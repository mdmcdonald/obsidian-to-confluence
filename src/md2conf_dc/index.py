"""Global title calculation and final-title-aware link resolution."""

from __future__ import annotations

import hashlib
import posixpath
import unicodedata
from collections import defaultdict
from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from pathlib import PurePosixPath
from types import MappingProxyType
from urllib.parse import unquote, urlsplit

from md2conf_dc.models import (
    Diagnostic,
    FolderNode,
    ResolvedLink,
    Severity,
    SourceDocument,
    SourceSpan,
)


@dataclass(frozen=True, slots=True)
class LinkResolution:
    link: ResolvedLink
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def resolved(self) -> bool:
        return self.link.target_source_id is not None or self.link.external_url is not None


@dataclass(frozen=True, slots=True)
class ManagedLabel:
    value: str
    facet: str
    source_value: str


@dataclass(frozen=True, slots=True)
class ManagedLabelSet:
    labels: tuple[ManagedLabel, ...]
    diagnostics: tuple[Diagnostic, ...] = ()

    @property
    def values(self) -> tuple[str, ...]:
        return tuple(item.value for item in self.labels)


@dataclass(frozen=True, slots=True)
class CorpusIndex:
    final_titles: Mapping[str, str]
    path_to_source_id: Mapping[str, str]
    basename_to_source_ids: Mapping[str, tuple[str, ...]]
    metadata_id_to_source_id: Mapping[str, str]
    diagnostics: tuple[Diagnostic, ...]
    _documents: Mapping[str, SourceDocument]

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)

    def resolve_link(
        self, source_id: str, target: str, *, label: str | None = None
    ) -> LinkResolution:
        """Resolve Markdown/Obsidian targets using relative-path-first semantics."""

        source = self._documents.get(source_id)
        if source is None:
            raise KeyError(f"unknown source ID: {source_id}")
        raw_target, embedded_label = _split_alias(target)
        display_label = label or embedded_label or raw_target
        if not raw_target:
            return LinkResolution(
                ResolvedLink(label=display_label, target_source_id=None, target_title=None),
                (
                    Diagnostic(
                        code="LINK_EMPTY",
                        severity=Severity.WARNING,
                        message="empty links are not publishable",
                        span=SourceSpan(source.absolute_path),
                    ),
                ),
            )
        parsed_url = urlsplit(raw_target)
        if parsed_url.scheme or parsed_url.netloc:
            if parsed_url.scheme.casefold() not in {"http", "https", "mailto"}:
                return LinkResolution(
                    ResolvedLink(
                        label=display_label,
                        target_source_id=None,
                        target_title=None,
                    ),
                    (
                        Diagnostic(
                            code="LINK_SCHEME_UNSAFE",
                            severity=Severity.ERROR,
                            message=f"unsupported external link scheme in {raw_target!r}",
                            span=SourceSpan(source.absolute_path),
                        ),
                    ),
                )
            return LinkResolution(
                ResolvedLink(
                    label=display_label,
                    target_source_id=None,
                    target_title=None,
                    external_url=raw_target,
                )
            )

        path_part, anchor = _split_anchor(raw_target)
        if not path_part:
            return LinkResolution(
                ResolvedLink(
                    label=display_label,
                    target_source_id=source_id,
                    target_title=self.final_titles[source_id],
                    anchor=anchor,
                )
            )
        decoded = unquote(path_part)
        if "\x00" in decoded or "\\" in decoded:
            return _unresolved(display_label, target, "link contains an unsafe path")
        source_parent = PurePosixPath(source.identity.relative_path).parent
        if decoded.startswith("/"):
            normalized = posixpath.normpath(decoded.lstrip("/"))
        else:
            normalized = posixpath.normpath((source_parent / decoded).as_posix())
        if normalized == ".." or normalized.startswith("../"):
            return _unresolved(display_label, target, "link escapes the vault")
        candidates = [normalized]
        if not PurePosixPath(normalized).suffix:
            candidates.append(f"{normalized}.md")
        target_id = next(
            (self.path_to_source_id[item] for item in candidates if item in self.path_to_source_id),
            None,
        )
        if target_id is None:
            basename = PurePosixPath(decoded).name
            basename = basename[:-3] if basename.casefold().endswith(".md") else basename
            matches = self.basename_to_source_ids.get(_title_key(basename), ())
            if len(matches) == 1:
                target_id = matches[0]
            elif len(matches) > 1:
                return _unresolved(display_label, target, "link basename is ambiguous")
        if target_id is None:
            return _unresolved(display_label, target, "link target is not published")
        return LinkResolution(
            ResolvedLink(
                label=display_label,
                target_source_id=target_id,
                target_title=self.final_titles[target_id],
                anchor=anchor,
            )
        )

    def resolve_relationship(self, source_id: str, value: str) -> LinkResolution:
        """Resolve a Page Properties relationship by wikilink, metadata ID, or path."""

        candidate = value.strip()
        if candidate.startswith("[[") and candidate.endswith("]]"):
            candidate = candidate[2:-2].strip()
        metadata_target = self.metadata_id_to_source_id.get(_title_key(candidate))
        if metadata_target is not None:
            return LinkResolution(
                ResolvedLink(
                    label=value,
                    target_source_id=metadata_target,
                    target_title=self.final_titles[metadata_target],
                )
            )
        resolution = self.resolve_link(source_id, candidate, label=value)
        if resolution.resolved:
            return resolution
        source = self._documents[source_id]
        return LinkResolution(
            ResolvedLink(label=value, target_source_id=None, target_title=None),
            (
                Diagnostic(
                    code="RELATIONSHIP_UNRESOLVED",
                    severity=Severity.WARNING,
                    message=(
                        f"relationship value remains text because it did not resolve: {value!r}"
                    ),
                    span=SourceSpan(source.absolute_path),
                ),
            ),
        )


