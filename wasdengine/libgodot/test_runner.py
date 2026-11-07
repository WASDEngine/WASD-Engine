"""Tests for godot_runner.c: arguments, exit statuses, stop requests, and the parent watch.

The tests compile the runner and stub_libgodot.c, a stand-in for LibGodot, with the
C compiler cc, so they run on macOS and Linux and are skipped elsewhere.

Run with: python3 -B -m unittest discover --start-directory wasdengine/libgodot --pattern 'test_*.py'
"""

from __future__ import annotations

import os
import shutil
import signal
import subprocess
import sys
import tempfile
import time
import unittest
from typing import Dict, List, Tuple

HERE = os.path.dirname(os.path.abspath(__file__))
# PARENT_EXIT_GRACE_SECONDS in godot_runner.c.
GRACE_SECONDS = 3
DEADLINE_SECONDS = 10
# Starts the runner with --parent-pid naming this process, prints the runner's pid, and waits until it is killed.
PARENT_SCRIPT = """
import os, signal, subprocess, sys
runner, library, output, errors = sys.argv[1:5]
with open(output, "wb") as stdout, open(errors, "wb") as stderr:
    child = subprocess.Popen([runner, "--libgodot", library, "--parent-pid", str(os.getpid()), "--", *sys.argv[5:]],
                             stdin=subprocess.DEVNULL, stdout=stdout, stderr=stderr)
print(child.pid, flush=True)
while True:
    signal.pause()
"""


def compile_c(output: str, source: str, shared: bool) -> None:
    """Compile one C file of this directory for this machine with build.sh's runner flags, treating warnings as errors."""
    command = ["cc", "-std=c11", "-O2", "-Wall", "-Wextra", "-Werror"]
    if sys.platform == "darwin":
        command += ["-dynamiclib"] if shared else []
        command += ["-o", output, os.path.join(HERE, source)]
        command += [] if shared else ["-framework", "CoreFoundation", "-lobjc"]
    else:
        command += ["-D_DEFAULT_SOURCE", "-pthread"] + (["-shared", "-fPIC"] if shared else [])
        command += ["-o", output, os.path.join(HERE, source)]
        command += [] if shared else ["-ldl"]
    result = subprocess.run(command, capture_output=True, text=True)
    if result.returncode != 0:
        raise AssertionError(f"{' '.join(command)} failed:\n{result.stderr}")


def is_running(pid: int) -> bool:
    """Whether a process exists and has not exited; an exited process that nobody reaped yet counts as exited."""
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    state = subprocess.run(["ps", "-o", "stat=", "-p", str(pid)], capture_output=True, text=True).stdout.strip()
    return state != "" and not state.startswith("Z")


def kill_if_running(pid: int) -> None:
    if is_running(pid):
        os.kill(pid, signal.SIGKILL)


def read_text(path: str) -> str:
    with open(path, encoding="utf-8", errors="replace") as stream:
        return stream.read()


