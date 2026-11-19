#!/usr/bin/env python3
"""Package, install, merge, and verify WASD Engine SuperCollider runtime archives.

build.sh runs the supercollider-version, package, and install commands, and on
Windows the vc-runtime and check-imports commands; the release workflow
(.github/workflows/wasd-supercollider.yml) runs merge and verify. BUILD.md
describes runtime.json, manifest.json, and the archive layout. The script needs
only the standard library of Python 3.8 or newer. It writes UTF-8 with LF line
ends to stdout and stderr on every platform. Every failure prints one
"runtime.py: error:" line on stderr and exits with status 1.
What it shares with the other tools' runtime scripts is in ../runtime_archive.py, which it imports.
"""

from __future__ import annotations

import argparse
import functools
import io
import os
import re
import shutil
import sys
from typing import Any, Dict, List, Optional, Tuple

# The functions every tool's runtime script shares (../runtime_archive.py); python -I leaves this script's folder
# off sys.path, so the folder above it goes on.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runtime_archive as shared  # noqa: E402
from runtime_archive import (  # noqa: E402
    ARCHES,
    FORMAT,
    MANIFEST_FILE,
    NAME_MAX_LENGTH,
    PLATFORMS,
    REPOSITORY_PATTERN,
    RUNTIME_FILE,
    SHA256_PATTERN,
    archive_mtime,
    check_format,
    check_version,
    json_text,
    pe_imports,
    Record,
    require_fields,
    require_string,
    RuntimeToolError,
    sha256_file,
    write_text_atomic,
)

RUNTIME_FIELDS = ("format", "version", "supercollider", "platform", "arch", "sclang", "scsynth", "plugins", "classLibrary", "helpSource", "sha256")
DIRECTORY_FIELDS = ("plugins", "classLibrary", "helpSource")
# The form of SuperCollider's SCVersion.txt: 3.14.1, or 3.15.0-rc1 with a tweak.
SUPERCOLLIDER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-?[A-Za-z0-9_.]+)?\Z")
# One part of a runtime path: a file or folder name that does not start with a dot.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,-][A-Za-z0-9 _.+@=,-]*\Z")
RUNTIME_FILE_MAX_BYTES = 1 << 20

# Extensions of the runtime's PE files: programs, libraries, and UGen plugins.
PE_EXTENSIONS = (".exe", ".dll", ".scx")


def is_runtime_path(path: str) -> bool:
    """Tell whether a path can name a file inside a runtime: relative, '/'-separated, without empty, '.', or '..' parts.

    @param path: candidate path.
    @returns: whether every part matches NAME_PATTERN and the path is not runtime.json itself.
    """
    parts = path.split("/")
    return path != RUNTIME_FILE and all(len(part) <= NAME_MAX_LENGTH and NAME_PATTERN.match(part) is not None for part in parts)


