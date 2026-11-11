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
"""

from __future__ import annotations

import argparse
import fnmatch
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
import zipfile
from typing import IO, Any, Dict, List, Optional, Set, Tuple

RUNTIME_FILE = "runtime.json"
MANIFEST_FILE = "manifest.json"
PLATFORMS = ("darwin", "linux", "win32")
ARCHES = ("arm64", "x64")
# The Blender plugin (packages/gamedev/blender/src/environment.ts) and Desktop packaging
# (apps/desktop/scripts/wasdengine-blender.ts) read both files; FORMAT changes only with them.
FORMAT = 1
RUNTIME_FIELDS = ("format", "version", "bpy", "python", "platform", "arch", "executable", "sha256")
MANIFEST_FIELDS = ("format", "version", "bpy", "artifacts")
ARTIFACT_FIELDS = ("url", "bytes", "sha256")
# The patterns end in \Z, which rejects a trailing newline that $ accepts.
# The version names files, a URL path segment, and the Git tag blender-<version>.
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
# The bpy package version, which is the Blender version: 5.2.3.
BPY_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+\Z")
PYTHON_PATTERN = re.compile(r"^3\.[0-9]+\.[0-9]+\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
# One part of a runtime path: a file or folder name that does not start with a dot. Blender's camera presets also use
# '&', as in Arri_Alexa_Mini_&_SXT.py.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,#%()&-][A-Za-z0-9 _.+@=,#%()&-]*\Z")
# Names that start with a dot and still belong to the runtime: numpy keeps OpenBLAS and the Fortran runtime in
# numpy/.dylibs, from where its extension modules load them.
DOT_NAMES = (".dylibs",)
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
ARTIFACT_KEY_PATTERN = re.compile(r"^(?:darwin|linux|win32)-(?:arm64|x64)\Z")
MACOS_VERSION_PATTERN = re.compile(r"^[0-9]+(?:\.[0-9]+){0,2}\Z")
COPY_CHUNK_BYTES = 1 << 20
RUNTIME_FILE_MAX_BYTES = 16 << 20
NAME_MAX_LENGTH = 200
MACH_O_MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce")
# The folder of the runtime that holds the Python installation.
PYTHON = "python"
# The file that keeps an otherwise empty folder in archives, which hold plain files only.
KEEP_FILE = "wasd-engine-folder.txt"
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

Record = Dict[str, Any]


class RuntimeToolError(Exception):
    """A failure reported as one error line and exit status 1."""


def check_version(version: str) -> None:
    """Reject a runtime version that cannot name an archive, a URL path segment, and a Git tag.

    @param version: runtime version such as 5.2.3-wasd.1.
    @raises RuntimeToolError: when the version has other characters or a ".." sequence.
    """
    if VERSION_PATTERN.match(version) is None or ".." in version:
        raise RuntimeToolError(
            f"invalid runtime version {version!r}: use letters, digits, '.', '_', '+', and '-', "
            "starting with a letter or digit, without '..'"
        )


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


def check_format(record: Record, where: str) -> None:
    """Require the file format this script, the plugin, and Desktop packaging share.

    @param record: parsed runtime.json or manifest.json object.
    @param where: file description for error messages.
    @raises RuntimeToolError: when the format is not FORMAT.
    """
    value = record["format"]
    if isinstance(value, bool) or value != FORMAT:
        raise RuntimeToolError(f"{where}: format must be {FORMAT}, found {value!r}")


def archive_name(version: str, key: str) -> str:
    """Return the archive file name of one platform.

    @param version: runtime version.
    @param key: artifact key <platform>-<arch>, with Node.js platform and architecture names.
    @returns: blender-<version>-<key>.tar.gz.
    """
    return f"blender-{version}-{key}.tar.gz"


def release_url(repository: str, version: str, file_name: str) -> str:
    """Return the download URL of a file attached to the GitHub release blender-<version>.

    @param repository: GitHub repository as owner/name.
    @param version: runtime version.
    @param file_name: release asset name.
    @returns: https://github.com/<repository>/releases/download/blender-<version>/<file_name>.
    """
    return f"https://github.com/{repository}/releases/download/blender-{version}/{file_name}"


def sha256_stream(stream: IO[bytes], sink: Optional[IO[bytes]] = None) -> str:
    """Hash a byte stream to its end, copying every byte to sink when one is given.

    @param stream: readable binary stream.
    @param sink: optional writable binary stream.
    @returns: lowercase hexadecimal SHA-256 digest.
    """
    digest = hashlib.sha256()
    for chunk in iter(lambda: stream.read(COPY_CHUNK_BYTES), b""):
        digest.update(chunk)
        if sink is not None:
            sink.write(chunk)
    return digest.hexdigest()


def sha256_file(path: str) -> str:
    """Hash one file.

    @param path: file path.
    @returns: lowercase hexadecimal SHA-256 digest of the file's bytes.
    """
    with open(path, "rb") as stream:
        return sha256_stream(stream)


def json_text(value: Record) -> str:
    """Serialize a record as this tool stores JSON files: two-space indentation and one trailing newline.

    @param value: JSON-compatible record.
    @returns: the serialized text.
    """
    return json.dumps(value, indent=2) + "\n"


def write_text_atomic(path: str, text: str) -> None:
    """Write a UTF-8 text file with mode 0644 through a temporary sibling and a rename.

    @param path: destination path; its directory must exist.
    @param text: complete file contents.
    """
    handle, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(handle, "w", encoding="utf-8", newline="\n") as stream:
            stream.write(text)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def read_json(path: str) -> Any:
    """Read one JSON file.

    @param path: file path.
    @returns: the parsed value.
    @raises RuntimeToolError: when the file is missing, unreadable, or not JSON.
    """
    try:
        with open(path, encoding="utf-8") as stream:
            return json.load(stream)
    except OSError as error:
        raise RuntimeToolError(f"cannot read {path}: {error.strerror}") from error
    except ValueError as error:
        raise RuntimeToolError(f"{path} is not valid JSON: {error}") from error


def require_fields(value: Any, fields: Tuple[str, ...], where: str) -> Record:
    """Require a JSON object with exactly the given fields.

    @param value: parsed JSON value.
    @param fields: field names the object must have, and no others.
    @param where: description of the value for error messages.
    @returns: the object.
    @raises RuntimeToolError: when the value is not an object or its fields differ.
    """
    if not isinstance(value, dict):
        raise RuntimeToolError(f"{where} must be a JSON object")
    missing = [field for field in fields if field not in value]
    unknown = sorted(field for field in value if field not in fields)
    if missing or unknown:
        details = (["missing " + ", ".join(missing)] if missing else []) + (["unknown " + ", ".join(unknown)] if unknown else [])
        raise RuntimeToolError(f"{where} has unexpected fields ({'; '.join(details)})")
    return value


def require_string(record: Record, field: str, where: str, pattern: Optional[re.Pattern[str]] = None) -> str:
    """Require a non-empty string field, optionally matching a pattern.

    @param record: JSON object.
    @param field: field name.
    @param where: description of the object for error messages.
    @param pattern: optional regular expression the value must match from its start.
    @returns: the string.
    @raises RuntimeToolError: when the field is not a non-empty string or does not match.
    """
    value = record[field]
    if not isinstance(value, str) or value == "" or (pattern is not None and pattern.match(value) is None):
        raise RuntimeToolError(f"{where}: {field} is {value!r}, which is not valid")
    return value


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


def parse_manifest(value: Any, where: str) -> Record:
    """Validate the contents of manifest.json.

    @param value: parsed manifest.json.
    @param where: file description for error messages.
    @returns: the validated manifest.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    manifest = require_fields(value, MANIFEST_FIELDS, where)
    check_format(manifest, where)
    check_version(require_string(manifest, "version", where))
    require_string(manifest, "bpy", where, BPY_PATTERN)
    if not isinstance(manifest["artifacts"], dict):
        raise RuntimeToolError(f"{where}: artifacts must be a JSON object")
    for key, entry in manifest["artifacts"].items():
        if ARTIFACT_KEY_PATTERN.match(key) is None:
            raise RuntimeToolError(f"{where}: artifact key {key!r} is not <platform>-<arch>")
        artifact = require_fields(entry, ARTIFACT_FIELDS, f"{where}: artifacts.{key}")
        if not require_string(artifact, "url", f"{where}: artifacts.{key}").startswith("https://"):
            raise RuntimeToolError(f"{where}: artifacts.{key}.url must be an https URL")
        size = artifact["bytes"]
        if isinstance(size, bool) or not isinstance(size, int) or size <= 0:
            raise RuntimeToolError(f"{where}: artifacts.{key}.bytes must be a positive integer")
        require_string(artifact, "sha256", f"{where}: artifacts.{key}", SHA256_PATTERN)
    return manifest


