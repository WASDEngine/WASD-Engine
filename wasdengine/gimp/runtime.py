#!/usr/bin/env python3
"""Prepare, package, install, merge, and verify WASD Engine GIMP runtime archives.

build.sh runs the prepare, macho-files, check-links, package, and install
commands; the release workflow (.github/workflows/wasd-gimp.yml) runs merge and
verify. BUILD.md describes the runtime layout, runtime.json, and manifest.json.
The script needs only the standard library of Python 3.8 or newer; check-links
also runs otool. It writes UTF-8 with LF line ends to stdout and stderr. Every
failure prints one "runtime.py: error:" line on stderr and exits with status 1.
"""

from __future__ import annotations

import argparse
import fnmatch
import gzip
import hashlib
import io
import json
import os
import plistlib
import re
import shutil
import stat
import subprocess
import sys
import tarfile
import tempfile
import time
from typing import IO, Any, Dict, List, Optional, Tuple

RUNTIME_FILE = "runtime.json"
MANIFEST_FILE = "manifest.json"
PLATFORMS = ("darwin", "linux", "win32")
ARCHES = ("arm64", "x64")
# The GIMP plugin (packages/gamedev/gimp/src/environment.ts) and Desktop packaging
# (apps/desktop/scripts/wasdengine-gimp.ts) read both files; FORMAT changes only with them.
FORMAT = 1
RUNTIME_FIELDS = ("format", "version", "gimp", "platform", "arch", "console", "dataDir", "localeDir", "sysconfDir", "sha256")
DIRECTORY_FIELDS = ("dataDir", "localeDir", "sysconfDir")
MANIFEST_FIELDS = ("format", "version", "gimp", "artifacts")
ARTIFACT_FIELDS = ("url", "bytes", "sha256")
# The patterns end in \Z, which rejects a trailing newline that $ accepts.
# The version names files, a URL path segment, and the Git tag gimp-<version>.
VERSION_PATTERN = re.compile(r"^[0-9A-Za-z][0-9A-Za-z._+-]*\Z")
# GIMP's version as its application bundle states it: 3.2.8, or 3.3.0-RC1.
GIMP_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-?[A-Za-z0-9_.]+)?\Z")
REPOSITORY_PATTERN = re.compile(r"^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+\Z")
# One part of a runtime path: a file or folder name that does not start with a dot. GIMP's brush and
# script files also use '#', '%', and parentheses.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,#%()-][A-Za-z0-9 _.+@=,#%()-]*\Z")
SHA256_PATTERN = re.compile(r"^[0-9a-f]{64}\Z")
ARTIFACT_KEY_PATTERN = re.compile(r"^(?:darwin|linux|win32)-(?:arm64|x64)\Z")
COPY_CHUNK_BYTES = 1 << 20
RUNTIME_FILE_MAX_BYTES = 16 << 20
NAME_MAX_LENGTH = 200
MACH_O_MAGICS = (b"\xcf\xfa\xed\xfe", b"\xce\xfa\xed\xfe", b"\xca\xfe\xba\xbe", b"\xfe\xed\xfa\xcf", b"\xfe\xed\xfa\xce")
# The folder of the runtime that holds GIMP's bundle contents. GIMP finds its plug-ins, fonts, and libraries relative to
# the bundle that macOS derives from <bundle>/Contents/MacOS/<program>, so the folder keeps that name; the runtime
# folder above it is no application bundle, because it has no .app name and no Info.plist.
CONTENTS = "Contents"
# The file that keeps an otherwise empty folder in archives, which hold plain files only.
KEEP_FILE = "wasd-engine-folder.txt"
KEEP_TEXT = (
    "WASD Engine's GIMP runtime keeps this folder empty; GIMP looks for it, and this file keeps it in archives,\n"
    "which hold files only.\n"
)
# Programs of GIMP's macOS bundle that the tools never run: the debug dialog, a clipboard test, and the plug-in
# build helper. The bundle's own executable, the GUI program, goes too.
UNUSED_PROGRAMS = ("gimp-debug-tool*", "gimp-test-clipboard*", "gimptool*")
# Paths relative to the bundle's Contents that the runtime leaves out: bundle metadata and signatures, headers,
# translations, and the GUI icons and themes' icon files.
UNUSED_PATHS = ("Info.plist", "CodeResources", "_CodeSignature", "include", "Resources/icons", "Resources/locale")
UNUSED_RESOURCE_FILES = ("*.icns", "Assets.car")
# Python standard library folders that GIMP's Python never imports: the test suite, the IDE, Tk, turtle demos, and pip's installer.
UNUSED_STDLIB = ("test", "idlelib", "tkinter", "turtledemo", "ensurepip")
# Build and documentation tools that GIMP's macOS build leaves in site-packages; no plug-in imports them.
# sitecustomize.py imports certifi, which stays.
UNUSED_SITE_PACKAGES = (
    "_distutils_hack", "distutils-precedence.pth", "setuptools", "setuptools-*.dist-info", "mesonbuild", "meson-*.dist-info",
    "gidocgen", "gi_docgen-*.dist-info", "jinja2", "jinja2-*.dist-info", "mako", "mako-*.dist-info", "markdown",
    "markdown-*.dist-info", "markupsafe", "markupsafe-*.dist-info", "pygments", "pygments-*.dist-info", "smartypants.py",
    "smartypants-*.dist-info", "typogrify", "typogrify-*.dist-info", "toml", "toml-*.dist-info", "packaging",
    "packaging-*.dist-info",
)

