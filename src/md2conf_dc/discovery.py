"""Deterministic, scope-aware Markdown source discovery."""

from __future__ import annotations

import hashlib
import json
import os
import re
import stat
from collections import defaultdict
from collections.abc import Sequence
from dataclasses import dataclass
from pathlib import Path, PurePosixPath
from typing import Protocol
from uuid import UUID, uuid5

from md2conf_dc.config import SourceConfig
from md2conf_dc.frontmatter import parse_frontmatter
from md2conf_dc.models import (
    Diagnostic,
    Selection,
    Severity,
    SourceDocument,
    SourceIdentity,
    SourceKind,
    SourceSpan,
)

_FENCE_OPEN = re.compile(r"^[ \t]{0,3}(`{3,}|~{3,})")
_ATX_H1 = re.compile(r"^[ \t]{0,3}#[ \t]+(.+?)[ \t]*$")


class _UnsafeSourcePathError(OSError):
    pass


class SourceIdentityLookup(Protocol):
    def source_id_for_path(self, relative_path: str) -> str | None: ...


@dataclass(frozen=True, slots=True)
class DiscoveryResult:
    """Authoritative corpus plus the subset selected for an eventual publish."""

    documents: tuple[SourceDocument, ...]
    diagnostics: tuple[Diagnostic, ...]
    authoritative: bool
    selected_source_ids: frozenset[str]
    source_set_sha256: str
    scope_fingerprint: str

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)

    @property
    def orphan_reconciliation_safe(self) -> bool:
        """Whether local discovery is complete enough to evaluate remote orphans."""

        return self.authoritative and self.ok and bool(self.documents)