def load_manifest(path: str) -> Record:
    """Read and validate a manifest.json file.

    @param path: file path.
    @returns: the validated manifest.
    @raises RuntimeToolError: when the file cannot be read or is invalid.
    """
    return parse_manifest(read_json(path), path)


def manifest_text(manifest: Record) -> str:
    """Serialize a manifest with its artifacts sorted by key.

    @param manifest: validated manifest.
    @returns: the serialized text.
    """
    artifacts = manifest["artifacts"]
    return json_text({
        "format": FORMAT,
        "version": manifest["version"],
        "bpy": manifest["bpy"],
        "artifacts": {key: artifacts[key] for key in sorted(artifacts)},
    })


def check_same_release(base: Record, other: Record, where: str) -> None:
    """Require two manifests to describe the same runtime version and bpy version.

    @param base: manifest being extended.
    @param other: manifest merged into it.
    @param where: description of other for error messages.
    @raises RuntimeToolError: when either version differs.
    """
    for field in ("version", "bpy"):
        if base[field] != other[field]:
            raise RuntimeToolError(
                f"{where} has {field} {other[field]!r}, not {base[field]!r}; "
                "one manifest holds the archives of one runtime version built from one bpy version"
            )


def remove_path(path: str) -> None:
    """Delete a file, a link, or a folder with its contents; a missing path is not an error.

    @param path: path to delete.
    """
    if os.path.islink(path) or os.path.isfile(path):
        os.unlink(path)
    elif os.path.isdir(path):
        shutil.rmtree(path)


