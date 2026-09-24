"""Start or reuse the local real-client bridge without touching legacy processes."""

import argparse
import ctypes
import hashlib
import http.client
import json
import os
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


VERSION = "real-ui-1"
DEFAULT_PORT = 8805
PROJECT_ROOT = Path(__file__).resolve().parent.parent
PORTABLE_PYTHON = PROJECT_ROOT / "runtime" / "python" / "python.exe"
PYTHON_EXE = Path(os.environ.get("WECHATVIBE_PYTHON") or
                  (PORTABLE_PYTHON if PORTABLE_PYTHON.is_file() else sys.executable))
START_TIMEOUT = 20.0


class LauncherError(Exception):
    pass


class FileTime(ctypes.Structure):
    _fields_ = [("low", ctypes.c_uint32), ("high", ctypes.c_uint32)]


@dataclass(frozen=True)
class Config:
    root: Path
    python_exe: Path
    port: int
    timeout: float = START_TIMEOUT

    @property
    def runtime_dir(self):
        return self.root / ".local" / "real-client-runtime"

    @property
    def no_auto_recovery_marker(self):
        return self.runtime_dir / "no-auto-recovery.json"

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"


def health(config):
    connection = http.client.HTTPConnection("127.0.0.1", config.port, timeout=3)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        body = response.read(65536)
        if response.status == 200:
            try:
                if json.loads(body).get("version") == VERSION:
                    return "ready"
            except (ValueError, AttributeError):
                pass
        return "wrong service (health response does not match real-ui-1)"
    except (OSError, http.client.HTTPException):
        return "unavailable"
    finally:
        connection.close()


def port_occupied(port):
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as connection:
        connection.settimeout(0.4)
        return connection.connect_ex(("127.0.0.1", port)) == 0


def clear_no_auto_recovery(config):
    """An explicit successful launch resets the current-account exit latch."""
    marker = config.no_auto_recovery_marker
    if marker.is_symlink() or (marker.exists() and not marker.is_file()):
        raise LauncherError(f"Unsafe recovery marker: {marker}")
    try:
        marker.unlink(missing_ok=True)
    except OSError as error:
        raise LauncherError(f"Could not reset recovery marker: {error}") from error


def process_identity(pid):
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenProcess.argtypes = [ctypes.c_uint32, ctypes.c_int, ctypes.c_uint32]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.GetExitCodeProcess.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    kernel32.GetProcessTimes.argtypes = [ctypes.c_void_p] + [ctypes.POINTER(FileTime)] * 4
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    handle = kernel32.OpenProcess(0x1000, False, pid)
    if not handle:
        denied = ctypes.get_last_error() == 5
        if denied:
            # Windows can retain an inaccessible process object after the PID has left
            # the process table. Such a stale runtime record must not prevent a restart.
            try:
                import psutil
                if pid not in psutil.pids():
                    return False, None
            except (ImportError, OSError):
                pass
        return denied, None
    try:
        exit_code = ctypes.c_uint32()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(exit_code)) or exit_code.value != 259:
            return False, None
        created, exited, kernel_time, user_time = (FileTime() for _ in range(4))
        if kernel32.GetProcessTimes(handle, ctypes.byref(created), ctypes.byref(exited), ctypes.byref(kernel_time), ctypes.byref(user_time)):
            return True, (created.high << 32) | created.low
        return True, None
    finally:
        kernel32.CloseHandle(handle)


def previous_live_bridge(config):
    if not config.runtime_dir.is_dir():
        return None
    for record_path in config.runtime_dir.glob("bridge-*.json"):
        try:
            record = json.loads(record_path.read_text(encoding="utf-8"))
            if record.get("port") != config.port:
                continue
            if not isinstance(record.get("log"), str):
                continue
            alive, created = process_identity(int(record["pid"]))
            if alive and (record.get("created_filetime") is None or created is None or created == record["created_filetime"]):
                return record
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            continue
    return None


@contextmanager
def launch_mutex(config):
    if os.name != "nt":
        raise LauncherError("This launcher requires Windows named mutexes")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_int, ctypes.c_wchar_p]
    kernel32.CreateMutexW.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
    kernel32.WaitForSingleObject.restype = ctypes.c_uint32
    kernel32.ReleaseMutex.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    identity = f"{config.root.resolve()}:{config.port}".casefold().encode("utf-8")
    name = "Local\\HaoGanDuRealClient-" + hashlib.sha256(identity).hexdigest()[:24]
    handle = kernel32.CreateMutexW(None, False, name)
    if not handle:
        raise LauncherError(f"Cannot create launch mutex: {ctypes.get_last_error()}")
    acquired = False
    try:
        result = kernel32.WaitForSingleObject(handle, 30000)
        acquired = result in (0, 0x80)
        if not acquired:
            raise LauncherError("Timed out waiting for another launcher; retry after it finishes")
        yield
    finally:
        if acquired:
            kernel32.ReleaseMutex(handle)
        kernel32.CloseHandle(handle)


