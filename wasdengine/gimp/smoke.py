#!/usr/bin/env python3
"""Smoke-test a WASD Engine GIMP runtime the way the GIMP plugin runs it.

The test starts the runtime's gimp-console without a splash screen, with a new
profile under the work directory and GIMP3_DATADIR, GIMP3_LOCALEDIR, and
GIMP3_SYSCONFDIR naming the runtime's folders, as the plugin sets them, and runs
one python-fu-eval batch command; on Windows it starts GIMP without a console
window, as the plugin's Node.js process does. The command creates an image,
fills it, saves it as PNG, and records GIMP's data folder, which its Python
plug-ins also read. While GIMP runs, the test asks lsappinfo whether macOS lists
an application for the process, which would put GIMP in the Dock, or, on
Windows, looks for a visible window of any process that GIMP started, which
would also put GIMP on the taskbar. The test passes when GIMP exits with status
0, says that the batch command succeeded, prints no catalog, CRITICAL, or
WARNING line, saved the PNG, reports the runtime's data folder, and showed
nothing. It needs only the standard library of Python 3.8 or newer, prints one
"smoke.py:" line, and exits with status 1 on failure, after printing GIMP's
output.

Usage: smoke.py --runtime <dir> --work <dir> [--console <path>]
"""

from __future__ import annotations

import argparse
import io
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from typing import Dict, List, Optional

TIMEOUT_SECONDS = 300
# Seconds the batch command waits after its work, so lsappinfo can look at a running GIMP.
LINGER_SECONDS = 3
WIDTH, HEIGHT = 64, 32
# The folders of the build's layouts before runtime.json exists: inside Contents on macOS, at the root on Windows.
DEFAULT_FOLDERS = {"dataDir": "Contents/share/gimp/3.0", "localeDir": "Contents/share/locale", "sysconfDir": "Contents/etc/gimp/3.0"}
WINDOWS_FOLDERS = {"dataDir": "share/gimp/3.0", "localeDir": "share/locale", "sysconfDir": "etc/gimp/3.0"}
# Seconds between two looks at the windows of GIMP's processes on Windows.
POLL_SECONDS = 0.2
# Lines that a healthy start prints none of: missing translation catalogs and GLib criticals or warnings.
FORBIDDEN_OUTPUT = ("catalog directory does not exist", "-CRITICAL", "-WARNING")
REDIRECTING_VARIABLES = ("PYTHONPATH", "PYTHONHOME", "PYTHONSTARTUP", "VIRTUAL_ENV", "ELECTRON_RUN_AS_NODE")


def runtime_layout(runtime: str, console: Optional[str], windows: bool = os.name == "nt") -> Dict[str, str]:
    """Read the console and folders of a runtime from its runtime.json, or use the build's names before packaging.

    @param runtime: runtime directory.
    @param console: console path relative to the runtime, which replaces runtime.json's.
    @param windows: whether the build's names are those of the Windows layout.
    @returns: console, dataDir, localeDir, and sysconfDir relative to the runtime.
    @raises SystemExit: when neither runtime.json nor --console names the console.
    """
    path = os.path.join(runtime, "runtime.json")
    layout = dict(WINDOWS_FOLDERS if windows else DEFAULT_FOLDERS)
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as stream:
            record = json.load(stream)
        layout.update({field: record[field] for field in ("console", *DEFAULT_FOLDERS)})
    if console is not None:
        layout["console"] = console
    if "console" not in layout:
        raise SystemExit("smoke.py: error: the runtime has no runtime.json; pass --console")
    return layout


def batch_command(png: str, result: str, started: str) -> str:
    """Build the python-fu-eval batch command.

    @param png: path the command saves the image to.
    @param result: path of the JSON file it writes with GIMP's data folder.
    @param started: path of the file it creates first, which tells the test that GIMP runs.
    @returns: Python source; JSON string literals are also Python string literals.
    """
    return "\n".join([
        "import json, time",
        "from gi.repository import Gimp, Gio",
        f"open({json.dumps(started)}, 'w').close()",
        f"image = Gimp.Image.new({WIDTH}, {HEIGHT}, Gimp.ImageBaseType.RGB)",
        f"layer = Gimp.Layer.new(image, 'Background', {WIDTH}, {HEIGHT}, Gimp.ImageType.RGBA_IMAGE, 100.0, Gimp.LayerMode.NORMAL)",
        "image.insert_layer(layer, None, 0)",
        "layer.fill(Gimp.FillType.WHITE)",
        f"Gimp.file_save(Gimp.RunMode.NONINTERACTIVE, image, Gio.File.new_for_path({json.dumps(png)}), None)",
        f"json.dump({{'data': Gimp.data_directory()}}, open({json.dumps(result)}, 'w'))",
        f"time.sleep({LINGER_SECONDS})",
    ])


