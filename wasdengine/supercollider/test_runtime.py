"""Tests for runtime.py: the Windows build's library checks, and packaging, installing, merging, and verifying SuperCollider runtime archives.

Run with: python3 -B -m unittest discover --start-directory wasdengine/supercollider --pattern 'test_*.py'
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import struct
import tarfile
import tempfile
import unittest
from typing import Dict, List, Tuple
from unittest import mock

SPEC = importlib.util.spec_from_file_location("supercollider_runtime", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime.py"))
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

VERSION = "3.14.1-wasd.1"
SUPERCOLLIDER = "3.14.1"
EPOCH = 1_700_000_000
BASE_URL = f"https://github.com/WASDEngine/WASD-Engine/releases/download/supercollider-{VERSION}/"
# A runtime tree in miniature: the two programs, one plugin, one class file, one help file, and the license.
FILES: Dict[str, Tuple[bytes, int]] = {
    "sclang": (b"sclang bytes", 0o755),
    "scsynth": (b"scsynth bytes", 0o755),
    "plugins/OscUGens.scx": (b"plugin bytes", 0o644),
    "SCClassLibrary/Common/Core/Object.sc": (b"Object {}", 0o644),
    "HelpSource/Classes/SinOsc.schelp": (b"class:: SinOsc", 0o644),
    "COPYING": (b"GPL", 0o644),
}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


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
        content[0x800:0x80C] = struct.pack("<I", 0xFEEF04BD) + struct.pack("<II", 0x10000, (major << 16) | minor)
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


class WindowsLibrariesTest(unittest.TestCase):
    """The Windows build copies the Visual C++ runtime that its files load and checks that every library resolves."""

    def setUp(self) -> None:
        root = tempfile.mkdtemp(prefix="supercollider-windows-test-")
        self.addCleanup(shutil.rmtree, root)
        self.stage, self.redist = os.path.join(root, "stage"), os.path.join(root, "Microsoft.VC143.CRT")
        for name, data in {
            "sclang.exe": pe_bytes(imports=("sndfile.dll", "MSVCP140.dll", "KERNEL32.dll", "WS2_32.dll")),
            "scsynth.exe": pe_bytes(imports=("sndfile.dll", "fftw3f.dll", "VCRUNTIME140.dll", "api-ms-win-crt-runtime-l1-1-0.dll")),
            "sndfile.dll": pe_bytes(imports=("VCRUNTIME140.dll",)),
            "fftw3f.dll": pe_bytes(imports=("VCRUNTIME140.dll",)),
            "plugins/OscUGens.scx": pe_bytes(imports=("VCRUNTIME140_1.dll",)),
        }.items():
            self.write(os.path.join(self.stage, *name.split("/")), data)
        for name, data in {
            "msvcp140.dll": pe_bytes(imports=("vcruntime140.dll", "vcruntime140_1.dll")), "vcruntime140.dll": pe_bytes(),
            "vcruntime140_1.dll": pe_bytes(imports=("vcruntime140.dll",)), "concrt140.dll": pe_bytes(),
        }.items():
            self.write(os.path.join(self.redist, name), data)

    @staticmethod
    def write(path: str, data: bytes) -> None:
        os.makedirs(os.path.dirname(path), exist_ok=True)
        with open(path, "wb") as stream:
            stream.write(data)

    def run_tool(self, *args: str) -> Tuple[int, str]:
        stderr = io.StringIO()
        with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(stderr):
            status = runtime.main(list(args))
        return status, stderr.getvalue()

    def test_vc_runtime_copies_the_libraries_that_the_runtime_loads_and_their_own(self) -> None:
        self.assertEqual(runtime.unresolved_imports(self.stage, (".",)), [
            "fftw3f.dll loads VCRUNTIME140.dll", "plugins/OscUGens.scx loads VCRUNTIME140_1.dll", "sclang.exe loads MSVCP140.dll",
            "scsynth.exe loads VCRUNTIME140.dll", "sndfile.dll loads VCRUNTIME140.dll",
        ])
        self.assertEqual(self.run_tool("vc-runtime", "--stage", self.stage, "--redist", self.redist),
                         (0, f"runtime.py: copied msvcp140.dll, vcruntime140.dll, vcruntime140_1.dll Visual C++ runtime libraries into {self.stage}\n"))
        self.assertEqual(sorted(os.listdir(self.stage)), ["fftw3f.dll", "msvcp140.dll", "plugins", "sclang.exe", "scsynth.exe", "sndfile.dll",
                                                          "vcruntime140.dll", "vcruntime140_1.dll"])
        self.assertEqual(runtime.copy_vc_runtime(self.stage, self.redist), [])
        status, message = self.run_tool("check-imports", "--stage", self.stage, "--folder", ".")
        self.assertEqual((status, message), (0, "runtime.py: the libraries of 8 PE files resolve inside the runtime or to Windows\n"))

    def test_check_imports_names_missing_libraries_and_foreign_code(self) -> None:
        status, message = self.run_tool("check-imports", "--stage", self.stage, "--folder", ".")
        self.assertEqual(status, 1)
        self.assertIn("5 libraries resolve neither inside the runtime nor to Windows: fftw3f.dll loads VCRUNTIME140.dll", message)
        self.write(os.path.join(self.stage, "plugins", "Arm.scx"), pe_bytes(machine=0xAA64))
        self.assertIn("1 programs or libraries are not x64 code: plugins/Arm.scx", self.run_tool("check-imports", "--stage", self.stage, "--folder", ".")[1])

    def test_vc_runtime_needs_a_folder_of_libraries(self) -> None:
        status, message = self.run_tool("vc-runtime", "--stage", self.stage, "--redist", os.path.join(self.stage, "missing"))
        self.assertEqual(status, 1)
        self.assertIn("holds no Visual C++ runtime library", message)


class RuntimeToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="supercollider-runtime-test-")
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

    def package_arguments(self, stage: str, platform: str = "darwin", version: str = VERSION, out: str = "", supercollider: str = SUPERCOLLIDER) -> List[str]:
        return [
            "package", "--stage", stage, "--out", out or self.out, "--version", version, "--supercollider", supercollider,
            "--platform", platform, "--arch", "arm64" if platform == "darwin" else "x64", "--sclang", "sclang", "--scsynth", "scsynth",
            "--repository", "WASDEngine/WASD-Engine",
        ]

    def package(self, platform: str = "darwin", files: Dict[str, Tuple[bytes, int]] = FILES, **options: str) -> Tuple[int, str, str]:
        return self.run_tool(*self.package_arguments(self.stage(files), platform, **options))

    def manifest(self, path: str = "") -> Dict[str, object]:
        with open(path or os.path.join(self.out, "manifest.json"), encoding="utf-8") as stream:
            return json.load(stream)

    def write_tar(self, path: str, entries: List[Tuple[tarfile.TarInfo, bytes]]) -> None:
        with tarfile.open(path, "w:gz") as archive:
            for entry, data in entries:
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def record(self, **change: object) -> Dict[str, object]:
        record: Dict[str, object] = {
            "format": 1, "version": VERSION, "supercollider": SUPERCOLLIDER, "platform": "linux", "arch": "x64",
            "sclang": "sclang", "scsynth": "scsynth", "plugins": "plugins", "classLibrary": "SCClassLibrary", "helpSource": "HelpSource",
            "sha256": {name: sha256(data) for name, (data, _) in FILES.items()},
        }
        record.update(change)
        return record

    def handmade_archive(self, record: Dict[str, object], extra: List[Tuple[tarfile.TarInfo, bytes]] = ()) -> str:
        self.stages += 1
        path = os.path.join(self.root, f"handmade-{self.stages}.tar.gz")
        entries = [(tarfile.TarInfo(name), data) for name, (data, _) in FILES.items()]
        entries += [(tarfile.TarInfo("runtime.json"), json.dumps(record).encode())] + list(extra)
        self.write_tar(path, entries)
        return path

    def test_package_writes_runtime_json_archive_and_manifest(self) -> None:
        status, archive, _ = self.package()
        self.assertEqual(status, 0)
        self.assertEqual(archive, os.path.join(self.out, f"supercollider-{VERSION}-darwin-arm64.tar.gz"))
        with tarfile.open(archive) as tar:
            entries = [(entry.name, entry.mode, entry.uid, entry.gid, entry.uname, entry.mtime) for entry in tar]
            member = tar.extractfile("runtime.json")
            assert member is not None
            record = json.loads(member.read())
        self.assertEqual(entries, [(name, FILES[name][1], 0, 0, "", EPOCH) for name in sorted(FILES)] + [("runtime.json", 0o644, 0, 0, "", EPOCH)])
        self.assertEqual(record, self.record(platform="darwin", arch="arm64"))
        with open(archive, "rb") as stream:
            data = stream.read()
        self.assertEqual(self.manifest(), {"format": 1, "version": VERSION, "supercollider": SUPERCOLLIDER, "artifacts": {
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

    def test_package_refuses_links_programs_without_execute_permission_and_dot_files(self) -> None:
        stage = self.stage()
        os.symlink("sclang", os.path.join(stage, "sclang-link"))
        status, _, error = self.run_tool(*self.package_arguments(stage))
        self.assertEqual(status, 1)
        self.assertIn("is not a plain file or folder; a runtime holds no links", error)
        status, _, error = self.package(files={**FILES, "scsynth": (b"scsynth bytes", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("is not an executable file at the root of the stage", error)
        status, _, error = self.package(files={**FILES, "SCClassLibrary/.DS_Store": (b"", 0o644)})
        self.assertEqual(status, 1)
        self.assertIn("cannot name a file inside a runtime", error)
        status, _, error = self.package(files={name: value for name, value in FILES.items() if not name.startswith("HelpSource/")})
        self.assertEqual(status, 1)
        self.assertIn("lists no file in the helpSource folder 'HelpSource'", error)
        self.assertFalse(os.path.exists(os.path.join(self.out, "manifest.json")))

    def test_package_keeps_the_artifacts_of_other_platforms_and_refuses_another_release(self) -> None:
        self.assertEqual(self.package()[0], 0)
        self.assertEqual(self.package(platform="linux")[0], 0)
        self.assertEqual(sorted(self.manifest()["artifacts"]), ["darwin-arm64", "linux-x64"])  # type: ignore[arg-type]
        status, _, error = self.package(platform="linux", supercollider="3.14.0")
        self.assertEqual(status, 1)
        self.assertIn("has supercollider '3.14.1', not '3.14.0'", error)

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
        status, _, error = self.run_tool("install", "--archive", archive, "--root", root, "--version", "3.14.1-wasd.2")
        self.assertEqual(status, 1)
        self.assertIn("holds runtime '3.14.1-wasd.1', not '3.14.1-wasd.2'", error)
        status, _, error = self.run_tool("install", "--archive", archive, "--root", "relative", "--version", VERSION)
        self.assertEqual(status, 1)
        self.assertIn("--root must be an absolute path", error)

    def test_install_refuses_unsafe_unlisted_and_mismatched_entries(self) -> None:
        root = self.directory("runtime-root")
        link = tarfile.TarInfo("plugins/link.scx")
        link.type = tarfile.SYMTYPE
        link.linkname = "../../outside"
        cases = [
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("../outside"), b"x")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("/etc/outside"), b"x")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(link, b"")]), "is not a uniquely named plain file inside the runtime"),
            (self.handmade_archive(self.record(), [(tarfile.TarInfo("plugins/Extra.scx"), b"x")]), "does not hold exactly the files runtime.json lists (unlisted plugins/Extra.scx)"),
            (self.handmade_archive(self.record(sha256={**self.record()["sha256"], "sclang": "0" * 64})), "the SHA-256 of sclang does not match runtime.json"),  # type: ignore[dict-item]
            (self.handmade_archive(self.record(sclang="scsynth")), "must name five entries other than runtime.json"),
        ]
        for archive, message in cases:
            status, _, error = self.run_tool("install", "--archive", archive, "--root", root, "--version", VERSION)
            self.assertEqual(status, 1, message)
            self.assertIn(message, error)
            self.assertEqual(os.listdir(root), [])
        self.assertFalse(os.path.exists(os.path.join(self.root, "outside")))

    def test_merge_and_verify_check_every_archive_against_the_merged_manifest(self) -> None:
        darwin, linux = self.directory("darwin"), self.directory("linux")
        self.assertEqual(self.package(out=darwin)[0], 0)
        self.assertEqual(self.package(platform="linux", out=linux)[0], 0)
        release = self.directory("release")
        for folder in (darwin, linux):
            for name in os.listdir(folder):
                if name.endswith(".tar.gz"):
                    shutil.copy(os.path.join(folder, name), release)
        merged = os.path.join(release, "manifest.json")
        self.assertEqual(self.run_tool("merge", "--output", merged, os.path.join(darwin, "manifest.json"), os.path.join(linux, "manifest.json"))[0], 0)
        self.assertEqual(sorted(self.manifest(merged)["artifacts"]), ["darwin-arm64", "linux-x64"])  # type: ignore[arg-type]
        verify = ["verify", "--manifest", merged, "--dir", release, "--version", VERSION, "--base-url", BASE_URL]
        self.assertEqual(self.run_tool(*verify)[0], 0)
        status, _, error = self.run_tool(*verify[:-1], "https://example.com/elsewhere/")
        self.assertEqual(status, 1)
        self.assertIn("artifacts.darwin-arm64.url is", error)
        with open(os.path.join(release, f"supercollider-{VERSION}-win32-x64.tar.gz"), "wb") as stream:
            stream.write(b"stray")
        status, _, error = self.run_tool(*verify)
        self.assertEqual(status, 1)
        self.assertIn("holds archives that", error)

    def test_supercollider_version_reads_scversion_txt(self) -> None:
        source = self.directory("source")
        with open(os.path.join(source, "SCVersion.txt"), "w", encoding="utf-8") as stream:
            stream.write('set(SC_VERSION_MAJOR 3)\nset(SC_VERSION_MINOR 15)\nset(SC_VERSION_PATCH 0)\nset(SC_VERSION_TWEAK "-rc1")\n')
        self.assertEqual(self.run_tool("supercollider-version", "--source", source)[:2], (0, "3.15.0-rc1"))
        status, _, error = self.run_tool("supercollider-version", "--source", self.directory("empty"))
        self.assertEqual(status, 1)
        self.assertIn("the source is not a SuperCollider source tree", error)


if __name__ == "__main__":
    unittest.main()
