#!/usr/bin/env python3
"""Package, install, merge, and verify WASD Engine LibGodot runtime archives.

build.sh runs the godot-version, package, and install commands; the release
workflow (.github/workflows/wasd-libgodot.yml) runs merge and verify. BUILD.md
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
import sys
import tarfile
import tempfile
import time
from typing import IO, Any, Dict, List, Optional, Tuple

RUNTIME_FILE = "runtime.json"
MANIFEST_FILE = "manifest.json"
PLATFORMS = ("darwin", "linux", "win32")
ARCHES = ("arm64", "x64")
# The Godot plugin (packages/gamedev/godot/src/runtime.ts) reads both files; FORMAT changes only with it.
FORMAT = 1
RUNTIME_FIELDS = ("format", "version", "godot", "platform", "arch", "runner", "library", "sha256")
MANIFEST_FIELDS = ("format", "version", "godot", "artifacts")
ARTIFACT_FIELDS = ("url", "bytes", "sha256", "runner", "library")
# The patterns end in \Z, which rejects a trailing newline that $ accepts.
# The version names files, a URL path segment, and the Git tag libgodot-<version>.
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
# The form godot_version prints, such as 4.7.2-stable or 4.8-beta2.
GODOT_PATTERN = re.compile(r"^[0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[A-Za-z0-9_.-]+)?\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
FILE_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_][A-Za-z0-9_.-]*\Z")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
ARTIFACT_KEY_PATTERN = re.compile(r"^(?:darwin|linux|win32)-(?:arm64|x64)\Z")
COPY_CHUNK_BYTES = 1 << 20
RUNTIME_FILE_MAX_BYTES = 64 * 1024

Record = Dict[str, Any]


class RuntimeToolError(Exception):
    """A failure reported as one error line and exit status 1."""


def check_version(version: str) -> None:
    """Reject a runtime version that cannot name an archive, a URL path segment, and a Git tag.

    @param version: runtime version such as 4.7.2-wasd.1.
    @raises RuntimeToolError: when the version has other characters or a ".." sequence.
    """
    if VERSION_PATTERN.match(version) is None or ".." in version:
        raise RuntimeToolError(
            f"invalid runtime version {version!r}: use letters, digits, '.', '_', '+', and '-', "
            "starting with a letter or digit, without '..'"
        )


def check_format(record: Record, where: str) -> None:
    """Require the file format this script and the Godot plugin share.

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
    @returns: libgodot-<version>-<key>.tar.gz.
    """
    return f"libgodot-{version}-{key}.tar.gz"


def release_url(repository: str, version: str, file_name: str) -> str:
    """Return the download URL of a file attached to the GitHub release libgodot-<version>.

    @param repository: GitHub repository as owner/name.
    @param version: runtime version.
    @param file_name: release asset name.
    @returns: https://github.com/<repository>/releases/download/libgodot-<version>/<file_name>.
    """
    return f"https://github.com/{repository}/releases/download/libgodot-{version}/{file_name}"


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

    @param value: parsed runtime.json.
    @param where: file description for error messages.
    @returns: the validated record.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    record = require_fields(value, RUNTIME_FIELDS, where)
    check_format(record, where)
    check_version(require_string(record, "version", where))
    require_string(record, "godot", where, GODOT_PATTERN)
    if record["platform"] not in PLATFORMS or record["arch"] not in ARCHES:
        raise RuntimeToolError(f"{where}: platform {record['platform']!r} and arch {record['arch']!r} are not supported")
    runner = require_string(record, "runner", where, FILE_NAME_PATTERN)
    library = require_string(record, "library", where, FILE_NAME_PATTERN)
    if runner == library or RUNTIME_FILE in (runner, library):
        raise RuntimeToolError(f"{where}: runner and library must be two files other than {RUNTIME_FILE}")
    digests = require_fields(record["sha256"], (runner, library), f"{where}: sha256")
    for name in (runner, library):
        require_string(digests, name, f"{where}: sha256", SHA256_PATTERN)
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
    require_string(manifest, "godot", where, GODOT_PATTERN)
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
        runner = require_string(artifact, "runner", f"{where}: artifacts.{key}", FILE_NAME_PATTERN)
        library = require_string(artifact, "library", f"{where}: artifacts.{key}", FILE_NAME_PATTERN)
        if runner == library or RUNTIME_FILE in (runner, library):
            raise RuntimeToolError(f"{where}: artifacts.{key} runner and library must be two files other than {RUNTIME_FILE}")
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
        "godot": manifest["godot"],
        "artifacts": {key: artifacts[key] for key in sorted(artifacts)},
    })


def check_same_release(base: Record, other: Record, where: str) -> None:
    """Require two manifests to describe the same runtime version and Godot version.

    @param base: manifest being extended.
    @param other: manifest merged into it.
    @param where: description of other for error messages.
    @raises RuntimeToolError: when either version differs.
    """
    for field in ("version", "godot"):
        if base[field] != other[field]:
            raise RuntimeToolError(
                f"{where} has {field} {other[field]!r}, not {base[field]!r}; "
                "one manifest holds the archives of one runtime version built from one Godot version"
            )


def godot_version(source: str) -> str:
    """Read the Godot version of a source tree from its version.py without running it.

    @param source: Godot source directory.
    @returns: <major>.<minor>[.<patch>]-<status>, the form of Godot's release tags, such as 4.7.2-stable.
    @raises RuntimeToolError: when version.py is missing or lacks a field.
    """
    path = os.path.join(source, "version.py")
    try:
        with open(path, encoding="utf-8") as stream:
            text = stream.read()
    except OSError as error:
        raise RuntimeToolError(f"cannot read {path}: {error.strerror}; the source is not a Godot checkout") from error
    numbers = {}
    for field in ("major", "minor", "patch"):
        match = re.search(rf"^{field} = (\d+)\s*$", text, re.MULTILINE)
        if match is None:
            raise RuntimeToolError(f"{path} has no integer {field} field")
        numbers[field] = match.group(1)
    status = re.search(r'^status = "([A-Za-z0-9_.-]*)"\s*$', text, re.MULTILINE)
    if status is None:
        raise RuntimeToolError(f"{path} has no status field")
    number = f"{numbers['major']}.{numbers['minor']}"
    if numbers["patch"] != "0":
        number += f".{numbers['patch']}"
    return f"{number}-{status.group(1)}" if status.group(1) else number


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


def write_archive(path: str, directory: str, files: List[Tuple[str, int]], mtime: int) -> None:
    """Write a gzip-compressed ustar archive with plain files at its root, through a temporary sibling.

    Entries carry the given modes, owner 0:0 without names, and one
    modification time, so equal files and mtime produce equal archive bytes.

    @param path: archive path.
    @param directory: directory holding the files.
    @param files: entry names with their permission modes, in archive order.
    @param mtime: modification time of every entry and of the gzip header.
    """
    handle, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", dir=os.path.dirname(os.path.abspath(path)))
    try:
        with os.fdopen(handle, "wb") as raw, \
                gzip.GzipFile(filename="", mode="wb", fileobj=raw, compresslevel=9, mtime=mtime) as compressed, \
                tarfile.open(fileobj=compressed, mode="w", format=tarfile.USTAR_FORMAT) as archive:
            for name, mode in files:
                source = os.path.join(directory, name)
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
    """Create one file exclusively from an archive entry, with mode 0755 or 0644 following the entry's execute bit.

    @param directory: destination directory.
    @param entry: archive entry with a validated plain name.
    @param stream: the entry's bytes.
    @returns: lowercase hexadecimal SHA-256 digest of the written bytes.
    """
    destination = os.path.join(directory, entry.name)
    with open(destination, "xb") as sink:
        digest = sha256_stream(stream, sink)
    os.chmod(destination, 0o755 if entry.mode & 0o111 else 0o644)
    return digest


def read_archive(path: str, directory: Optional[str] = None) -> Tuple[Record, Dict[str, str]]:
    """Read a runtime archive, hashing every file and optionally extracting the files.

    @param path: archive path.
    @param directory: existing empty directory that receives the files, or None to only read them.
    @returns: the validated runtime.json record and the SHA-256 digest of every entry by name.
    @raises RuntimeToolError: when an entry is not a plain file at the archive
        root, a name repeats, or runtime.json is missing, too large, or invalid.
    """
    digests: Dict[str, str] = {}
    runtime_bytes: Optional[bytes] = None
    try:
        with tarfile.open(path, mode="r:gz") as archive:
            for entry in archive:
                if not entry.isfile() or FILE_NAME_PATTERN.match(entry.name) is None or entry.name in digests:
                    raise RuntimeToolError(f"{path}: entry {entry.name!r} is not a uniquely named plain file at the archive root")
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
    """Require an archive's files to match its runtime.json.

    @param path: archive path for error messages.
    @param record: validated runtime.json record.
    @param digests: SHA-256 digest of every archive entry by name.
    @param version: runtime version the archive must hold.
    @param key: artifact key <platform>-<arch> the archive must hold, or None to accept any.
    @raises RuntimeToolError: on a version, platform, file set, or digest mismatch.
    """
    if record["version"] != version:
        raise RuntimeToolError(f"{path} holds runtime {record['version']!r}, not {version!r}")
    if key is not None and f"{record['platform']}-{record['arch']}" != key:
        raise RuntimeToolError(f"{path} holds the {record['platform']}-{record['arch']} runtime, not {key}")
    expected = {RUNTIME_FILE, record["runner"], record["library"]}
    if set(digests) != expected:
        raise RuntimeToolError(f"{path} holds {', '.join(sorted(digests))}; expected exactly {', '.join(sorted(expected))}")
    for name in (record["runner"], record["library"]):
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
        hint = "; stop every game that runs from it, then retry" if os.name == "nt" else ""
        raise RuntimeToolError(f"cannot replace {target}: {error.strerror}{hint}") from error
    if previous is not None:
        if os.path.isdir(previous) and not os.path.islink(previous):
            shutil.rmtree(previous)
        else:
            os.unlink(previous)


def command_godot_version(args: argparse.Namespace) -> None:
    """Print the Godot version of a source tree on stdout.

    @param args: parsed arguments with source.
    """
    print(godot_version(args.source))


def command_package(args: argparse.Namespace) -> None:
    """Write runtime.json into the stage, archive the stage, and record the archive in manifest.json.

    Prints the archive path on stdout and a summary on stderr. An existing
    manifest.json in the output directory keeps its other artifacts and must
    describe the same runtime and Godot versions.

    @param args: parsed arguments with stage, out, version, godot, platform,
        arch, runner, library, and repository.
    """
    check_version(args.version)
    if REPOSITORY_PATTERN.match(args.repository) is None:
        raise RuntimeToolError(f"invalid repository {args.repository!r}: use owner/name")
    for name in (args.runner, args.library):
        if FILE_NAME_PATTERN.match(name) is None or name == RUNTIME_FILE:
            raise RuntimeToolError(f"invalid file name {name!r}")
        if not os.path.isfile(os.path.join(args.stage, name)):
            raise RuntimeToolError(f"{os.path.join(args.stage, name)} does not exist")
    record = parse_runtime({
        "format": FORMAT,
        "version": args.version,
        "godot": args.godot,
        "platform": args.platform,
        "arch": args.arch,
        "runner": args.runner,
        "library": args.library,
        "sha256": {name: sha256_file(os.path.join(args.stage, name)) for name in (args.runner, args.library)},
    }, RUNTIME_FILE)
    write_text_atomic(os.path.join(args.stage, RUNTIME_FILE), json_text(record))

    key = f"{args.platform}-{args.arch}"
    name = archive_name(args.version, key)
    archive = os.path.join(args.out, name)
    write_archive(archive, args.stage, [(args.runner, 0o755), (args.library, 0o755), (RUNTIME_FILE, 0o644)], archive_mtime())
    artifact = {
        "url": release_url(args.repository, args.version, name),
        "bytes": os.path.getsize(archive),
        "sha256": sha256_file(archive),
        "runner": args.runner,
        "library": args.library,
    }

    manifest_path = os.path.join(args.out, MANIFEST_FILE)
    manifest: Record = {"format": FORMAT, "version": args.version, "godot": args.godot, "artifacts": {}}
    if os.path.exists(manifest_path):
        existing = load_manifest(manifest_path)
        check_same_release(manifest, existing, manifest_path)
        manifest["artifacts"].update(existing["artifacts"])
    manifest["artifacts"][key] = artifact
    write_text_atomic(manifest_path, manifest_text(parse_manifest(manifest, manifest_path)))
    print(f"runtime.py: {archive}: {artifact['bytes']} bytes, sha256 {artifact['sha256']}", file=sys.stderr)
    print(f"runtime.py: {manifest_path}: {key} -> {artifact['url']}", file=sys.stderr)
    print(archive)


def command_install(args: argparse.Namespace) -> None:
    """Install an archive into <data-root>/runtime/<version>/ after checking its files against runtime.json.

    The files are unpacked into a temporary sibling directory that one rename
    moves into place, so the target holds either the previous runtime or the
    complete new one. Prints the installed directory on stdout.

    @param args: parsed arguments with archive, data_root, and version.
    """
    check_version(args.version)
    if not os.path.isabs(args.data_root):
        raise RuntimeToolError(f"--data-root must be an absolute path, not {args.data_root!r}")
    runtime_root = os.path.join(args.data_root, "runtime")
    os.makedirs(runtime_root, exist_ok=True)
    target = os.path.join(runtime_root, args.version)
    staging = tempfile.mkdtemp(prefix=f".{args.version}.install-", dir=runtime_root)
    try:
        record, digests = read_archive(args.archive, staging)
        check_archive(args.archive, record, digests, args.version, None)
        os.chmod(staging, 0o755)
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
            merged = {"format": FORMAT, "version": manifest["version"], "godot": manifest["godot"], "artifacts": {}}
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
        if record["godot"] != manifest["godot"]:
            raise RuntimeToolError(f"{path} holds Godot {record['godot']!r}, but {args.manifest} lists {manifest['godot']!r}")
        listed.add(name)
    unlisted = sorted(name for name in os.listdir(args.dir) if name.startswith("libgodot-") and name.endswith(".tar.gz") and name not in listed)
    if unlisted:
        raise RuntimeToolError(f"{args.dir} holds archives that {args.manifest} does not list: {', '.join(unlisted)}")
    print(f"runtime.py: {args.manifest}: {len(listed)} archive(s) match", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser.

    @returns: a parser whose subcommands store their handler as run.
    """
    parser = argparse.ArgumentParser(prog="runtime.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    version_command = commands.add_parser("godot-version", help="print the Godot version of a source tree")
    version_command.add_argument("--source", required=True, help="Godot source directory")
    version_command.set_defaults(run=command_godot_version)

    package = commands.add_parser("package", help="write runtime.json, the archive, and manifest.json")
    package.add_argument("--stage", required=True, help="directory holding the runner and the library")
    package.add_argument("--out", required=True, help="directory for the archive and manifest.json")
    package.add_argument("--version", required=True, help="runtime version")
    package.add_argument("--godot", required=True, help="Godot version of the library")
    package.add_argument("--platform", required=True, choices=PLATFORMS, help="Node.js platform name")
    package.add_argument("--arch", required=True, choices=ARCHES, help="Node.js architecture name")
    package.add_argument("--runner", required=True, help="runner file name in the stage")
    package.add_argument("--library", required=True, help="library file name in the stage")
    package.add_argument("--repository", required=True, help="GitHub repository owner/name that hosts the release")
    package.set_defaults(run=command_package)

    install = commands.add_parser("install", help="install an archive into <data-root>/runtime/<version>/")
    install.add_argument("--archive", required=True, help="runtime archive")
    install.add_argument("--data-root", required=True, help="absolute Godot plugin data root")
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
