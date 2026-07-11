"""Safety boundary for operator-managed derived-cache directories."""

from __future__ import annotations

import hashlib
import re
from pathlib import Path

CACHE_SENTINEL = ".md2conf-cache-v1"


class CacheSafetyError(ValueError):
    """Raised when a configured cache root is not safely bound to its path."""


def cache_sentinel_value(path: Path) -> str:
    resolved = path.expanduser().resolve(strict=False)
    digest = hashlib.sha256(str(resolved).encode("utf-8")).hexdigest()
    return f"md2conf-dc-derived-cache-v1:{digest}\n"


def initialize_managed_cache_root(path: Path) -> Path:
    """Bind an empty cache directory to its canonical path.

    This never adopts a non-empty directory and is intended for explicit setup flows
    such as ``md2conf init`` or a future GUI's cache-initialization action.
    """

    path = path.expanduser()
    try:
        if path.is_symlink():
            raise CacheSafetyError("refusing to initialize a symlinked cache directory")
        if path.exists() and not path.is_dir():
            raise CacheSafetyError("configured cache path is not a directory")
        sentinel = path / CACHE_SENTINEL
        existing = list(path.iterdir()) if path.exists() else []
        if existing and not sentinel.exists():
            raise CacheSafetyError("refusing to adopt a non-empty unmanaged cache directory")
        path.mkdir(parents=True, exist_ok=True)
        expected = cache_sentinel_value(path)
        if sentinel.exists():
            _verify_sentinel(sentinel, expected)
            return path.resolve(strict=True)
        sentinel.write_text(expected, encoding="utf-8")
        _verify_sentinel(sentinel, expected)
        return path.resolve(strict=True)
    except OSError as exc:
        raise CacheSafetyError(f"could not initialize the managed cache: {exc}") from exc


def require_managed_cache_root(path: Path) -> Path:
    """Return the canonical cache root only when its path-bound sentinel is valid."""

    path = path.expanduser()
    try:
        if path.is_symlink() or not path.is_dir():
            raise CacheSafetyError("configured cache is not a managed directory")
        sentinel = path / CACHE_SENTINEL
        _verify_sentinel(sentinel, cache_sentinel_value(path))
        return path.resolve(strict=True)
    except OSError as exc:
        raise CacheSafetyError(f"could not verify the managed cache: {exc}") from exc


def prepare_managed_cache_child(path: Path, name: str) -> Path:
    """Create or verify one simple derived-cache child under a managed root."""

    if re.fullmatch(r"[a-z0-9][a-z0-9-]{0,63}", name) is None:
        raise CacheSafetyError("cache child name is invalid")
    root = require_managed_cache_root(path)
    child = root / name
    try:
        if child.is_symlink():
            raise CacheSafetyError("refusing to use a symlinked cache directory")
        if child.exists() and not child.is_dir():
            raise CacheSafetyError("configured cache child is not a directory")
        child.mkdir(exist_ok=True)
        resolved = child.resolve(strict=True)
        resolved.relative_to(root)
        return resolved
    except CacheSafetyError:
        raise
    except (OSError, ValueError) as exc:
        raise CacheSafetyError(f"could not prepare the managed cache child: {exc}") from exc


def _verify_sentinel(sentinel: Path, expected: str) -> None:
    if sentinel.is_symlink() or not sentinel.is_file():
        raise CacheSafetyError("cache is uninitialized; initialize it before rendering")
    if sentinel.stat().st_size > 256:
        raise CacheSafetyError("cache sentinel is invalid")
    if sentinel.read_text(encoding="utf-8") != expected:
        raise CacheSafetyError("cache sentinel does not match the configured directory")