def discover_sources(
    config: SourceConfig,
    *,
    vault_id: str,
    state: SourceIdentityLookup | None = None,
    selection: Selection | None = None,
) -> DiscoveryResult:
    """Discover every publishable source, then identify the requested publish subset.

    The complete publishable corpus is always returned because global title and link
    resolution must not vary with batch size.  ``selected_source_ids`` carries a
    non-authoritative single-file/batch selection for the planner.
    """

    namespace = UUID(vault_id)
    vault_root = config.vault_root.resolve(strict=True)
    publish_root = config.publish_root.resolve(strict=False)
    if not _is_relative_to(publish_root, vault_root):
        raise ValueError("publish root is outside the vault")
    requested = selection or Selection.all()
    diagnostics: list[Diagnostic] = []
    candidates = _candidate_paths(vault_root, config, diagnostics)
    if len(candidates) > config.max_documents:
        diagnostics.append(
            Diagnostic(
                code="DISCOVERY_DOCUMENT_LIMIT",
                severity=Severity.ERROR,
                message=(
                    f"discovery found {len(candidates)} Markdown files, exceeding the "
                    f"{config.max_documents}-document limit"
                ),
            )
        )

    documents: list[SourceDocument] = []
    for path in candidates[: config.max_documents]:
        relative = PurePosixPath(path.relative_to(vault_root).as_posix())
        relative_string = relative.as_posix()
        in_scope = _is_relative_to(path, publish_root)
        included_by_glob = _matches_any(relative, config.include)
        try:
            raw = _read_regular_source(path, max_bytes=config.max_source_bytes)
        except _UnsafeSourcePathError:
            diagnostics.append(
                _path_error(
                    path,
                    "SOURCE_PATH_UNSAFE",
                    "source is a symlink, non-regular file, or changed during opening",
                )
            )
            continue
        except OSError as exc:
            diagnostics.append(_path_error(path, "SOURCE_READ_FAILED", str(exc)))
            continue
        if len(raw) > config.max_source_bytes:
            diagnostics.append(
                _path_error(
                    path,
                    "SOURCE_TOO_LARGE",
                    f"source exceeds the {config.max_source_bytes}-byte limit",
                )
            )
            continue
        try:
            text = raw.decode("utf-8-sig").replace("\r\n", "\n").replace("\r", "\n")
        except UnicodeDecodeError as exc:
            diagnostics.append(_path_error(path, "SOURCE_READ_FAILED", str(exc)))
            continue
        parsed = parse_frontmatter(
            text,
            path,
            max_bytes=config.max_frontmatter_bytes,
        )
        diagnostics.extend(parsed.diagnostics)
        explicit = parsed.settings.publish
        publishable = explicit is True or (in_scope and included_by_glob and explicit is not False)
        if not publishable:
            continue
        local_diagnostics = list(parsed.diagnostics)
        if not in_scope:
            warning = Diagnostic(
                code="SOURCE_OUTSIDE_SCOPE",
                severity=Severity.WARNING,
                message=(
                    f"{relative_string} is outside the publish root and was included by "
                    "connie-publish: true"
                ),
                span=SourceSpan(path),
                hint="It will be placed under the configured boundary root",
            )
            local_diagnostics.append(warning)
            diagnostics.append(warning)

        source_id = parsed.settings.source_id
        if source_id is None and state is not None:
            source_id = state.source_id_for_path(relative_string)
        if source_id is None:
            source_id = str(uuid5(namespace, f"note:{relative_string}"))

        body = parsed.body
        title = parsed.settings.title
        if title is None and config.first_heading_page_title:
            heading = _consume_first_h1(body)
            if heading is not None:
                title, body = heading
        if title is None:
            title = path.stem
        identity = SourceIdentity(
            vault_id=str(namespace),
            source_id=source_id,
            relative_path=relative_string,
            kind=SourceKind.NOTE,
        )
        documents.append(
            SourceDocument(
                identity=identity,
                absolute_path=path,
                source_sha256=hashlib.sha256(text.encode("utf-8")).hexdigest(),
                body=body,
                frontmatter=parsed.settings,
                title_candidate=title,
                diagnostics=tuple(local_diagnostics),
            )
        )

    documents.sort(
        key=lambda item: (
            item.identity.relative_path.casefold(),
            item.identity.relative_path,
        )
    )
    diagnostics.extend(_duplicate_identity_diagnostics(documents))
    diagnostics.extend(_case_colliding_path_diagnostics(documents))
    selected_ids = _selected_source_ids(documents, requested, vault_root, diagnostics)
    source_set_sha256 = _source_set_digest(documents)
    scope_fingerprint = _scope_fingerprint(namespace, config)
    return DiscoveryResult(
        documents=tuple(documents),
        diagnostics=tuple(diagnostics),
        authoritative=requested.authoritative,
        selected_source_ids=selected_ids,
        source_set_sha256=source_set_sha256,
        scope_fingerprint=scope_fingerprint,
    )


def _candidate_paths(
    vault_root: Path, config: SourceConfig, diagnostics: list[Diagnostic]
) -> list[Path]:
    candidates: list[Path] = []
    for directory_name, directory_names, file_names in os.walk(vault_root, followlinks=False):
        directory = Path(directory_name)
        retained: list[str] = []
        for name in sorted(directory_names, key=lambda item: (item.casefold(), item)):
            child = directory / name
            relative = PurePosixPath(child.relative_to(vault_root).as_posix())
            if child.is_symlink():
                diagnostics.append(
                    Diagnostic(
                        code="SOURCE_SYMLINK_DIRECTORY_IGNORED",
                        severity=Severity.WARNING,
                        message=f"symlink directory ignored: {relative.as_posix()}",
                        span=SourceSpan(child),
                    )
                )
                continue
            if _directory_is_ignored(relative, config.exclude):
                continue
            retained.append(name)
        directory_names[:] = retained

        for name in sorted(file_names, key=lambda item: (item.casefold(), item)):
            lexical = directory / name
            relative = PurePosixPath(lexical.relative_to(vault_root).as_posix())
            if lexical.suffix.casefold() != ".md" or relative.name.casefold().endswith(
                ".excalidraw.md"
            ):
                continue
            if _matches_any(relative, config.exclude):
                continue
            if lexical.is_symlink():
                diagnostics.append(
                    _path_error(
                        lexical,
                        "SOURCE_SYMLINK_IGNORED",
                        "symlink source files are not publishable",
                    )
                )
                continue
            try:
                resolved = lexical.resolve(strict=True)
            except OSError as exc:
                diagnostics.append(_path_error(lexical, "SOURCE_RESOLVE_FAILED", str(exc)))
                continue
            if not _is_relative_to(resolved, vault_root):
                diagnostics.append(
                    _path_error(
                        lexical,
                        "SOURCE_SYMLINK_ESCAPE",
                        "source resolves outside the vault and was ignored",
                    )
                )
                continue
            if not resolved.is_file():
                continue
            candidates.append(lexical)
    return sorted(candidates, key=lambda path: (path.as_posix().casefold(), path.as_posix()))