def remove_matching(directory: str, patterns: Tuple[str, ...]) -> None:
    """Delete the entries of one folder whose names match any of the patterns.

    @param directory: folder; a missing folder has no entries.
    @param patterns: fnmatch patterns of entry names.
    """
    if not os.path.isdir(directory):
        return
    for name in sorted(os.listdir(directory)):
        if any(fnmatch.fnmatchcase(name, pattern) for pattern in patterns):
            remove_path(os.path.join(directory, name))


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


def macho_files(stage: str) -> List[str]:
    """List the Mach-O files of a staged runtime.

    @param stage: runtime folder.
    @returns: absolute paths, sorted.
    """
    found = []
    for directory, _, names in os.walk(stage):
        for name in names:
            path = os.path.join(directory, name)
            if os.path.isfile(path) and not os.path.islink(path):
                with open(path, "rb") as stream:
                    if stream.read(4) in MACH_O_MAGICS:
                        found.append(path)
    return sorted(found)


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


def archive_mtime() -> int:
    """Return the modification time stored in archives: SOURCE_DATE_EPOCH when set, otherwise now.

    @returns: seconds since the epoch.
    @raises RuntimeToolError: when SOURCE_DATE_EPOCH is set but is not a non-negative integer.
    """
    value = os.environ.get("SOURCE_DATE_EPOCH", "")
    if value == "":
        return int(time.time())
    if not value.isdigit():
        raise RuntimeToolError(f"SOURCE_DATE_EPOCH is {value!r}, not a non-negative integer")
    return int(value)


