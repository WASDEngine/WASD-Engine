"""Headless GIMP 3 worker for the dsh-gimp MCP server.

The MCP server starts GIMP with this file as a python-fu-eval batch command::

    GIMP3_DIRECTORY=<profile> gimp-console-3.x -n -s -c --batch-interpreter=python-fu-eval \\
        -b 'import runpy; runpy.run_path("<this file>", run_name="__main__")' --quit

The batch command runs in GIMP's Python plug-in process, which inherits the
launcher's stdin and fd 3. Protocol (one JSON object per line):

- requests on stdin: ``{"id": <int>, "method": "<name>", "params": {...}}``;
- replies on fd 3: first ``{"ready": true, "protocol": 1, "app": "gimp",
  "version": "<GIMP version>", "python": "<x.y.z>"}``, then, in request order,
  ``{"id": <int>, "ok": true, "result": <json>}`` or ``{"id": <int>, "ok": false,
  "error": {"type": "<exception class>", "message": "...", "traceback": "..."}}``
  (``traceback`` only for unexpected failures).

Stdout and stderr stay GIMP's log streams. The worker handles one request at a
time and returns when stdin closes or after replying to ``shutdown``; GIMP then
quits through ``--quit``. Replies never contain NaN, Infinity, or integers that
JavaScript cannot represent exactly, and a reply line longer than the server
accepts becomes an error reply. Every GIMP call uses the non-interactive run
mode. Images are referenced by GIMP image id and layers by item id or exact
name; coordinates are image pixels. Image files the worker writes for the server
to read (snapshots, at a path stem the server chooses) are left for the server
to delete.

GIMP keeps running after its Python plug-in process dies, so on POSIX a
watchdog process kills GIMP when this process ends without finishing; the
server then sees the worker exit instead of waiting for a reply. This process
also ends without finishing once nothing reads its replies, so GIMP stops when
the server dies during a request.
"""

from __future__ import annotations

import collections
import contextlib
import difflib
import io
import json
import math
import os
import platform
import re
import select
import struct
import subprocess
import sys
import threading
import time
import traceback
import warnings
from typing import Any, Callable, Deque, Dict, Iterator, List, Optional, Tuple

import gi

gi.require_version('Gimp', '3.0')
gi.require_version('Gegl', '0.4')
gi.require_version('Babl', '0.1')
from gi.repository import Babl, Gegl, Gimp, Gio, GLib, GObject  # noqa: E402

PROTOCOL = 1
REPLY_FD = 3
# The server stops a worker that writes a longer reply line, in bytes (MAX_REPLY_BYTES of dsh-app-mcp).
MAX_REPLY_BYTES = 32 * 1024 * 1024
# Larger integers lose precision as JSON numbers in JavaScript (Number.MAX_SAFE_INTEGER).
MAX_EXACT_INTEGER = 2 ** 53 - 1
# Seconds between checks that the server still reads the replies.
SERVER_CHECK_SECONDS = 1.0
# Captured output, serialized results, and error messages are cut to this many characters.
OUTPUT_LIMIT = 20000
# The common GPU texture size limit; larger canvases are rejected.
MAX_DIMENSION = 8192
MAX_LAYERS_LISTED = 500
MAX_ITEMS_LISTED = 200
MAX_SHEET_FRAMES = 256
MAX_TEXT_CHARS = 10000
MAX_HELP_CHARS = 3000
MAX_CODE_CHARS = 200000
# Snapshots of images whose long edge is shorter than this are enlarged by an
# integer factor with nearest-neighbor sampling so pixel art stays legible.
SNAPSHOT_MIN_EDGE = 256
# Default largest snapshot file; a larger PNG is replaced by a smaller JPEG.
SNAPSHOT_MAX_BYTES = 3 * 1024 * 1024
# JPEG quality (0..1) and the long edge below which a JPEG snapshot is no longer shrunk.
SNAPSHOT_JPEG_QUALITY = 0.85
SNAPSHOT_JPEG_MIN_EDGE = 64
# Transparent snapshot areas render as GIMP's mid-tone checkerboard.
CHECK_SIZE = 8
CHECK_COLORS = ('#999999', '#666666')
NONINTERACTIVE = Gimp.RunMode.NONINTERACTIVE
SRGB_U8 = "R'G'B'A u8"

# Export formats by file extension; ``opaque`` formats are flattened onto white.
EXPORT_FORMATS: Dict[str, Dict[str, Any]] = {
    '.png': {'format': 'png', 'opaque': False},
    '.webp': {'format': 'webp', 'opaque': False, 'quality': ('file-webp-export', 1.0)},
    '.jpg': {'format': 'jpeg', 'opaque': True, 'quality': ('file-jpeg-export', 0.01)},
    '.jpeg': {'format': 'jpeg', 'opaque': True, 'quality': ('file-jpeg-export', 0.01)},
    '.tga': {'format': 'tga', 'opaque': False},
    '.bmp': {'format': 'bmp', 'opaque': True},
    '.ico': {'format': 'ico', 'opaque': False},
    '.xcf': {'format': 'xcf', 'opaque': False},
}

INT_SPECS = tuple(
    getattr(GObject, name)
    for name in (
        'ParamSpecInt', 'ParamSpecUInt', 'ParamSpecInt64', 'ParamSpecUInt64',
        'ParamSpecLong', 'ParamSpecULong', 'ParamSpecChar', 'ParamSpecUChar',
    )
    if hasattr(GObject, name)
)
FLOAT_SPECS = (GObject.ParamSpecDouble, GObject.ParamSpecFloat)
# Unit spellings accepted besides the names GIMP gives its units (Gimp.Unit.get_name()).
UNIT_ALIASES = {
    'pixel': 'pixels', 'px': 'pixels', 'inch': 'inches', 'mm': 'millimeters', 'millimeter': 'millimeters',
    'point': 'points', 'pica': 'picas',
}
# Format of the weight masks make_seamless blends with.
MASK_FORMAT = 'Y float'


class GimpError(Exception):
    """A GIMP procedure reported failure; the message carries GIMP's reason."""


class NotFoundError(LookupError):
    """A referenced image, layer, item, font, filter, or procedure does not exist."""


_MISSING = object()


def _log(message: str) -> None:
    """Write one diagnostic line to the worker's stderr log stream."""
    sys.stderr.write(f'wasd_gimp_worker: {message}\n')
    sys.stderr.flush()


def _clip(text: str, limit: int = OUTPUT_LIMIT) -> str:
    """Return ``text`` cut to ``limit`` characters, keeping its head and tail."""
    if len(text) <= limit:
        return text
    return _cut(text, text, len(text), limit)


def _cut(head: str, tail: str, total: int, limit: int) -> str:
    """Return the start of ``head`` and the end of ``tail`` around an omission marker, ``limit``
    characters together, for a text of ``total`` characters that begins with ``head`` and ends
    with ``tail``; each must hold at least ``limit`` characters of it."""
    marker = f'\n[... {total - limit} characters omitted ...]\n'
    keep = max(0, limit - len(marker))
    first = keep // 2
    return head[:first] + marker + tail[len(tail) - (keep - first):]


class BoundedOutput(io.TextIOBase):
    """Text stream for the printed output of executed code. It keeps the first and the last
    ``limit`` characters written, so its memory stays bounded however much the code prints, and
    :meth:`text` returns what ``_clip`` returns for the whole output. Threads may write at once."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self._limit = limit
        self._head: List[str] = []
        self._head_size = 0
        self._tail: Deque[str] = collections.deque()
        self._tail_size = 0
        self._total = 0
        # The code may print from several threads. Reentrant, so that a signal handler that prints
        # during a write in its own thread does not deadlock.
        self._lock = threading.RLock()

    def writable(self) -> bool:
        return True

    def write(self, text: str) -> int:
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

    def text(self) -> str:
        """Return the output, cut to ``limit`` characters around an omission marker when it is longer."""
        with self._lock:
            head = ''.join(self._head)
            if self._total <= self._limit:
                return head
            return _cut(head, ''.join(self._tail), self._total, self._limit)


def _last_error() -> str:
    """Return the message of the last failed PDB call made by this plug-in."""
    pdb = Gimp.get_pdb()
    message = pdb.get_last_error() if pdb is not None else ''
    return message if message and message != 'success' else 'GIMP gave no reason'


def _ensure(value: Any, what: str) -> Any:
    """Return ``value``, raising GimpError with GIMP's reason when it is False or None."""
    if value is None or value is False:
        raise GimpError(f'{what} failed: {_last_error()}')
    return value


def _check_last_status(what: str) -> None:
    """Raise GimpError when the last PDB call of a void libgimp function failed."""
    pdb = Gimp.get_pdb()
    if pdb is not None and pdb.get_last_status() != Gimp.PDBStatusType.SUCCESS:
        raise GimpError(f'{what} failed: {_last_error()}')


def _set_property(obj: GObject.Object, name: str, value: Any, label: str) -> None:
    """Set a GObject property, turning GLib's out-of-range warnings into ValueError.

    GLib only warns and keeps the previous value when a property value is
    invalid, so every warning except deprecations fails the call.
    """
    with warnings.catch_warnings(record=True) as caught:
        warnings.simplefilter('always')
        try:
            obj.set_property(name, value)
        except TypeError as error:
            raise ValueError(f'{label}: {error}') from None
    for warning in caught:
        if not issubclass(warning.category, (DeprecationWarning, PendingDeprecationWarning)):
            raise ValueError(f'{label}: {warning.message}')


def _nick(name: str) -> str:
    """Normalize an enum or option spelling: lower case, ``-`` for ``_`` and spaces."""
    return name.strip().lower().replace('_', '-').replace(' ', '-')


def _enum_members(enum_class: Any) -> Dict[str, Any]:
    """Map each value nick of a GObject enum class to its member."""
    return {member.value_nick: member for member in enum_class.__enum_values__.values()}


# Modules searched for the Python class of a GType, by GType name prefix.
TYPE_MODULES = (('Gimp', (Gimp,)), ('Gegl', (Gegl,)), ('G', (GObject, Gio, GLib)))


def _gtype_class(gtype: GObject.GType) -> Any:
    """Return the Python class of an enum or object GType, or None when no loaded module defines it.

    ``GType.pytype`` stays None until PyGObject first loads the class, so the
    class is looked up by name in the module that defines it. Enum classes are
    never read from ``GObject.ParamSpecEnum.enum_class``: PyGObject's override
    of it frees the GEnumClass it reads, and the next use of that enum crashes
    the process.
    """
    pytype = gtype.pytype
    if pytype is not None:
        return pytype
    name = GObject.type_name(gtype)
    for prefix, modules in TYPE_MODULES:
        if name.startswith(prefix):
            for module in modules:
                found = getattr(module, name[len(prefix):], None)
                if found is not None:
                    return found
    return None


def _enum_value(enum_class: Any, value: Any, label: str, exclude: Tuple[str, ...] = ()) -> Any:
    """Return the member of ``enum_class`` named by a nick string or an integer value."""
    members = {nick: member for nick, member in _enum_members(enum_class).items() if nick not in exclude}
    if isinstance(value, str):
        member = members.get(_nick(value))
        if member is not None:
            return member
    elif isinstance(value, int) and not isinstance(value, bool):
        for member in members.values():
            if int(member) == value:
                return member
    raise ValueError(f'{label} must be one of {", ".join(sorted(members))}; got {value!r}')


def _color_hex(color: Gegl.Color) -> str:
    """Return a color as ``#rrggbb`` (sRGB), with an ``aa`` suffix when not opaque."""
    data = bytes(color.get_bytes(Babl.format(SRGB_U8)).get_data())
    return '#' + data[:3].hex() + ('' if data[3] == 255 else f'{data[3]:02x}')


_HEX_COLOR = re.compile(r'#([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})')


def _parse_color(value: Any, label: str) -> Gegl.Color:
    """Parse ``#rgb``, ``#rgba``, ``#rrggbb``, ``#rrggbbaa``, or a CSS color into an sRGB color."""
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f'{label} must be a color such as "#ff8800", "#ff880080", "white", or "rgba(255, 136, 0, 0.5)"')
    text = value.strip()
    match = _HEX_COLOR.fullmatch(text)
    if match is not None:
        digits = match.group(1)
        if len(digits) in (3, 4):
            digits = ''.join(digit * 2 for digit in digits)
        color = Gimp.color_parse_hex('#' + digits[:6])
        if color is not None:
            Gimp.color_set_alpha(color, int(digits[6:8], 16) / 255 if len(digits) == 8 else 1.0)
            return color
    color = Gimp.color_parse_css(text)
    if color is None:
        raise ValueError(f'{label} is not a color: {value!r}; use "#rrggbb", "#rrggbbaa", or a CSS color name')
    return color