def _read_regular_source(path: Path, *, max_bytes: int) -> bytes:
    """Read one stable regular-file descriptor without following a final symlink."""

    before = os.lstat(path)
    if stat.S_ISLNK(before.st_mode) or not stat.S_ISREG(before.st_mode):
        raise _UnsafeSourcePathError("unsafe source type")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        if path.is_symlink():
            raise _UnsafeSourcePathError("source became a symlink") from exc
        raise
    try:
        opened = os.fstat(descriptor)
        current = os.lstat(path)
        if (
            not stat.S_ISREG(opened.st_mode)
            or stat.S_ISLNK(current.st_mode)
            or not stat.S_ISREG(current.st_mode)
            or (opened.st_dev, opened.st_ino) != (current.st_dev, current.st_ino)
        ):
            raise _UnsafeSourcePathError("source changed while opening")
        chunks: list[bytes] = []
        remaining = max_bytes + 1
        while remaining:
            chunk = os.read(descriptor, min(1024 * 1024, remaining))
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(descriptor)


def _directory_is_ignored(path: PurePosixPath, patterns: Sequence[str]) -> bool:
    if path.name in {".git", ".obsidian", ".md2conf", "__pycache__"}:
        return True
    text = path.as_posix()
    for pattern in patterns:
        prefix = pattern[:-3].rstrip("/") if pattern.endswith("/**") else None
        if prefix is not None and (text == prefix or text.startswith(f"{prefix}/")):
            return True
        if _glob_matches(path, pattern):
            return True
    return False


def _matches_any(path: PurePosixPath, patterns: Sequence[str]) -> bool:
    return any(_glob_matches(path, pattern) for pattern in patterns)


def _glob_matches(path: PurePosixPath, pattern: str) -> bool:
    if path.match(pattern):
        return True
    return pattern.startswith("**/") and path.match(pattern[3:])


def _consume_first_h1(body: str) -> tuple[str, str] | None:
    lines = body.splitlines(keepends=True)
    fence_character: str | None = None
    fence_length = 0
    for index, line in enumerate(lines):
        stripped = line.rstrip("\r\n")
        if fence_character is not None:
            candidate = stripped.lstrip(" \t")
            if candidate and set(candidate) == {fence_character} and len(candidate) >= fence_length:
                fence_character = None
            continue
        fence = _FENCE_OPEN.match(stripped)
        if fence is not None:
            marker = fence.group(1)
            fence_character = marker[0]
            fence_length = len(marker)
            continue
        heading = _ATX_H1.match(stripped)
        if heading is None:
            continue
        title = re.sub(r"[ \t]+#+[ \t]*$", "", heading.group(1)).strip()
        if not title:
            continue
        del lines[index]
        return title, "".join(lines)
    return None