def gimp_environment(runtime: str, layout: Dict[str, str], profile: str) -> Dict[str, str]:
    """Build GIMP's environment as the plugin does: the test's own without Python and Electron redirection, plus the profile and folders.

    @param runtime: runtime directory.
    @param layout: console and folders relative to the runtime.
    @param profile: GIMP profile directory.
    @returns: the environment.
    """
    env = {name: value for name, value in os.environ.items() if name not in REDIRECTING_VARIABLES}
    env["GIMP3_DIRECTORY"] = profile
    for variable, field in (("GIMP3_DATADIR", "dataDir"), ("GIMP3_LOCALEDIR", "localeDir"), ("GIMP3_SYSCONFDIR", "sysconfDir")):
        env[variable] = os.path.join(runtime, *layout[field].split("/"))
    return env


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


def problems(returncode: int, output: str, size: Optional[List[int]], data: Optional[str], expected_data: str, app: str,
             windows: Optional[List[str]] = None) -> List[str]:
    """List what a GIMP run did wrong.

    @param returncode: GIMP's exit status.
    @param output: GIMP's combined standard output and error.
    @param size: the saved PNG's [width, height], or None.
    @param data: the data folder GIMP reported, or None.
    @param expected_data: the runtime's data folder.
    @param app: what lsappinfo printed for GIMP's process.
    @param windows: the visible windows that GIMP's processes showed on Windows.
    @returns: one description per problem; empty when the run passed.
    """
    found = []
    if returncode != 0:
        found.append(f"GIMP exited with status {returncode}")
    if "batch command executed successfully" not in output:
        found.append("GIMP did not report that the batch command succeeded")
    found.extend(f"GIMP printed {text!r}" for text in FORBIDDEN_OUTPUT if text in output)
    if size != [WIDTH, HEIGHT]:
        found.append(f"the saved PNG is {size}, not {WIDTH}x{HEIGHT}")
    if data is None or os.path.normcase(os.path.realpath(data)) != os.path.normcase(os.path.realpath(expected_data)):
        found.append(f"GIMP's data folder is {data!r}, not {expected_data!r}")
    if app.strip() != "":
        found.append(f"macOS lists an application for GIMP's process: {app.strip()}")
    if windows:
        found.append(f"GIMP's processes showed windows: {'; '.join(windows)}")
    return found


def application_entry(pid: int) -> str:
    """Ask lsappinfo which application macOS lists for a process.

    @param pid: process id.
    @returns: lsappinfo's output; empty when it lists none or lsappinfo is missing.
    """
    lsappinfo = shutil.which("lsappinfo")
    if lsappinfo is None:
        return ""
    return subprocess.run([lsappinfo, "find", f"pid={pid}"], capture_output=True, text=True, check=False).stdout


