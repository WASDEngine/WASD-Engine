#!/usr/bin/env python3
"""Smoke-test a WASD Engine SuperCollider runtime the way the SuperCollider plugin runs it.

The test starts sclang in IDE mode, as the plugin's bridge does, with a class
library configuration that replaces the default paths with the runtime's class
library and that it names relative to its working directory, and user folders
under the work directory, then sends one command through sclang's terminal
input; on Windows it starts sclang without a console window, as the plugin's
Node.js process does. The command renders a short tone offline with the
runtime's scsynth and UGen plugins to WAV, Ogg Vorbis, and FLAC, reads each file
back with SoundFile, and prints the results. scsynth reads a copy of the plugins
in a folder whose path, made of characters outside ASCII, is longer than 255
bytes but shorter than Windows' 260-character limit, which stock scsynth cuts
short (BUILD.md explains the build's change). The test passes when every file
holds half a second of stereo audio at 44100 Hz that peaks near the tone's 0.5,
which fails when scsynth loaded no plugins and rendered silence, and when, on
Windows, no process that sclang started showed a visible window. It needs only
the standard library of Python 3.8 or newer, prints one "smoke.py:" line, and
exits with status 1 on failure, after printing sclang's output.

Usage: smoke.py --runtime <dir> --work <dir>
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
from typing import Callable, Dict, List, Optional, Set

# Terminal input byte that makes sclang interpret the text before it without printing its value.
INTERPRET = "\x1b"
TIMEOUT_SECONDS = 180
SECONDS = 0.5
SAMPLE_RATE = 44100
FORMATS = (("WAV", "int16", "smoke.wav"), ("OGG", "vorbis", "smoke.ogg"), ("FLAC", "int24", "smoke.flac"))
DEFAULT_NAMES = {"sclang": "sclang", "scsynth": "scsynth", "plugins": "plugins", "classLibrary": "SCClassLibrary"}
# The class library configuration, in the work directory, which is sclang's working directory.
CONFIG_NAME = "sclang_conf.yaml"
# A folder name of 20 characters outside ASCII, 60 bytes in UTF-8, which deepens the plugin path.
DEEP_FOLDER = "\u58f0" * 20
# Seconds between two looks at the windows of sclang's processes on Windows.
POLL_SECONDS = 0.2


def sclang_string(text: str) -> str:
    """Quote text as an sclang string literal.

    @param text: text without control characters.
    @returns: the literal with backslashes and quotes escaped.
    """
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def runtime_names(runtime: str, windows: bool = os.name == "nt") -> Dict[str, str]:
    """Read the program and folder names of a runtime from its runtime.json, or use the build's names before packaging.

    @param runtime: runtime directory.
    @param windows: whether the build's programs carry the .exe extension.
    @returns: sclang, scsynth, plugins, and classLibrary names relative to the runtime.
    """
    path = os.path.join(runtime, "runtime.json")
    if not os.path.isfile(path):
        names = dict(DEFAULT_NAMES)
        if windows:
            names.update(sclang="sclang.exe", scsynth="scsynth.exe")
        return names
    with open(path, encoding="utf-8") as stream:
        record = json.load(stream)
    return {field: record[field] for field in DEFAULT_NAMES}


def score_program(scsynth: str, windows: bool) -> str:
    """Return the sclang expression for Score.program, as the plugin's worker class sets it.

    sclang runs the command through sh on macOS and Linux, where exec replaces the shell with scsynth, and through
    cmd.exe on Windows, which quotes with double quotes and has no exec.

    @param scsynth: absolute scsynth path.
    @param windows: whether sclang runs on Windows.
    @returns: sclang code.
    """
    return f"{sclang_string(scsynth)}.quote" if windows else f'"exec %".format({sclang_string(scsynth)}.shellQuote)'


def deep_plugins(work: str) -> str:
    """Return a plugin folder inside the work directory whose path is longer than 255 bytes in UTF-8.

    @param work: absolute work directory.
    @returns: the folder path, which nests DEEP_FOLDER until the path passes 255 bytes.
    """
    folder = work
    while len(os.path.join(folder, "plugins").encode("utf-8")) <= 255:
        folder = os.path.join(folder, DEEP_FOLDER)
    return os.path.join(folder, "plugins")


def command(scsynth: str, plugins: str, work: str, windows: bool = os.name == "nt") -> str:
    """Return the sclang code that renders the test files and prints one SMOKE line.

    @param scsynth: absolute scsynth path.
    @param plugins: absolute UGen plugin folder.
    @param work: absolute work directory for the rendered files.
    @param windows: whether sclang runs on Windows.
    @returns: sclang code ending in the interpret byte.
    """
    formats = "[" + ", ".join(f"[{sclang_string(header)}, {sclang_string(sample)}, {sclang_string(os.path.join(work, name))}]" for header, sample, name in FORMATS) + "]"
    return f"""(
Routine {{
    var condition = Condition.new, results = List.new, exitCode;
    var def = SynthDef(\\wasdSmoke, {{ Out.ar(0, SinOsc.ar(440) * Env.perc(0.01, 0.4).kr(2) * 0.5 ! 2) }});
    var options = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0).ugenPluginsPath_({sclang_string(plugins)});
    Score.program = {score_program(scsynth, windows)};
    {formats}.do {{ |format|
        condition.test = false;
        Score([[0.0, [\\d_recv, def.asBytes]], [0.0, [\\s_new, \\wasdSmoke, 1000, 0, 0]]])
            .recordNRT(format[2] ++ ".osc", format[2], nil, {SAMPLE_RATE}, format[0], format[1], options, "", {SECONDS},
                {{ |code| exitCode = code; condition.test = true; condition.signal }});
        condition.wait;
        SoundFile.use(format[2], {{ |file|
            var samples = FloatArray.newClear(file.numFrames * file.numChannels);
            file.readData(samples);
            results.add([format[0], exitCode, file.numFrames, file.numChannels, file.sampleRate, (samples.abs.maxItem ? 0).round(0.001)]);
        }});
    }};
    ("SMOKE " ++ Main.version ++ " " ++ results.asArray.collect {{ |result| result.join(",") }}.join(";")).postln;
    0.exit;
}}.play(AppClock);
)
{INTERPRET}"""


def check(line: str) -> Optional[str]:
    """Check the SMOKE line.

    @param line: the line sclang printed, starting with "SMOKE ".
    @returns: None when every file holds the expected audio, otherwise the reason.
    """
    parts = line.split(" ", 2)
    if len(parts) < 3 or parts[2].strip() == "":
        return "sclang rendered no file"
    results = [entry.split(",") for entry in parts[2].strip().split(";")]
    if any(len(result) != 6 for result in results):
        return f"sclang printed the malformed line {line.strip()!r}"
    if [result[0] for result in results] != [header for header, _, _ in FORMATS]:
        return f"sclang rendered {', '.join(result[0] for result in results)}"
    for header, code, frames, channels, rate, peak in results:
        if code != "0":
            return f"scsynth exited with code {code} while rendering {header}"
        # Vorbis rounds the length up to whole blocks.
        if not SECONDS * SAMPLE_RATE <= int(frames) <= SECONDS * SAMPLE_RATE + 4096 or channels != "2" or rate != str(SAMPLE_RATE):
            return f"the {header} file holds {frames} frames of {channels} channels at {rate} Hz"
        if not 0.25 <= float(peak) <= 1:
            return f"the {header} file peaks at {peak} instead of about 0.5"
    return None


def process_tree(root: int, parents: Dict[int, int], created: Callable[[int], Optional[int]]) -> Set[int]:
    """Collect a process and every process that it started, directly or through others.

    A process joins when its recorded parent is in the collection and was created no later than it: Windows reuses process
    ids, so a process whose parent has exited can name an id that a later, unrelated process holds.

    @param root: process id of the first process.
    @param parents: the recorded parent id of every process.
    @param created: a process's creation time, or None when it cannot be read; such a process never joins.
    @returns: the ids of root and its descendants.
    """
    tree = {root}
    times: Dict[int, Optional[int]] = {}

    def time_of(process: int) -> Optional[int]:
        if process not in times:
            times[process] = created(process)
        return times[process]

    grown = True
    while grown:
        grown = False
        for process, parent in parents.items():
            if parent not in tree or process in tree or process == parent:
                continue
            child, origin = time_of(process), time_of(parent)
            if child is not None and origin is not None and child >= origin:
                tree.add(process)
                grown = True
    return tree


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
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
    kernel32.GetProcessTimes.argtypes = [wintypes.HANDLE] + [ctypes.POINTER(wintypes.FILETIME)] * 4

    def created(process: int) -> Optional[int]:
        handle = kernel32.OpenProcess(0x1000, False, process)  # PROCESS_QUERY_LIMITED_INFORMATION
        if not handle:
            return None
        try:
            times = [wintypes.FILETIME() for _ in range(4)]
            if not kernel32.GetProcessTimes(handle, *(ctypes.byref(time) for time in times)):
                return None
            return times[0].dwHighDateTime << 32 | times[0].dwLowDateTime
        finally:
            kernel32.CloseHandle(handle)

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
    tree = process_tree(root, parents, created)

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
    parser.add_argument("--work", required=True, help="work directory, emptied first and removed after a passing test")
    args = parser.parse_args(argv)
    runtime = os.path.abspath(args.runtime)
    work = os.path.abspath(args.work)
    names = runtime_names(runtime)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    config = os.path.join(work, CONFIG_NAME)
    with open(config, "w", encoding="utf-8") as stream:
        # A JSON string literal is also a YAML double-quoted scalar.
        stream.write(f"includePaths:\n  - {json.dumps(os.path.join(runtime, names['classLibrary']))}\nexcludePaths: []\n"
                     "postInlineWarnings: false\nexcludeDefaultPaths: true\n")
    env = dict(os.environ, XDG_CONFIG_HOME=os.path.join(work, "config"), XDG_DATA_HOME=os.path.join(work, "data"))
    # Stock scsynth cuts each folder of its plugin path to 255 bytes; this one is longer.
    plugins = deep_plugins(work)
    shutil.copytree(os.path.join(runtime, names["plugins"]), plugins)
    code = command(os.path.join(runtime, names["scsynth"]), plugins, work)
    # sclang quits at the end of its input, so stdin stays open until the command's 0.exit ends it. The configuration is
    # named relative to the working directory, because sclang on Windows reads its arguments in the ANSI code page.
    # CREATE_NO_WINDOW gives sclang a console without a window, as Node.js does for a hidden child with piped output.
    process = subprocess.Popen([os.path.join(runtime, names["sclang"]), "-i", "wasd", "-l", CONFIG_NAME],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=work, env=env,
                               creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    chunks: List[bytes] = []
    reader = threading.Thread(target=lambda: chunks.extend(iter(lambda: process.stdout.read1(65536) if process.stdout else b"", b"")), daemon=True)
    reader.start()
    assert process.stdin is not None
    process.stdin.write(code.encode("utf-8"))
    process.stdin.flush()
    deadline = time.monotonic() + TIMEOUT_SECONDS
    windows: List[str] = []
    while process.poll() is None and time.monotonic() < deadline:
        windows.extend(window for window in visible_windows(process.pid) if window not in windows)
        time.sleep(POLL_SECONDS)
    timed_out = ""
    if process.poll() is None:
        process.kill()
        process.wait()
        timed_out = f"\n[sclang ran longer than {TIMEOUT_SECONDS} s]"
    process.stdin.close()
    reader.join(timeout=10)
    output = b"".join(chunks).decode("utf-8", "replace") + timed_out
    line = next((candidate for candidate in output.splitlines() if candidate.startswith("SMOKE ")), None)
    failure = "sclang printed no SMOKE line" if line is None else check(line)
    if failure is None and windows:
        failure = f"sclang's processes showed windows: {'; '.join(windows)}"
    if failure is not None:
        sys.stdout.write(output)
        print(f"smoke.py: error: {failure}", file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print(f"smoke.py: SuperCollider {line.split(' ')[1]} rendered {', '.join(header for header, _, _ in FORMATS)} offline from {runtime} and showed no window")
    return 0


if __name__ == "__main__":
    sys.exit(main())
