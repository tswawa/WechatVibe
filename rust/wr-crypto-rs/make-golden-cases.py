"""Generate real-world cases for `wr/crypto.py` that the fuzzer never reaches.

The generated cases all pass garbage (`{"a": "b"}`, `"x"`) into byte parameters, so every
interesting branch (valid page, tampered HMAC, salt mismatch, round trip) is never recorded.
This writes `golden-cases.jsonl` in rust-anything's input format.
"""

from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(os.path.dirname(HERE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

from wr import crypto  # noqa: E402


def enc(value):
    if isinstance(value, bool):
        return value
    if isinstance(value, int):
        return value
    if isinstance(value, str):
        return value
    if value is None:
        return None
    if isinstance(value, (bytes, bytearray)):
        return {"$bytes": list(value)}
    if isinstance(value, crypto.PageKey):
        return {
            "$object": "PageKey",
            "attrs": {
                "key": enc(value.key),
                "salt": enc(value.salt),
                "hmac_key": enc(value.hmac_key),
            },
        }
    raise TypeError(type(value))


CASES: list[dict] = []


def case(fn, *args):
    CASES.append({"fn": fn, "args": [enc(a) for a in args]})


def usable_page_one() -> bytes:
    page = bytearray(crypto.PAGE_SIZE - crypto.RESERVED)
    page[0:16] = crypto.SQLITE_HEADER
    page[16:18] = crypto.PAGE_SIZE.to_bytes(2, "big")
    page[18] = 1
    page[19] = 1
    page[20] = crypto.RESERVED
    for i in range(100, len(page)):
        page[i] = (i * 7 + 13) & 0xFF
    return bytes(page)


def usable_page_n(n: int) -> bytes:
    page = bytearray(crypto.PAGE_SIZE - crypto.RESERVED)
    for i in range(len(page)):
        page[i] = (i * 31 + n * 17) & 0xFF
    return bytes(page)


KEYS = [
    bytes(range(32)),
    bytes([0xFF] * 32),
    bytes((i * 11) & 0xFF for i in range(32)),
]
SALTS = [
    bytes(range(16)),
    bytes([0x00] * 16),
    bytes((i * 29 + 5) & 0xFF for i in range(16)),
]

# --- key derivation ---------------------------------------------------------
for key, salt in zip(KEYS, SALTS):
    case("derive_hmac_key", key, salt)
    case("make_page_key", key, salt)
case("make_page_key", bytes(31), SALTS[0])   # raw key too short
case("make_page_key", KEYS[0], bytes(15))    # salt too short
case("derive_key_from_passphrase", b"correct horse battery staple", SALTS[0])
case("derive_key_from_passphrase", b"", SALTS[1])

# --- page encryption / decryption ------------------------------------------
for key, salt in zip(KEYS, SALTS):
    pk = crypto.make_page_key(key, salt)
    page1 = usable_page_one()
    cipher1 = crypto.encrypt_page(page1, pk, 1, True)
    case("decrypt_page", cipher1, pk, 1, True)
    case("encrypt_page", page1, pk, 1, True)

    for n in (2, 3, 1000):
        body = usable_page_n(n)
        cipher_n = crypto.encrypt_page(body, pk, n, False)
        case("decrypt_page", cipher_n, pk, n, False)
        case("encrypt_page", body, pk, n, False)

        # wrong page number in the HMAC
        case("decrypt_page", cipher_n, pk, n + 1, False)
        # wrong key
        other = crypto.make_page_key(KEYS[(KEYS.index(key) + 1) % len(KEYS)], salt)
        case("decrypt_page", cipher_n, other, n, False)

    # salt mismatch: main page one decrypted with another salt
    other_salt = crypto.make_page_key(key, SALTS[(SALTS.index(salt) + 1) % len(SALTS)])
    case("decrypt_page", cipher1, other_salt, 1, True)

    # truncated / oversized pages
    case("decrypt_page", cipher1[:-1], pk, 1, True)
    case("decrypt_page", cipher1 + b"\x00", pk, 1, True)
    case("decrypt_page", b"", pk, 1, True)

    # encrypt with a wrong-length usable page
    case("encrypt_page", page1[:-1], pk, 1, True)

# --- structural checks ------------------------------------------------------
case("is_valid_sqlite_page_one", usable_page_one())
bad_size = bytearray(usable_page_one())
bad_size[16:18] = (2048).to_bytes(2, "big")
case("is_valid_sqlite_page_one", bytes(bad_size))
bad_reserved = bytearray(usable_page_one())
bad_reserved[20] = 0
case("is_valid_sqlite_page_one", bytes(bad_reserved))
bad_header = bytearray(usable_page_one())
bad_header[0:16] = b"Not a SQLite hdr"
case("is_valid_sqlite_page_one", bytes(bad_header))
case("is_valid_sqlite_page_one", b"short")

# --- validate_key ----------------------------------------------------------
for key, salt in zip(KEYS, SALTS):
    pk = crypto.make_page_key(key, salt)
    cipher1 = crypto.encrypt_page(usable_page_one(), pk, 1, True)
    case("validate_key", key, salt, cipher1)
    case("validate_key", KEYS[(KEYS.index(key) + 1) % len(KEYS)], salt, cipher1)
    # a page that decrypts but is not a valid page 1
    odd = crypto.encrypt_page(usable_page_n(9), pk, 1, True)
    case("validate_key", key, salt, odd)

# --- looks_like_key --------------------------------------------------------
case("looks_like_key", "00" * 32)
case("looks_like_key", ("0123456789abcdef" * 4).upper())
case("looks_like_key", "AB CD EF 01" + "00" * 28)
case("looks_like_key", "0" * 63)
case("looks_like_key", "0" * 65)
case("looks_like_key", "zz" * 32)
case("looks_like_key", " 0" * 32)

with open(os.path.join(ROOT, "rust", "wr-crypto-rs", "golden-cases.jsonl"), "w", encoding="utf-8") as f:
    for c in CASES:
        f.write(json.dumps(c, ensure_ascii=False) + "\n")

print(f"wrote {len(CASES)} real-world cases")