def _color_alpha(color: Gegl.Color) -> float:
    """Return a color's alpha in 0..1."""
    return bytes(color.get_bytes(Babl.format(SRGB_U8)).get_data())[3] / 255


def _opaque(color: Gegl.Color) -> Gegl.Color:
    """Return a copy of ``color`` with alpha 1."""
    copy = color.duplicate()
    Gimp.color_set_alpha(copy, 1.0)
    return copy


def _absolute_path(value: Any, label: str) -> str:
    """Validate an absolute filesystem path."""
    if not isinstance(value, str) or not value:
        raise ValueError(f'{label} must be an absolute path')
    if not os.path.isabs(value):
        raise ValueError(f'{label} must be an absolute path; got {value!r}')
    return os.path.normpath(value)


def _existing_file(value: Any, label: str) -> str:
    """Validate an absolute path naming an existing regular file."""
    path = _absolute_path(value, label)
    if not os.path.isfile(path):
        raise ValueError(f'{label} {path!r} does not exist or is not a file')
    return path


def _jsonable(value: Any, depth: int = 0) -> Any:
    """Convert GIMP, GObject, and Python values into JSON-compatible values.

    Images become ``{"image": id}``, items ``{"item": id, "name": ...}``,
    colors hex strings, files paths, resources names, enums nicks, integers
    beyond ``MAX_EXACT_INTEGER`` their decimal digits; anything else that JSON
    cannot represent becomes its ``repr``.
    """
    if depth > 8:
        return _safe_repr(value, 200)
    if value is None or isinstance(value, (bool, str)):
        return value
    if isinstance(value, int) and not isinstance(value, GObject.GEnum) and not isinstance(value, GObject.GFlags):
        return value if -MAX_EXACT_INTEGER <= value <= MAX_EXACT_INTEGER else _integer_text(value)
    if isinstance(value, float):
        return value if math.isfinite(value) else repr(value)
    if isinstance(value, GObject.GEnum):
        return value.value_nick
    if isinstance(value, GObject.GFlags):
        return int(value)
    if isinstance(value, Gimp.Image):
        return {'image': value.get_id()}
    if isinstance(value, Gimp.Item):
        return {'item': value.get_id(), 'name': value.get_name()}
    if isinstance(value, Gimp.DrawableFilter):
        return {'filter': value.get_id(), 'operation': value.get_operation_name()}
    if isinstance(value, Gegl.Color):
        return _color_hex(value)
    if isinstance(value, Gio.File):
        return value.get_path() or value.get_uri()
    if isinstance(value, Gimp.Resource):
        return value.get_name()
    if isinstance(value, Gimp.Unit):
        return value.get_name()
    if isinstance(value, GLib.Bytes):
        return {'bytes': value.get_size()}
    if isinstance(value, dict):
        return {str(key): _jsonable(item, depth + 1) for key, item in value.items()}
    if isinstance(value, (list, tuple, set, frozenset)):
        return [_jsonable(item, depth + 1) for item in value]
    return _safe_repr(value, 1000)


def _integer_text(value: int) -> str:
    """Return the decimal digits of ``value``, or its digit count when Python refuses to convert that many."""
    try:
        return str(value)
    except ValueError:
        # Python converts at most sys.get_int_max_str_digits() digits.
        return f'<integer of about {int(math.log10(abs(value))) + 1} digits>'


def _safe_repr(value: Any, limit: int) -> str:
    """Return ``repr(value)`` cut to ``limit`` characters, or a type label when repr fails.

    The repr of some PyGObject boxed wrappers, such as GIMP number arrays, raises.
    """
    try:
        return _clip(repr(value), limit)
    except Exception:  # noqa: BLE001 - any repr failure falls back to the type label
        return f'<{type(value).__name__} value>'


def _finite(value: Any) -> Any:
    """Return ``value`` with every NaN or infinite float in its dicts, lists, and tuples replaced by None."""
    if isinstance(value, float):
        return value if math.isfinite(value) else None
    if isinstance(value, dict):
        return {key: _finite(item) for key, item in value.items()}
    if isinstance(value, (list, tuple)):
        return [_finite(item) for item in value]
    return value


def _bounded_json(value: Any, label: str) -> Any:
    """Return ``value`` as JSON-compatible data, or a clipped string when its JSON exceeds OUTPUT_LIMIT."""
    data = _jsonable(value)
    text = json.dumps(data, ensure_ascii=False)
    if len(text) <= OUTPUT_LIMIT:
        return data
    return _clip(f'[{label} is {len(text)} characters of JSON; showing a clipped copy] ' + text)


def _error_line(reply: Dict[str, Any], error_type: str, text: str) -> str:
    """Return the JSON line of an error reply that replaces ``reply``, for the same request id."""
    return json.dumps({'id': reply.get('id'), 'ok': False, 'error': {'type': error_type, 'message': text}}, ensure_ascii=True, separators=(',', ':'))


class Params:
    """Validated access to one request's params.

    Unknown keys are rejected; JSON null counts as absent.
    """

    def __init__(self, method: str, raw: Any, allowed: frozenset) -> None:
        if raw is None:
            raw = {}
        if not isinstance(raw, dict):
            raise ValueError(f'{method} params must be a JSON object')
        unknown = sorted(set(raw) - allowed)
        if unknown:
            expected = ', '.join(sorted(allowed)) or 'none'
            raise ValueError(f'{method} does not take {", ".join(unknown)}; parameters: {expected}')
        self.method = method
        # Names the method, or its action or mode once ``only`` selected one, in errors.
        self.context = method
        self.values = {key: value for key, value in raw.items() if value is not None}

    def has(self, name: str) -> bool:
        """Return whether ``name`` was given."""
        return name in self.values

    def raw(self, name: str, default: Any = _MISSING) -> Any:
        """Return the given value, ``default`` when absent, or raise when required."""
        if name in self.values:
            return self.values[name]
        if default is _MISSING:
            raise ValueError(f'{self.context} requires {name}')
        return default

    def only(self, context: str, allowed: Tuple[str, ...]) -> None:
        """Reject given params outside ``allowed`` for the selected action or mode."""
        self.context = context
        extra = sorted(name for name in self.values if name not in allowed)
        if extra:
            raise ValueError(f'{", ".join(extra)} {"does" if len(extra) == 1 else "do"} not apply to {context}')

    def integer(self, name: str, default: Any = _MISSING, lo: Optional[int] = None, hi: Optional[int] = None) -> Any:
        """Return an integer param within ``lo``..``hi``."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f'{name} must be an integer; got {value!r}')
        _check_range(name, value, lo, hi)
        return value

    def number(self, name: str, default: Any = _MISSING, lo: Optional[float] = None, hi: Optional[float] = None) -> Any:
        """Return a finite number param within ``lo``..``hi``."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError(f'{name} must be a number; got {value!r}')
        _check_range(name, value, lo, hi)
        return float(value)

    def boolean(self, name: str, default: Any = _MISSING) -> Any:
        """Return a boolean param."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if not isinstance(value, bool):
            raise ValueError(f'{name} must be true or false; got {value!r}')
        return value

    def string(self, name: str, default: Any = _MISSING, choices: Optional[Tuple[str, ...]] = None, limit: int = MAX_TEXT_CHARS, allow_empty: bool = False) -> Any:
        """Return a string param (non-empty unless ``allow_empty``), optionally one of ``choices``."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if not isinstance(value, str) or (not value and not allow_empty):
            raise ValueError(f'{name} must be a non-empty string; got {value!r}')
        if len(value) > limit:
            raise ValueError(f'{name} must be at most {limit} characters; got {len(value)}')
        if choices is not None and value not in choices:
            raise ValueError(f'{name} must be one of {", ".join(choices)}; got {value!r}')
        return value

    def object(self, name: str, default: Any = _MISSING) -> Any:
        """Return a JSON object param."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if not isinstance(value, dict):
            raise ValueError(f'{name} must be a JSON object; got {value!r}')
        return value

    def array(self, name: str, default: Any = _MISSING, lo: int = 0, hi: int = MAX_ITEMS_LISTED) -> Any:
        """Return a JSON array param with ``lo``..``hi`` entries."""
        value = self.raw(name, default)
        if value is default and default is not _MISSING:
            return value
        if not isinstance(value, list):
            raise ValueError(f'{name} must be an array; got {value!r}')
        if not lo <= len(value) <= hi:
            raise ValueError(f'{name} must have {lo} to {hi} entries; got {len(value)}')
        return value


def _check_range(name: str, value: float, lo: Optional[float], hi: Optional[float]) -> None:
    """Raise ValueError when ``value`` is outside ``lo``..``hi``."""
    if (lo is not None and value < lo) or (hi is not None and value > hi):
        bounds = f'between {lo} and {hi}' if lo is not None and hi is not None else (f'at least {lo}' if lo is not None else f'at most {hi}')
        raise ValueError(f'{name} must be {bounds}; got {value}')


def _all_layers(image: Gimp.Image) -> List[Gimp.Layer]:
    """Return every layer of ``image`` depth-first, groups before their children, top first."""
    found: List[Gimp.Layer] = []

    def walk(layers: List[Gimp.Layer]) -> None:
        for layer in layers:
            found.append(layer)
            if layer.is_group():
                walk(layer.get_children())

    walk(image.get_layers())
    return found


def _find_layer(image: Gimp.Image, ref: Any, required: bool = False) -> Gimp.Layer:
    """Return the layer named by id or exact name; default: the selected layer, else the top one."""
    if ref is None:
        if required:
            raise ValueError('layer is required (a layer id or exact name from image_info)')
        selected = [layer for layer in image.get_selected_layers() if layer.is_valid()]
        if selected:
            return selected[0]
        layers = image.get_layers()
        if not layers:
            raise ValueError(f'image {image.get_id()} has no layers')
        return layers[0]
    if isinstance(ref, int) and not isinstance(ref, bool):
        item = Gimp.Item.get_by_id(ref)
        if item is None or not item.is_valid() or not item.is_layer() or item.get_image().get_id() != image.get_id():
            raise NotFoundError(f'image {image.get_id()} has no layer with id {ref}; call image_info to list its layers')
        return Gimp.Layer.get_by_id(ref)
    if isinstance(ref, str) and ref:
        matches = [layer for layer in _all_layers(image) if layer.get_name() == ref]
        if len(matches) == 1:
            return matches[0]
        if not matches:
            raise NotFoundError(f'image {image.get_id()} has no layer named {ref!r}; call image_info to list its layers')
        ids = ', '.join(str(layer.get_id()) for layer in matches)
        raise NotFoundError(f'{len(matches)} layers of image {image.get_id()} are named {ref!r}; pass one of the ids {ids}')
    raise ValueError(f'layer must be a layer id (integer) or an exact layer name; got {ref!r}')


def _pixel_layer(image: Gimp.Image, ref: Any) -> Gimp.Layer:
    """Return the layer ``_find_layer`` names, rejecting a layer group: its pixels are its layers' composite."""
    layer = _find_layer(image, ref)
    if layer.is_group():
        raise ValueError(f'layer {layer.get_name()!r} (id {layer.get_id()}) is a layer group, which has no pixels of its own; pass a layer inside it')
    return layer


def _file_path(file: Optional[Gio.File]) -> Optional[str]:
    """Return the local path of ``file``, if any."""
    return file.get_path() if file is not None else None


def _selection_bounds(image: Gimp.Image) -> Optional[Dict[str, int]]:
    """Return the selection's bounding box in image pixels, or None when nothing is selected."""
    _, non_empty, x1, y1, x2, y2 = Gimp.Selection.bounds(image)
    if not non_empty:
        return None
    return {'x': x1, 'y': y1, 'width': x2 - x1, 'height': y2 - y1}


def _layer_kind(layer: Gimp.Layer) -> str:
    """Return ``text``, ``group``, or ``layer``."""
    if layer.is_text_layer():
        return 'text'
    if layer.is_group():
        return 'group'
    return 'layer'


