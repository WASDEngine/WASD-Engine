#!/usr/bin/env python3
"""Install wheels into, prepare, package, install, merge, and verify WASD Engine Blender runtime archives.

build.sh runs the install-wheels, prepare, macho-files, check-binaries,
package, and install commands; the release workflow
(.github/workflows/wasd-blender.yml) runs install, merge, and verify. BUILD.md
describes the runtime layouts, runtime.json, and manifest.json. The script
needs only the standard library of Python 3.8 or newer, whatever platform the
runtime is for; install-wheels also downloads from PyPI, and check-binaries runs
otool. It writes UTF-8 with LF line ends to stdout and stderr. Every failure
prints one "runtime.py: error:" line on stderr and exits with status 1.
What it shares with the other tools' runtime scripts is in ../runtime_archive.py, which it imports.
"""

from __future__ import annotations

import argparse
import functools
import fnmatch
import io
import os
import re
import shutil
import subprocess
import sys
import urllib.request
import zipfile
from typing import Any, List, Optional, Set, Tuple

# The functions every tool's runtime script shares (../runtime_archive.py); python -I leaves this script's folder
# off sys.path, so the folder above it goes on.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runtime_archive as shared  # noqa: E402
from runtime_archive import (  # noqa: E402
    ARCHES,
    COPY_CHUNK_BYTES,
    FORMAT,
    KEEP_FILE,
    MANIFEST_FILE,
    NAME_MAX_LENGTH,
    PLATFORMS,
    REPOSITORY_PATTERN,
    RUNTIME_FILE,
    SHA256_PATTERN,
    archive_mtime,
    check_format,
    check_version,
    command_macho_files,
    json_text,
    macho_files,
    Record,
    remove_matching,
    remove_path,
    require_fields,
    require_string,
    RuntimeToolError,
    sha256_file,
    sha256_stream,
    write_text_atomic,
)

RUNTIME_FIELDS = ("format", "version", "bpy", "python", "platform", "arch", "executable", "sha256")
# The bpy package version, which is the Blender version: 5.2.3.
BPY_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\Z")
PYTHON_PATTERN = re.compile(r"^3\.[0-9]+\.[0-9]+\Z")
# One part of a runtime path: a file or folder name that does not start with a dot. Blender's camera presets also use
# '&', as in Arri_Alexa_Mini_&_SXT.py.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,#%()&-][A-Za-z0-9 _.+@=,#%()&-]*\Z")
# Names that start with a dot and still belong to the runtime: numpy keeps OpenBLAS and the Fortran runtime in
# numpy/.dylibs, from where its extension modules load them.
DOT_NAMES = (".dylibs",)
MACOS_VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}\Z")
RUNTIME_FILE_MAX_BYTES = 16 << 20
# The folder of the runtime that holds the Python installation.
PYTHON = "python"
KEEP_TEXT = (
    "WASD Engine's Blender runtime keeps this folder empty; its Python may look for it, and this file keeps it in\n"
    "archives, which hold files only.\n"
)
# What python-build-standalone's installations hold beside the program and its library that the runtime leaves out:
# C headers, manual pages, pkg-config files, and Tcl and Tk, which only tkinter loads, under macOS's lib; and on
# Windows the pip launchers of Scripts, the import libraries of libs, the windowless pythonw.exe, Tcl's data, and the
# Tcl and Tk DLLs.
UNUSED_PATHS = {
    "posix": ("include", "share", "lib/pkgconfig"),
    "windows": ("include", "libs", "Scripts", "tcl", "pythonw.exe"),
}
UNUSED_LIBRARIES = {"posix": ("itcl*", "tcl*", "tk*", "thread*", "libtcl*", "libtk*"), "windows": ("tcl*.dll", "tk*.dll")}
# Standard library parts that bpy and the worker never import: the test suite, the IDE, Tk, turtle graphics and its
# demos, and pip's installer. A runtime without Tk can open no window.
UNUSED_STDLIB = ("test", "idlelib", "tkinter", "turtledemo", "turtle.py", "ensurepip")
UNUSED_EXTENSIONS = ("_tkinter.*", ".empty")
# One line of a requirements file: a package pinned to one wheel URL and that file's SHA-256.
REQUIREMENT_PATTERN = re.compile(r"^(?P<name>[A-Za-z0-9][A-Za-z0-9._-]*) @ (?P<url>https://\S+\.whl) --hash=sha256:(?P<sha256>[0-9a-f]{64})\Z")
# The installer name that install-wheels records in each package's INSTALLER file, where pip records "pip".
INSTALLER_NAME = "wasd-engine"
# pip, which installed the packages; the runtime installs nothing.
UNUSED_SITE_PACKAGES = ("pip", "pip-*.dist-info")
# Folders of a package's own test suite, removed from every package that site-packages lists here: numpy's tests
# hold files whose names start with a dot.
TESTED_PACKAGES = ("numpy",)


