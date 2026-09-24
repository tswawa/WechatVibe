"""Synthetic launcher checks; never starts the project bridge or a browser."""

import importlib.util
import io
import json
import socket
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stderr
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("start-real-client.py")
spec = importlib.util.spec_from_file_location("real_client_launcher", SCRIPT)
launcher = importlib.util.module_from_spec(spec)
sys.modules[spec.name] = launcher
spec.loader.exec_module(launcher)


class HealthHandler(BaseHTTPRequestHandler):
    version = "real-ui-1"

    def do_GET(self):
        body = json.dumps({"version": self.version}).encode()
        self.send_response(200)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *args):
        pass


class FakeProcess:
    pid = 47231
    returncode = None

    def poll(self):
        return None


def unused_port():
    with socket.socket() as connection:
        connection.bind(("127.0.0.1", 0))
        return connection.getsockname()[1]


class LauncherTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix="client fixture ")
        self.addCleanup(self.temporary.cleanup)
        self.root = Path(self.temporary.name) / "中文 空格"
        (self.root / "bridge").mkdir(parents=True)
        (self.root / "bridge" / "chat_server.py").write_text("fixture only", encoding="utf-8")
        self.config = launcher.Config(self.root, Path(sys.executable), unused_port(), 0.35)

    def server(self, version):
        handler = type("FixtureHandler", (HealthHandler,), {"version": version})
        server = ThreadingHTTPServer(("127.0.0.1", self.config.port), handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        self.addCleanup(thread.join)
        self.addCleanup(server.server_close)
        self.addCleanup(server.shutdown)
        return server

    def test_reuses_matching_version_without_creating_runtime_files(self):
        self.server("real-ui-1")
        self.assertEqual(launcher.ensure_service(self.config, starter=lambda *_: self.fail("started")), (False, None))
        self.assertFalse(self.config.runtime_dir.exists())

    def test_rejects_wrong_version_and_non_http_occupant(self):
        self.server("old-version")
        with self.assertRaisesRegex(launcher.LauncherError, "occupied"):
            launcher.ensure_service(self.config, starter=lambda *_: self.fail("started"))
        self.assertFalse(self.config.runtime_dir.exists())

    def test_rejects_tcp_listener_without_health(self):
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", self.config.port))
            listener.listen()
            with self.assertRaisesRegex(launcher.LauncherError, "occupied"):
                launcher.ensure_service(self.config, starter=lambda *_: self.fail("started"))

    def test_concurrent_launch_creates_once_and_records_unicode_path(self):
        calls = []
        outcomes = []
        errors = []
        barrier = threading.Barrier(2)
        server = None

        def starter(config, log_path):
            nonlocal server
            calls.append(log_path)
            log_path.write_text("synthetic bridge", encoding="utf-8")
            time.sleep(0.12)
            server = self.server("real-ui-1")
            return FakeProcess()

        def run():
            try:
                barrier.wait()
                outcomes.append(launcher.ensure_service(self.config, starter=starter))
            except Exception as error:
                errors.append(error)

        threads = [threading.Thread(target=run) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=5)
        self.assertTrue(all(not thread.is_alive() for thread in threads))
        self.assertEqual(errors, [])
        self.assertEqual(len(calls), 1)
        self.assertEqual(sorted(created for created, _ in outcomes), [False, True])
        self.assertIsNotNone(server)
        metadata = json.loads((self.config.runtime_dir / "bridge-47231.json").read_text(encoding="utf-8"))
        self.assertEqual(metadata["pid"], 47231)
        self.assertIn("中文 空格", metadata["log"])

    def test_timeout_reports_log_without_claiming_success(self):
        with self.assertRaisesRegex(launcher.LauncherError, "did not report.*log:"):
            launcher.ensure_service(self.config, starter=lambda *_: FakeProcess())
        self.assertTrue((self.config.runtime_dir / "bridge-47231.json").is_file())

    def test_early_exit_reports_log(self):
        class ExitedProcess(FakeProcess):
            returncode = 19

            def poll(self):
                return self.returncode

        with self.assertRaisesRegex(launcher.LauncherError, "exited with code 19; log:"):
            launcher.ensure_service(self.config, starter=lambda *_: ExitedProcess())

    def test_retry_after_timeout_does_not_spawn_second_live_bridge(self):
        calls = []

        def starter(*_):
            calls.append(True)
            return FakeProcess()

        with patch.object(launcher, "process_identity", return_value=(True, 42)):
            with self.assertRaisesRegex(launcher.LauncherError, "did not report"):
                launcher.ensure_service(self.config, starter=starter)
            with self.assertRaisesRegex(launcher.LauncherError, "no duplicate started; log:"):
                launcher.ensure_service(self.config, starter=starter)
        self.assertEqual(len(calls), 1)

    def test_mutex_is_shared_with_another_process(self):
        marker = self.root / "child acquired.txt"
        child_code = (
            "import importlib.util, pathlib, sys; "
            "spec=importlib.util.spec_from_file_location('launcher_child', sys.argv[1]); "
            "module=importlib.util.module_from_spec(spec); sys.modules[spec.name]=module; "
            "spec.loader.exec_module(module); "
            "config=module.Config(pathlib.Path(sys.argv[2]), pathlib.Path(sys.executable), int(sys.argv[3])); "
            "lock=module.launch_mutex(config); lock.__enter__(); "
            "pathlib.Path(sys.argv[4]).write_text('acquired'); lock.__exit__(None,None,None)"
        )
        with launcher.launch_mutex(self.config):
            child = subprocess.Popen(
                [sys.executable, "-B", "-c", child_code, str(SCRIPT), str(self.root),
                 str(self.config.port), str(marker)], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
            )
            time.sleep(0.35)
            self.assertIsNone(child.poll())
            self.assertFalse(marker.exists())
        output, errors = child.communicate(timeout=5)
        self.assertEqual(child.returncode, 0, (output, errors))
        self.assertEqual(marker.read_text(), "acquired")

    def test_dedicated_shell_required_without_browser_fallback(self):
        with patch.object(launcher.subprocess, "Popen") as process:
            with self.assertRaisesRegex(launcher.LauncherError, "Electron shell is unavailable"):
                launcher.open_client(self.config.url, self.root)
            process.assert_not_called()
        electron = self.root / "node_modules" / "electron" / "dist" / "electron.exe"
        electron.parent.mkdir(parents=True)
        electron.write_bytes(b"synthetic")
        shell = self.root / "scripts" / "real-client-shell.cjs"
        shell.parent.mkdir(parents=True)
        shell.write_text("synthetic", encoding="utf-8")
        with patch.object(launcher.subprocess, "Popen") as process:
            launcher.open_client(self.config.url, self.root)
            process.assert_called_once_with(
                [str(electron), str(shell), "--client-url", self.config.url],
                cwd=str(self.root), close_fds=True,
            )
        with patch.object(launcher.subprocess, "Popen", side_effect=OSError("synthetic failure")):
            with self.assertRaisesRegex(launcher.LauncherError, "Could not open dedicated Electron shell"):
                launcher.open_client(self.config.url, self.root)

    def test_status_is_read_only_and_no_open_skips_browser(self):
        self.server("real-ui-1")
        with patch.object(launcher, "PROJECT_ROOT", self.root), patch.dict("os.environ", {"CHATUI_PORT": str(self.config.port)}), patch.object(launcher, "open_client", side_effect=AssertionError("GUI opened")):
            self.assertEqual(launcher.main(["--status"]), 0)
            self.assertEqual(launcher.main(["--no-open"]), 0)
        self.assertFalse(self.config.runtime_dir.exists())

    def test_current_clear_marker_blocks_recovery_until_explicit_launch(self):
        marker = self.config.no_auto_recovery_marker
        marker.parent.mkdir(parents=True)
        marker.write_text('{"reason":"account-cleared"}', encoding='utf-8')
        with patch.object(launcher, 'health', side_effect=AssertionError('health probed')):
            with self.assertRaisesRegex(launcher.LauncherError, 'Automatic recovery is disabled'):
                launcher.ensure_service(self.config, starter=lambda *_: self.fail('started'), recovery=True)
        self.assertTrue(marker.exists())
        self.server('real-ui-1')
        self.assertEqual(launcher.ensure_service(self.config, starter=lambda *_: self.fail('started')),
                         (False, None))
        self.assertFalse(marker.exists())
        self.assertEqual(launcher.ensure_service(self.config, starter=lambda *_: self.fail('started'),
                                                 recovery=True), (False, None))

    def test_failed_explicit_launch_preserves_no_recovery_marker(self):
        marker = self.config.no_auto_recovery_marker
        marker.parent.mkdir(parents=True)
        marker.write_text('{"reason":"account-cleared"}', encoding='utf-8')
        self.server('wrong-version')
        with self.assertRaisesRegex(launcher.LauncherError, 'occupied'):
            launcher.ensure_service(self.config, starter=lambda *_: self.fail('started'))
        self.assertTrue(marker.exists())

    def test_recovery_command_does_not_open_or_start_when_marker_exists(self):
        marker = self.config.no_auto_recovery_marker
        marker.parent.mkdir(parents=True)
        marker.write_text('{"reason":"account-cleared"}', encoding='utf-8')
        with patch.object(launcher, 'PROJECT_ROOT', self.root), patch.object(launcher, 'PYTHON_EXE', Path(sys.executable)), \
             patch.dict('os.environ', {'CHATUI_PORT': str(self.config.port)}), \
             patch.object(launcher, 'open_client', side_effect=AssertionError('GUI opened')):
            with redirect_stderr(io.StringIO()) as errors:
                self.assertEqual(launcher.main(['--no-open', '--recovery']), 1)
        self.assertIn('Automatic recovery is disabled', errors.getvalue())
        self.assertTrue(marker.exists())


if __name__ == "__main__":
    unittest.main()
