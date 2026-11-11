#!/usr/bin/env python3
"""Smoke-test a WASD Engine Blender runtime the way the Blender plugin runs it.

The test starts the runtime's Python as the plugin starts its worker, isolated
(-I), in UTF-8 mode (-X utf8), which Blender also sets for its own Python, and
without writing bytecode (-B), in an environment without Python redirection,
and runs one script. The script imports bpy and numpy, builds a
scene with a mesh, a material, a camera, and a light, renders it with Cycles on
the CPU and, on macOS, with EEVEE, exports it as glTF, and saves it as a .blend
file, then waits until the test has looked at it. EEVEE renders on the GPU,
which the Windows runners of the release workflow lack. On macOS it renders
through Metal, which connects the process to the window server, so macOS
registers it with LaunchServices: the test asks lsappinfo for the process's
application entry and accepts none or a BackgroundOnly one, which has no Dock
icon, no menu bar, and no place in the application switcher. The test passes
when Python exits with status 0, reports the expected Blender version and a
numpy result, wrote every image at its size, a glTF binary, and a .blend file,
macOS lists no visible application for it, and the run left every file and
folder of the runtime as it found them. It needs only the standard library of
Python 3.8 or newer, prints one "smoke.py:" line, and exits with status 1 on
failure, after printing Blender's output.

Usage: smoke.py --runtime <dir> --work <dir> [--executable <path>] [--bpy <version>]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import re
import shutil
import subprocess
import sys
import time
from typing import Dict, List, Optional, Tuple

TIMEOUT_SECONDS = 600
# Seconds the script waits for the test to look at its application entry before it exits anyway.
CHECK_WAIT_SECONDS = 60
# Seconds the test waits for LaunchServices to finish registering the process, which leaves its type unset at first.
REGISTRATION_SECONDS = 10
WIDTH, HEIGHT = 64, 48
REDIRECTING_VARIABLES = ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "ELECTRON_RUN_AS_NODE")
# What the script reports when it finished: numpy.dot([1, 2], [3, 4]).
NUMPY_RESULT = 11
# The first bytes of a .blend file: Blender's header, or a zstd frame for the compressed files that Blender 5 saves by default.
BLEND_HEADERS = (b"BLENDER", b"\x28\xb5\x2f\xfd")
# The application type that LaunchServices gives a process with no Dock icon, no menu bar, and no place in the switcher.
HIDDEN_TYPE = "BackgroundOnly"
# Whether the script also renders with EEVEE, which needs a GPU: macOS always has one through Metal, and the Windows
# runners of the release workflow have none.
EEVEE = sys.platform == "darwin"

SCRIPT = f"""
import json, os, platform, sys, time
import bpy, numpy
worked, checked, result, cycles, eevee, glb, blend = sys.argv[1:8]
bpy.ops.wm.read_factory_settings(use_empty=True)
scene = bpy.context.scene
mesh = bpy.data.meshes.new('Pyramid')
mesh.from_pydata([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0), (0, 0, 1.5)], [],
                 [(0, 1, 2, 3), (0, 1, 4), (1, 2, 4), (2, 3, 4), (3, 0, 4)])
pyramid = bpy.data.objects.new('Pyramid', mesh)
scene.collection.objects.link(pyramid)
material = bpy.data.materials.new('Red')
material.use_nodes = True
material.node_tree.nodes['Principled BSDF'].inputs['Base Color'].default_value = (0.8, 0.1, 0.1, 1.0)
mesh.materials.append(material)
camera = bpy.data.objects.new('Camera', bpy.data.cameras.new('Camera'))
camera.location = (4, -4, 3)
camera.rotation_euler = (1.1, 0, 0.785)
scene.collection.objects.link(camera)
scene.camera = camera
light = bpy.data.objects.new('Sun', bpy.data.lights.new('Sun', 'SUN'))
scene.collection.objects.link(light)
scene.render.resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = {WIDTH}, {HEIGHT}, 100
scene.render.image_settings.file_format = 'PNG'
scene.render.engine = 'CYCLES'
scene.cycles.device = 'CPU'
scene.cycles.samples = 4
scene.render.filepath = cycles
bpy.ops.render.render(write_still=True)
if {EEVEE}:
    scene.render.engine = 'BLENDER_EEVEE'
    scene.eevee.taa_render_samples = 4
    scene.render.filepath = eevee
    bpy.ops.render.render(write_still=True)
bpy.ops.export_scene.gltf(filepath=glb, export_format='GLB')
bpy.ops.wm.save_as_mainfile(filepath=blend)
json.dump({{'blender': '.'.join(str(part) for part in bpy.app.version), 'python': platform.python_version(),
           'numpy': int(numpy.dot([1, 2], [3, 4]))}}, open(result, 'w'))
open(worked, 'w').close()
deadline = time.monotonic() + {CHECK_WAIT_SECONDS}
while not os.path.exists(checked) and time.monotonic() < deadline:
    time.sleep(0.1)
