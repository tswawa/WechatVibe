"""Start or reuse the local real-client bridge without touching legacy processes."""

import argparse
import ctypes
import hashlib
import http.client
import json
import os
import re
import secrets
import shutil
import socket
import subprocess
import sys
import time
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path


VERSION = "real-ui-1"
PROJECT_ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(PROJECT_ROOT / "bridge"))
from instance_identity import default_port, instance_id

PORTABLE_PYTHON = PROJECT_ROOT / "runtime" / "python" / "python.exe"


def selected_python_exe(value=None):
    """Resolve a PATH command before comparing it with a running Python image."""
    value = value if value is not None else os.environ.get("WECHATVIBE_PYTHON")
    if not value:
        return PORTABLE_PYTHON if PORTABLE_PYTHON.is_file() else Path(sys.executable)
    candidate = Path(value)
    if candidate.name == value:
        resolved = shutil.which(value)
        if resolved:
            return Path(resolved).resolve()
    return candidate


PYTHON_EXE = selected_python_exe()
START_TIMEOUT = 20.0
STOP_TIMEOUT = 30.0
STOP_CLEANUP_TIMEOUT = 8.0
CONTROL_TOKEN_ENV = "WECHATVIBE_CONTROL_TOKEN"
CONTROL_TOKEN_HEADER = "X-WechatVibe-Control-Token"


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

    @property
    def instance_id(self):
        return instance_id(self.root)


def health(config):
    expected_app_version = None
    package_file = config.root / "package.json"
    if package_file.is_file():
        try:
            expected_app_version = json.loads(package_file.read_text(encoding="utf-8")).get("version")
        except (OSError, ValueError, AttributeError):
            return "wrong service (installation version metadata invalid)"
    connection = http.client.HTTPConnection("127.0.0.1", config.port, timeout=3)
    try:
        connection.request("GET", "/api/health")
        response = connection.getresponse()
        body = response.read(65536)
        if response.status == 200:
            try:
                payload = json.loads(body)
                if (payload.get("version") == VERSION and
                        payload.get("instanceId") == config.instance_id and
                        (expected_app_version is None or
                         payload.get("appVersion") == expected_app_version)):
                    return "ready"
            except (ValueError, AttributeError):
                pass
        return "wrong service (health version or installation identity differs)"
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


def checked_runtime_dir(config):
    """Reject records reached through a redirected install-local runtime path."""
    root = config.root.resolve()
    for directory in (config.root / ".local", config.runtime_dir):
        if directory.exists() and directory.lstat().st_file_attributes & 0x400:
            raise LauncherError(f"Unsafe runtime directory: {directory}")
    if not config.runtime_dir.resolve().is_relative_to(root):
        raise LauncherError("Runtime directory leaves this installation")
    return config.runtime_dir


