"""Read-only legacy Obsidian migration planning.

The importer extracts only path/page mappings from an explicitly supplied plugin data
file.  It never copies legacy credentials, content hashes, or ownership assumptions into
durable state; every page ID remains an unverified adoption candidate.
"""

from __future__ import annotations

import hashlib
import json
import os
from collections import defaultdict
from collections.abc import Mapping
from dataclasses import dataclass, replace
from enum import StrEnum
from pathlib import Path, PurePosixPath
from uuid import UUID, uuid5

from md2conf_dc.frontmatter import ParsedFrontmatter, parse_frontmatter
from md2conf_dc.models import ContentKind, Diagnostic, Severity, SourceSpan

MAX_LEGACY_DATA_BYTES = 32 * 1024 * 1024
MAX_LEGACY_SOURCES = 10_000
MAX_LEGACY_SOURCE_BYTES = 5 * 1024 * 1024


class LegacyCandidateStatus(StrEnum):
    UNVERIFIED = "unverified"
    MISSING_SOURCE = "missing_source"
    AMBIGUOUS = "ambiguous"


@dataclass(frozen=True, slots=True)
class LegacyImportCandidate:
    source_path: str
    source_id: str
    page_id: str | None
    title: str
    content_kind: ContentKind
    status: LegacyCandidateStatus
    provenance: tuple[str, ...]
    diagnostics: tuple[Diagnostic, ...] = ()


@dataclass(frozen=True, slots=True)
class LegacyImportPlan:
    plugin_data_path: Path
    candidates: tuple[LegacyImportCandidate, ...]
    diagnostics: tuple[Diagnostic, ...]
    digest: str

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


@dataclass(frozen=True, slots=True)
class _FrontmatterIdentity:
    parsed: ParsedFrontmatter
    absolute_path: Path


def plan_obsidian_import(
    plugin_data_path: Path,
    *,
    vault_root: Path,
    vault_id: str,
    source_ids_by_path: Mapping[str, str] | None = None,
) -> LegacyImportPlan:
    """Create a deterministic, non-mutating plan from plugin state and frontmatter."""

    namespace = UUID(vault_id)
    root = vault_root.expanduser().resolve(strict=True)
    plugin_path = plugin_data_path.expanduser().resolve(strict=True)
    diagnostics: list[Diagnostic] = []
    plugin_records = _read_plugin_records(plugin_path, root, diagnostics)
    frontmatter = _scan_frontmatter(root, diagnostics)
    known_ids = source_ids_by_path or {}
    candidates: list[LegacyImportCandidate] = []

    all_paths = sorted(
        set(plugin_records) | set(frontmatter), key=lambda item: (item.casefold(), item)
    )
    for source_path in all_paths:
        plugin_page_id = plugin_records.get(source_path)
        identity = frontmatter.get(source_path)
        settings = None if identity is None else identity.parsed.settings
        frontmatter_page_id = None if settings is None else settings.page_id
        candidate_diagnostics: list[Diagnostic] = []
        status = LegacyCandidateStatus.UNVERIFIED
        if identity is None:
            status = LegacyCandidateStatus.MISSING_SOURCE
            candidate_diagnostics.append(
                Diagnostic(
                    code="LEGACY_SOURCE_MISSING",
                    severity=Severity.WARNING,
                    message=f"legacy record source does not exist: {source_path}",
                )
            )
        if (
            plugin_page_id is not None
            and frontmatter_page_id is not None
            and plugin_page_id != frontmatter_page_id
        ):
            status = LegacyCandidateStatus.AMBIGUOUS
            candidate_diagnostics.append(
                Diagnostic(
                    code="LEGACY_PAGE_ID_CONFLICT",
                    severity=Severity.ERROR,
                    message=(
                        f"plugin state and frontmatter disagree for {source_path}: "
                        f"{plugin_page_id} versus {frontmatter_page_id}"
                    ),
                    span=None if identity is None else SourceSpan(identity.absolute_path),
                )
            )
        page_id = frontmatter_page_id or plugin_page_id
        source_id = None if settings is None else settings.source_id
        source_id = source_id or known_ids.get(source_path)
        source_id = source_id or str(uuid5(namespace, f"note:{source_path}"))
        provenance: list[str] = []
        if plugin_page_id is not None:
            provenance.append("plugin-publishedPages")
        if frontmatter_page_id is not None:
            provenance.append("frontmatter-page-id")
        if settings is not None and settings.source_id is not None:
            provenance.append("frontmatter-source-id")
        title = (
            settings.title
            if settings is not None and settings.title is not None
            else PurePosixPath(source_path).stem
        )
        content_kind = ContentKind.PAGE if settings is None else settings.content_type
        candidates.append(
            LegacyImportCandidate(
                source_path=source_path,
                source_id=str(UUID(source_id)),
                page_id=page_id,
                title=title,
                content_kind=content_kind,
                status=status,
                provenance=tuple(provenance),
                diagnostics=tuple(candidate_diagnostics),
            )
        )
        diagnostics.extend(candidate_diagnostics)

    candidates = _mark_duplicate_page_ids(candidates, diagnostics)
    digest = _legacy_digest(namespace, candidates)
    return LegacyImportPlan(plugin_path, tuple(candidates), tuple(diagnostics), digest)


