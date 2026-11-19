#!/usr/bin/env python3
"""What the runtime scripts of WASD Engine's game tools share: runtime.json and manifest.json, their archives, and
installing, merging, and verifying them.

Each tool's ``runtime.py`` (``libgodot``, ``supercollider``, ``gimp``, ``blender``) describes itself with a
:class:`Tool` and binds these functions to it; its own commands, its runtime.json fields, and the files it stages stay
in its script. Standard library only, Python 3.8 or newer, as the scripts themselves; a script adds this folder to
``sys.path``, since ``python -I`` leaves its own folder off.
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
import struct
import sys
import tarfile
import tempfile
import time
from dataclasses import dataclass
from typing import IO, Any, Callable, Dict, List, Optional, Pattern, Tuple

RUNTIME_FILE = "runtime.json"
MANIFEST_FILE = "manifest.json"
PLATFORMS = ("darwin", "linux", "win32")
ARCHES = ("arm64", "x64")
# The fields of a manifest artifact.
ARTIFACT_FIELDS = ("url", "bytes", "sha256")
# Each tool's plugin (packages/gamedev/<tool>/src) and Desktop packaging (apps/desktop/scripts/wasdengine-<tool>.ts)
# read both files; FORMAT changes only with them.
FORMAT = 1
# The patterns end in \Z, which rejects a trailing newline that $ accepts.
# The version names files, a URL path segment, and the Git tag <tool>-<version>.
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
ARTIFACT_KEY_PATTERN = re.compile(r"^(?:darwin|linux|win32)-(?:arm64|x64)\Z")
COPY_CHUNK_BYTES = 1 << 20
NAME_MAX_LENGTH = 200
# PE machine type of x64 code.
PE_MACHINE_X64 = 0x8664
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
    "windowscodecs.dll", "xmllite.dll",
))
MACH_O_MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce")
# The file that keeps an otherwise empty folder in archives, which hold plain files only.
KEEP_FILE = "wasd-engine-folder.txt"
Record = Dict[str, Any]

@dataclass(frozen=True)
class Tool:
    """What sets one tool's runtime apart.

    @param name: the archives' and releases' name, such as gimp in gimp-<version>-<key>.tar.gz.
    @param upstream: the field of runtime.json and manifest.json that names the tool's own version, such as gimp.
    @param label: that version's name in messages, such as GIMP.
    @param upstream_pattern: what that version may be.
    @param runtime_file_max_bytes: the most bytes runtime.json may take in an archive.
    @param parse_runtime: the tool's runtime.json parser.
    @param is_runtime_path: whether a relative path may name a file of the runtime.
    @param gnu_format: whether archives use GNU tar, for paths longer than ustar's 100-byte names.
    @param windows_busy_hint: what a failed replacement on Windows adds, such as which processes to stop.
    @param pe_extensions: the file extensions of the runtime's Windows programs and libraries.
    """

    name: str
    upstream: str
    label: str
    upstream_pattern: Pattern[str]
    runtime_file_max_bytes: int
    parse_runtime: Callable[[Any, str], Dict[str, Any]]
    is_runtime_path: Callable[[str], bool]
    gnu_format: bool = False
    windows_busy_hint: str = ""
    pe_extensions: Tuple[str, ...] = (".exe", ".dll")


class RuntimeToolError(Exception):
    """A failure reported as one error line and exit status 1."""


def check_version(version: str) -> None:
    """Reject a runtime version that cannot name an archive, a URL path segment, and a Git tag.

    @param version: runtime version such as 3.2.8-wasd.1.
    @raises RuntimeToolError: when the version has other characters or a ".." sequence.
    """
    if VERSION_PATTERN.match(version) is None or ".." in version:
        raise RuntimeToolError(
            f"invalid runtime version {version!r}: use letters, digits, '.', '_', '+', and '-', "
            "starting with a letter or digit, without '..'"
        )


def check_format(record: Record, where: str) -> None:
    """Require the file format this script, the plugin, and Desktop packaging share.

    @param record: parsed runtime.json or manifest.json object.
    @param where: file description for error messages.
    @raises RuntimeToolError: when the format is not FORMAT.
    """
    value = record["format"]
    if isinstance(value, bool) or value != FORMAT:
        raise RuntimeToolError(f"{where}: format must be {FORMAT}, found {value!r}")


def archive_name(tool: Tool, version: str, key: str) -> str:
    """Return the archive file name of one platform.

    @param version: runtime version.
    @param key: artifact key <platform>-<arch>, with Node.js platform and architecture names.
    @returns: <tool>-<version>-<key>.tar.gz.
    """
    return f"{tool.name}-{version}-{key}.tar.gz"


def release_url(tool: Tool, repository: str, version: str, file_name: str) -> str:
    """Return the download URL of a file attached to the GitHub release <tool>-<version>.

    @param repository: GitHub repository as owner/name.
    @param version: runtime version.
    @param file_name: release asset name.
    @returns: https://github.com/<repository>/releases/download/<tool>-<version>/<file_name>.
    """
    return f"https://github.com/{repository}/releases/download/{tool.name}-{version}/{file_name}"


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


def parse_manifest(tool: Tool, value: Any, where: str) -> Record:
    """Validate the contents of manifest.json.

    @param value: parsed manifest.json.
    @param where: file description for error messages.
    @returns: the validated manifest.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    manifest = require_fields(value, ("format", "version", tool.upstream, "artifacts"), where)
    check_format(manifest, where)
    check_version(require_string(manifest, "version", where))
    require_string(manifest, tool.upstream, where, tool.upstream_pattern)
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


