"""Tests of template.py: deterministic packaging, the archive and manifest, verification, and the plugin pin."""

from __future__ import annotations

import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from contextlib import redirect_stderr, redirect_stdout

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import template  # noqa: E402

REPOSITORY = "WASDEngine/WASD-Engine"
VERSION = "4.7.2-wasd.1"
BASE_URL = f"https://github.com/{REPOSITORY}/releases/download/web-template-{VERSION}/"


def scons_zip(path: str, members=template.TEMPLATE_MEMBERS, time=(2026, 11, 13, 12, 0, 0)) -> None:
    """Write a template ZIP as SCons does: deflated entries with their files' times."""
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as archive:
        for name in reversed(members):
            info = zipfile.ZipInfo(name, time)
            info.compress_type = zipfile.ZIP_DEFLATED
            archive.writestr(info, f"contents of {name}\n" * 50)


class TemplateTest(unittest.TestCase):
    def setUp(self) -> None:
        self.directory = tempfile.TemporaryDirectory()
        self.root = self.directory.name

    def tearDown(self) -> None:
        self.directory.cleanup()

    def path(self, *parts: str) -> str:
        return os.path.join(self.root, *parts)

    def package(self, out: str = "out", **kwargs) -> dict:
        source = self.path("scons.zip")
        if not os.path.exists(source):
            scons_zip(source)
        options = {"version": VERSION, "godot": "4.7.2-stable", "emscripten": "4.0.20", "repository": REPOSITORY}
        options.update(kwargs)
        return template.package(source, self.path(out), **options)

    def test_same_files_give_the_same_template(self) -> None:
        scons_zip(self.path("a.zip"), time=(2026, 1, 1, 0, 0, 0))
        scons_zip(self.path("b.zip"), time=(2026, 6, 1, 12, 30, 0))
        template.write_template(self.path("a.zip"), self.path("a-template.zip"))
        template.write_template(self.path("b.zip"), self.path("b-template.zip"))
        self.assertEqual(template.sha256_file(self.path("a-template.zip")), template.sha256_file(self.path("b-template.zip")))
        with zipfile.ZipFile(self.path("a-template.zip")) as archive:
            infos = archive.infolist()
            self.assertEqual([info.filename for info in infos], list(template.TEMPLATE_MEMBERS))
            self.assertTrue(all(info.compress_type == zipfile.ZIP_STORED and info.date_time == template.ZIP_TIME for info in infos))
            self.assertEqual(archive.read("godot.wasm"), b"contents of godot.wasm\n" * 50)

    def test_package_writes_the_archive_and_manifest(self) -> None:
        manifest = self.package()
        with open(self.path("out", "manifest.json"), encoding="utf-8") as stream:
            self.assertEqual(json.load(stream), manifest)
        self.assertEqual(manifest["template"]["entry"], "templates/web_nothreads_release.zip")
        self.assertEqual(manifest["template"]["sha256"], template.sha256_file(self.path("out", "web_nothreads_release.zip")))
        self.assertEqual(manifest["archive"]["url"], BASE_URL + "web-template-4.7.2-wasd.1.tpz")
        self.assertEqual(manifest["emscripten"], "4.0.20")
        with zipfile.ZipFile(self.path("out", "web-template-4.7.2-wasd.1.tpz")) as archive:
            self.assertEqual(sorted(archive.namelist()), ["templates/version.txt", "templates/web_nothreads_release.zip"])
            self.assertEqual(archive.read("templates/version.txt"), b"4.7.2.stable")
            with open(self.path("out", "web_nothreads_release.zip"), "rb") as stream:
                self.assertEqual(archive.read("templates/web_nothreads_release.zip"), stream.read())

    def test_package_refuses_a_zip_that_is_not_a_web_release_template(self) -> None:
        scons_zip(self.path("scons.zip"), members=template.TEMPLATE_MEMBERS[:-1])
        with self.assertRaisesRegex(template.TemplateToolError, "single-threaded Web release template"):
            self.package()

    def test_package_refuses_invalid_versions(self) -> None:
        for field, value in (("version", "../x"), ("godot", "four"), ("emscripten", "4.0"), ("repository", "no-slash")):
            with self.subTest(field=field), self.assertRaises(template.TemplateToolError):
                self.package(**{field: value})

    def test_verify_accepts_a_packaged_release(self) -> None:
        self.package()
        manifest = template.verify(self.path("out", "manifest.json"), self.path("out"), VERSION, BASE_URL)
        self.assertEqual(manifest["version"], VERSION)

    def test_verify_rejects_changed_files_and_other_releases(self) -> None:
        self.package()
        with self.assertRaisesRegex(template.TemplateToolError, "describes version"):
            template.verify(self.path("out", "manifest.json"), self.path("out"), "4.7.2-wasd.9", BASE_URL)
        with self.assertRaisesRegex(template.TemplateToolError, "archive URL"):
            template.verify(self.path("out", "manifest.json"), self.path("out"), VERSION, "https://example.com/")
        with open(self.path("out", "web_nothreads_release.zip"), "ab") as stream:
            stream.write(b"x")
        with self.assertRaisesRegex(template.TemplateToolError, "the template .* does not match"):
            template.verify(self.path("out", "manifest.json"), self.path("out"), VERSION, BASE_URL)

    def test_pin_compares_the_plugin_default(self) -> None:
        manifest = self.package()
        digest = manifest["template"]["sha256"]
        source = self.path("index.ts")
        with open(source, "w", encoding="utf-8") as stream:
            stream.write(f"    webTemplateSha256: z.string().pattern(/^[0-9a-f]{{64}}$/u).default('{digest}'),\n")
        self.assertEqual(template.pin(self.path("out", "manifest.json"), source), digest)
        with open(source, "w", encoding="utf-8") as stream:
            stream.write(f"    webTemplateSha256: z.string().pattern(/^[0-9a-f]{{64}}$/u).default('{'0' * 64}'),\n")
        with self.assertRaisesRegex(template.TemplateToolError, "pins the Web template 0{64}, but this build is"):
            template.pin(self.path("out", "manifest.json"), source)

    def test_godot_version_reads_version_py(self) -> None:
        with open(self.path("version.py"), "w", encoding="utf-8") as stream:
            stream.write('short_name = "godot"\nmajor = 4\nminor = 7\npatch = 2\nstatus = "stable"\n')
        self.assertEqual(template.godot_version(self.root), "4.7.2-stable")
        with open(self.path("version.py"), "w", encoding="utf-8") as stream:
            stream.write('major = 4\nminor = 8\npatch = 0\nstatus = "beta2"\n')
        self.assertEqual(template.godot_version(self.root), "4.8-beta2")

    def test_main_reports_errors_on_one_line(self) -> None:
        stderr = io.StringIO()
        with redirect_stderr(stderr), redirect_stdout(io.StringIO()):
            status = template.main(["godot-version", "--source", self.path("missing")])
        self.assertEqual(status, 1)
        self.assertRegex(stderr.getvalue(), r"^template\.py: error: cannot read .*version\.py")
        self.assertEqual(stderr.getvalue().count("\n"), 1)


if __name__ == "__main__":
    unittest.main()
