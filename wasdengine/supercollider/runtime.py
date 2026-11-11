#!/usr/bin/env python3
"""Package, install, merge, and verify WASD Engine SuperCollider runtime archives.

build.sh runs the supercollider-version, package, and install commands, and on
Windows the vc-runtime and check-imports commands; the release workflow
(.github/workflows/wasd-supercollider.yml) runs merge and verify. BUILD.md
describes runtime.json, manifest.json, and the archive layout. The script needs
only the standard library of Python 3.8 or newer. It writes UTF-8 with LF line
ends to stdout and stderr on every platform. Every failure prints one
"runtime.py: error:" line on stderr and exits with status 1.
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import shutil
import stat
import struct
import sys
import tarfile
import tempfile
import time
from typing import IO, Any, Dict, List, Optional, Tuple

RUNTIME_FILE = "runtime.json"
MANIFEST_FILE = "manifest.json"
PLATFORMS = ("darwin", "linux", "win32")
ARCHES = ("arm64", "x64")
# The SuperCollider plugin (packages/gamedev/supercollider/src/environment.ts) and Desktop packaging
# (apps/desktop/scripts/wasdengine-supercollider.ts) read both files; FORMAT changes only with them.
FORMAT = 1
RUNTIME_FIELDS = ("format", "version", "supercollider", "platform", "arch", "sclang", "scsynth", "plugins", "classLibrary", "helpSource", "sha256")
DIRECTORY_FIELDS = ("plugins", "classLibrary", "helpSource")
MANIFEST_FIELDS = ("format", "version", "supercollider", "artifacts")
ARTIFACT_FIELDS = ("url", "bytes", "sha256")
# The patterns end in \Z, which rejects a trailing newline that $ accepts.
# The version names files, a URL path segment, and the Git tag supercollider-<version>.
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
# The form of SuperCollider's SCVersion.txt: 3.14.1, or 3.15.0-rc1 with a tweak.
SUPERCOLLIDER_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-?[A-Za-z0-9_.]+)?\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
# One part of a runtime path: a file or folder name that does not start with a dot.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,-][A-Za-z0-9 _.+@=,-]*\Z")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
ARTIFACT_KEY_PATTERN = re.compile(r"^(?:darwin|linux|win32)-(?:arm64|x64)\Z")
COPY_CHUNK_BYTES = 1 << 20
RUNTIME_FILE_MAX_BYTES = 1 << 20
NAME_MAX_LENGTH = 200

# PE machine type of x64 code.
PE_MACHINE_X64 = 0x8664
# Extensions of the runtime's PE files: programs, libraries, and UGen plugins.
PE_EXTENSIONS = (".exe", ".dll", ".scx")
# Libraries that every Windows 10 and later holds in System32, which runtime files may load besides their own; the API
# set names api-ms-win-* and ext-ms-win-* resolve to system libraries too. The Visual C++ runtime is not among them.
WINDOWS_SYSTEM_LIBRARIES = frozenset(name.lower() for name in (
    "advapi32.dll", "avrt.dll", "bcrypt.dll", "bcryptprimitives.dll", "cfgmgr32.dll", "comctl32.dll", "comdlg32.dll",
    "crypt32.dll", "d2d1.dll", "d3d11.dll", "d3d12.dll", "d3d9.dll", "d3dcompiler_47.dll", "dbghelp.dll", "dcomp.dll",
    "dnsapi.dll", "dsound.dll", "dwmapi.dll", "dwrite.dll", "dxgi.dll", "gdi32.dll", "gdiplus.dll", "glu32.dll", "hid.dll",
    "imagehlp.dll", "imm32.dll", "iphlpapi.dll", "kernel32.dll", "kernelbase.dll", "ksuser.dll", "mf.dll", "mfplat.dll",
    "mfreadwrite.dll", "mpr.dll", "msacm32.dll", "mscms.dll", "msimg32.dll", "msvcrt.dll", "mswsock.dll", "ncrypt.dll",
    "netapi32.dll", "normaliz.dll", "ntdll.dll", "ole32.dll", "oleacc.dll", "oleaut32.dll", "opengl32.dll", "powrprof.dll",
    "propsys.dll", "psapi.dll", "rpcrt4.dll", "secur32.dll", "setupapi.dll", "shcore.dll", "shell32.dll", "shlwapi.dll",
    "ucrtbase.dll", "urlmon.dll", "user32.dll", "userenv.dll", "usp10.dll", "uxtheme.dll", "version.dll", "winhttp.dll",
    "wininet.dll", "winmm.dll", "winspool.drv", "wintrust.dll", "wldap32.dll", "ws2_32.dll", "wsock32.dll", "wtsapi32.dll",
    "windowscodecs.dll",
))

Record = Dict[str, Any]


class RuntimeToolError(Exception):
    """A failure reported as one error line and exit status 1."""


def check_version(version: str) -> None:
    """Reject a runtime version that cannot name an archive, a URL path segment, and a Git tag.

    @param version: runtime version such as 3.14.1-wasd.1.
    @raises RuntimeToolError: when the version has other characters or a ".." sequence.
    """
    if VERSION_PATTERN.match(version) is None or ".." in version:
        raise RuntimeToolError(
            f"invalid runtime version {version!r}: use letters, digits, '.', '_', '+', and '-', "
            "starting with a letter or digit, without '..'"
        )


def is_runtime_path(path: str) -> bool:
    """Tell whether a path can name a file inside a runtime: relative, '/'-separated, without empty, '.', or '..' parts.

    @param path: candidate path.
    @returns: whether every part matches NAME_PATTERN and the path is not runtime.json itself.
    """
    parts = path.split("/")
    return path != RUNTIME_FILE and all(len(part) <= NAME_MAX_LENGTH and NAME_PATTERN.match(part) is not None for part in parts)


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
    @returns: supercollider-<version>-<key>.tar.gz.
    """
    return f"supercollider-{version}-{key}.tar.gz"