def protect_record(path):
    """Set an explicit current-user DACL before writing the control token."""
    system32 = Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32"
    flags = getattr(subprocess, "CREATE_NO_WINDOW", 0)
    try:
        user = subprocess.run([str(system32 / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
                              capture_output=True, check=True, creationflags=flags)
        match = re.search(rb"S-1-\d+(?:-\d+)+", user.stdout)
        if match is None:
            raise LauncherError("Cannot identify current Windows user for bridge record")
        result = subprocess.run([str(system32 / "icacls.exe"), str(path), "/inheritance:r",
                                 "/grant:r", "*" + match.group().decode("ascii") + ":F"],
                                capture_output=True, creationflags=flags)
        if result.returncode != 0:
            raise LauncherError("Cannot protect bridge control record with a user ACL")
    except OSError as error:
        raise LauncherError(f"Cannot protect bridge control record: {error}") from error
    except subprocess.CalledProcessError as error:
        raise LauncherError("Cannot identify current Windows user for bridge record") from error


def write_control_record(config, process, log_path, stamp, control_token):
    alive, created_filetime = process_identity(process.pid)
    if not alive or type(created_filetime) is not int:
        raise LauncherError("Bridge process creation time is unavailable; cannot record ownership")
    metadata = {"pid": process.pid, "port": config.port, "instance_id": config.instance_id,
                "log": str(log_path), "started_at": stamp,
                "created_filetime": created_filetime, "control_token": control_token}
    metadata_path = config.runtime_dir / f"bridge-{process.pid}.json"
    pending_path = config.runtime_dir / f".bridge-{process.pid}-{os.getpid()}.tmp"
    if metadata_path.is_symlink() or (metadata_path.exists() and
                                     metadata_path.lstat().st_file_attributes & 0x400):
        raise LauncherError(f"Unsafe bridge record: {metadata_path}")
    try:
        with pending_path.open("x", encoding="utf-8") as pending:
            protect_record(pending_path)
            pending.write(json.dumps(metadata, ensure_ascii=False, indent=2))
            pending.flush()
            os.fsync(pending.fileno())
        os.replace(pending_path, metadata_path)
    except OSError as error:
        raise LauncherError(f"Bridge PID {process.pid} started but PID record failed: {error}; log: {log_path}") from error
    finally:
        pending_path.unlink(missing_ok=True)


def stop_new_child_after_record_failure(process):
    """Use only this Popen handle; an unrecorded bridge must not outlive launch."""
    try:
        if process.poll() is None:
            process.terminate()
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.kill()
            process.wait(timeout=5)
    except (OSError, subprocess.TimeoutExpired) as error:
        raise LauncherError(f"Could not confirm newly launched bridge PID {process.pid} exited: {error}") from error


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


def start_service(config, log_path, control_token):
    environment = os.environ.copy()
    environment["CHATUI_PORT"] = str(config.port)
    environment[CONTROL_TOKEN_ENV] = control_token
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
        checked_runtime_dir(config).mkdir(parents=True, exist_ok=True)
        checked_runtime_dir(config)
        stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ")
        log_path = config.runtime_dir / f"bridge-{stamp}-{os.getpid()}.log"
        control_token = secrets.token_hex(32)
        try:
            process = starter(config, log_path, control_token)
        except OSError as error:
            raise LauncherError(f"Could not launch bridge: {error}; log: {log_path}") from error
        try:
            write_control_record(config, process, log_path, stamp, control_token)
        except Exception as error:
            try:
                stop_new_child_after_record_failure(process)
            except LauncherError as cleanup_error:
                raise LauncherError(f"Bridge record failed ({error}); {cleanup_error}") from error
            raise
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


def owned_bridge_records(config):
    runtime_dir = checked_runtime_dir(config)
    if not runtime_dir.is_dir():
        return []
    records = []
    for path in runtime_dir.glob("bridge-*.json"):
        try:
            if path.lstat().st_file_attributes & 0x400 or path.stat().st_size > 16384:
                raise LauncherError(f"Unsafe bridge record: {path}")
            record = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(record, dict) or record.get("port") != config.port:
                continue
            pid = record.get("pid")
            if type(pid) is not int or pid <= 0 or path.name != f"bridge-{pid}.json":
                raise LauncherError(f"Invalid bridge record: {path}")
            alive, created = process_identity(pid)
            if not alive:
                continue
            if type(created) is not int or type(record.get("created_filetime")) is not int:
                raise LauncherError(f"Cannot verify bridge PID {pid} creation time")
            if created != record["created_filetime"]:
                continue  # A stale record must never grant access to a reused PID.
            if record.get("instance_id") != config.instance_id:
                raise LauncherError(f"Live bridge PID {pid} has another installation identity")
            token = record.get("control_token")
            if not isinstance(token, str) or re.fullmatch(r"[0-9a-f]{64}", token) is None:
                raise LauncherError(f"Live bridge PID {pid} has no valid control token")
            records.append((path, record))
        except (OSError, ValueError, UnicodeError) as error:
            raise LauncherError(f"Cannot inspect bridge record {path}: {error}") from error
    return records


def verify_owned_process(config, record):
    """Read only image and argv; never inspect another process's open files."""
    try:
        import psutil
    except ImportError as error:
        raise LauncherError(f"Cannot verify bridge process ownership: {error}") from error
    try:
        process = psutil.Process(record["pid"])
        image = Path(process.exe()).resolve(strict=True)
        command = process.cmdline()
        expected_image = config.python_exe.resolve(strict=True)
        expected_script = (config.root / "bridge" / "chat_server.py").resolve(strict=True)
        portable = (config.root / "runtime" / "python" / "python.exe")
        if portable.is_file() and expected_image != portable.resolve(strict=True):
            raise LauncherError("Bridge interpreter differs from this installed runtime")
        if (str(image).casefold() != str(expected_image).casefold() or len(command) != 2 or
                str(Path(command[1]).resolve(strict=True)).casefold() != str(expected_script).casefold()):
            raise LauncherError("Bridge image or script command line differs from this installation")
        alive, created = process_identity(record["pid"])
        if not alive or created != record["created_filetime"]:
            raise LauncherError("Bridge process changed during ownership check")
        return process
    except (OSError, ValueError, psutil.Error) as error:
        raise LauncherError(f"Cannot verify bridge process ownership: {error}") from error


def request_owned_shutdown(config, token):
    connection = http.client.HTTPConnection("127.0.0.1", config.port, timeout=3)
    try:
        connection.request("POST", "/api/control/shutdown", body=b"",
                           headers={CONTROL_TOKEN_HEADER: token})
        response = connection.getresponse()
        body = response.read(4096)
        if response.status != 202 or json.loads(body).get("stopping") is not True:
            raise LauncherError(f"Bridge rejected controlled shutdown (HTTP {response.status})")
    except (OSError, http.client.HTTPException, ValueError, AttributeError) as error:
        raise LauncherError(f"Controlled bridge shutdown failed: {error}") from error
    finally:
        connection.close()


def bridge_exited(record):
    alive, created = process_identity(record["pid"])
    return not alive or (created is not None and created != record["created_filetime"])


def wait_for_bridge_exit(record, deadline):
    while time.monotonic() < deadline:
        if bridge_exited(record):
            return True
        time.sleep(min(0.2, max(0, deadline - time.monotonic())))
    return bridge_exited(record)


def owned_model_children(config, bridge_process):
    """Recognize only this verified bridge's direct analysis workers."""
    import psutil
    expected_script = (config.root / "bridge" / "analysis_server.ts").resolve()
    children = []
    try:
        for child in bridge_process.children():
            try:
                command = child.cmdline()
                image = Path(child.exe()).resolve(strict=True)
                if (image.name.casefold() == "node.exe" and len(command) >= 4 and
                        command[1:3] == ["--import", "tsx"] and
                        Path(command[3]).resolve() == expected_script):
                    children.append(child)
            except psutil.NoSuchProcess:
                continue
    except (OSError, ValueError, psutil.Error) as error:
        raise LauncherError(f"Cannot inspect owned analysis workers: {error}") from error
    return children


def finish_owned_shutdown(config, record, children, timeout=STOP_CLEANUP_TIMEOUT):
    """Bound cleanup to the exact bridge and model children verified above."""
    import psutil
    deadline = time.monotonic() + timeout
    exited = bridge_exited(record)
    if exited and not children:
        return
    if not exited:
        try:
            process = verify_owned_process(config, record)
        except LauncherError:
            if not bridge_exited(record):
                raise
        else:
            known = {child.pid: child for child in children}
            known.update({child.pid: child for child in owned_model_children(config, process)})
            children = list(known.values())
    for child in children:
        try:
            child.terminate()
        except psutil.NoSuchProcess:
            pass
        except psutil.Error as error:
            raise LauncherError(f"Could not stop owned analysis worker: {error}") from error
    _, alive_children = psutil.wait_procs(children, timeout=min(2, max(0, deadline - time.monotonic())))
    for child in alive_children:
        try:
            child.kill()
        except psutil.NoSuchProcess:
            pass
        except psutil.Error as error:
            raise LauncherError(f"Could not stop owned analysis worker: {error}") from error
    _, alive_children = psutil.wait_procs(alive_children, timeout=min(2, max(0, deadline - time.monotonic())))
    if alive_children:
        raise LauncherError("Owned analysis worker did not exit")
    if wait_for_bridge_exit(record, min(deadline, time.monotonic() + 2)):
        return
    try:
        process = verify_owned_process(config, record)
    except LauncherError:
        if bridge_exited(record):
            return
        raise
    try:
        process.terminate()
    except psutil.NoSuchProcess:
        pass
    except psutil.Error as error:
        raise LauncherError(f"Could not stop owned bridge: {error}") from error
    if not wait_for_bridge_exit(record, deadline):
        raise LauncherError(f"Owned bridge PID {record['pid']} did not exit after bounded cleanup")


def stop_owned_bridge(config, timeout=STOP_TIMEOUT):
    with launch_mutex(config):
        state = health(config)
        if state not in ("ready", "unavailable"):
            raise LauncherError(f"Port {config.port} has a wrong service ({state}); nothing was stopped")
        records = owned_bridge_records(config)
        if state == "unavailable" and not records:
            if port_occupied(config.port):
                raise LauncherError("Port is occupied without matching health; nothing was stopped")
            return {"stopped": False, "alreadyStopped": True}
        if len(records) != 1:
            raise LauncherError(f"Expected one owned bridge record; found {len(records)}; nothing was stopped")
        _, record = records[0]
        try:
            process = verify_owned_process(config, record)
        except LauncherError:
            if bridge_exited(record):
                return {"stopped": True, "pid": record["pid"]}
            raise
        children = owned_model_children(config, process)
        if state == "ready":
            current = health(config)
            if current == "ready":
                request_owned_shutdown(config, record["control_token"])
            elif current != "unavailable":
                raise LauncherError("Bridge health changed to another service; nothing was stopped")
        if wait_for_bridge_exit(record, time.monotonic() + timeout):
            finish_owned_shutdown(config, record, children)
            return {"stopped": True, "pid": record["pid"]}
        finish_owned_shutdown(config, record, children)
        return {"stopped": True, "pid": record["pid"], "forced": True}


def open_client(url, root=PROJECT_ROOT):
    electron = root / "node_modules" / "electron" / "dist" / "electron.exe"
    script = root / "scripts" / "real-client-shell.cjs"
    if not electron.is_file() or not script.is_file():
        raise LauncherError("Dedicated Electron shell is unavailable; install project dependencies before opening the client")
    try:
        environment = {**os.environ, "WECHATVIBE_INSTANCE_ID": instance_id(root)}
        subprocess.Popen([str(electron), str(script), "--client-url", url],
                         cwd=str(root), env=environment, close_fds=True)
    except OSError as error:
        raise LauncherError(f"Could not open dedicated Electron shell: {error}") from error


def main(argv=None):
    parser = argparse.ArgumentParser(description="Open the local real-data client")
    parser.add_argument("--no-open", action="store_true", help="start or reuse bridge without opening a GUI")
    parser.add_argument("--status", action="store_true", help="read-only health check")
    parser.add_argument("--stop-owned-bridge", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--json", action="store_true", help=argparse.SUPPRESS)
    parser.add_argument("--recovery", action="store_true", help=argparse.SUPPRESS)
    args = parser.parse_args(argv)
    try:
        port = int(os.environ.get("CHATUI_PORT", str(default_port(PROJECT_ROOT))))
        if not 1 <= port <= 65535:
            raise ValueError("out of range")
        config = Config(PROJECT_ROOT, PYTHON_EXE, port)
        if args.stop_owned_bridge:
            result = stop_owned_bridge(config)
            if args.json:
                print(json.dumps(result))
            else:
                print("Stopped owned bridge" if result["stopped"] else "Owned bridge already stopped")
            return 0
        if args.status:
            state = health(config)
            if args.json:
                print(json.dumps({"version": VERSION, "url": config.url,
                                  "instanceId": config.instance_id, "state": state}))
            else:
                print(f"{config.url}: {state}")
            return 0 if state == "ready" else 1
        created, log_path = ensure_service(config, recovery=args.recovery)
        if args.json:
            print(json.dumps({"version": VERSION, "url": config.url,
                              "instanceId": config.instance_id, "created": created}))
        else:
            print(f"{'Started' if created else 'Reusing'} {VERSION} at {config.url}")
            if log_path:
                print(f"Bridge log: {log_path}")
        if not args.no_open:
            open_client(config.url, config.root)
        return 0
    except (ValueError, LauncherError, OSError) as error:
        if args.stop_owned_bridge and args.json:
            print(json.dumps({"stopped": False, "error": str(error)}))
        print(f"Real client launch failed: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