def load_manifest(tool: Tool, path: str) -> Record:
    """Read and validate a manifest.json file.

    @param path: file path.
    @returns: the validated manifest.
    @raises RuntimeToolError: when the file cannot be read or is invalid.
    """
    return parse_manifest(tool, read_json(path), path)


def manifest_text(tool: Tool, manifest: Record) -> str:
    """Serialize a manifest with its artifacts sorted by key.

    @param manifest: validated manifest.
    @returns: the serialized text.
    """
    artifacts = manifest["artifacts"]
    return json_text({
        "format": FORMAT,
        "version": manifest["version"],
        tool.upstream: manifest[tool.upstream],
        "artifacts": {key: artifacts[key] for key in sorted(artifacts)},
    })


def check_same_release(tool: Tool, base: Record, other: Record, where: str) -> None:
    """Require two manifests to describe the same runtime version and upstream version (``tool.upstream``).

    @param base: manifest being extended.
    @param other: manifest merged into it.
    @param where: description of other for error messages.
    @raises RuntimeToolError: when either version differs.
    """
    for field in ("version", tool.upstream):
        if base[field] != other[field]:
            raise RuntimeToolError(
                f"{where} has {field} {other[field]!r}, not {base[field]!r}; "
                f"one manifest holds the archives of one runtime version built from one {tool.label} version"
            )


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


def stage_files(tool: Tool, stage: str) -> Dict[str, int]:
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
            if not tool.is_runtime_path(relative):
                raise RuntimeToolError(f"{full}: {relative!r} cannot name a file inside a runtime")
            if stat.S_ISREG(mode):
                files[relative] = 0o755 if mode & 0o111 else 0o644
    return files


def write_archive(tool: Tool, path: str, directory: str, files: List[Tuple[str, int]], mtime: int) -> None:
    """Write a gzip-compressed archive of files at their relative paths, through a temporary sibling.

    Entries are plain files only; extraction creates their folders. They carry
    the given modes, owner 0:0 without names, and one modification time, so
    equal files and mtime produce equal archive bytes. A tool whose paths outgrow
    ustar's 100-byte names writes GNU format (``tool.gnu_format``).

    @param path: archive path.
    @param directory: directory holding the files.
    @param files: relative '/'-separated paths with their permission modes, in archive order.
    @param mtime: modification time of every entry and of the gzip header.
    """
    handle, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(handle, "wb") as raw, \
                gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=mtime) as compressed, \
                tarfile.open(fileobj=compressed, mode="w", format=tarfile.GNU_FORMAT if tool.gnu_format else tarfile.USTAR_FORMAT) as archive:
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


