"""Every dependency the runtime stager needs must be pinned in the reviewed lock file.

`stage-real-runtime.py` refuses to build when a required root package is not installed, and the
documented environment installs exactly `python-requirements.lock.txt` (README: `pip install
--no-deps -r python-requirements.lock.txt`). PyYAML was listed as a root package but missing from
the lock - and `bridge/advisor_packages.py` really does `import yaml` - so a build that followed the
documentation aborted at its first step, and a runtime assembled that way could not import an
assistant package at all.
"""
from __future__ import annotations

import importlib.util
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def load(filename: str):
    spec = importlib.util.spec_from_file_location(
        Path(filename).stem.replace("-", "_"), Path(__file__).with_name(filename))
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


stage = load("stage-real-runtime.py")


class LockedRootPackagesTests(unittest.TestCase):
    def locked_versions(self) -> dict[str, str]:
        locked: dict[str, str] = {}
        for raw in (ROOT / "python-requirements.lock.txt").read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#"):
                continue
            name, separator, version = line.partition("==")
            self.assertTrue(separator and version, f"lock entry without an exact pin: {line}")
            canonical = name.lower().replace("_", "-")
            self.assertNotIn(canonical, locked, f"duplicate lock entry: {name}")
            locked[canonical] = version
        return locked

    def test_every_required_root_package_is_pinned_in_the_lock(self):
        locked = self.locked_versions()
        self.assertIn("pyyaml", locked)
        for package in stage.PYTHON_ROOT_PACKAGES:
            canonical = package.lower().replace("_", "-")
            if canonical in {name.lower().replace("_", "-") for name in stage.KNOWN_MISSING_OPTIONAL}:
                continue
            with self.subTest(package=package):
                self.assertIn(canonical, locked,
                              f"{package} is staged as a required root package but is not pinned "
                              f"in python-requirements.lock.txt")


if __name__ == "__main__":
    unittest.main()
