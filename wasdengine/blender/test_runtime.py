"""Tests for runtime.py: preparing a Python installation with bpy, checking Mach-O facts, and packaging, installing,
merging, and verifying runtime archives.

Run with: python3 -B -m unittest discover --start-directory wasdengine/blender --pattern 'test_*.py'
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import tarfile
import tempfile
import unittest
import zipfile
from typing import Dict, List, Tuple
from unittest import mock

SPEC = importlib.util.spec_from_file_location("blender_runtime", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime.py"))
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

VERSION = "5.2.3-wasd.1"
BPY = "5.2.3"
PYTHON = "3.13.18"
EPOCH = 1_700_000_000
BASE_URL = f"https://github.com/WASDEngine/WASD-Engine/releases/download/blender-{VERSION}/"
EXECUTABLE = "python/bin/python3.13"
SITE = "python/lib/python3.13/site-packages"
# A runtime tree in miniature: the program, the library, bpy with a preset whose name has '&', numpy's library folder, and the license.
FILES: Dict[str, Tuple[bytes, int]] = {
    EXECUTABLE: (b"python bytes", 0o755),
    "python/lib/libpython3.13.dylib": (b"library bytes", 0o644),
    f"{SITE}/bpy/__init__.so": (b"bpy bytes", 0o755),
    f"{SITE}/bpy/5.2/scripts/presets/camera/Arri_Alexa_Mini_&_SXT.py": (b"preset", 0o644),
    f"{SITE}/numpy/.dylibs/libscipy_openblas64_.dylib": (b"openblas", 0o644),
    "COPYING": (b"GPL", 0o644),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class NameTest(unittest.TestCase):
    def test_runtime_paths_allow_blender_s_names_and_numpy_s_library_folder_only(self) -> None:
        for path in FILES:
            self.assertTrue(runtime.is_runtime_path(path), path)
        for path in ("python/.DS_Store", "python/lib/._libpython3.13.dylib", "../outside", "python//bin", "runtime.json", "a:b", "x" * 201):
            self.assertFalse(runtime.is_runtime_path(path), path)


class PrepareTest(unittest.TestCase):
    """prepare turns a python-build-standalone installation with bpy into the runtime layout."""

    def setUp(self) -> None:
        self.installation = os.path.join(tempfile.mkdtemp(prefix="blender-prepare-test-"), "python")
        self.addCleanup(shutil.rmtree, os.path.dirname(self.installation))

    def file(self, relative: str, data: bytes = b"x", mode: int = 0o644) -> None:
        path = os.path.join(self.installation, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(data)
        os.chmod(path, mode)

    def link(self, relative: str, target: str) -> None:
        path = os.path.join(self.installation, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        os.symlink(target, path)

    def install(self) -> None:
        """An installation in miniature, with the aliases, scripts, and unused parts that python-build-standalone and pip leave."""
        self.file("bin/python3.13", mode=0o755)
        self.link("bin/python3", "python3.13")
        self.link("bin/python", "python3.13")
        self.file("bin/pip3.13", mode=0o755)
        self.file("bin/cythonize", mode=0o755)
        self.file("include/python3.13/Python.h")
        self.file("share/man/man1/python3.13.1")
        self.link("share/man/man1/python3.1", "python3.13.1")
        self.file("lib/libpython3.13.dylib")
        self.file("lib/libtcl9.0.dylib")
        self.file("lib/libtcl9tk9.0.dylib")
        self.file("lib/tcl9.0/init.tcl")
        self.file("lib/tk9.0/tk.tcl")
        self.file("lib/itcl4.3.8/itcl.tcl")
        self.file("lib/thread3.0.6/pkgIndex.tcl")
        self.file("lib/pkgconfig/python-3.13.pc")
        self.link("lib/pkgconfig/python3.pc", "python-3.13.pc")
        library = "lib/python3.13"
        self.file(f"{library}/os.py")
        self.file(f"{library}/LICENSE.txt")
        self.file(f"{library}/__pycache__/os.cpython-313.pyc")
        self.file(f"{library}/turtle.py")
        self.file(f"{library}/idlelib/idle.py")
        self.file(f"{library}/tkinter/__init__.py")
        self.file(f"{library}/turtledemo/demo.py")
        self.file(f"{library}/ensurepip/__init__.py")
        self.file(f"{library}/lib-dynload/_json.cpython-313-darwin.so")
        self.file(f"{library}/lib-dynload/_tkinter.cpython-313-darwin.so")
        self.file(f"{library}/lib-dynload/.empty")
        site = f"{library}/site-packages"
        self.file(f"{site}/pip/__init__.py")
        self.file(f"{site}/pip-26.2.2.dist-info/METADATA")
        self.file(f"{site}/bpy/__init__.so", mode=0o755)
        self.file(f"{site}/bpy/5.2/scripts/presets/camera/Arri_Alexa_Mini_&_SXT.py")
        self.file(f"{site}/bpy/5.2/scripts/startup/bl_ui.py")
        self.file(f"{site}/bpy/5.2/scripts/startup/__pycache__/bl_ui.cpython-313.pyc")
        self.file(f"{site}/bpy-{BPY}.dist-info/METADATA")
        self.file(f"{site}/numpy/__init__.py")
        self.file(f"{site}/numpy/.dylibs/libscipy_openblas64_.dylib")
        self.file(f"{site}/numpy/_core/numeric.py")
        self.file(f"{site}/numpy/_core/tests/test_numeric.py")
        self.file(f"{site}/numpy/f2py/__init__.py")
        self.file(f"{site}/numpy/f2py/tests/src/f2cmap/.f2py_f2cmap")
        self.file(f"{site}/numpy/testing/__init__.py")
        os.makedirs(os.path.join(self.installation, *f"{site}/bpy/5.2/extensions/user_default".split("/")))

    def tree(self) -> List[str]:
        entries = []
        for directory, folders, names in os.walk(self.installation):
            for name in folders + names:
                path = os.path.join(directory, name)
                relative = os.path.relpath(path, self.installation).replace(os.sep, "/")
                entries.append(relative + ("@" if os.path.islink(path) else "/" if os.path.isdir(path) else ""))
        return sorted(entries)

    def test_prepare_drops_links_scripts_tk_pip_tests_and_bytecode(self) -> None:
        self.install()
        self.assertEqual(runtime.prepare(self.installation), BPY)
        site = "lib/python3.13/site-packages"
        self.assertEqual([entry for entry in self.tree() if not entry.endswith("/")], sorted([
            "bin/python3.13", "lib/libpython3.13.dylib", "lib/python3.13/os.py", "lib/python3.13/LICENSE.txt",
            "lib/python3.13/lib-dynload/_json.cpython-313-darwin.so",
            f"{site}/bpy/__init__.so", f"{site}/bpy/5.2/scripts/presets/camera/Arri_Alexa_Mini_&_SXT.py",
            f"{site}/bpy/5.2/scripts/startup/bl_ui.py",
            f"{site}/bpy/5.2/extensions/user_default/wasd-engine-folder.txt", f"{site}/bpy-{BPY}.dist-info/METADATA",
            f"{site}/numpy/__init__.py", f"{site}/numpy/.dylibs/libscipy_openblas64_.dylib", f"{site}/numpy/_core/numeric.py",
            f"{site}/numpy/f2py/__init__.py", f"{site}/numpy/testing/__init__.py",
        ]))
        self.assertEqual(os.stat(os.path.join(self.installation, "bin", "python3.13")).st_mode & 0o777, 0o755)

    def test_prepare_refuses_an_unknown_link_and_an_installation_without_bpy(self) -> None:
        self.install()
        self.link("lib/python3.13/site-packages/bpy/alias.so", "__init__.so")
        with self.assertRaisesRegex(runtime.RuntimeToolError, "is a link that the runtime layout does not know"):
            runtime.prepare(self.installation)
        os.unlink(os.path.join(self.installation, "lib", "python3.13", "site-packages", "bpy", "alias.so"))
        shutil.rmtree(os.path.join(self.installation, "lib", "python3.13", "site-packages", f"bpy-{BPY}.dist-info"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "must hold one bpy installation"):
            runtime.prepare(self.installation)

    def test_prepare_requires_one_python_and_its_program(self) -> None:
        self.install()
        os.unlink(os.path.join(self.installation, "bin", "python3.13"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "python3.13 is missing"):
            runtime.prepare(self.installation)
        os.makedirs(os.path.join(self.installation, "lib", "python3.14"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, r"must hold one python3.<minor> folder, found \['python3.13', 'python3.14'\]"):
            runtime.prepare(self.installation)


class WindowsPrepareTest(PrepareTest):
    """prepare turns python-build-standalone's Windows installation with bpy into the runtime layout."""

    def install(self) -> None:
        """A Windows installation in miniature, with the launchers, import libraries, and Tcl and Tk that it brings."""
        self.file("python.exe", mode=0o755)
        self.file("pythonw.exe", mode=0o755)
        self.file("python313.dll")
        self.file("vcruntime140.dll")
        self.file("LICENSE.txt")
        self.file("Scripts/pip.exe", mode=0o755)
        self.file("include/Python.h")
        self.file("libs/python313.lib")
        self.file("tcl/tcl8.6/init.tcl")
        self.file("DLLs/_json.pyd")
        self.file("DLLs/_tkinter.pyd")
        self.file("DLLs/tcl86t.dll")
        self.file("DLLs/tk86t.dll")
        self.file("Lib/os.py")
        self.file("Lib/__pycache__/os.cpython-313.pyc")
        self.file("Lib/tkinter/__init__.py")
        self.file("Lib/idlelib/idle.py")
        self.file("Lib/ensurepip/__init__.py")
        self.file("Lib/site-packages/pip/__init__.py")
        self.file("Lib/site-packages/pip-26.2.2.dist-info/METADATA")
        self.file("Lib/site-packages/bpy/__init__.pyd")
        self.file(f"Lib/site-packages/bpy-{BPY}.dist-info/METADATA")
        self.file("Lib/site-packages/numpy/__init__.py")
        self.file("Lib/site-packages/numpy/_core/numeric.py")
        self.file("Lib/site-packages/numpy/_core/tests/test_numeric.py")
        self.file("Lib/site-packages/numpy.libs/libscipy_openblas64_.dll")

    def test_prepare_drops_links_scripts_tk_pip_tests_and_bytecode(self) -> None:
        self.install()
        self.assertEqual(runtime.prepare(self.installation), BPY)
        self.assertEqual([entry for entry in self.tree() if not entry.endswith("/")], sorted([
            "python.exe", "python313.dll", "vcruntime140.dll", "LICENSE.txt", "DLLs/_json.pyd", "Lib/os.py",
            "Lib/site-packages/bpy/__init__.pyd", f"Lib/site-packages/bpy-{BPY}.dist-info/METADATA", "Lib/site-packages/numpy/__init__.py",
            "Lib/site-packages/numpy/_core/numeric.py", "Lib/site-packages/numpy.libs/libscipy_openblas64_.dll",
        ]))

    def test_prepare_refuses_an_unknown_link_and_an_installation_without_bpy(self) -> None:
        self.install()
        shutil.rmtree(os.path.join(self.installation, "Lib", "site-packages", f"bpy-{BPY}.dist-info"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "must hold one bpy installation"):
            runtime.prepare(self.installation)

    def test_prepare_requires_one_python_and_its_program(self) -> None:
        self.install()
        os.unlink(os.path.join(self.installation, "python.exe"))
        with self.assertRaisesRegex(runtime.RuntimeToolError, "must hold one python3.<minor> folder"):
            runtime.prepare(self.installation)


class WheelTest(unittest.TestCase):
    """read_requirements, fetch_wheel, and install_wheel install pinned wheels without pip."""

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="blender-wheel-test-")
        self.addCleanup(shutil.rmtree, self.root)
        self.site = os.path.join(self.root, "site-packages")
        os.makedirs(self.site)

    def wheel(self, name: str, members: Dict[str, Tuple[bytes, int]]) -> str:
        path = os.path.join(self.root, name)
        with zipfile.ZipFile(path, "w") as archive:
            for member, (data, mode) in members.items():
                info = zipfile.ZipInfo(member)
                info.external_attr = (0o100000 | mode) << 16
                archive.writestr(info, data)
        return path

    def requirements(self, *lines: str) -> str:
        path = os.path.join(self.root, "requirements.txt")
        with open(path, "w", encoding="utf-8") as stream:
            stream.write("\n".join(lines) + "\n")
        return path

    def test_requirements_pin_one_wheel_url_and_digest_per_package(self) -> None:
        url = "https://files.pythonhosted.org/packages/aa/bb/demo-1.0-py3-none-any.whl"
        path = self.requirements("# comment", "", f"demo @ {url} --hash=sha256:{'a' * 64}")
        self.assertEqual(runtime.read_requirements(path), [("demo", url, "a" * 64)])
        for lines, message in [
            ((f"demo=={'1.0'} --hash=sha256:{'a' * 64}",), "expected '<name> @ <https URL of a .whl>"),
            ((f"demo @ http://example.com/demo-1.0-py3-none-any.whl --hash=sha256:{'a' * 64}",), "expected"),
            ((f"demo @ {url} --hash=sha256:{'a' * 64}", f"Demo @ {url}x.whl --hash=sha256:{'b' * 64}"), "names the package demo more than once"),
        ]:
            with self.assertRaisesRegex(runtime.RuntimeToolError, message):
                runtime.read_requirements(self.requirements(*lines))

    def test_fetch_reuses_a_cached_wheel_and_checks_a_download(self) -> None:
        source = self.wheel("demo-1.0-py3-none-any.whl", {"demo/__init__.py": (b"x = 1\n", 0o644)})
        digest = runtime.sha256_file(source)
        cache = os.path.join(self.root, "cache")
        url = "file://" + source
        fetched = runtime.fetch_wheel(url, digest, cache)
        self.assertEqual(fetched, os.path.join(cache, "demo-1.0-py3-none-any.whl"))
        self.assertEqual(runtime.fetch_wheel("file:///nowhere/demo-1.0-py3-none-any.whl", digest, cache), fetched)
        os.unlink(fetched)
        with self.assertRaisesRegex(runtime.RuntimeToolError, "not the pinned"):
            runtime.fetch_wheel(url, "0" * 64, cache)
        self.assertEqual(os.listdir(cache), [])

    def test_install_follows_the_wheel_format_and_records_the_installer(self) -> None:
        wheel = self.wheel("demo-1.0-py3-none-any.whl", {
            "demo/__init__.py": (b"x = 1\n", 0o644),
            "demo/tool.so": (b"binary", 0o755),
            "demo-1.0.data/platlib/demo_ext.so": (b"extension", 0o755),
            "demo-1.0.data/scripts/demo-cli": (b"#!python\n", 0o755),
            "demo-1.0.dist-info/METADATA": (b"Name: demo\n", 0o644),
            "demo-1.0.dist-info/RECORD": (b"", 0o644),
        })
        self.assertEqual(runtime.install_wheel(wheel, self.site), "demo-1.0.dist-info")
        files = sorted(os.path.relpath(os.path.join(d, n), self.site) for d, _, names in os.walk(self.site) for n in names)
        self.assertEqual(files, ["demo-1.0.dist-info/INSTALLER", "demo-1.0.dist-info/METADATA", "demo-1.0.dist-info/RECORD",
                                 "demo/__init__.py", "demo/tool.so", "demo_ext.so"])
        self.assertEqual(os.stat(os.path.join(self.site, "demo", "tool.so")).st_mode & 0o777, 0o755)
        with open(os.path.join(self.site, "demo-1.0.dist-info", "INSTALLER"), encoding="utf-8") as stream:
            self.assertEqual(stream.read(), "wasd-engine\n")
        with self.assertRaisesRegex(runtime.RuntimeToolError, "would replace demo/__init__.py"):
            runtime.install_wheel(self.wheel("demo2-1.0-py3-none-any.whl", {
                "demo/__init__.py": (b"", 0o644), "demo2-1.0.dist-info/METADATA": (b"", 0o644),
            }), self.site)

    def test_install_refuses_unsafe_members_unknown_data_and_wheels_without_one_dist_info(self) -> None:
        cases = [
            ({"../outside.py": (b"", 0o644), "a-1.dist-info/METADATA": (b"", 0o644)}, "is not a relative path inside site-packages"),
            ({"a-1.data/headers/a.h": (b"", 0o644), "a-1.dist-info/METADATA": (b"", 0o644)}, "is in the .data category 'headers'"),
            ({"a/__init__.py": (b"", 0o644)}, "must hold one .dist-info folder"),
        ]
        for index, (members, message) in enumerate(cases):
            with self.assertRaisesRegex(runtime.RuntimeToolError, message):
                runtime.install_wheel(self.wheel(f"a{index}-1-py3-none-any.whl", members), os.path.join(self.root, f"site-{index}"))
        self.assertFalse(os.path.exists(os.path.join(self.root, "outside.py")))


