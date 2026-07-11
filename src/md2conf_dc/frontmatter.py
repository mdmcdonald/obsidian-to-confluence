"""Bounded, safe YAML frontmatter parsing and explicit identity writeback."""

from __future__ import annotations

import hashlib
import io
import os
import re
import tempfile
from collections.abc import Mapping, MutableMapping, Sequence
from dataclasses import dataclass, field
from datetime import date, datetime
from pathlib import Path
from types import MappingProxyType
from uuid import UUID

from ruamel.yaml import YAML
from ruamel.yaml.error import YAMLError

from md2conf_dc.models import (
    ContentKind,
    Diagnostic,
    FrontmatterSettings,
    Severity,
    SourceSpan,
)

DEFAULT_MAX_FRONTMATTER_BYTES = 1024 * 1024
DEFAULT_MAX_ALIASES = 50
DEFAULT_MAX_DEPTH = 20
DEFAULT_MAX_NODES = 10_000
_ALIAS_PATTERN = re.compile(r"(?<![\w])\*[A-Za-z0-9_-]+")
_KNOWN_CONnie_KEYS = {
    "connie-publish",
    "connie-title",
    "connie-frontmatter-to-publish",
    "connie-page-id",
    "connie-source-id",
    "connie-dont-change-parent-page",
    "connie-blog-post-date",
    "connie-content-type",
}


@dataclass(frozen=True, slots=True)
class ParsedFrontmatter:
    settings: FrontmatterSettings
    body: str
    diagnostics: tuple[Diagnostic, ...]
    raw: Mapping[str, object]

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


@dataclass(frozen=True, slots=True)
class FrontmatterWriteResult:
    path: Path
    changed: bool
    source_sha256_before: str
    source_sha256_after: str
    diagnostics: tuple[Diagnostic, ...] = ()


@dataclass(frozen=True, slots=True)
class IdentityWritebackPlan:
    """Compare-and-swap plan for an explicit post-commit Markdown mutation.

    The updated bytes are deliberately excluded from ``repr`` so source contents do not
    accidentally enter a GUI debug log or structured event.
    """

    path: Path
    source_id: str
    page_id: str | None
    publish: bool | None
    source_sha256_before: str
    source_sha256_after: str
    changed: bool
    diagnostics: tuple[Diagnostic, ...]
    updated_bytes: bytes = field(repr=False)


@dataclass(frozen=True, slots=True)
class PublishFrontmatterPlan:
    """Non-mutating preview for changing only ``connie-publish``."""

    path: Path
    publish: bool
    source_sha256_before: str
    source_sha256_after: str
    changed: bool
    diagnostics: tuple[Diagnostic, ...]
    updated_bytes: bytes = field(repr=False)


@dataclass(frozen=True, slots=True)
class PublishFrontmatterResult:
    path: Path
    publish: bool
    changed: bool
    source_sha256_before: str
    source_sha256_after: str
    diagnostics: tuple[Diagnostic, ...] = ()