def is_runtime_name(name: str) -> bool:
    """Tell whether a file or folder name can be part of a runtime path.

    @param name: one path part.
    @returns: whether the name matches NAME_PATTERN or is one of DOT_NAMES, and is at most NAME_MAX_LENGTH long.
    """
    return len(name) <= NAME_MAX_LENGTH and (NAME_PATTERN.match(name) is not None or name in DOT_NAMES)


def is_runtime_path(path: str) -> bool:
    """Tell whether a path can name a file inside a runtime: relative, '/'-separated, without empty, '.', or '..' parts.

    @param path: candidate path.
    @returns: whether every part is a runtime name and the path is not runtime.json itself.
    """
    return path != RUNTIME_FILE and all(is_runtime_name(part) for part in path.split("/"))


def parse_runtime(value: Any, where: str) -> Record:
    """Validate the contents of runtime.json.

    bpy is the version of the bpy package, which is the Blender version; python is the version of the runtime's Python;
    executable names that Python's program inside the runtime; sha256 maps the path of every file of the runtime except
    runtime.json to its digest.

    @param value: parsed runtime.json.
    @param where: file description for error messages.
    @returns: the validated record.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    record = require_fields(value, RUNTIME_FIELDS, where)
    check_format(record, where)
    check_version(require_string(record, "version", where))
    require_string(record, "bpy", where, BPY_PATTERN)
    require_string(record, "python", where, PYTHON_PATTERN)
    if record["platform"] not in PLATFORMS or record["arch"] not in ARCHES:
        raise RuntimeToolError(f"{where}: platform {record['platform']!r} and arch {record['arch']!r} are not supported")
    if not is_runtime_path(require_string(record, "executable", where)):
        raise RuntimeToolError(f"{where}: executable {record['executable']!r} is not a relative path inside the runtime")
    digests = record["sha256"]
    if not isinstance(digests, dict):
        raise RuntimeToolError(f"{where}: sha256 must be a JSON object")
    for path, digest in digests.items():
        if not is_runtime_path(path):
            raise RuntimeToolError(f"{where}: sha256 lists {path!r}, which is not a relative path inside the runtime")
        if not isinstance(digest, str) or SHA256_PATTERN.match(digest) is None:
            raise RuntimeToolError(f"{where}: sha256.{path} is not a SHA-256 digest")
    if record["executable"] not in digests:
        raise RuntimeToolError(f"{where}: sha256 does not list {record['executable']}")
    return record


def is_dropped_link(relative: str) -> bool:
    """Tell whether a symbolic link of the Python installation is one that the runtime drops.

    The installation links program aliases in bin, such as python3 to python3.13, manual pages in share, and
    pkg-config files in lib/pkgconfig; the runtime holds no links and none of these folders' aliases.

    @param relative: '/'-separated path of the link relative to the installation.
    @returns: whether the link is one of these.
    """
    parts = relative.split("/")
    return parts[0] in ("bin", "share") or parts[:2] == ["lib", "pkgconfig"]


class Layout:
    """Where a python-build-standalone installation keeps its program, standard library, and packages."""

    def __init__(self, kind: str, program: str, library: str, site_packages: str, extensions: str) -> None:
        """@param kind: posix for macOS and Linux, windows for Windows.
        @param program: the Python program, relative to the installation, such as bin/python3.13 or python.exe.
        @param library: the standard library folder, such as lib/python3.13 or Lib.
        @param site_packages: the folder of installed packages, such as lib/python3.13/site-packages or Lib/site-packages.
        @param extensions: the folder of the standard library's extension modules, lib-dynload or DLLs.
        """
        self.kind = kind
        self.program = program
        self.library = library
        self.site_packages = site_packages
        self.extensions = extensions


def installation_layout(installation: str) -> Layout:
    """Tell the layout of a Python installation: Windows's, with python.exe beside Lib and DLLs, or macOS's and
    Linux's, with bin/python3.<minor> and lib/python3.<minor>.

    @param installation: the installation folder.
    @returns: the layout, relative to the installation.
    @raises RuntimeToolError: when neither layout's program is there, or lib holds no python3.<minor> folder or more than one.
    """
    if os.path.isfile(os.path.join(installation, "python.exe")):
        return Layout("windows", "python.exe", "Lib", "Lib/site-packages", "DLLs")
    lib = os.path.join(installation, "lib")
    names = sorted(name for name in os.listdir(lib) if re.match(r"^python3\.[0-9]+\Z", name)) if os.path.isdir(lib) else []
    if len(names) != 1:
        raise RuntimeToolError(f"{lib} must hold one python3.<minor> folder, found {names}; pass a Python installation")
    program = os.path.join(installation, "bin", names[0])
    if not os.path.isfile(program) or os.path.islink(program):
        raise RuntimeToolError(f"{program} is missing; pass a python-build-standalone installation")
    return Layout("posix", f"bin/{names[0]}", f"lib/{names[0]}", f"lib/{names[0]}/site-packages", f"lib/{names[0]}/lib-dynload")


def prepare(installation: str) -> str:
    """Turn a Python installation with bpy into the runtime layout, in place, and return the bpy version.

    The installation is python-build-standalone's install_only layout for macOS or Windows. The runtime keeps the
    Python program, its library, and site-packages, and drops the program aliases and scripts in bin, headers, manual
    pages, pkg-config files, import libraries, the windowless pythonw.exe, Tcl and Tk, the unused standard library
    folders, pip, numpy's tests, and every bytecode cache. Every empty folder gets KEEP_FILE.

    @param installation: the installation folder, which holds bin and lib, or python.exe and Lib.
    @returns: the bpy version, read from the name of bpy's dist-info folder.
    @raises RuntimeToolError: when the Python program or bpy is missing, or the installation holds an unexpected link.
    """
    layout = installation_layout(installation)
    site_packages = os.path.join(installation, *layout.site_packages.split("/"))
    versions = sorted(
        name[len("bpy-"):-len(".dist-info")] for name in (os.listdir(site_packages) if os.path.isdir(site_packages) else [])
        if fnmatch.fnmatchcase(name, "bpy-*.dist-info")
    )
    if len(versions) != 1 or BPY_PATTERN.match(versions[0]) is None or not os.path.isdir(os.path.join(site_packages, "bpy")):
        raise RuntimeToolError(f"{site_packages} must hold one bpy installation, found {versions}; install bpy first")

    for directory, folders, names in os.walk(installation):
        for name in folders + names:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                if not is_dropped_link(os.path.relpath(path, installation).replace(os.sep, "/")):
                    raise RuntimeToolError(f"{path} is a link that the runtime layout does not know; update prepare for this Python build")
                os.unlink(path)
        folders[:] = [name for name in folders if os.path.isdir(os.path.join(directory, name))]

    if layout.kind == "posix":
        program = layout.program.split("/")[-1]
        for name in sorted(os.listdir(os.path.join(installation, "bin"))):
            if name != program:
                remove_path(os.path.join(installation, "bin", name))
        remove_matching(os.path.join(installation, "lib"), UNUSED_LIBRARIES["posix"])
    else:
        remove_matching(os.path.join(installation, "DLLs"), UNUSED_LIBRARIES["windows"])
    for relative in UNUSED_PATHS[layout.kind]:
        remove_path(os.path.join(installation, *relative.split("/")))
    remove_matching(os.path.join(installation, *layout.library.split("/")), UNUSED_STDLIB)
    remove_matching(os.path.join(installation, *layout.extensions.split("/")), UNUSED_EXTENSIONS)
    remove_matching(site_packages, UNUSED_SITE_PACKAGES)
    for package in TESTED_PACKAGES:
        for directory, folders, _ in os.walk(os.path.join(site_packages, package)):
            for name in [name for name in folders if name == "tests"]:
                shutil.rmtree(os.path.join(directory, name))
            folders[:] = [name for name in folders if name != "tests"]
    for directory, folders, names in os.walk(installation):
        for name in [name for name in folders if name == "__pycache__"]:
            shutil.rmtree(os.path.join(directory, name))
        folders[:] = [name for name in folders if name != "__pycache__"]
        for name in names:
            if name.endswith((".pyc", ".pyo")):
                os.unlink(os.path.join(directory, name))
    for directory, folders, names in os.walk(installation):
        if not folders and not names:
            write_text_atomic(os.path.join(directory, KEEP_FILE), KEEP_TEXT)
    return versions[0]


def read_requirements(path: str) -> List[Tuple[str, str, str]]:
    """Read a requirements file that pins every package to one wheel URL and its SHA-256.

    @param path: requirements file; blank lines and lines that start with # are comments.
    @returns: (name, url, sha256) of every line, in file order.
    @raises RuntimeToolError: when the file is unreadable, a line is not `<name> @ <https URL of a .whl> --hash=sha256:<digest>`,
        or two lines name the same package or wheel.
    """
    try:
        with open(path, encoding="utf-8") as stream:
            lines = stream.read().splitlines()
    except OSError as error:
        raise RuntimeToolError(f"cannot read {path}: {error.strerror}") from error
    pins: List[Tuple[str, str, str]] = []
    for number, line in enumerate(lines, start=1):
        if line.strip() == "" or line.startswith("#"):
            continue
        match = REQUIREMENT_PATTERN.match(line)
        if match is None:
            raise RuntimeToolError(f"{path}:{number}: expected '<name> @ <https URL of a .whl> --hash=sha256:<digest>', found {line!r}")
        pins.append((match.group("name"), match.group("url"), match.group("sha256")))
    for index, key in ((0, "package"), (1, "wheel")):
        seen = [pin[index].lower().replace("_", "-") if index == 0 else wheel_file_name(pin[1]) for pin in pins]
        repeated = sorted({value for value in seen if seen.count(value) > 1})
        if repeated:
            raise RuntimeToolError(f"{path} names the {key} {repeated[0]} more than once")
    return pins


def wheel_file_name(url: str) -> str:
    """Return the file name of a wheel URL, which names the wheel in a cache folder.

    @param url: https URL ending in .whl.
    @returns: the last path segment.
    """
    return url.rsplit("/", 1)[-1]


def fetch_wheel(url: str, sha256: str, cache: str) -> str:
    """Return a wheel from the cache folder, downloading it when it is missing or does not match its digest.

    @param url: the wheel's https URL.
    @param sha256: the digest the file must have.
    @param cache: folder that keeps downloaded wheels.
    @returns: the wheel's path in the cache.
    @raises RuntimeToolError: when the download fails or its bytes do not match the digest.
    """
    os.makedirs(cache, exist_ok=True)
    path = os.path.join(cache, wheel_file_name(url))
    if os.path.isfile(path) and sha256_file(path) == sha256:
        return path
    partial = f"{path}.partial"
    try:
        with urllib.request.urlopen(url, timeout=60) as response, open(partial, "wb") as sink:
            actual = sha256_stream(response, sink)
    except OSError as error:
        remove_path(partial)
        raise RuntimeToolError(f"cannot download {url}: {error}") from error
    if actual != sha256:
        remove_path(partial)
        raise RuntimeToolError(f"{url} has SHA-256 {actual}, not the pinned {sha256}")
    os.replace(partial, path)
    return path


def wheel_destination(member: str, data_prefix: str) -> Optional[str]:
    """Map one wheel member to its path in site-packages, following the binary distribution format.

    Files under <name>-<version>.data/purelib and platlib go to site-packages itself; the console scripts under
    .data/scripts are left out, because the runtime runs only its Python.

    @param member: '/'-separated member name.
    @param data_prefix: the wheel's .data folder name followed by '/'.
    @returns: the '/'-separated destination relative to site-packages, or None for a member the runtime leaves out.
    @raises RuntimeToolError: when the member's path leaves site-packages, or it is a .data category the runtime cannot hold.
    """
    parts = member.split("/")
    if member.startswith("/") or "\\" in member or ":" in parts[0] or any(part in ("", ".", "..") for part in parts):
        raise RuntimeToolError(f"wheel member {member!r} is not a relative path inside site-packages")
    if not member.startswith(data_prefix):
        return member
    category, rest = parts[1], "/".join(parts[2:])
    if category in ("purelib", "platlib"):
        return rest
    if category == "scripts":
        return None
    raise RuntimeToolError(f"wheel member {member!r} is in the .data category {category!r}, which the runtime does not install")


def install_wheel(wheel: str, site_packages: str) -> str:
    """Unpack one wheel into site-packages and record wasd-engine as its installer.

    @param wheel: the wheel file.
    @param site_packages: the folder of installed packages.
    @returns: the name of the wheel's .dist-info folder.
    @raises RuntimeToolError: when the wheel is unreadable, has no single .dist-info folder, holds an unsafe member, or
        would replace a file that an earlier wheel installed.
    """
    try:
        archive = zipfile.ZipFile(wheel)
    except (OSError, zipfile.BadZipFile) as error:
        raise RuntimeToolError(f"cannot read wheel {wheel}: {error}") from error
    with archive:
        members = [info for info in archive.infolist() if not info.is_dir()]
        infos = sorted({info.filename.split("/")[0] for info in members if info.filename.split("/")[0].endswith(".dist-info")})
        if len(infos) != 1:
            raise RuntimeToolError(f"wheel {wheel} must hold one .dist-info folder, found {infos}")
        data_prefix = infos[0][:-len(".dist-info")] + ".data/"
        for info in members:
            relative = wheel_destination(info.filename, data_prefix)
            if relative is None:
                continue
            destination = os.path.join(site_packages, *relative.split("/"))
            os.makedirs(os.path.dirname(destination), exist_ok=True)
            try:
                with archive.open(info) as source, open(destination, "xb") as sink:
                    shutil.copyfileobj(source, sink, COPY_CHUNK_BYTES)
            except FileExistsError as error:
                raise RuntimeToolError(f"wheel {wheel} would replace {relative}, which an earlier wheel installed") from error
            os.chmod(destination, 0o755 if (info.external_attr >> 16) & 0o111 else 0o644)
    write_text_atomic(os.path.join(site_packages, infos[0], "INSTALLER"), INSTALLER_NAME + "\n")
    return infos[0]


def otool(arguments: List[str]) -> List[str]:
    """Run otool for the arm64 slice of a file and return its output lines after the first, which names the file.

    @param arguments: otool arguments ending with the file.
    @returns: the remaining output lines.
    @raises RuntimeToolError: when otool fails.
    """
    result = subprocess.run(["otool", "-arch", "arm64", *arguments], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeToolError(f"otool {' '.join(arguments)} failed: {result.stderr.strip()}")
    return result.stdout.splitlines()[1:]


class Binary:
    """The facts check-binaries reads from one Mach-O file: its install names, rpath folders, the libraries it loads, and its minimum macOS."""

    def __init__(self, path: str, names: List[str], rpaths: List[str], libraries: List[str], minimum: Optional[str]) -> None:
        """@param path: the file.
        @param names: its own install names; empty for a program or a module without one.
        @param rpaths: its LC_RPATH entries, with @loader_path and @executable_path expanded.
        @param libraries: the install names of the libraries it loads, without its own.
        @param minimum: the minimum macOS version of its LC_BUILD_VERSION or LC_VERSION_MIN_MACOSX command, or None.
        """
        self.path = path
        self.names = names
        self.rpaths = rpaths
        self.libraries = libraries
        self.minimum = minimum


def read_binary(runtime: str, path: str) -> Binary:
    """Read the load commands of one Mach-O file of a runtime.

    @loader_path is the file's folder and @executable_path is the folder of the runtime's Python program, which loads
    every library of the runtime.

    @param runtime: the runtime folder.
    @param path: Mach-O file inside it.
    @returns: the file's rpaths, libraries, and minimum macOS.
    """
    folder = os.path.dirname(path)
    executables = os.path.join(runtime, PYTHON, "bin")

    def expand(name: str) -> str:
        if name.startswith("@loader_path"):
            return os.path.normpath(os.path.join(folder, name[len("@loader_path"):].lstrip("/")))
        if name.startswith("@executable_path"):
            return os.path.normpath(os.path.join(executables, name[len("@executable_path"):].lstrip("/")))
        return name

    lines = otool(["-l", path])
    rpaths: List[str] = []
    minimum = None
    for index, line in enumerate(lines):
        command = line.strip()
        if command == "cmd LC_RPATH":
            rpaths.append(expand(lines[index + 2].split()[1]))
        elif command in ("cmd LC_BUILD_VERSION", "cmd LC_VERSION_MIN_MACOSX") and minimum is None:
            for detail in lines[index + 1:index + 5]:
                field = detail.split()
                if len(field) == 2 and field[0] in ("minos", "version"):
                    minimum = field[1]
                    break
    # A library's own install name, which otool -L lists first, is not a library it loads.
    own = [line.strip() for line in otool(["-D", path]) if line.strip() != ""]
    libraries = [line.strip().split(" (")[0] for line in otool(["-L", path])]
    return Binary(path, own, rpaths, [name for name in libraries if name not in own], minimum)


def version_key(version: str) -> Tuple[int, ...]:
    """Turn a macOS version such as 11.2 into a comparable tuple of three numbers.

    @param version: dotted version with one to three numbers.
    @returns: the numbers, padded with zeros.
    """
    numbers = [int(part) for part in version.split(".")]
    return tuple(numbers + [0] * (3 - len(numbers)))


def binary_problems(runtime: str, binaries: List[Binary], minimum_macos: str) -> List[str]:
    """List the libraries that resolve to no plain file inside the runtime or the system, and the files that need a newer macOS.

    An @rpath name resolves through the file's own rpath folders and the rpath folders inside the runtime of every
    other file, or names the install name of another file of the runtime, because a library that a program or module
    loaded earlier, such as bpy's libraries or the core module that MaterialX's package imports first, satisfies a
    later load of its install name. @loader_path and @executable_path names resolve as read_binary expands them.

    @param runtime: the runtime folder.
    @param binaries: every Mach-O file of the runtime.
    @param minimum_macos: the oldest macOS that the runtime must run on.
    @returns: one description per problem, naming the file relative to the runtime.
    """
    inside = os.path.realpath(runtime) + os.sep

    def is_inside(path: str) -> bool:
        return os.path.realpath(path).startswith(inside)

    shared: Set[str] = {rpath for binary in binaries for rpath in binary.rpaths if is_inside(rpath)}
    provided: Set[str] = {name for binary in binaries for name in binary.names}
    problems = []
    for binary in binaries:
        relative = os.path.relpath(binary.path, runtime)
        folder = os.path.dirname(binary.path)
        executables = os.path.join(runtime, PYTHON, "bin")
        for name in binary.libraries:
            if name.startswith("/usr/lib/") or name.startswith("/System/Library/") or (name.startswith("@rpath/") and name in provided):
                continue
            if name.startswith("@rpath/"):
                candidates = [os.path.join(rpath, name[len("@rpath/"):]) for rpath in [*binary.rpaths, *sorted(shared)]]
            elif name.startswith("@loader_path/"):
                candidates = [os.path.join(folder, name[len("@loader_path/"):])]
            elif name.startswith("@executable_path/"):
                candidates = [os.path.join(executables, name[len("@executable_path/"):])]
            else:
                candidates = []
            if not any(os.path.isfile(path) and not os.path.islink(path) and is_inside(path) for path in candidates):
                problems.append(f"{relative} loads {name}, which is not in the runtime")
        if binary.minimum is not None and version_key(binary.minimum) > version_key(minimum_macos):
            problems.append(f"{relative} needs macOS {binary.minimum}, newer than {minimum_macos}")
    return problems


def command_install_wheels(args: argparse.Namespace) -> None:
    """Install the wheels that a requirements file pins into site-packages, downloading each into the cache first.

    @param args: parsed arguments with requirements, cache, and site_packages.
    """
    pins = read_requirements(args.requirements)
    if not os.path.isdir(args.site_packages):
        raise RuntimeToolError(f"{args.site_packages} is not a folder; pass the site-packages folder of a Python installation")
    for _, url, sha256 in pins:
        install_wheel(fetch_wheel(url, sha256, args.cache), args.site_packages)
    print(f"runtime.py: installed {len(pins)} wheels into {args.site_packages}", file=sys.stderr)


def command_prepare(args: argparse.Namespace) -> None:
    """Turn a Python installation with bpy into the runtime layout and print the bpy version on stdout.

    @param args: parsed arguments with installation.
    """
    print(prepare(args.installation))


def command_check_binaries(args: argparse.Namespace) -> None:
    """Require every library that a Mach-O file of the runtime loads to resolve inside the runtime or the system, and
    every Mach-O file to run on the oldest macOS that the Desktop app supports.

    @param args: parsed arguments with runtime and minimum_macos.
    """
    if MACOS_VERSION_PATTERN.match(args.minimum_macos) is None:
        raise RuntimeToolError(f"invalid --minimum-macos {args.minimum_macos!r}: use a version such as 13.0")
    binaries = [read_binary(args.runtime, path) for path in macho_files(args.runtime)]
    problems = binary_problems(args.runtime, binaries, args.minimum_macos)
    if problems:
        raise RuntimeToolError(f"{len(problems)} problems in the runtime's Mach-O files: {'; '.join(problems[:5])}")
    print(
        f"runtime.py: the libraries of {len(binaries)} Mach-O files resolve inside the runtime or the system, "
        f"and all run on macOS {args.minimum_macos}",
        file=sys.stderr,
    )


def command_package(args: argparse.Namespace) -> None:
    """Write runtime.json into the stage, archive the stage, and record the archive in manifest.json.

    Prints the archive path on stdout and a summary on stderr. An existing
    manifest.json in the output directory keeps its other artifacts and must
    describe the same runtime and bpy versions.

    @param args: parsed arguments with stage, out, version, bpy, python, platform, arch, executable, and repository.
    """
    check_version(args.version)
    if REPOSITORY_PATTERN.match(args.repository) is None:
        raise RuntimeToolError(f"invalid repository {args.repository!r}: use owner/name")
    files = stage_files(args.stage)
    if files.get(args.executable) != 0o755:
        raise RuntimeToolError(f"{os.path.join(args.stage, args.executable)} is not an executable file in the stage")
    record = parse_runtime({
        "format": FORMAT,
        "version": args.version,
        "bpy": args.bpy,
        "python": args.python,
        "platform": args.platform,
        "arch": args.arch,
        "executable": args.executable,
        "sha256": {name: sha256_file(os.path.join(args.stage, *name.split("/"))) for name in sorted(files)},
    }, RUNTIME_FILE)
    write_text_atomic(os.path.join(args.stage, RUNTIME_FILE), json_text(record))

    key = f"{args.platform}-{args.arch}"
    name = archive_name(args.version, key)
    archive = os.path.join(args.out, name)
    write_archive(archive, args.stage, [(path, files[path]) for path in sorted(files)] + [(RUNTIME_FILE, 0o644)], archive_mtime())
    artifact = {"url": release_url(args.repository, args.version, name), "bytes": os.path.getsize(archive), "sha256": sha256_file(archive)}

    manifest_path = os.path.join(args.out, MANIFEST_FILE)
    manifest: Record = {"format": FORMAT, "version": args.version, "bpy": args.bpy, "artifacts": {}}
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

    wheels = commands.add_parser("install-wheels", help="install the wheels that a requirements file pins into site-packages")
    wheels.add_argument("--requirements", required=True, help="requirements file pinning each package to one wheel URL and SHA-256")
    wheels.add_argument("--cache", required=True, help="folder that keeps downloaded wheels between builds")
    wheels.add_argument("--site-packages", required=True, help="site-packages folder of the Python installation")
    wheels.set_defaults(run=command_install_wheels)

    prepare_command = commands.add_parser("prepare", help="turn a Python installation with bpy into the runtime layout")
    prepare_command.add_argument("--installation", required=True, help="python-build-standalone installation for macOS or Windows with bpy installed")
    prepare_command.set_defaults(run=command_prepare)

    macho = commands.add_parser("macho-files", help="print the Mach-O files of a staged runtime, NUL-separated")
    macho.add_argument("--stage", required=True, help="runtime folder")
    macho.set_defaults(run=command_macho_files)

    binaries = commands.add_parser("check-binaries", help="check the libraries and minimum macOS of every Mach-O file")
    binaries.add_argument("--runtime", required=True, help="runtime folder")
    binaries.add_argument("--minimum-macos", required=True, help="oldest macOS the runtime must run on, such as 13.0")
    binaries.set_defaults(run=command_check_binaries)

    package = commands.add_parser("package", help="write runtime.json, the archive, and manifest.json")
    package.add_argument("--stage", required=True, help="directory holding the runtime tree")
    package.add_argument("--out", required=True, help="directory for the archive and manifest.json")
    package.add_argument("--version", required=True, help="runtime version")
    package.add_argument("--bpy", required=True, help="version of the bpy package")
    package.add_argument("--python", required=True, help="version of the runtime's Python")
    package.add_argument("--platform", required=True, choices=PLATFORMS, help="Node.js platform name")
    package.add_argument("--arch", required=True, choices=ARCHES, help="Node.js architecture name")
    package.add_argument("--executable", required=True, help="path of the Python program relative to the stage")
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
    name="blender",
    upstream="bpy",
    label="bpy",
    upstream_pattern=BPY_PATTERN,
    runtime_file_max_bytes=RUNTIME_FILE_MAX_BYTES,
    parse_runtime=parse_runtime,
    is_runtime_path=is_runtime_path,
    gnu_format=True,
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


def main(argv: Optional[List[str]] = None) -> int:
    """Run one command.

    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    return shared.run(build_parser(), argv)


if __name__ == "__main__":
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    sys.exit(main())
