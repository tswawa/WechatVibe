"""Column-level encryption for the analysis payloads that hold chat text.

The analysis store keeps labels, scores and cursors in the clear so SQL can still sort and
page over them, but a few payload columns hold raw conversation text: the rolling context
windows (`progress_v1.context_json`, `batch_progress_v1.context_json`) and the evidence
quotes in `api_portrait_v1` and `api_guidance_v1`. Those are the columns encrypted here.

Design notes
------------
* **Column level, not file level.** SQLCipher would need a new native dependency and would
  break the portable build. Encrypting the payload columns leaves every index, `ORDER BY`,
  `rowid` cursor and `source_id LIKE` prefix scan working, because none of them read these
  columns.
* **AES-256-GCM.** The envelope is authenticated, so a truncated or edited payload is
  rejected instead of silently returning garbage.
* **The key is protected by DPAPI**, the mechanism `model_source.py` already uses for API
  keys. It is machine- and user-bound: a database copied to another Windows account or
  machine cannot be decrypted, and the store treats that as "no results yet" rather than a
  hard failure. The tradeoff is deliberate -- it protects the file at rest without adding a
  passphrase prompt to every launch.
* **Legacy rows stay readable.** A stored value without the `wv1:` envelope is plaintext
  written by an older build and is returned as-is; the next write re-encrypts it. Migration
  is therefore lazy and needs no schema version.
"""
from __future__ import annotations

import base64
import binascii
import json
import os
import threading
from pathlib import Path

from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM

# JSON payloads start with "{" or "[", so this prefix cannot collide with a legacy value.
ENVELOPE = "wv1:"
KEY_BYTES = 32
NONCE_BYTES = 12
KEY_FILENAME = "analysis-key.bin"


class PayloadUnreadable(RuntimeError):
    """A stored payload cannot be decrypted with the current key."""


def _dpapi_protect(value: bytes) -> bytes:
    import win32crypt

    return win32crypt.CryptProtectData(value, "WechatVibe analysis key", None, None, None, 0x1)


def _dpapi_unprotect(value: bytes) -> bytes:
    import win32crypt

    try:
        return win32crypt.CryptUnprotectData(value, None, None, None, 0x1)[1]
    except Exception as exc:
        # DPAPI rejects a blob that was tampered with, truncated, or produced by another
        # Windows account. Report it as an unreadable payload instead of leaking pywintypes.
        raise PayloadUnreadable("analysis key cannot be unprotected on this account") from exc


class PayloadCipher:
    """Encrypts and decrypts one payload column with a DPAPI-protected key.

    `protect`/`unprotect` are injectable for the same reason `ModelSourceStore` allows it:
    a test must not depend on the machine's DPAPI key.
    """

    def __init__(self, key_path=None, *, protect=None, unprotect=None, key=None):
        self.key_path = Path(key_path) if key_path is not None else None
        self._protect = protect or _dpapi_protect
        self._unprotect = unprotect or _dpapi_unprotect
        self.lock = threading.RLock()
        self._key = key

    def _load_key(self):
        if self._key is not None:
            return self._key
        with self.lock:
            if self._key is not None:
                return self._key
            if self.key_path is None:
                # No key file: the transform still works, but nothing survives a restart.
                self._key = os.urandom(KEY_BYTES)
                return self._key
            if self.key_path.is_file():
                blob = base64.b64decode(self.key_path.read_bytes(), validate=True)
                self._key = self._unprotect(blob)
                if len(self._key) != KEY_BYTES:
                    raise PayloadUnreadable("analysis key has the wrong length")
                return self._key
            self.key_path.parent.mkdir(parents=True, exist_ok=True)
            self._key = os.urandom(KEY_BYTES)
            self.key_path.write_bytes(base64.b64encode(self._protect(self._key)))
            return self._key

    def protect(self, text):
        """Return the stored form of `text`: an authenticated envelope, never plaintext."""
        if not isinstance(text, str):
            raise TypeError("payload must be a string")
        nonce = os.urandom(NONCE_BYTES)
        sealed = AESGCM(self._load_key()).encrypt(nonce, text.encode("utf-8"), None)
        return ENVELOPE + base64.b64encode(nonce + sealed).decode("ascii")

    def unprotect(self, stored):
        """Return the plaintext of a stored payload, tolerating legacy plaintext rows."""
        if not isinstance(stored, str):
            raise TypeError("payload must be a string")
        if not stored.startswith(ENVELOPE):
            # Written by a build that predates the encryption.
            return stored
        try:
            blob = base64.b64decode(stored[len(ENVELOPE):], validate=True)
        except (binascii.Error, ValueError) as exc:
            raise PayloadUnreadable("stored payload is not valid base64") from exc
        if len(blob) <= NONCE_BYTES:
            raise PayloadUnreadable("stored payload is too short")
        try:
            plain = AESGCM(self._load_key()).decrypt(blob[:NONCE_BYTES], blob[NONCE_BYTES:], None)
        except InvalidTag as exc:
            # Wrong key (another machine or account) or an edited payload.
            raise PayloadUnreadable("stored payload cannot be decrypted here") from exc
        return plain.decode("utf-8")

    def dumps(self, value):
        """Encrypt a JSON-serialisable value for storage."""
        return self.protect(json.dumps(value, ensure_ascii=False))

    def loads(self, stored):
        """Decrypt and parse a stored payload. `None` and the empty string read as `None`."""
        if stored is None or stored == "":
            return None
        return json.loads(self.unprotect(stored))


_default_lock = threading.Lock()
_default_cipher = None


def default_cipher(root=None):
    """The process-wide cipher, keyed by a DPAPI-protected file under `.local`."""
    global _default_cipher
    with _default_lock:
        if _default_cipher is None:
            if root is None:
                from backend_contracts import ROOT
                root = ROOT
            _default_cipher = PayloadCipher(Path(root) / ".local" / "real-client-runtime" / KEY_FILENAME)
        return _default_cipher