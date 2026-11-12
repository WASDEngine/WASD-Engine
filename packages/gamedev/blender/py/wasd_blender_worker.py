"""Headless Blender worker for the WASD Engine Blender MCP server.

Protocol 1: the parent writes one JSON request per line to standard input,
``{"id": <int>, "method": "<name>", "params": {...}}``. Replies go to file
descriptor 3, one JSON object per line: first the ready line
``{"ready": true, "protocol": 1, "app": "blender", "version": ..., "python": ...}``,
then one ``{"id", "ok": true, "result"}`` or
``{"id", "ok": false, "error": {"type", "message", "traceback"}}`` per request.
Standard output and standard error stay log streams. Requests run one at a
time on the main thread. Replies never contain NaN, Infinity, or integers that
a JavaScript number cannot hold exactly, and a reply line longer than the
server accepts becomes an error reply. The worker exits with ``os._exit(0)``
after the ``shutdown`` reply, because Blender can crash in its own exit
handlers after some exporters ran.

Standard input closing without a ``shutdown`` request, or the reply pipe
losing its reader, means the server is gone. A thread checks the reply pipe
every second, so the worker notices this also in the middle of a request,
once the running code lets Python threads run. The worker then ends at once:
when it leads its own process group, which the server gives it on POSIX, it
kills the group with SIGKILL, so processes that executed code started end
with it; otherwise it exits with ``os._exit``.

The same file runs under the ``bpy`` module (``python -I -X utf8 -u <file>``)
and inside Blender (``blender --background --python <file>``). It uses only
the standard library and Blender's bundled modules.
"""

import builtins
import collections
import contextlib
import difflib
import importlib
import inspect
import io
import itertools
import json
import linecache
import math
import os
import platform
import runpy
import select
import signal
import sys
import threading
import time
import traceback
import types

# The bpy wheel registers Blender's built-in modules when bpy loads, so bpy comes first.
import bpy  # isort: skip
import addon_utils
import bmesh
import idprop
import mathutils
from mathutils import Euler, Matrix, Quaternion, Vector

PROTOCOL = 1
REPLY_FD = 3
# The server stops a worker that writes a longer reply line, in bytes (MAX_REPLY_BYTES of dsh-app-mcp).
MAX_REPLY_BYTES = 32 * 1024 * 1024
# The largest integer that a JavaScript number holds exactly; larger ones travel as decimal text.
MAX_EXACT_INTEGER = 2 ** 53 - 1
# Seconds between checks that the server still reads the replies.
SERVER_CHECK_SECONDS = 1.0
OUTPUT_LIMIT = 20000
RESULT_LIMIT = 50000
ITEM_LIMIT = 10000
OBJECT_LIMIT = 300
NAME_LIMIT = 300
COLLECTION_LIMIT = 200
API_TEXT_LIMIT = 12000
ENUM_ITEM_LIMIT = 40
MEMBER_LIMIT = 150
SETTING_LIMIT = 16
PREVIEW_MARGIN = 1.12
PREVIEW_EEVEE_SAMPLES = 16
DEFAULT_VIEWPORT_COLOR = (0.8, 0.8, 0.8, 1.0)

GEOMETRY_TYPES = frozenset(
    ('MESH', 'CURVE', 'SURFACE', 'META', 'FONT', 'CURVES', 'POINTCLOUD', 'VOLUME', 'GREASEPENCIL', 'GPENCIL')
)
VIEW_DIRECTIONS = {
    'iso': (1.0, -1.0, 1.0),
    'front': (0.0, -1.0, 0.0),
    'back': (0.0, 1.0, 0.0),
    'left': (-1.0, 0.0, 0.0),
    'right': (1.0, 0.0, 0.0),
    'top': (0.0, 0.0, 1.0),
}
ENGINE_IDS = {
    'EEVEE': ('BLENDER_EEVEE_NEXT', 'BLENDER_EEVEE'),
    'CYCLES': ('CYCLES',),
    'WORKBENCH': ('BLENDER_WORKBENCH',),
}
PRINCIPLED_INPUTS = ('Base Color', 'Metallic', 'Roughness', 'Alpha', 'Normal', 'Emission Color', 'Emission Strength')
MODIFIER_SKIPPED_SETTINGS = frozenset(
    ('rna_type', 'name', 'type', 'use_apply_on_spline', 'execution_time', 'persistent_uid', 'use_pin_to_last')
)
API_PYTHON_ROOTS = frozenset(
    ('bpy', 'bmesh', 'mathutils', 'bpy_extras', 'gpu', 'gpu_extras', 'bl_math', 'idprop', 'aud', 'freestyle', 'imbuf')
)
UI_SETTING_PREFIXES = ('show_', 'open_', 'is_')
RNA_TYPE_NAMES = {
    'BOOLEAN': 'bool', 'INT': 'int', 'FLOAT': 'float', 'STRING': 'str', 'ENUM': 'enum',
    'POINTER': 'pointer', 'COLLECTION': 'collection',
}

_MISSING = object()


class ParamError(ValueError):
    """A request parameter is missing or invalid; the message names the method and parameter."""


class Args:
    """Typed readers over one request's ``params`` object that reject unknown keys."""

    def __init__(self, method, params, allowed):
        if not isinstance(params, dict):
            raise ParamError(f'{method}: params must be a JSON object')
        unknown = sorted(key for key in params if key not in allowed)
        if unknown:
            raise ParamError(f'{method}: unknown parameter(s) {", ".join(unknown)}; accepted: {", ".join(allowed) or "none"}')
        self.method = method
        self.params = params

    def _fail(self, key, expected):
        raise ParamError(f'{self.method}: {key} must be {expected}, got {json.dumps(self.params[key])[:200]}')

    def text(self, key, required=False):
        """Return a non-empty string, or None when the key is absent and optional."""
        if key not in self.params or self.params[key] is None:
            if required:
                raise ParamError(f'{self.method}: {key} is required')
            return None
        value = self.params[key]
        if not isinstance(value, str) or value == '':
            self._fail(key, 'a non-empty string')
        return value

    def flag(self, key, default):
        """Return a boolean, or the default when the key is absent."""
        if key not in self.params or self.params[key] is None:
            return default
        value = self.params[key]
        if not isinstance(value, bool):
            self._fail(key, 'true or false')
        return value

    def integer(self, key, default, low, high):
        """Return an integer within [low, high], or the default when the key is absent."""
        if key not in self.params or self.params[key] is None:
            return default
        value = self.params[key]
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            self._fail(key, f'an integer from {low} to {high}')
        return value

    def choice(self, key, choices, default):
        """Return one of the allowed strings, or the default when the key is absent."""
        if key not in self.params or self.params[key] is None:
            return default
        value = self.params[key]
        if value not in choices:
            self._fail(key, f'one of {", ".join(choices)}')
        return value

    def names(self, key):
        """Return a non-empty list of distinct non-empty strings, or None when the key is absent."""
        if key not in self.params or self.params[key] is None:
            return None
        value = self.params[key]
        if not isinstance(value, list) or not value or not all(isinstance(item, str) and item for item in value):
            self._fail(key, 'a non-empty list of object names')
        return list(dict.fromkeys(value))

    def path(self, key, required=True, exists=False, extensions=None):
        """Return an absolute path, optionally required to exist and to end with one of the extensions."""
        value = self.text(key, required)
        if value is None:
            return None
        if not os.path.isabs(value):
            raise ParamError(f'{self.method}: {key} must be an absolute path, got {value!r}')
        if extensions is not None and os.path.splitext(value)[1].lower() not in extensions:
            raise ParamError(f'{self.method}: {key} must end with {" or ".join(extensions)}, got {value!r}')
        if exists and not os.path.isfile(value):
            raise ParamError(f'{self.method}: {key} does not name an existing file: {value!r}')
        return value

    def image_target(self, key):
        """Return the agent-visible image budget ``{stem, max_edge, max_bytes}``, or None when absent."""
        if key not in self.params or self.params[key] is None:
            return None
        value = self.params[key]
        nested = Args(f'{self.method}.{key}', value, ('stem', 'max_edge', 'max_bytes'))
        stem = nested.text('stem', required=True)
        if not os.path.isabs(stem):
            raise ParamError(f'{self.method}: {key}.stem must be an absolute path, got {stem!r}')
        return {
            'stem': stem,
            'max_edge': nested.integer('max_edge', 1568, 16, 16384),
            'max_bytes': nested.integer('max_bytes', 3 * 1024 * 1024, 1024, 1 << 30),
        }


class Overrides:
    """Attribute assignments recorded for restoration in reverse order of assignment."""

    def __init__(self):
        self._undo = []

    def set(self, owner, attribute, value, optional=False):
        """Assign ``owner.attribute`` and remember the previous value; optional assignments skip
        properties this Blender version lacks or rejects."""
        try:
            previous = _snapshot(getattr(owner, attribute))
            setattr(owner, attribute, value)
        except (AttributeError, TypeError, ValueError, RuntimeError):
            if optional:
                return
            raise
        self._undo.append(lambda: setattr(owner, attribute, previous))

    def defer(self, restore):
        """Run ``restore`` during restoration, in reverse order with the other entries."""
        self._undo.append(restore)

    def restore(self):
        """Restore every recorded value; return messages for values that could not be restored."""
        failures = []
        while self._undo:
            restore = self._undo.pop()
            try:
                restore()
            except (AttributeError, TypeError, ValueError, RuntimeError, ReferenceError) as error:
                failures.append(str(error))
        return failures


def _snapshot(value):
    """Copy mutable vector-like values so a later restoration writes the old contents."""
    if isinstance(value, (Vector, Euler, Quaternion, Matrix, mathutils.Color)):
        return value.copy()
    if isinstance(value, bpy.types.bpy_prop_array):
        return tuple(value)
    return value


def _number(value, digits=4):
    """Round a float for compact output; non-finite values become None."""
    value = float(value)
    if not math.isfinite(value):
        return None
    rounded = round(value, digits)
    return 0.0 if rounded == 0 else rounded


def _vector(values, digits=4):
    return [_number(value, digits) for value in values]


def _truncate(text, limit):
    """Keep the head and tail of ``text`` so the returned string is at most ``limit`` characters."""
    if len(text) <= limit:
        return text
    return _cut(text, text, len(text), limit)


def _cut(head, tail, total, limit):
    """The start of ``head`` and the end of ``tail`` around an omission marker, at most ``limit``
    characters together, for a text of ``total`` characters that begins with ``head`` and ends with
    ``tail``; each must hold at least ``limit`` characters of it."""
    marker = '\n[... {} characters omitted ...]\n'
    keep = max(limit - len(marker.format(total)), 0)
    first = keep // 2
    return head[:first] + marker.format(total - keep) + tail[len(tail) - (keep - first):]