def start_service(config, log_path):
    environment = os.environ.copy()
    environment["CHATUI_PORT"] = str(config.port)
    with log_path.open("ab", buffering=0) as log_file:
        return subprocess.Popen(
            [str(config.python_exe), str(config.root / "bridge" / "chat_server.py")],
            cwd=str(config.root), env=environment, stdin=subprocess.DEVNULL,
            stdout=log_file, stderr=subprocess.STDOUT,
            creationflags=subprocess.CREATE_NO_WINDOW | subprocess.CREATE_NEW_PROCESS_GROUP,
            close_fds=True,
        )


def ensure_service(config, starter=start_service, *, recovery=False):
    if recovery and config.no_auto_recovery_marker.exists():
        raise LauncherError("Automatic recovery is disabled after clearing the current account")
    with launch_mutex(config):
        if recovery and config.no_auto_recovery_marker.exists():
            raise LauncherError("Automatic recovery is disabled after clearing the current account")
        state = health(config)
        if state == "ready":
            if not recovery:
                clear_no_auto_recovery(config)
            return False, None
        if state != "unavailable" or port_occupied(config.port):
            raise LauncherError(f"Port {config.port} is occupied by another service ({state}); nothing was stopped")
        previous = previous_live_bridge(config)
        if previous:
            raise LauncherError(f"Earlier bridge PID {previous['pid']} is still running without health; no duplicate started; log: {previous['log']}")
        bridge = config.root / "bridge" / "chat_server.py"
        if not bridge.is_file():
            raise LauncherError(f"Bridge script not found: {bridge}")
        if not config.python_exe.is_file():
            raise LauncherError(f"Python interpreter not found: {config.python_exe}")
        config.runtime_dir.mkdir(parents=True, exist_ok=True)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        log_path = config.runtime_dir / f"bridge-{stamp}-{os.getpid()}.log"
        try:
            process = starter(config, log_path)
        except OSError as error:
            raise LauncherError(f"Could not launch bridge: {error}; log: {log_path}") from error
        _, created_filetime = process_identity(process.pid)
        metadata = {"pid": process.pid, "port": config.port, "log": str(log_path),
                    "started_at": stamp, "created_filetime": created_filetime}
        metadata_path = config.runtime_dir / f"bridge-{process.pid}.json"
        pending_path = config.runtime_dir / f".bridge-{process.pid}-{os.getpid()}.tmp"
        try:
            pending_path.write_text(json.dumps(metadata, ensure_ascii=False, indent=2), encoding="utf-8")
            os.replace(pending_path, metadata_path)
        except OSError as error:
            raise LauncherError(f"Bridge PID {process.pid} started but PID record failed: {error}; log: {log_path}") from error
        deadline = time.monotonic() + config.timeout
        while time.monotonic() < deadline:
            state = health(config)
            if state == "ready":
                if recovery and config.no_auto_recovery_marker.exists():
                    raise LauncherError("Automatic recovery is disabled after clearing the current account")
                if not recovery:
                    clear_no_auto_recovery(config)
                return True, log_path
            if state != "unavailable":
                raise LauncherError(f"Port {config.port} now has a different service ({state}); log: {log_path}")
            if process.poll() is not None:
                raise LauncherError(f"Bridge exited with code {process.returncode}; log: {log_path}")
            time.sleep(min(0.2, max(0, deadline - time.monotonic())))
        raise LauncherError(f"Bridge did not report {VERSION} within {config.timeout:g}s; log: {log_path}")


def open_client(url, root=PROJECT_ROOT):
    electron = root / "node_modules" / "electron" / "dist" / "electron.exe"
    script = root / "scripts" / "real-client-shell.cjs"
    if not electron.is_file() or not script.is_file():
        raise LauncherError("Dedicated Electron shell is unavailable; install project dependencies before opening the client")
    try:
        subprocess.Popen([str(electron), str(script), "--client-url", url], cwd=str(root), close_fds=True)
    except OSError as error:
        raise LauncherError(f"Could not open dedicated Electron shell: {error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Open the local real-data client")
    parser.add_argument("--no-open", action="store_true", help="start or reuse bridge without opening a GUI")
    parser.add_argument("--status", action="store_true", help="read-only health check")
    parser.add_argument("--recovery", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        port = int(os.environ.get("CHATUI_PORT", str(DEFAULT_PORT)))
        if not 1 <= port <= 65535:
            raise ValueError("out of range")
        config = Config(PROJECT_ROOT, PYTHON_EXE, port)
        if args.status:
            state = health(config)
            print(f"{config.url}: {state}")
            return 0 if state == "ready" else 1
        created, log_path = ensure_service(config, recovery=args.recovery)
        print(f"{'Started' if created else 'Reusing'} {VERSION} at {config.url}")
        if log_path:
            print(f"Bridge log: {log_path}")
        if not args.no_open:
            open_client(config.url, config.root)
        return 0
    except (ValueError, LauncherError, OSError) as error:
        print(f"Real client launch failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