def build_index(
    documents: Sequence[SourceDocument],
    *,
    folders: Sequence[FolderNode] = (),
    deduplicate_titles: bool = True,
) -> CorpusIndex:
    """Compute every effective title before any page is rendered."""

    diagnostics: list[Diagnostic] = []
    document_by_id = {item.identity.source_id: item for item in documents}
    candidates = {
        item.identity.source_id: (item.title_candidate.strip(), item.identity.relative_path)
        for item in documents
    }
    folder_aliases: dict[str, str] = {}
    landing_ids = {item.landing_source_id for item in folders if item.landing_source_id is not None}
    for folder in folders:
        page_source_id = folder.landing_source_id or folder.identity.source_id
        candidates[page_source_id] = (folder.final_title.strip(), folder.relative_path)
        folder_aliases[folder.identity.source_id] = page_source_id
    for _source_id, (title, path) in candidates.items():
        if not title:
            diagnostics.append(
                Diagnostic(
                    code="TITLE_EMPTY",
                    severity=Severity.ERROR,
                    message=f"source {path} has an empty effective title",
                )
            )

    groups: defaultdict[str, list[str]] = defaultdict(list)
    for source_id, (title, _) in candidates.items():
        groups[_title_key(title)].append(source_id)
    final_titles = {
        source_id: _bounded_title(title) for source_id, (title, _) in candidates.items()
    }
    for source_ids in groups.values():
        if len(source_ids) < 2:
            continue
        paths = sorted(candidates[source_id][1] for source_id in source_ids)
        if not deduplicate_titles:
            diagnostics.append(
                Diagnostic(
                    code="TITLE_COLLISION",
                    severity=Severity.ERROR,
                    message=f"duplicate effective title is used by: {', '.join(paths)}",
                    hint="Enable deduplicate_titles or choose explicit connie-title values",
                )
            )
            continue
        for source_id in source_ids:
            title, path = candidates[source_id]
            suffix = hashlib.sha256(path.encode("utf-8")).hexdigest()[:8]
            renamed = _bounded_title(f"{title} — {suffix}")
            final_titles[source_id] = renamed
            diagnostics.append(
                Diagnostic(
                    code="TITLE_DEDUPLICATED",
                    severity=Severity.WARNING,
                    message=f"renamed {path!r} from {title!r} to {renamed!r}",
                )
            )
    for folder_id, page_source_id in folder_aliases.items():
        final_titles[folder_id] = final_titles[page_source_id]

    path_to_source_id = {item.identity.relative_path: item.identity.source_id for item in documents}
    basename: defaultdict[str, list[str]] = defaultdict(list)
    for document in documents:
        basename[_title_key(PurePosixPath(document.identity.relative_path).stem)].append(
            document.identity.source_id
        )
    basename_frozen = {key: tuple(sorted(values)) for key, values in sorted(basename.items())}
    metadata_ids: defaultdict[str, list[SourceDocument]] = defaultdict(list)
    for document in documents:
        metadata_id = document.frontmatter.metadata.get("id")
        if metadata_id is None:
            continue
        if not isinstance(metadata_id, str) or not metadata_id.strip():
            diagnostics.append(
                Diagnostic(
                    code="METADATA_ID_INVALID",
                    severity=Severity.ERROR,
                    message="frontmatter id must be a non-empty string",
                    span=SourceSpan(document.absolute_path),
                )
            )
            continue
        metadata_ids[_title_key(metadata_id)].append(document)
    metadata_id_to_source_id: dict[str, str] = {}
    for metadata_id, matches in metadata_ids.items():
        if len(matches) > 1:
            diagnostics.append(
                Diagnostic(
                    code="METADATA_ID_DUPLICATE",
                    severity=Severity.ERROR,
                    message=(
                        f"frontmatter id {metadata_id!r} is used by: "
                        + ", ".join(sorted(item.identity.relative_path for item in matches))
                    ),
                )
            )
            continue
        metadata_id_to_source_id[metadata_id] = matches[0].identity.source_id
    # Landing IDs are intentionally still indexed by their source path, while synthetic
    # folders have no Markdown path and therefore cannot be a direct Markdown link target.
    del landing_ids
    return CorpusIndex(
        final_titles=MappingProxyType(final_titles),
        path_to_source_id=MappingProxyType(path_to_source_id),
        basename_to_source_ids=MappingProxyType(basename_frozen),
        metadata_id_to_source_id=MappingProxyType(metadata_id_to_source_id),
        diagnostics=tuple(diagnostics),
        _documents=MappingProxyType(document_by_id),
    )


