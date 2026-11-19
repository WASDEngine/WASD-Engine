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
What it shares with the other tools' runtime scripts is in ../runtime_archive.py, which it imports.
"""

from __future__ import annotations

import argparse
import functools
import fnmatch
import io
import os
import plistlib
import re
import shutil
import struct
import subprocess
import sys
from typing import Any, Dict, List, Optional

# The functions every tool's runtime script shares (../runtime_archive.py); python -I leaves this script's folder
# off sys.path, so the folder above it goes on.
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import runtime_archive as shared  # noqa: E402
from runtime_archive import (  # noqa: E402, F401 - also this script's names for its tests
    ARCHES,
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
    pe_imports,
    Record,
    remove_matching,
    remove_path,
    require_fields,
    require_string,
    RuntimeToolError,
    sha256_file,
    write_text_atomic,
)

RUNTIME_FIELDS = ("format", "version", "gimp", "platform", "arch", "console", "dataDir", "localeDir", "sysconfDir", "sha256")
DIRECTORY_FIELDS = ("dataDir", "localeDir", "sysconfDir")
# GIMP's version as its application bundle states it: 3.2.8, or 3.3.0-RC1.
GIMP_PATTERN = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-?[A-Za-z0-9_.]+)?\Z")
# One part of a runtime path: a file or folder name that does not start with a dot. GIMP's brush and
# script files also use '#', '%', and parentheses.
NAME_PATTERN = re.compile(r"^[A-Za-z0-9_+@=,#%()-][A-Za-z0-9 _.+@=,#%()-]*\Z")
RUNTIME_FILE_MAX_BYTES = 16 << 20
# The folder of the runtime that holds GIMP's bundle contents. GIMP finds its plug-ins, fonts, and libraries relative to
# the bundle that macOS derives from <bundle>/Contents/MacOS/<program>, so the folder keeps that name; the runtime
# folder above it is no application bundle, because it has no .app name and no Info.plist.
CONTENTS = "Contents"
KEEP_TEXT = (
    "WASD Engine's GIMP runtime keeps this folder empty; GIMP looks for it, and this file keeps it in archives,\n"
    "which hold files only.\n"
)
# Programs of GIMP's macOS bundle that the tools never run: the debug dialog, a clipboard test, and the plug-in
# build helper. The bundle's own executable, the GUI program, goes too.
UNUSED_PROGRAMS = ("gimp-debug-tool*", "gimp-test-clipboard*", "gimptool*")
# The folder of GIMP's system extensions. GIMP needs none there and reports, at each start, every file in it that is no
# extension, so the runtime removes the folder once it is empty instead of keeping it with KEEP_FILE.
EXTENSIONS = "lib/gimp/3.0/extensions"
# GIMP's demo extension, plug-in examples in C, Vala, and Python that each open a dialog, and the only extension GIMP
# installs. On Windows its Vala plug-in reads its own path from the ANSI command line, so in a folder outside ASCII it
# reports that its translation catalog is missing.
DEMO_EXTENSION = f"{EXTENSIONS}/org.gimp.extension.goat-exercises"
# GIMP's RAW loaders, which hand a RAW file to darktable, RawTherapee, or ART and wait while that program's window is
# open; a headless runtime keeps none of them, and file-raw-placeholder then refuses RAW files instead.
RAW_EDITOR_PLUG_INS = tuple(
    f"lib/gimp/3.0/plug-ins/{name}" for name in ("file-darktable", "file-rawtherapee", "file-another-rawtherapee")
)
# Paths relative to the bundle's Contents that the runtime leaves out: bundle metadata and signatures, headers,
# translations, the GUI icons and themes' icon files, the demo extension, and the RAW loaders.
UNUSED_PATHS = (
    "Info.plist", "CodeResources", "_CodeSignature", "include", "Resources/icons", "Resources/locale", DEMO_EXTENSION,
    *RAW_EDITOR_PLUG_INS,
)
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
# the scanner's own dialog, the demo extension, and the RAW loaders.
WINDOWS_UNUSED_PATHS = (
    "uninst", "include", "lib/pkgconfig", "32", "share/icons", "lib/gimp/3.0/plug-ins/twain", DEMO_EXTENSION,
    *RAW_EDITOR_PLUG_INS,
)
# Files of a Windows install that the runtime leaves out wherever they are: debug symbols and static libraries.
WINDOWS_UNUSED_FILES = ("*.pdb", "*.a")
# The folder of GIMP's interpreter files, whose programs the installer names by its own absolute folder.
INTERPRETERS = "lib/gimp/3.0/interpreters"
# Extensions of the runtime's PE files: programs, libraries, and Python extension modules.
PE_EXTENSIONS = (".exe", ".dll", ".pyd")
# The signature of VS_FIXEDFILEINFO, which starts the fixed part of a program's version resource.
VERSION_SIGNATURE = struct.pack("<I", 0xFEEF04BD)


def is_runtime_path(path: str) -> bool:
    """Tell whether a path can name a file inside a runtime: relative, '/'-separated, without empty, '.', or '..' parts.

    @param path: candidate path.
    @returns: whether every part matches NAME_PATTERN and the path is not runtime.json itself.
    """
    parts = path.split("/")
    return path != RUNTIME_FILE and all(len(part) <= NAME_MAX_LENGTH and NAME_PATTERN.match(part) is not None for part in parts)


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


def remove_empty_folder(path: str) -> None:
    """Delete a folder that holds nothing; a missing folder, a link, or a folder with entries stays as it is.

    @param path: folder path.
    """
    if os.path.isdir(path) and not os.path.islink(path) and not os.listdir(path):
        os.rmdir(path)


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
    unused programs, headers, translations, GUI icons, bundle metadata and signatures, the demo extension and the
    extensions folder that it leaves empty, Python's test suite and other unused standard library folders, and the build
    tools in site-packages. Every other empty folder outside __pycache__ gets KEEP_FILE.

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
    remove_empty_folder(os.path.join(contents, *EXTENSIONS.split("/")))
    remove_matching(os.path.join(contents, "Resources"), UNUSED_RESOURCE_FILES)
    remove_empty_folder(os.path.join(contents, "Resources", "share"))
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
    the scanner plug-in, the demo extension and the extensions folder that it leaves empty, Python's test suite and other
    unused standard library folders, and build tools in site-packages; it names the programs of the interpreter files by
    file name, keeps an empty share/locale with KEEP_FILE, and gives every other empty folder KEEP_FILE.

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
    remove_empty_folder(os.path.join(stage, *EXTENSIONS.split("/")))
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


def command_prepare(args: argparse.Namespace) -> None:
    """Turn a copy of GIMP.app/Contents into the runtime layout and print the GIMP version on stdout.

    @param args: parsed arguments with contents.
    """
    print(prepare(args.contents))


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


TOOL = shared.Tool(
    name="gimp",
    upstream="gimp",
    label="GIMP",
    upstream_pattern=GIMP_PATTERN,
    runtime_file_max_bytes=RUNTIME_FILE_MAX_BYTES,
    parse_runtime=parse_runtime,
    is_runtime_path=is_runtime_path,
    gnu_format=True,
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
    if isinstance(sys.stdout, io.TextIOWrapper):
        sys.stdout.reconfigure(encoding="utf-8", newline="\n")
    if isinstance(sys.stderr, io.TextIOWrapper):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace", newline="\n")
    sys.exit(main())