class BoundedOutput(io.TextIOBase):
    """Text stream for the printed output of executed code. It keeps the first and the last
    ``limit`` characters written, so its memory stays bounded however much the code prints, and
    :meth:`text` returns what ``_truncate`` returns for the whole output. Threads may write at once."""

    def __init__(self, limit):
        super().__init__()
        self._limit = limit
        self._head = []
        self._head_size = 0
        self._tail = collections.deque()
        self._tail_size = 0
        self._total = 0
        # The code may print from several threads. Reentrant, so that a signal handler that prints
        # during a write in its own thread does not deadlock.
        self._lock = threading.RLock()

    def writable(self):
        return True

    def write(self, text):
        if not isinstance(text, str):
            raise TypeError(f'write() argument must be str, not {type(text).__name__}')
        if not text:
            return 0
        with self._lock:
            self._total += len(text)
            if self._head_size < self._limit:
                part = text[:self._limit - self._head_size]
                self._head.append(part)
                self._head_size += len(part)
            part = text[-self._limit:]
            self._tail.append(part)
            self._tail_size += len(part)
            # Drop the oldest chunks that the last ``limit`` characters no longer reach. The newest
            # chunk always stays: a write nested in a signal handler can leave the sizes inexact.
            while len(self._tail) > 1 and self._tail_size - len(self._tail[0]) >= self._limit:
                self._tail_size -= len(self._tail.popleft())
        return len(text)

    def text(self):
        """The output, cut to ``limit`` characters around an omission marker when it is longer."""
        with self._lock:
            head = ''.join(self._head)
            if self._total <= self._limit:
                return head
            return _cut(head, ''.join(self._tail), self._total, self._limit)


def _integer_text(value):
    """Return the decimal digits of ``value``, or its digit count when Python refuses to convert that many."""
    try:
        return str(value)
    except ValueError:
        # Python converts at most sys.get_int_max_str_digits() digits.
        return f'<integer of about {int(math.log10(abs(value))) + 1} digits>'


