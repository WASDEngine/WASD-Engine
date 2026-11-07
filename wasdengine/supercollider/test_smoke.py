"""Tests for smoke.py's check of the line that sclang prints after rendering the test files.

Run with: python3 -B -m unittest discover --start-directory wasdengine/supercollider --pattern 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import os
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


if __name__ == "__main__":
    unittest.main()