class BinaryTest(unittest.TestCase):
    """binary_problems checks where the libraries of the Mach-O files resolve and the macOS they need."""

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="blender-binary-test-")
        self.addCleanup(shutil.rmtree, self.root)

    def path(self, relative: str) -> str:
        path = os.path.join(self.root, *relative.split("/"))
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(b"\xcf\xfa\xed\xfe")
        return path

    def test_libraries_resolve_through_rpaths_install_names_and_loader_paths(self) -> None:
        bpy_lib = os.path.join(self.root, SITE, "bpy", "lib")
        python_lib = os.path.join(self.root, "python", "lib")
        binaries = [
            runtime.Binary(self.path(EXECUTABLE), [], [python_lib], ["@rpath/libpython3.13.dylib", "/usr/lib/libSystem.B.dylib"], "11.0"),
            runtime.Binary(self.path("python/lib/libpython3.13.dylib"), ["@rpath/libpython3.13.dylib"], [], [], "11.0"),
            runtime.Binary(self.path(f"{SITE}/bpy/__init__.so"), [], [bpy_lib], ["@rpath/libtbb.dylib"], "11.2"),
            runtime.Binary(self.path(f"{SITE}/bpy/lib/libtbb.dylib"), ["@rpath/libtbb.dylib"], [bpy_lib], [], "11.2"),
            # Resolves through bpy's rpath folder, which bpy/__init__.so loaded it from first.
            runtime.Binary(self.path(f"{SITE}/bpy/5.2/scripts/addons_core/io_scene_gltf2/libbridge.dylib"), ["@rpath/libbridge.dylib"],
                           ["/Users/blender/git/lib"], ["@rpath/libtbb.dylib"], "11.2"),
            # Resolves through the install name of a module that its package imports first.
            runtime.Binary(self.path(f"{SITE}/bpy/5.2/python/MaterialX/PyMaterialXCore.so"), ["@rpath/PyMaterialXCore.so"], [], [], "11.2"),
            runtime.Binary(self.path(f"{SITE}/bpy/5.2/python/MaterialX/PyMaterialXFormat.so"), ["@rpath/PyMaterialXFormat.so"],
                           [bpy_lib], ["@rpath/PyMaterialXCore.so"], "11.2"),
            runtime.Binary(self.path(f"{SITE}/numpy/_core/_multiarray_umath.so"), [], [],
                           ["@loader_path/../.dylibs/libscipy_openblas64_.dylib"], "11.0"),
            runtime.Binary(self.path(f"{SITE}/numpy/.dylibs/libscipy_openblas64_.dylib"), ["@rpath/libscipy_openblas64_.dylib"], [], [], "11.0"),
        ]
        self.assertEqual(runtime.binary_problems(self.root, binaries, "13.0"), [])

    def test_problems_name_missing_libraries_and_newer_macos(self) -> None:
        binaries = [
            runtime.Binary(self.path(EXECUTABLE), [], ["/opt/homebrew/lib"], ["@rpath/libintl.8.dylib", "/opt/homebrew/lib/libz.dylib"], "14.0"),
            runtime.Binary(self.path(f"{SITE}/numpy/_core/_umath.so"), [], [], ["@loader_path/../.dylibs/libmissing.dylib"], None),
        ]
        self.assertEqual(runtime.binary_problems(self.root, binaries, "13.0"), [
            f"{EXECUTABLE} loads @rpath/libintl.8.dylib, which is not in the runtime",
            f"{EXECUTABLE} loads /opt/homebrew/lib/libz.dylib, which is not in the runtime",
            f"{EXECUTABLE} needs macOS 14.0, newer than 13.0",
            f"{SITE}/numpy/_core/_umath.so loads @loader_path/../.dylibs/libmissing.dylib, which is not in the runtime",
        ])
        self.assertEqual(runtime.version_key("13"), (13, 0, 0))
        self.assertLess(runtime.version_key("11.2"), runtime.version_key("13.0"))

    def test_check_binaries_rejects_an_invalid_minimum(self) -> None:
        stderr = io.StringIO()
        with contextlib.redirect_stderr(stderr):
            self.assertEqual(runtime.main(["check-binaries", "--runtime", self.root, "--minimum-macos", "thirteen"]), 1)
        self.assertIn("invalid --minimum-macos 'thirteen'", stderr.getvalue())


class RuntimeToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="blender-runtime-test-")
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

    def package_arguments(self, stage: str, arch: str = "arm64", version: str = VERSION, out: str = "", bpy: str = BPY) -> List[str]:
        return [
            "package", "--stage", stage, "--out", out or self.out, "--version", version, "--bpy", bpy, "--python", PYTHON,
            "--platform", "darwin", "--arch", arch, "--executable", EXECUTABLE, "--repository", "WASDEngine/WASD-Engine",
        ]

    def package(self, arch: str = "arm64", files: Dict[str, Tuple[bytes, int]] = FILES, **options: str) -> Tuple[int, str, str]:
        return self.run_tool(*self.package_arguments(self.stage(files), arch, **options))

    def manifest(self, path: str = "") -> Dict[str, object]:
        with open(path or os.path.join(self.out, "manifest.json"), encoding="utf-8") as stream:
            return json.load(stream)

    def record(self, **change: object) -> Dict[str, object]:
        record: Dict[str, object] = {
            "format": 1, "version": VERSION, "bpy": BPY, "python": PYTHON, "platform": "darwin", "arch": "arm64",
            "executable": EXECUTABLE, "sha256": {name: sha256(data) for name, (data, _) in FILES.items()},
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
        self.assertEqual(archive, os.path.join(self.out, f"blender-{VERSION}-darwin-arm64.tar.gz"))
        with tarfile.open(archive) as tar:
            entries = [(entry.name, entry.mode, entry.uid, entry.gid, entry.uname, entry.mtime) for entry in tar]
            member = tar.extractfile("runtime.json")
            assert member is not None
            record = json.loads(member.read())
        self.assertEqual(entries, [(name, FILES[name][1], 0, 0, "", EPOCH) for name in sorted(FILES)] + [("runtime.json", 0o644, 0, 0, "", EPOCH)])
        self.assertEqual(record, self.record())
        with open(archive, "rb") as stream:
            data = stream.read()
        self.assertEqual(self.manifest(), {"format": 1, "version": VERSION, "bpy": BPY, "artifacts": {
            "darwin-arm64": {"url": BASE_URL + os.path.basename(archive), "bytes": len(data), "sha256": sha256(data)},
        }})

    def test_package_output_is_reproducible_with_source_date_epoch(self) -> None:
        archives = []
        for out in (self.directory("first"), self.directory("second")):
            status, archive, _ = self.package(out=out)
            self.assertEqual(status, 0)
            with open(archive, "rb") as stream:
                archives.append(stream.read())
        self.assertEqual(archives[0], archives[1])

    def test_package_refuses_links_a_program_without_execute_permission_dot_files_and_bad_versions(self) -> None:
        stage = self.stage()
        os.symlink("python3.13", os.path.join(stage, "python", "bin", "python3"))
        status, _, error = self.run_tool(*self.package_arguments(stage))
        self.assertEqual(status, 1)
        self.assertIn("is not a plain file or folder; a runtime holds no links", error)
        status, _, error = self.package(files={**FILES, EXECUTABLE: (b"python bytes", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("is not an executable file in the stage", error)
        status, _, error = self.package(files={**FILES, f"{SITE}/bpy/.DS_Store": (b"", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("cannot name a file inside a runtime", error)
        status, _, error = self.package(bpy="5.2")
        self.assertEqual(status, 1)
        self.assertIn("bpy is '5.2', which is not valid", error)
        self.assertFalse(os.path.exists(os.path.join(self.out, "manifest.json")))

    def test_package_keeps_the_artifacts_of_other_architectures_and_refuses_another_release(self) -> None:
        self.assertEqual(self.package()[0], 0)
        self.assertEqual(self.package(arch="x64")[0], 0)
        self.assertEqual(sorted(self.manifest()["artifacts"]), ["darwin-arm64", "darwin-x64"])  # type: ignore[arg-type]
        status, _, error = self.package(arch="x64", bpy="5.2.2")
        self.assertEqual(status, 1)
        self.assertIn("has bpy '5.2.3', not '5.2.2'", error)

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
        status, _, error = self.run_tool("install", "--archive", archive, "--root", root, "--version", "5.2.3-wasd.2")
        self.assertEqual(status, 1)
        self.assertIn("holds runtime '5.2.3-wasd.1', not '5.2.3-wasd.2'", error)

    def test_install_refuses_unsafe_unlisted_and_mismatched_entries(self) -> None:
        root = self.directory("runtime-root")
        link = tarfile.TarInfo("python/lib/link.dylib")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../outside"
        cases = [
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("../outside"), b"x")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(link, b"")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("python/lib/extra.dylib"), b"x")]), "does not hold exactly the files runtime.json lists (unlisted python/lib/extra.dylib)"),
            (self.handmade_archive(self.record(sha256={**self.record()["sha256"], EXECUTABLE: "0" * 64})), f"the SHA-256 of {EXECUTABLE} does not match runtime.json"),  # type: ignore[dict-item]
            (self.handmade_archive(self.record(executable="../python3.13")), "is not a relative path inside the runtime"),
            (self.handmade_archive(self.record(python="3.13")), "python is '3.13', which is not valid"),
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
        with open(os.path.join(release, f"blender-{VERSION}-linux-x64.tar.gz"), "wb") as stream:
            stream.write(b"stray")
        status, _, error = self.run_tool(*verify)
        self.assertEqual(status, 1)
        self.assertIn("holds archives that", error)


if __name__ == "__main__":
    unittest.main()