def _jsonable(value, depth=0):
    """Convert a Python value to JSON-compatible data: vectors become lists, datablocks become
    ``{"type", "name"}``, ID properties become plain values, integers beyond ``MAX_EXACT_INTEGER``
    their decimal digits, and anything else becomes its repr."""
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int):
        return value if -MAX_EXACT_INTEGER <= value <= MAX_EXACT_INTEGER else _integer_text(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if depth >= 32:
        return _safe_repr(value)
    if isinstance(value, (Vector, Euler, Quaternion, mathutils.Color)):
        return [_jsonable(item) for item in value]
    if isinstance(value, Matrix):
        return [[_jsonable(item) for item in row] for row in value]
    if isinstance(value, bpy.types.ID):
        try:
            return {'type': value.bl_rna.identifier, 'name': value.name}
        except ReferenceError:
            return _safe_repr(value)
    if isinstance(value, idprop.types.IDPropertyGroup):
        return _jsonable(value.to_dict(), depth + 1)
    if isinstance(value, idprop.types.IDPropertyArray):
        return _jsonable(value.to_list(), depth + 1)
    if isinstance(value, dict):
        entries = list(itertools.islice(value.items(), ITEM_LIMIT + 1))
        converted = {
            (key if isinstance(key, str) else _safe_repr(key)): _jsonable(item, depth + 1)
            for key, item in entries[:ITEM_LIMIT]
        }
        if len(entries) > ITEM_LIMIT:
            converted['[omitted]'] = f'more than {ITEM_LIMIT} entries; the rest are omitted'
        return converted
    if isinstance(value, (list, tuple, set, frozenset, bpy.types.bpy_prop_array, bpy.types.bpy_prop_collection)):
        try:
            items = list(itertools.islice(value, ITEM_LIMIT + 1))
        except ReferenceError:
            return _safe_repr(value)
        converted = [_jsonable(item, depth + 1) for item in items[:ITEM_LIMIT]]
        if len(items) > ITEM_LIMIT:
            converted.append(f'[more than {ITEM_LIMIT} items; the rest are omitted]')
        return converted
    return _safe_repr(value)


def _safe_repr(value):
    try:
        return repr(value)
    except Exception as error:  # A user object's __repr__ may raise anything.
        return f'<unrepresentable {type(value).__name__}: {error}>'


def _clip(text, limit):
    """One-line form of ``text`` cut to ``limit`` characters."""
    line = ' '.join(text.split())
    return line if len(line) <= limit else line[:limit - 3] + '...'


def _bounded_json(value):
    """Convert ``value`` and replace it with a truncated JSON text preview when it is too large."""
    converted = _jsonable(value)
    text = json.dumps(converted, ensure_ascii=False)
    if len(text) <= RESULT_LIMIT:
        return converted
    return {'truncated': True, 'json_characters': len(text), 'preview': text[:RESULT_LIMIT]}


def _object(method, name):
    """Return the object named ``name`` or raise a ParamError that suggests close names."""
    obj = bpy.data.objects.get(name)
    if obj is not None:
        return obj
    close = difflib.get_close_matches(name, [o.name for o in bpy.data.objects], n=5, cutoff=0.5)
    hint = f' Close names: {", ".join(close)}.' if close else ' Call scene_info for the object list.'
    raise ParamError(f'{method}: no object named {name!r}.{hint}')


def _with_descendants(objects):
    """Return the objects followed by their descendants, without duplicates, in a stable order."""
    seen = {}
    for obj in objects:
        seen[obj.as_pointer()] = obj
        for child in obj.children_recursive:
            seen.setdefault(child.as_pointer(), child)
    return list(seen.values())


def _ensure_object_mode():
    """Leave edit, sculpt, or paint modes so object data is flushed before undo steps, saves,
    exports, and renders."""
    context = bpy.context
    if context.mode != 'OBJECT' and context.view_layer.objects.active is not None:
        bpy.ops.object.mode_set(mode='OBJECT')


def _evaluated_triangles(obj, depsgraph):
    """Count triangles of the object's evaluated mesh (modifiers applied)."""
    evaluated = obj.evaluated_get(depsgraph)
    mesh = evaluated.to_mesh()
    try:
        mesh.calc_loop_triangles()
        return len(mesh.loop_triangles)
    finally:
        evaluated.to_mesh_clear()


def _world_bounds(obj, depsgraph):
    """Return world-space min and max corners of the object's evaluated bounding box."""
    evaluated = obj.evaluated_get(depsgraph)
    corners = [obj.matrix_world @ Vector(corner) for corner in evaluated.bound_box]
    low = [min(corner[axis] for corner in corners) for axis in range(3)]
    high = [max(corner[axis] for corner in corners) for axis in range(3)]
    return low, high


def _rotation_fields(obj):
    mode = obj.rotation_mode
    if mode == 'QUATERNION':
        return {'rotation_mode': mode, 'rotation_quaternion': _vector(obj.rotation_quaternion)}
    if mode == 'AXIS_ANGLE':
        return {'rotation_mode': mode, 'rotation_axis_angle': _vector(obj.rotation_axis_angle)}
    fields = {'rotation_euler': _vector(obj.rotation_euler)}
    if mode != 'XYZ':
        fields['rotation_mode'] = mode
    return fields


def _object_summary(obj, depsgraph, view_layer):
    entry = {'name': obj.name, 'type': obj.type}
    if obj.parent is not None:
        entry['parent'] = obj.parent.name
    entry['location'] = _vector(obj.location)
    entry.update(_rotation_fields(obj))
    entry['scale'] = _vector(obj.scale)
    entry['dimensions'] = _vector(obj.dimensions)
    if obj.data is not None:
        entry['data'] = obj.data.name
    materials = [slot.material.name for slot in obj.material_slots if slot.material is not None]
    if materials:
        entry['materials'] = materials
    modifiers = [modifier.name for modifier in obj.modifiers]
    if modifiers:
        entry['modifiers'] = modifiers
    entry['visible'] = obj.visible_get(view_layer=view_layer)
    if obj.hide_render:
        entry['hide_render'] = True
    if obj.type == 'MESH':
        entry['triangles'] = _evaluated_triangles(obj, depsgraph)
    return entry


def _collection_tree(layer_collection, budget):
    """Summarize the view layer's collection tree; ``budget`` is a one-item list of remaining nodes."""
    budget[0] -= 1
    collection = layer_collection.collection
    node = {'name': layer_collection.name, 'objects': len(collection.objects)}
    if layer_collection.exclude:
        node['excluded'] = True
    if layer_collection.hide_viewport or collection.hide_viewport:
        node['hidden'] = True
    if collection.hide_render:
        node['hide_render'] = True
    children = []
    omitted = 0
    for child in layer_collection.children:
        if budget[0] <= 0:
            omitted += 1
            continue
        children.append(_collection_tree(child, budget))
    if children:
        node['children'] = children
    if omitted:
        node['children_omitted'] = omitted
    return node


def _action_fcurve_count(action):
    """Count F-curves of a legacy or layered (slotted) action."""
    legacy = getattr(action, 'fcurves', None)
    if legacy is not None:
        return len(legacy)
    count = 0
    for layer in getattr(action, 'layers', ()):
        for strip in layer.strips:
            for channelbag in getattr(strip, 'channelbags', ()):
                count += len(channelbag.fcurves)
    return count


def _rna_value(value):
    """Compact JSON form of an RNA property value used in setting summaries."""
    if isinstance(value, bpy.types.ID):
        return value.name
    if isinstance(value, float):
        return _number(value)
    if isinstance(value, (bpy.types.bpy_prop_array, Vector, Euler, Quaternion, mathutils.Color)):
        return [_number(item) if isinstance(item, float) else item for item in value]
    if isinstance(value, set):
        return sorted(value)
    if value is None or isinstance(value, (bool, int, str)):
        return value
    return None


def _struct_settings(struct, skipped, limit):
    """Return up to ``limit`` scalar, enum, vector, and datablock settings of an RNA struct."""
    settings = {}
    for prop in struct.bl_rna.properties:
        if prop.identifier in skipped or prop.identifier.startswith(UI_SETTING_PREFIXES) or prop.type == 'COLLECTION':
            continue
        if prop.type == 'POINTER' and not isinstance(getattr(struct, prop.identifier, None), bpy.types.ID):
            continue
        try:
            value = _rna_value(getattr(struct, prop.identifier))
        except (AttributeError, ReferenceError, RuntimeError):
            continue
        if value is None:
            continue
        settings[prop.identifier] = value
        if len(settings) >= limit:
            break
    return settings


def _socket_value(socket):
    if socket.is_linked:
        link = socket.links[0]
        source = link.from_node
        label = f'{source.name}.{link.from_socket.name}'
        image = getattr(source, 'image', None)
        return {'linked': label, 'image': image.name} if image is not None else {'linked': label}
    value = getattr(socket, 'default_value', None)
    if value is None:
        return None
    if isinstance(value, float):
        return _number(value)
    try:
        return _vector(value)
    except TypeError:
        return None


def _material_summary(index, slot):
    material = slot.material
    entry = {'slot': index, 'name': material.name if material is not None else None, 'link': slot.link}
    if material is None:
        return entry
    entry['viewport_color'] = _vector(material.diffuse_color, 3)
    tree = material.node_tree
    if tree is None:
        return entry
    nodes = list(tree.nodes)
    entry['nodes'] = [{'name': node.name, 'type': node.bl_idname} for node in nodes[:30]]
    if len(nodes) > 30:
        entry['nodes_omitted'] = len(nodes) - 30
    for node in nodes:
        if node.type == 'BSDF_PRINCIPLED':
            inputs = {}
            for name in PRINCIPLED_INPUTS:
                socket = node.inputs.get(name)
                if socket is None:
                    continue
                value = _socket_value(socket)
                if value is not None and not (name == 'Normal' and not socket.is_linked):
                    inputs[name] = value
            entry['principled'] = inputs
            break
    images = []
    for node in nodes:
        image = getattr(node, 'image', None) if node.type == 'TEX_IMAGE' else None
        if image is not None:
            images.append({'node': node.name, 'image': image.name, 'filepath': image.filepath, 'size': list(image.size)})
    if images:
        entry['images'] = images[:10]
    return entry


def _mesh_details(obj, depsgraph):
    mesh = obj.data
    mesh.calc_loop_triangles()
    details = {
        'vertices': len(mesh.vertices),
        'edges': len(mesh.edges),
        'faces': len(mesh.polygons),
        'triangles': len(mesh.loop_triangles),
        'evaluated_triangles': _evaluated_triangles(obj, depsgraph),
        'uv_layers': [layer.name for layer in mesh.uv_layers],
        'vertex_groups': [group.name for group in obj.vertex_groups][:100],
        'color_attributes': [attribute.name for attribute in mesh.color_attributes],
        'users': mesh.users,
    }
    if mesh.uv_layers.active is not None:
        details['active_uv_layer'] = mesh.uv_layers.active.name
    if mesh.shape_keys is not None:
        details['shape_keys'] = [key.name for key in mesh.shape_keys.key_blocks][:100]
    return details


def _type_details(obj):
    data = obj.data
    if obj.type == 'CAMERA':
        return {'camera': {
            'type': data.type, 'lens': _number(data.lens), 'ortho_scale': _number(data.ortho_scale),
            'sensor_width': _number(data.sensor_width), 'clip_start': _number(data.clip_start),
            'clip_end': _number(data.clip_end),
        }}
    if obj.type == 'LIGHT':
        return {'light': {
            'type': data.type, 'energy': _number(data.energy), 'color': _vector(data.color, 3),
            'radius': _number(getattr(data, 'shadow_soft_size', 0.0)),
        }}
    if obj.type == 'ARMATURE':
        bones = list(data.bones)
        return {'armature': {
            'bones': len(bones),
            'root_bones': [bone.name for bone in bones if bone.parent is None][:50],
            'pose_position': data.pose_position,
        }}
    if obj.type == 'EMPTY':
        details = {'display_type': obj.empty_display_type, 'display_size': _number(obj.empty_display_size)}
        if obj.instance_type == 'COLLECTION' and obj.instance_collection is not None:
            details['instance_collection'] = obj.instance_collection.name
        return {'empty': details}
    return {}


def _image_settings_restorer(settings):
    """Capture image output settings and return a callback that restores them in dependency order."""
    saved = [(name, getattr(settings, name)) for name in ('media_type', 'file_format', 'color_mode', 'color_depth')
             if hasattr(settings, name)]

    def restore():
        for name, value in saved:
            try:
                setattr(settings, name, value)
            except (TypeError, ValueError):
                continue
    return restore


def _use_png_output(overrides, render, rgba):
    """Switch the scene's output to 8-bit PNG until ``overrides`` is restored."""
    settings = render.image_settings
    overrides.defer(_image_settings_restorer(settings))
    if hasattr(settings, 'media_type'):
        settings.media_type = 'IMAGE'
    settings.file_format = 'PNG'
    settings.color_mode = 'RGBA' if rgba else 'RGB'
    settings.color_depth = '8'


def _engine_id(scene, engine):
    """Map EEVEE, CYCLES, or WORKBENCH to this Blender version's render engine identifier."""
    current = scene.render.engine
    for candidate in ENGINE_IDS[engine]:
        try:
            scene.render.engine = candidate
        except TypeError:
            continue
        scene.render.engine = current
        return candidate
    raise ValueError(f'The {engine} render engine is not available in this Blender build')


def _remove_new_images(before, types):
    for image in list(bpy.data.images):
        if image.as_pointer() not in before and image.type in types:
            bpy.data.images.remove(image)


def _agent_image(path, width, height, target):
    """Return the image the agent should see: the rendered file itself when it fits the budget,
    otherwise a downscaled PNG copy, or a JPEG copy when the PNG is still too large."""
    if target is None or (max(width, height) <= target['max_edge'] and os.path.getsize(path) <= target['max_bytes']):
        return {'path': path, 'mime_type': 'image/png', 'width': width, 'height': height}
    scale = min(1.0, target['max_edge'] / max(width, height))
    size = (max(1, round(width * scale)), max(1, round(height * scale)))
    os.makedirs(os.path.dirname(target['stem']), exist_ok=True)
    image = bpy.data.images.load(path, check_existing=False)
    try:
        if size != (width, height):
            image.scale(*size)
        candidates = (('PNG', '.png', 'image/png'), ('JPEG', '.jpg', 'image/jpeg'))
        for file_format, extension, mime_type in candidates:
            copy = target['stem'] + extension
            image.file_format = file_format
            image.save(filepath=copy, quality=90)
            if os.path.getsize(copy) <= target['max_bytes'] or file_format == 'JPEG':
                return {'path': copy, 'mime_type': mime_type, 'width': size[0], 'height': size[1]}
            os.remove(copy)
    finally:
        bpy.data.images.remove(image)
    raise AssertionError('unreachable: the JPEG candidate always returns')


def _preview_targets(method, names):
    if names is None:
        return None
    return _with_descendants([_object(method, name) for name in names])


def _render_candidates(view_layer):
    """Objects in the collections that a render of ``view_layer`` shows: collections neither
    excluded from the view layer nor, themselves or through a parent, hidden from renders.
    Returns the objects keyed by pointer."""
    found = {}
    pending = [(view_layer.layer_collection, False)]
    while pending:
        layer, hidden = pending.pop()
        if layer.exclude:
            continue
        hidden = hidden or layer.collection.hide_render
        if not hidden:
            for obj in layer.collection.objects:
                found.setdefault(obj.as_pointer(), obj)
        pending.extend((child, hidden) for child in layer.children)
    return found


def _rendered_objects(view_layer, targets):
    """The objects that a preview renders, and the names of targets it cannot show. Renders ignore
    viewport visibility; they show the ``targets``, also those hidden from renders, or else every
    object not hidden from renders, but only objects in collections that renders show."""
    candidates = _render_candidates(view_layer)
    if targets is None:
        return [obj for obj in candidates.values() if not obj.hide_render], []
    shown = [obj for obj in targets if obj.as_pointer() in candidates]
    return shown, [obj.name for obj in targets if obj.as_pointer() not in candidates]


def _reveal_collections(overrides, layer, wanted):
    """Show the collections of ``layer``'s tree that hold an object whose pointer is in ``wanted``
    in the viewport until ``overrides`` is restored; returns whether the tree holds one."""
    if layer.exclude:
        return False
    holds = any(obj.as_pointer() in wanted for obj in layer.collection.objects)
    for child in layer.children:
        if _reveal_collections(overrides, child, wanted):
            holds = True
    if holds:
        if layer.hide_viewport:
            overrides.set(layer, 'hide_viewport', False, optional=True)
        if layer.collection.hide_viewport:
            overrides.set(layer.collection, 'hide_viewport', False, optional=True)
    return holds


def _render_bounds(overrides, objects):
    """World-space bounds of ``objects`` as a render shows them, from evaluated instances so
    modifiers, geometry nodes, and collection instances count; returns (low, high, count), where
    count is the number of geometry instances measured. The viewport dependency graph leaves out
    objects hidden in the viewport, which renders still show, so the objects and the collections
    that hold them are shown in the viewport until ``overrides`` is restored."""
    wanted = {obj.as_pointer() for obj in objects}
    for obj in objects:
        _reveal(overrides, obj)
    _reveal_collections(overrides, bpy.context.view_layer.layer_collection, wanted)
    depsgraph = bpy.context.evaluated_depsgraph_get()
    low = [math.inf] * 3
    high = [-math.inf] * 3
    count = 0
    for instance in depsgraph.object_instances:
        owner = (instance.parent if instance.is_instance else instance.object).original
        if owner.as_pointer() not in wanted:
            continue
        shown = instance.object
        if shown.type not in GEOMETRY_TYPES:
            continue
        matrix = instance.matrix_world.copy()
        for corner in shown.bound_box:
            point = matrix @ Vector(corner)
            for axis in range(3):
                low[axis] = min(low[axis], point[axis])
                high[axis] = max(high[axis], point[axis])
        count += 1
    if not all(math.isfinite(value) for value in low + high):
        low, high = [-1.0] * 3, [1.0] * 3
    return Vector(low), Vector(high), count


def _origin_bounds(objects):
    """Bounds that reach 0.5 m around the origin of each object, for objects with no geometry to measure."""
    origins = [obj.matrix_world.translation for obj in objects]
    low = [min(origin[axis] for origin in origins) - 0.5 for axis in range(3)]
    high = [max(origin[axis] for origin in origins) + 0.5 for axis in range(3)]
    return Vector(low), Vector(high)


def _use_standard_view(overrides, view_settings):
    """Show the image with the Standard view transform and no look until ``overrides`` is restored.
    A look belongs to one view transform, and Blender resets a look that a new transform lacks, so
    both are saved before either changes and restored view transform first."""
    saved_transform, saved_look = view_settings.view_transform, view_settings.look
    try:
        view_settings.view_transform = 'Standard'
    except TypeError:
        # TypeError: this color management configuration has no Standard view, so the scene's own view stays.
        return

    def restore():
        view_settings.view_transform = saved_transform
        view_settings.look = saved_look
    overrides.defer(restore)
    view_settings.look = 'None'


def _frame_camera(camera, low, high, view, width, height):
    """Place an orthographic camera looking at the bounds from ``view`` so they fill the frame."""
    center = (low + high) / 2
    radius = max((high - low).length / 2, 1e-3)
    direction = Vector(VIEW_DIRECTIONS[view]).normalized()
    if view == 'top':
        rotation = Quaternion()
    else:
        rotation = (-direction).to_track_quat('-Z', 'Y')
    inverse = rotation.to_matrix().inverted()
    xs, ys = [], []
    for x in (low.x, high.x):
        for y in (low.y, high.y):
            for z in (low.z, high.z):
                local = inverse @ (Vector((x, y, z)) - center)
                xs.append(local.x)
                ys.append(local.y)
    extent_x = max(xs) - min(xs)
    extent_y = max(ys) - min(ys)
    aspect = width / height
    scale = max(extent_x, extent_y * aspect) if aspect >= 1 else max(extent_y, extent_x / aspect)
    scale = max(scale * PREVIEW_MARGIN, 1e-3)
    distance = radius * 2 + 1
    camera.location = center + direction * distance
    camera.rotation_euler = rotation.to_euler()
    data = camera.data
    data.type = 'ORTHO'
    data.sensor_fit = 'AUTO'
    data.ortho_scale = scale
    data.clip_start = max((distance - radius) * 0.5, 1e-4)
    data.clip_end = distance + radius * 2 + 1
    return {'center': _vector(center), 'size': _vector(high - low), 'ortho_scale': _number(scale)}


def _neutral_world(world):
    """Give a temporary preview world a mid-grey background for Workbench and EEVEE."""
    world.color = (0.18, 0.18, 0.18)
    tree = world.node_tree
    if tree is None:
        return
    for node in tree.nodes:
        if node.type == 'BACKGROUND':
            node.inputs['Color'].default_value = (0.18, 0.18, 0.18, 1.0)
            node.inputs['Strength'].default_value = 1.0


def _principled_base_color(material):
    tree = material.node_tree
    if tree is None:
        return None
    for node in tree.nodes:
        if node.type == 'BSDF_PRINCIPLED':
            socket = node.inputs.get('Base Color')
            if socket is not None and not socket.is_linked:
                return tuple(socket.default_value)
            return None
    return None


def _sync_viewport_colors(overrides, objects):
    """Show node-based base colors in a solid preview: materials whose viewport color is still the
    default borrow their Principled BSDF base color until the preview is restored."""
    seen = set()
    for obj in objects:
        for slot in obj.material_slots:
            material = slot.material
            if material is None or material.as_pointer() in seen:
                continue
            seen.add(material.as_pointer())
            base = _principled_base_color(material)
            current = tuple(material.diffuse_color)
            if base is None or any(abs(a - b) > 1e-4 for a, b in zip(current, DEFAULT_VIEWPORT_COLOR)):
                continue
            overrides.set(material, 'diffuse_color', (base[0], base[1], base[2], current[3]), optional=True)


def _format_number(value):
    if isinstance(value, float):
        if math.isinf(value):
            return 'inf' if value > 0 else '-inf'
        return f'{value:g}'
    return repr(value)


def _property_kind(prop):
    kind = RNA_TYPE_NAMES.get(prop.type, prop.type.lower())
    if prop.type in ('BOOLEAN', 'INT', 'FLOAT') and getattr(prop, 'array_length', 0) > 0:
        dimensions = [d for d in getattr(prop, 'array_dimensions', ()) if d > 0] or [prop.array_length]
        kind += ''.join(f'[{d}]' for d in dimensions)
    elif prop.type == 'POINTER' and prop.fixed_type is not None:
        kind = prop.fixed_type.identifier
    elif prop.type == 'COLLECTION' and prop.fixed_type is not None:
        kind = f'collection of {prop.fixed_type.identifier}'
    elif prop.type == 'ENUM' and prop.is_enum_flag:
        kind = 'enum set'
    return kind


def _property_default(prop):
    if prop.type in ('BOOLEAN', 'INT', 'FLOAT'):
        if getattr(prop, 'array_length', 0) > 0:
            values = list(prop.default_array)
            if len(values) > 16:
                return None
            return '(' + ', '.join(_format_number(v) for v in values) + ')'
        return _format_number(prop.default)
    if prop.type == 'STRING':
        return repr(prop.default)
    if prop.type == 'ENUM':
        if prop.is_enum_flag:
            return '{' + ', '.join(repr(item) for item in sorted(prop.default_flag)) + '}'
        return repr(prop.default) if prop.default else None
    return None


def _enum_items(prop, limit):
    items = list(prop.enum_items)
    if not items:
        return None
    shown = ', '.join(repr(item.identifier) for item in items[:limit])
    if len(items) > limit:
        shown += f', ... ({len(items) - limit} more)'
    return shown


def _property_line(prop, enum_limit=12):
    head = f'- {prop.identifier}: {_property_kind(prop)}'
    default = None if prop.is_output else _property_default(prop)
    if default is not None:
        head += f' = {default}'
    notes = []
    if prop.subtype not in ('NONE', '') and prop.type in ('INT', 'FLOAT', 'STRING'):
        notes.append(prop.subtype.lower())
    if prop.unit not in ('NONE', ''):
        notes.append(f'unit {prop.unit.lower()}')
    if prop.type in ('INT', 'FLOAT'):
        low, high = prop.hard_min, prop.hard_max
        if (low, high) != (-math.inf, math.inf) and abs(low) < 1e30 and abs(high) < 1e30:
            notes.append(f'range {_format_number(low)}..{_format_number(high)}')
    if prop.is_readonly:
        notes.append('read-only')
    if getattr(prop, 'is_deprecated', False):
        notes.append('deprecated')
    if notes:
        head += f' ({", ".join(notes)})'
    if prop.description:
        head += f'. {prop.description}'
    lines = [head]
    if prop.type == 'ENUM' and enum_limit > 0:
        items = _enum_items(prop, enum_limit)
        if items:
            lines.append(f'    items: {items}')
    return lines


def _function_line(function):
    inputs = [p for p in function.parameters if not p.is_output]
    outputs = [p for p in function.parameters if p.is_output]
    parts = []
    for param in inputs:
        part = f'{param.identifier}: {_property_kind(param)}'
        if not param.is_required:
            default = _property_default(param)
            part += f' = {default}' if default is not None else ' = None'
        parts.append(part)
    line = f'- {function.identifier}({", ".join(parts)})'
    if outputs:
        line += ' -> ' + ', '.join(f'{p.identifier}: {_property_kind(p)}' for p in outputs)
    if function.description:
        line += f'. {function.description}'
    return line


def _struct_doc(identifier, struct_type):
    rna = struct_type.bl_rna
    base = rna.base
    inherited = set()
    if base is not None:
        inherited = {p.identifier for p in base.properties} | {f.identifier for f in base.functions}
    lines = [identifier + (f' (subclass of bpy.types.{base.identifier}; its members are listed there)' if base is not None else '')]
    if rna.description:
        lines.append(rna.description)
    own_properties = [p for p in rna.properties if p.identifier != 'rna_type' and p.identifier not in inherited]
    if own_properties:
        lines.append('Properties:')
        for prop in own_properties:
            lines.extend(_property_line(prop))
    own_functions = [f for f in rna.functions if f.identifier not in inherited]
    if own_functions:
        lines.append('Functions:')
        lines.extend(_function_line(function) for function in own_functions)
    rna_names = {p.identifier for p in rna.properties} | {f.identifier for f in rna.functions}
    python_members = [
        (name, member) for name, member in sorted(vars(struct_type).items())
        if not name.startswith('_') and name not in rna_names and (callable(member) or isinstance(member, property))
    ]
    if python_members:
        lines.append('Python members:')
        for name, member in python_members[:MEMBER_LIMIT]:
            summary = _doc_summary(member.fget if isinstance(member, property) else member)
            lines.append(f'- {name}' + (f': {summary}' if summary else ''))
    return '\n'.join(lines)


def _member_doc(identifier, struct_type, member):
    rna = struct_type.bl_rna
    prop = rna.properties.get(member)
    if prop is not None:
        lines = [f'{identifier} (property of bpy.types.{rna.identifier})']
        lines.extend(_property_line(prop, 0) if prop.type == 'ENUM' else _property_line(prop))
        if prop.type in ('INT', 'FLOAT'):
            lines.append(f'    soft range {_format_number(prop.soft_min)}..{_format_number(prop.soft_max)}, step {_format_number(prop.step)}')
        if prop.type == 'ENUM':
            for item in list(prop.enum_items)[:ENUM_ITEM_LIMIT]:
                lines.append(f'    {item.identifier!r}: {item.name}' + (f'. {item.description}' if item.description else ''))
        return 'property', '\n'.join(lines)
    function = rna.functions.get(member)
    if function is not None:
        lines = [f'{identifier} (function of bpy.types.{rna.identifier})', _function_line(function)]
        for param in function.parameters:
            role = 'returns' if param.is_output else 'param'
            lines.append(f'    {role} {param.identifier}: {_property_kind(param)}' + (f'. {param.description}' if param.description else ''))
        return 'function', '\n'.join(lines)
    attribute = getattr(struct_type, member, _MISSING)
    if attribute is not _MISSING:
        return 'python', _python_doc(identifier, attribute)
    names = [p.identifier for p in rna.properties] + [f.identifier for f in rna.functions]
    close = difflib.get_close_matches(member, names, n=5, cutoff=0.5)
    hint = f' Close names: {", ".join(close)}.' if close else ''
    raise ParamError(f'python_api: bpy.types.{rna.identifier} has no member {member!r}.{hint}')


def _operator_doc(module_name, operator_name):
    module = getattr(bpy.ops, module_name)
    operator = getattr(module, operator_name)
    rna = operator.get_rna_type()
    properties = [p for p in rna.properties if p.identifier != 'rna_type']
    signature = ', '.join(
        f'{p.identifier}={_property_default(p)}' if _property_default(p) is not None else p.identifier
        for p in properties
    )
    lines = [f'bpy.ops.{module_name}.{operator_name}({signature})']
    if rna.name:
        lines.append(f'{rna.name}' + (f': {rna.description}' if rna.description else ''))
    if properties:
        lines.append('Parameters:')
        for prop in properties:
            lines.extend(_property_line(prop, ENUM_ITEM_LIMIT))
    return '\n'.join(lines)


def _operator_module_doc(module_name):
    module = getattr(bpy.ops, module_name)
    lines = [f'bpy.ops.{module_name} operators:']
    for name in dir(module):
        if name.startswith('_'):
            continue
        try:
            rna = getattr(module, name).get_rna_type()
        except (KeyError, AttributeError, RuntimeError):
            continue
        lines.append(f'- {name}' + (f': {rna.description}' if rna.description else ''))
    return '\n'.join(lines)


def _python_doc(identifier, value):
    kind = 'module' if inspect.ismodule(value) else 'class' if inspect.isclass(value) else type(value).__name__
    lines = [f'{identifier} ({kind})']
    if callable(value) and not inspect.isclass(value):
        try:
            lines.append(f'{identifier.rsplit(".", 1)[-1]}{inspect.signature(value)}')
        except (TypeError, ValueError):
            pass
    doc = inspect.getdoc(value)
    if doc:
        lines.append(_truncate(doc, 4000))
    if inspect.ismodule(value) or inspect.isclass(value) or not callable(value):
        members = [name for name in dir(value) if not name.startswith('_')]
        if members:
            lines.append('Members:')
            for name in members[:MEMBER_LIMIT]:
                member = getattr(value, name, None)
                if callable(member) or inspect.ismodule(member):
                    summary = _doc_summary(member)
                else:
                    summary = _clip(_safe_repr(member), 120)
                lines.append(f'- {name}' + (f': {summary}' if summary else ''))
            if len(members) > MEMBER_LIMIT:
                lines.append(f'... ({len(members) - MEMBER_LIMIT} more)')
    return '\n'.join(lines)


def _doc_summary(member):
    """First meaningful docstring line; a leading reST directive such as ``.. method:: f(x)``
    contributes its signature."""
    lines = [line.strip() for line in (inspect.getdoc(member) or '').splitlines()]
    signature = ''
    if lines and lines[0].startswith('.. ') and '::' in lines[0]:
        signature = lines.pop(0).split('::', 1)[1].strip()
    text = next((line for line in lines if line and not line.startswith(':')), '')
    if signature and text:
        return f'{signature}: {text}'
    return signature or text


def _resolve_python(identifier):
    parts = identifier.split('.')
    if parts[0] not in API_PYTHON_ROOTS:
        raise ParamError(
            f'python_api: {identifier!r} is not a Blender API name; use bpy.types.<Type>[.<member>], '
            f'bpy.ops.<module>[.<operator>], or a name under {", ".join(sorted(API_PYTHON_ROOTS))}'
        )
    for split in range(len(parts), 0, -1):
        try:
            value = importlib.import_module('.'.join(parts[:split]))
        except ImportError:
            continue
        for index in range(split, len(parts)):
            next_value = getattr(value, parts[index], _MISSING)
            if next_value is _MISSING:
                members = [name for name in dir(value) if not name.startswith('_')]
                close = difflib.get_close_matches(parts[index], members, n=5, cutoff=0.5)
                hint = f' Close names: {", ".join(close)}.' if close else ''
                raise ParamError(f'python_api: {".".join(parts[:index])} has no member {parts[index]!r}.{hint}')
            value = next_value
        return value
    raise ParamError(f'python_api: cannot import {parts[0]!r}')


def _api_doc(identifier):
    """Resolve an API identifier and return (kind, text)."""
    if identifier.startswith('bpy.ops.') or identifier == 'bpy.ops':
        parts = identifier.split('.')
        modules = [name for name in dir(bpy.ops) if not name.startswith('_')]
        if len(parts) == 2:
            return 'module', 'bpy.ops modules: ' + ', '.join(modules)
        if parts[2] not in modules:
            close = difflib.get_close_matches(parts[2], modules, n=5, cutoff=0.5)
            raise ParamError(f'python_api: no operator module bpy.ops.{parts[2]}.' + (f' Close names: {", ".join(close)}.' if close else ''))
        if len(parts) == 3:
            return 'module', _operator_module_doc(parts[2])
        operators = [name for name in dir(getattr(bpy.ops, parts[2])) if not name.startswith('_')]
        if len(parts) != 4 or parts[3] not in operators:
            close = difflib.get_close_matches(parts[-1], operators, n=5, cutoff=0.5)
            raise ParamError(f'python_api: no operator {identifier}.' + (f' Close names: bpy.ops.{parts[2]}.{", ".join(close)}.' if close else ''))
        return 'operator', _operator_doc(parts[2], parts[3])
    aliases = {'bpy.data': 'BlendData', 'bpy.context': 'Context'}
    for prefix, type_name in aliases.items():
        if identifier == prefix:
            return 'struct', _struct_doc(f'{prefix} (bpy.types.{type_name})', getattr(bpy.types, type_name))
        if identifier.startswith(prefix + '.'):
            member = identifier[len(prefix) + 1:]
            if '.' not in member:
                return _member_doc(identifier, getattr(bpy.types, type_name), member)
    rest = identifier[len('bpy.types.'):] if identifier.startswith('bpy.types.') else identifier
    parts = rest.split('.')
    struct_type = getattr(bpy.types, parts[0], None) if parts[0] else None
    if struct_type is not None and hasattr(struct_type, 'bl_rna') and len(parts) <= 2:
        if len(parts) == 1:
            return 'struct', _struct_doc(f'bpy.types.{parts[0]}', struct_type)
        return _member_doc(f'bpy.types.{rest}', struct_type, parts[1])
    if identifier.startswith('bpy.types.') or '.' not in identifier:
        names = [name for name in dir(bpy.types) if not name.startswith('_')]
        close = difflib.get_close_matches(parts[0], names, n=5, cutoff=0.5)
        hint = f' Close names: {", ".join(close)}.' if close else ''
        raise ParamError(f'python_api: no type bpy.types.{parts[0]}.{hint}')
    return 'python', _python_doc(identifier, _resolve_python(identifier))


def _user_traceback(error, filename):
    """Format ``error`` starting at the first frame of the executed code."""
    if isinstance(error, SyntaxError) and error.filename == filename:
        return ''.join(traceback.format_exception_only(type(error), error))
    frames = error.__traceback__
    while frames is not None and frames.tb_frame.f_code.co_filename != filename:
        frames = frames.tb_next
    return ''.join(traceback.format_exception(type(error), error, frames or error.__traceback__))


def _undo_context():
    window_manager = bpy.context.window_manager
    window = bpy.context.window or (window_manager.windows[0] if len(window_manager.windows) else None)
    if window is None:
        return contextlib.nullcontext()
    return bpy.context.temp_override(window=window, screen=window.screen)


def _import_file(path, extension):
    ops = bpy.ops
    if extension in ('.glb', '.gltf'):
        ops.import_scene.gltf(filepath=path)
    elif extension == '.fbx':
        ops.import_scene.fbx(filepath=path)
    elif extension == '.obj':
        ops.wm.obj_import(filepath=path)
    elif extension == '.stl':
        ops.wm.stl_import(filepath=path)
    elif extension == '.ply':
        ops.wm.ply_import(filepath=path)
    elif extension in ('.usd', '.usda', '.usdc', '.usdz'):
        ops.wm.usd_import(filepath=path)
    elif extension == '.abc':
        ops.wm.alembic_import(filepath=path, as_background_job=False)
    elif extension == '.svg':
        ops.import_curve.svg(filepath=path)
    else:
        with bpy.data.libraries.load(path, link=False) as (source, target):
            target.objects = list(source.objects)
        collection = bpy.context.collection or bpy.context.scene.collection
        for obj in target.objects:
            if obj is not None and not obj.users_collection:
                collection.objects.link(obj)


IMPORT_EXTENSIONS = (
    '.glb', '.gltf', '.fbx', '.obj', '.stl', '.ply', '.usd', '.usda', '.usdc', '.usdz', '.abc', '.svg', '.blend',
)
EXPORT_FORMATS = {
    'fbx': ('.fbx',),
    'obj': ('.obj',),
    'stl': ('.stl',),
    'usd': ('.usd', '.usda', '.usdc', '.usdz'),
}
# Object types that export_gltf leaves out: the glTF exporter exports cameras and lights only on request.
GLTF_SKIPPED_TYPES = frozenset(('CAMERA', 'LIGHT'))


def _has_shape_keys(obj):
    """Whether a mesh object has shape keys besides its basis, which glTF exports as morph targets."""
    return obj.type == 'MESH' and obj.data.shape_keys is not None and len(obj.data.shape_keys.key_blocks) > 1


def _reveal(overrides, obj, selectable=False):
    """Show ``obj`` in the viewport, and with ``selectable`` let it be selected, until ``overrides``
    is restored: Blender leaves hidden and unselectable objects out of the selection and out of the
    viewport dependency graph. A setting this Blender refuses to change, such as one of an object
    linked from a library, stays as it is."""
    if obj.hide_get():
        obj.hide_set(False)
        overrides.defer(lambda: obj.hide_set(True))
    if obj.hide_viewport:
        overrides.set(obj, 'hide_viewport', False, optional=True)
    if selectable and obj.hide_select:
        overrides.set(obj, 'hide_select', False, optional=True)


@contextlib.contextmanager
def _selected(method, names):
    """Select exactly the named objects and their descendants, also when they are hidden or
    unselectable, and restore their visibility, the previous selection, and the active object
    afterwards; yields the selected objects, or None when ``names`` is None. Raises ParamError for
    objects that no change of their own settings makes selectable, such as those in a collection
    that disables selection."""
    if names is None:
        yield None
        return
    view_layer = bpy.context.view_layer
    objects = _with_descendants([_object(method, name) for name in names])
    outside = [obj.name for obj in objects if view_layer.objects.get(obj.name) is None]
    if outside:
        raise ParamError(f'{method}: objects outside the view layer cannot be selected (their collection is excluded): {", ".join(outside)}')
    previous = [obj for obj in view_layer.objects if obj.select_get()]
    active = view_layer.objects.active
    overrides = Overrides()
    try:
        for obj in objects:
            _reveal(overrides, obj, selectable=True)
        for obj in view_layer.objects:
            obj.select_set(False)
        for obj in objects:
            obj.select_set(True)
        refused = [obj.name for obj in objects if not obj.select_get()]
        if refused:
            raise ParamError(
                f'{method}: Blender cannot select {", ".join(refused)}: a collection that holds them disables selection or '
                f'viewport display. Enable both for that collection, or link the objects to another collection.')
        view_layer.objects.active = objects[0]
        yield objects
    finally:
        for obj in view_layer.objects:
            obj.select_set(False)
        failures = overrides.restore()
        for obj in previous:
            obj.select_set(True)
        view_layer.objects.active = active
    if failures:
        raise RuntimeError(f'{method}: the export finished, but these settings could not be restored: {"; ".join(failures)}')


def _remove_previous(paths):
    """Delete earlier files at the paths an export writes, so a file that is present afterwards is the export's own."""
    for path in paths:
        with contextlib.suppress(FileNotFoundError):
            # FileNotFoundError: no earlier file is there.
            os.remove(path)


def _require_export(method, result, path):
    """Fail unless the export operator finished and wrote ``path``."""
    if 'FINISHED' not in result:
        raise RuntimeError(f'{method}: Blender did not finish the export (operator result {", ".join(sorted(result))})')
    if not os.path.isfile(path):
        raise RuntimeError(f'{method}: Blender wrote no file at {path}: the exported objects hold nothing that this format stores')


def _export_selection_call(format_name, path, selection):
    ops = bpy.ops
    if format_name == 'fbx':
        return ops.export_scene.fbx(filepath=path, use_selection=selection)
    if format_name == 'obj':
        return ops.wm.obj_export(filepath=path, export_selected_objects=selection)
    if format_name == 'stl':
        return ops.wm.stl_export(filepath=path, export_selected_objects=selection)
    return ops.wm.usd_export(filepath=path, selected_objects_only=selection)


def _version():
    return '.'.join(str(part) for part in bpy.app.version)


ADDON_STORE_VARIABLE = 'WASD_ADDON_STORE'
"""Environment variable that names the game add-on store, from the Blender plugin's ``addonStore``."""

ADDON_REPO_MODULE = 'wasd'
"""Module name of the extensions repository that holds the store's extensions: they import as ``bl_ext.wasd.<id>``."""

ADDON_STORE_INDEX = 'catalog.json'
"""The store's index of the catalog's Blender add-ons, which the game add-ons plugin writes."""

ADDON_STORE_MARKER = '.wasd-addon.json'
"""The file the game add-ons plugin writes into an add-on or asset folder once it unpacked it completely."""


class AddonError(RuntimeError):
    """An add-on that ``wasd_addons.enable`` cannot enable, with what the agent should do."""


class Addons:
    """WASD Engine's catalog add-ons in this worker, behind the ``wasd_addons`` module. ``enable`` makes one usable:
    an extension unpacked in the store through a ``wasd`` extensions repository whose folder is the store, a core
    add-on as it ships inside Blender. An add-on whose catalog entry has a setup script, such as one that points the
    add-on at its asset pack, gets it run after it is enabled. Factory settings, which a new scene and executed code may
    load, drop the repository, disable every add-on, and reset their preferences, so a persistent handler enables the
    ones this worker enabled again and runs their setup again."""

    def __init__(self, store):
        self.store = os.path.abspath(store) if store else ''
        self.ids = []
        self.prepared = set()
        addons = self

        @bpy.app.handlers.persistent
        def wasd_addons_restore(*_args):
            addons.restore()

        bpy.app.handlers.load_factory_preferences_post.append(wasd_addons_restore)

    def _entry(self, name):
        if not self.store:
            raise AddonError('This Blender has no game add-on store, so wasd_addons cannot enable add-ons.')
        try:
            with open(os.path.join(self.store, ADDON_STORE_INDEX), encoding='utf-8') as index:
                addons = json.load(index)['addons']
        except FileNotFoundError:
            raise AddonError('No game add-ons are known yet: install one in the game project with game_addons first.') from None
        if name in addons:
            return name, addons[name]
        for addon_id, entry in addons.items():
            if entry.get('module') == name:
                return addon_id, entry
        raise AddonError(f'{name!r} is not a catalog Blender add-on; the catalog has {", ".join(sorted(addons))}.')

    def _repository(self):
        repos = bpy.context.preferences.extensions.repos
        for repo in repos:
            if repo.module == ADDON_REPO_MODULE:
                if not repo.use_custom_directory or os.path.abspath(repo.custom_directory) != self.store:
                    repo.use_custom_directory = True
                    repo.custom_directory = self.store
                repo.enabled = True
                return
        repos.new(name='WASD Engine add-ons', module=ADDON_REPO_MODULE, custom_directory=self.store, source='USER')

    def enable(self, name):
        """Enable a catalog Blender add-on by its id or module; returns the Python module name it runs as."""
        addon_id, entry = self._entry(str(name))
        module = entry['module']
        if entry['kind'] == 'core':
            full = module
        else:
            folder = os.path.join(self.store, module)
            if not any(os.path.isfile(os.path.join(folder, marker)) for marker in ('blender_manifest.toml', '__init__.py')):
                raise AddonError(f'{addon_id} is not downloaded yet: install it in the game project with game_addons first.')
            self._repository()
            full = f'bl_ext.{ADDON_REPO_MODULE}.{module}'
        if addon_utils.check(full) != (True, True):
            errors = []
            loaded = addon_utils.enable(full, default_set=True, persistent=True, handle_error=errors.append)
            if loaded is None or errors:
                cause = f'{type(errors[0]).__name__}: {errors[0]}' if errors else 'it did not load'
                raise AddonError(f'Enabling {addon_id} failed: {cause}')
        if addon_id not in self.prepared:
            self._setup(addon_id, entry, full)
            self.prepared.add(addon_id)
        if addon_id not in self.ids:
            self.ids.append(addon_id)
        return full

    def _assets(self, addon_id, entry):
        folder = entry.get('assets')
        if folder is None:
            return None
        if not os.path.isfile(os.path.join(folder, ADDON_STORE_MARKER)):
            raise AddonError(f'The asset pack of {addon_id} is not downloaded yet: install the add-on in the game project with game_addons again.')
        return folder

    def _setup(self, addon_id, entry, module):
        script = entry.get('setup')
        if script is None:
            return
        assets = self._assets(addon_id, entry)
        try:
            runpy.run_path(script, run_name='wasd_addon_setup')['setup'](module=module, assets=assets)
        except Exception as error:
            raise AddonError(f'Setting up {addon_id} failed: {type(error).__name__}: {error}') from error

    def assets(self, name):
        """The folder of a catalog add-on's asset pack, which the add-on's setup already points it at."""
        addon_id, entry = self._entry(str(name))
        if entry.get('assets') is None:
            raise AddonError(f'{addon_id} has no asset pack.')
        return self._assets(addon_id, entry)

    def enabled(self):
        """The ids that ``enable`` enabled in this worker, in order."""
        return list(self.ids)

    def restore(self):
        """Enable again what the worker had enabled, and run its setup again, after factory settings disabled it and
        reset its preferences; an add-on that fails stays out. Blender calls it from a file-loading handler, so it
        never raises."""
        self.prepared.clear()
        for addon_id in list(self.ids):
            try:
                self.enable(addon_id)
            except Exception as error:  # noqa: BLE001 - one failed add-on must not stop the scene from loading.
                self.ids.remove(addon_id)
                sys.stderr.write(f'wasd_addons: could not enable {addon_id} again: {error}\n')


def _addons_module(addons):
    """The ``wasd_addons`` module that executed code imports."""
    module = types.ModuleType('wasd_addons', 'Enable WASD Engine\'s catalog add-ons in this Blender: enable(id), enabled(), and assets(id).')
    module.enable = addons.enable
    module.enabled = addons.enabled
    module.assets = addons.assets
    module.AddonError = AddonError
    return module


def _fresh_namespace():
    """The ``execute_python`` namespace before any code ran: the preloaded modules only."""
    return {
        '__name__': '__wasd__', '__builtins__': builtins,
        'bpy': bpy, 'bmesh': bmesh, 'mathutils': mathutils, 'json': json, 'math': math,
        'wasd_addons': sys.modules['wasd_addons'],
    }


class Worker:
    """Request dispatcher; owns the persistent ``execute_python`` namespace, the checkpoint model,
    and the unsaved-changes flag."""

    def __init__(self, replies):
        self.replies = replies
        self.addons = Addons(os.environ.get(ADDON_STORE_VARIABLE, ''))
        sys.modules['wasd_addons'] = _addons_module(self.addons)
        self.namespace = _fresh_namespace()
        self.runs = 0
        self.undo_error = None
        self.steps = []
        self.position = -1
        self.clean = True
        self.restored = False
        self.unsaved = False
        self.next_checkpoint = 1
        self._start_scene()

    # Checkpoint model: ``steps`` mirrors Blender's undo stack (0 is the opened state, positive
    # numbers are checkpoints, None is a step pushed before undoing unsaved changes), ``position``
    # is the active step, ``clean`` means the scene equals the active step, and ``restored`` means
    # undo already returned to the active step, so the next undo steps further back. ``unsaved``
    # means a tool may have changed the scene since it was opened, created, or saved; Blender's own
    # ``bpy.data.is_dirty`` cannot tell, since every undo step sets it and saving does not clear it.

    def _changed(self):
        self.clean = False
        self.restored = False
        self.unsaved = True

    def _push(self, label, number):
        bpy.ops.ed.undo_push(message=label)
        del self.steps[self.position + 1:]
        self.steps.append(number)
        limit = max(bpy.context.preferences.edit.undo_steps, 1)
        while len(self.steps) > limit + 1:
            self.steps.pop(0)
        self.position = len(self.steps) - 1

    def _start_scene(self):
        """Begin a scene that was just opened or created: clear the names that executed code
        defined, start the checkpoint model over, and count the scene as unchanged. Returns the
        cleared names, sorted, without ``result``, which every call resets anyway."""
        fresh = _fresh_namespace()
        cleared = sorted(name for name, value in self.namespace.items() if name != 'result' and fresh.get(name, _MISSING) is not value)
        self.namespace = fresh
        self.unsaved = False
        self.steps = []
        self.position = -1
        self.clean = True
        self.restored = False
        self.next_checkpoint = 1
        try:
            _ensure_object_mode()
            self._push('Opened', 0)
            self.undo_error = None
        except RuntimeError as error:
            self.undo_error = str(error)
        return cleared

    def _replace_scene(self, load):
        """Run ``load``, which replaces Blender's data with a new or opened file, then begin the new
        scene; returns the names that executed code had defined. Freed data leaves references to it
        dangling: datablock references raise ReferenceError, but references to their parts, such as
        ``scene.render``, ``mesh.vertices``, or a vertex's ``co``, point at freed memory, so reading
        them returns garbage and writing through them corrupts the new data or crashes Blender. A
        load that fails before it replaced the data keeps the names and the checkpoints."""
        data = bpy.data.as_pointer()
        try:
            load()
        except Exception:
            # A load that failed after it replaced the data leaves the same dangling references.
            if bpy.data.as_pointer() != data:
                self._start_scene()
            raise
        return self._start_scene()

    def _require_undo(self, method):
        if self.undo_error is not None:
            raise RuntimeError(f'{method}: undo is unavailable in this Blender session: {self.undo_error}')

    def send(self, message):
        """Write one reply line; a reply longer than the server accepts becomes an error reply."""
        try:
            text = json.dumps(message, ensure_ascii=True, allow_nan=False)
        except ValueError:
            text = json.dumps(_jsonable(message), ensure_ascii=True, allow_nan=False)
        if len(text) > MAX_REPLY_BYTES:
            text = json.dumps({'id': message.get('id'), 'ok': False, 'error': {
                'type': 'ValueError', 'traceback': '',
                'message': f'the request completed, but its reply is {len(text)} bytes of JSON, more than the {MAX_REPLY_BYTES} bytes the server accepts',
            }})
        self.replies.write(text + '\n')
        self.replies.flush()

    def handle(self, line):
        """Run one request line and write its reply; return True when the worker must exit."""
        try:
            request = json.loads(line)
        except ValueError as error:
            self.send({'id': None, 'ok': False, 'error': {'type': 'ProtocolError', 'message': f'invalid JSON request: {error}', 'traceback': ''}})
            return False
        request_id = request.get('id') if isinstance(request, dict) else None
        if not isinstance(request_id, int) or isinstance(request_id, bool) or not isinstance(request.get('method'), str):
            self.send({'id': request_id if isinstance(request_id, int) else None, 'ok': False, 'error': {
                'type': 'ProtocolError', 'message': 'a request needs an integer id and a string method', 'traceback': ''}})
            return False
        method = request['method']
        handler = METHODS.get(method)
        try:
            if handler is None:
                raise ParamError(f'unknown method {method!r}; available: {", ".join(sorted(METHODS))}')
            result = handler(self, request.get('params', {}))
        except ParamError as error:
            self.send({'id': request_id, 'ok': False, 'error': {'type': 'ValueError', 'message': _truncate(str(error), OUTPUT_LIMIT), 'traceback': ''}})
        except Exception as error:  # Every failure becomes an error reply for this request.
            self.send({'id': request_id, 'ok': False, 'error': {
                'type': type(error).__name__, 'message': _truncate(str(error), OUTPUT_LIMIT), 'traceback': _truncate(traceback.format_exc(), 8000)}})
        else:
            self.send({'id': request_id, 'ok': True, 'result': result})
        return method == 'shutdown' and handler is not None

    def ping(self, params):
        Args('ping', params, ())
        return {'app': 'blender', 'version': _version(), 'python': platform.python_version(), 'file': bpy.data.filepath or None}

    def scene_info(self, params):
        Args('scene_info', params, ())
        scene = bpy.context.scene
        view_layer = bpy.context.view_layer
        depsgraph = bpy.context.evaluated_depsgraph_get()
        objects = list(scene.objects)
        shown = objects[:OBJECT_LIMIT]
        render = scene.render
        units = scene.unit_settings
        return {
            'file': bpy.data.filepath or None,
            'dirty': self.unsaved,
            'scene': scene.name,
            'scenes': [s.name for s in bpy.data.scenes],
            'frame': {
                'start': scene.frame_start, 'end': scene.frame_end, 'current': scene.frame_current,
                'fps': _number(render.fps / render.fps_base, 3),
            },
            'render': {
                'engine': render.engine, 'resolution': [render.resolution_x, render.resolution_y],
                'percentage': render.resolution_percentage, 'film_transparent': render.film_transparent,
                'camera': scene.camera.name if scene.camera is not None else None,
            },
            'units': {'system': units.system, 'scale_length': _number(units.scale_length, 6), 'length_unit': units.length_unit},
            'collections': _collection_tree(view_layer.layer_collection, [COLLECTION_LIMIT]),
            'objects': [_object_summary(obj, depsgraph, view_layer) for obj in shown],
            'object_count': len(objects),
            'objects_omitted': len(objects) - len(shown),
            'datablocks': {
                'meshes': len(bpy.data.meshes), 'materials': len(bpy.data.materials), 'images': len(bpy.data.images),
                'actions': len(bpy.data.actions), 'collections': len(bpy.data.collections),
            },
        }

    def object_info(self, params):
        args = Args('object_info', params, ('name',))
        obj = _object('object_info', args.text('name', required=True))
        depsgraph = bpy.context.evaluated_depsgraph_get()
        view_layer = bpy.context.view_layer
        world_location, world_rotation, world_scale = obj.matrix_world.decompose()
        low, high = _world_bounds(obj, depsgraph)
        info = {
            'name': obj.name,
            'type': obj.type,
            'data': obj.data.name if obj.data is not None else None,
            'parent': obj.parent.name if obj.parent is not None else None,
            'children': [child.name for child in obj.children][:NAME_LIMIT],
            'collections': [collection.name for collection in obj.users_collection],
            'local': dict({'location': _vector(obj.location)}, **_rotation_fields(obj), scale=_vector(obj.scale)),
            'world': {
                'location': _vector(world_location), 'rotation_euler': _vector(world_rotation.to_euler()),
                'scale': _vector(world_scale),
            },
            'dimensions': _vector(obj.dimensions),
            'bounds_world': {'min': _vector(low), 'max': _vector(high)},
            'visibility': {
                'visible': obj.visible_get(view_layer=view_layer), 'hide_viewport': obj.hide_viewport,
                'hide_render': obj.hide_render, 'hide_select': obj.hide_select,
            },
        }
        if obj.parent is not None:
            info['parent_type'] = obj.parent_type
            if obj.parent_type == 'BONE':
                info['parent_bone'] = obj.parent_bone
        if obj.type == 'MESH':
            info['mesh'] = _mesh_details(obj, depsgraph)
        info.update(_type_details(obj))
        info['modifiers'] = [
            {'name': m.name, 'type': m.type, 'show_viewport': m.show_viewport, 'show_render': m.show_render,
             'settings': _struct_settings(m, MODIFIER_SKIPPED_SETTINGS, SETTING_LIMIT)}
            for m in obj.modifiers
        ]
        info['materials'] = [_material_summary(index, slot) for index, slot in enumerate(obj.material_slots)]
        info['constraints'] = [
            {'name': c.name, 'type': c.type, 'target': c.target.name if getattr(c, 'target', None) is not None else None,
             'influence': _number(c.influence), 'enabled': not c.mute}
            for c in obj.constraints
        ]
        info['custom_properties'] = {
            key: _jsonable(obj[key]) for key in list(obj.keys())[:50] if not key.startswith('_')
        }
        animation = obj.animation_data
        if animation is not None:
            action = animation.action
            info['animation'] = {
                'action': action.name if action is not None else None,
                'fcurves': _action_fcurve_count(action) if action is not None else 0,
                'frame_range': _vector(action.frame_range, 3) if action is not None else None,
                'nla_tracks': len(animation.nla_tracks),
                'drivers': len(animation.drivers),
            }
        return info

    def execute_python(self, params):
        args = Args('execute_python', params, ('code',))
        code = args.text('code', required=True)
        self._changed()
        self.runs += 1
        filename = f'<execute_python #{self.runs}>'
        linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)
        namespace = self.namespace
        namespace.pop('result', None)
        output = BoundedOutput(OUTPUT_LIMIT)
        error = None
        started = time.monotonic()
        try:
            compiled = compile(code, filename, 'exec')
        except SyntaxError as failure:
            error = failure
        else:
            saved_stdin = sys.stdin
            sys.stdin = io.StringIO('')
            try:
                with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                    exec(compiled, namespace)
            except BaseException as failure:  # SystemExit and KeyboardInterrupt from user code must not stop the worker.
                error = failure
            finally:
                sys.stdin = saved_stdin
        reply = {
            'result': _bounded_json(namespace['result']) if 'result' in namespace else None,
            'output': output.text(),
            'seconds': _number(time.monotonic() - started, 3),
        }
        if error is not None:
            reply['error'] = {
                'type': type(error).__name__, 'message': _truncate(str(error), OUTPUT_LIMIT),
                'traceback': _truncate(_user_traceback(error, filename), 8000),
            }
        return reply

    def new_scene(self, params):
        args = Args('new_scene', params, ('empty',))
        empty = args.flag('empty', True)
        cleared = self._replace_scene(lambda: bpy.ops.wm.read_factory_settings(use_empty=empty))
        return {
            'empty': empty, 'objects': [obj.name for obj in bpy.context.scene.objects][:NAME_LIMIT],
            'cleared': cleared[:NAME_LIMIT], 'cleared_count': len(cleared),
        }

    def open_blend(self, params):
        args = Args('open_blend', params, ('path',))
        path = args.path('path', exists=True, extensions=('.blend',))
        cleared = self._replace_scene(lambda: bpy.ops.wm.open_mainfile(filepath=path, load_ui=False, use_scripts=False))
        objects = list(bpy.context.scene.objects)
        return {
            'file': bpy.data.filepath, 'scene': bpy.context.scene.name, 'scenes': [s.name for s in bpy.data.scenes],
            'objects': [obj.name for obj in objects[:NAME_LIMIT]], 'object_count': len(objects),
            'cleared': cleared[:NAME_LIMIT], 'cleared_count': len(cleared),
        }

    def save_blend(self, params):
        args = Args('save_blend', params, ('path',))
        path = args.path('path', required=False, extensions=('.blend',))
        _ensure_object_mode()
        if path is None:
            if not bpy.data.filepath:
                raise ParamError('save_blend: the scene has never been saved; pass path')
            path = bpy.data.filepath
            bpy.ops.wm.save_mainfile(filepath=path)
        else:
            os.makedirs(os.path.dirname(path), exist_ok=True)
            bpy.ops.wm.save_as_mainfile(filepath=path, check_existing=False)
        self.unsaved = False
        return {'path': path, 'bytes': os.path.getsize(path)}

    def import_file(self, params):
        args = Args('import_file', params, ('path',))
        path = args.path('path', exists=True, extensions=IMPORT_EXTENSIONS)
        _ensure_object_mode()
        self._changed()
        before = {obj.as_pointer() for obj in bpy.data.objects}
        _import_file(path, os.path.splitext(path)[1].lower())
        added = [obj.name for obj in bpy.data.objects if obj.as_pointer() not in before]
        return {'objects': added[:NAME_LIMIT], 'count': len(added), 'omitted': max(len(added) - NAME_LIMIT, 0)}

    def export_gltf(self, params):
        args = Args('export_gltf', params, ('path', 'selection', 'apply_modifiers', 'animations', 'format'))
        path = args.path('path', extensions=('.glb', '.gltf'))
        names = args.names('selection')
        apply_modifiers = args.flag('apply_modifiers', None)
        animations = args.flag('animations', True)
        extension = os.path.splitext(path)[1].lower()
        export_format = args.choice('format', ('GLB', 'GLTF_SEPARATE'), 'GLB' if extension == '.glb' else 'GLTF_SEPARATE')
        expected = '.glb' if export_format == 'GLB' else '.gltf'
        if extension != expected:
            raise ParamError(f'export_gltf: format {export_format} writes {expected} files, but path ends with {extension}')
        _ensure_object_mode()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        buffer = os.path.splitext(path)[0] + '.bin'
        _remove_previous([path, buffer] if export_format == 'GLTF_SEPARATE' else [path])
        with _selected('export_gltf', names) as selected:
            exported = list(selected) if selected is not None else list(bpy.context.scene.objects)
            if apply_modifiers is None:
                # Skins export what Armature modifiers do, so an Armature-only stack gains nothing from
                # applying, while applying any stack drops that mesh's shape keys.
                apply_modifiers = any(
                    modifier.type != 'ARMATURE' and modifier.show_viewport for obj in exported for modifier in obj.modifiers
                )
            # The exporter writes every mesh that has any modifier from its evaluated copy, which has no shape keys.
            dropped = [obj.name for obj in exported if apply_modifiers and len(obj.modifiers) > 0 and _has_shape_keys(obj)]
            result = bpy.ops.export_scene.gltf(
                filepath=path, export_format=export_format, use_selection=selected is not None, use_active_scene=True,
                export_apply=apply_modifiers, export_animations=animations,
                export_draco_mesh_compression_enable=False, export_yup=True,
            )
            count = sum(1 for obj in exported if obj.type not in GLTF_SKIPPED_TYPES)
        _require_export('export_gltf', result, path)
        files = [path]
        if export_format == 'GLTF_SEPARATE' and os.path.isfile(buffer):
            files.append(buffer)
        return {
            'path': path, 'format': export_format, 'bytes': os.path.getsize(path), 'objects': count, 'files': files,
            'applied_modifiers': apply_modifiers, 'shape_keys_dropped': dropped,
        }

    def export_file(self, params):
        args = Args('export_file', params, ('path', 'format', 'selection'))
        export_format = args.choice('format', tuple(EXPORT_FORMATS), None)
        if export_format is None:
            raise ParamError(f'export_file: format is required ({", ".join(EXPORT_FORMATS)})')
        path = args.path('path', extensions=EXPORT_FORMATS[export_format])
        names = args.names('selection')
        _ensure_object_mode()
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _remove_previous([path])
        with _selected('export_file', names) as selected:
            result = _export_selection_call(export_format, path, selected is not None)
        _require_export('export_file', result, path)
        return {'path': path, 'format': export_format, 'bytes': os.path.getsize(path)}

    def render_preview(self, params):
        args = Args('render_preview', params, ('path', 'width', 'height', 'view', 'objects', 'shading', 'agent_image'))
        path = args.path('path', extensions=('.png',))
        width = args.integer('width', 768, 16, 8192)
        height = args.integer('height', 768, 16, 8192)
        view = args.choice('view', tuple(VIEW_DIRECTIONS), 'iso')
        shading = args.choice('shading', ('solid', 'material'), 'solid')
        targets = _preview_targets('render_preview', args.names('objects'))
        agent_image = args.image_target('agent_image')
        _ensure_object_mode()
        scene = bpy.context.scene
        render = scene.render
        shown, unseen = _rendered_objects(bpy.context.view_layer, targets)
        revealed = Overrides()
        try:
            low, high, count = _render_bounds(revealed, shown)
        finally:
            failures = revealed.restore()
        if count == 0 and targets:
            low, high = _origin_bounds(targets)
        overrides = Overrides()
        created = []
        images_before = {image.as_pointer() for image in bpy.data.images}
        started = time.monotonic()
        try:
            camera_data = bpy.data.cameras.new('WASD preview camera')
            created.append((bpy.data.cameras, camera_data))
            camera = bpy.data.objects.new('WASD preview camera', camera_data)
            created.append((bpy.data.objects, camera))
            scene.collection.objects.link(camera)
            framing = _frame_camera(camera, low, high, view, width, height)
            overrides.set(scene, 'camera', camera)
            if scene.world is None:
                world = bpy.data.worlds.new('WASD preview world')
                created.append((bpy.data.worlds, world))
                _neutral_world(world)
                overrides.set(scene, 'world', world)
            if shading == 'material' and not any(obj.type == 'LIGHT' and not obj.hide_render for obj in scene.objects):
                light_data = bpy.data.lights.new('WASD preview light', 'SUN')
                created.append((bpy.data.lights, light_data))
                light_data.energy = 3.0
                light = bpy.data.objects.new('WASD preview light', light_data)
                created.append((bpy.data.objects, light))
                scene.collection.objects.link(light)
                light.rotation_euler = Euler((math.radians(50.0), 0.0, math.radians(30.0)))
            if targets is not None:
                wanted = {obj.as_pointer() for obj in targets}
                for obj in scene.objects:
                    if obj.as_pointer() in wanted:
                        if obj.hide_render:
                            overrides.set(obj, 'hide_render', False)
                    elif obj.type in GEOMETRY_TYPES and not obj.hide_render:
                        overrides.set(obj, 'hide_render', True)
            if shading == 'solid':
                overrides.set(render, 'engine', 'BLENDER_WORKBENCH')
                display = scene.display.shading
                for attribute, value in (('light', 'STUDIO'), ('color_type', 'TEXTURE'), ('show_cavity', True),
                                         ('cavity_type', 'BOTH'), ('show_object_outline', True), ('show_shadows', False),
                                         ('show_xray', False), ('show_backface_culling', False)):
                    overrides.set(display, attribute, value, optional=True)
                _use_standard_view(overrides, scene.view_settings)
                _sync_viewport_colors(overrides, shown)
            else:
                overrides.set(render, 'engine', _engine_id(scene, 'EEVEE'))
                overrides.set(scene.eevee, 'taa_render_samples', PREVIEW_EEVEE_SAMPLES, optional=True)
            for attribute, value in (('resolution_x', width), ('resolution_y', height), ('resolution_percentage', 100),
                                     ('pixel_aspect_x', 1.0), ('pixel_aspect_y', 1.0), ('use_border', False),
                                     ('film_transparent', False), ('use_compositing', False), ('use_sequencer', False),
                                     ('use_stamp', False), ('use_motion_blur', False), ('use_freestyle', False),
                                     ('use_multiview', False)):
                overrides.set(render, attribute, value, optional=True)
            _use_png_output(overrides, render, rgba=False)
            overrides.set(render, 'filepath', path)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            bpy.ops.render.render(write_still=True)
        finally:
            failures += overrides.restore()
            for collection, block in reversed(created):
                collection.remove(block)
            _remove_new_images(images_before, ('RENDER_RESULT', 'COMPOSITING'))
        if failures:
            raise RuntimeError(f'render_preview: the preview rendered, but these settings could not be restored: {"; ".join(failures)}')
        if not os.path.isfile(path):
            raise RuntimeError(f'render_preview: Blender did not write {path}')
        reply = {
            'path': path, 'width': width, 'height': height, 'view': view, 'shading': shading,
            'objects': count, 'framing': dict(framing, min=_vector(low), max=_vector(high)),
            'seconds': _number(time.monotonic() - started, 3),
            'image': _agent_image(path, width, height, agent_image),
        }
        notes = []
        if unseen:
            notes.append(f'The preview cannot show {", ".join(unseen[:NAME_LIMIT])}: no collection of the view layer that renders include holds them.')
        if count == 0:
            notes.append('Nothing renderable was found; the preview shows an empty view.')
        if notes:
            reply['note'] = ' '.join(notes)
        return reply

    def render(self, params):
        args = Args('render', params, ('path', 'width', 'height', 'engine', 'samples', 'camera', 'time_limit', 'agent_image'))
        path = args.path('path', extensions=('.png',))
        width = args.integer('width', None, 16, 16384)
        height = args.integer('height', None, 16, 16384)
        engine = args.choice('engine', tuple(ENGINE_IDS), None)
        samples = args.integer('samples', None, 1, 65536)
        time_limit = args.integer('time_limit', None, 1, 86400)
        camera_name = args.text('camera')
        agent_image = args.image_target('agent_image')
        scene = bpy.context.scene
        render = scene.render
        camera = scene.camera if camera_name is None else _object('render', camera_name)
        if camera is None:
            raise ParamError('render: the scene has no camera; add a camera object and set scene.camera, pass camera, or use render_preview')
        if camera.type != 'CAMERA':
            raise ParamError(f'render: {camera.name!r} is a {camera.type} object, not a camera')
        engine_id = _engine_id(scene, engine) if engine is not None else render.engine
        if samples is not None and engine_id not in ('CYCLES', 'BLENDER_EEVEE', 'BLENDER_EEVEE_NEXT'):
            raise ParamError(f'render: samples applies to EEVEE and CYCLES, not {engine_id}')
        _ensure_object_mode()
        overrides = Overrides()
        started = time.monotonic()
        try:
            overrides.set(scene, 'camera', camera)
            overrides.set(render, 'engine', engine_id)
            if width is not None:
                overrides.set(render, 'resolution_x', width)
            if height is not None:
                overrides.set(render, 'resolution_y', height)
            if width is not None or height is not None:
                overrides.set(render, 'resolution_percentage', 100)
            if samples is not None:
                if engine_id == 'CYCLES':
                    overrides.set(scene.cycles, 'samples', samples)
                else:
                    overrides.set(scene.eevee, 'taa_render_samples', samples)
            # Cycles stops sampling at its time limit and still writes the image; a scene's own stricter limit stays.
            if time_limit is not None and engine_id == 'CYCLES' and not 0 < scene.cycles.time_limit <= time_limit:
                overrides.set(scene.cycles, 'time_limit', time_limit)
            out_width = render.resolution_x * render.resolution_percentage // 100
            out_height = render.resolution_y * render.resolution_percentage // 100
            _use_png_output(overrides, render, rgba=render.film_transparent)
            overrides.set(render, 'filepath', path)
            os.makedirs(os.path.dirname(path), exist_ok=True)
            bpy.ops.render.render(write_still=True)
        finally:
            failures = overrides.restore()
        if failures:
            raise RuntimeError(f'render: the image rendered, but these settings could not be restored: {"; ".join(failures)}')
        if not os.path.isfile(path):
            raise RuntimeError(f'render: Blender did not write {path}')
        return {
            'path': path, 'width': out_width, 'height': out_height, 'engine': engine_id, 'camera': camera.name,
            'seconds': _number(time.monotonic() - started, 3),
            'image': _agent_image(path, out_width, out_height, agent_image),
        }

    def python_api(self, params):
        args = Args('python_api', params, ('identifier',))
        identifier = args.text('identifier', required=True).strip()
        kind, text = _api_doc(identifier)
        truncated = len(text) > API_TEXT_LIMIT
        if truncated:
            note = '\n[truncated; ask for a specific property, function, or operator]'
            text = text[:API_TEXT_LIMIT - len(note)] + note
        return {'identifier': identifier, 'kind': kind, 'text': text, 'truncated': truncated}

    def checkpoint(self, params):
        Args('checkpoint', params, ())
        self._require_undo('checkpoint')
        _ensure_object_mode()
        number = self.next_checkpoint
        self._push(f'Checkpoint {number}', number)
        self.next_checkpoint += 1
        self.clean = True
        self.restored = False
        return {'checkpoint': number}

    def undo(self, params):
        """Return to the latest checkpoint. With no changes since it, the scene already matches it
        and nothing is undone; only a repeated undo steps back to the checkpoint before."""
        Args('undo', params, ())
        self._require_undo('undo')
        _ensure_object_mode()
        if not self.clean:
            self._push('Before undo', None)
            self._step_back()
        elif self.restored:
            if self.position <= 0:
                oldest = self.steps[self.position]
                if oldest == 0:
                    raise ParamError('undo: no earlier checkpoint is kept; the scene is at the state it was opened in')
                raise ParamError(
                    f'undo: no earlier checkpoint is kept; the scene is at checkpoint {oldest}, the oldest one left, '
                    f'because Blender keeps only its {bpy.context.preferences.edit.undo_steps} most recent undo steps')
            self._step_back()
            self.unsaved = True
        self.clean = True
        self.restored = True
        return {'checkpoint': self.steps[self.position]}

    def _step_back(self):
        with _undo_context():
            if not bpy.ops.ed.undo.poll():
                raise RuntimeError('undo: Blender has no earlier undo step')
            bpy.ops.ed.undo()
        self.position -= 1

    def shutdown(self, params):
        Args('shutdown', params, ())
        return {}