def read_archive(tool: Tool, path: str, directory: Optional[str] = None) -> Tuple[Record, Dict[str, str]]:
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
                if not entry.isfile() or not (entry.name == RUNTIME_FILE or tool.is_runtime_path(entry.name)) or entry.name in digests:
                    raise RuntimeToolError(f"{path}: entry {entry.name!r} is not a uniquely named plain file inside the runtime")
                if entry.name == RUNTIME_FILE and entry.size > tool.runtime_file_max_bytes:
                    raise RuntimeToolError(f"{path}: {RUNTIME_FILE} is larger than {tool.runtime_file_max_bytes} bytes")
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
    return tool.parse_runtime(value, f"{path}: {RUNTIME_FILE}"), digests


def check_archive(tool: Tool, path: str, record: Record, digests: Dict[str, str], version: str, key: Optional[str]) -> None:
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


def replace_directory(tool: Tool, staging: str, target: str) -> None:
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
        hint = tool.windows_busy_hint if os.name == "nt" else ""
        raise RuntimeToolError(f"cannot replace {target}: {error.strerror}{hint}") from error
    if previous is not None:
        if os.path.isdir(previous) and not os.path.islink(previous):
            shutil.rmtree(previous)
        else:
            os.unlink(previous)


def command_install(tool: Tool, args: argparse.Namespace) -> None:
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
        record, digests = read_archive(tool, args.archive, staging)
        check_archive(tool, args.archive, record, digests, args.version, None)
        os.chmod(staging, 0o755)
        target = os.path.join(args.root, f"{record['platform']}-{record['arch']}")
        replace_directory(tool, staging, target)
    except BaseException:
        shutil.rmtree(staging, ignore_errors=True)
        raise
    print(target)


def command_merge(tool: Tool, args: argparse.Namespace) -> None:
    """Merge manifests of one runtime version into one file; a later artifact replaces an earlier one with the same key.

    @param args: parsed arguments with output and manifests.
    """
    merged: Optional[Record] = None
    for path in args.manifests:
        manifest = load_manifest(tool, path)
        if merged is None:
            merged = {"format": FORMAT, "version": manifest["version"], tool.upstream: manifest[tool.upstream], "artifacts": {}}
        else:
            check_same_release(tool, merged, manifest, path)
        merged["artifacts"].update(manifest["artifacts"])
    if merged is None:
        raise RuntimeToolError("merge needs at least one manifest")
    write_text_atomic(args.output, manifest_text(tool, merged))
    print(f"runtime.py: {args.output}: {', '.join(sorted(merged['artifacts']))}", file=sys.stderr)


