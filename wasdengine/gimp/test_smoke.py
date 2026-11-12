"""Tests for smoke.py's helpers: the runtime layout, GIMP's environment, the batch command, and the verdict.

Run with: python3 -B -m unittest discover --start-directory wasdengine/gimp --pattern 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("gimp_smoke", os.path.join(os.path.dirname(os.path.abspath(__file__)), "smoke.py"))
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)

OUTPUT = "GIMP-Message: Welcome to GIMP 3.2.8!\nbatch command executed successfully\n"


class SmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = tempfile.mkdtemp(prefix="gimp-smoke-test-")
        self.addCleanup(shutil.rmtree, self.runtime)

    def test_layout_comes_from_runtime_json_or_the_build_s_names(self) -> None:
        self.assertEqual(smoke.runtime_layout(self.runtime, "Contents/MacOS/gimp-console-3.2", False)["dataDir"], "Contents/share/gimp/3.0")
        self.assertEqual(smoke.runtime_layout(self.runtime, "bin/gimp-console-3.2.exe", True),
                         {"console": "bin/gimp-console-3.2.exe", "dataDir": "share/gimp/3.0", "localeDir": "share/locale", "sysconfDir": "etc/gimp/3.0"})
        with self.assertRaises(SystemExit):
            smoke.runtime_layout(self.runtime, None)
        with open(os.path.join(self.runtime, "runtime.json"), "w", encoding="utf-8") as stream:
            json.dump({"console": "Contents/MacOS/gimp-console-3.4", "dataDir": "Contents/share/gimp/3.0",
                       "localeDir": "Contents/share/locale", "sysconfDir": "Contents/etc/gimp/3.0"}, stream)
        self.assertEqual(smoke.runtime_layout(self.runtime, None)["console"], "Contents/MacOS/gimp-console-3.4")

    def test_environment_names_the_profile_and_folders_without_python_redirection(self) -> None:
        layout = smoke.runtime_layout(self.runtime, "Contents/MacOS/gimp-console-3.2", False)
        with mock.patch.dict(os.environ, {"PYTHONPATH": "/elsewhere", "ELECTRON_RUN_AS_NODE": "1"}):
            env = smoke.gimp_environment(self.runtime, layout, "/work/profile")
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
        self.assertEqual(env["GIMP3_DIRECTORY"], "/work/profile")
        self.assertEqual(env["GIMP3_LOCALEDIR"], os.path.join(self.runtime, "Contents", "share", "locale"))

    def test_batch_command_quotes_paths_as_string_literals(self) -> None:
        command = smoke.batch_command('/w/it\'s "a".png', "/w/result.json", "/w/started")
        self.assertIn('Gio.File.new_for_path("/w/it\'s \\"a\\".png")', command)
        compile(command, "batch", "exec")

    def test_verdict_names_every_problem(self) -> None:
        data = os.path.join(self.runtime, "Contents", "share", "gimp", "3.0")
        self.assertEqual(smoke.problems(0, OUTPUT, [smoke.WIDTH, smoke.HEIGHT], data, data, ""), [])
        found = smoke.problems(1, "[file-png] The catalog directory does not exist: /x\n", None, "/other", data, "ASN:0x0-0x1: GIMP")
        self.assertEqual(len(found), 6)
        self.assertIn("GIMP exited with status 1", found)
        self.assertTrue(any("macOS lists an application" in problem for problem in found))
        stray = "Skipping unknown file '/r/lib/gimp/3.0/extensions/a.txt' in extension directory.\n" + OUTPUT
        self.assertEqual(smoke.problems(0, stray, [smoke.WIDTH, smoke.HEIGHT], data, data, ""), ["GIMP printed 'Skipping unknown file'"])
        shown = smoke.problems(0, OUTPUT, [smoke.WIDTH, smoke.HEIGHT], data, data, "", ["python.exe (42): ConsoleWindowClass 'C:\\x'"])
        self.assertEqual(shown, ["GIMP's processes showed windows: python.exe (42): ConsoleWindowClass 'C:\\x'"])

    def test_windows_are_looked_for_only_on_windows(self) -> None:
        if os.name != "nt":
            self.assertEqual(smoke.visible_windows(os.getpid()), [])
        else:
            self.assertIsInstance(smoke.visible_windows(os.getpid()), list)

    def test_process_tree_takes_a_child_only_after_its_parent_was_created(self) -> None:
        parents = {10: 1, 11: 10, 12: 11, 20: 11, 30: 99, 40: 40}
        created = {10: 100, 11: 110, 12: 120, 20: 50, 30: 130, 40: 140}
        # 20 names 11 as its parent but is older than 11: its own parent exited, and Windows gave that id to 11.
        self.assertEqual(smoke.process_tree(10, parents, created.get), {10, 11, 12})
        self.assertEqual(smoke.process_tree(10, {11: 10}, {11: 110}.get), {10})


if __name__ == "__main__":
    unittest.main()