def stage_files(stage: str) -> Dict[str, int]:
    """List the files of a staged runtime with their archive modes.

    @param stage: directory holding the runtime tree.
    @returns: the relative path of every file except runtime.json, mapped to 0755 for a file with an execute bit and 0644 otherwise.
    @raises RuntimeToolError: when the stage holds a link or another non-file entry, or a name the runtime cannot hold.
    """
    files: Dict[str, int] = {}
    for directory, folders, names in os.walk(stage):
        for name in folders + names:
            full = os.path.join(directory, name)
            relative = os.path.relpath(full, stage).replace(os.sep, "/")
            mode = os.lstat(full).st_mode
            if stat.S_ISLNK(mode) or not (stat.S_ISDIR(mode) or stat.S_ISREG(mode)):
                raise RuntimeToolError(f"{full} is not a plain file or folder; a runtime holds no links")
            if relative == RUNTIME_FILE:
                continue
            if not is_runtime_path(relative):
                raise RuntimeToolError(f"{full}: {relative!r} cannot name a file inside a runtime")
            if stat.S_ISREG(mode):
                files[relative] = 0o755 if mode & 0o111 else 0o644
    return files


def write_archive(path: str, directory: str, files: List[Tuple[str, int]], mtime: int) -> None:
    """Write a gzip-compressed archive of files at their relative paths, through a temporary sibling.

    Entries are plain files only; extraction creates their folders. They carry
    the given modes, owner 0:0 without names, and one modification time, so
    equal files and mtime produce equal archive bytes. GNU format allows paths
    longer than ustar's 100-byte names.

    @param path: archive path.
    @param directory: directory holding the files.
    @param files: relative '/'-separated paths with their permission modes, in archive order.
    @param mtime: modification time of every entry and of the gzip header.
    """
    handle, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(handle, "wb") as raw, \
                gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=mtime) as compressed, \
                tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT) as archive:
            for name, mode in files:
                source = os.path.join(directory, *name.split("/"))
                entry = tarfile.TarInfo(name)
                entry.size = os.path.getsize(source)
                entry.mode = mode
                entry.mtime = mtime
                entry.uid = entry.gid = 0
                entry.uname = entry.gname = ""
                with open(source, "rb") as stream:
                    archive.addfile(entry, stream)
        os.chmod(temporary, 0o644)
        os.replace(temporary, path)
    except BaseException:
        if os.path.exists(temporary):
            os.unlink(temporary)
        raise


def extract_entry(directory: str, entry: tarfile.TarInfo, stream: IO[bytes]) -> str:
    """Create one file exclusively from an archive entry, with its folders, and mode 0755 or 0644 following the entry's execute bit.

    @param directory: destination directory.
    @param entry: archive entry with a validated relative name.
    @param stream: the entry's bytes.
    @returns: lowercase hexadecimal SHA-256 digest of the written bytes.
    """
    destination = os.path.join(directory, *entry.name.split("/"))
    os.makedirs(os.path.dirname(destination), mode=0o755, exist_ok=True)
    with open(destination, "xb") as sink:
        digest = sha256_stream(stream, sink)
    os.chmod(destination, 0o755 if entry.mode & 0o111 else 0o644)
    return digest