"""


def runtime_executable(runtime: str, executable: Optional[str]) -> str:
    """Read the Python program of a runtime from its runtime.json, or use the build's path before packaging.

    @param runtime: runtime directory.
    @param executable: program path relative to the runtime, which replaces runtime.json's.
    @returns: the program path relative to the runtime.
    @raises SystemExit: when neither runtime.json nor --executable names the program.
    """
    if executable is not None:
        return executable
    path = os.path.join(runtime, "runtime.json")
    if not os.path.isfile(path):
        raise SystemExit("smoke.py: error: the runtime has no runtime.json; pass --executable")
    with open(path, encoding="utf-8") as stream:
        return str(json.load(stream)["executable"])


def python_environment() -> Dict[str, str]:
    """Build the Python environment as the plugin does: the test's own without Python and Electron redirection.

    @returns: the environment.
    """
    return {name: value for name, value in os.environ.items() if name not in REDIRECTING_VARIABLES}


def tree_state(root: str) -> Dict[str, Tuple[int, int]]:
    """Record every entry of a folder: files with their size and modification time, folders with zeros.

    @param root: folder to record.
    @returns: the relative '/'-separated path of every entry mapped to its size and modification time in nanoseconds.
    """
    state: Dict[str, Tuple[int, int]] = {}
    for directory, folders, names in os.walk(root):
        for name in folders + names:
            path = os.path.join(directory, name)
            relative = os.path.relpath(path, root).replace(os.sep, "/")
            info = os.lstat(path)
            state[relative] = (0, 0) if name in folders else (info.st_size, info.st_mtime_ns)
    return state


def tree_changes(before: Dict[str, Tuple[int, int]], after: Dict[str, Tuple[int, int]]) -> List[str]:
    """Name the entries that a run added, removed, or changed.

    @param before: tree_state before the run.
    @param after: tree_state after the run.
    @returns: up to five relative paths, sorted.
    """
    changed = set(before) ^ set(after)
    changed.update(path for path in set(before) & set(after) if before[path] != after[path])
    return sorted(changed)[:5]


def png_size(path: str) -> Optional[List[int]]:
    """Read a PNG file's width and height from its header.

    @param path: file path.
    @returns: [width, height], or None when the file is missing or not a PNG.
    """
    try:
        with open(path, "rb") as stream:
            header = stream.read(24)
    except OSError:
        return None
    if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n":
        return None
    return [int.from_bytes(header[16:20], "big"), int.from_bytes(header[20:24], "big")]


def starts_with(path: str, prefixes: Tuple[bytes, ...]) -> bool:
    """Tell whether a file starts with one of the given byte strings.

    @param path: file path.
    @param prefixes: the accepted first bytes.
    @returns: false for a missing file.
    """
    try:
        with open(path, "rb") as stream:
            head = stream.read(max(len(prefix) for prefix in prefixes))
    except OSError:
        return False
    return any(head.startswith(prefix) for prefix in prefixes)


class Application:
    """How LaunchServices lists a process: its entry, the entry's type, and whether the Dock and the switcher show it."""

    def __init__(self, entry: str, kind: Optional[str], visible: bool) -> None:
        """@param entry: the application serial number that lsappinfo prints, such as ASN:0x0-0x245245; empty for none.
        @param kind: the entry's type, such as BackgroundOnly or Foreground; None while it is unset or without an entry.
        @param visible: whether lsappinfo's visible process list holds the entry.
        """
        self.entry = entry
        self.kind = kind
        self.visible = visible


def entry_type(info: str) -> Optional[str]:
    """Read an application entry's type from lsappinfo info output.

    @param info: what lsappinfo info printed for the entry.
    @returns: the type, such as BackgroundOnly; None when it is unset ([ NULL ]) or missing.
    """
    match = re.search(r'\btype="([^"]*)"', info)
    return match.group(1) if match else None


def problems(returncode: int, report: Optional[Dict[str, object]], bpy: Optional[str], sizes: List[Optional[List[int]]],
             files: Dict[str, bool], app: Application, changes: List[str]) -> List[str]:
    """List what a run did wrong.

    @param returncode: Python's exit status.
    @param report: the JSON object the script wrote, or None.
    @param bpy: the Blender version the runtime must report, or None to accept any.
    @param sizes: the [width, height] of the Cycles image and, when EEVEE rendered, the EEVEE image; None for a missing one.
    @param files: whether the glTF binary and the .blend file start as they must, by kind.
    @param app: how LaunchServices lists Python's process.
    @param changes: entries of the runtime that the run added, removed, or changed.
    @returns: one description per problem; empty when the run passed.
    """
    found = []
    if returncode != 0:
        found.append(f"Python exited with status {returncode}")
    if report is None:
        found.append("the script reported nothing")
    else:
        if bpy is not None and report.get("blender") != bpy:
            found.append(f"Blender reported version {report.get('blender')!r}, not {bpy!r}")
        if report.get("numpy") != NUMPY_RESULT:
            found.append(f"numpy computed {report.get('numpy')!r}, not {NUMPY_RESULT}")
    for engine, size in zip(("Cycles", "EEVEE"), sizes):
        if size != [WIDTH, HEIGHT]:
            found.append(f"the {engine} render is {size}, not {WIDTH}x{HEIGHT}")
    found.extend(f"no valid {kind} file was written" for kind, valid in sorted(files.items()) if not valid)
    if app.entry != "" and app.kind != HIDDEN_TYPE:
        found.append(f"macOS lists Blender's process as an application of type {app.kind or 'unset'}, not {HIDDEN_TYPE}: {app.entry}")
    if app.visible:
        found.append(f"macOS shows Blender's process in the Dock and the application switcher: {app.entry}")
    if changes:
        found.append(f"the run changed the runtime: {', '.join(changes)}")
    return found


