"""Persist a user-selected local Laya directory across desktop updates."""

from __future__ import annotations

import json
import os
import uuid
from pathlib import Path

from model_bundle import ModelBundleError, available_model_dir, validate_model_dir


class ModelSource:
    def __init__(self, root: Path):
        self.root = Path(root).resolve()
        self.downloaded = self.root / ".local" / "models" / "laya"
        self.bundled = self.root / ".models" / "laya"
        self.config = self.root / ".local" / "real-client-runtime" / "model-source.json"

    def status(self) -> dict:
        try:
            setting = json.loads(self.config.read_text(encoding="utf-8"))
            selected = setting.get("path") if setting.get("schema") == 1 else None
        except (OSError, ValueError, AttributeError):
            selected = None
        if isinstance(selected, str) and selected and Path(selected).is_absolute():
            path = Path(selected)
            if path == self.bundled and not available_model_dir(path) and available_model_dir(self.downloaded):
                return {"state": "ready", "source": "downloaded", "path": str(self.downloaded)}
            source = "downloaded" if path == self.downloaded else "custom"
            return {"state": "ready" if available_model_dir(path) else "missing",
                    "source": source, "path": str(path)}
        for source, path in (("downloaded", self.downloaded), ("bundled", self.bundled)):
            if available_model_dir(path):
                return {"state": "ready", "source": source, "path": str(path)}
        return {"state": "missing", "source": "none", "path": str(self.downloaded)}

    def select(self, value: str) -> dict:
        if value == "downloaded":
            path = self.downloaded
        elif isinstance(value, str) and value and Path(value).is_absolute():
            path = Path(value)
        else:
            raise ModelBundleError("请选择有效的模型目录")
        try:
            path = validate_model_dir(path)
        except OSError as exc:
            raise ModelBundleError("模型目录不可用") from exc
        self.config.parent.mkdir(parents=True, exist_ok=True)
        temporary = self.config.with_name(self.config.name + "." + uuid.uuid4().hex + ".tmp")
        try:
            with temporary.open("x", encoding="utf-8") as stream:
                json.dump({"schema": 1, "path": str(path)}, stream, ensure_ascii=False)
                stream.write("\n")
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self.config)
        finally:
            temporary.unlink(missing_ok=True)
        return self.status()