def read_archive(path: str, directory: Optional[str] = None) -> Tuple[Record, Dict[str, str]]:
    """Read a runtime archive, hashing every file and optionally extracting the files.

    @param path: archive path.
    @param directory: existing empty directory that receives the files, or None to only read them.
    @returns: the validated runtime.json record and the SHA-256 digest of every entry by path.
    @raises RuntimeToolError: when an entry is not a plain file at a relative
        path inside the runtime, a path repeats, or runtime.json is missing, too large, or invalid.
    """
    digests: Dict[str, str] = {}
    runtime_bytes: Optional[bytes] = None
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for entry in archive:
                if not entry.isfile() or not (entry.name == RUNTIME_FILE or is_runtime_path(entry.name)) or entry.name in digests:
                    raise RuntimeToolError(f"{path}: entry {entry.name!r} is not a uniquely named plain file inside the runtime")
                if entry.name == RUNTIME_FILE and entry.size > RUNTIME_FILE_MAX_BYTES:
                    raise RuntimeToolError(f"{path}: {RUNTIME_FILE} is larger than {RUNTIME_FILE_MAX_BYTES} bytes")
                member = archive.extractfile(entry)
                if member is None:
                    raise RuntimeToolError(f"{path}: entry {entry.name!r} has no data")
                with member:
                    stream: IO[bytes] = member
                    if entry.name == RUNTIME_FILE:
                        runtime_bytes = member.read()
                        stream = io.BytesIO(runtime_bytes)
                    digests[entry.name] = sha256_stream(stream) if directory is None else extract_entry(directory, entry, stream)
    except (OSError, tarfile.TarError, EOFError) as error:
        raise RuntimeToolError(f"cannot read archive {path}: {error}") from error
    if runtime_bytes is None:
        raise RuntimeToolError(f"{path} has no {RUNTIME_FILE}")
    try:
        value = json.loads(runtime_bytes.decode("utf-8"))
    except ValueError as error:
        raise RuntimeToolError(f"{path}: {RUNTIME_FILE} is not valid JSON: {error}") from error
    return parse_runtime(value, f"{path}: {RUNTIME_FILE}"), digests


def check_archive(path: str, record: Record, digests: Dict[str, str], version: str, key: Optional[str]) -> None:
    """Require an archive's files to match its runtime.json exactly.

    @param path: archive path for error messages.
    @param record: validated runtime.json record.
    @param digests: SHA-256 digest of every archive entry by path.
    @param version: runtime version the archive must hold.
    @param key: artifact key <platform>-<arch> the archive must hold, or None to accept any.
    @raises RuntimeToolError: on a version, platform, file set, or digest mismatch.
    """
    if record["version"] != version:
        raise RuntimeToolError(f"{path} holds runtime {record['version']!r}, not {version!r}")
    if key is not None and f"{record['platform']}-{record['arch']}" != key:
        raise RuntimeToolError(f"{path} holds the {record['platform']}-{record['arch']} runtime, not {key}")
    listed = set(record["sha256"])
    held = set(digests) - {RUNTIME_FILE}
    if held != listed:
        extra, missing = sorted(held - listed), sorted(listed - held)
        details = ([f"unlisted {', '.join(extra[:5])}"] if extra else []) + ([f"missing {', '.join(missing[:5])}"] if missing else [])
        raise RuntimeToolError(f"{path} does not hold exactly the files {RUNTIME_FILE} lists ({'; '.join(details)})")
    for name in sorted(listed):
        if digests[name] != record["sha256"][name]:
            raise RuntimeToolError(f"{path}: the SHA-256 of {name} does not match {RUNTIME_FILE}")


def replace_directory(staging: str, target: str) -> None:
    """Move a complete directory into place, replacing an existing target.

    The previous target is renamed aside first, then deleted after the move,
    or renamed back when the move fails.

    @param staging: complete directory on the same file system as target.
    @param target: destination path.
    @raises RuntimeToolError: when the previous target cannot be moved aside or the move fails.
    """
    previous = None
    try:
        if os.path.lexists(target):
            previous = tempfile.mkdtemp(prefix=f".{os.path.basename(target)}.previous-", dir=os.path.dirname(target))
            os.rmdir(previous)
            os.rename(target, previous)
        try:
            os.rename(staging, target)
        except OSError:
            if previous is not None:
                os.rename(previous, target)
                previous = None
            raise
    except OSError as error:
        raise RuntimeToolError(f"cannot replace {target}: {error.strerror}") from error
    if previous is not None:
        if os.path.isdir(previous) and not os.path.islink(previous):
            shutil.rmtree(previous)
        else:
            os.unlink(previous)


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


def command_macho_files(args: argparse.Namespace) -> None:
    """Print the Mach-O files of a staged runtime, each followed by a NUL byte, for xargs -0.

    @param args: parsed arguments with stage.
    """
    sys.stdout.write("".join(f"{path}\0" for path in macho_files(args.stage)))


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