def parse_frontmatter(
    text: str,
    path: Path,
    *,
    max_bytes: int = DEFAULT_MAX_FRONTMATTER_BYTES,
    max_aliases: int = DEFAULT_MAX_ALIASES,
    max_depth: int = DEFAULT_MAX_DEPTH,
    max_nodes: int = DEFAULT_MAX_NODES,
) -> ParsedFrontmatter:
    """Parse one Markdown document's leading frontmatter with bounded YAML features."""

    empty = FrontmatterSettings()
    if not text.startswith("---\n") and not text.startswith("---\r\n"):
        return ParsedFrontmatter(empty, text, (), MappingProxyType({}))

    lines = text.splitlines(keepends=True)
    closing_index = next(
        (index for index, line in enumerate(lines[1:], start=1) if line.rstrip("\r\n") == "---"),
        None,
    )
    if closing_index is None:
        diagnostic = _error(path, "FRONTMATTER_UNTERMINATED", "frontmatter has no closing '---'")
        return ParsedFrontmatter(empty, text, (diagnostic,), MappingProxyType({}))

    yaml_text = "".join(lines[1:closing_index])
    body = "".join(lines[closing_index + 1 :])
    if len(yaml_text.encode("utf-8")) > max_bytes:
        diagnostic = _error(
            path,
            "FRONTMATTER_TOO_LARGE",
            f"frontmatter exceeds the {max_bytes}-byte limit",
        )
        return ParsedFrontmatter(empty, body, (diagnostic,), MappingProxyType({}))
    if len(_ALIAS_PATTERN.findall(yaml_text)) > max_aliases:
        diagnostic = _error(
            path,
            "FRONTMATTER_ALIAS_LIMIT",
            f"frontmatter exceeds the {max_aliases}-alias limit",
        )
        return ParsedFrontmatter(empty, body, (diagnostic,), MappingProxyType({}))
    if _flow_depth_exceeded(yaml_text, max_depth=max_depth):
        diagnostic = _error(
            path,
            "FRONTMATTER_DEPTH_LIMIT",
            f"frontmatter exceeds the {max_depth}-level nesting limit",
        )
        return ParsedFrontmatter(empty, body, (diagnostic,), MappingProxyType({}))

    diagnostics: list[Diagnostic] = []
    try:
        yaml = YAML(typ="safe", pure=True)
        yaml.allow_duplicate_keys = False
        loaded = yaml.load(yaml_text) if yaml_text.strip() else {}
    except (YAMLError, ValueError, RecursionError) as exc:
        diagnostics.append(_error(path, "FRONTMATTER_YAML_INVALID", _safe_yaml_error_message(exc)))
        return ParsedFrontmatter(empty, body, tuple(diagnostics), MappingProxyType({}))

    if loaded is None:
        loaded = {}
    if not isinstance(loaded, Mapping) or not all(isinstance(key, str) for key in loaded):
        diagnostics.append(
            _error(path, "FRONTMATTER_NOT_MAPPING", "frontmatter must be a string-keyed mapping")
        )
        return ParsedFrontmatter(empty, body, tuple(diagnostics), MappingProxyType({}))
    try:
        _validate_structure(loaded, max_depth=max_depth, max_nodes=max_nodes)
    except ValueError as exc:
        diagnostics.append(_error(path, "FRONTMATTER_LIMIT", str(exc)))
        return ParsedFrontmatter(empty, body, tuple(diagnostics), MappingProxyType({}))

    data = {str(key): _normalize_yaml_value(value) for key, value in loaded.items()}
    for key in sorted(data):
        if key.startswith("connie-") and key not in _KNOWN_CONnie_KEYS:
            diagnostics.append(
                Diagnostic(
                    code="FRONTMATTER_UNKNOWN_CONnie_KEY",
                    severity=Severity.WARNING,
                    message=f"unknown publisher frontmatter key {key!r}",
                    span=SourceSpan(path),
                    hint="Check the key spelling; it will otherwise be ignored",
                )
            )

    publish = _optional_bool(data, "connie-publish", path, diagnostics)
    title = _optional_nonempty_string(data, "connie-title", path, diagnostics)
    projected = _optional_string_tuple(
        data,
        "connie-frontmatter-to-publish",
        path,
        diagnostics,
        allow_scalar=False,
    )
    tags = _optional_string_tuple(data, "tags", path, diagnostics, allow_scalar=True)
    page_id = _optional_positive_decimal(data, "connie-page-id", path, diagnostics)
    source_id = _optional_uuid(data, "connie-source-id", path, diagnostics)
    dont_change = _optional_bool(
        data,
        "connie-dont-change-parent-page",
        path,
        diagnostics,
    )
    blog_date = _optional_date(data, "connie-blog-post-date", path, diagnostics)
    content_type = _content_kind(data, path, diagnostics)
    metadata = {key: value for key, value in data.items() if not key.startswith("connie-")}

    settings = FrontmatterSettings(
        publish=publish,
        title=title,
        frontmatter_to_publish=projected,
        tags=tags,
        page_id=page_id,
        source_id=source_id,
        # The TypeScript plugin defaults to keeping an existing page in place; only an
        # explicit false opts a note into hierarchy-driven reparenting.
        dont_change_parent_page=True if dont_change is None else dont_change,
        blog_post_date=blog_date,
        content_type=content_type,
        metadata=MappingProxyType(metadata),
    )
    return ParsedFrontmatter(
        settings=settings,
        body=body,
        diagnostics=tuple(diagnostics),
        raw=MappingProxyType(data),
    )