def release_url(repository: str, version: str, file_name: str) -> str:
    """Return the download URL of a file attached to the GitHub release supercollider-<version>.

    @param repository: GitHub repository as owner/name.
    @param version: runtime version.
    @param file_name: release asset name.
    @returns: https://github.com/<repository>/releases/download/supercollider-<version>/<file_name>.
    """
    return f"https://github.com/{repository}/releases/download/supercollider-{version}/{file_name}"


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
    require_string(manifest, "supercollider", where, SUPERCOLLIDER_PATTERN)
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
        "supercollider": manifest["supercollider"],
        "artifacts": {key: artifacts[key] for key in sorted(artifacts)},
    })


def check_same_release(base: Record, other: Record, where: str) -> None:
    """Require two manifests to describe the same runtime version and SuperCollider version.

    @param base: manifest being extended.
    @param other: manifest merged into it.
    @param where: description of other for error messages.
    @raises RuntimeToolError: when either version differs.
    """
    for field in ("version", "supercollider"):
        if base[field] != other[field]:
            raise RuntimeToolError(
                f"{where} has {field} {other[field]!r}, not {base[field]!r}; "
                "one manifest holds the archives of one runtime version built from one SuperCollider version"
            )


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
    """Write a gzip-compressed ustar archive of files at their relative paths, through a temporary sibling.

    Entries are plain files only; extraction creates their folders. They carry
    the given modes, owner 0:0 without names, and one modification time, so
    equal files and mtime produce equal archive bytes.

    @param path: archive path.
    @param directory: directory holding the files.
    @param files: relative '/'-separated paths with their permission modes, in archive order.
    @param mtime: modification time of every entry and of the gzip header.
    """
    handle, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(handle, "wb") as raw, \
                gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=mtime) as compressed, \
                tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
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
        # Windows refuses to rename a directory while a process runs a file from it.
        hint = "; stop every process that runs SuperCollider from it, then retry" if os.name == "nt" else ""
        raise RuntimeToolError(f"cannot replace {target}: {error.strerror}{hint}") from error
    if previous is not None:
        if os.path.isdir(previous) and not os.path.islink(previous):
            shutil.rmtree(previous)
        else:
            os.unlink(previous)