def _layer_info(layer: Gimp.Layer, budget: Optional[List[int]] = None) -> Dict[str, Any]:
    """Describe a layer; groups include their children while ``budget[0]`` entries remain."""
    if budget is not None:
        budget[0] -= 1
    _, x, y = layer.get_offsets()
    info: Dict[str, Any] = {
        'id': layer.get_id(),
        'name': layer.get_name(),
        'kind': _layer_kind(layer),
        'type': layer.type().value_nick,
        'visible': layer.get_visible(),
        'opacity': round(layer.get_opacity(), 2),
        'mode': layer.get_mode().value_nick,
        'x': x,
        'y': y,
        'width': layer.get_width(),
        'height': layer.get_height(),
        'has_alpha': layer.has_alpha(),
    }
    if info['kind'] == 'text':
        text_layer = layer if isinstance(layer, Gimp.TextLayer) else Gimp.TextLayer.get_by_id(layer.get_id())
        size, _ = text_layer.get_font_size()
        info['text'] = _clip(text_layer.get_text() or '', 500)
        info['font'] = text_layer.get_font().get_name()
        info['font_size'] = size
        info['color'] = _color_hex(text_layer.get_color())
    if info['kind'] == 'group':
        children = layer.get_children()
        info['children'] = [_layer_info(child, budget) for child in _take(children, budget)]
        if budget is not None and len(info['children']) < len(children):
            info['children_omitted'] = len(children) - len(info['children'])
    return info


def _take(layers: List[Gimp.Layer], budget: Optional[List[int]]) -> Iterator[Gimp.Layer]:
    """Yield layers while the shared listing budget lasts."""
    for layer in layers:
        if budget is not None and budget[0] <= 0:
            return
        yield layer


def _layer_tree(image: Gimp.Image) -> Dict[str, Any]:
    """Return the layer tree (top first) capped at MAX_LAYERS_LISTED entries."""
    budget = [MAX_LAYERS_LISTED]
    roots = image.get_layers()
    tree = [_layer_info(layer, budget) for layer in _take(roots, budget)]
    total = len(_all_layers(image))
    result: Dict[str, Any] = {'layers': tree, 'layer_count': total}
    if total > MAX_LAYERS_LISTED:
        result['layers_omitted'] = total - MAX_LAYERS_LISTED
    return result


def _image_size(image: Gimp.Image) -> Dict[str, int]:
    """Return an image's id and canvas size."""
    return {'id': image.get_id(), 'width': image.get_width(), 'height': image.get_height()}


@contextlib.contextmanager
def _context() -> Iterator[None]:
    """Push GIMP's context for the block so color, opacity, and interpolation changes stay local."""
    Gimp.context_push()
    try:
        yield
    finally:
        Gimp.context_pop()


@contextlib.contextmanager
def _selection_suspended(image: Gimp.Image) -> Iterator[None]:
    """Clear the selection for the block and restore it afterwards.

    Whole-layer transforms and filters would otherwise act on the selected
    region only (creating floating selections for transforms).
    """
    if Gimp.Selection.is_empty(image):
        yield
        return
    saved = _ensure(Gimp.Selection.save(image), 'saving the selection')
    Gimp.Selection.none(image)
    try:
        yield
    finally:
        image.select_item(Gimp.ChannelOps.REPLACE, saved)
        image.remove_channel(saved)


def _composite_copy(image: Gimp.Image, flatten: bool) -> Gimp.Image:
    """Return a one-layer duplicate of ``image``'s visible composite; the caller deletes it.

    The source image is never modified. The copy has no selection, so
    histograms and filters on it cover every pixel. ``flatten`` fills
    transparency with white.
    """
    if not any(layer.get_visible() for layer in image.get_layers()):
        raise ValueError(f'image {image.get_id()} has no visible layers')
    copy = image.duplicate()
    try:
        floating = copy.get_floating_sel()
        if floating is not None:
            _ensure(Gimp.floating_sel_anchor(floating), 'anchoring the floating selection')
        _ensure(Gimp.Selection.none(copy), 'clearing the selection of the copy')
        merged = _ensure(copy.merge_visible_layers(Gimp.MergeType.CLIP_TO_IMAGE), 'merging the visible layers')
        for layer in copy.get_layers():
            if layer.get_id() != merged.get_id():
                copy.remove_layer(layer)
        _ensure(merged.resize_to_image_size(), 'resizing the merged layer')
        if flatten:
            with _context():
                Gimp.context_set_background(_parse_color('#ffffff', 'background'))
                _ensure(copy.flatten(), 'flattening')
        return copy
    except BaseException:
        copy.delete()
        raise


def _export_spec(path: str, label: str) -> Dict[str, Any]:
    """Return the export format entry for ``path``'s extension."""
    extension = os.path.splitext(path)[1].lower()
    spec = EXPORT_FORMATS.get(extension)
    if spec is None:
        raise ValueError(f'{label} must end with one of {", ".join(EXPORT_FORMATS)}; got {path!r}')
    return spec


def _run_procedure(name: str, values: Dict[str, Any]) -> Gimp.ValueArray:
    """Run a PDB procedure non-interactively with ``values``; raise GimpError on failure."""
    procedure = _ensure(Gimp.get_pdb().lookup_procedure(name), f'looking up {name}')
    config = procedure.create_config()
    if config.find_property('run-mode') is not None:
        config.set_property('run-mode', NONINTERACTIVE)
    for key, value in values.items():
        _set_property(config, key, value, f'{name} {key}')
    result = procedure.run(config)
    _raise_for_status(name, result)
    return result


def _raise_for_status(name: str, result: Gimp.ValueArray) -> None:
    """Raise GimpError with the procedure's message unless ``result`` reports success."""
    status = result.index(0)
    if status == Gimp.PDBStatusType.SUCCESS:
        return
    message = result.index(1) if result.length() > 1 else None
    if not isinstance(message, str) or not message:
        message = _last_error()
    nick = status.value_nick if isinstance(status, GObject.GEnum) else str(status)
    raise GimpError(f'{name} failed ({nick}): {message}')


def _write_file(image: Gimp.Image, path: str, quality: Optional[float], spec: Dict[str, Any]) -> None:
    """Save or export ``image`` to ``path`` by extension, with an optional quality in 0..100."""
    file = Gio.File.new_for_path(path)
    if quality is None:
        _ensure(Gimp.file_save(NONINTERACTIVE, image, file, None), f'writing {path}')
        return
    procedure, scale = spec['quality']
    _run_procedure(procedure, {'image': image, 'file': file, 'quality': quality * scale})


def _export(image: Gimp.Image, path: str, quality: Optional[float]) -> Dict[str, Any]:
    """Export a composite copy of ``image`` (all layers for XCF) without modifying it.

    The file is written to a hidden temporary sibling and renamed into place,
    so file watchers such as Godot's importer never see a partial file.
    """
    spec = _export_spec(path, 'path')
    if quality is not None and 'quality' not in spec:
        raise ValueError(f'quality applies to .jpg, .jpeg, and .webp exports, not {os.path.splitext(path)[1]}')
    directory, base = os.path.split(path)
    os.makedirs(directory, exist_ok=True)
    temporary = os.path.join(directory, f'.{base}.wasd-{os.getpid()}{os.path.splitext(base)[1]}')
    copy = image.duplicate() if spec['format'] == 'xcf' else _composite_copy(image, spec['opaque'])
    try:
        _write_file(copy, temporary, quality, spec)
        os.replace(temporary, path)
    finally:
        copy.delete()
        with contextlib.suppress(FileNotFoundError):
            os.remove(temporary)
    return {
        'path': path,
        'bytes': os.path.getsize(path),
        'format': spec['format'],
        'width': image.get_width(),
        'height': image.get_height(),
        'flattened': spec['opaque'],
    }


def _has_transparency(drawable: Gimp.Drawable) -> bool:
    """Return whether any pixel of ``drawable`` is not fully opaque."""
    if not drawable.has_alpha():
        return False
    # The alpha histogram's mean, in 0..255, stays exactly 255 only when every pixel is opaque.
    ok, mean, *_ = drawable.histogram(Gimp.HistogramChannel.ALPHA, 0.0, 1.0)
    return not ok or mean < 255.0