def _duplicate_identity_diagnostics(documents: Sequence[SourceDocument]) -> list[Diagnostic]:
    diagnostics: list[Diagnostic] = []
    source_paths: defaultdict[str, list[str]] = defaultdict(list)
    page_paths: defaultdict[str, list[str]] = defaultdict(list)
    for document in documents:
        source_paths[document.identity.source_id].append(document.identity.relative_path)
        if document.frontmatter.page_id is not None:
            page_paths[document.frontmatter.page_id].append(document.identity.relative_path)
    for value, paths in sorted(source_paths.items()):
        if len(paths) > 1:
            diagnostics.append(
                Diagnostic(
                    code="DUPLICATE_SOURCE_ID",
                    severity=Severity.ERROR,
                    message=f"source ID {value} is used by: {', '.join(sorted(paths))}",
                )
            )
    for value, paths in sorted(page_paths.items()):
        if len(paths) > 1:
            diagnostics.append(
                Diagnostic(
                    code="DUPLICATE_PAGE_ID",
                    severity=Severity.ERROR,
                    message=f"page ID {value} is used by: {', '.join(sorted(paths))}",
                )
            )
    return diagnostics


def _case_colliding_path_diagnostics(
    documents: Sequence[SourceDocument],
) -> list[Diagnostic]:
    by_path: defaultdict[str, list[str]] = defaultdict(list)
    for document in documents:
        by_path[document.identity.relative_path.casefold()].append(document.identity.relative_path)
    return [
        Diagnostic(
            code="SOURCE_PATH_CASE_COLLISION",
            severity=Severity.ERROR,
            message=(
                f"source paths differ only by case and are not portable: {', '.join(sorted(paths))}"
            ),
        )
        for paths in by_path.values()
        if len(paths) > 1
    ]


def _source_set_digest(documents: Sequence[SourceDocument]) -> str:
    value = [
        {
            "source_id": document.identity.source_id,
            "path": document.identity.relative_path,
            "source_sha256": document.source_sha256,
        }
        for document in documents
    ]
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _scope_fingerprint(namespace: UUID, config: SourceConfig) -> str:
    value = {
        "vault_id": str(namespace),
        "publish_root": config.publish_root_relative.as_posix(),
        "include": list(config.include),
        "exclude": list(config.exclude),
    }
    encoded = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(encoded.encode("utf-8")).hexdigest()


def _selected_source_ids(
    documents: Sequence[SourceDocument],
    selection: Selection,
    vault_root: Path,
    diagnostics: list[Diagnostic],
) -> frozenset[str]:
    if not selection.paths:
        return frozenset(item.identity.source_id for item in documents)
    requested: list[Path] = []
    for item in selection.paths:
        candidate = item if item.is_absolute() else vault_root / item
        resolved = candidate.resolve(strict=False)
        if not _is_relative_to(resolved, vault_root):
            diagnostics.append(
                Diagnostic(
                    code="SELECTION_OUTSIDE_VAULT",
                    severity=Severity.ERROR,
                    message=f"selected path is outside the vault: {item}",
                )
            )
            continue
        requested.append(resolved)
    selected: set[str] = set()
    for document in documents:
        document_path = document.absolute_path.resolve(strict=False)
        if any(document_path == item or _is_relative_to(document_path, item) for item in requested):
            selected.add(document.identity.source_id)
    for item in requested:
        if not any(
            document.absolute_path.resolve(strict=False) == item
            or _is_relative_to(document.absolute_path.resolve(strict=False), item)
            for document in documents
        ):
            diagnostics.append(
                Diagnostic(
                    code="SELECTION_NOT_PUBLISHABLE",
                    severity=Severity.WARNING,
                    message=f"selected path contains no publishable source: {item}",
                )
            )
    return frozenset(selected)


def _path_error(path: Path, code: str, message: str) -> Diagnostic:
    return Diagnostic(
        code=code,
        severity=Severity.ERROR,
        message=" ".join(message.splitlines())[:300],
        span=SourceSpan(path),
    )


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