def write_identity_frontmatter(
    path: Path,
    *,
    source_id: str,
    page_id: str | None = None,
    publish: bool | None = None,
    vault_root: Path,
    expected_sha256: str | None = None,
    max_bytes: int = DEFAULT_MAX_FRONTMATTER_BYTES,
) -> FrontmatterWriteResult:
    """Round-trip identity keys into a note using compare-and-swap semantics.

    This is an explicit mutation API, not called by discovery or planning.  It rejects
    symlinks and paths outside ``vault_root``, so a GUI can safely preview and then apply
    writeback without granting the renderer an implicit file-write capability.
    """

    plan = plan_identity_writeback(
        path,
        source_id=source_id,
        page_id=page_id,
        publish=publish,
        vault_root=vault_root,
        expected_sha256=expected_sha256,
        max_bytes=max_bytes,
    )
    if not plan.changed:
        return FrontmatterWriteResult(
            plan.path,
            False,
            plan.source_sha256_before,
            plan.source_sha256_after,
            plan.diagnostics,
        )
    current_hash = hashlib.sha256(plan.path.read_bytes()).hexdigest()
    if current_hash != plan.source_sha256_before:
        raise ValueError("source changed after writeback planning; writeback was not applied")
    _atomic_write(plan.path, plan.updated_bytes)
    return FrontmatterWriteResult(
        plan.path,
        True,
        plan.source_sha256_before,
        plan.source_sha256_after,
        plan.diagnostics,
    )


def plan_identity_writeback(
    path: Path,
    *,
    source_id: str,
    page_id: str | None = None,
    publish: bool | None = None,
    vault_root: Path,
    expected_sha256: str | None = None,
    max_bytes: int = DEFAULT_MAX_FRONTMATTER_BYTES,
) -> IdentityWritebackPlan:
    """Build a non-mutating, GUI-previewable identity writeback plan."""

    normalized_source_id = str(UUID(source_id))
    if page_id is not None and (not page_id.isdecimal() or int(page_id) <= 0):
        raise ValueError("page_id must be a positive decimal string")
    if publish is not None and type(publish) is not bool:
        raise ValueError("publish must be a Boolean when supplied")
    root = vault_root.expanduser().resolve(strict=True)
    if path.is_symlink():
        raise ValueError("identity writeback refuses symlink paths")
    resolved = path.expanduser().resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("identity writeback path is outside the vault") from exc

    original_bytes = resolved.read_bytes()
    before = hashlib.sha256(original_bytes).hexdigest()
    text = original_bytes.decode("utf-8-sig")
    normalized_hash = hashlib.sha256(
        text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    ).hexdigest()
    if expected_sha256 is not None and expected_sha256 not in {before, normalized_hash}:
        raise ValueError("source changed since it was read; identity writeback was not applied")
    parsed = parse_frontmatter(text, resolved, max_bytes=max_bytes)
    if not parsed.ok:
        raise ValueError("cannot write identity into invalid frontmatter")

    updated = _updated_frontmatter_text(
        text,
        source_id=normalized_source_id,
        page_id=page_id,
        publish=publish,
    )
    bom = b"\xef\xbb\xbf" if original_bytes.startswith(b"\xef\xbb\xbf") else b""
    updated_bytes = bom + updated.encode("utf-8")
    after = hashlib.sha256(updated_bytes).hexdigest()
    return IdentityWritebackPlan(
        path=resolved,
        source_id=normalized_source_id,
        page_id=page_id,
        publish=publish,
        source_sha256_before=before,
        source_sha256_after=after,
        changed=updated_bytes != original_bytes,
        diagnostics=parsed.diagnostics,
        updated_bytes=updated_bytes,
    )


def set_publish_frontmatter(
    path: Path,
    publish: bool,
    *,
    vault_root: Path | None = None,
    expected_sha256: str | None = None,
    max_bytes: int = DEFAULT_MAX_FRONTMATTER_BYTES,
) -> PublishFrontmatterResult:
    """Set only ``connie-publish`` using a guarded atomic replacement."""

    plan = plan_publish_frontmatter(
        path,
        publish,
        vault_root=vault_root,
        expected_sha256=expected_sha256,
        max_bytes=max_bytes,
    )
    if plan.changed:
        current_hash = hashlib.sha256(plan.path.read_bytes()).hexdigest()
        if current_hash != plan.source_sha256_before:
            raise ValueError("source changed after writeback planning; writeback was not applied")
        _atomic_write(plan.path, plan.updated_bytes)
    return PublishFrontmatterResult(
        path=plan.path,
        publish=plan.publish,
        changed=plan.changed,
        source_sha256_before=plan.source_sha256_before,
        source_sha256_after=plan.source_sha256_after,
        diagnostics=plan.diagnostics,
    )