def _write_snapshot(image: Gimp.Image, stem: str, max_bytes: int) -> Tuple[str, str]:
    """Write the single-layer ``image`` as ``<stem>.png``, or as a JPEG ``<stem>.jpg`` shrunk to ``max_bytes``.

    Returns the path written and its MIME type; ``image`` is scaled down when
    the JPEG needs shrinking.
    """
    png = stem + '.png'
    _ensure(Gimp.file_save(NONINTERACTIVE, image, Gio.File.new_for_path(png), None), 'writing the snapshot')
    if os.path.getsize(png) <= max_bytes:
        return png, 'image/png'
    os.remove(png)
    jpeg = stem + '.jpg'
    while True:
        _run_procedure('file-jpeg-export', {'image': image, 'file': Gio.File.new_for_path(jpeg), 'quality': SNAPSHOT_JPEG_QUALITY})
        width, height = image.get_width(), image.get_height()
        if os.path.getsize(jpeg) <= max_bytes or max(width, height) <= SNAPSHOT_JPEG_MIN_EDGE:
            return jpeg, 'image/jpeg'
        with _context():
            Gimp.context_set_interpolation(Gimp.InterpolationType.CUBIC)
            _ensure(image.scale(max(1, width * 3 // 4), max(1, height * 3 // 4)), 'shrinking the snapshot')


def _fill(drawable: Gimp.Drawable, color: Gegl.Color) -> None:
    """Fill the selection (or the whole drawable) with ``color``; its alpha sets the fill opacity."""
    with _context():
        Gimp.context_set_foreground(_opaque(color))
        Gimp.context_set_opacity(_color_alpha(color) * 100)
        Gimp.context_set_paint_mode(Gimp.LayerMode.NORMAL)
        _ensure(drawable.edit_fill(Gimp.FillType.FOREGROUND), 'filling')


class Worker:
    """Per-process worker state: image labels, the execute_python namespace, and filter details."""

    def __init__(self, replies: io.TextIOBase) -> None:
        self._replies = replies
        self._labels: Dict[int, str] = {}
        self._details: Dict[str, Dict[str, Any]] = {}
        self._namespace: Dict[str, Any] = {
            '__name__': '__wasd_gimp__',
            'Gimp': Gimp, 'Gio': Gio, 'Gegl': Gegl, 'GLib': GLib, 'GObject': GObject, 'Babl': Babl,
        }

    # Protocol --------------------------------------------------------------

    def serve(self) -> None:
        """Answer requests from stdin until it closes or ``shutdown`` arrives."""
        self._send({'ready': True, 'protocol': PROTOCOL, 'app': 'gimp', 'version': Gimp.version(), 'python': platform.python_version()})
        requests = os.fdopen(0, 'rb', closefd=False)
        while True:
            line = requests.readline()
            if not line:
                return
            line = line.strip()
            if not line:
                continue
            try:
                request = json.loads(line)
            except ValueError as error:
                _log(f'ignoring a request line that is not JSON: {error}')
                continue
            request_id = request.get('id') if isinstance(request, dict) else None
            if not isinstance(request_id, int) or isinstance(request_id, bool):
                _log('ignoring a request without an integer id')
                continue
            method = request.get('method')
            if method == 'shutdown':
                self._send({'id': request_id, 'ok': True, 'result': {'shutdown': True}})
                return
            self._send(self._dispatch(request_id, method, request.get('params')))

    def _send(self, message: Dict[str, Any]) -> None:
        """Write one reply line; a reply that cannot be serialized, or exceeds ``MAX_REPLY_BYTES``, becomes an error reply.

        JSON has no NaN or Infinity, so non-finite numbers are sent as null.
        """
        try:
            line = json.dumps(_finite(message), ensure_ascii=True, allow_nan=False, separators=(',', ':'))
        except (TypeError, ValueError) as error:
            line = _error_line(message, type(error).__name__, f'the result could not be encoded as JSON: {_clip(str(error))}')
        # ensure_ascii makes every character one byte.
        if len(line) > MAX_REPLY_BYTES:
            line = _error_line(message, 'ValueError', f'the request completed, but its reply is {len(line)} bytes of JSON, more than the {MAX_REPLY_BYTES} bytes the server accepts')
        self._replies.write(line + '\n')
        self._replies.flush()

    def _dispatch(self, request_id: int, method: Any, params: Any) -> Dict[str, Any]:
        """Run one method and build its reply."""
        try:
            entry = METHODS.get(method) if isinstance(method, str) else None
            if entry is None:
                raise NotFoundError(f'unknown method {method!r}; methods: {", ".join(sorted(METHODS))}')
            handler, allowed = entry
            result = handler(self, Params(method, params, allowed))
            return {'id': request_id, 'ok': True, 'result': result}
        except (ValueError, NotFoundError, GimpError) as error:
            return {'id': request_id, 'ok': False, 'error': {'type': type(error).__name__, 'message': _clip(str(error))}}
        except Exception as error:  # noqa: BLE001 - every failure must reach the caller as a reply
            return {
                'id': request_id, 'ok': False,
                'error': {'type': type(error).__name__, 'message': _clip(str(error) or type(error).__name__), 'traceback': _clip(traceback.format_exc(), 4000)},
            }

    # Lookups ---------------------------------------------------------------

    def _image(self, p: Params, name: str = 'image') -> Gimp.Image:
        """Return the open image whose id is param ``name``."""
        image_id = p.integer(name, lo=1)
        image = Gimp.Image.get_by_id(image_id)
        if image is None or not image.is_valid():
            raise NotFoundError(f'no open image has id {image_id}; call list_images to see open images')
        return image

    def _image_summary(self, image: Gimp.Image) -> Dict[str, Any]:
        """Return the list_images entry for ``image``."""
        return {
            'id': image.get_id(),
            'name': self._labels.get(image.get_id()) or image.get_name(),
            'file': _file_path(image.get_file()),
            'width': image.get_width(),
            'height': image.get_height(),
            'base_type': image.get_base_type().value_nick,
            'precision': image.get_precision().value_nick,
            'layer_count': len(_all_layers(image)),
            'dirty': image.is_dirty(),
        }

    def _image_info(self, image: Gimp.Image) -> Dict[str, Any]:
        """Return the image_info result for ``image``."""
        info = self._image_summary(image)
        del info['layer_count']
        _, xres, yres = image.get_resolution()
        floating = image.get_floating_sel()
        info.update({
            'resolution': {'x': round(xres, 3), 'y': round(yres, 3)},
            **_layer_tree(image),
            'selected_layers': [layer.get_id() for layer in image.get_selected_layers()],
            'selection': _selection_bounds(image),
            'floating_selection': floating.get_id() if floating is not None else None,
        })
        return info

    # Images ----------------------------------------------------------------

    @staticmethod
    def _open_images() -> List[Gimp.Image]:
        """Return the open images in id order."""
        return sorted((image for image in Gimp.get_images() if image.is_valid()), key=lambda image: image.get_id())

    def ping(self, p: Params) -> Dict[str, Any]:
        """Report liveness and the number of open images."""
        return {'pong': True, 'version': Gimp.version(), 'images': len(self._open_images())}

    def list_images(self, p: Params) -> Dict[str, Any]:
        """List open images."""
        images = self._open_images()
        result: Dict[str, Any] = {'images': [self._image_summary(image) for image in images[:MAX_ITEMS_LISTED]], 'count': len(images)}
        if len(images) > MAX_ITEMS_LISTED:
            result['omitted'] = len(images) - MAX_ITEMS_LISTED
        return result

    def open_image(self, p: Params) -> Dict[str, Any]:
        """Open an image file (any format GIMP reads, including XCF)."""
        path = _existing_file(p.raw('path'), 'path')
        already = [image.get_id() for image in self._open_images() if _file_path(image.get_file()) == path]
        image = Gimp.file_load(NONINTERACTIVE, Gio.File.new_for_path(path))
        if image is None or not image.is_valid():
            raise GimpError(f'opening {path} failed: {_last_error()}')
        info = self._image_info(image)
        if already:
            info['also_open_as'] = already
        return info

    def new_image(self, p: Params) -> Dict[str, Any]:
        """Create an RGB image with one RGBA layer named Background."""
        width = p.integer('width', lo=1, hi=MAX_DIMENSION)
        height = p.integer('height', lo=1, hi=MAX_DIMENSION)
        fill = p.string('fill', 'transparent')
        name = p.string('name', None, limit=200)
        color = None if _nick(fill) == 'transparent' else _parse_color(fill, 'fill')
        image = _ensure(Gimp.Image.new(width, height, Gimp.ImageBaseType.RGB), 'creating the image')
        try:
            layer = _ensure(Gimp.Layer.new(image, 'Background', width, height, Gimp.ImageType.RGBA_IMAGE, 100.0, Gimp.LayerMode.NORMAL), 'creating the layer')
            _ensure(image.insert_layer(layer, None, 0), 'inserting the layer')
            _ensure(layer.fill(Gimp.FillType.TRANSPARENT), 'clearing the layer')
            if color is not None:
                _fill(layer, color)
            image.set_selected_layers([layer])
            image.clean_all()
        except BaseException:
            image.delete()
            raise
        if name is not None:
            self._labels[image.get_id()] = name
        return self._image_info(image)

    def image_info(self, p: Params) -> Dict[str, Any]:
        """Describe an image: size, layers, selection."""
        return self._image_info(self._image(p))

    def snapshot(self, p: Params) -> Dict[str, Any]:
        """Render the visible composite within ``max_size`` to ``<stem>.png`` without changing the image.

        When the PNG exceeds ``max_bytes``, a JPEG ``<stem>.jpg`` replaces it,
        shrunk until it fits. The caller reads and deletes the file.
        """
        image = self._image(p)
        max_size = p.integer('max_size', 1024, lo=16, hi=4096)
        stem = _absolute_path(p.raw('stem'), 'stem')
        max_bytes = p.integer('max_bytes', SNAPSHOT_MAX_BYTES, lo=1024)
        copy = _composite_copy(image, flatten=False)
        try:
            if copy.get_base_type() != Gimp.ImageBaseType.RGB:
                _ensure(copy.convert_rgb(), 'converting the snapshot to RGB')
            if copy.get_precision() != Gimp.Precision.U8_NON_LINEAR:
                _ensure(copy.convert_precision(Gimp.Precision.U8_NON_LINEAR), 'converting the snapshot to 8-bit')
            width, height = image.get_width(), image.get_height()
            edge = max(width, height)
            if edge > max_size:
                scale = max_size / edge
                interpolation = Gimp.InterpolationType.CUBIC
            else:
                scale = float(max(1, min(SNAPSHOT_MIN_EDGE, max_size) // edge))
                interpolation = Gimp.InterpolationType.NONE
            out_width, out_height = max(1, round(width * scale)), max(1, round(height * scale))
            if (out_width, out_height) != (width, height):
                with _context():
                    Gimp.context_set_interpolation(interpolation)
                    _ensure(copy.scale(out_width, out_height), 'scaling the snapshot')
            transparency = 'none'
            if _has_transparency(copy.get_layers()[0]):
                self._underlay_checkerboard(copy)
                transparency = 'checkerboard'
            os.makedirs(os.path.dirname(stem), exist_ok=True)
            path, mime_type = _write_snapshot(copy, stem, max_bytes)
            out_width, out_height = copy.get_width(), copy.get_height()
        finally:
            copy.delete()
        return {
            'path': path,
            'mime_type': mime_type,
            'width': out_width,
            'height': out_height,
            'image': _image_size(image),
            'scale': round(out_width / width, 4),
            'transparency': transparency,
        }

    @staticmethod
    def _underlay_checkerboard(image: Gimp.Image) -> None:
        """Put a checkerboard under the single layer of ``image`` and flatten it."""
        board = _ensure(
            Gimp.Layer.new(image, 'checkerboard', image.get_width(), image.get_height(), Gimp.ImageType.RGBA_IMAGE, 100.0, Gimp.LayerMode.NORMAL),
            'creating the checkerboard',
        )
        _ensure(image.insert_layer(board, None, 1), 'inserting the checkerboard')
        board_filter = Gimp.DrawableFilter.new(board, 'gegl:checkerboard', None)
        config = board_filter.get_config()
        config.set_property('x', CHECK_SIZE)
        config.set_property('y', CHECK_SIZE)
        config.set_property('color1', _parse_color(CHECK_COLORS[0], 'check color'))
        config.set_property('color2', _parse_color(CHECK_COLORS[1], 'check color'))
        board_filter.update()
        board.merge_filter(board_filter)
        _check_last_status('rendering the checkerboard')
        _ensure(image.flatten(), 'flattening the snapshot')

    def export_image(self, p: Params) -> Dict[str, Any]:
        """Export the visible composite by extension; the image stays unchanged."""
        image = self._image(p)
        path = _absolute_path(p.raw('path'), 'path')
        quality = p.number('quality', None, lo=0, hi=100)
        return _export(image, path, quality)

    def save_xcf(self, p: Params) -> Dict[str, Any]:
        """Save the image with all layers as XCF and make that file the image's file.

        GIMP then names the image after the file, so a name given to
        new_image or make_sprite_sheet no longer replaces GIMP's name.
        """
        image = self._image(p)
        if p.has('path'):
            path = _absolute_path(p.raw('path'), 'path')
        else:
            path = _file_path(image.get_xcf_file()) or ''
            if not path:
                raise ValueError(f'image {image.get_id()} has no XCF file yet; pass path')
        if not path.lower().endswith('.xcf'):
            raise ValueError(f'path must end with .xcf; got {path!r}')
        os.makedirs(os.path.dirname(path), exist_ok=True)
        _ensure(Gimp.file_save(NONINTERACTIVE, image, Gio.File.new_for_path(path), None), f'saving {path}')
        self._labels.pop(image.get_id(), None)
        return {'path': path, 'bytes': os.path.getsize(path), 'image': image.get_id()}

    def close_image(self, p: Params) -> Dict[str, Any]:
        """Close an image without saving."""
        image = self._image(p)
        image_id, dirty = image.get_id(), image.is_dirty()
        _ensure(image.delete(), f'closing image {image_id}')
        self._labels.pop(image_id, None)
        return {'closed': image_id, 'discarded_unsaved_changes': dirty}

    # Layers ----------------------------------------------------------------

    LAYER_ACTIONS = {
        'add': ('name', 'opacity', 'visible', 'mode', 'offset_x', 'offset_y', 'position'),
        'duplicate': ('layer', 'name'),
        'delete': ('layer',),
        'rename': ('layer', 'name'),
        'set': ('layer', 'name', 'opacity', 'visible', 'mode', 'offset_x', 'offset_y'),
        'move': ('layer', 'position'),
        'merge_down': ('layer',),
        'merge_visible': (),
        'flatten': (),
    }

    def layer(self, p: Params) -> Dict[str, Any]:
        """Add, duplicate, delete, rename, change, restack, or merge layers."""
        image = self._image(p)
        action = p.string('action', choices=tuple(self.LAYER_ACTIONS))
        p.only(f"layer action '{action}'", ('image', 'action') + self.LAYER_ACTIONS[action])
        target: Optional[Gimp.Layer] = None
        if action == 'add':
            target = _ensure(
                Gimp.Layer.new(image, p.string('name', 'Layer', limit=200), image.get_width(), image.get_height(), Gimp.ImageType.RGBA_IMAGE, 100.0, Gimp.LayerMode.NORMAL),
                'creating the layer',
            )
            _ensure(image.insert_layer(target, None, p.integer('position', 0, lo=0)), 'inserting the layer')
            _ensure(target.fill(Gimp.FillType.TRANSPARENT), 'clearing the layer')
            self._set_layer_properties(target, p)
            image.set_selected_layers([target])
        elif action == 'duplicate':
            source = _find_layer(image, p.raw('layer', None))
            target = _ensure(source.copy(), 'duplicating the layer')
            parent = source.get_parent()
            _ensure(image.insert_layer(target, parent, image.get_item_position(source)), 'inserting the copy')
            if p.has('name'):
                target.set_name(p.string('name', limit=200))
            image.set_selected_layers([target])
        elif action == 'delete':
            doomed = _find_layer(image, p.raw('layer', None), required=True)
            _ensure(image.remove_layer(doomed), 'deleting the layer')
        elif action == 'rename':
            target = _find_layer(image, p.raw('layer', None), required=True)
            _ensure(target.set_name(p.string('name', limit=200)), 'renaming the layer')
        elif action == 'set':
            target = _find_layer(image, p.raw('layer', None), required=True)
            if not any(p.has(name) for name in self.LAYER_ACTIONS['set'][1:]):
                raise ValueError("layer action 'set' needs at least one of name, opacity, visible, mode, offset_x, offset_y")
            if p.has('name'):
                _ensure(target.set_name(p.string('name', limit=200)), 'renaming the layer')
            self._set_layer_properties(target, p)
        elif action == 'move':
            target = _find_layer(image, p.raw('layer', None), required=True)
            position = p.integer('position', lo=0)
            _ensure(image.reorder_item(target, target.get_parent(), position), 'moving the layer')
        elif action == 'merge_down':
            upper = _find_layer(image, p.raw('layer', None))
            target = _ensure(image.merge_down(upper, Gimp.MergeType.EXPAND_AS_NECESSARY), 'merging down')
        elif action == 'merge_visible':
            target = _ensure(image.merge_visible_layers(Gimp.MergeType.CLIP_TO_IMAGE), 'merging the visible layers')
        else:
            target = _ensure(image.flatten(), 'flattening')
        result: Dict[str, Any] = {'image': _image_size(image), 'layer': _layer_info(target) if target is not None else None}
        result.update(_layer_tree(image))
        return result

    def _set_layer_properties(self, layer: Gimp.Layer, p: Params) -> None:
        """Apply the opacity, visibility, mode, and offset params that were given."""
        if p.has('opacity'):
            _ensure(layer.set_opacity(p.number('opacity', lo=0, hi=100)), 'setting the opacity')
        if p.has('visible'):
            _ensure(layer.set_visible(p.boolean('visible')), 'setting the visibility')
        if p.has('mode'):
            mode = _enum_value(Gimp.LayerMode, p.raw('mode'), 'mode', exclude=tuple(nick for nick in _enum_members(Gimp.LayerMode) if nick.endswith('-legacy')))
            _ensure(layer.set_mode(mode), 'setting the mode')
        if p.has('offset_x') or p.has('offset_y'):
            _, x, y = layer.get_offsets()
            _ensure(layer.set_offsets(p.integer('offset_x', x), p.integer('offset_y', y)), 'moving the layer')

    # Selection -------------------------------------------------------------

    SELECT_MODES = {
        'all': (), 'none': (), 'invert': (),
        'rect': ('x', 'y', 'width', 'height', 'operation'),
        'ellipse': ('x', 'y', 'width', 'height', 'operation'),
        'color': ('color', 'threshold', 'layer', 'operation'),
        'grow': ('amount',), 'shrink': ('amount',), 'feather': ('amount',),
    }
    OPERATIONS = {
        'replace': Gimp.ChannelOps.REPLACE, 'add': Gimp.ChannelOps.ADD,
        'subtract': Gimp.ChannelOps.SUBTRACT, 'intersect': Gimp.ChannelOps.INTERSECT,
    }

    def select(self, p: Params) -> Dict[str, Any]:
        """Change the selection; returns its bounding box."""
        image = self._image(p)
        mode = p.string('mode', choices=tuple(self.SELECT_MODES))
        p.only(f"select mode '{mode}'", ('image', 'mode') + self.SELECT_MODES[mode])
        operation = self.OPERATIONS[p.string('operation', 'replace', choices=tuple(self.OPERATIONS))]
        if mode == 'all':
            _ensure(Gimp.Selection.all(image), 'selecting all')
        elif mode == 'none':
            _ensure(Gimp.Selection.none(image), 'clearing the selection')
        elif mode == 'invert':
            _ensure(Gimp.Selection.invert(image), 'inverting the selection')
        elif mode in ('rect', 'ellipse'):
            x = p.number('x', 0.0)
            y = p.number('y', 0.0)
            width = p.number('width', lo=1)
            height = p.number('height', lo=1)
            with _context():
                Gimp.context_set_antialias(mode == 'ellipse')
                Gimp.context_set_feather(False)
                select = image.select_rectangle if mode == 'rect' else image.select_ellipse
                _ensure(select(operation, x, y, width, height), f'selecting the {mode}')
        elif mode == 'color':
            drawable = _find_layer(image, p.raw('layer', None))
            color = _parse_color(p.raw('color'), 'color')
            threshold = p.number('threshold', 15.0, lo=0, hi=255)
            with _context():
                Gimp.context_set_sample_threshold(threshold / 255)
                Gimp.context_set_sample_criterion(Gimp.SelectCriterion.COMPOSITE)
                Gimp.context_set_sample_merged(False)
                Gimp.context_set_antialias(False)
                Gimp.context_set_feather(False)
                _ensure(image.select_color(operation, drawable, color), 'selecting by color')
        else:
            amount = p.number('amount', lo=0, hi=MAX_DIMENSION)
            if mode == 'grow':
                _ensure(Gimp.Selection.grow(image, round(amount)), 'growing the selection')
            elif mode == 'shrink':
                _ensure(Gimp.Selection.shrink(image, round(amount)), 'shrinking the selection')
            else:
                _ensure(Gimp.Selection.feather(image, amount), 'feathering the selection')
        return {'image': _image_size(image), 'selection': _selection_bounds(image)}

    # Transforms ------------------------------------------------------------

    TRANSFORM_ACTIONS = {
        'scale_image': ('width', 'height', 'interpolation'),
        'resize_canvas': ('width', 'height', 'x', 'y'),
        'crop': ('width', 'height', 'x', 'y'),
        'rotate': ('angle', 'layer', 'interpolation'),
        'flip': ('axis', 'layer'),
        'scale_layer': ('layer', 'width', 'height', 'x', 'y', 'interpolation'),
    }

    def transform(self, p: Params) -> Dict[str, Any]:
        """Scale, resize, crop, rotate, or flip the image or one layer."""
        image = self._image(p)
        action = p.string('action', choices=tuple(self.TRANSFORM_ACTIONS))
        p.only(f"transform action '{action}'", ('image', 'action') + self.TRANSFORM_ACTIONS[action])
        interpolation = _enum_value(Gimp.InterpolationType, p.raw('interpolation', 'cubic'), 'interpolation')
        layer: Optional[Gimp.Layer] = None
        if action == 'scale_image':
            width, height = self._scaled_size(p, image.get_width(), image.get_height())
            with _context():
                Gimp.context_set_interpolation(interpolation)
                _ensure(image.scale(width, height), 'scaling the image')
        elif action == 'resize_canvas':
            width = p.integer('width', lo=1, hi=MAX_DIMENSION)
            height = p.integer('height', lo=1, hi=MAX_DIMENSION)
            _ensure(image.resize(width, height, p.integer('x', 0), p.integer('y', 0)), 'resizing the canvas')
            for item in _all_layers(image):
                if not item.is_text_layer() and not item.is_group():
                    _ensure(item.resize_to_image_size(), f'resizing layer {item.get_name()!r} to the canvas')
        elif action == 'crop':
            width = p.integer('width', lo=1)
            height = p.integer('height', lo=1)
            x = p.integer('x', 0, lo=0)
            y = p.integer('y', 0, lo=0)
            if x + width > image.get_width() or y + height > image.get_height():
                raise ValueError(f'the crop rectangle {width}x{height}+{x}+{y} extends past the {image.get_width()}x{image.get_height()} image')
            _ensure(image.crop(width, height, x, y), 'cropping')
        elif action == 'rotate':
            angle = p.number('angle')
            if p.has('layer'):
                layer = _find_layer(image, p.raw('layer'))
                with _selection_suspended(image), _context():
                    Gimp.context_set_interpolation(interpolation)
                    Gimp.context_set_transform_resize(Gimp.TransformResize.ADJUST)
                    _ensure(layer.transform_rotate(math.radians(angle), True, 0.0, 0.0), 'rotating the layer')
            else:
                turns = {90: Gimp.RotationType.DEGREES90, 180: Gimp.RotationType.DEGREES180, 270: Gimp.RotationType.DEGREES270}
                rotation = turns.get(round(angle) % 360) if float(angle).is_integer() else None
                if rotation is None:
                    raise ValueError('rotating the whole image takes angle 90, 180, or 270 (clockwise); pass layer to rotate one layer by any angle')
                _ensure(image.rotate(rotation), 'rotating the image')
        elif action == 'flip':
            axis = p.string('axis', choices=('horizontal', 'vertical'))
            orientation = Gimp.OrientationType.HORIZONTAL if axis == 'horizontal' else Gimp.OrientationType.VERTICAL
            if p.has('layer'):
                layer = _find_layer(image, p.raw('layer'))
                with _selection_suspended(image):
                    _ensure(layer.transform_flip_simple(orientation, True, 0.0), 'flipping the layer')
            else:
                _ensure(image.flip(orientation), 'flipping the image')
        else:
            layer = _find_layer(image, p.raw('layer', None))
            width, height = self._scaled_size(p, layer.get_width(), layer.get_height())
            _, x, y = layer.get_offsets()
            with _context():
                Gimp.context_set_interpolation(interpolation)
                _ensure(layer.scale(width, height, False), 'scaling the layer')
            _ensure(layer.set_offsets(p.integer('x', x), p.integer('y', y)), 'positioning the layer')
        return {'image': _image_size(image), 'layer': _layer_info(layer) if layer is not None else None}

    @staticmethod
    def _scaled_size(p: Params, width: int, height: int) -> Tuple[int, int]:
        """Return the target size; a missing width or height keeps the aspect ratio."""
        if not p.has('width') and not p.has('height'):
            raise ValueError('pass width, height, or both')
        new_width = p.integer('width', None, lo=1, hi=MAX_DIMENSION)
        new_height = p.integer('height', None, lo=1, hi=MAX_DIMENSION)
        if new_width is None:
            new_width = max(1, round(width * new_height / height))
        if new_height is None:
            new_height = max(1, round(height * new_width / width))
        return new_width, new_height

    # Drawing ---------------------------------------------------------------

    DRAW_ACTIONS = {
        'fill': ('layer', 'color'),
        'gradient': ('layer', 'color', 'color2', 'x', 'y', 'x2', 'y2'),
        'text': ('layer', 'text', 'font', 'size', 'color', 'x', 'y'),
        'clear': ('layer',),
    }

    def draw(self, p: Params) -> Dict[str, Any]:
        """Fill, paint a linear gradient, clear (within the selection), or add a text layer."""
        image = self._image(p)
        action = p.string('action', choices=tuple(self.DRAW_ACTIONS))
        p.only(f"draw action '{action}'", ('image', 'action') + self.DRAW_ACTIONS[action])
        if action == 'text':
            layer = self._text(image, p)
        else:
            layer = _find_layer(image, p.raw('layer', None))
            if action == 'fill':
                _fill(layer, _parse_color(p.raw('color'), 'color'))
            elif action == 'gradient':
                self._gradient(image, layer, p)
            else:
                if not layer.has_alpha():
                    _ensure(layer.add_alpha(), 'adding transparency to the layer')
                _ensure(layer.edit_clear(), 'clearing')
        return {'image': _image_size(image), 'layer': _layer_info(layer), 'selection': _selection_bounds(image)}

    @staticmethod
    def _gradient(image: Gimp.Image, layer: Gimp.Layer, p: Params) -> None:
        """Paint a linear gradient from (x, y) in ``color`` to (x2, y2) in ``color2``."""
        start = _parse_color(p.raw('color'), 'color')
        end = _parse_color(p.raw('color2'), 'color2')
        _, offset_x, offset_y = layer.get_offsets()
        x = p.number('x', float(offset_x))
        y = p.number('y', float(offset_y))
        x2 = p.number('x2', float(offset_x + layer.get_width()))
        y2 = p.number('y2', y)
        if (x, y) == (x2, y2):
            raise ValueError('the gradient start (x, y) and end (x2, y2) must differ')
        with _context():
            # The built-in FG-to-BG gradients drop the colors' alpha, so paint
            # with a temporary one-segment gradient that keeps it.
            gradient = _ensure(Gimp.Gradient.new('wasd gradient'), 'creating the gradient')
            try:
                _ensure(gradient.segment_set_left_color(0, start), 'setting the gradient start color')
                _ensure(gradient.segment_set_right_color(0, end), 'setting the gradient end color')
                _ensure(Gimp.context_set_gradient(gradient), 'selecting the gradient')
                Gimp.context_set_opacity(100.0)
                Gimp.context_set_paint_mode(Gimp.LayerMode.NORMAL)
                # edit_gradient_fill takes drawable-local coordinates.
                _ensure(
                    layer.edit_gradient_fill(Gimp.GradientType.LINEAR, 0.0, False, 1, 0.0, False, x - offset_x, y - offset_y, x2 - offset_x, y2 - offset_y),
                    'painting the gradient',
                )
            finally:
                gradient.delete()

    @staticmethod
    def _text(image: Gimp.Image, p: Params) -> Gimp.Layer:
        """Create a text layer at (x, y), above ``layer`` when given, else at the top."""
        text = p.string('text')
        font_name = p.string('font', 'Sans-serif', limit=200)
        font = Gimp.Font.get_by_name(font_name)
        if font is None:
            words = font_name.split()
            similar = [font.get_name() for font in Gimp.fonts_get_list('(?i)' + re.escape(words[0] if words else font_name))][:10]
            hint = f'; similar fonts: {", ".join(similar)}' if similar else '; "Sans-serif", "Serif", and "Monospace" always exist'
            raise NotFoundError(f'no font is named {font_name!r}{hint}')
        size = p.number('size', 32.0, lo=1, hi=2000)
        parent, position = None, 0
        if p.has('layer'):
            anchor = _find_layer(image, p.raw('layer'), required=True)
            parent, position = anchor.get_parent(), image.get_item_position(anchor)
        layer = _ensure(Gimp.TextLayer.new(image, text, font, size, Gimp.Unit.pixel()), 'creating the text layer')
        _ensure(image.insert_layer(layer, parent, position), 'inserting the text layer')
        _ensure(layer.set_offsets(round(p.number('x', 0.0)), round(p.number('y', 0.0))), 'positioning the text layer')
        if p.has('color'):
            _ensure(layer.set_color(_parse_color(p.raw('color'), 'color')), 'coloring the text')
        image.set_selected_layers([layer])
        return layer

    # Filters ---------------------------------------------------------------

    def _filter_details(self, operation: str) -> Dict[str, Any]:
        """Return the cached title, description, and categories of a filter operation."""
        cached = self._details.get(operation)
        if cached is None:
            ok, names, values = Gimp.DrawableFilter.operation_get_details(operation)
            details = {name: values.index(index) for index, name in enumerate(names)} if ok else {}
            cached = {
                'title': details.get('title') or '',
                'description': details.get('description') or '',
                'categories': details.get('categories') or '',
            }
            self._details[operation] = cached
        return cached

    @staticmethod
    def _require_operation(operation: Any) -> str:
        """Validate that a filter operation is available."""
        if not isinstance(operation, str) or not operation:
            raise ValueError('operation must be a filter operation name such as "gegl:gaussian-blur"')
        available = Gimp.DrawableFilter.operation_get_available()
        if operation not in available:
            needle = operation.split(':')[-1].split('-')[0].lower()
            similar = _similar_names(operation, available, lambda name: bool(needle) and needle in name.lower())
            hint = f'; similar: {", ".join(similar)}' if similar else '; call filters to list operations'
            raise NotFoundError(f'no filter operation is named {operation!r}{hint}')
        return operation

    def filters(self, p: Params) -> Dict[str, Any]:
        """List filter operations whose name, title, or category contains ``query``."""
        query = p.string('query', '', limit=200, allow_empty=True).lower()
        entries = []
        for name in sorted(Gimp.DrawableFilter.operation_get_available()):
            details = self._filter_details(name)
            haystack = ' '.join((name, details['title'], details['categories'])).lower()
            if query in haystack:
                entries.append({'name': name, 'title': details['title'], 'categories': details['categories']})
        result: Dict[str, Any] = {'filters': entries[:MAX_ITEMS_LISTED], 'count': len(entries)}
        if len(entries) > MAX_ITEMS_LISTED:
            result['omitted'] = len(entries) - MAX_ITEMS_LISTED
        return result

    def filter_info(self, p: Params) -> Dict[str, Any]:
        """Describe a filter operation and its properties."""
        operation = self._require_operation(p.raw('operation'))
        specs = Gimp.DrawableFilter.operation_get_pspecs(operation)
        return {
            'name': operation,
            **self._filter_details(operation),
            'properties': [_describe_spec(specs.index(index)) for index in range(specs.length())],
        }

    def apply_filter(self, p: Params) -> Dict[str, Any]:
        """Apply a filter operation destructively to a layer (within the selection, if any)."""
        image = self._image(p)
        layer = _pixel_layer(image, p.raw('layer', None))
        operation = self._require_operation(p.raw('operation'))
        properties = p.object('properties', {})
        applied = _apply_operation(layer, operation, properties)
        return {'image': _image_size(image), 'layer': _layer_info(layer), 'operation': operation, 'properties': applied, 'selection': _selection_bounds(image)}

    # Procedural database ---------------------------------------------------

    def pdb_search(self, p: Params) -> Dict[str, Any]:
        """Find PDB procedures whose name or summary contains ``query`` (case-insensitive)."""
        query = p.string('query', limit=200).strip()
        pdb = Gimp.get_pdb()
        # Procedure names separate words with hyphens.
        name_query = re.sub(r'[\s_]+', '-', query).lower()
        names = set(pdb.query_procedures('(?i).*' + re.escape(name_query) + '.*', '', '', '', '', '', '', ''))
        names.update(pdb.query_procedures('', '(?i).*' + re.escape(query) + '.*', '', '', '', '', '', ''))
        words = re.compile(r'(^|-)' + re.escape(name_query) + r'($|-)')

        def rank(name: str) -> Tuple[int, int, str]:
            """Exact names first, then names with the query as whole words, then names containing it, then summary matches."""
            lowered = name.lower()
            tier = 0 if lowered == name_query else 1 if words.search(lowered) else 2 if name_query in lowered else 3
            return tier, len(name), name

        ordered = sorted(names, key=rank)
        entries = []
        for name in ordered[:MAX_ITEMS_LISTED]:
            procedure = pdb.lookup_procedure(name)
            entries.append({'name': name, 'summary': (procedure.get_blurb() or '') if procedure is not None else ''})
        result: Dict[str, Any] = {'procedures': entries, 'count': len(ordered)}
        if len(ordered) > MAX_ITEMS_LISTED:
            result['omitted'] = len(ordered) - MAX_ITEMS_LISTED
        return result

    @staticmethod
    def _procedure(name: Any) -> Gimp.Procedure:
        """Return the PDB procedure named ``name``."""
        if not isinstance(name, str) or not name:
            raise ValueError('procedure must be a PDB procedure name such as "gimp-image-scale"')
        pdb = Gimp.get_pdb()
        procedure = pdb.lookup_procedure(name)
        if procedure is None:
            similar = _similar_names(name, pdb.query_procedures('', '', '', '', '', '', '', ''), lambda _name: False)
            hint = f'; similar: {", ".join(similar)}' if similar else ''
            raise NotFoundError(f'no PDB procedure is named {name!r}{hint}; call pdb_search to find one')
        return procedure

    def pdb_describe(self, p: Params) -> Dict[str, Any]:
        """Describe a PDB procedure's arguments and return values."""
        procedure = self._procedure(p.raw('procedure'))
        return {
            'name': procedure.get_name(),
            'summary': procedure.get_blurb() or '',
            'help': _clip(procedure.get_help() or '', MAX_HELP_CHARS),
            'kind': procedure.get_proc_type().value_nick,
            'image_types': procedure.get_image_types() or '',
            'menu_label': procedure.get_menu_label() or '',
            'authors': procedure.get_authors() or '',
            'date': procedure.get_date() or '',
            'arguments': [_describe_spec(spec) for spec in procedure.get_arguments()],
            'return_values': [_describe_spec(spec) for spec in procedure.get_return_values()],
        }

    def pdb_run(self, p: Params) -> Dict[str, Any]:
        """Run a PDB procedure non-interactively with JSON arguments keyed by argument name."""
        procedure = self._procedure(p.raw('procedure'))
        arguments = p.object('arguments', {})
        name = procedure.get_name()
        specs = {spec.name: spec for spec in procedure.get_arguments()}
        config = procedure.create_config()
        if 'run-mode' in specs:
            config.set_property('run-mode', NONINTERACTIVE)
        for key, value in arguments.items():
            spec = specs.get(key) or specs.get(key.replace('_', '-'))
            if spec is None:
                raise ValueError(f'{name} has no argument {key!r}; arguments: {", ".join(specs) or "none"}')
            if spec.name == 'run-mode':
                continue
            _set_config_value(config, spec, value, f'{name} argument {spec.name}')
        result = procedure.run(config)
        _raise_for_status(name, result)
        values = {}
        for index, spec in enumerate(procedure.get_return_values(), start=1):
            if index < result.length():
                values[spec.name] = _return_value(result, index, spec)
        return {'procedure': name, 'status': 'success', 'values': _bounded_json(values, 'values')}

    # Python ----------------------------------------------------------------

    def execute_python(self, p: Params) -> Dict[str, Any]:
        """Run Python in a namespace that persists across calls; capture output and ``result``.

        The reply carries ``error`` (type, message, traceback) when the code
        raised; the worker keeps running either way. Standard input reads as
        empty during the call, since the worker's own stdin carries requests.
        """
        code = p.string('code', limit=MAX_CODE_CHARS)
        namespace = self._namespace
        namespace['images'] = {image.get_id(): image for image in self._open_images()}
        namespace.pop('result', None)
        output = BoundedOutput(OUTPUT_LIMIT)
        error: Optional[Dict[str, str]] = None
        started = time.perf_counter()
        stdin, sys.stdin = sys.stdin, io.StringIO()
        try:
            compiled = compile(code, '<execute_python>', 'exec')
            with contextlib.redirect_stdout(output), contextlib.redirect_stderr(output):
                exec(compiled, namespace)  # noqa: S102 - running agent code is this method's purpose
        except SystemExit as exit_error:
            error = {'type': 'SystemExit', 'message': f'the code called exit({_safe_repr(exit_error.code, 200)}); the worker keeps running', 'traceback': ''}
        except BaseException as failure:  # noqa: BLE001 - user code failures are reported, not raised
            error = {'type': type(failure).__name__, 'message': _clip(str(failure)), 'traceback': _clip(_user_traceback(failure), 8000)}
        finally:
            sys.stdin = stdin
        reply: Dict[str, Any] = {
            'result': _bounded_json(namespace.get('result'), 'result'),
            'output': output.text(),
            'seconds': round(time.perf_counter() - started, 3),
        }
        if error is not None:
            reply['error'] = error
        return reply

    # Game helpers ----------------------------------------------------------

    def make_sprite_sheet(self, p: Params) -> Dict[str, Any]:
        """Pack image files into a grid sheet, export it, and keep it open as a new image."""
        paths = [_existing_file(path, f'paths[{index}]') for index, path in enumerate(p.array('paths', lo=1, hi=MAX_SHEET_FRAMES))]
        columns = p.integer('columns', lo=1, hi=MAX_SHEET_FRAMES)
        output = _absolute_path(p.raw('output'), 'output')
        _export_spec(output, 'output')
        padding = p.integer('padding', 0, lo=0, hi=1024)
        sheet = _ensure(Gimp.Image.new(1, 1, Gimp.ImageBaseType.RGB), 'creating the sheet')
        try:
            frames = []
            for path in paths:
                frame = Gimp.file_load_layer(NONINTERACTIVE, sheet, Gio.File.new_for_path(path))
                if frame is None:
                    raise GimpError(f'loading {path} failed: {_last_error()}')
                frames.append((path, frame))
            frame_width = max(frame.get_width() for _, frame in frames)
            frame_height = max(frame.get_height() for _, frame in frames)
            cell_width, cell_height = frame_width + 2 * padding, frame_height + 2 * padding
            rows = math.ceil(len(frames) / columns)
            width, height = columns * cell_width, rows * cell_height
            if width > MAX_DIMENSION or height > MAX_DIMENSION:
                raise ValueError(f'the sheet would be {width}x{height}; the limit is {MAX_DIMENSION} per side; use more or fewer columns or split the frames')
            _ensure(sheet.resize(width, height, 0, 0), 'sizing the sheet')
            placed = []
            for index, (path, frame) in enumerate(frames):
                column, row = index % columns, index // columns
                x = column * cell_width + padding + (frame_width - frame.get_width()) // 2
                y = row * cell_height + padding + (frame_height - frame.get_height()) // 2
                frame.set_name(f'frame {index}: {os.path.basename(path)}')
                _ensure(sheet.insert_layer(frame, None, 0), 'inserting a frame')
                if not frame.has_alpha():
                    _ensure(frame.add_alpha(), 'adding transparency to a frame')
                _ensure(frame.set_offsets(x, y), 'placing a frame')
                placed.append({'index': index, 'file': os.path.basename(path), 'x': x, 'y': y, 'width': frame.get_width(), 'height': frame.get_height()})
            exported = _export(sheet, output, None)
            sheet.clean_all()
        except BaseException:
            sheet.delete()
            raise
        self._labels[sheet.get_id()] = os.path.basename(output)
        return {
            'image': sheet.get_id(),
            'output': exported['path'],
            'bytes': exported['bytes'],
            'width': width,
            'height': height,
            'columns': columns,
            'rows': rows,
            'frame_width': frame_width,
            'frame_height': frame_height,
            'cell_width': cell_width,
            'cell_height': cell_height,
            'padding': padding,
            'frames': placed,
        }

    def make_seamless(self, p: Params) -> Dict[str, Any]:
        """Make a layer tile seamlessly over its whole area, regardless of the selection."""
        image = self._image(p)
        layer = _pixel_layer(image, p.raw('layer', None))
        with _selection_suspended(image):
            _make_tileable(layer)
        return {'image': _image_size(image), 'layer': _layer_info(layer)}


def _similar_names(name: str, names: List[str], related: Callable[[str], bool]) -> List[str]:
    """Return up to ten of ``names`` close to the misspelled ``name`` or ``related`` to it, closest first."""
    close = difflib.get_close_matches(name, names, n=5, cutoff=0.75)
    return (close + sorted(other for other in names if related(other) and other not in close))[:10]


def _user_traceback(failure: BaseException) -> str:
    """Format a user-code exception without the worker's own frames."""
    if isinstance(failure, SyntaxError):
        # The code never ran: the error names the line, and every frame is the worker's.
        return ''.join(traceback.format_exception_only(type(failure), failure))
    frames = traceback.extract_tb(failure.__traceback__)
    user = [frame for frame in frames if frame.filename == '<execute_python>'] or frames[-1:]
    lines = ['Traceback (most recent call last):\n'] + traceback.format_list(user) + traceback.format_exception_only(type(failure), failure)
    return ''.join(lines)


def _spec_kind(spec: GObject.ParamSpec) -> str:
    """Classify a GParamSpec by the JSON value it accepts."""
    if isinstance(spec, Gimp.ParamChoice):
        return 'choice'
    if isinstance(spec, GObject.ParamSpecBoolean):
        return 'boolean'
    if isinstance(spec, INT_SPECS):
        return 'integer'
    if isinstance(spec, FLOAT_SPECS):
        return 'number'
    if isinstance(spec, GObject.ParamSpecEnum):
        return 'enum' if _gtype_class(spec.value_type) is not None else 'unsupported'
    if isinstance(spec, GObject.ParamSpecFlags):
        return 'flags'
    if isinstance(spec, GObject.ParamSpecString):
        return 'string'
    gtype = spec.value_type
    type_name = GObject.type_name(gtype)
    if type_name == 'GimpImage':
        return 'image'
    if GObject.type_is_a(gtype, Gimp.Item.__gtype__):
        return 'item'
    if type_name == 'GimpCoreObjectArray':
        return 'object-array'
    if type_name == 'GFile':
        return 'file'
    if type_name == 'GeglColor':
        return 'color'
    if GObject.type_is_a(gtype, Gimp.Resource.__gtype__) and type_name != 'GimpResource' and _gtype_class(gtype) is not None:
        return 'resource'
    if type_name == 'GimpUnit':
        return 'unit'
    if type_name == 'GStrv':
        return 'strings'
    if type_name == 'GimpDoubleArray':
        return 'numbers'
    if type_name == 'GimpInt32Array':
        return 'integers'
    return 'unsupported'


def _item_label(gtype: GObject.GType) -> str:
    """Return a readable item type such as ``layer`` or ``text layer`` for a GimpItem GType."""
    name = GObject.type_name(gtype)
    words = re.sub(r'(?<!^)(?=[A-Z])', ' ', name[4:] if name.startswith('Gimp') else name).lower()
    return words


def _describe_spec(spec: GObject.ParamSpec) -> Dict[str, Any]:
    """Describe an argument, return value, or filter property: name, JSON type, default, range, and choices."""
    kind = _spec_kind(spec)
    type_name = GObject.type_name(spec.value_type)
    entry: Dict[str, Any] = {'name': spec.name, 'type': kind, 'description': spec.get_blurb() or ''}
    if kind in ('integer', 'number'):
        entry['minimum'] = spec.minimum
        entry['maximum'] = spec.maximum
        entry['default'] = _jsonable(spec.get_default_value())
    elif kind in ('boolean', 'string', 'flags'):
        entry['default'] = _jsonable(spec.get_default_value())
    elif kind == 'choice':
        entry['choices'] = list(Gimp.param_spec_choice_get_choice(spec).list_nicks())
        entry['default'] = spec.get_default_value()
    elif kind == 'enum':
        members = _enum_members(_gtype_class(spec.value_type))
        entry['values'] = list(members)
        entry['default'] = next((nick for nick, member in members.items() if int(member) == spec.default_value), None)
    elif kind == 'item':
        entry['type'] = f'{_item_label(spec.value_type)} id'
    elif kind == 'image':
        entry['type'] = 'image id'
    elif kind == 'object-array':
        element = Gimp.param_spec_core_object_array_get_object_type(spec)
        entry['type'] = 'array of image ids' if GObject.type_name(element) == 'GimpImage' else f'array of {_item_label(element)} ids'
    elif kind == 'file':
        entry['type'] = 'absolute path'
    elif kind == 'color':
        entry['type'] = 'color'
        default = spec.get_default_value()
        entry['default'] = _color_hex(default) if isinstance(default, Gegl.Color) else None
    elif kind == 'resource':
        entry['type'] = f'{_item_label(spec.value_type)} name'
    elif kind == 'unit':
        entry['type'] = 'unit'
        entry['choices'] = list(_units(spec))
        default = spec.get_default_value()
        entry['default'] = default.get_name() if isinstance(default, Gimp.Unit) else None
    elif kind == 'strings':
        entry['type'] = 'array of strings'
    elif kind == 'numbers':
        entry['type'] = 'array of numbers'
    elif kind == 'integers':
        entry['type'] = 'array of integers'
    else:
        entry['type'] = f'unsupported ({type_name})'
    entry['gtype'] = type_name
    return entry


def _coerce(spec: GObject.ParamSpec, value: Any, label: str) -> Any:
    """Convert a JSON value to the Python value a GParamSpec accepts, validating ranges and choices."""
    kind = _spec_kind(spec)
    if kind == 'choice':
        nicks = list(Gimp.param_spec_choice_get_choice(spec).list_nicks())
        if value not in nicks:
            raise ValueError(f'{label} must be one of {", ".join(nicks)}; got {value!r}')
        return value
    if kind == 'boolean':
        if not isinstance(value, bool):
            raise ValueError(f'{label} must be true or false; got {value!r}')
        return value
    if kind in ('integer', 'flags'):
        if isinstance(value, float) and value.is_integer():
            value = int(value)
        if not isinstance(value, int) or isinstance(value, bool):
            raise ValueError(f'{label} must be an integer; got {value!r}')
        if kind == 'integer':
            _check_range(label, value, spec.minimum, spec.maximum)
        return value
    if kind == 'number':
        if not isinstance(value, (int, float)) or isinstance(value, bool) or not math.isfinite(value):
            raise ValueError(f'{label} must be a number; got {value!r}')
        _check_range(label, value, spec.minimum, spec.maximum)
        return float(value)
    if kind == 'enum':
        return _enum_value(_gtype_class(spec.value_type), value, label)
    if kind == 'string':
        if not isinstance(value, str):
            raise ValueError(f'{label} must be a string; got {value!r}')
        return value
    if kind == 'image':
        return _image_by_id(value, label)
    if kind == 'item':
        return _item_by_id(value, spec.value_type, label)
    if kind == 'file':
        return Gio.File.new_for_path(_absolute_path(value, label))
    if kind == 'color':
        return _parse_color(value, label)
    if kind == 'resource':
        if not isinstance(value, str) or not value:
            raise ValueError(f'{label} must be a {_item_label(spec.value_type)} name')
        resource = _gtype_class(spec.value_type).get_by_name(value)
        if resource is None:
            raise NotFoundError(f'{label}: no {_item_label(spec.value_type)} is named {value!r}')
        return resource
    if kind == 'unit':
        units = _units(spec)
        if isinstance(value, str):
            nick = _nick(value)
            wanted = _nick(UNIT_ALIASES.get(nick, nick))
            for name, unit in units.items():
                if _nick(name) == wanted:
                    return unit
        raise ValueError(f'{label} must be one of {", ".join(units)}; got {value!r}')
    if kind == 'strings':
        if not isinstance(value, list) or not all(isinstance(item, str) for item in value):
            raise ValueError(f'{label} must be an array of strings')
        return value
    raise ValueError(f'{label} has type {GObject.type_name(spec.value_type)}, which cannot be set from JSON; use execute_python')


def _units(spec: GObject.ParamSpec) -> Dict[str, Gimp.Unit]:
    """Return the units a unit argument accepts by GIMP's name for them: the built-in and user-defined ones, in id order.

    Pixels and percent are included only where the argument allows them.
    """
    units: List[Gimp.Unit] = []
    # Unit ids run from 0 without gaps; percent has its own id.
    unit = Gimp.Unit.get_by_id(0)
    while unit is not None:
        units.append(unit)
        unit = Gimp.Unit.get_by_id(len(units))
    units.append(Gimp.Unit.percent())
    excluded = set()
    if not Gimp.param_spec_unit_pixel_allowed(spec):
        excluded.add(Gimp.Unit.pixel().get_id())
    if not Gimp.param_spec_unit_percent_allowed(spec):
        excluded.add(Gimp.Unit.percent().get_id())
    return {unit.get_name(): unit for unit in units if unit.get_id() not in excluded}


def _set_config_value(config: GObject.Object, spec: GObject.ParamSpec, value: Any, label: str) -> None:
    """Set one procedure-config argument from JSON, including array arguments."""
    kind = _spec_kind(spec)
    if kind == 'object-array':
        if not isinstance(value, list):
            raise ValueError(f'{label} must be an array of ids')
        element = Gimp.param_spec_core_object_array_get_object_type(spec)
        if GObject.type_name(element) == 'GimpImage':
            objects = [_image_by_id(item, f'{label}[{index}]') for index, item in enumerate(value)]
        else:
            objects = [_item_by_id(item, element, f'{label}[{index}]') for index, item in enumerate(value)]
        config.set_core_object_array(spec.name, objects)
        return
    if kind in ('numbers', 'integers'):
        if not isinstance(value, list) or not all(isinstance(item, (int, float)) and not isinstance(item, bool) for item in value):
            raise ValueError(f'{label} must be an array of {"numbers" if kind == "numbers" else "integers"}')
        if kind == 'integers' and not all(float(item).is_integer() for item in value):
            raise ValueError(f'{label} must be an array of integers')
        boxed = GObject.Value(Gimp.DoubleArray if kind == 'numbers' else Gimp.Int32Array)
        if kind == 'numbers':
            Gimp.value_set_double_array(boxed, [float(item) for item in value])
        else:
            Gimp.value_set_int32_array(boxed, [int(item) for item in value])
        _set_property(config, spec.name, boxed.get_value(), label)
        return
    _set_property(config, spec.name, _coerce(spec, value, label), label)


# Return value types GIMP's Python bindings cannot read, with what pdb_run reports instead.
UNREADABLE_RETURNS = {
    'GimpInt32Array': '<array of integers; GIMP\'s Python bindings cannot read it>',
    'GimpDoubleArray': '<array of numbers; GIMP\'s Python bindings cannot read it>',
}


def _return_value(result: Gimp.ValueArray, index: int, spec: GObject.ParamSpec) -> Any:
    """Read return value ``index`` of a procedure result as JSON-compatible data.

    The procedure already ran, so a value that cannot be converted is reported
    as text instead of failing the call.
    """
    type_name = GObject.type_name(spec.value_type)
    if type_name in UNREADABLE_RETURNS:
        return UNREADABLE_RETURNS[type_name]
    try:
        if type_name == 'GimpCoreObjectArray':
            return _jsonable(result.get_core_object_array(index))
        if type_name == 'GimpColorArray':
            return _jsonable(result.get_color_array(index))
        return _jsonable(result.index(index))
    except Exception as error:  # noqa: BLE001 - PyGObject raises various errors for boxed types it cannot convert
        return f'<{type_name} value that cannot be converted: {error}>'


def _image_by_id(value: Any, label: str) -> Gimp.Image:
    """Return the open image with id ``value``."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f'{label} must be an image id; got {value!r}')
    image = Gimp.Image.get_by_id(value)
    if image is None or not image.is_valid():
        raise NotFoundError(f'{label}: no open image has id {value}')
    return image


def _item_by_id(value: Any, gtype: GObject.GType, label: str) -> Gimp.Item:
    """Return the item with id ``value`` when it is an instance of ``gtype``."""
    if not isinstance(value, int) or isinstance(value, bool):
        raise ValueError(f'{label} must be a {_item_label(gtype)} id; got {value!r}')
    item = Gimp.Item.get_by_id(value)
    if item is None or not item.is_valid():
        raise NotFoundError(f'{label}: no item has id {value}')
    if not GObject.type_is_a(type(item).__gtype__, gtype):
        raise ValueError(f'{label}: item {value} is a {_item_label(type(item).__gtype__)}, not a {_item_label(gtype)}')
    return item


def _apply_operation(drawable: Gimp.Drawable, operation: str, properties: Dict[str, Any]) -> Dict[str, Any]:
    """Apply a GEGL or GIMP filter operation to ``drawable`` and merge it; returns the properties set."""
    try:
        drawable_filter = Gimp.DrawableFilter.new(drawable, operation, None)
    except TypeError:
        raise GimpError(f'creating the {operation} filter failed: {_last_error()}') from None
    config = drawable_filter.get_config()
    applied: Dict[str, Any] = {}
    try:
        for key, value in properties.items():
            spec = config.find_property(key) or config.find_property(key.replace('_', '-'))
            if spec is None:
                names = ', '.join(entry.name for entry in config.list_properties()) or 'none'
                raise ValueError(f'{operation} has no property {key!r}; properties: {names}')
            label = f'{operation} property {spec.name}'
            _set_property(config, spec.name, _coerce(spec, value, label), label)
            applied[spec.name] = value
    except BaseException:
        drawable_filter.delete()
        raise
    drawable_filter.update()
    drawable.merge_filter(drawable_filter)
    _check_last_status(f'applying {operation}')
    return applied


def _graph_child(graph: Gegl.Node, operation: str, **properties: Any) -> Gegl.Node:
    """Add a node that runs ``operation`` with ``properties`` to ``graph``."""
    node = graph.create_child(operation)
    for name, value in properties.items():
        node.set_property(name, value)
    return node


def _repeat(graph: Gegl.Node, source: Gegl.Node, width: int, height: int, dx: int = 0, dy: int = 0) -> Gegl.Node:
    """Return the ``width`` x ``height`` image ``source`` (at the origin) moved by ``dx``, ``dy`` with wrap-around."""
    tile = _graph_child(graph, 'gegl:tile')
    move = _graph_child(graph, 'gegl:translate', x=float(dx), y=float(dy))
    crop = _graph_child(graph, 'gegl:crop', x=0.0, y=0.0, width=float(width), height=float(height))
    source.link(tile)
    tile.link(move)
    move.link(crop)
    return crop


def _weight_mask(graph: Gegl.Node, weights: List[float], across: bool, width: int, height: int) -> Gegl.Node:
    """Return a ``width`` x ``height`` mask whose column (``across``) or row ``index`` has the value ``weights[index]``."""
    columns, rows = (len(weights), 1) if across else (1, len(weights))
    buffer = Gegl.Buffer.new(MASK_FORMAT, 0, 0, columns, rows)
    buffer.set(Gegl.Rectangle.new(0, 0, columns, rows), MASK_FORMAT, struct.pack(f'={len(weights)}f', *weights))
    return _repeat(graph, _graph_child(graph, 'gegl:buffer-source', buffer=buffer), width, height)


def _faded(graph: Gegl.Node, source: Gegl.Node, mask: Gegl.Node) -> Gegl.Node:
    """Return ``source`` with its premultiplied pixels scaled by ``mask``."""
    node = _graph_child(graph, 'gegl:opacity')
    source.connect_to('output', node, 'input')
    mask.connect_to('output', node, 'aux')
    return node


def _cross_fade(graph: Gegl.Node, source: Gegl.Node, width: int, height: int, across: bool) -> Gegl.Node:
    """Return ``source`` cross-faded with itself moved by half its width (``across``) or height, so that axis tiles.

    The moved copy, whose edge pixels come from the continuous middle of
    ``source``, shows at the edges, and ``source`` shows in the middle, where the
    copy has its seam. The raised-cosine weights reach 1 and 0 there smoothly.
    """
    size = width if across else height
    shift = -(size // 2)
    moved = _repeat(graph, source, width, height, shift if across else 0, 0 if across else shift)
    weights = [(1 + math.cos(2 * math.pi * (index + 0.5) / size)) / 2 for index in range(size)]
    copy = _faded(graph, moved, _weight_mask(graph, weights, across, width, height))
    original = _faded(graph, source, _weight_mask(graph, [1 - weight for weight in weights], across, width, height))
    total = _graph_child(graph, 'svg:plus')
    copy.connect_to('output', total, 'input')
    original.connect_to('output', total, 'aux')
    return total


def _render_tileable(layer: Gimp.Layer, width: int, height: int) -> None:
    """Write the tileable version of ``layer``, which is ``width`` x ``height``, to its shadow buffer.

    A pass across and then a pass down cross-fade the layer with itself moved
    by half its size; the pass down mixes whole rows, which already tile across.
    Pixels mix with premultiplied alpha, so transparency blends like color.
    """
    graph = Gegl.Node()
    source = _graph_child(graph, 'gegl:buffer-source', buffer=layer.get_buffer())
    tiled = _cross_fade(graph, _cross_fade(graph, source, width, height, True), width, height, False)
    shadow = layer.get_shadow_buffer()
    sink = _graph_child(graph, 'gegl:write-buffer', buffer=shadow)
    tiled.link(sink)
    sink.process()
    shadow.flush()


def _make_tileable(layer: Gimp.Layer) -> None:
    """Replace the pixels of ``layer`` so that its opposite edges continue each other when it repeats.

    The selection limits the change, so callers suspend it.
    """
    width, height = layer.get_width(), layer.get_height()
    try:
        _render_tileable(layer, width, height)
        _ensure(layer.merge_shadow(True), 'writing the seamless pixels')
    finally:
        # GIMP otherwise keeps the shadow allocated until the worker's batch command ends.
        layer.free_shadow()
    _ensure(layer.update(0, 0, width, height), 'updating the layer')


METHODS: Dict[str, Tuple[Callable[[Worker, Params], Any], frozenset]] = {
    'ping': (Worker.ping, frozenset()),
    'list_images': (Worker.list_images, frozenset()),
    'open_image': (Worker.open_image, frozenset({'path'})),
    'new_image': (Worker.new_image, frozenset({'width', 'height', 'fill', 'name'})),
    'image_info': (Worker.image_info, frozenset({'image'})),
    'snapshot': (Worker.snapshot, frozenset({'image', 'max_size', 'stem', 'max_bytes'})),
    'export_image': (Worker.export_image, frozenset({'image', 'path', 'quality'})),
    'save_xcf': (Worker.save_xcf, frozenset({'image', 'path'})),
    'close_image': (Worker.close_image, frozenset({'image'})),
    'layer': (Worker.layer, frozenset({'image', 'action', 'layer', 'name', 'opacity', 'visible', 'mode', 'offset_x', 'offset_y', 'position'})),
    'select': (Worker.select, frozenset({'image', 'mode', 'x', 'y', 'width', 'height', 'color', 'threshold', 'amount', 'operation', 'layer'})),
    'transform': (Worker.transform, frozenset({'image', 'action', 'width', 'height', 'x', 'y', 'angle', 'axis', 'layer', 'interpolation'})),
    'draw': (Worker.draw, frozenset({'image', 'action', 'layer', 'color', 'color2', 'x', 'y', 'x2', 'y2', 'text', 'font', 'size'})),
    'filters': (Worker.filters, frozenset({'query'})),
    'filter_info': (Worker.filter_info, frozenset({'operation'})),
    'apply_filter': (Worker.apply_filter, frozenset({'image', 'layer', 'operation', 'properties'})),
    'pdb_search': (Worker.pdb_search, frozenset({'query'})),
    'pdb_describe': (Worker.pdb_describe, frozenset({'procedure'})),
    'pdb_run': (Worker.pdb_run, frozenset({'procedure', 'arguments'})),
    'execute_python': (Worker.execute_python, frozenset({'code'})),
    'make_sprite_sheet': (Worker.make_sprite_sheet, frozenset({'paths', 'columns', 'output', 'padding'})),
    'make_seamless': (Worker.make_seamless, frozenset({'image', 'layer'})),
}


# Run by /bin/sh with $1 = the GIMP process id and $2 = its process group id.
# It waits for the goodbye line on stdin; end of input without it means the
# worker process died, and then it kills GIMP: its group when GIMP leads one.
# SIGPIPE is ignored so that a log write to a closed stderr, after the server
# died, cannot end the shell before the kill.
WATCHDOG_SCRIPT = (
    "trap '' PIPE; "
    'IFS= read -r line; [ "$line" = bye ] && exit 0; '
    'echo "wasd_gimp_worker: the GIMP Python process ended without finishing; stopping GIMP" >&2; '
    'if [ "$1" = "$2" ]; then kill -KILL -- "-$1"; else kill -KILL "$1"; fi'
)


def _start_watchdog() -> Optional[io.TextIOBase]:
    """Start a watchdog process that stops GIMP when this worker process dies; return its goodbye pipe.

    GIMP 3.2 keeps running, busy, after its Python plug-in process crashes,
    and it holds the reply pipe open, so the server would see neither a reply
    nor an exit before its request timeout. Returns None where there is no
    POSIX shell, or when the watchdog cannot start (the worker runs without it).
    """
    if os.name != 'posix':
        return None
    gimp = os.getppid()
    read_end, write_end = os.pipe()
    try:
        subprocess.Popen(
            ['/bin/sh', '-c', WATCHDOG_SCRIPT, 'wasd-gimp-watchdog', str(gimp), str(os.getpgid(gimp))],
            stdin=read_end, stdout=subprocess.DEVNULL, close_fds=True,
        )
    except OSError as error:
        os.close(write_end)
        _log(f'running without a crash watchdog: {error}')
        return None
    finally:
        os.close(read_end)
    return os.fdopen(write_end, 'w', encoding='ascii')


def _exit_when_unread() -> None:
    """End this process without the goodbye once nothing reads the reply pipe, so the watchdog stops GIMP.

    A request can keep the main thread busy indefinitely after the server died.
    poll() reports POLLERR (Linux) or POLLHUP (macOS, only for a descriptor
    registered for POLLOUT) once the pipe has no reader.
    """
    poller = select.poll()
    poller.register(REPLY_FD, select.POLLOUT)
    while not any(events & (select.POLLHUP | select.POLLERR) for _, events in poller.poll(0)):
        time.sleep(SERVER_CHECK_SECONDS)
    os._exit(1)


def main() -> None:
    """Serve the protocol on stdin and fd 3 until stdin closes or ``shutdown``."""
    replies = os.fdopen(REPLY_FD, 'w', buffering=1, encoding='ascii', newline='\n')
    goodbye = _start_watchdog()
    if goodbye is not None:
        threading.Thread(target=_exit_when_unread, name='wasd-gimp-reply-check', daemon=True).start()
    try:
        # GIMP's Python plug-in process loads GEGL's operations only on Gegl.init;
        # building a graph (make_seamless, execute_python code) before it crashes the process.
        Gegl.init(None)
        Worker(replies).serve()
    except BrokenPipeError:
        # The server closed fd 3; nothing can receive replies, so the worker stops.
        return
    finally:
        if goodbye is not None:
            with contextlib.suppress(OSError):
                # OSError: the watchdog is already gone, so nothing waits for the goodbye.
                goodbye.write('bye\n')
                goodbye.close()


if __name__ == '__main__':
    main()