def command_verify(tool: Tool, args: argparse.Namespace) -> None:
    """Check that a directory holds exactly the archives a manifest lists, with matching URLs, sizes, digests, and contents.

    @param args: parsed arguments with manifest, dir, version, and base_url.
    """
    manifest = load_manifest(tool, args.manifest)
    if manifest["version"] != args.version:
        raise RuntimeToolError(f"{args.manifest} lists runtime {manifest['version']!r}, not {args.version!r}")
    if not manifest["artifacts"]:
        raise RuntimeToolError(f"{args.manifest} lists no artifacts")
    base_url = args.base_url if args.base_url.endswith("/") else args.base_url + "/"
    listed = set()
    for key in sorted(manifest["artifacts"]):
        entry = manifest["artifacts"][key]
        name = archive_name(tool, args.version, key)
        path = os.path.join(args.dir, name)
        if entry["url"] != base_url + name:
            raise RuntimeToolError(f"{args.manifest}: artifacts.{key}.url is {entry['url']}, not {base_url + name}")
        if not os.path.isfile(path):
            raise RuntimeToolError(f"{path} is missing")
        if os.path.getsize(path) != entry["bytes"] or sha256_file(path) != entry["sha256"]:
            raise RuntimeToolError(f"{path} does not match the size and SHA-256 that {args.manifest} lists")
        record, digests = read_archive(tool, path)
        check_archive(tool, path, record, digests, args.version, key)
        if record[tool.upstream] != manifest[tool.upstream]:
            raise RuntimeToolError(f"{path} holds {tool.label} {record[tool.upstream]!r}, but {args.manifest} lists {manifest[tool.upstream]!r}")
        listed.add(name)
    unlisted = sorted(name for name in os.listdir(args.dir) if name.startswith(f"{tool.name}-") and name.endswith(".tar.gz") and name not in listed)
    if unlisted:
        raise RuntimeToolError(f"{args.dir} holds archives that {args.manifest} does not list: {', '.join(unlisted)}")
    print(f"runtime.py: {args.manifest}: {len(listed)} archive(s) match", file=sys.stderr)


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


def command_macho_files(args: argparse.Namespace) -> None:
    """Print the Mach-O files of a staged runtime, each followed by a NUL byte, for xargs -0.

    @param args: parsed arguments with stage.
    """
    sys.stdout.write("".join(f"{path}\0" for path in macho_files(args.stage)))


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


def pe_files(tool: Tool, stage: str) -> List[str]:
    """List the PE files of a staged runtime by their extension.

    @param stage: runtime folder.
    @returns: absolute paths of the files whose extension the tool's ``pe_extensions`` lists, sorted.
    """
    found = []
    for directory, _, names in os.walk(stage):
        found.extend(os.path.join(directory, name) for name in names if name.lower().endswith(tool.pe_extensions))
    return sorted(found)


def pe_machines(tool: Tool, stage: str) -> List[Tuple[str, int]]:
    """List the machine type of every PE file of a staged runtime.

    @param stage: runtime folder.
    @returns: ('/'-separated path relative to the stage, machine type) of each PE file, sorted by path.
    """
    machines = []
    for path in pe_files(tool, stage):
        with open(path, "rb") as stream:
            layout = pe_layout(stream.read())
        if layout is not None:
            machines.append((os.path.relpath(path, stage).replace(os.sep, "/"), layout[0]))
    return machines


def unresolved_imports(tool: Tool, stage: str, folders: Tuple[str, ...]) -> List[str]:
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
    for path in pe_files(tool, stage):
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


def command_check_imports(tool: Tool, args: argparse.Namespace) -> None:
    """Require every PE file of the runtime to be x64 code whose libraries resolve inside the runtime or to Windows.

    @param args: parsed arguments with stage and folder.
    """
    files = pe_files(tool, args.stage)
    foreign = [path for path, machine in pe_machines(tool, args.stage) if machine != PE_MACHINE_X64]
    if foreign:
        raise RuntimeToolError(f"{len(foreign)} programs or libraries are not x64 code: {', '.join(foreign[:5])}")
    problems = unresolved_imports(tool, args.stage, tuple(args.folder))
    if problems:
        raise RuntimeToolError(f"{len(problems)} libraries resolve neither inside the runtime nor to Windows: {'; '.join(problems[:5])}")
    print(f"runtime.py: the libraries of {len(files)} PE files resolve inside the runtime or to Windows", file=sys.stderr)


def run(parser: argparse.ArgumentParser, argv: Optional[List[str]] = None) -> int:
    """Run one command of a runtime script.

    @param parser: the script's parser, whose commands set ``run``.
    @param argv: arguments without the program name; None reads sys.argv.
    @returns: process exit status.
    """
    args = parser.parse_args(argv)
    try:
        args.run(args)
    except (RuntimeToolError, OSError) as error:
        print(f"runtime.py: error: {error}", file=sys.stderr)
        return 1
    return 0
