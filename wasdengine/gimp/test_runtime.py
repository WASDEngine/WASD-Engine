"""Tests for runtime.py: preparing GIMP's macOS bundle and Windows install, and packaging, installing, merging, and verifying runtime archives.

Run with: python3 -B -m unittest discover --start-directory wasdengine/gimp --pattern 'test_*.py'
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import plistlib
import shutil
import struct
import subprocess
import tarfile
import tempfile
import unittest
from typing import Dict, List, Tuple
from unittest import mock

SPEC = importlib.util.spec_from_file_location("gimp_runtime", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime.py"))
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

VERSION = "3.2.8-wasd.1"
GIMP = "3.2.8"
EPOCH = 1_700_000_000
BASE_URL = f"https://github.com/WASDEngine/WASD-Engine/releases/download/gimp-{VERSION}/"
CONSOLE = "Contents/MacOS/gimp-console-3.2"
# A runtime tree in miniature: the console, one library, data, a translation-free locale folder, configuration, and the license.
FILES: Dict[str, Tuple[bytes, int]] = {
    CONSOLE: (b"console bytes", 0o755),
    "Contents/lib/libgimpbase-3.0.0.dylib": (b"library bytes", 0o644),
    "Contents/share/gimp/3.0/brushes/arrow#1.myb": (b"brush", 0o644),
    "Contents/share/locale/wasd-engine-folder.txt": (b"keep", 0o644),
    "Contents/etc/gimp/3.0/gimprc": (b"# gimprc", 0o644),
    "Contents/Resources/wasd-engine-folder.txt": (b"keep", 0o644),
    "COPYING": (b"GPL", 0o644),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class PrepareTest(unittest.TestCase):
    """prepare turns a copy of GIMP.app/Contents into the runtime layout."""

    def setUp(self) -> None:
        self.contents = os.path.join(tempfile.mkdtemp(prefix="gimp-prepare-test-"), "Contents")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.contents))

    def file(self, relative: str, data: bytes = b"x", mode: int = 0o644) -> None:
        path = os.path.join(self.contents, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(data)
        os.chmod(path, mode)

    def link(self, relative: str, target: str) -> None:
        path = os.path.join(self.contents, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)

    def bundle(self) -> None:
        """A GIMP 3.2.8 bundle in miniature, with the links, metadata, and unused files of the official build."""
        self.file("Info.plist", plistlib.dumps({"CFBundleShortVersionString": GIMP, "CFBundleExecutable": "gimp-3.2"}))
        self.file("CodeResources")
        self.file("_CodeSignature/CodeResources")
        self.file("MacOS/gimp-3.2", mode=0o755)
        self.file("MacOS/gimp-console-3.2", mode=0o755)
        self.file("MacOS/python3", mode=0o755)
        self.file("MacOS/gimp-debug-tool-3.2", mode=0o755)
        self.file("MacOS/gimptool-3.2", mode=0o755)
        self.file("MacOS/gimp-console-3.2.dSYM/Contents/Resources/DWARF/gimp-console-3.2")
        self.link("MacOS/gimp-console", "gimp-console-3.2")
        self.link("MacOS/gimp", "gimp-3.2")
        self.file("lib/libglib-2.0.0.dylib")
        self.link("lib/libglib-2.0.dylib", "libglib-2.0.0.dylib")
        self.file("lib/gimp/3.0/plug-ins/python-eval/python-eval.py", mode=0o755)
        self.file("include/gimp-3.0/libgimp/gimp.h")
        self.file("etc/gimp/3.0/gimprc")
        self.file("Resources/gimp/3.0/brushes/arrow#1.myb")
        self.file("Resources/gimp/3.0/fonts/.placeholder-removed-below")
        os.unlink(os.path.join(self.contents, "Resources/gimp/3.0/fonts/.placeholder-removed-below"))
        self.file("Resources/icons/hicolor/index.theme")
        self.file("Resources/locale/de/LC_MESSAGES/gimp30.mo")
        self.file("Resources/AppIcon.icns")
        self.file("Resources/Assets.car")
        self.link("Resources/share/locale", "../locale")
        self.link("share", "Resources")
        framework = "lib/Python.framework/Versions/3.14"
        self.file(f"{framework}/Python")
        self.file(f"{framework}/_CodeSignature/CodeResources")
        self.file(f"{framework}/Resources/Info.plist")
        self.file(f"{framework}/Resources/Python.app/Contents/MacOS/Python", mode=0o755)
        self.file(f"{framework}/Resources/Python.app/Contents/Info.plist")
        self.file(f"{framework}/Resources/Python.app/Contents/PkgInfo")
        self.file(f"{framework}/Resources/Python.app/Contents/Resources/PythonApplet.icns")
        self.link(f"{framework}/Resources/Python.app/Contents/share", "../../../../../../../share")
        library = f"{framework}/lib/python3.14"
        self.file(f"{library}/os.py")
        self.file(f"{library}/test/test_os.py")
        self.file(f"{library}/idlelib/idle.py")
        self.file(f"{library}/site-packages/gi/__init__.py")
        self.file(f"{library}/site-packages/certifi/__init__.py")
        self.file(f"{library}/site-packages/sitecustomize.py")
        self.file(f"{library}/site-packages/distutils-precedence.pth")
        self.file(f"{library}/site-packages/setuptools/_vendor/.lock")
        self.file(f"{library}/site-packages/setuptools-84.2.1.dist-info/METADATA")
        self.file(f"{library}/site-packages/mesonbuild/mesonmain.py")
        os.makedirs(os.path.join(self.contents, *f"{library}/__pycache__".split("/")))

    def tree(self) -> List[str]:
        entries = []
        for directory, folders, names in os.walk(self.contents):
            for name in folders + names:
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, self.contents).replace(os.sep, "/")
                entries.append(relative + ("@" if os.path.islink(path) else "/" if os.path.isdir(path) else ""))
        return sorted(entries)

    def test_prepare_flattens_the_bundle_into_the_runtime_layout(self) -> None:
        self.bundle()
        self.assertEqual(runtime.prepare(self.contents), GIMP)
        tree = self.tree()
        framework = "lib/Python.framework/Versions/3.14"
        library = f"{framework}/lib/python3.14"
        self.assertEqual([entry for entry in tree if not entry.endswith("/")], sorted([
            "MacOS/gimp-console-3.2", "MacOS/python3",
            "lib/libglib-2.0.0.dylib", "lib/gimp/3.0/plug-ins/python-eval/python-eval.py",
            "etc/gimp/3.0/gimprc",
            "share/gimp/3.0/brushes/arrow#1.myb", "share/gimp/3.0/fonts/wasd-engine-folder.txt",
            "share/locale/wasd-engine-folder.txt", "Resources/wasd-engine-folder.txt",
            f"{framework}/Python", f"{framework}/Resources/Python.app/Contents/MacOS/Python",
            f"{library}/os.py", f"{library}/site-packages/gi/__init__.py", f"{library}/site-packages/certifi/__init__.py",
            f"{library}/site-packages/sitecustomize.py",
        ]))
        self.assertIn(f"{library}/__pycache__/", tree)
        self.assertNotIn(f"{library}/__pycache__/wasd-engine-folder.txt", tree)
        self.assertEqual(os.stat(os.path.join(self.contents, "MacOS", "gimp-console-3.2")).st_mode & 0o777, 0o755)

    def test_prepare_refuses_a_link_it_does_not_know_and_a_bundle_without_gimp(self) -> None:
        self.bundle()
        self.link("lib/gimp/3.0/plug-ins/alias", "python-eval")
        with self.assertRaisesRegex(runtime.RuntimeToolError, "is a link that the runtime layout does not know"):
            runtime.prepare(self.contents)
        empty = os.path.join(os.path.dirname(self.contents), "Empty")
        os.makedirs(empty)
        with self.assertRaisesRegex(runtime.RuntimeToolError, "has no readable Info.plist"):
            runtime.prepare(empty)

    def test_prepare_requires_the_console_of_the_version_info_plist_names(self) -> None:
        self.bundle()
        os.unlink(os.path.join(self.contents, "MacOS", "gimp-console-3.2"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "gimp-console-3.2 is missing"):
            runtime.prepare(self.contents)


def pe_bytes(machine: int = 0x8664, imports: Tuple[str, ...] = ("KERNEL32.dll",), delayed: Tuple[Tuple[str, bool], ...] = (),
             version: Tuple[int, int, int] = (0, 0, 0)) -> bytes:
    """Build a small PE32+ file with one section that holds its import and delay-load tables and a version resource.

    @param machine: COFF machine type.
    @param imports: libraries of the import table.
    @param delayed: libraries of the delay-load table, each with whether its descriptor holds image-relative addresses.
    @param version: file version of the VS_FIXEDFILEINFO; (0, 0, 0) writes none.
    @returns: the file's bytes.
    """
    image_base, section_address, raw_offset, size = 0x10000000, 0x1000, 0x200, 0x1000
    content = bytearray(size)
    names = 0x400

    def name(text: str) -> int:
        nonlocal names
        address = section_address + names
        content[names:names + len(text) + 1] = text.encode() + b"\0"
        names += len(text) + 1
        return address

    cursor = 0
    for library in imports:
        struct.pack_into("<IIIII", content, cursor, 0, 0, 0, name(library), 0)
        cursor += 20
    cursor += 20
    delay_address = section_address + cursor
    for library, relative in delayed:
        address = name(library)
        struct.pack_into("<II", content, cursor, 1 if relative else 0, address if relative else address + image_base)
        cursor += 32
    if version != (0, 0, 0):
        major, minor, micro = version
        content[0x800:0x80C] = runtime.VERSION_SIGNATURE + struct.pack("<II", 0x10000, (major << 16) | minor)
        content[0x80C:0x810] = struct.pack("<I", micro << 16)
    data = bytearray(raw_offset) + content
    data[0:2] = b"MZ"
    struct.pack_into("<I", data, 0x3C, 0x40)
    data[0x40:0x44] = b"PE\0\0"
    struct.pack_into("<HHIIIHH", data, 0x44, machine, 1, 0, 0, 0, 240, 0x22)
    optional = 0x58
    struct.pack_into("<H", data, optional, 0x20B)
    struct.pack_into("<Q", data, optional + 24, image_base)
    struct.pack_into("<I", data, optional + 108, 16)
    struct.pack_into("<II", data, optional + 112 + 8, section_address, 40)
    if delayed:
        struct.pack_into("<II", data, optional + 112 + 13 * 8, delay_address, 32 * len(delayed))
    section = optional + 240
    data[section:section + 8] = b".idata\0\0"
    struct.pack_into("<IIII", data, section + 8, size, section_address, size, raw_offset)
    return bytes(data)


class WindowsTest(unittest.TestCase):
    """The Windows build: reading PE files, preparing an install, and running the installer."""

    def setUp(self) -> None:
        self.stage = os.path.join(tempfile.mkdtemp(prefix="gimp-windows-test-"), "stage")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.stage))
        self.installed = "D:\\a\\_temp\\gimp-out\\.stage-win32-x64"

    def file(self, relative: str, data: bytes = b"x") -> None:
        path = os.path.join(self.stage, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(data)

    def install(self) -> None:
        """Write an install in miniature, as GIMP's installer leaves it."""
        self.file("bin/gimp-console-3.2.exe", pe_bytes(imports=("libgimp-3.0-0.dll", "KERNEL32.dll"), version=(3, 2, 8)))
        self.file("bin/gimp-3.2.exe", pe_bytes())
        self.file("bin/gimp-debug-tool-3.0.exe", pe_bytes())
        self.file("bin/gimptool-3.0.exe", pe_bytes())
        self.file("bin/libgimp-3.0-0.dll", pe_bytes(imports=("api-ms-win-crt-runtime-l1-1-0.dll", "libc++.dll")))
        self.file("bin/libc++.dll", pe_bytes())
        self.file("bin/libgimp-3.0-0.pdb")
        self.file("bin/python.exe", pe_bytes())
        self.file("lib/libgimp-3.0.dll.a")
        self.file("lib/gimp/3.0/plug-ins/file-png/file-png.exe", pe_bytes(imports=("libgimp-3.0-0.dll",)))
        self.file("lib/gimp/3.0/plug-ins/twain/twain.exe", pe_bytes())
        self.file("lib/gimp/3.0/environ/default.env", b"PATH=${gimp_installation_dir}\\bin\n")
        self.file("lib/gimp/3.0/interpreters/pygimp.interp", b"python=python.exe\n/usr/bin/python3=python.exe\n:Python:E::py::python3:\n")
        script_fu = f"{self.installed}\\bin\\gimp-script-fu-interpreter-3.0.exe"
        self.file("lib/gimp/3.0/interpreters/gimp-script-fu-interpreter.interp",
                  f"# Script-Fu\ngimp-script-fu-interpreter={script_fu}\n,ScriptFu,E,,scm,,{script_fu},\n".encode())
        self.file("lib/python3.12/test/test_os.py")
        self.file("lib/python3.12/site-packages/setuptools/__init__.py")
        self.file("lib/python3.12/site-packages/gi/__init__.py")
        self.file("share/locale/de/LC_MESSAGES/gimp30.mo")
        self.file("share/icons/hicolor/index.theme")
        self.file("share/gimp/3.0/brushes/arrow#1.myb", b"brush")
        self.file("etc/gimp/3.0/gimprc", b"# gimprc")
        self.file("include/gimp-3.0/libgimp/gimp.h")
        self.file("uninst/unins000.exe", pe_bytes())
        os.makedirs(os.path.join(self.stage, "lib", "gimp", "3.0", "modules"))

    def files(self) -> List[str]:
        found = []
        for directory, _, names in os.walk(self.stage):
            found.extend(os.path.relpath(os.path.join(directory, name), self.stage).replace(os.sep, "/") for name in names)
        return sorted(found)

    def test_pe_imports_reads_the_import_and_delay_load_tables(self) -> None:
        data = pe_bytes(imports=("KERNEL32.dll", "libglib-2.0-0.dll"), delayed=(("dbghelp.dll", True), ("old.dll", False)))
        self.assertEqual(runtime.pe_imports(data), (0x8664, ["KERNEL32.dll", "libglib-2.0-0.dll", "dbghelp.dll", "old.dll"]))
        self.assertEqual(runtime.pe_imports(pe_bytes(machine=0xAA64, imports=()))[0], 0xAA64)
        self.assertIsNone(runtime.pe_imports(b"#!/bin/sh\n"))
        self.assertIsNone(runtime.pe_imports(b"MZ" + b"\0" * 62 + b"no PE header"))
        broken = bytearray(pe_bytes())
        struct.pack_into("<I", broken, 0x58 + 112 + 8, 0x9000)
        with self.assertRaisesRegex(runtime.RuntimeToolError, "lies in no section"):
            runtime.pe_imports(bytes(broken))

    def test_windows_file_version_reads_the_fixed_version_resource(self) -> None:
        self.file("bin/a.exe", pe_bytes(version=(3, 2, 8)))
        self.file("bin/b.exe", pe_bytes())
        self.assertEqual(runtime.windows_file_version(os.path.join(self.stage, "bin", "a.exe")), "3.2.8")
        self.assertIsNone(runtime.windows_file_version(os.path.join(self.stage, "bin", "b.exe")))

    def test_prepare_windows_keeps_what_the_tools_use_and_names_interpreters_by_file_name(self) -> None:
        self.install()
        self.assertEqual(runtime.prepare_windows(self.stage, self.installed), "3.2.8")
        self.assertEqual(self.files(), [
            "bin/gimp-console-3.2.exe", "bin/libc++.dll", "bin/libgimp-3.0-0.dll", "bin/python.exe",
            "etc/gimp/3.0/gimprc", "lib/gimp/3.0/environ/default.env", "lib/gimp/3.0/interpreters/gimp-script-fu-interpreter.interp",
            "lib/gimp/3.0/interpreters/pygimp.interp", f"lib/gimp/3.0/modules/{runtime.KEEP_FILE}", "lib/gimp/3.0/plug-ins/file-png/file-png.exe",
            "lib/python3.12/site-packages/gi/__init__.py", "share/gimp/3.0/brushes/arrow#1.myb", f"share/locale/{runtime.KEEP_FILE}",
        ])
        with open(os.path.join(self.stage, "lib", "gimp", "3.0", "interpreters", "gimp-script-fu-interpreter.interp"), encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "# Script-Fu\ngimp-script-fu-interpreter=gimp-script-fu-interpreter-3.0.exe\n"
                                            ",ScriptFu,E,,scm,,gimp-script-fu-interpreter-3.0.exe,\n")
        with open(os.path.join(self.stage, "lib", "gimp", "3.0", "interpreters", "pygimp.interp"), encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "python=python.exe\n/usr/bin/python3=python.exe\n:Python:E::py::python3:\n")
        self.assertEqual(runtime.unresolved_imports(self.stage, ("bin",)), [])

    def test_prepare_windows_refuses_another_install_and_files_that_name_the_install_folder(self) -> None:
        with self.assertRaisesRegex(runtime.RuntimeToolError, "holds 0 versioned gimp-console programs"):
            runtime.prepare_windows(self.stage, self.installed)
        self.install()
        self.file("bin/gimp-console-3.2.exe", pe_bytes(version=(3, 4, 0)))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "states the version '3.4.0', which does not match its name"):
            runtime.prepare_windows(self.stage, self.installed)
        shutil.rmtree(self.stage)
        self.install()
        self.file("etc/fonts/local.conf", f"<dir>{self.installed.replace(chr(92), '/').upper()}/share/fonts</dir>".encode())
        self.file("bin/libpaths.dll", pe_bytes() + self.installed.lower().encode("utf-16-le"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "2 files name the install folder .*: bin/libpaths.dll, etc/fonts/local.conf"):
            runtime.prepare_windows(self.stage, self.installed)

    def test_rewrite_interpreters_keeps_bare_names_comments_and_other_lines(self) -> None:
        self.assertEqual(runtime.rewrite_interpreters(self.stage), [])
        self.file("lib/gimp/3.0/interpreters/lua.interp", b"lua=\\\\server\\share\\luajit.exe\n,Lua,E,,lua,,C:/GIMP/bin/luajit.exe,\nnot a line\n")
        self.file("lib/gimp/3.0/interpreters/notes.txt", b"C:\\GIMP")
        self.assertEqual(runtime.rewrite_interpreters(self.stage), ["lib/gimp/3.0/interpreters/lua.interp"])
        with open(os.path.join(self.stage, "lib", "gimp", "3.0", "interpreters", "lua.interp"), encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "lua=luajit.exe\n,Lua,E,,lua,,luajit.exe,\nnot a line\n")
        self.assertEqual(runtime.rewrite_interpreters(self.stage), [])

    def test_unresolved_imports_names_libraries_that_neither_the_runtime_nor_windows_provides(self) -> None:
        self.file("bin/tool.exe", pe_bytes(imports=("MSVCP140.dll", "ext-ms-win-ntuser-window-l1-1-0.dll", "USER32.dll", "helper.dll")))
        self.file("bin/helper.dll", pe_bytes())
        self.file("lib/plugin/plugin.dll", pe_bytes(imports=("sibling.dll", "Tool.EXE", "missing.dll"), delayed=(("dbghelp.dll", True),)))
        self.file("lib/plugin/sibling.dll", pe_bytes())
        self.file("lib/plugin/readme.txt", b"MZ but not a program")
        self.assertEqual(runtime.unresolved_imports(self.stage, ("bin",)), ["bin/tool.exe loads MSVCP140.dll", "lib/plugin/plugin.dll loads missing.dll"])
        broken = bytearray(pe_bytes())
        struct.pack_into("<I", broken, 0x58 + 112 + 8, 0x9000)
        self.file("bin/broken.dll", bytes(broken))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "broken.dll has a broken import table"):
            runtime.unresolved_imports(self.stage, ("bin",))

    def test_check_imports_and_prepare_windows_commands(self) -> None:
        self.install()
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            self.assertEqual(runtime.main(["prepare-windows", "--stage", self.stage, "--installed", self.installed]), 0)
            self.assertEqual(runtime.main(["check-imports", "--stage", self.stage, "--folder", "bin"]), 0)
            self.file("bin/extra.dll", pe_bytes(imports=("VCRUNTIME140.dll",)))
            self.assertEqual(runtime.main(["check-imports", "--stage", self.stage, "--folder", "bin"]), 1)
            self.file("bin/libarm.dll", pe_bytes(machine=0xAA64))
            self.assertEqual(runtime.main(["check-imports", "--stage", self.stage, "--folder", "bin"]), 1)
        self.assertEqual(stdout.getvalue(), "3.2.8\n")
        self.assertIn("the libraries of 5 PE files resolve inside the runtime or to Windows", stderr.getvalue())
        self.assertIn("1 libraries resolve neither inside the runtime nor to Windows: bin/extra.dll loads VCRUNTIME140.dll", stderr.getvalue())
        self.assertIn("1 programs or libraries are not x64 code: bin/libarm.dll", stderr.getvalue())

    def test_run_setup_installs_silently_per_user_into_a_new_folder(self) -> None:
        with mock.patch.object(runtime.os, "name", "posix"):
            with self.assertRaisesRegex(runtime.RuntimeToolError, "runs on Windows only"):
                runtime.run_setup("setup.exe", self.stage, "setup.log")
        completed = subprocess.CompletedProcess([], 0, "", "")
        with mock.patch.object(runtime.os, "name", "nt"), mock.patch.object(runtime.subprocess, "run", return_value=completed) as run:
            runtime.run_setup("C:\\dl\\gimp-3.2.8-setup.exe", "C:\\out\\stage", "C:\\out\\setup.log")
            os.makedirs(self.stage)
            with self.assertRaisesRegex(runtime.RuntimeToolError, "exists; the installer must install into a new folder"):
                runtime.run_setup("setup.exe", self.stage, "setup.log")
            run.return_value = subprocess.CompletedProcess([], 3, "", "")
            with self.assertRaisesRegex(runtime.RuntimeToolError, "failed with exit code 3; see C:\\\\out\\\\setup.log"):
                runtime.run_setup("setup.exe", "C:\\out\\stage", "C:\\out\\setup.log")
            run.side_effect = subprocess.TimeoutExpired("setup.exe", 1800)
            with self.assertRaisesRegex(runtime.RuntimeToolError, "did not finish within 1800 s"):
                runtime.run_setup("setup.exe", "C:\\out\\stage", "C:\\out\\setup.log")
        self.assertEqual(run.call_args_list[0].args[0], [
            "C:\\dl\\gimp-3.2.8-setup.exe", "/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/SP-", "/NOCANCEL", "/CURRENTUSER", "/NOICONS",
            "/TASKS=", "/COMPONENTS=gimpX64,depsX64,pyX64,gsX64,mypaint", "/DIR=C:\\out\\stage", "/LOG=C:\\out\\setup.log",
        ])


class RuntimeToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="gimp-runtime-test-")
        self.addCleanup(shutil.rmtree, self.root)
        environment = mock.patch.dict(os.environ, {"SOURCE_DATE_EPOCH": str(EPOCH)})
        environment.start()
        self.addCleanup(environment.stop)
        self.out = self.directory("out")
        self.stages = 0

    def directory(self, *parts: str) -> str:
        path = os.path.join(self.root, *parts)
        os.makedirs(path)
        return path

    def run_tool(self, *args: str) -> Tuple[int, str, str]:
        stdout, stderr = io.StringIO(), io.StringIO()
        with contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            status = runtime.main(list(args))
        return status, stdout.getvalue().strip(), stderr.getvalue()

    def stage(self, files: Dict[str, Tuple[bytes, int]] = FILES) -> str:
        self.stages += 1
        stage = self.directory(f"stage-{self.stages}")
        for name, (data, mode) in files.items():
            path = os.path.join(stage, *name.split("/"))
            os.makedirs(os.path.dirname(path), exist_ok=True)
            with open(path, "wb") as stream:
                stream.write(data)
            os.chmod(path, mode)
        return stage

    def package_arguments(self, stage: str, arch: str = "arm64", version: str = VERSION, out: str = "", gimp: str = GIMP) -> List[str]:
        return [
            "package", "--stage", stage, "--out", out or self.out, "--version", version, "--gimp", gimp,
            "--platform", "darwin", "--arch", arch, "--console", CONSOLE, "--repository", "WASDEngine/WASD-Engine",
        ]

    def package(self, arch: str = "arm64", files: Dict[str, Tuple[bytes, int]] = FILES, **options: str) -> Tuple[int, str, str]:
        return self.run_tool(*self.package_arguments(self.stage(files), arch, **options))

    def manifest(self, path: str = "") -> Dict[str, object]:
        with open(path or os.path.join(self.out, "manifest.json"), encoding="utf-8") as stream:
            return json.load(stream)

    def record(self, **change: object) -> Dict[str, object]:
        record: Dict[str, object] = {
            "format": 1, "version": VERSION, "gimp": GIMP, "platform": "darwin", "arch": "arm64", "console": CONSOLE,
            "dataDir": "Contents/share/gimp/3.0", "localeDir": "Contents/share/locale", "sysconfDir": "Contents/etc/gimp/3.0",
            "sha256": {name: sha256(data) for name, (data, _) in FILES.items()},
        }
        record.update(change)
        return record

    def handmade_archive(self, record: Dict[str, object], extra: List[Tuple[tarfile.TarInfo, bytes]] = ()) -> str:
        self.stages += 1
        path = os.path.join(self.root, f"handmade-{self.stages}.tar.gz")
        entries = [(tarfile.TarInfo(name), data) for name, (data, _) in FILES.items()]
        entries += [(tarfile.TarInfo("runtime.json"), json.dumps(record).encode())] + list(extra)
        with tarfile.open(path, "w:gz") as archive:
            for entry, data in entries:
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))
        return path

    def test_package_writes_runtime_json_archive_and_manifest(self) -> None:
        status, archive, _ = self.package()
        self.assertEqual(status, 0)
        self.assertEqual(archive, os.path.join(self.out, f"gimp-{VERSION}-darwin-arm64.tar.gz"))
        with tarfile.open(archive) as tar:
            entries = [(entry.name, entry.mode, entry.uid, entry.gid, entry.uname, entry.mtime) for entry in tar]
            member = tar.extractfile("runtime.json")
            assert member is not None
            record = json.loads(member.read())
        self.assertEqual(entries, [(name, FILES[name][1], 0, 0, "", EPOCH) for name in sorted(FILES)] + [("runtime.json", 0o644, 0, 0, "", EPOCH)])
        self.assertEqual(record, self.record())
        with open(archive, "rb") as stream:
            data = stream.read()
        self.assertEqual(self.manifest(), {"format": 1, "version": VERSION, "gimp": GIMP, "artifacts": {
            "darwin-arm64": {"url": BASE_URL + os.path.basename(archive), "bytes": len(data), "sha256": sha256(data)},
        }})

    def test_package_names_the_folders_of_the_windows_layout(self) -> None:
        files = {
            "bin/gimp-console-3.2.exe": (b"MZ", 0o755), "share/gimp/3.0/brushes/arrow#1.myb": (b"brush", 0o644),
            "share/locale/wasd-engine-folder.txt": (b"keep", 0o644), "etc/gimp/3.0/gimprc": (b"# gimprc", 0o644), "COPYING": (b"GPL", 0o644),
        }
        arguments = self.package_arguments(self.stage(files))
        arguments[arguments.index("darwin")] = "win32"
        arguments[arguments.index("arm64")] = "x64"
        arguments[arguments.index(CONSOLE)] = "bin/gimp-console-3.2.exe"
        status, archive, _ = self.run_tool(*arguments)
        self.assertEqual(status, 0)
        with tarfile.open(archive) as tar:
            member = tar.extractfile("runtime.json")
            assert member is not None
            record = json.loads(member.read())
        self.assertEqual({field: record[field] for field in ("platform", "arch", "console", "dataDir", "localeDir", "sysconfDir")}, {
            "platform": "win32", "arch": "x64", "console": "bin/gimp-console-3.2.exe",
            "dataDir": "share/gimp/3.0", "localeDir": "share/locale", "sysconfDir": "etc/gimp/3.0",
        })
        self.assertEqual(list(self.manifest()["artifacts"]), ["win32-x64"])

    def test_package_output_is_reproducible_with_source_date_epoch(self) -> None:
        archives = []
        for out in (self.directory("first"), self.directory("second")):
            status, archive, _ = self.package(out=out)
            self.assertEqual(status, 0)
            with open(archive, "rb") as stream:
                archives.append(stream.read())
        self.assertEqual(archives[0], archives[1])

    def test_package_refuses_links_a_console_without_execute_permission_dot_files_and_empty_folders(self) -> None:
        stage = self.stage()
        os.symlink("gimp-console-3.2", os.path.join(stage, "Contents", "MacOS", "gimp-console"))
        status, _, error = self.run_tool(*self.package_arguments(stage))
        self.assertEqual(status, 1)
        self.assertIn("is not a plain file or folder; a runtime holds no links", error)
        status, _, error = self.package(files={**FILES, CONSOLE: (b"console bytes", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("is not an executable file in the stage", error)
        status, _, error = self.package(files={**FILES, "Contents/share/gimp/3.0/.DS_Store": (b"", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("cannot name a file inside a runtime", error)
        status, _, error = self.package(files={name: value for name, value in FILES.items() if not name.startswith("Contents/share/locale/")})
        self.assertEqual(status, 1)
        self.assertIn("lists no file in the localeDir folder 'Contents/share/locale'", error)
        self.assertFalse(os.path.exists(os.path.join(self.out, "manifest.json")))

    def test_package_keeps_the_artifacts_of_other_architectures_and_refuses_another_release(self) -> None:
        self.assertEqual(self.package()[0], 0)
        self.assertEqual(self.package(arch="x64")[0], 0)
        self.assertEqual(sorted(self.manifest()["artifacts"]), ["darwin-arm64", "darwin-x64"])  # type: ignore[arg-type]
        status, _, error = self.package(arch="x64", gimp="3.2.6")
        self.assertEqual(status, 1)
        self.assertIn("has gimp '3.2.8', not '3.2.6'", error)

    def test_install_unpacks_into_the_platform_folder_and_replaces_an_earlier_install(self) -> None:
        _, archive, _ = self.package()
        root = os.path.join(self.root, "package", "runtime")
        for _ in range(2):
            status, installed, _ = self.run_tool("install", "--archive", archive, "--root", root, "--version", VERSION)
            self.assertEqual(status, 0)
            self.assertEqual(installed, os.path.join(root, "darwin-arm64"))
        self.assertEqual(os.listdir(root), ["darwin-arm64"])
        for name, (data, mode) in FILES.items():
            path = os.path.join(installed, *name.split("/"))
            with open(path, "rb") as stream:
                self.assertEqual(stream.read(), data)
            self.assertEqual(os.stat(path).st_mode & 0o777, mode)
        status, _, error = self.run_tool("install", "--archive", archive, "--root", root, "--version", "3.2.8-wasd.2")
        self.assertEqual(status, 1)
        self.assertIn("holds runtime '3.2.8-wasd.1', not '3.2.8-wasd.2'", error)

    def test_install_refuses_unsafe_unlisted_and_mismatched_entries(self) -> None:
        root = self.directory("runtime-root")
        link = tarfile.TarInfo("Contents/lib/link.dylib")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../outside"
        cases = [
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("../outside"), b"x")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(link, b"")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("Contents/lib/extra.dylib"), b"x")]), "does not hold exactly the files runtime.json lists (unlisted Contents/lib/extra.dylib)"),
            (self.handmade_archive(self.record(sha256={**self.record()["sha256"], CONSOLE: "0" * 64})), f"the SHA-256 of {CONSOLE} does not match runtime.json"),  # type: ignore[dict-item]
            (self.handmade_archive(self.record(console="../gimp-console")), "is not a relative path inside the runtime"),
        ]
        for archive, message in cases:
            status, _, error = self.run_tool("install", "--archive", archive, "--root", root, "--version", VERSION)
            self.assertEqual(status, 1, message)
            self.assertIn(message, error)
            self.assertEqual(os.listdir(root), [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "outside")))

    def test_merge_and_verify_check_every_archive_against_the_merged_manifest(self) -> None:
        arm64, x64 = self.directory("arm64"), self.directory("x64")
        self.assertEqual(self.package(out=arm64)[0], 0)
        self.assertEqual(self.package(arch="x64", out=x64)[0], 0)
        release = self.directory("release")
        for folder in (arm64, x64):
            for name in os.listdir(folder):
                if name.endswith(".tar.gz"):
                    shutil.copy(os.path.join(folder, name), release)
        merged = os.path.join(release, "manifest.json")
        self.assertEqual(self.run_tool("merge", "--output", merged, os.path.join(arm64, "manifest.json"), os.path.join(x64, "manifest.json"))[0], 0)
        self.assertEqual(sorted(self.manifest(merged)["artifacts"]), ["darwin-arm64", "darwin-x64"])  # type: ignore[arg-type]
        verify = ["verify", "--manifest", merged, "--dir", release, "--version", VERSION, "--base-url", BASE_URL]
        self.assertEqual(self.run_tool(*verify)[0], 0)
        with open(os.path.join(release, f"gimp-{VERSION}-linux-x64.tar.gz"), "wb") as stream:
            stream.write(b"stray")
        status, _, error = self.run_tool(*verify)
        self.assertEqual(status, 1)
        self.assertIn("holds archives that", error)


if __name__ == "__main__":
    unittest.main()