def parse_runtime(value: Any, where: str) -> Record:
    """Validate the contents of runtime.json.

    sclang and scsynth name files at the runtime root; plugins, classLibrary,
    and helpSource name folders at the root; sha256 maps the path of every file
    of the runtime except runtime.json to its digest.

    @param value: parsed runtime.json.
    @param where: file description for error messages.
    @returns: the validated record.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    record = require_fields(value, RUNTIME_FIELDS, where)
    check_format(record, where)
    check_version(require_string(record, "version", where))
    require_string(record, "supercollider", where, SUPERCOLLIDER_PATTERN)
    if record["platform"] not in PLATFORMS or record["arch"] not in ARCHES:
        raise RuntimeToolError(f"{where}: platform {record['platform']!r} and arch {record['arch']!r} are not supported")
    names = [require_string(record, field, where, NAME_PATTERN) for field in ("sclang", "scsynth", *DIRECTORY_FIELDS)]
    if len(set(names)) != len(names) or RUNTIME_FILE in names:
        raise RuntimeToolError(f"{where}: sclang, scsynth, plugins, classLibrary, and helpSource must name five entries other than {RUNTIME_FILE}")
    digests = record["sha256"]
    if not isinstance(digests, dict):
        raise RuntimeToolError(f"{where}: sha256 must be a JSON object")
    for path, digest in digests.items():
        if not is_runtime_path(path):
            raise RuntimeToolError(f"{where}: sha256 lists {path!r}, which is not a relative path inside the runtime")
        if not isinstance(digest, str) or SHA256_PATTERN.match(digest) is None:
            raise RuntimeToolError(f"{where}: sha256.{path} is not a SHA-256 digest")
    for program in (record["sclang"], record["scsynth"]):
        if program not in digests:
            raise RuntimeToolError(f"{where}: sha256 does not list {program}")
    for field in DIRECTORY_FIELDS:
        if not any(path.startswith(record[field] + "/") for path in digests):
            raise RuntimeToolError(f"{where}: sha256 lists no file in the {field} folder {record[field]!r}")
    return record


# The lines of SuperCollider 3.14.1 that build.sh changes, by file: scsynth passes the UTF-8 folders of its plugin path
# (-U and SC_PLUGIN_PATH) and the name of its non-real-time score file to Windows through the ANSI code page, which holds
# few characters outside ASCII, so a runtime or work folder whose path holds others loads no UGens or reads no score.
# The changed lines convert through UTF-16 on Windows; on macOS and Linux, SC_Codecvt::utf8_str_to_path makes the same
# path as before, and the fopen line is Windows only.
SOURCE_PATCHES: Tuple[Tuple[str, str, str], ...] = (
    ("server/scsynth/SC_Lib_Cintf.cpp",
     "            PlugIn_LoadDir(const_cast<char*>(sp.NextToken()), true);\n",
     "            PlugIn_LoadDir(SC_Codecvt::utf8_str_to_path(sp.NextToken()), true);\n"),
    ("server/scsynth/SC_Lib_Cintf.cpp",
     "            PlugIn_LoadDir(sp.NextToken(), true);\n",
     "            PlugIn_LoadDir(SC_Codecvt::utf8_str_to_path(sp.NextToken()), true);\n"),
    ("server/scsynth/SC_World.cpp",
     '        cmdFile = fopen(inOptions->mNonRealTimeCmdFilename, "rb");\n',
     '        cmdFile = _wfopen(SC_Codecvt::utf8_cstr_to_utf16_wstring(inOptions->mNonRealTimeCmdFilename).c_str(), L"rb");\n'),
)


def patch_source(source: str) -> List[str]:
    """Change the lines of SOURCE_PATCHES in a SuperCollider source tree, once.

    A file changes only when it holds every original line of its patches exactly once; a file that holds none of them
    and every changed line already is left as it is.

    @param source: SuperCollider source directory.
    @returns: the files it changed, relative to the source directory.
    @raises RuntimeToolError: for a missing file, or one that matches neither state, such as another SuperCollider.
    """
    by_file: Dict[str, List[Tuple[str, str]]] = {}
    for name, original, changed_line in SOURCE_PATCHES:
        by_file.setdefault(name, []).append((original, changed_line))
    changed: List[str] = []
    for name, edits in by_file.items():
        path = os.path.join(source, *name.split("/"))
        try:
            with open(path, encoding="utf-8", newline="") as stream:
                text = stream.read()
        except OSError as error:
            raise RuntimeToolError(f"the source has no {name}: {error.strerror}") from error
        counts = [text.count(original) for original, _ in edits]
        expected: Dict[str, int] = {}
        for _, changed_line in edits:
            expected[changed_line] = expected.get(changed_line, 0) + 1
        if all(count == 1 for count in counts):
            for original, changed_line in edits:
                text = text.replace(original, changed_line, 1)
            with open(path, "w", encoding="utf-8", newline="") as stream:
                stream.write(text)
            changed.append(name)
        elif not any(counts) and all(text.count(line) == count for line, count in expected.items()):
            continue
        else:
            raise RuntimeToolError(f"{name} does not hold the lines that build.sh changes in SuperCollider 3.14.1")
    return changed


def supercollider_version(source: str) -> str:
    """Read the SuperCollider version of a source tree from its SCVersion.txt without running CMake.

    @param source: SuperCollider source directory.
    @returns: <major>.<minor>.<patch><tweak>, such as 3.14.1.
    @raises RuntimeToolError: when SCVersion.txt is missing or lacks a field.
    """
    path = os.path.join(source, "SCVersion.txt")
    try:
        with open(path, encoding="utf-8") as stream:
            text = stream.read()
    except OSError as error:
        raise RuntimeToolError(f"cannot read {path}: {error.strerror}; the source is not a SuperCollider source tree") from error
    numbers = {}
    for field in ("MAJOR", "MINOR", "PATCH"):
        match = re.search(rf"^set\(SC_VERSION_{field} (\d+)\)\s*$", text, re.MULTILINE)
        if match is None:
            raise RuntimeToolError(f"{path} has no integer SC_VERSION_{field}")
        numbers[field] = match.group(1)
    tweak = re.search(r'^set\(SC_VERSION_TWEAK "([A-Za-z0-9_.-]*)"\)\s*$', text, re.MULTILINE)
    if tweak is None:
        raise RuntimeToolError(f"{path} has no SC_VERSION_TWEAK")
    return f"{numbers['MAJOR']}.{numbers['MINOR']}.{numbers['PATCH']}{tweak.group(1)}"


def copy_vc_runtime(stage: str, redist: str) -> List[str]:
    """Copy the Visual C++ runtime libraries that the runtime's PE files load from Visual Studio's redistributable folder.

    The libraries go beside sclang and scsynth, where Windows looks first, so the runtime needs no Visual C++
    Redistributable installed; a copied library that loads another one of the folder brings it too.

    @param stage: runtime folder.
    @param redist: Visual Studio's x64 Microsoft.VC*.CRT folder of redistributable libraries.
    @returns: the copied file names, in the order they were copied.
    @raises RuntimeToolError: when the folder holds no library or a PE file's tables are broken.
    """
    available = {name.lower(): name for name in os.listdir(redist) if name.lower().endswith(".dll")} if os.path.isdir(redist) else {}
    if not available:
        raise RuntimeToolError(f"{redist} holds no Visual C++ runtime library")
    copied: List[str] = []
    while True:
        present = {name.lower() for name in os.listdir(stage)}
        needed = set()
        for path in pe_files(stage):
            with open(path, "rb") as stream:
                parsed = pe_imports(stream.read())
            needed.update(name.lower() for name in (parsed[1] if parsed is not None else []) if name.lower() in available and name.lower() not in present)
        if not needed:
            return copied
        for name in sorted(needed):
            shutil.copyfile(os.path.join(redist, available[name]), os.path.join(stage, available[name]))
            copied.append(available[name])


def command_supercollider_version(args: argparse.Namespace) -> None:
    """Print the SuperCollider version of a source tree on stdout.

    @param args: parsed arguments with source.
    """
    print(supercollider_version(args.source))


def command_patch_source(args: argparse.Namespace) -> None:
    """Apply SOURCE_PATCHES and print each file it changed on its own line.

    @param args: parsed arguments with source.
    """
    for name in patch_source(args.source):
        print(name)


def command_vc_runtime(args: argparse.Namespace) -> None:
    """Copy the Visual C++ runtime libraries that the runtime loads into its folder and name them on stderr.

    @param args: parsed arguments with stage and redist.
    """
    copied = copy_vc_runtime(args.stage, args.redist)
    print(f"runtime.py: copied {', '.join(copied) or 'no'} Visual C++ runtime libraries into {args.stage}", file=sys.stderr)


def command_package(args: argparse.Namespace) -> None:
    """Write runtime.json into the stage, archive the stage, and record the archive in manifest.json.

    Prints the archive path on stdout and a summary on stderr. An existing
    manifest.json in the output directory keeps its other artifacts and must
    describe the same runtime and SuperCollider versions.

    @param args: parsed arguments with stage, out, version, supercollider, platform, arch, sclang, scsynth, and repository.
    """
    check_version(args.version)
    if REPOSITORY_PATTERN.match(args.repository) is None:
        raise RuntimeToolError(f"invalid repository {args.repository!r}: use owner/name")
    files = stage_files(args.stage)
    for program in (args.sclang, args.scsynth):
        if files.get(program) != 0o755:
            raise RuntimeToolError(f"{os.path.join(args.stage, program)} is not an executable file at the root of the stage")
    record = parse_runtime({
        "format": FORMAT,
        "version": args.version,
        "supercollider": args.supercollider,
        "platform": args.platform,
        "arch": args.arch,
        "sclang": args.sclang,
        "scsynth": args.scsynth,
        "plugins": "plugins",
        "classLibrary": "SCClassLibrary",
        "helpSource": "HelpSource",
        "sha256": {name: sha256_file(os.path.join(args.stage, *name.split("/"))) for name in sorted(files)},
    }, RUNTIME_FILE)
    write_text_atomic(os.path.join(args.stage, RUNTIME_FILE), json_text(record))

    key = f"{args.platform}-{args.arch}"
    name = archive_name(args.version, key)
    archive = os.path.join(args.out, name)
    write_archive(archive, args.stage, [(path, files[path]) for path in sorted(files)] + [(RUNTIME_FILE, 0o644)], archive_mtime())
    artifact = {"url": release_url(args.repository, args.version, name), "bytes": os.path.getsize(archive), "sha256": sha256_file(archive)}

    manifest_path = os.path.join(args.out, MANIFEST_FILE)
    manifest: Record = {"format": FORMAT, "version": args.version, "supercollider": args.supercollider, "artifacts": {}}
    if os.path.exists(manifest_path):
        existing = load_manifest(manifest_path)
        check_same_release(manifest, existing, manifest_path)
        manifest["artifacts"].update(existing["artifacts"])
    manifest["artifacts"][key] = artifact
    write_text_atomic(manifest_path, manifest_text(parse_manifest(manifest, manifest_path)))
    print(f"runtime.py: {archive}: {len(files)} files, {artifact['bytes']} bytes, sha256 {artifact['sha256']}", file=sys.stderr)
    print(f"runtime.py: {manifest_path}: {key} -> {artifact['url']}", file=sys.stderr)
    print(archive)


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser.

    @returns: a parser whose subcommands store their handler as run.
    """
    parser = argparse.ArgumentParser(prog="runtime.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    version_command = commands.add_parser("supercollider-version", help="print the SuperCollider version of a source tree")
    version_command.add_argument("--source", required=True, help="SuperCollider source directory")
    version_command.set_defaults(run=command_supercollider_version)

    patch = commands.add_parser("patch-source", help="change the scsynth lines that read paths through the ANSI code page on Windows")
    patch.add_argument("--source", required=True, help="SuperCollider source directory")
    patch.set_defaults(run=command_patch_source)

    vc_runtime = commands.add_parser("vc-runtime", help="copy the Visual C++ runtime libraries that the runtime loads into it")
    vc_runtime.add_argument("--stage", required=True, help="runtime folder")
    vc_runtime.add_argument("--redist", required=True, help="Visual Studio's x64 Microsoft.VC*.CRT folder")
    vc_runtime.set_defaults(run=command_vc_runtime)

    imports = commands.add_parser("check-imports", help="check that every library a PE file loads resolves inside the runtime or to Windows")
    imports.add_argument("--stage", required=True, help="runtime folder")
    imports.add_argument("--folder", action="append", required=True, help="library folder relative to the stage, such as .; repeatable")
    imports.set_defaults(run=command_check_imports)

    package = commands.add_parser("package", help="write runtime.json, the archive, and manifest.json")
    package.add_argument("--stage", required=True, help="directory holding the runtime tree")
    package.add_argument("--out", required=True, help="directory for the archive and manifest.json")
    package.add_argument("--version", required=True, help="runtime version")
    package.add_argument("--supercollider", required=True, help="SuperCollider version of the programs")
    package.add_argument("--platform", required=True, choices=PLATFORMS, help="Node.js platform name")
    package.add_argument("--arch", required=True, choices=ARCHES, help="Node.js architecture name")
    package.add_argument("--sclang", required=True, help="sclang file name at the root of the stage")
    package.add_argument("--scsynth", required=True, help="scsynth file name at the root of the stage")
    package.add_argument("--repository", required=True, help="GitHub repository owner/name that hosts the release")
    package.set_defaults(run=command_package)

    install = commands.add_parser("install", help="install an archive into <root>/<platform>-<arch>/")
    install.add_argument("--archive", required=True, help="runtime archive")
    install.add_argument("--root", required=True, help="absolute folder of runtimes, such as the plugin package's runtime folder")
    install.add_argument("--version", required=True, help="runtime version the archive must hold")
    install.set_defaults(run=command_install)

    merge = commands.add_parser("merge", help="merge manifests of one runtime version")
    merge.add_argument("--output", required=True, help="merged manifest path")
    merge.add_argument("manifests", nargs="+", help="manifest files")
    merge.set_defaults(run=command_merge)

    verify = commands.add_parser("verify", help="check release archives against a manifest")
    verify.add_argument("--manifest", required=True, help="manifest path")
    verify.add_argument("--dir", required=True, help="directory holding the archives")
    verify.add_argument("--version", required=True, help="runtime version the manifest must list")
    verify.add_argument("--base-url", required=True, help="URL prefix of every archive URL")
    verify.set_defaults(run=command_verify)
    return parser


TOOL = shared.Tool(
    name="supercollider",
    upstream="supercollider",
    label="SuperCollider",
    upstream_pattern=SUPERCOLLIDER_PATTERN,
    runtime_file_max_bytes=RUNTIME_FILE_MAX_BYTES,
    parse_runtime=parse_runtime,
    is_runtime_path=is_runtime_path,
    gnu_format=False,
    windows_busy_hint="; stop every process that runs SuperCollider from it, then retry",
    pe_extensions=PE_EXTENSIONS,
)
archive_name = functools.partial(shared.archive_name, TOOL)
release_url = functools.partial(shared.release_url, TOOL)
parse_manifest = functools.partial(shared.parse_manifest, TOOL)
load_manifest = functools.partial(shared.load_manifest, TOOL)
manifest_text = functools.partial(shared.manifest_text, TOOL)
check_same_release = functools.partial(shared.check_same_release, TOOL)
stage_files = functools.partial(shared.stage_files, TOOL)
write_archive = functools.partial(shared.write_archive, TOOL)
read_archive = functools.partial(shared.read_archive, TOOL)
check_archive = functools.partial(shared.check_archive, TOOL)
replace_directory = functools.partial(shared.replace_directory, TOOL)
command_install = functools.partial(shared.command_install, TOOL)
command_merge = functools.partial(shared.command_merge, TOOL)
command_verify = functools.partial(shared.command_verify, TOOL)
pe_files = functools.partial(shared.pe_files, TOOL)
pe_machines = functools.partial(shared.pe_machines, TOOL)
unresolved_imports = functools.partial(shared.unresolved_imports, TOOL)
command_check_imports = functools.partial(shared.command_check_imports, TOOL)


def main(argv: Optional[List[str]] = None) -> int:
    """Run one command.

    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    return shared.run(build_parser(), argv)


if __name__ == "__main__":
    # build.sh reads printed paths through $(...), which keeps the carriage returns of
    # Windows text mode, and Windows encodes piped output in the ANSI code page.
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    sys.exit(main())