METHODS = {
    'ping': Worker.ping,
    'scene_info': Worker.scene_info,
    'object_info': Worker.object_info,
    'execute_python': Worker.execute_python,
    'new_scene': Worker.new_scene,
    'open_blend': Worker.open_blend,
    'save_blend': Worker.save_blend,
    'import_file': Worker.import_file,
    'export_gltf': Worker.export_gltf,
    'export_file': Worker.export_file,
    'render_preview': Worker.render_preview,
    'render': Worker.render,
    'python_api': Worker.python_api,
    'undo': Worker.undo,
    'checkpoint': Worker.checkpoint,
    'shutdown': Worker.shutdown,
}


def _end_worker(code):
    """End the worker at once. When it leads its process group, as the server starts it on POSIX,
    kill the group with SIGKILL, so processes that executed code started end with it; otherwise
    exit with ``code``."""
    if hasattr(os, 'killpg') and os.getpgrp() == os.getpid():
        os.killpg(os.getpid(), signal.SIGKILL)
    os._exit(code)


def _end_when_unread(fd):
    """End the worker once nothing reads the reply pipe ``fd``: the server is gone. The main thread
    can be busy with one request indefinitely, so this thread checks every SERVER_CHECK_SECONDS,
    whenever executed code lets Python threads run. poll() reports POLLHUP (on macOS only for a
    descriptor registered for POLLOUT) or POLLERR once the pipe has no reader."""
    poller = select.poll()
    poller.register(fd, select.POLLOUT)
    gone = select.POLLHUP | select.POLLERR | select.POLLNVAL
    while not any(events & gone for _, events in poller.poll(0)):
        time.sleep(SERVER_CHECK_SECONDS)
    _end_worker(1)


