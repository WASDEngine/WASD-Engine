"""Tests for runtime.py: packaging, installing, merging, and verifying LibGodot runtime archives.

Run with: python3 -B -m unittest discover --start-directory wasdengine/libgodot --pattern 'test_*.py'
"""

from __future__ import annotations

import contextlib
import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import unittest
from typing import Dict, List, Tuple
from unittest import mock

SPEC = importlib.util.spec_from_file_location("libgodot_runtime", os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime.py"))
assert SPEC is not None and SPEC.loader is not None
runtime = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(runtime)

VERSION = "4.7.2-wasd.1"
GODOT = "4.7.2-stable"
EPOCH = 1_700_000_000
BASE_URL = f"https://github.com/WASDEngine/WASD-Engine/releases/download/libgodot-{VERSION}/"
LIBRARIES = {"darwin": "libgodot.macos.editor.arm64.dylib", "linux": "libgodot.linuxbsd.editor.x86_64.so"}


def sha256(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


class RuntimeToolTest(unittest.TestCase):
    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="libgodot-runtime-test-")
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

    def stage(self, name: str, library: str, library_bytes: bytes, runner: str = "godot_runner") -> str:
        stage = self.directory(name)
        for file_name, data in ((runner, b"runner bytes"), (library, library_bytes)):
            with open(os.path.join(stage, file_name), "wb") as stream:
                stream.write(data)
        return stage

    def package_arguments(self, platform: str = "darwin", version: str = VERSION, library_bytes: bytes = b"library bytes", out: str = "", godot: str = GODOT) -> List[str]:
        arch = "arm64" if platform == "darwin" else "x64"
        self.stages += 1
        stage = self.stage(f"stage-{self.stages}", LIBRARIES[platform], library_bytes)
        return [
            "package", "--stage", stage, "--out", out or self.out, "--version", version, "--godot", godot,
            "--platform", platform, "--arch", arch, "--runner", "godot_runner", "--library", LIBRARIES[platform],
            "--repository", "WASDEngine/WASD-Engine",
        ]

    def package(self, platform: str = "darwin", version: str = VERSION, library_bytes: bytes = b"library bytes", out: str = "", godot: str = GODOT) -> Tuple[int, str, str]:
        return self.run_tool(*self.package_arguments(platform, version, library_bytes, out, godot))

    def manifest(self, path: str = "") -> Dict[str, object]:
        with open(path or os.path.join(self.out, "manifest.json"), encoding="utf-8") as stream:
            return json.load(stream)

    def write_tar(self, path: str, entries: List[Tuple[tarfile.TarInfo, bytes]]) -> None:
        with tarfile.open(path, "w:gz") as archive:
            for entry, data in entries:
                entry.size = len(data)
                archive.addfile(entry, io.BytesIO(data))

    def test_package_writes_runtime_json_archive_and_manifest(self) -> None:
        status, archive, _ = self.package()
        self.assertEqual(status, 0)
        self.assertEqual(archive, os.path.join(self.out, f"libgodot-{VERSION}-darwin-arm64.tar.gz"))
        with tarfile.open(archive) as tar:
            entries = [(entry.name, entry.mode, entry.uid, entry.gid, entry.uname, entry.mtime) for entry in tar]
            record = json.loads(tar.extractfile("runtime.json").read())
        self.assertEqual(entries, [
            ("godot_runner", 0o755, 0, 0, "", EPOCH),
            (LIBRARIES["darwin"], 0o755, 0, 0, "", EPOCH),
            ("runtime.json", 0o644, 0, 0, "", EPOCH),
        ])
        self.assertEqual(record, {
            "format": 1, "version": VERSION, "godot": GODOT, "platform": "darwin", "arch": "arm64",
            "runner": "godot_runner", "library": LIBRARIES["darwin"],
            "sha256": {"godot_runner": sha256(b"runner bytes"), LIBRARIES["darwin"]: sha256(b"library bytes")},
        })
        with open(archive, "rb") as stream:
            data = stream.read()
        self.assertEqual(self.manifest(), {"format": 1, "version": VERSION, "godot": GODOT, "artifacts": {
            "darwin-arm64": {
                "url": BASE_URL + os.path.basename(archive), "bytes": len(data), "sha256": sha256(data),
                "runner": "godot_runner", "library": LIBRARIES["darwin"],
            },
        }})

    def test_package_output_is_reproducible_with_source_date_epoch(self) -> None:
        first_out, second_out = self.directory("first"), self.directory("second")
        archives = []
        for out in (first_out, second_out):
            status, archive, _ = self.package(out=out)
            self.assertEqual(status, 0)
            with open(archive, "rb") as stream:
                archives.append(stream.read())
        self.assertEqual(archives[0], archives[1])

    def test_package_keeps_other_platforms_and_rejects_another_version(self) -> None:
        self.assertEqual(self.package("linux")[0], 0)
        self.assertEqual(self.package("darwin")[0], 0)
        self.assertEqual(list(self.manifest()["artifacts"]), ["darwin-arm64", "linux-x64"])
        status, _, stderr = self.package("darwin", version="4.7.2-wasd.2")
        self.assertEqual(status, 1)
        self.assertIn("has version '4.7.2-wasd.1', not '4.7.2-wasd.2'", stderr)

    def test_package_rejects_invalid_versions(self) -> None:
        for version in ("../evil", "4.7..2", "-4.7", f"{VERSION}\n"):
            status, _, stderr = self.package(version=version)
            self.assertEqual(status, 1, version)
            self.assertIn("invalid runtime version", stderr)

    def test_package_rejects_godot_versions_that_godot_version_cannot_print(self) -> None:
        for godot in (f"{GODOT}\r", f"{GODOT}\n", "stable", "4.7.2 stable"):
            status, _, stderr = self.package(godot=godot)
            self.assertEqual(status, 1, repr(godot))
            self.assertIn(f"godot is {godot!r}, which is not valid", stderr)
        self.assertFalse(os.path.exists(os.path.join(self.out, "manifest.json")))

    def test_the_command_prints_utf8_lines_with_lf_under_windows_text_mode(self) -> None:
        # Windows gives a piped stdout CRLF line ends and the ANSI code page; the script must still print the path as build.sh reads it.
        out = self.directory("out ü 游戏")
        emulate_windows = (
            "import io, runpy, sys; sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='cp1252', newline='\\r\\n'); "
            "sys.argv = sys.argv[1:]; runpy.run_path(sys.argv[0], run_name='__main__')"
        )
        result = subprocess.run([sys.executable, "-B", "-I", "-c", emulate_windows, SPEC.origin, *self.package_arguments(out=out)], capture_output=True)
        self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))
        self.assertEqual(result.stdout, (os.path.join(out, f"libgodot-{VERSION}-darwin-arm64.tar.gz") + "\n").encode("utf-8"))

    def test_install_replaces_the_previous_runtime_in_one_move(self) -> None:
        data_root = self.directory("data")
        target = os.path.join(data_root, "runtime", VERSION)
        for library_bytes in (b"first library", b"second library"):
            out = self.directory(f"out-{library_bytes.decode().split()[0]}")
            archive = self.package(out=out, library_bytes=library_bytes)[1]
            status, installed, _ = self.run_tool("install", "--archive", archive, "--data-root", data_root, "--version", VERSION)
            self.assertEqual((status, installed), (0, target))
            with open(os.path.join(target, LIBRARIES["darwin"]), "rb") as stream:
                self.assertEqual(stream.read(), library_bytes)
        self.assertEqual(sorted(os.listdir(os.path.join(data_root, "runtime"))), [VERSION])
        self.assertEqual(sorted(os.listdir(target)), sorted(["godot_runner", LIBRARIES["darwin"], "runtime.json"]))
        if os.name != "nt":
            self.assertEqual(os.stat(os.path.join(target, "godot_runner")).st_mode & 0o777, 0o755)
            self.assertEqual(os.stat(os.path.join(target, "runtime.json")).st_mode & 0o777, 0o644)

    def test_install_rejects_a_tampered_archive_and_keeps_the_installed_runtime(self) -> None:
        data_root = self.directory("data")
        archive = self.package()[1]
        self.assertEqual(self.run_tool("install", "--archive", archive, "--data-root", data_root, "--version", VERSION)[0], 0)
        tampered = os.path.join(self.root, "tampered.tar.gz")
        with tarfile.open(archive) as tar:
            entries = [(entry, tar.extractfile(entry).read()) for entry in tar]
        self.write_tar(tampered, [(entry, b"other library" if entry.name == LIBRARIES["darwin"] else data) for entry, data in entries])
        status, _, stderr = self.run_tool("install", "--archive", tampered, "--data-root", data_root, "--version", VERSION)
        self.assertEqual(status, 1)
        self.assertIn(f"the SHA-256 of {LIBRARIES['darwin']} does not match runtime.json", stderr)
        with open(os.path.join(data_root, "runtime", VERSION, LIBRARIES["darwin"]), "rb") as stream:
            self.assertEqual(stream.read(), b"library bytes")
        self.assertEqual(os.listdir(os.path.join(data_root, "runtime")), [VERSION])

    def test_install_rejects_relative_roots_other_versions_and_unsafe_entries(self) -> None:
        archive = self.package()[1]
        status, _, stderr = self.run_tool("install", "--archive", archive, "--data-root", "relative", "--version", VERSION)
        self.assertEqual(status, 1)
        self.assertIn("--data-root must be an absolute path", stderr)
        data_root = self.directory("data")
        status, _, stderr = self.run_tool("install", "--archive", archive, "--data-root", data_root, "--version", "4.7.2-wasd.9")
        self.assertEqual(status, 1)
        self.assertIn("holds runtime '4.7.2-wasd.1', not '4.7.2-wasd.9'", stderr)
        link = tarfile.TarInfo("godot_runner")
        link.type, link.linkname = tarfile.SYMTYPE, "/bin/sh"
        for name, entry in (("nested", tarfile.TarInfo("bin/godot_runner")), ("link", link)):
            unsafe = os.path.join(self.root, f"{name}.tar.gz")
            self.write_tar(unsafe, [(entry, b"" if entry.issym() else b"data")])
            status, _, stderr = self.run_tool("install", "--archive", unsafe, "--data-root", data_root, "--version", VERSION)
            self.assertEqual(status, 1, name)
            self.assertIn("is not a uniquely named plain file at the archive root", stderr)
        self.assertEqual(os.listdir(os.path.join(data_root, "runtime")), [])

    def test_merge_combines_manifests_of_one_version(self) -> None:
        darwin_out, linux_out = self.directory("darwin"), self.directory("linux")
        self.package("darwin", out=darwin_out)
        self.package("linux", out=linux_out)
        merged = os.path.join(self.root, "manifest.json")
        status, _, _ = self.run_tool("merge", "--output", merged, os.path.join(linux_out, "manifest.json"), os.path.join(darwin_out, "manifest.json"))
        self.assertEqual(status, 0)
        self.assertEqual(list(self.manifest(merged)["artifacts"]), ["darwin-arm64", "linux-x64"])
        other = self.manifest(os.path.join(linux_out, "manifest.json"))
        other["godot"] = "4.7.3-stable"
        with open(os.path.join(linux_out, "manifest.json"), "w", encoding="utf-8") as stream:
            json.dump(other, stream)
        status, _, stderr = self.run_tool("merge", "--output", merged, os.path.join(darwin_out, "manifest.json"), os.path.join(linux_out, "manifest.json"))
        self.assertEqual(status, 1)
        self.assertIn("has godot '4.7.3-stable', not '4.7.2-stable'", stderr)

    def test_merge_rejects_manifests_with_unknown_fields(self) -> None:
        self.package()
        manifest = self.manifest()
        manifest["channel"] = "beta"
        with open(os.path.join(self.out, "manifest.json"), "w", encoding="utf-8") as stream:
            json.dump(manifest, stream)
        status, _, stderr = self.run_tool("merge", "--output", os.path.join(self.root, "merged.json"), os.path.join(self.out, "manifest.json"))
        self.assertEqual(status, 1)
        self.assertIn("unexpected fields (unknown channel)", stderr)

    def verify(self) -> Tuple[int, str, str]:
        return self.run_tool("verify", "--manifest", os.path.join(self.out, "manifest.json"), "--dir", self.out, "--version", VERSION, "--base-url", BASE_URL)

    def test_verify_accepts_a_matching_release_directory(self) -> None:
        self.package("darwin")
        self.package("linux")
        self.assertEqual(self.verify()[0], 0)

    def test_verify_rejects_urls_extra_archives_and_changed_bytes(self) -> None:
        archive = self.package()[1]
        status, _, stderr = self.run_tool("verify", "--manifest", os.path.join(self.out, "manifest.json"), "--dir", self.out, "--version", VERSION, "--base-url", "https://example.com/")
        self.assertEqual(status, 1)
        self.assertIn("url is", stderr)
        extra = os.path.join(self.out, f"libgodot-{VERSION}-win32-x64.tar.gz")
        shutil.copy(archive, extra)
        self.assertIn("does not list", self.verify()[2])
        os.unlink(extra)
        with open(archive, "r+b") as stream:
            stream.seek(-1, os.SEEK_END)
            last = stream.read(1)
            stream.seek(-1, os.SEEK_END)
            stream.write(bytes([last[0] ^ 1]))
        self.assertIn("does not match the size and SHA-256", self.verify()[2])

    def test_verify_rejects_an_archive_listed_under_another_platform(self) -> None:
        archive = self.package()[1]
        renamed = os.path.join(self.out, f"libgodot-{VERSION}-linux-x64.tar.gz")
        os.rename(archive, renamed)
        manifest = self.manifest()
        entry = manifest["artifacts"].pop("darwin-arm64")
        entry["url"] = BASE_URL + os.path.basename(renamed)
        manifest["artifacts"]["linux-x64"] = entry
        with open(os.path.join(self.out, "manifest.json"), "w", encoding="utf-8") as stream:
            json.dump(manifest, stream)
        status, _, stderr = self.verify()
        self.assertEqual(status, 1)
        self.assertIn("holds the darwin-arm64 runtime, not linux-x64", stderr)

    def test_godot_version_reads_version_py_without_running_it(self) -> None:
        source = self.directory("godot")
        cases = (
            ('major = 4\nminor = 7\npatch = 2\nstatus = "stable"\n', "4.7.2-stable"),
            ('major = 4\r\nminor = 8\r\npatch = 0\r\nstatus = "beta2"\r\n', "4.8-beta2"),
        )
        for text, expected in cases:
            with open(os.path.join(source, "version.py"), "w", encoding="utf-8", newline="") as stream:
                stream.write(text)
            self.assertEqual(self.run_tool("godot-version", "--source", source)[:2], (0, expected))
        os.unlink(os.path.join(source, "version.py"))
        status, _, stderr = self.run_tool("godot-version", "--source", source)
        self.assertEqual(status, 1)
        self.assertIn("is not a Godot checkout", stderr)


if __name__ == "__main__":
    unittest.main()