def command_install(args: argparse.Namespace) -> None:
    """Install an archive into <root>/<platform>-<arch>/ after checking its files against runtime.json.

    The files are unpacked into a temporary sibling directory that one rename
    moves into place, so the target holds either the previous runtime or the
    complete new one. Prints the installed directory on stdout.

    @param args: parsed arguments with archive, root, and version.
    """
    check_version(args.version)
    if not os.path.isabs(args.root):
        raise RuntimeToolError(f"--root must be an absolute path, not {args.root!r}")
    os.makedirs(args.root, exist_ok=True)
    staging = tempfile.mkdtemp(prefix=f".{args.version}.install-", dir=args.root)
    try:
        record, digests = read_archive(args.archive, staging)
        check_archive(args.archive, record, digests, args.version, None)
        os.chmod(staging, 0o755)
        target = os.path.join(args.root, f"{record['platform']}-{record['arch']}")
        replace_directory(staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(target)


def command_merge(args: argparse.Namespace) -> None:
    """Merge manifests of one runtime version into one file; a later artifact replaces an earlier one with the same key.

    @param args: parsed arguments with output and manifests.
    """
    merged: Optional[Record] = None
    for path in args.manifests:
        manifest = load_manifest(path)
        if merged is None:
            merged = {"format": FORMAT, "version": manifest["version"], "bpy": manifest["bpy"], "artifacts": {}}
        else:
            check_same_release(merged, manifest, path)
        merged["artifacts"].update(manifest["artifacts"])
    if merged is None:
        raise RuntimeToolError("merge needs at least one manifest")
    write_text_atomic(args.output, manifest_text(merged))
    print(f"runtime.py: {args.output}: {', '.join(sorted(merged['artifacts']))}", file=sys.stderr)


def command_verify(args: argparse.Namespace) -> None:
    """Check that a directory holds exactly the archives a manifest lists, with matching URLs, sizes, digests, and contents.

    @param args: parsed arguments with manifest, dir, version, and base_url.
    """
    manifest = load_manifest(args.manifest)
    if manifest["version"] != args.version:
        raise RuntimeToolError(f"{args.manifest} lists runtime {manifest['version']!r}, not {args.version!r}")
    if not manifest["artifacts"]:
        raise RuntimeToolError(f"{args.manifest} lists no artifacts")
    base_url = args.base_url if args.base_url.endswith("/") else args.base_url + "/"
    listed = set()
    for key in sorted(manifest["artifacts"]):
        entry = manifest["artifacts"][key]
        name = archive_name(args.version, key)
        path = os.path.join(args.dir, name)
        if entry["url"] != base_url + name:
            raise RuntimeToolError(f"{args.manifest}: artifacts.{key}.url is {entry['url']}, not {base_url + name}")
        if not os.path.isfile(path):
            raise RuntimeToolError(f"{path} is missing")
        if os.path.getsize(path) != entry["bytes"] or sha256_file(path) != entry["sha256"]:
            raise RuntimeToolError(f"{path} does not match the size and SHA-256 that {args.manifest} lists")
        record, digests = read_archive(path)
        check_archive(path, record, digests, args.version, key)
        if record["bpy"] != manifest["bpy"]:
            raise RuntimeToolError(f"{path} holds bpy {record['bpy']!r}, but {args.manifest} lists {manifest['bpy']!r}")
        listed.add(name)
    unlisted = sorted(name for name in os.listdir(args.dir) if name.startswith("blender-") and name.endswith(".tar.gz") and name not in listed)
    if unlisted:
        raise RuntimeToolError(f"{args.dir} holds archives that {args.manifest} does not list: {', '.join(unlisted)}")
    print(f"runtime.py: {args.manifest}: {len(listed)} archive(s) match", file=sys.stderr)


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


def main(argv: Optional[List[str]] = None) -> int:
    """Run one command.

    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    args = build_parser().parse_args(argv)
    try:
        args.run(args)
    except (RuntimeToolError, OSError) as error:
        print(f"runtime.py: error: {error}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    sys.exit(main())
