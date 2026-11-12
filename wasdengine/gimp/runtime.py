#!/usr/bin/env python3
"""Prepare, package, install, merge, and verify WASD Engine GIMP runtime archives.

build.sh runs the prepare, macho-files, check-links, package, and install
commands for macOS, and the install-setup, prepare-windows, check-imports,
package, and install commands for Windows; the release workflow
(.github/workflows/wasd-gimp.yml) runs merge and verify. BUILD.md describes the
runtime layout, runtime.json, and manifest.json. The script needs only the
standard library of Python 3.8 or newer; check-links also runs otool, and
install-setup runs GIMP's Windows installer, so it runs on Windows only. It
writes UTF-8 with LF line ends to stdout and stderr. Every failure prints one
"runtime.py: error:" line on stderr and exits with status 1.
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
import struct
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
# GIMP's demo extension, plug-in examples in C, Vala, and Python that each open a dialog. On Windows its Vala plug-in reads
# its own path from the ANSI command line, so in a folder outside ASCII it reports that its translation catalog is missing.
DEMO_EXTENSION = "lib/gimp/3.0/extensions/org.gimp.extension.goat-exercises"
# Paths relative to the bundle's Contents that the runtime leaves out: bundle metadata and signatures, headers,
# translations, the GUI icons and themes' icon files, and the demo extension.
UNUSED_PATHS = ("Info.plist", "CodeResources", "_CodeSignature", "include", "Resources/icons", "Resources/locale", DEMO_EXTENSION)
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

# GIMP's Windows installer (Inno Setup) and the switches that install it without a window or a question: per user, without
# Start menu or desktop entries, and only the components that the macOS runtime also holds: GIMP and its libraries,
# Python for the python-fu-eval batch interpreter, Ghostscript for PostScript, and the MyPaint brushes; not the debug
# symbols, the development files, or the translations.
SETUP_COMPONENTS = ("gimpX64", "depsX64", "pyX64", "gsX64", "mypaint")
SETUP_SWITCHES = ("/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/NOCANCEL", "/CURRENTUSER", "/NOICONS", "/TASKS=")
SETUP_TIMEOUT_SECONDS = 1800
# Paths of a Windows install, relative to its folder, that the runtime leaves out: the uninstaller, headers and import
# libraries, the 32-bit TWAIN helper, the hicolor icon theme of the desktop, the scanner plug-in, which only opens
# the scanner's own dialog, and the demo extension.
WINDOWS_UNUSED_PATHS = ("uninst", "include", "lib/pkgconfig", "32", "share/icons", "lib/gimp/3.0/plug-ins/twain", DEMO_EXTENSION)
# Files of a Windows install that the runtime leaves out wherever they are: debug symbols and static libraries.
WINDOWS_UNUSED_FILES = ("*.pdb", "*.a")
# The folder of GIMP's interpreter files, whose programs the installer names by its own absolute folder.
INTERPRETERS = "lib/gimp/3.0/interpreters"
# PE machine type of x64 code.
PE_MACHINE_X64 = 0x8664
# Extensions of the runtime's PE files: programs, libraries, and Python extension modules.
PE_EXTENSIONS = (".exe", ".dll", ".pyd")
# The signature of VS_FIXEDFILEINFO, which starts the fixed part of a program's version resource.
VERSION_SIGNATURE = struct.pack("<I", 0xFEEF04BD)
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
    unused programs, headers, translations, GUI icons, bundle metadata and signatures, the demo extension, Python's
    test suite and other unused standard library folders, and the build tools in site-packages. Every empty folder
    outside __pycache__ gets KEEP_FILE.

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


def runtime_folders(platform: str) -> Dict[str, str]:
    """Return the runtime.json folders of a platform's layout: inside Contents on macOS, at the root on Windows.

    @param platform: Node.js platform name.
    @returns: dataDir, localeDir, and sysconfDir.
    """
    prefix = f"{CONTENTS}/" if platform == "darwin" else ""
    return {"dataDir": f"{prefix}share/gimp/3.0", "localeDir": f"{prefix}share/locale", "sysconfDir": f"{prefix}etc/gimp/3.0"}


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


def run_setup(setup: str, directory: str, log: str) -> None:
    """Install GIMP into a folder with its Windows installer, without a window or a question.

    The installer runs in its per-user mode with the components that SETUP_COMPONENTS names, writes its log, and adds
    no Start menu or desktop entry; its registry entries stay on the machine that builds the runtime.

    @param setup: GIMP's Inno Setup installer.
    @param directory: absolute folder to install into; it must not exist yet.
    @param log: file the installer writes its log to.
    @raises RuntimeToolError: when not on Windows, the folder exists, or the installer fails or runs too long.
    """
    if os.name != "nt":
        raise RuntimeToolError("install-setup runs GIMP's Windows installer, so it runs on Windows only")
    if os.path.lexists(directory):
        raise RuntimeToolError(f"{directory} exists; the installer must install into a new folder")
    command = [setup, *SETUP_SWITCHES, f"/COMPONENTS={','.join(SETUP_COMPONENTS)}", f"/DIR={directory}", f"/LOG={log}"]
    try:
        result = subprocess.run(command, capture_output=True, text=True, errors="replace", timeout=SETUP_TIMEOUT_SECONDS, check=False,
                                creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
    except subprocess.TimeoutExpired as error:
        raise RuntimeToolError(f"{setup} did not finish within {SETUP_TIMEOUT_SECONDS} s; see {log}") from error
    if result.returncode != 0:
        raise RuntimeToolError(f"{setup} failed with exit code {result.returncode}; see {log}")


def windows_file_version(path: str) -> Optional[str]:
    """Read the file version that a Windows program's version resource states.

    @param path: program file.
    @returns: major.minor.micro of VS_FIXEDFILEINFO, such as 3.2.8, or None when the file has no version resource.
    """
    with open(path, "rb") as stream:
        data = stream.read()
    index = data.find(VERSION_SIGNATURE)
    if index < 0 or index + 16 > len(data):
        return None
    most, least = struct.unpack_from("<II", data, index + 8)
    return f"{most >> 16}.{most & 0xFFFF}.{least >> 16}"


def rewrite_interpreters(stage: str) -> List[str]:
    """Name the programs of GIMP's interpreter files by file name instead of the installer's absolute folder.

    GIMP looks a program that its .interp file names without a folder up in the folder of the running GIMP program
    first, which is the runtime's bin folder, so the files work wherever the runtime is unpacked. A program line is
    name=program; a binfmt line is :name:type:offset:magic:mask:program:flags, with its first character as separator.

    @param stage: runtime folder.
    @returns: the '/'-separated paths of the files that changed, relative to the stage.
    """
    folder = os.path.join(stage, *INTERPRETERS.split("/"))
    changed = []
    for name in sorted(os.listdir(folder)) if os.path.isdir(folder) else []:
        if not name.endswith(".interp"):
            continue
        path = os.path.join(folder, name)
        with open(path, encoding="utf-8") as stream:
            lines = stream.read().split("\n")
        rewritten = []
        for line in lines:
            stripped = line.strip()
            if stripped == "" or stripped.startswith("#"):
                rewritten.append(line)
            elif stripped[0] in ":,":
                fields = stripped.split(stripped[0])
                if len(fields) > 6:
                    fields[6] = windows_basename(fields[6])
                rewritten.append(stripped[0].join(fields))
            elif "=" in stripped:
                key, program = stripped.split("=", 1)
                rewritten.append(f"{key}={windows_basename(program)}")
            else:
                rewritten.append(line)
        if rewritten != lines:
            write_text_atomic(path, "\n".join(rewritten))
            changed.append(f"{INTERPRETERS}/{name}")
    return changed


def windows_basename(program: str) -> str:
    """Return the file name of an absolute Windows path, and any other text unchanged.

    @param program: a program as an .interp file names it.
    @returns: the file name after the last separator of a drive or UNC path, else program.
    """
    if re.match(r"^(?:[A-Za-z]:[\\/]|\\\\)", program) is None:
        return program
    return re.split(r"[\\/]", program)[-1]


def path_references(stage: str, folder: str) -> List[str]:
    """List the files of a runtime that name a folder, such as the one the installer installed into.

    @param stage: runtime folder.
    @param folder: absolute folder whose path, with either separator and in UTF-8 or UTF-16, files must not hold, compared
        without regard to case.
    @returns: the '/'-separated paths of the files that hold it, relative to the stage, sorted.
    """
    forms = {folder.replace("/", "\\"), folder.replace("\\", "/")}
    needles = [form.lower().encode(encoding) for form in forms for encoding in ("utf-8", "utf-16-le")]
    found = []
    for directory, _, names in os.walk(stage):
        for name in names:
            path = os.path.join(directory, name)
            with open(path, "rb") as stream:
                data = stream.read().lower()
            if any(needle in data for needle in needles):
                found.append(os.path.relpath(path, stage).replace(os.sep, "/"))
    return sorted(found)


def prepare_windows(stage: str, installed: str) -> str:
    """Turn a GIMP install made by its Windows installer into the runtime layout, in place, and return the GIMP version.

    The layout keeps the install's bin, lib, share, and etc folders. The runtime drops the uninstaller, debug symbols,
    the GUI program and the other unused programs, headers and import libraries, translations, the desktop icon theme,
    the scanner plug-in, the demo extension, Python's test suite and other unused standard library folders, and build
    tools in site-packages; it names the programs of the interpreter files by file name, keeps an empty share/locale
    with KEEP_FILE, and gives every other empty folder KEEP_FILE.

    @param stage: the install folder.
    @param installed: the absolute folder the installer installed into, which no file may name afterwards.
    @returns: the GIMP version of the console program's version resource, such as 3.2.8.
    @raises RuntimeToolError: when the console program or its version is missing, or a file still names the install folder.
    """
    binaries = os.path.join(stage, "bin")
    consoles = sorted(name for name in os.listdir(binaries) if re.match(r"^gimp-console-\d+\.\d+\.exe\Z", name)) if os.path.isdir(binaries) else []
    if len(consoles) != 1:
        raise RuntimeToolError(f"{binaries} holds {len(consoles)} versioned gimp-console programs, not one; the install is not GIMP 3 for Windows")
    version = windows_file_version(os.path.join(binaries, consoles[0]))
    if version is None or GIMP_PATTERN.match(version) is None or consoles[0] != f"{console_name(version)}.exe":
        raise RuntimeToolError(f"{consoles[0]} states the version {version!r}, which does not match its name")

    for relative in WINDOWS_UNUSED_PATHS:
        remove_path(os.path.join(stage, *relative.split("/")))
    gui = re.compile(r"^gimp-\d+(?:\.\d+)*\.exe\Z")
    for name in sorted(os.listdir(binaries)):
        if gui.match(name) or any(fnmatch.fnmatchcase(name.lower(), pattern) for pattern in UNUSED_PROGRAMS):
            remove_path(os.path.join(binaries, name))
    for directory, _, names in os.walk(stage):
        for name in names:
            if any(fnmatch.fnmatchcase(name.lower(), pattern) for pattern in WINDOWS_UNUSED_FILES):
                os.unlink(os.path.join(directory, name))
    remove_path(os.path.join(stage, "share", "locale"))
    os.makedirs(os.path.join(stage, "share", "locale"))
    library = os.path.join(stage, "lib")
    for name in sorted(os.listdir(library)) if os.path.isdir(library) else []:
        if re.match(r"^python3\.\d+\Z", name):
            remove_matching(os.path.join(library, name), UNUSED_STDLIB)
            remove_matching(os.path.join(library, name, "site-packages"), UNUSED_SITE_PACKAGES)
    rewrite_interpreters(stage)

    for directory, folders, names in os.walk(stage, topdown=False):
        if not os.listdir(directory) and os.path.basename(directory) != "__pycache__":
            write_text_atomic(os.path.join(directory, KEEP_FILE), KEEP_TEXT)
    references = path_references(stage, installed)
    if references:
        raise RuntimeToolError(f"{len(references)} files name the install folder {installed}: {', '.join(references[:5])}")
    return version


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


def command_install_setup(args: argparse.Namespace) -> None:
    """Install GIMP into a new folder with its Windows installer.

    @param args: parsed arguments with setup, dir, and log.
    """
    run_setup(os.path.abspath(args.setup), os.path.abspath(args.dir), os.path.abspath(args.log))
    print(f"runtime.py: installed GIMP into {os.path.abspath(args.dir)}", file=sys.stderr)


def command_prepare_windows(args: argparse.Namespace) -> None:
    """Turn a GIMP install made by its Windows installer into the runtime layout and print the GIMP version on stdout.

    @param args: parsed arguments with stage and installed.
    """
    print(prepare_windows(args.stage, args.installed))


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
        **runtime_folders(args.platform),
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

    setup = commands.add_parser("install-setup", help="install GIMP into a new folder with its Windows installer (Windows only)")
    setup.add_argument("--setup", required=True, help="GIMP's Windows installer")
    setup.add_argument("--dir", required=True, help="new folder to install into")
    setup.add_argument("--log", required=True, help="file for the installer's log")
    setup.set_defaults(run=command_install_setup)

    windows = commands.add_parser("prepare-windows", help="turn a GIMP install for Windows into the runtime layout")
    windows.add_argument("--stage", required=True, help="the install folder")
    windows.add_argument("--installed", required=True, help="absolute folder the installer installed into, which no file may name")
    windows.set_defaults(run=command_prepare_windows)

    imports = commands.add_parser("check-imports", help="check that every library a PE file loads resolves inside the runtime or to Windows")
    imports.add_argument("--stage", required=True, help="runtime folder")
    imports.add_argument("--folder", action="append", required=True, help="library folder relative to the stage, such as bin; repeatable")
    imports.set_defaults(run=command_check_imports)

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