def visible_windows(root: int) -> List[str]:
    """List the visible top-level windows of a Windows process and every process it started, which the taskbar shows.

    @param root: process id of the first process.
    @returns: one "<program> (<pid>): <class> '<title>'" description per window; empty off Windows.
    """
    if os.name != "nt":
        return []
    import ctypes
    from ctypes import wintypes

    class ProcessEntry(ctypes.Structure):
        _fields_ = [("dwSize", wintypes.DWORD), ("cntUsage", wintypes.DWORD), ("th32ProcessID", wintypes.DWORD),
                    ("th32DefaultHeapID", ctypes.c_size_t), ("th32ModuleID", wintypes.DWORD), ("cntThreads", wintypes.DWORD),
                    ("th32ParentProcessID", wintypes.DWORD), ("pcPriClassBase", ctypes.c_long), ("dwFlags", wintypes.DWORD),
                    ("szExeFile", wintypes.WCHAR * 260)]

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32.CreateToolhelp32Snapshot.restype = wintypes.HANDLE
    kernel32.CreateToolhelp32Snapshot.argtypes = [wintypes.DWORD, wintypes.DWORD]
    kernel32.Process32FirstW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel32.Process32NextW.argtypes = [wintypes.HANDLE, ctypes.POINTER(ProcessEntry)]
    kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
    parents: Dict[int, int] = {}
    programs: Dict[int, str] = {}
    snapshot = kernel32.CreateToolhelp32Snapshot(0x2, 0)  # TH32CS_SNAPPROCESS
    if snapshot is None or snapshot == wintypes.HANDLE(-1).value:
        return []
    try:
        entry = ProcessEntry()
        entry.dwSize = ctypes.sizeof(entry)
        more = kernel32.Process32FirstW(snapshot, ctypes.byref(entry))
        while more:
            parents[entry.th32ProcessID] = entry.th32ParentProcessID
            programs[entry.th32ProcessID] = entry.szExeFile
            more = kernel32.Process32NextW(snapshot, ctypes.byref(entry))
    finally:
        kernel32.CloseHandle(snapshot)
    tree = {root}
    grown = True
    while grown:
        grown = False
        for process, parent in parents.items():
            if parent in tree and process not in tree and process != parent:
                tree.add(process)
                grown = True

    found: List[str] = []
    callback_type = ctypes.WINFUNCTYPE(wintypes.BOOL, wintypes.HWND, wintypes.LPARAM)
    user32.GetWindowThreadProcessId.argtypes = [wintypes.HWND, ctypes.POINTER(wintypes.DWORD)]
    user32.IsWindowVisible.argtypes = [wintypes.HWND]
    user32.GetWindowTextW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.GetClassNameW.argtypes = [wintypes.HWND, wintypes.LPWSTR, ctypes.c_int]
    user32.EnumWindows.argtypes = [callback_type, wintypes.LPARAM]

    def visit(window: int, _: int) -> bool:
        owner = wintypes.DWORD()
        user32.GetWindowThreadProcessId(window, ctypes.byref(owner))
        if owner.value in tree and user32.IsWindowVisible(window):
            title, kind = ctypes.create_unicode_buffer(256), ctypes.create_unicode_buffer(256)
            user32.GetWindowTextW(window, title, 256)
            user32.GetClassNameW(window, kind, 256)
            found.append(f"{programs.get(owner.value, '?')} ({owner.value}): {kind.value} {title.value!r}")
        return True

    user32.EnumWindows(callback_type(visit), 0)
    return found


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
    parser.add_argument("--work", required=True, help="directory for the profile and the test's files; it is replaced")
    parser.add_argument("--console", help="console path relative to the runtime, before runtime.json exists")
    args = parser.parse_args(argv)
    runtime = os.path.abspath(args.runtime)
    work = os.path.abspath(args.work)
    layout = runtime_layout(runtime, args.console)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(os.path.join(work, "profile"))
    png, result, started = (os.path.join(work, name) for name in ("smoke.png", "result.json", "started"))
    command = [os.path.join(runtime, *layout["console"].split("/")), "-n", "-s", "-c", "--batch-interpreter=python-fu-eval",
               "-b", batch_command(png, result, started), "--quit"]
    # CREATE_NO_WINDOW gives GIMP a console without a window, as Node.js does for a hidden child with piped output.
    process = subprocess.Popen(command, cwd=work, env=gimp_environment(runtime, layout, os.path.join(work, "profile")),
                               stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, errors="replace",
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    chunks: List[str] = []
    reader = threading.Thread(target=lambda: chunks.extend(iter(lambda: process.stdout.read(4096) if process.stdout else "", "")), daemon=True)
    reader.start()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    app = ""
    asked = False
    windows: List[str] = []
    while process.poll() is None and time.monotonic() < deadline:
        windows.extend(window for window in visible_windows(process.pid) if window not in windows)
        if not asked and os.path.exists(started):
            app, asked = application_entry(process.pid), True
        time.sleep(POLL_SECONDS)
    if process.poll() is None:
        process.kill()
        process.wait()
        reader.join(timeout=10)
        print("".join(chunks))
        print(f"smoke.py: error: GIMP did not finish within {TIMEOUT_SECONDS} s", file=sys.stderr)
        return 1
    reader.join(timeout=10)
    output = "".join(chunks)
    data = None
    if os.path.isfile(result):
        with open(result, encoding="utf-8") as stream:
            data = json.load(stream).get("data")
    expected = os.path.join(runtime, *layout["dataDir"].split("/"))
    found = problems(process.returncode, output, png_size(png), data, expected, app, windows)
    if found:
        print(output)
        print(f"smoke.py: error: {'; '.join(found)}", file=sys.stderr)
        return 1
    print(f"smoke.py: GIMP saved a {WIDTH}x{HEIGHT} PNG from {layout['console']} with the runtime's data folder and showed no application or window", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