@unittest.skipIf(os.name == "nt" or shutil.which("cc") is None, "the runner tests need macOS or Linux with the C compiler cc")
class RunnerTest(unittest.TestCase):
    build = ""
    runner = ""
    library = ""

    @classmethod
    def setUpClass(cls) -> None:
        cls.build = tempfile.mkdtemp(prefix="godot-runner-test-")
        cls.addClassCleanup(shutil.rmtree, cls.build)
        cls.runner = os.path.join(cls.build, "godot_runner")
        cls.library = os.path.join(cls.build, "libstub_libgodot.dylib" if sys.platform == "darwin" else "libstub_libgodot.so")
        compile_c(cls.runner, "godot_runner.c", shared=False)
        compile_c(cls.library, "stub_libgodot.c", shared=True)

    def setUp(self) -> None:
        self.root = tempfile.mkdtemp(prefix="run-", dir=self.build)
        self.runs = 0
        self.log = ""
        self.next_log()

    def next_log(self) -> str:
        self.runs += 1
        self.log = os.path.join(self.root, f"stub-{self.runs}.log")
        return self.log

    def environment(self, mode: str, **extra: str) -> Dict[str, str]:
        return dict(os.environ, STUB_LIBGODOT_MODE=mode, STUB_LIBGODOT_LOG=self.log, **extra)

    def events(self) -> List[str]:
        return read_text(self.log).splitlines() if os.path.exists(self.log) else []

    def wait_for_event(self, event: str) -> None:
        deadline = time.monotonic() + DEADLINE_SECONDS
        while event not in self.events():
            if time.monotonic() > deadline:
                self.fail(f"the stub did not log {event!r}; it logged {self.events()}")
            time.sleep(0.02)

    def run_runner(self, arguments: List[str], mode: str = "quit") -> Tuple[int, str]:
        result = subprocess.run([self.runner, *arguments], env=self.environment(mode), stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=DEADLINE_SECONDS)
        return result.returncode, result.stderr

    def start_runner(self, arguments: List[str], mode: str, **extra: str) -> subprocess.Popen[str]:
        process = subprocess.Popen([self.runner, *arguments], env=self.environment(mode, **extra), stdin=subprocess.DEVNULL,
                                   stdout=subprocess.DEVNULL, stderr=subprocess.PIPE, text=True)
        self.addCleanup(process.communicate)
        self.addCleanup(kill_if_running, process.pid)
        return process

    def orphan(self, mode: str) -> Tuple[int, float, str]:
        """Start the runner under a parent process and kill that parent with SIGKILL once the game runs.

        @returns: the runner's pid, the monotonic time of the kill, and the file holding the runner's stderr.
        """
        self.next_log()
        output, errors = os.path.join(self.root, f"runner-{self.runs}.out"), os.path.join(self.root, f"runner-{self.runs}.err")
        parent = subprocess.Popen([sys.executable, "-I", "-c", PARENT_SCRIPT, self.runner, self.library, output, errors],
                                  env=self.environment(mode), stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, text=True)
        self.addCleanup(parent.wait)
        self.addCleanup(kill_if_running, parent.pid)
        assert parent.stdout is not None
        with parent.stdout:
            runner = int(parent.stdout.readline())
        self.addCleanup(kill_if_running, runner)
        self.wait_for_event("hang" if mode.startswith("hang") else "iteration")
        parent.kill()
        return runner, time.monotonic(), errors

    def wait_for_exit(self, pid: int, seconds: float) -> float:
        deadline = time.monotonic() + seconds
        while is_running(pid):
            if time.monotonic() > deadline:
                self.fail(f"the runner {pid} still runs {seconds} s later")
            time.sleep(0.02)
        return time.monotonic()

    def test_a_game_that_quits_ends_with_status_0_after_the_instance_is_destroyed(self) -> None:
        project = os.path.join(self.root, "projekt ünïcode")
        status, stderr = self.run_runner(["--libgodot", self.library, "--parent-pid", str(os.getpid()), "--", "--headless", "--path", project])
        self.assertEqual((status, stderr), (0, ""))
        self.assertEqual(self.events(), [
            "create", f"arg {self.runner}", "arg --headless", "arg --path", f"arg {project}", "start", "focus_in", "iteration", "destroy",
        ])

    def test_usage_errors_end_with_status_2_before_the_library_loads(self) -> None:
        library = ["--libgodot", self.library]
        cases = [[], library, [*library, "--frobnicate", "--"]] + [[*library, "--parent-pid", pid, "--"] for pid in ("abc", "0", "-1", "12x", "99999999999")]
        for arguments in cases:
            with self.subTest(arguments=arguments):
                status, stderr = self.run_runner(arguments)
                self.assertEqual(status, 2)
                self.assertIn("usage: godot_runner --libgodot <path>", stderr)
        self.assertEqual(self.events(), [])

    def test_library_instance_and_start_failures_end_with_statuses_3_4_and_5(self) -> None:
        self.assertEqual(self.run_runner(["--libgodot", os.path.join(self.root, "missing.so"), "--"])[0], 3)
        self.assertEqual(self.run_runner(["--libgodot", self.library, "--"], mode="fail-create")[0], 4)
        status, stderr = self.run_runner(["--libgodot", self.library, "--"], mode="fail-start")
        self.assertEqual(status, 5)
        self.assertIn("GodotInstance.start() failed", stderr)
        self.assertEqual(self.events()[-1], "destroy")

    def test_sigterm_stops_the_game_through_destroy(self) -> None:
        runner = self.start_runner(["--libgodot", self.library, "--parent-pid", str(os.getpid()), "--"], "run")
        self.wait_for_event("iteration")
        runner.send_signal(signal.SIGTERM)
        self.assertEqual(runner.wait(timeout=DEADLINE_SECONDS), 0)
        self.assertEqual(self.events()[-1], "destroy")

    def test_sigint_stops_the_game_after_the_library_replaced_its_handler(self) -> None:
        runner = self.start_runner(["--libgodot", self.library, "--"], "run", STUB_LIBGODOT_TAKE_SIGINT="1")
        self.wait_for_event("iteration")
        runner.send_signal(signal.SIGINT)
        self.assertEqual(runner.wait(timeout=DEADLINE_SECONDS), 0)
        self.assertEqual(self.events()[-1], "destroy")

    def test_a_parent_pid_that_names_another_running_process_ends_with_status_2(self) -> None:
        other = subprocess.Popen([sys.executable, "-I", "-c", "import time; time.sleep(60)"])
        self.addCleanup(other.wait)
        self.addCleanup(other.kill)
        status, stderr = self.run_runner(["--libgodot", self.library, "--parent-pid", str(other.pid), "--"])
        self.assertEqual(status, 2)
        self.assertIn(f"--parent-pid {other.pid} is not the parent of this process", stderr)
        self.assertEqual(self.events(), [])

    def test_a_parent_pid_that_names_no_running_process_ends_with_status_6(self) -> None:
        exited = subprocess.Popen([sys.executable, "-I", "-c", ""])
        exited.wait()
        status, stderr = self.run_runner(["--libgodot", self.library, "--parent-pid", str(exited.pid), "--"])
        self.assertEqual(status, 6)
        self.assertIn(f"process {exited.pid}", stderr)
        self.assertEqual(self.events(), [])

    def test_the_parent_exit_stops_a_running_game_through_destroy(self) -> None:
        runner, killed, errors = self.orphan("run")
        self.assertLess(self.wait_for_exit(runner, GRACE_SECONDS) - killed, GRACE_SECONDS)
        self.assertEqual(self.events()[-1], "destroy")
        self.assertRegex(read_text(errors), r"\Agodot_runner: process [0-9]+ exited; stopping the game\n\Z")

    def test_the_parent_exit_terminates_a_hung_game_after_the_grace_period(self) -> None:
        for mode in ("hang", "hang-start"):
            with self.subTest(mode=mode):
                runner, killed, errors = self.orphan(mode)
                elapsed = self.wait_for_exit(runner, GRACE_SECONDS + DEADLINE_SECONDS) - killed
                self.assertGreater(elapsed, GRACE_SECONDS - 0.5)
                self.assertNotIn("destroy", self.events())
                self.assertIn(f"godot_runner: the engine did not shut down within {GRACE_SECONDS} seconds; terminating the runner\n", read_text(errors))


if __name__ == "__main__":
    unittest.main()