def application(pid: int) -> Application:
    """Ask lsappinfo how macOS lists a process, waiting up to REGISTRATION_SECONDS for its registration to set a type.

    @param pid: process id.
    @returns: the process's entry, type, and visibility; no entry when lsappinfo lists none or is missing.
    """
    lsappinfo = shutil.which("lsappinfo")
    if lsappinfo is None:
        return Application("", None, False)

    def run(*arguments: str) -> str:
        return subprocess.run([lsappinfo, *arguments], capture_output=True, text=True, check=False).stdout

    found = run("find", f"pid={pid}").split()
    if not found:
        return Application("", None, False)
    entry = found[0].split('"')[0].rstrip(":-")
    deadline = time.monotonic() + REGISTRATION_SECONDS
    kind = entry_type(run("info", entry))
    while kind is None and time.monotonic() < deadline:
        time.sleep(0.25)
        kind = entry_type(run("info", entry))
    return Application(entry, kind, re.search(re.escape(entry) + r"[-:]", run("visibleProcessList")) is not None)


def main(argv: Optional[List[str]] = None) -> int:
    """Run the smoke test.

    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    # A Windows console writes in its code page, which cannot hold every character of a runtime's output or paths.
    for stream in (sys.stdout, sys.stderr):
        if isinstance(stream, io.TextIOWrapper):
            stream.reconfigure(errors="backslashreplace")
    parser = argparse.ArgumentParser(prog="smoke.py", description=__doc__.splitlines()[0])
    parser.add_argument("--runtime", required=True, help="runtime directory")
    parser.add_argument("--work", required=True, help="directory for the test's files; it is replaced")
    parser.add_argument("--executable", help="Python program path relative to the runtime, before runtime.json exists")
    parser.add_argument("--bpy", help="Blender version the runtime must report, such as 5.2.3")
    args = parser.parse_args(argv)
    runtime = os.path.abspath(args.runtime)
    work = os.path.abspath(args.work)
    executable = runtime_executable(runtime, args.executable)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    names = ("worked", "checked", "result.json", "cycles.png", "eevee.png", "scene.glb", "scene.blend")
    worked, checked, result, cycles, eevee, glb, blend = (os.path.join(work, name) for name in names)
    before = tree_state(runtime)
    command = [os.path.join(runtime, *executable.split("/")), "-I", "-X", "utf8", "-B", "-u", "-c", SCRIPT, worked, checked, result, cycles, eevee,
               glb, blend]
    # In UTF-8 mode Python reads and writes UTF-8 whatever the locale, so the work folder's name may hold any character.
    process = subprocess.Popen(command, cwd=work, env=python_environment(), stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                               encoding="utf-8", errors="replace")
    deadline = time.monotonic() + TIMEOUT_SECONDS
    app = Application("", None, False)
    while process.poll() is None and not os.path.exists(worked) and time.monotonic() < deadline:
        time.sleep(0.2)
    if process.poll() is None and os.path.exists(worked):
        app = application(process.pid)
    with open(checked, "w", encoding="utf-8"):
        pass
    try:
        output, _ = process.communicate(timeout=max(1.0, deadline - time.monotonic()))
    except subprocess.TimeoutExpired:
        process.kill()
        output, _ = process.communicate()
        print(output)
        print(f"smoke.py: error: Blender did not finish within {TIMEOUT_SECONDS} s", file=sys.stderr)
        return 1
    report = None
    if os.path.isfile(result):
        with open(result, encoding="utf-8") as stream:
            report = json.load(stream)
    files = {"glTF binary": starts_with(glb, (b"glTF",)), ".blend": starts_with(blend, BLEND_HEADERS)}
    sizes = [png_size(cycles)] + ([png_size(eevee)] if EEVEE else [])
    found = problems(process.returncode, report, args.bpy, sizes, files, app, tree_changes(before, tree_state(runtime)))
    if found:
        print(output)
        print(f"smoke.py: error: {'; '.join(found)}", file=sys.stderr)
        return 1
    assert report is not None
    listing = "no application entry" if app.entry == "" else f"a {HIDDEN_TYPE} application entry"
    engines = "Cycles and EEVEE" if EEVEE else "Cycles"
    print(
        f"smoke.py: Blender {report['blender']} on Python {report['python']} rendered with {engines}, exported glTF, "
        f"and saved a .blend from {executable} with {listing} and the runtime unchanged",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
