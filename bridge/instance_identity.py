"""Stable local bridge identity for one resolved client installation.

A profile names a second, independent instance of the same installation: it moves the port,
the runtime directory, the mutex and the Electron user-data directory, so one checkout can
serve two WeChat accounts at once. `None` is the default instance and must keep producing
byte-identical identities and paths, so an installation that never sets a profile behaves
exactly as it did before.

Storage is deliberately NOT per profile: the decrypted snapshot a reader writes lives in one
machine-wide directory per account no matter which instance opens it, so splitting the
registry per profile would leave every entry naming a workdir that does not match. Two
instances are kept off each other's account instead - see
`account_pin_source.conflicting_instance`.
"""

import hashlib
import os
import re
from pathlib import Path


PROFILE_ENV = "WECHATVIBE_PROFILE"
# The profile reaches a directory name and a mutex name, so keep it to a safe alphabet.
PROFILE_PATTERN = re.compile(r"[A-Za-z0-9_-]{1,32}")


def profile_name(value=None):
    """Validate an instance profile. None and "" both mean the default instance."""
    if value is None:
        value = os.environ.get(PROFILE_ENV)
    if value is None or value == "":
        return None
    if not isinstance(value, str) or PROFILE_PATTERN.fullmatch(value) is None:
        raise ValueError("invalid instance profile")
    return value


def instance_id(root, profile=None):
    # Resolve links and ignore case so every entry point names the same Windows root.
    canonical = str(Path(root).resolve()).casefold()
    if profile:
        canonical += "|" + profile
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()


def default_port(root, profile=None):
    # A collision is possible in this finite range; the launcher checks identity
    # before reuse and refuses to attach to any different occupant.
    return 20000 + int(instance_id(root, profile)[:8], 16) % 40000


def runtime_dir(root, profile=None):
    """Per-instance runtime state: ports, bridge records, pins, logs."""
    base = Path(root) / ".local" / "real-client-runtime"
    return base if profile is None else base / profile


def shell_data_dir(root, profile=None):
    """Per-instance Electron user-data directory (and its single-instance lock)."""
    base = Path(root) / ".local" / "real-client-shell"
    return base if profile is None else base / profile