def main():
    try:
        replies = os.fdopen(REPLY_FD, 'w', buffering=1, encoding='utf-8')
    except OSError as error:
        sys.stderr.write(f'wasd_blender_worker: file descriptor {REPLY_FD} must be the reply pipe ({error})\n')
        sys.stderr.flush()
        os._exit(2)
    os.set_inheritable(REPLY_FD, False)
    if hasattr(select, 'poll'):
        threading.Thread(target=_end_when_unread, args=(REPLY_FD,), name='wasd-blender-server-check', daemon=True).start()
    for stream in (sys.stdout, sys.stderr):
        reconfigure = getattr(stream, 'reconfigure', None)
        if reconfigure is not None:
            try:
                reconfigure(line_buffering=True)
            except (ValueError, io.UnsupportedOperation):
                continue  # A host-replaced stream keeps its own buffering; logs may arrive later.
    # Blender may replace sys.stdin; requests always come from the inherited descriptor 0.
    requests = os.fdopen(0, 'rb', closefd=False)
    worker = Worker(replies)
    worker.send({'ready': True, 'protocol': PROTOCOL, 'app': 'blender', 'version': _version(), 'python': platform.python_version()})
    while True:
        line = requests.readline()
        if not line:
            # Standard input closed without a shutdown request: the server is gone.
            _end_worker(0)
        text = line.decode('utf-8', errors='surrogateescape')
        try:
            if text.strip() and worker.handle(text):
                break
        except (BrokenPipeError, ConnectionResetError):
            # The reply pipe lost its reader while the reply was written: the server is gone.
            _end_worker(1)
    replies.flush()
    sys.stdout.flush()
    sys.stderr.flush()
    os._exit(0)


main()