def pe_layout(data: bytes) -> Optional[Tuple[int, int, int, List[Tuple[int, int, int]], int]]:
    """Read the headers of a PE file: the machine, image base, data directories, and sections.

    @param data: the file's bytes.
    @returns: machine type, image base, offset of the data directories, sections as (virtual address, size, file offset),
        and the number of data directories; None when the data is not a PE file.
    """
    if len(data) < 64 or data[:2] != b"MZ":
        return None
    header = struct.unpack_from("<I", data, 0x3C)[0]
    if header + 24 > len(data) or data[header:header + 4] != b"PE\0\0":
        return None
    machine, section_count = struct.unpack_from("<HH", data, header + 4)
    optional_size = struct.unpack_from("<H", data, header + 20)[0]
    optional = header + 24
    magic = struct.unpack_from("<H", data, optional)[0]
    if magic == 0x20B:
        image_base, directories = struct.unpack_from("<Q", data, optional + 24)[0], optional + 112
    elif magic == 0x10B:
        image_base, directories = struct.unpack_from("<I", data, optional + 28)[0], optional + 96
    else:
        return None
    directory_count = struct.unpack_from("<I", data, directories - 4)[0]
    sections = []
    for index in range(section_count):
        entry = optional + optional_size + index * 40
        virtual_size, virtual_address, raw_size, raw_offset = struct.unpack_from("<IIII", data, entry + 8)
        sections.append((virtual_address, max(virtual_size, raw_size), raw_offset))
    return machine, image_base, directories, sections, directory_count


def pe_imports(data: bytes) -> Optional[Tuple[int, List[str]]]:
    """Read the machine type and the libraries that a PE file loads, from its import and delay-load import tables.

    @param data: the file's bytes.
    @returns: the machine type and the library names in table order, or None when the data is not a PE file.
    @raises RuntimeToolError: when a table points outside the file.
    """
    layout = pe_layout(data)
    if layout is None:
        return None
    machine, image_base, directories, sections, directory_count = layout

    def offset(address: int) -> int:
        for virtual_address, size, raw_offset in sections:
            if virtual_address <= address < virtual_address + size:
                return raw_offset + address - virtual_address
        raise RuntimeToolError(f"the address {address:#x} lies in no section")

    def name_at(address: int) -> str:
        start = offset(address)
        end = data.find(b"\0", start)
        return data[start:end].decode("ascii", "replace")

    names = []
    # The import table (directory 1) holds 20-byte descriptors with the name at byte 12; the delay-load table
    # (directory 13) holds 32-byte descriptors with the name at byte 4, an address relative to the image when bit 0 of
    # their attributes is set and an absolute one otherwise. A descriptor without a name ends each table.
    for index, size, name_field in ((1, 20, 12), (13, 32, 4)):
        if index >= directory_count:
            continue
        address = struct.unpack_from("<I", data, directories + index * 8)[0]
        if address == 0:
            continue
        cursor = offset(address)
        while cursor + size <= len(data):
            attributes, = struct.unpack_from("<I", data, cursor)
            name = struct.unpack_from("<I", data, cursor + name_field)[0]
            if name == 0:
                break
            if index == 13 and attributes & 1 == 0:
                name -= image_base
            names.append(name_at(name))
            cursor += size
    return machine, names


def pe_files(stage: str) -> List[str]:
    """List the PE files of a staged runtime by their extension.

    @param stage: runtime folder.
    @returns: absolute paths of the files whose extension PE_EXTENSIONS lists, sorted.
    """
    found = []
    for directory, _, names in os.walk(stage):
        found.extend(os.path.join(directory, name) for name in names if name.lower().endswith(PE_EXTENSIONS))
    return sorted(found)


def pe_machines(stage: str) -> List[Tuple[str, int]]:
    """List the machine type of every PE file of a staged runtime.

    @param stage: runtime folder.
    @returns: ('/'-separated path relative to the stage, machine type) of each PE file, sorted by path.
    """
    machines = []
    for path in pe_files(stage):
        with open(path, "rb") as stream:
            layout = pe_layout(stream.read())
        if layout is not None:
            machines.append((os.path.relpath(path, stage).replace(os.sep, "/"), layout[0]))
    return machines