Record = Dict[str, Any]


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
    @returns: gimp-<version>-<key>.tar.gz.
    """
    return f"gimp-{version}-{key}.tar.gz"


def release_url(repository: str, version: str, file_name: str) -> str:
    """Return the download URL of a file attached to the GitHub release gimp-<version>.

    @param repository: GitHub repository as owner/name.
    @param version: runtime version.
    @param file_name: release asset name.
    @returns: https://github.com/<repository>/releases/download/gimp-<version>/<file_name>.
    """
    return f"https://github.com/{repository}/releases/download/gimp-{version}/{file_name}"


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

    console names the gimp-console program inside Contents; dataDir, localeDir, and sysconfDir
    name the folders that the plugin passes to GIMP as GIMP3_DATADIR,
    GIMP3_LOCALEDIR, and GIMP3_SYSCONFDIR; sha256 maps the path of every file of
    the runtime except runtime.json to its digest.

    @param value: parsed runtime.json.
    @param where: file description for error messages.
    @returns: the validated record.
    @raises RuntimeToolError: when a field is missing, unknown, or invalid.
    """
    record = require_fields(value, RUNTIME_FIELDS, where)
    check_format(record, where)
    check_version(require_string(record, "version", where))
    require_string(record, "gimp", where, GIMP_PATTERN)
    if record["platform"] not in PLATFORMS or record["arch"] not in ARCHES:
        raise RuntimeToolError(f"{where}: platform {record['platform']!r} and arch {record['arch']!r} are not supported")
    for field in ("console", *DIRECTORY_FIELDS):
        if not is_runtime_path(require_string(record, field, where)):
            raise RuntimeToolError(f"{where}: {field} {record[field]!r} is not a relative path inside the runtime")
    digests = record["sha256"]
    if not isinstance(digests, dict):
        raise RuntimeToolError(f"{where}: sha256 must be a JSON object")
    for path, digest in digests.items():
        if not is_runtime_path(path):
            raise RuntimeToolError(f"{where}: sha256 lists {path!r}, which is not a relative path inside the runtime")
        if not isinstance(digest, str) or SHA256_PATTERN.match(digest) is None:
            raise RuntimeToolError(f"{where}: sha256.{path} is not a SHA-256 digest")
    if record["console"] not in digests:
        raise RuntimeToolError(f"{where}: sha256 does not list {record['console']}")
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
    require_string(manifest, "gimp", where, GIMP_PATTERN)
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
        "gimp": manifest["gimp"],
        "artifacts": {key: artifacts[key] for key in sorted(artifacts)},
    })


