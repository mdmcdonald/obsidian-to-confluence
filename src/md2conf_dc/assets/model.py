"""Small immutable asset helper models."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path


def attachment_filename(path: Path, source_identity: str) -> str:
    """Return a content-independent, collision-resistant attachment filename."""

    stem = re.sub(r"[^A-Za-z0-9._-]+", "-", path.stem).strip("-._") or "asset"
    extension = path.suffix.casefold()
    identity_hash = hashlib.sha256(source_identity.encode("utf-8")).hexdigest()
    return f"{stem}-{identity_hash[:12]}{extension}"


def asset_id(*, kind: str, source: str, checksum: str) -> str:
    """Return stable asset identity; checksum represents mutable asset data separately."""

    del checksum
    value = f"md2conf-asset-v2\0{kind}\0{source}".encode()
    return hashlib.sha256(value).hexdigest()
