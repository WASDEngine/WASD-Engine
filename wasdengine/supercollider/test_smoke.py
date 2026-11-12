"""Tests for smoke.py: the line that sclang prints after rendering the test files, and how it runs sclang on each platform.

Run with: python3 -B -m unittest discover --start-directory wasdengine/supercollider --pattern 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import os
import tempfile
import unittest

SPEC = importlib.util.spec_from_file_location("supercollider_smoke", os.path.join(os.path.dirname(os.path.abspath(__file__)), "smoke.py"))
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)


def line(*results: str) -> str:
    """Return a SMOKE line for SuperCollider 3.14.1 with the given comma-separated file results."""
    return "SMOKE 3.14.1 " + ";".join(results) + "\n"


WAV = "WAV,0,22050,2,44100,0.5"
OGG = "OGG,0,22528,2,44100,0.497"
FLAC = "FLAC,0,22050,2,44100,0.5"


class CheckTest(unittest.TestCase):
    def test_accepts_half_a_second_of_the_tone_in_every_format(self) -> None:
        self.assertIsNone(smoke.check(line(WAV, OGG, FLAC)))

    def test_rejects_a_silent_file(self) -> None:
        # scsynth renders silence of the full length when it loaded no UGen plugins.
        self.assertEqual(smoke.check(line("WAV,0,22050,2,44100,0", OGG, FLAC)), "the WAV file peaks at 0 instead of about 0.5")

    def test_rejects_a_clipped_file(self) -> None:
        self.assertEqual(smoke.check(line(WAV, OGG, "FLAC,0,22050,2,44100,1.2")), "the FLAC file peaks at 1.2 instead of about 0.5")

    def test_rejects_a_file_of_another_length(self) -> None:
        self.assertEqual(smoke.check(line(WAV, "OGG,0,30000,2,44100,0.5", FLAC)), "the OGG file holds 30000 frames of 2 channels at 44100 Hz")

    def test_rejects_a_failed_render(self) -> None:
        self.assertEqual(smoke.check(line("WAV,1,22050,2,44100,0.5", OGG, FLAC)), "scsynth exited with code 1 while rendering WAV")

    def test_rejects_missing_formats(self) -> None:
        self.assertEqual(smoke.check(line(WAV, FLAC)), "sclang rendered WAV, FLAC")
        self.assertEqual(smoke.check("SMOKE 3.14.1 \n"), "sclang rendered no file")

    def test_rejects_a_result_without_every_field(self) -> None:
        self.assertEqual(smoke.check(line(WAV, "OGG,0,22528,2,44100", FLAC)),
                         "sclang printed the malformed line 'SMOKE 3.14.1 WAV,0,22050,2,44100,0.5;OGG,0,22528,2,44100;FLAC,0,22050,2,44100,0.5'")


class PlatformTest(unittest.TestCase):
    def test_names_the_programs_of_the_build_for_each_platform(self) -> None:
        with tempfile.TemporaryDirectory() as runtime:
            self.assertEqual(smoke.runtime_names(runtime, False)["sclang"], "sclang")
            self.assertEqual(smoke.runtime_names(runtime, True), {"sclang": "sclang.exe", "scsynth": "scsynth.exe", "plugins": "plugins", "classLibrary": "SCClassLibrary"})

    def test_runs_scsynth_through_the_shell_of_each_platform(self) -> None:
        self.assertEqual(smoke.score_program("/rt/scsynth", False), '"exec %".format("/rt/scsynth".shellQuote)')
        self.assertEqual(smoke.score_program("C:\\rt\\scsynth.exe", True), '"C:\\\\rt\\\\scsynth.exe".quote')
        self.assertIn('Score.program = "C:\\\\rt\\\\scsynth.exe".quote;', smoke.command("C:\\rt\\scsynth.exe", "C:\\p", "C:\\w", True))

    def test_deep_plugin_folder_passes_255_bytes_with_few_characters(self) -> None:
        plugins = smoke.deep_plugins(os.path.join(os.sep, "work"))
        self.assertGreater(len(plugins.encode("utf-8")), 255)
        self.assertLess(len(plugins), 120)
        self.assertEqual(smoke.deep_plugins(os.sep + "w" * 300), os.path.join(os.sep + "w" * 300, "plugins"))

    def test_windows_are_looked_for_only_on_windows(self) -> None:
        if os.name != "nt":
            self.assertEqual(smoke.visible_windows(os.getpid()), [])

    def test_process_tree_takes_a_child_only_after_its_parent_was_created(self) -> None:
        parents = {10: 1, 11: 10, 12: 11, 20: 11, 30: 99, 40: 40}
        created = {10: 100, 11: 110, 12: 120, 20: 50, 30: 130, 40: 140}
        # 20 names 11 as its parent but is older than 11: its own parent exited, and Windows gave that id to 11.
        self.assertEqual(smoke.process_tree(10, parents, created.get), {10, 11, 12})
        self.assertEqual(smoke.process_tree(10, {11: 10}, {11: 110}.get), {10})


if __name__ == "__main__":
    unittest.main()