def plan_publish_frontmatter(
    path: Path,
    publish: bool,
    *,
    vault_root: Path | None = None,
    expected_sha256: str | None = None,
    max_bytes: int = DEFAULT_MAX_FRONTMATTER_BYTES,
) -> PublishFrontmatterPlan:
    """Preview a publish toggle without inventing or changing identity fields."""

    if type(publish) is not bool:
        raise ValueError("publish must be a Boolean")
    root = path.parent if vault_root is None else vault_root
    root = root.expanduser().resolve(strict=True)
    if path.is_symlink():
        raise ValueError("frontmatter writeback refuses symlink paths")
    resolved = path.expanduser().resolve(strict=True)
    try:
        resolved.relative_to(root)
    except ValueError as exc:
        raise ValueError("frontmatter writeback path is outside the vault") from exc

    original_bytes = resolved.read_bytes()
    before = hashlib.sha256(original_bytes).hexdigest()
    text = original_bytes.decode("utf-8-sig")
    normalized_hash = hashlib.sha256(
        text.replace("\r\n", "\n").replace("\r", "\n").encode("utf-8")
    ).hexdigest()
    if expected_sha256 is not None and expected_sha256 not in {before, normalized_hash}:
        raise ValueError("source changed since it was read; publish toggle was not applied")
    parsed = parse_frontmatter(text, resolved, max_bytes=max_bytes)
    if not parsed.ok:
        raise ValueError("cannot update publish state in invalid frontmatter")

    updated = _updated_frontmatter_values(text, {"connie-publish": publish})
    bom = b"\xef\xbb\xbf" if original_bytes.startswith(b"\xef\xbb\xbf") else b""
    updated_bytes = bom + updated.encode("utf-8")
    after = hashlib.sha256(updated_bytes).hexdigest()
    return PublishFrontmatterPlan(
        path=resolved,
        publish=publish,
        source_sha256_before=before,
        source_sha256_after=after,
        changed=updated_bytes != original_bytes,
        diagnostics=parsed.diagnostics,
        updated_bytes=updated_bytes,
    )


def _updated_frontmatter_text(
    text: str,
    *,
    source_id: str,
    page_id: str | None,
    publish: bool | None,
) -> str:
    updates: dict[str, object] = {"connie-source-id": source_id}
    if page_id is not None:
        updates["connie-page-id"] = page_id
    if publish is not None:
        updates["connie-publish"] = publish
    return _updated_frontmatter_values(text, updates)


def _updated_frontmatter_values(text: str, updates: Mapping[str, object]) -> str:
    yaml = YAML(typ="rt", pure=True)
    yaml.allow_duplicate_keys = False
    yaml.preserve_quotes = True
    if text.startswith("---\n") or text.startswith("---\r\n"):
        lines = text.splitlines(keepends=True)
        closing = next(
            index for index, line in enumerate(lines[1:], start=1) if line.rstrip("\r\n") == "---"
        )
        frontmatter_text = "".join(lines[1:closing])
        body = "".join(lines[closing + 1 :])
        data = yaml.load(frontmatter_text) if frontmatter_text.strip() else {}
        if data is None:
            data = {}
    else:
        data = {}
        body = text
    if not isinstance(data, MutableMapping):
        raise ValueError("frontmatter must be a mapping")
    if all(data.get(key) == value for key, value in updates.items()):
        return text
    data.update(updates)
    output = io.StringIO()
    yaml.dump(data, output)
    newline = "\r\n" if "\r\n" in text else "\n"
    yaml_output = output.getvalue().replace("\r\n", "\n").replace("\r", "\n")
    yaml_output = yaml_output.replace("\n", newline)
    return f"---{newline}{yaml_output}---{newline}{body}"


def _atomic_write(path: Path, content: bytes) -> None:
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, path.stat().st_mode)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _optional_bool(
    data: Mapping[str, object],
    key: str,
    path: Path,
    diagnostics: list[Diagnostic],
) -> bool | None:
    value = data.get(key)
    if value is None:
        return None
    if type(value) is not bool:
        diagnostics.append(_type_error(path, key, "a Boolean"))
        return None
    return value


def _optional_nonempty_string(
    data: Mapping[str, object],
    key: str,
    path: Path,
    diagnostics: list[Diagnostic],
) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.strip():
        diagnostics.append(_type_error(path, key, "a non-empty string"))
        return None
    return value.strip()


def _optional_string_tuple(
    data: Mapping[str, object],
    key: str,
    path: Path,
    diagnostics: list[Diagnostic],
    *,
    allow_scalar: bool,
) -> tuple[str, ...]:
    value = data.get(key)
    if value is None:
        return ()
    if allow_scalar and isinstance(value, str):
        items: Sequence[object] = [part.strip() for part in value.split(",")]
    elif isinstance(value, (list, tuple)):
        items = value
    else:
        diagnostics.append(_type_error(path, key, "a list of strings"))
        return ()
    if any(not isinstance(item, str) or not item.strip() for item in items):
        diagnostics.append(_type_error(path, key, "a list of non-empty strings"))
        return ()
    return tuple(dict.fromkeys(str(item).strip() for item in items))


