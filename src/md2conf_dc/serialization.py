"""Versioned JSON conversion for UI adapters and automation."""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import fields, is_dataclass
from datetime import date, datetime
from enum import Enum
from pathlib import Path
from typing import TypeGuard

from md2conf_dc.models import PageSpec


def _is_dataclass_instance(value: object) -> TypeGuard[object]:
    return is_dataclass(value) and not isinstance(value, type)


def to_json_value(value: object) -> object:
    """Convert public models to JSON-compatible values without framework coupling."""

    if value is None or isinstance(value, str | int | float | bool):
        return value
    if isinstance(value, Enum):
        return value.value
    if isinstance(value, Path):
        return value.as_posix()
    if isinstance(value, datetime | date):
        return value.isoformat()
    if isinstance(value, PageSpec):
        return {
            item.name: to_json_value(getattr(value, item.name))
            for item in fields(value)
            if item.name != "storage_value" and not item.name.startswith("_")
        }
    if _is_dataclass_instance(value):
        return {
            item.name: to_json_value(getattr(value, item.name))
            for item in fields(value)  # type: ignore[arg-type]
            if not item.name.startswith("_")
        }
    if isinstance(value, Mapping):
        return {str(key): to_json_value(item) for key, item in value.items()}
    if isinstance(value, tuple | list | set | frozenset):
        return [to_json_value(item) for item in value]
    raise TypeError(f"Unsupported JSON value: {type(value).__name__}")


def dumps(value: object, *, pretty: bool = False) -> str:
    return json.dumps(
        to_json_value(value),
        indent=2 if pretty else None,
        sort_keys=True,
        ensure_ascii=False,
        separators=None if pretty else (",", ":"),
    )