def _read_plugin_records(
    path: Path, vault_root: Path, diagnostics: list[Diagnostic]
) -> dict[str, str]:
    if path.stat().st_size > MAX_LEGACY_DATA_BYTES:
        raise ValueError(f"legacy plugin data exceeds {MAX_LEGACY_DATA_BYTES} bytes")
    invalid = False
    try:
        with path.open("r", encoding="utf-8") as stream:
            value = json.load(stream)
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        invalid = True
        value = None
    if invalid:
        # Do not retain JSONDecodeError.doc: legacy plugin files may contain tokens.
        raise ValueError("legacy plugin data is not valid UTF-8 JSON")
    if not isinstance(value, Mapping):
        raise ValueError("legacy plugin data must be a JSON object")
    # Deliberately select only this field.  Access tokens, passwords, account names,
    # hashes, and all other legacy settings are ignored and never enter the plan.
    raw_records = value.get("publishedPages", {})
    if not isinstance(raw_records, Mapping):
        raise ValueError("legacy publishedPages must be a JSON object")
    if len(raw_records) > MAX_LEGACY_SOURCES:
        raise ValueError(f"legacy plugin data exceeds {MAX_LEGACY_SOURCES} source records")
    records: dict[str, str] = {}
    for raw_path, raw_record in raw_records.items():
        try:
            source_path = _safe_source_path(str(raw_path), vault_root)
            if not isinstance(raw_record, Mapping):
                raise ValueError("record must be an object")
            page_id = _legacy_page_id(raw_record.get("pageId"))
        except ValueError as exc:
            diagnostics.append(
                Diagnostic(
                    code="LEGACY_RECORD_INVALID",
                    severity=Severity.ERROR,
                    message=f"invalid legacy record for {raw_path!r}: {exc}",
                    span=SourceSpan(path),
                )
            )
            continue
        records[source_path] = page_id
    return records


def _scan_frontmatter(
    vault_root: Path, diagnostics: list[Diagnostic]
) -> dict[str, _FrontmatterIdentity]:
    result: dict[str, _FrontmatterIdentity] = {}
    seen = 0
    for directory_name, directory_names, file_names in os.walk(vault_root, followlinks=False):
        directory_names[:] = sorted(
            (
                name
                for name in directory_names
                if name not in {".git", ".obsidian", ".md2conf", "__pycache__"}
                and not (Path(directory_name) / name).is_symlink()
            ),
            key=lambda item: (item.casefold(), item),
        )
        for name in sorted(file_names, key=lambda item: (item.casefold(), item)):
            if not name.casefold().endswith(".md") or name.casefold().endswith(".excalidraw.md"):
                continue
            seen += 1
            if seen > MAX_LEGACY_SOURCES:
                diagnostics.append(
                    Diagnostic(
                        code="LEGACY_SOURCE_LIMIT",
                        severity=Severity.ERROR,
                        message=f"frontmatter scan exceeds {MAX_LEGACY_SOURCES} Markdown files",
                    )
                )
                return result
            path = Path(directory_name) / name
            try:
                resolved = path.resolve(strict=True)
                resolved.relative_to(vault_root)
                if path.is_symlink() or resolved.stat().st_size > MAX_LEGACY_SOURCE_BYTES:
                    continue
                text = resolved.read_text(encoding="utf-8-sig")
            except (OSError, UnicodeDecodeError, ValueError) as exc:
                diagnostics.append(
                    Diagnostic(
                        code="LEGACY_SOURCE_READ_FAILED",
                        severity=Severity.WARNING,
                        message=f"could not inspect legacy frontmatter: {exc}",
                        span=SourceSpan(path),
                    )
                )
                continue
            parsed = parse_frontmatter(text, path)
            diagnostics.extend(parsed.diagnostics)
            if parsed.settings.page_id is None and parsed.settings.source_id is None:
                continue
            relative = path.relative_to(vault_root).as_posix()
            result[relative] = _FrontmatterIdentity(parsed, path)
    return result


def _mark_duplicate_page_ids(
    candidates: list[LegacyImportCandidate], diagnostics: list[Diagnostic]
) -> list[LegacyImportCandidate]:
    by_page: defaultdict[str, list[int]] = defaultdict(list)
    for index, candidate in enumerate(candidates):
        if candidate.page_id is not None:
            by_page[candidate.page_id].append(index)
    for page_id, indices in by_page.items():
        if len(indices) < 2:
            continue
        paths = ", ".join(candidates[index].source_path for index in indices)
        diagnostic = Diagnostic(
            code="LEGACY_DUPLICATE_PAGE_ID",
            severity=Severity.ERROR,
            message=f"legacy page ID {page_id} is claimed by: {paths}",
        )
        diagnostics.append(diagnostic)
        for index in indices:
            candidate = candidates[index]
            candidates[index] = replace(
                candidate,
                status=LegacyCandidateStatus.AMBIGUOUS,
                diagnostics=(*candidate.diagnostics, diagnostic),
            )
    return candidates


def _safe_source_path(value: str, vault_root: Path) -> str:
    normalized = value.replace("\\", "/")
    path = PurePosixPath(normalized)
    if not normalized or path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("source path must be a normalized relative path")
    resolved = (vault_root / Path(*path.parts)).resolve(strict=False)
    try:
        resolved.relative_to(vault_root)
    except ValueError as exc:
        raise ValueError("source path escapes the vault") from exc
    return path.as_posix()


def _legacy_page_id(value: object) -> str:
    if type(value) is int:
        value = str(value)
    if not isinstance(value, str) or not value.isdecimal() or int(value) <= 0:
        raise ValueError("pageId must be a positive decimal string or integer")
    return value


def _legacy_digest(namespace: UUID, candidates: list[LegacyImportCandidate]) -> str:
    payload = {
        "schema": 1,
        "vault_id": str(namespace),
        "candidates": [
            {
                "source_path": candidate.source_path,
                "source_id": candidate.source_id,
                "page_id": candidate.page_id,
                "title": candidate.title,
                "content_kind": candidate.content_kind.value,
                "status": candidate.status.value,
                "provenance": list(candidate.provenance),
            }
            for candidate in candidates
        ],
    }
    value = json.dumps(payload, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(value.encode("utf-8")).hexdigest()
