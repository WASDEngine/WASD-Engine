"""Tests for patches/: the series that build.sh applies in file-name order, each hunk's line counts, and the GDScript
profiling changes of patch 0004 that the harness relies on.

Run with: python3 -B -m unittest discover --start-directory wasdengine/libgodot --pattern 'test_*.py'
"""

from __future__ import annotations

import os
import re
import unittest
from typing import Dict, List, NamedTuple

PATCHES = os.path.join(os.path.dirname(os.path.abspath(__file__)), "patches")
NAME = re.compile(r"^(\d{4})-[a-z0-9]+(?:-[a-z0-9]+)*\.patch\Z")
FILE_HEADER = re.compile(r"^diff --git a/(\S+) b/(\S+)\Z")
HUNK_HEADER = re.compile(r"^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@")
# Lines of a file section between its diff --git line and its first hunk.
SECTION_LINES = re.compile(r"^(?:(?:new|deleted) file mode \d+|index [0-9a-f]+\.\.[0-9a-f]+(?: \d+)?|--- (?:a/\S+|/dev/null)|\+\+\+ (?:b/\S+|/dev/null))\Z")
VM = "modules/gdscript/gdscript_vm.cpp"


class Hunk(NamedTuple):
    old_count: int
    new_count: int
    lines: List[str]


def patch_names() -> List[str]:
    return sorted(name for name in os.listdir(PATCHES) if name.endswith(".patch"))


def read_patch(name: str) -> str:
    with open(os.path.join(PATCHES, name), encoding="utf-8", newline="") as stream:
        return stream.read()


def parse(text: str) -> Dict[str, List[Hunk]]:
    """Split a git diff into its files' hunks.

    @param text: the patch.
    @returns: each changed file's hunks, by the file's path.
    @raises AssertionError: for a line outside the structure of a git diff, or a hunk whose lines do not match its header.
    """
    files: Dict[str, List[Hunk]] = {}
    current: List[Hunk] = []
    lines = text.split("\n")
    assert lines[-1] == "", "the patch does not end with a newline"
    index = 0
    body = lines[:-1]
    while index < len(body):
        line = body[index]
        header = FILE_HEADER.match(line)
        if header is not None:
            assert header.group(1) == header.group(2), line
            current = files.setdefault(header.group(2), [])
            index += 1
            while index < len(body) and SECTION_LINES.match(body[index]):
                index += 1
            continue
        hunk = HUNK_HEADER.match(line)
        assert hunk is not None, f"unexpected line {index + 1}: {line!r}"
        old_count = int(hunk.group(2) or "1")
        new_count = int(hunk.group(4) or "1")
        index += 1
        hunk_lines: List[str] = []
        old_seen = new_seen = 0
        while index < len(body) and (old_seen < old_count or new_seen < new_count):
            entry = body[index]
            if entry.startswith("\\"):
                index += 1
                continue
            assert entry[:1] in (" ", "-", "+"), f"line {index + 1} is not a hunk line: {entry!r}"
            old_seen += entry[0] in " -"
            new_seen += entry[0] in " +"
            hunk_lines.append(entry)
            index += 1
        assert (old_seen, new_seen) == (old_count, new_count), f"hunk {line!r} holds {old_seen} old and {new_seen} new lines"
        current.append(Hunk(old_count, new_count, hunk_lines))
    return files


class PatchSeriesTest(unittest.TestCase):
    def test_the_patches_are_numbered_in_the_order_build_sh_applies_them(self) -> None:
        names = patch_names()
        self.assertGreaterEqual(len(names), 4)
        numbers = []
        for name in names:
            match = NAME.match(name)
            self.assertIsNotNone(match, name)
            assert match is not None
            numbers.append(int(match.group(1)))
        self.assertEqual(numbers, list(range(1, len(names) + 1)))

    def test_every_hunk_holds_the_lines_its_header_counts(self) -> None:
        for name in patch_names():
            with self.subTest(patch=name):
                text = read_patch(name)
                self.assertNotIn("\r", text)
                files = parse(text)
                self.assertTrue(files)
                # The repository's whitespace check refuses a patch whose last line is blank.
                self.assertNotEqual(text.rstrip("\n").split("\n")[-1].strip(), "")


class NativeCallProfilingPatchTest(unittest.TestCase):
    def setUp(self) -> None:
        names = [name for name in patch_names() if name.startswith("0004-")]
        self.assertEqual(len(names), 1)
        self.files = parse(read_patch(names[0]))

    def changed(self, path: str, sign: str) -> List[str]:
        return [line[1:] for hunk in self.files[path] for line in hunk.lines if line.startswith(sign)]

    def test_every_native_call_profiling_check_of_the_vm_requires_the_main_thread(self) -> None:
        removed = [line for line in self.changed(VM, "-") if "profile_native_calls" in line]
        added = [line for line in self.changed(VM, "+") if "profile_native_calls" in line]
        # The checks at the start and the end of each typed engine method call, and the one of untyped calls.
        self.assertEqual(len(removed), 13)
        self.assertEqual(len(added), len(removed))
        for line in added:
            self.assertIn("Thread::is_main_thread()", line)
        unchanged = [line for hunk in self.files[VM] for line in hunk.lines if line.startswith(" ") and "profile_native_calls" in line]
        self.assertEqual(unchanged, [])

    def test_a_call_that_began_before_profiling_adds_no_time(self) -> None:
        exits = [line for line in self.changed(VM, "+") if "function_start_time != 0" in line]
        self.assertEqual(len(exits), 1)
        self.assertIn("GDScriptLanguage::get_singleton()->profiling", exits[0])

    def test_the_runtime_singleton_reports_that_native_call_profiling_is_thread_safe(self) -> None:
        # runtime/wasd_harness.gd times engine methods only on runtimes whose singleton has this method.
        header = "".join(self.changed("modules/wasd_runtime/wasd_engine_runtime.h", "+"))
        source = "".join(self.changed("modules/wasd_runtime/wasd_engine_runtime.cpp", "+"))
        self.assertIn("bool is_native_call_profiling_thread_safe() const { return true; }", header)
        self.assertIn('D_METHOD("is_native_call_profiling_thread_safe")', source)


if __name__ == "__main__":
    unittest.main()