def unresolved_imports(stage: str, folders: Tuple[str, ...]) -> List[str]:
    """List the libraries that the PE files of a runtime load but neither the runtime nor Windows provides.

    A library resolves when Windows provides it (WINDOWS_SYSTEM_LIBRARIES or an api-ms-win- or ext-ms-win- API set), or
    when a file of that name, compared without regard to case, lies beside the file that loads it or in one of the
    runtime's library folders, which its programs put first on the search path.

    @param stage: runtime folder.
    @param folders: '/'-separated library folders relative to the stage, such as bin.
    @returns: one "<file> loads <library>" line per unresolved library, sorted.
    @raises RuntimeToolError: when a PE file's tables are broken.
    """
    def names_in(directory: str) -> set:
        return {name.lower() for name in os.listdir(directory)} if os.path.isdir(directory) else set()

    shared = set()
    for folder in folders:
        shared |= names_in(os.path.join(stage, *folder.split("/")))
    unresolved = []
    for path in pe_files(stage):
        with open(path, "rb") as stream:
            data = stream.read()
        try:
            parsed = pe_imports(data)
        except (struct.error, RuntimeToolError) as error:
            raise RuntimeToolError(f"{path} has a broken import table: {error}") from error
        if parsed is None:
            continue
        beside = names_in(os.path.dirname(path))
        for library in parsed[1]:
            name = library.lower()
            if name in WINDOWS_SYSTEM_LIBRARIES or name.startswith(("api-ms-win-", "ext-ms-win-")) or name in shared or name in beside:
                continue
            unresolved.append(f"{os.path.relpath(path, stage).replace(os.sep, '/')} loads {library}")
    return sorted(unresolved)


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


def command_vc_runtime(args: argparse.Namespace) -> None:
    """Copy the Visual C++ runtime libraries that the runtime loads into its folder and name them on stderr.

    @param args: parsed arguments with stage and redist.
    """
    copied = copy_vc_runtime(args.stage, args.redist)
    print(f"runtime.py: copied {', '.join(copied) or 'no'} Visual C++ runtime libraries into {args.stage}", file=sys.stderr)


def command_check_imports(args: argparse.Namespace) -> None:
    """Require every PE file of the runtime to be x64 code whose libraries resolve inside the runtime or to Windows.

    @param args: parsed arguments with stage and folder.
    """
    files = pe_files(args.stage)
    foreign = [path for path, machine in pe_machines(args.stage) if machine != PE_MACHINE_X64]
    if foreign:
        raise RuntimeToolError(f"{len(foreign)} programs or libraries are not x64 code: {', '.join(foreign[:5])}")
    problems = unresolved_imports(args.stage, tuple(args.folder))
    if problems:
        raise RuntimeToolError(f"{len(problems)} libraries resolve neither inside the runtime nor to Windows: {'; '.join(problems[:5])}")
    print(f"runtime.py: the libraries of {len(files)} PE files resolve inside the runtime or to Windows", file=sys.stderr)


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
            merged = {"format": FORMAT, "version": manifest["version"], "supercollider": manifest["supercollider"], "artifacts": {}}
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
        if record["supercollider"] != manifest["supercollider"]:
            raise RuntimeToolError(f"{path} holds SuperCollider {record['supercollider']!r}, but {args.manifest} lists {manifest['supercollider']!r}")
        listed.add(name)
    unlisted = sorted(name for name in os.listdir(args.dir) if name.startswith("supercollider-") and name.endswith(".tar.gz") and name not in listed)
    if unlisted:
        raise RuntimeToolError(f"{args.dir} holds archives that {args.manifest} does not list: {', '.join(unlisted)}")
    print(f"runtime.py: {args.manifest}: {len(listed)} archive(s) match", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser.

    @returns: a parser whose subcommands store their handler as run.
    """
    parser = argparse.ArgumentParser(prog="runtime.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    version_command = commands.add_parser("supercollider-version", help="print the SuperCollider version of a source tree")
    version_command.add_argument("--source", required=True, help="SuperCollider source directory")
    version_command.set_defaults(run=command_supercollider_version)

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
    # build.sh reads printed paths through $(...), which keeps the carriage returns of
    # Windows text mode, and Windows encodes piped output in the ANSI code page.
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    sys.exit(main())
