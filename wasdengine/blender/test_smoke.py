"""Tests for smoke.py's helpers: the runtime's program, Python's environment, the script, the tree record, and the verdict.

Run with: python3 -B -m unittest discover --start-directory wasdengine/blender --pattern 'test_*.py'
"""

from __future__ import annotations

import importlib.util
import json
import os
import shutil
import tempfile
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location("blender_smoke", os.path.join(os.path.dirname(os.path.abspath(__file__)), "smoke.py"))
assert SPEC is not None and SPEC.loader is not None
smoke = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(smoke)

REPORT = {"blender": "5.2.3", "python": "3.13.18", "numpy": smoke.NUMPY_RESULT}
SIZES = [[smoke.WIDTH, smoke.HEIGHT], [smoke.WIDTH, smoke.HEIGHT]]
FILES = {"glTF binary": True, ".blend": True}
NO_ENTRY = smoke.Application("", None, False)


class SmokeTest(unittest.TestCase):
    def setUp(self) -> None:
        self.runtime = tempfile.mkdtemp(prefix="blender-smoke-test-")
        self.addCleanup(shutil.rmtree, self.runtime)

    def test_program_comes_from_runtime_json_or_the_build_s_path(self) -> None:
        self.assertEqual(smoke.runtime_executable(self.runtime, "python/bin/python3.13"), "python/bin/python3.13")
        with self.assertRaises(SystemExit):
            smoke.runtime_executable(self.runtime, None)
        with open(os.path.join(self.runtime, "runtime.json"), "w", encoding="utf-8") as stream:
            json.dump({"executable": "python/bin/python3.14"}, stream)
        self.assertEqual(smoke.runtime_executable(self.runtime, None), "python/bin/python3.14")

    def test_environment_drops_python_and_electron_redirection(self) -> None:
        with mock.patch.dict(os.environ, {"PYTHONPATH": "/elsewhere", "PYTHONHOME": "/home", "ELECTRON_RUN_AS_NODE": "1", "LANG": "C"}):
            env = smoke.python_environment()
        self.assertNotIn("PYTHONPATH", env)
        self.assertNotIn("PYTHONHOME", env)
        self.assertNotIn("ELECTRON_RUN_AS_NODE", env)
        self.assertEqual(env["LANG"], "C")

    def test_script_compiles_and_names_its_files_from_argv(self) -> None:
        compile(smoke.SCRIPT, "smoke", "exec")
        self.assertIn(f"if {smoke.EEVEE}:", smoke.SCRIPT)
        self.assertIn("sys.argv[1:8]", smoke.SCRIPT)
        self.assertIn(f"resolution_x, scene.render.resolution_y, scene.render.resolution_percentage = {smoke.WIDTH}, {smoke.HEIGHT}, 100", smoke.SCRIPT)

    def test_tree_record_names_added_removed_and_changed_entries(self) -> None:
        os.makedirs(os.path.join(self.runtime, "python", "lib"))
        with open(os.path.join(self.runtime, "python", "lib", "os.py"), "w", encoding="utf-8") as stream:
            stream.write("x")
        before = smoke.tree_state(self.runtime)
        self.assertEqual(smoke.tree_changes(before, smoke.tree_state(self.runtime)), [])
        os.makedirs(os.path.join(self.runtime, "python", "lib", "__pycache__"))
        with open(os.path.join(self.runtime, "python", "lib", "os.py"), "a", encoding="utf-8") as stream:
            stream.write("y")
        self.assertEqual(smoke.tree_changes(before, smoke.tree_state(self.runtime)), ["python/lib/__pycache__", "python/lib/os.py"])

    def test_files_start_with_any_accepted_header(self) -> None:
        blend = os.path.join(self.runtime, "scene.blend")
        with open(blend, "wb") as stream:
            stream.write(b"\x28\xb5\x2f\xfd compressed")
        self.assertTrue(smoke.starts_with(blend, smoke.BLEND_HEADERS))
        self.assertFalse(smoke.starts_with(blend, (b"glTF",)))
        self.assertFalse(smoke.starts_with(os.path.join(self.runtime, "missing"), smoke.BLEND_HEADERS))

    def test_entry_type_reads_lsappinfo_output(self) -> None:
        self.assertEqual(smoke.entry_type('pid = 59418 token=[sess=1] !signalled type="BackgroundOnly" flavor=3'), "BackgroundOnly")
        self.assertIsNone(smoke.entry_type("!cgsConnection !signalled type=[ NULL ]  flavor=[ NULL ]"))

    def test_verdict_accepts_no_entry_or_a_background_only_one_and_names_every_problem(self) -> None:
        self.assertEqual(smoke.problems(0, REPORT, "5.2.3", SIZES, FILES, NO_ENTRY, []), [])
        self.assertEqual(smoke.problems(0, REPORT, "5.2.3", SIZES[:1], FILES, NO_ENTRY, []), [])
        hidden = smoke.Application("ASN:0x0-0x245245", "BackgroundOnly", False)
        self.assertEqual(smoke.problems(0, REPORT, None, SIZES, FILES, hidden, []), [])
        shown = smoke.Application("ASN:0x0-0x245245", "Foreground", True)
        found = smoke.problems(1, {"blender": "5.2.2", "numpy": 0}, "5.2.3", [None, [1, 1]], {"glTF binary": False, ".blend": True},
                               shown, ["python/lib/__pycache__"])
        self.assertEqual(len(found), 9)
        self.assertIn("Python exited with status 1", found)
        self.assertIn("macOS lists Blender's process as an application of type Foreground, not BackgroundOnly: ASN:0x0-0x245245", found)
        self.assertIn("macOS shows Blender's process in the Dock and the application switcher: ASN:0x0-0x245245", found)
        self.assertIn("the run changed the runtime: python/lib/__pycache__", found)
        unset = smoke.problems(0, None, None, SIZES, FILES, smoke.Application("ASN:0x0-0x1", None, False), [])
        self.assertEqual(unset, ["the script reported nothing", "macOS lists Blender's process as an application of type unset, not BackgroundOnly: ASN:0x0-0x1"])


if __name__ == "__main__":
    unittest.main()