def build_managed_labels(
    document: SourceDocument,
    *,
    taxonomy_fields: Sequence[str] = ("subject", "type"),
    maximum_length: int = 255,
) -> ManagedLabelSet:
    """Normalize author tags and taxonomy fields while retaining provenance."""

    if maximum_length <= 0:
        raise ValueError("maximum_length must be positive")
    raw: list[tuple[str, str]] = [("tag", value) for value in document.frontmatter.tags]
    for facet in taxonomy_fields:
        value = document.frontmatter.metadata.get(facet)
        if facet == "type" and value is None:
            value = document.frontmatter.metadata.get("document_type")
        if value is None:
            continue
        values: Sequence[object] = value if isinstance(value, (list, tuple)) else (value,)
        for item in values:
            if not isinstance(item, str):
                raw.append((facet, ""))
            else:
                raw.append((facet, item))

    diagnostics: list[Diagnostic] = []
    by_value: dict[str, ManagedLabel] = {}
    provenance: defaultdict[str, list[tuple[str, str]]] = defaultdict(list)
    for facet, source_value in raw:
        normalized = _normalize_label(source_value, maximum_length=maximum_length)
        if not normalized:
            diagnostics.append(
                Diagnostic(
                    code="LABEL_VALUE_INVALID",
                    severity=Severity.WARNING,
                    message=f"{facet} value cannot produce a usable Confluence label",
                    span=SourceSpan(document.absolute_path),
                )
            )
            continue
        provenance[normalized].append((facet, source_value))
        by_value.setdefault(normalized, ManagedLabel(normalized, facet, source_value))
    for normalized, sources in provenance.items():
        if len(set(sources)) > 1:
            diagnostics.append(
                Diagnostic(
                    code="LABEL_NORMALIZATION_COLLISION",
                    severity=Severity.WARNING,
                    message=(
                        f"multiple frontmatter values normalize to label {normalized!r}: "
                        + ", ".join(repr(value) for _, value in sources)
                    ),
                    span=SourceSpan(document.absolute_path),
                )
            )
    return ManagedLabelSet(
        labels=tuple(by_value[key] for key in sorted(by_value)),
        diagnostics=tuple(diagnostics),
    )


def _unresolved(label: str, target: str, reason: str) -> LinkResolution:
    return LinkResolution(
        ResolvedLink(label=label, target_source_id=None, target_title=None),
        (
            Diagnostic(
                code="LINK_UNRESOLVED",
                severity=Severity.WARNING,
                message=f"could not resolve {target!r}: {reason}",
            ),
        ),
    )


def _split_alias(target: str) -> tuple[str, str | None]:
    if "|" not in target:
        return target.strip(), None
    raw, alias = target.rsplit("|", 1)
    return raw.strip(), alias.strip() or None


def _split_anchor(target: str) -> tuple[str, str | None]:
    if "#" not in target:
        return target, None
    path, anchor = target.split("#", 1)
    return path, anchor or None


def _title_key(value: str) -> str:
    return unicodedata.normalize("NFC", value).strip().casefold()


def _bounded_title(value: str, maximum: int = 255) -> str:
    normalized = unicodedata.normalize("NFC", value).strip()
    return normalized if len(normalized) <= maximum else normalized[:maximum].rstrip()


def _normalize_label(value: str, *, maximum_length: int) -> str:
    text = unicodedata.normalize("NFC", value).strip().strip("\"'")
    # Preserve the legacy taxonomy convention where a leading namespace is display
    # context rather than part of the Confluence label itself.
    if ":" in text:
        namespace, remainder = text.split(":", 1)
        if namespace and namespace[0].isalpha() and namespace.replace("-", "").isalnum():
            text = remainder
    result: list[str] = []
    separator_pending = False
    for character in text.casefold():
        if character.isalnum():
            if separator_pending and result:
                result.append("-")
            result.append(character)
            separator_pending = False
        else:
            separator_pending = True
    return "".join(result)[:maximum_length].rstrip("-")