def _optional_positive_decimal(
    data: Mapping[str, object], key: str, path: Path, diagnostics: list[Diagnostic]
) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
        diagnostics.append(_type_error(path, key, "a positive decimal string"))
        return None
    return value


def _optional_uuid(
    data: Mapping[str, object], key: str, path: Path, diagnostics: list[Diagnostic]
) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if not isinstance(value, str):
        diagnostics.append(_type_error(path, key, "a UUID string"))
        return None
    try:
        return str(UUID(value))
    except ValueError:
        diagnostics.append(_type_error(path, key, "a UUID string"))
        return None


def _optional_date(
    data: Mapping[str, object], key: str, path: Path, diagnostics: list[Diagnostic]
) -> str | None:
    value = data.get(key)
    if value is None:
        return None
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, str):
        try:
            return date.fromisoformat(value).isoformat()
        except ValueError:
            diagnostics.append(_type_error(path, key, "an ISO 8601 date"))
            return None
    diagnostics.append(_type_error(path, key, "an ISO 8601 date"))
    return None


def _content_kind(
    data: Mapping[str, object], path: Path, diagnostics: list[Diagnostic]
) -> ContentKind:
    value = data.get("connie-content-type")
    if value is None:
        return ContentKind.PAGE
    if not isinstance(value, str):
        diagnostics.append(_type_error(path, "connie-content-type", "'page' or 'blogpost'"))
        return ContentKind.PAGE
    normalized = value.casefold().replace("-", "").replace("_", "")
    if normalized == "page":
        return ContentKind.PAGE
    if normalized == "blogpost":
        return ContentKind.BLOGPOST
    diagnostics.append(_type_error(path, "connie-content-type", "'page' or 'blogpost'"))
    return ContentKind.PAGE


def _normalize_yaml_value(value: object) -> object:
    if isinstance(value, datetime):
        return value.isoformat()
    if isinstance(value, date):
        return value.isoformat()
    if isinstance(value, Mapping):
        return {str(key): _normalize_yaml_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [_normalize_yaml_value(item) for item in value]
    if value is None or type(value) in {str, bool, int, float}:
        return value
    return str(value)


def _validate_structure(value: object, *, max_depth: int, max_nodes: int) -> None:
    nodes = 0
    active: set[int] = set()

    def visit(item: object, depth: int) -> None:
        nonlocal nodes
        nodes += 1
        if nodes > max_nodes:
            raise ValueError(f"frontmatter exceeds the {max_nodes}-node limit")
        if depth > max_depth:
            raise ValueError(f"frontmatter exceeds the {max_depth}-level nesting limit")
        if isinstance(item, (Mapping, list, tuple)):
            identity = id(item)
            if identity in active:
                raise ValueError("frontmatter contains a recursive YAML alias")
            active.add(identity)
            children = item.values() if isinstance(item, Mapping) else item
            for child in children:
                visit(child, depth + 1)
            active.remove(identity)

    visit(value, 0)


def _error(path: Path, code: str, message: str) -> Diagnostic:
    return Diagnostic(code=code, severity=Severity.ERROR, message=message, span=SourceSpan(path))


def _type_error(path: Path, key: str, expected: str) -> Diagnostic:
    return _error(path, "FRONTMATTER_TYPE", f"{key} must be {expected}")


def _safe_yaml_error_message(error: Exception) -> str:
    mark = getattr(error, "problem_mark", None)
    line = getattr(mark, "line", None)
    column = getattr(mark, "column", None)
    if isinstance(line, int) and isinstance(column, int):
        return f"frontmatter contains invalid YAML near line {line + 1}, column {column + 1}"
    return "frontmatter contains invalid YAML"


def _flow_depth_exceeded(value: str, *, max_depth: int) -> bool:
    """Bound flow-style nesting before handing untrusted text to the YAML parser."""

    depth = 0
    quote: str | None = None
    escaped = False
    comment = False
    for character in value:
        if comment:
            if character == "\n":
                comment = False
            continue
        if quote == '"':
            if escaped:
                escaped = False
            elif character == "\\":
                escaped = True
            elif character == '"':
                quote = None
            continue
        if quote == "'":
            if character == "'":
                quote = None
            continue
        if character in {'"', "'"}:
            quote = character
        elif character == "#":
            comment = True
        elif character in "[{":
            depth += 1
            if depth > max_depth:
                return True
        elif character in "]}" and depth:
            depth -= 1
    return False