def check_same_release(base: Record, other: Record, where: str) -> None:
    """Require two manifests to describe the same runtime version and GIMP version.

    @param base: manifest being extended.
    @param other: manifest merged into it.
    @param where: description of other for error messages.
    @raises RuntimeToolError: when either version differs.
    """
    for field in ("version", "gimp"):
        if base[field] != other[field]:
            raise RuntimeToolError(
                f"{where} has {field} {other[field]!r}, not {base[field]!r}; "
                "one manifest holds the archives of one runtime version built from one GIMP version"
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
    """Tell whether a symbolic link of GIMP's macOS bundle is one the runtime replaces or drops.

    The runtime holds no links: aliases of programs and libraries are not loaded by name, Contents/share
    and Resources/share/locale become real folders when Resources moves to share, and Python.app's
    Contents/share link is replaced by GIMP3_DATADIR, GIMP3_LOCALEDIR, and GIMP3_SYSCONFDIR.

    @param relative: '/'-separated path of the link relative to Contents.
    @returns: whether the link is one of these.
    """
    parts = relative.split("/")
    if len(parts) == 2 and parts[0] == "MacOS":
        return True
    if len(parts) == 2 and parts[0] == "lib" and parts[1].endswith(".dylib"):
        return True
    if relative in ("share", "Resources/share/locale"):
        return True
    return fnmatch.fnmatchcase(relative, "lib/Python.framework/Versions/*/Resources/Python.app/Contents/share")


def prepare(contents: str) -> str:
    """Turn a copy of GIMP.app/Contents into the runtime layout, in place, and return the GIMP version.

    The layout keeps GIMP's MacOS, lib, and etc folders; Resources moves to share, the folder GIMP and its
    libraries read through the bundle's share link, and an empty Resources folder stays, because GIMP sets up its
    bundled libraries only when that folder exists. The runtime drops debug symbols, the GUI program and the other
    unused programs, headers, translations, GUI icons, bundle metadata and signatures, Python's test suite and
    other unused standard library folders, and the build tools in site-packages. Every empty folder outside
    __pycache__ gets KEEP_FILE.

    @param contents: copy of a GIMP 3 application bundle's Contents folder.
    @returns: the GIMP version from Info.plist, such as 3.2.8.
    @raises RuntimeToolError: when Info.plist or the console program is missing, or the bundle holds an unexpected link.
    """
    try:
        with open(os.path.join(contents, "Info.plist"), "rb") as stream:
            info = plistlib.load(stream)
    except (OSError, plistlib.InvalidFileException) as error:
        raise RuntimeToolError(f"{contents} has no readable Info.plist; pass the Contents folder of GIMP.app") from error
    version = info.get("CFBundleShortVersionString")
    gui = info.get("CFBundleExecutable")
    if not isinstance(version, str) or GIMP_PATTERN.match(version) is None or not isinstance(gui, str) or "/" in gui:
        raise RuntimeToolError(f"{contents}/Info.plist does not name a GIMP version and program")
    console = os.path.join(contents, "MacOS", console_name(version))
    if not os.path.isfile(console) or os.path.islink(console):
        raise RuntimeToolError(f"{console} is missing; the bundle is not GIMP {version} for macOS")

    for directory, folders, _ in os.walk(contents):
        for name in [name for name in folders if name.endswith(".dSYM") and not os.path.islink(os.path.join(directory, name))]:
            shutil.rmtree(os.path.join(directory, name))
        folders[:] = [name for name in folders if not name.endswith(".dSYM")]
    for directory, folders, names in os.walk(contents):
        for name in folders + names:
            path = os.path.join(directory, name)
            if os.path.islink(path):
                if not is_dropped_link(os.path.relpath(path, contents).replace(os.sep, "/")):
                    raise RuntimeToolError(f"{path} is a link that the runtime layout does not know; update prepare for this GIMP build")
                os.unlink(path)
        folders[:] = [name for name in folders if os.path.isdir(os.path.join(directory, name))]

    remove_path(os.path.join(contents, "MacOS", gui))
    remove_matching(os.path.join(contents, "MacOS"), UNUSED_PROGRAMS)
    for relative in UNUSED_PATHS:
        remove_path(os.path.join(contents, *relative.split("/")))
    remove_matching(os.path.join(contents, "Resources"), UNUSED_RESOURCE_FILES)
    resources_share = os.path.join(contents, "Resources", "share")
    if os.path.isdir(resources_share) and not os.listdir(resources_share):
        os.rmdir(resources_share)
    versions = os.path.join(contents, "lib", "Python.framework", "Versions")
    for python in sorted(os.listdir(versions)) if os.path.isdir(versions) else []:
        framework = os.path.join(versions, python)
        for relative in ("_CodeSignature", "Resources/Info.plist"):
            remove_path(os.path.join(framework, *relative.split("/")))
        app = os.path.join(framework, "Resources", "Python.app", "Contents")
        for relative in ("Info.plist", "PkgInfo", "_CodeSignature", "Resources"):
            remove_path(os.path.join(app, relative))
        library = os.path.join(framework, "lib", f"python{python}")
        remove_matching(library, UNUSED_STDLIB)
        remove_matching(os.path.join(library, "site-packages"), UNUSED_SITE_PACKAGES)

    share = os.path.join(contents, "share")
    if os.path.lexists(share):
        raise RuntimeToolError(f"{share} exists after its link was removed; the bundle layout is not GIMP's")
    os.rename(os.path.join(contents, "Resources"), share)
    os.makedirs(os.path.join(contents, "Resources"))
    os.makedirs(os.path.join(share, "locale"), exist_ok=True)
    for directory, folders, names in os.walk(contents):
        if not folders and not names and os.path.basename(directory) != "__pycache__":
            write_text_atomic(os.path.join(directory, KEEP_FILE), KEEP_TEXT)
    return version


def console_name(gimp: str) -> str:
    """Return the console program name of a GIMP version.

    @param gimp: GIMP version such as 3.2.8.
    @returns: gimp-console-<major>.<minor>, such as gimp-console-3.2.
    """
    major, minor = gimp.split(".")[:2]
    return f"gimp-console-{major}.{minor}"


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
    """Run otool and return its output lines after the first, which names the file.

    @param arguments: otool arguments ending with the file.
    @returns: the remaining output lines.
    @raises RuntimeToolError: when otool fails.
    """
    result = subprocess.run(["otool", *arguments], capture_output=True, text=True, check=False)
    if result.returncode != 0:
        raise RuntimeToolError(f"otool {' '.join(arguments)} failed: {result.stderr.strip()}")
    return result.stdout.splitlines()[1:]


def unresolved_libraries(contents: str, binary: str) -> List[str]:
    """List the libraries one Mach-O file loads that resolve to no plain file inside Contents or the system.

    @rpath names resolve through the file's own LC_RPATH entries and Contents/lib, which the programs' rpath
    names; @loader_path is the file's folder; @executable_path is Contents/MacOS.

    @param contents: the runtime's Contents folder.
    @param binary: Mach-O file inside it.
    @returns: the unresolved load commands, as otool prints them.
    """
    folder = os.path.dirname(binary)
    executables = os.path.join(contents, "MacOS")

    def expand(name: str) -> str:
        if name.startswith("@loader_path/"):
            return os.path.normpath(os.path.join(folder, name[len("@loader_path/"):]))
        if name.startswith("@executable_path/"):
            return os.path.normpath(os.path.join(executables, name[len("@executable_path/"):]))
        return name

    lines = otool(["-l", binary])
    rpaths = [expand(lines[index + 2].split()[1]) for index, line in enumerate(lines) if line.strip() == "cmd LC_RPATH"]
    rpaths.append(os.path.join(contents, "lib"))
    # A library's own install name, which otool -L lists first, is not a library it loads.
    own = {line.strip() for line in otool(["-D", binary])}
    inside = os.path.realpath(contents) + os.sep
    unresolved = []
    for line in otool(["-L", binary]):
        name = line.strip().split(" (")[0]
        if name in own or name.startswith("/usr/lib/") or name.startswith("/System/Library/"):
            continue
        if name.startswith("@rpath/"):
            candidates = [os.path.join(rpath, name[len("@rpath/"):]) for rpath in rpaths]
        elif name.startswith("@"):
            candidates = [expand(name)]
        else:
            candidates = []
        if not any(os.path.isfile(path) and not os.path.islink(path) and os.path.realpath(path).startswith(inside) for path in candidates):
            unresolved.append(name)
    return unresolved


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


def command_prepare(args: argparse.Namespace) -> None:
    """Turn a copy of GIMP.app/Contents into the runtime layout and print the GIMP version on stdout.

    @param args: parsed arguments with contents.
    """
    print(prepare(args.contents))


def command_macho_files(args: argparse.Namespace) -> None:
    """Print the Mach-O files of a staged runtime, each followed by a NUL byte, for xargs -0.

    @param args: parsed arguments with stage.
    """
    sys.stdout.write("".join(f"{path}\0" for path in macho_files(args.stage)))


def command_check_links(args: argparse.Namespace) -> None:
    """Require every library that a Mach-O file of the runtime loads to resolve inside Contents or the system.

    @param args: parsed arguments with contents.
    """
    binaries = macho_files(args.contents)
    problems = [f"{os.path.relpath(binary, args.contents)} loads {name}" for binary in binaries for name in unresolved_libraries(args.contents, binary)]
    if problems:
        raise RuntimeToolError(f"{len(problems)} libraries do not resolve inside Contents: {'; '.join(problems[:5])}")
    print(f"runtime.py: the libraries of {len(binaries)} Mach-O files resolve inside Contents or the system", file=sys.stderr)


def command_package(args: argparse.Namespace) -> None:
    """Write runtime.json into the stage, archive the stage, and record the archive in manifest.json.

    Prints the archive path on stdout and a summary on stderr. An existing
    manifest.json in the output directory keeps its other artifacts and must
    describe the same runtime and GIMP versions.

    @param args: parsed arguments with stage, out, version, gimp, platform, arch, console, and repository.
    """
    check_version(args.version)
    if REPOSITORY_PATTERN.match(args.repository) is None:
        raise RuntimeToolError(f"invalid repository {args.repository!r}: use owner/name")
    files = stage_files(args.stage)
    if files.get(args.console) != 0o755:
        raise RuntimeToolError(f"{os.path.join(args.stage, args.console)} is not an executable file in the stage")
    record = parse_runtime({
        "format": FORMAT,
        "version": args.version,
        "gimp": args.gimp,
        "platform": args.platform,
        "arch": args.arch,
        "console": args.console,
        "dataDir": f"{CONTENTS}/share/gimp/3.0",
        "localeDir": f"{CONTENTS}/share/locale",
        "sysconfDir": f"{CONTENTS}/etc/gimp/3.0",
        "sha256": {name: sha256_file(os.path.join(args.stage, *name.split("/"))) for name in sorted(files)},
    }, RUNTIME_FILE)
    write_text_atomic(os.path.join(args.stage, RUNTIME_FILE), json_text(record))

    key = f"{args.platform}-{args.arch}"
    name = archive_name(args.version, key)
    archive = os.path.join(args.out, name)
    write_archive(archive, args.stage, [(path, files[path]) for path in sorted(files)] + [(RUNTIME_FILE, 0o644)], archive_mtime())
    artifact = {"url": release_url(args.repository, args.version, name), "bytes": os.path.getsize(archive), "sha256": sha256_file(archive)}

    manifest_path = os.path.join(args.out, MANIFEST_FILE)
    manifest: Record = {"format": FORMAT, "version": args.version, "gimp": args.gimp, "artifacts": {}}
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
            merged = {"format": FORMAT, "version": manifest["version"], "gimp": manifest["gimp"], "artifacts": {}}
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
        if record["gimp"] != manifest["gimp"]:
            raise RuntimeToolError(f"{path} holds GIMP {record['gimp']!r}, but {args.manifest} lists {manifest['gimp']!r}")
        listed.add(name)
    unlisted = sorted(name for name in os.listdir(args.dir) if name.startswith("gimp-") and name.endswith(".tar.gz") and name not in listed)
    if unlisted:
        raise RuntimeToolError(f"{args.dir} holds archives that {args.manifest} does not list: {', '.join(unlisted)}")
    print(f"runtime.py: {args.manifest}: {len(listed)} archive(s) match", file=sys.stderr)


def build_parser() -> argparse.ArgumentParser:
    """Build the command-line parser.

    @returns: a parser whose subcommands store their handler as run.
    """
    parser = argparse.ArgumentParser(prog="runtime.py", description=__doc__.splitlines()[0])
    commands = parser.add_subparsers(dest="command", required=True)

    prepare_command = commands.add_parser("prepare", help="turn a copy of GIMP.app/Contents into the runtime layout")
    prepare_command.add_argument("--contents", required=True, help="copy of the Contents folder of GIMP.app")
    prepare_command.set_defaults(run=command_prepare)

    macho = commands.add_parser("macho-files", help="print the Mach-O files of a staged runtime, NUL-separated")
    macho.add_argument("--stage", required=True, help="runtime folder")
    macho.set_defaults(run=command_macho_files)

    links = commands.add_parser("check-links", help="check that every library a Mach-O file loads resolves inside Contents")
    links.add_argument("--contents", required=True, help="the runtime's Contents folder")
    links.set_defaults(run=command_check_links)

    package = commands.add_parser("package", help="write runtime.json, the archive, and manifest.json")
    package.add_argument("--stage", required=True, help="directory holding the runtime tree")
    package.add_argument("--out", required=True, help="directory for the archive and manifest.json")
    package.add_argument("--version", required=True, help="runtime version")
    package.add_argument("--gimp", required=True, help="GIMP version of the programs")
    package.add_argument("--platform", required=True, choices=PLATFORMS, help="Node.js platform name")
    package.add_argument("--arch", required=True, choices=ARCHES, help="Node.js architecture name")
    package.add_argument("--console", required=True, help="path of gimp-console relative to the stage")
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
