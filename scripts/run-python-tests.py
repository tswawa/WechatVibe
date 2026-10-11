"""Run the Python test files.

Serial by default, because several of these tests are timing sensitive: running four at
once stretched `bridge/test_real_backend.py` from 165s to 472s and made three
`bridge/test_api_insights.py` cases fail on timeouts. `--jobs` stays available for a quick
look on an idle machine, but the supported way to iterate quickly is `--only` / `--skip-slow`,
which skip the two end-to-end files that own ~80% of the wall clock.

    scripts/run-python-tests.py                    # everything, serial (default)
    scripts/run-python-tests.py --skip-slow        # everything except the two slow files
    scripts/run-python-tests.py --only pool        # just the files matching "pool"
    scripts/run-python-tests.py --jobs 4            # opt-in; can fail on a busy machine
    scripts/run-python-tests.py --list             # show what would run and how long it took
"""
from __future__ import annotations

import argparse
import os
import subprocess
import sys
import time
from pathlib import Path


from project_python import ROOT, select_python

#: Group order is kept stable so the log reads the same way as it always has.
GROUPS = (("bridge", "test_*.py"), ("scripts", "test-*.py"), ("native-reader", "test_*.py"))

#: Files that dominate the wall clock; `--skip-slow` leaves them out for quick loops.
SLOW_FILES = ("bridge/test_real_backend.py", "scripts/test-start-real-client.py")


def use_project_python() -> int | None:
    python = select_python()
    if Path(sys.executable).resolve() == python.resolve():
        return None
    return subprocess.run([str(python), str(Path(__file__).resolve()), *sys.argv[1:]],
                          cwd=ROOT).returncode


def collect_files(only, skip_slow):
    files = []
    for directory, pattern in GROUPS:
        found = sorted((ROOT / directory).glob(pattern))
        if not found:
            raise RuntimeError(f"No tests found in {ROOT / directory}")
        for path in found:
            relative = path.relative_to(ROOT).as_posix()
            if only and only not in relative:
                continue
            if skip_slow and relative in SLOW_FILES:
                continue
            files.append(path)
    if not files:
        raise RuntimeError("No test files matched the selection")
    return files


def run_file(path):
    started = time.monotonic()
    completed = subprocess.run([sys.executable, str(path)], cwd=path.parent,
                               capture_output=True, text=True, encoding="utf-8",
                               errors="replace")
    return path, completed.returncode, (completed.stdout or "") + (completed.stderr or ""), \
        time.monotonic() - started


def run_serial(files) -> float:
    started = time.monotonic()
    for path in files:
        print(f"===== {path.relative_to(ROOT)} =====", flush=True)
        if subprocess.run([sys.executable, str(path)], cwd=path.parent).returncode != 0:
            raise SystemExit(1)
    return time.monotonic() - started


def run_parallel(files, jobs) -> float:
    from concurrent.futures import ThreadPoolExecutor
    started = time.monotonic()
    failed = []
    with ThreadPoolExecutor(max_workers=min(jobs, len(files))) as pool:
        for path, code, output, seconds in pool.map(run_file, files):
            print(f"===== {path.relative_to(ROOT)} ({seconds:.1f}s) =====", flush=True)
            if code != 0:
                failed.append(path.relative_to(ROOT).as_posix())
                print(output, flush=True)
    if failed:
        raise SystemExit("Failed: " + ", ".join(failed))
    return time.monotonic() - started


def parse_args():
    parser = argparse.ArgumentParser(description="Run the Python test files.")
    parser.add_argument("--jobs", type=int, default=1,
                        help="files to run at a time; the suite is timing sensitive, so "
                             "only raise this on an otherwise idle machine")
    parser.add_argument("--only", help="substring filter on the repo-relative test path")
    parser.add_argument("--skip-slow", action="store_true",
                        help="skip the two slowest end-to-end files")
    parser.add_argument("--list", action="store_true", help="list the selected files and exit")
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    project_result = use_project_python()
    if project_result is not None:
        return project_result
    files = collect_files(args.only, args.skip_slow)
    if args.list:
        for path in files:
            print(path.relative_to(ROOT).as_posix())
        print(f"{len(files)} files", flush=True)
        return 0
    if args.jobs > 1:
        elapsed = run_parallel(files, args.jobs)
    else:
        elapsed = run_serial(files)
    print(f"----- {len(files)} files in {elapsed:.1f}s -----", flush=True)
    print("ALL_PYTHON_TESTS_PASSED", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())