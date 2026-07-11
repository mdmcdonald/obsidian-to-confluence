"""Typed page-decoration policies with no storage/XML injection surface."""

from __future__ import annotations

import re
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import date, datetime
from math import isfinite
from typing import Protocol, Self, runtime_checkable

from md2conf_dc.markdown.ir import (
    Block,
    Directive,
    Document,
    Heading,
    MacroName,
    Paragraph,
    Table,
    TableCell,
    TableRow,
    Text,
)
from md2conf_dc.models import Diagnostic, RenderContext, Severity

MetadataScalar = str | int | float | bool | date | datetime


@dataclass(frozen=True, slots=True)
class MetadataValue:
    text: str

    @classmethod
    def from_scalar(cls, value: MetadataScalar) -> Self:
        if isinstance(value, bool):
            return cls("true" if value else "false")
        if isinstance(value, (date, datetime)):
            return cls(value.isoformat())
        if isinstance(value, float):
            if not isfinite(value):
                raise ValueError("metadata numbers must be finite")
            return cls(format(value, ".15g"))
        return cls(str(value))


@dataclass(frozen=True, slots=True)
class MetadataField:
    label: str
    values: tuple[MetadataValue, ...]

    @classmethod
    def scalar(cls, label: str, value: MetadataScalar) -> Self:
        return cls(label, (MetadataValue.from_scalar(value),))


@dataclass(frozen=True, slots=True)
class MetadataDecorationResult:
    document: Document
    diagnostics: tuple[Diagnostic, ...]
    included: bool


def decorate_with_metadata(
    document: Document,
    fields: Sequence[MetadataField],
    *,
    max_fields: int = 100,
) -> MetadataDecorationResult:
    """Prepend a typed Page Properties table, or leave an empty set visually quiet."""

    if not fields:
        return MetadataDecorationResult(document, (), False)
    diagnostics: list[Diagnostic] = []
    if len(fields) > max_fields:
        diagnostics.append(
            Diagnostic(
                "METADATA_FIELD_LIMIT",
                Severity.ERROR,
                f"Metadata has {len(fields)} fields; the configured limit is {max_fields}.",
                document.span,
            )
        )
        return MetadataDecorationResult(document, tuple(diagnostics), False)

    rows: list[TableRow] = []
    seen: set[str] = set()
    for field in fields:
        label = field.label.strip()
        if not label:
            diagnostics.append(
                Diagnostic(
                    "METADATA_EMPTY_LABEL",
                    Severity.ERROR,
                    "Metadata field labels must not be empty.",
                    document.span,
                )
            )
            continue
        folded = label.casefold()
        if folded in seen:
            diagnostics.append(
                Diagnostic(
                    "METADATA_DUPLICATE_LABEL",
                    Severity.ERROR,
                    f"Metadata field label is duplicated: {label}",
                    document.span,
                )
            )
            continue
        seen.add(folded)
        readable_values = tuple(value for value in field.values if value.text.strip())
        if not readable_values:
            continue
        value_nodes: list[Text] = []
        for index, value in enumerate(readable_values):
            if index:
                value_nodes.append(Text(", ", document.span))
            value_nodes.append(Text(value.text, document.span))
        rows.append(
            TableRow(
                (
                    TableCell((Text(label, document.span),), False, None, document.span),
                    TableCell(tuple(value_nodes), False, None, document.span),
                ),
                document.span,
            )
        )
    if not rows:
        return MetadataDecorationResult(document, tuple(diagnostics), False)
    table = Table(tuple(rows), document.span)
    details = Directive(MacroName.PAGE_PROPERTIES, (), (table,), document.span)
    decorated = Document((details, *document.blocks), document.span)
    return MetadataDecorationResult(decorated, tuple(diagnostics), True)


@dataclass(frozen=True, slots=True)
class PolicyResult:
    document: Document
    diagnostics: tuple[Diagnostic, ...] = ()


@runtime_checkable
class PagePolicy(Protocol):
    @property
    def identity(self) -> str: ...

    def decorate(self, document: Document, *, context: RenderContext) -> PolicyResult: ...


@dataclass(frozen=True, slots=True)
class MinimalPolicy:
    @property
    def identity(self) -> str:
        return "builtin:minimal:v1"

    def decorate(self, document: Document, *, context: RenderContext) -> PolicyResult:
        del context
        return PolicyResult(document)


@dataclass(frozen=True, slots=True)
class TechnicalDocumentPolicy:
    toc_heading_threshold: int = 2

    @property
    def identity(self) -> str:
        return f"builtin:technical-doc:v1:toc={self.toc_heading_threshold}"

    def decorate(self, document: Document, *, context: RenderContext) -> PolicyResult:
        del context
        if _heading_count(document.blocks) < self.toc_heading_threshold or _has_toc(document):
            return PolicyResult(document)
        toc = Directive(MacroName.TOC, (), (), document.span)
        return PolicyResult(Document((toc, *document.blocks), document.span))


@dataclass(frozen=True, slots=True)
class KnowledgeBasePolicy:
    toc_heading_threshold: int = 3
    toc_word_threshold: int = 500

    @property
    def identity(self) -> str:
        return (
            "builtin:knowledge-base:v1:"
            f"headings={self.toc_heading_threshold}:words={self.toc_word_threshold}"
        )

    def decorate(self, document: Document, *, context: RenderContext) -> PolicyResult:
        del context
        should_add = _heading_count(document.blocks) >= self.toc_heading_threshold or (
            _word_count(document.blocks) >= self.toc_word_threshold
        )
        if not should_add or _has_toc(document):
            return PolicyResult(document)
        toc = Directive(MacroName.TOC, (), (), document.span)
        return PolicyResult(Document((toc, *document.blocks), document.span))


@dataclass(frozen=True, slots=True)
class PolicyResolution:
    policy: PagePolicy | None
    diagnostics: tuple[Diagnostic, ...]


def resolve_policy(name: str) -> PolicyResolution:
    policies: dict[str, PagePolicy] = {
        "minimal": MinimalPolicy(),
        "technical-doc": TechnicalDocumentPolicy(),
        "knowledge-base": KnowledgeBasePolicy(),
    }
    policy = policies.get(name)
    if policy is not None:
        return PolicyResolution(policy, ())
    return PolicyResolution(
        None,
        (
            Diagnostic(
                "POLICY_UNKNOWN",
                Severity.ERROR,
                f"Unknown page policy: {name}",
            ),
        ),
    )


def _heading_count(blocks: tuple[Block, ...]) -> int:
    return sum(isinstance(block, Heading) for block in blocks)


def _word_count(blocks: tuple[Block, ...]) -> int:
    values: list[str] = []
    for block in blocks:
        if isinstance(block, (Paragraph, Heading)):
            values.extend(node.value for node in block.children if isinstance(node, Text))
    return len(re.findall(r"\w+", " ".join(values), re.UNICODE))


def _has_toc(document: Document) -> bool:
    return any(
        isinstance(block, Directive) and block.name is MacroName.TOC for block in document.blocks
    )
