"""Differential check for `wr/snapshot.py`: Python and Rust run the same ops on twin directories.

    python tools/compare.py

Both start from an identical directory tree. After replay we compare every returned value and the
entire resulting file tree (names and bytes). Random uuid4 snapshot ids are normalised to `<SNAP>`
in both responses and file trees before comparison.

Usage:  python tools/compare.py
"""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
CRATE = os.path.dirname(HERE)
ROOT = os.path.dirname(os.path.dirname(CRATE))
sys.path.insert(0, os.path.join(ROOT, "native-reader"))

from wr import errors, snapshot  # noqa: E402

DATA = os.path.join(CRATE, "testdata")
PY_DIR = os.path.join(DATA, "py")
RS_DIR = os.path.join(DATA, "rs")
BINARY = os.path.join(CRATE, "target", "release", "wr-snapshot.exe")
ROOT_DIR = os.path.join(DATA, "initial")
ID_BYTES = re.compile(rb"[0-9a-f]{32}")
ID_TEXT = re.compile(r"[0-9a-f]{32}")

OPS: list[dict] = [
    {"op": "has_dataset", "dataset_id": "ds-existing"},
    {"op": "has_dataset", "dataset_id": "missing"},
    {"op": "has_dataset", "dataset_id": "../escape"},
    {"op": "load_dataset_meta", "dataset_id": "ds-existing"},
    {"op": "load_dataset_blob", "dataset_id": "ds-existing", "shard_id": "s1"},
    {"op": "load_dataset_blob", "dataset_id": "ds-existing", "shard_id": "nope"},
    {"op": "create_dataset", "dataset_id": "ds-new",
     "meta": {"shards": [{"shardId": "s2", "hasWal": False}], "note": "中文"},
     "blobs": [["s2", "hello blob"]]},
    {"op": "load_dataset_meta", "dataset_id": "ds-new"},
    {"op": "load_dataset_blob", "dataset_id": "ds-new", "shard_id": "s2"},
    {"op": "create_dataset", "dataset_id": "ds-new",
     "meta": {"shards": [{"shardId": "s2", "hasWal": True}]},
     "blobs": [["s2", "MUST NOT OVERWRITE"]]},
    {"op": "load_dataset_meta", "dataset_id": "ds-new"},
    {"op": "load_dataset_blob", "dataset_id": "ds-new", "shard_id": "s2"},
    {"op": "create_snapshot", "meta": {"datasetId": "ds-new", "contact": "wxid_a", "tag": "中文"}},
    {"op": "load_meta", "from_create": 12},
    {"op": "load_meta", "id": "nope"},
    {"op": "load_meta", "id": "../escape"},
    {"op": "create_dataset", "dataset_id": "ds-temp", "meta": {"shards": []}, "blobs": []},
    {"op": "prune_datasets", "max": 1},
    {"op": "has_dataset", "dataset_id": "ds-temp"},
    {"op": "has_dataset", "dataset_id": "ds-new"},
    {"op": "load_dataset_meta", "dataset_id": ""},
    {"op": "create_snapshot", "meta": {"datasetId": "ds-existing"}},
]


def normalise(value, id_map=None):
    """Replace generated uuid4 ids with per-run sequential tokens, recursively."""
    def sub_text(value):
        return id_map.get(value, "<SNAP>") if id_map else "<SNAP>"

    def sub_bytes(match):
        return sub_text(match.group(0).decode("ascii")).encode("utf-8")

    if isinstance(value, bytes):
        return ID_BYTES.sub(sub_bytes, value)
    if isinstance(value, str):
        return ID_TEXT.sub(lambda match: sub_text(match.group(0)), value)
    if isinstance(value, list):
        return [normalise(v) for v in value]
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            if key == "error" and isinstance(item, str):
                item = re.sub(r"^ProtocolError\([^)]*\): ", "ProtocolError: ", item)
            out[normalise(key, id_map)] = normalise(item, id_map)
        return out
    return value


def build_initial() -> None:
    os.makedirs(ROOT_DIR, exist_ok=True)
    for name in os.listdir(ROOT_DIR):
        path = os.path.join(ROOT_DIR, name)
        if os.path.isfile(path):
            os.remove(path)
    with open(os.path.join(ROOT_DIR, "ds-existing.dataset.json"), "w", encoding="utf-8") as handle:
        json.dump({"shards": [{"shardId": "s1", "hasWal": False}], "datasetId": "ds-existing"},
                  handle, ensure_ascii=False)
    with open(os.path.join(ROOT_DIR, "ds-existing." + snapshot.blob_digest("s1") + ".bin"), "wb") as handle:
        handle.write(b"existing blob")
    with open(os.path.join(ROOT_DIR, "old-snap.meta.json"), "w", encoding="utf-8") as handle:
        json.dump({"datasetId": "ds-existing", "contact": "old"}, handle, ensure_ascii=False)
    with open(os.path.join(ROOT_DIR, "junk.txt"), "wb") as handle:
        handle.write(b"unrelated")
    # Deterministic, distinct mtimes so pruning order does not depend on wall clock.
    for index, name in enumerate(sorted(os.listdir(ROOT_DIR))):
        os.utime(os.path.join(ROOT_DIR, name), (1_700_000_000 + index, 1_700_000_000 + index))


