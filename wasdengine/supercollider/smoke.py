#!/usr/bin/env python3
"""Smoke-test a WASD Engine SuperCollider runtime the way the SuperCollider plugin runs it.

The test starts sclang in IDE mode with a class library configuration that
replaces the default paths with the runtime's class library, and user folders
under the work directory, then sends one command through sclang's terminal
input. The command renders a short tone offline with the runtime's scsynth and
UGen plugins to WAV, Ogg Vorbis, and FLAC, reads each file back with
SoundFile, and prints the results. scsynth reaches the plugins through a
symbolic link at a path longer than 255 bytes, which stock scsynth cuts short
(BUILD.md explains the build's change). The test passes when every file holds
half a second of stereo audio at 44100 Hz that peaks near the tone's 0.5, which
fails when scsynth loaded no plugins and rendered silence. It needs only the
standard library of Python 3.8 or newer, prints one "smoke.py:" line, and exits
with status 1 on failure, after printing sclang's output.

Usage: smoke.py --runtime <dir> --work <dir>
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import threading
from typing import Dict, List, Optional

# Terminal input byte that makes sclang interpret the text before it without printing its value.
INTERPRET = "\x1b"
TIMEOUT_SECONDS = 180
SECONDS = 0.5
SAMPLE_RATE = 44100
FORMATS = (("WAV", "int16", "smoke.wav"), ("OGG", "vorbis", "smoke.ogg"), ("FLAC", "int24", "smoke.flac"))
DEFAULT_NAMES = {"sclang": "sclang", "scsynth": "scsynth", "plugins": "plugins", "classLibrary": "SCClassLibrary"}


def sclang_string(text: str) -> str:
    """Quote text as an sclang string literal.

    @param text: text without control characters.
    @returns: the literal with backslashes and quotes escaped.
    """
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def runtime_names(runtime: str) -> Dict[str, str]:
    """Read the program and folder names of a runtime from its runtime.json, or use the build's names before packaging.

    @param runtime: runtime directory.
    @returns: sclang, scsynth, plugins, and classLibrary names relative to the runtime.
    """
    path = os.path.join(runtime, "runtime.json")
    if not os.path.isfile(path):
        return dict(DEFAULT_NAMES)
    with open(path, encoding="utf-8") as stream:
        record = json.load(stream)
    return {field: record[field] for field in DEFAULT_NAMES}


def command(scsynth: str, plugins: str, work: str) -> str:
    """Return the sclang code that renders the test files and prints one SMOKE line.

    @param scsynth: absolute scsynth path.
    @param plugins: absolute UGen plugin folder.
    @param work: absolute work directory for the rendered files.
    @returns: sclang code ending in the interpret byte.
    """
    formats = "[" + ", ".join(f"[{sclang_string(header)}, {sclang_string(sample)}, {sclang_string(os.path.join(work, name))}]" for header, sample, name in FORMATS) + "]"
    return f"""(
Routine {{
    var condition = Condition.new, results = List.new, exitCode;
    var def = SynthDef(\\wasdSmoke, {{ Out.ar(0, SinOsc.ar(440) * Env.perc(0.01, 0.4).kr(2) * 0.5 ! 2) }});
    var options = ServerOptions.new.numOutputBusChannels_(2).numInputBusChannels_(0).ugenPluginsPath_({sclang_string(plugins)});
    Score.program = "exec %".format({sclang_string(scsynth)}.shellQuote);
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


def main(argv: Optional[List[str]] = None) -> int:
    """Run the smoke test.

    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    parser = argparse.ArgumentParser(prog="smoke.py", description=__doc__.splitlines()[0])
    parser.add_argument("--runtime", required=True, help="runtime directory")
    parser.add_argument("--work", required=True, help="work directory, emptied first and removed after a passing test")
    args = parser.parse_args(argv)
    runtime = os.path.abspath(args.runtime)
    work = os.path.abspath(args.work)
    names = runtime_names(runtime)
    shutil.rmtree(work, ignore_errors=True)
    os.makedirs(work)
    config = os.path.join(work, "sclang_conf.yaml")
    with open(config, "w", encoding="utf-8") as stream:
        # A JSON string literal is also a YAML double-quoted scalar.
        stream.write(f"includePaths:\n  - {json.dumps(os.path.join(runtime, names['classLibrary']))}\nexcludePaths: []\n"
                     "postInlineWarnings: false\nexcludeDefaultPaths: true\n")
    env = dict(os.environ, XDG_CONFIG_HOME=os.path.join(work, "config"), XDG_DATA_HOME=os.path.join(work, "data"))
    # Stock scsynth cuts each folder of its plugin path to 255 bytes; this one is longer.
    deep = os.path.join(work, *(["long-folder-name"] * 16))
    os.makedirs(deep)
    plugins = os.path.join(deep, "plugins")
    os.symlink(os.path.join(runtime, names["plugins"]), plugins, target_is_directory=True)
    code = command(os.path.join(runtime, names["scsynth"]), plugins, work)
    # sclang quits at the end of its input, so stdin stays open until the command's 0.exit ends it.
    process = subprocess.Popen([os.path.join(runtime, names["sclang"]), "-i", "wasd", "-l", config],
                               stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, cwd=work, env=env)
    chunks: List[bytes] = []
    reader = threading.Thread(target=lambda: chunks.extend(iter(lambda: process.stdout.read1(65536) if process.stdout else b"", b"")), daemon=True)
    reader.start()
    assert process.stdin is not None
    process.stdin.write(code.encode("utf-8"))
    process.stdin.flush()
    try:
        process.wait(timeout=TIMEOUT_SECONDS)
        timed_out = ""
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait()
        timed_out = f"\n[sclang ran longer than {TIMEOUT_SECONDS} s]"
    process.stdin.close()
    reader.join(timeout=10)
    output = b"".join(chunks).decode("utf-8", "replace") + timed_out
    line = next((candidate for candidate in output.splitlines() if candidate.startswith("SMOKE ")), None)
    failure = "sclang printed no SMOKE line" if line is None else check(line)
    if failure is not None:
        sys.stdout.write(output)
        print(f"smoke.py: error: {failure}", file=sys.stderr)
        return 1
    shutil.rmtree(work, ignore_errors=True)
    print(f"smoke.py: SuperCollider {line.split(' ')[1]} rendered {', '.join(header for header, _, _ in FORMATS)} offline from {runtime}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
