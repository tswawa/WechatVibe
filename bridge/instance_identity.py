"""Stable local bridge identity for one resolved client installation."""

import hashlib
from pathlib import Path


def instance_id(root):
    # Resolve links and ignore case so every entry point names the same Windows root.
    canonical = str(Path(root).resolve()).casefold().encode("utf-8")
    return hashlib.sha256(canonical).hexdigest()


def default_port(root):
    # A collision is possible in this finite range; the launcher checks identity
    # before reuse and refuses to attach to any different occupant.
    return 20000 + int(instance_id(root)[:8], 16) % 40000