def fresh_dir(target: str) -> None:
    if os.path.exists(target):
        shutil.rmtree(target)
    shutil.copytree(ROOT_DIR, target)


def run_python() -> list[dict]:
    store = snapshot.SnapshotStore(PY_DIR)
    responses: list[dict] = []
    for op in OPS:
        name = op["op"]
        if "from_create" in op:
            target = responses[op["from_create"]]["ok"]["snapshotId"]
        else:
            target = op.get("id")
        try:
            if name == "has_dataset":
                value = store.has_dataset(op["dataset_id"])
            elif name == "create_dataset":
                value = store.create_dataset(op["dataset_id"], op["meta"], [(b[0], b[1].encode("utf-8")) for b in op["blobs"]])
            elif name == "load_dataset_meta":
                value = store.load_dataset_meta(op["dataset_id"])
            elif name == "load_dataset_blob":
                value = list(store.load_dataset_blob(op["dataset_id"], op["shard_id"]))
            elif name == "prune_datasets":
                value = store.prune_datasets(op["max"])
            elif name == "create_snapshot":
                value = store.create_snapshot(op["meta"])
            elif name == "load_meta":
                value = store.load_meta(target)
            else:
                raise SystemExit(f"unknown op {name}")
            responses.append({"ok": value})
        except errors.ProtocolError as exc:
            responses.append({"error": f"ProtocolError: {exc}"})
    return responses


def run_rust() -> list[dict]:
    if not os.path.exists(BINARY):
        print(f"missing {BINARY}; run: cargo build --release", file=sys.stderr)
        raise SystemExit(2)
    ops_file = os.path.join(DATA, "snapshot-ops.json")
    with open(ops_file, "w", encoding="utf-8") as handle:
        for op in OPS:
            handle.write(json.dumps(op, ensure_ascii=False) + "\n")
    proc = subprocess.run(
        [BINARY, "--dir", RS_DIR, "--ops", ops_file],
        check=True,
        capture_output=True,
    )
    return json.loads(proc.stdout)


def tree(directory: str, id_map: dict | None = None) -> dict:
    out = {}
    for root, _, files in os.walk(directory):
        for name in files:
            path = os.path.join(root, name)
            relative = os.path.relpath(path, directory).replace("\\", "/")
            with open(path, "rb") as handle:
                out[normalise(relative, id_map)] = normalise(handle.read(), id_map)
    return out


def main() -> int:
    build_initial()
    fresh_dir(PY_DIR)
    fresh_dir(RS_DIR)
    py_raw = run_python()
    rs_raw = run_rust()

    def id_map_of(responses):
        return {
            response["ok"]["snapshotId"]: f"snap{index}"
            for index, response in enumerate(responses)
            if "ok" in response and isinstance(response["ok"], dict)
            and "snapshotId" in response["ok"]
        }

    py_ids, rs_ids = id_map_of(py_raw), id_map_of(rs_raw)
    py_results = normalise(py_raw, py_ids)
    rs_results = normalise(rs_raw, rs_ids)

    failures = []
    if len(py_results) != len(rs_results):
        failures.append(f"response count: python={len(py_results)} rust={len(rs_results)}")
    for index, (want, have) in enumerate(zip(py_results, rs_results)):
        if want != have:
            failures.append(
                f"op #{index} {OPS[index]['op']}:\n"
                f"  python {json.dumps(want, ensure_ascii=False)[:220]}\n"
                f"  rust   {json.dumps(have, ensure_ascii=False)[:220]}"
            )

    py_tree, rs_tree = tree(PY_DIR, py_ids), tree(RS_DIR, rs_ids)
    for path in sorted(set(py_tree) | set(rs_tree)):
        if py_tree.get(path) != rs_tree.get(path):
            failures.append(
                f"file {path}:\n  python {str(py_tree.get(path))[:220]}\n"
                f"  rust   {str(rs_tree.get(path))[:220]}"
            )

    total = len(OPS) + len(set(py_tree) | set(rs_tree))
    for failure in failures:
        print(failure)
    print(f"{total - len(failures)}/{total} checks identical "
          f"({len(OPS)} responses + {len(set(py_tree) | set(rs_tree))} files)")
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
