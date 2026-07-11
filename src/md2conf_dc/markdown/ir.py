"""Closed, source-positioned intermediate representation for supported Markdown.

The renderer exhaustively handles this union.  Unknown markdown-it tokens become an
``UnsupportedBlock`` instead of silently rendering their children, which is important
for safe publishing and useful GUI diagnostics.
"""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum

from md2conf_dc.models import SourceSpan


class BreakKind(StrEnum):
    SOFT = "soft"
    HARD = "hard"


class ListKind(StrEnum):
    BULLET = "bullet"
    ORDERED = "ordered"


class MacroName(StrEnum):
    TOC = "toc"
    CHILDREN = "children"
    PAGE_TREE = "page-tree"
    STATUS = "status"
    EXPAND = "expand"
    EXCERPT = "excerpt"
    EXCERPT_INCLUDE = "excerpt-include"
    PAGE_PROPERTIES = "page-properties"
    PAGE_PROPERTIES_REPORT = "page-properties-report"
    CONTENT_BY_LABEL = "content-by-label"
    ANCHOR = "anchor"
    INFO = "info"
    NOTE = "note"
    TIP = "tip"
    WARNING = "warning"
    LAYOUT = "layout"


@dataclass(frozen=True, slots=True)
class Text:
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Emphasis:
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Strong:
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Strike:
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Highlight:
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class InlineCode:
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class InlineMath:
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Break:
    kind: BreakKind
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Link:
    destination: str
    children: tuple[Inline, ...]
    title: str | None
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class WikiLink:
    target: str
    alias: str | None
    heading: str | None
    block_id: str | None
    embed: bool
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Image:
    source: str
    alt_text: str
    title: str | None
    width: int | None
    height: int | None
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class RawHtml:
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class UnsupportedInline:
    token_type: str
    source: str
    span: SourceSpan


Inline = (
    Text
    | Emphasis
    | Strong
    | Strike
    | Highlight
    | InlineCode
    | InlineMath
    | Break
    | Link
    | WikiLink
    | Image
    | RawHtml
    | UnsupportedInline
)


@dataclass(frozen=True, slots=True)
class Paragraph:
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Heading:
    level: int
    children: tuple[Inline, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class HorizontalRule:
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class BlockQuote:
    children: tuple[Block, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class ListItem:
    children: tuple[Block, ...]
    task_checked: bool | None
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class ListBlock:
    kind: ListKind
    items: tuple[ListItem, ...]
    start: int
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class TaskList:
    items: tuple[ListItem, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class CodeBlock:
    value: str
    language: str | None
    fenced: bool
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class MathBlock:
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class TableCell:
    children: tuple[Inline, ...]
    header: bool
    alignment: str | None
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class TableRow:
    cells: tuple[TableCell, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Table:
    rows: tuple[TableRow, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Callout:
    kind: str
    title: str | None
    collapsible: bool
    initially_open: bool
    body: tuple[Block, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class DirectiveParameter:
    name: str
    value: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Directive:
    name: MacroName
    parameters: tuple[DirectiveParameter, ...]
    body: tuple[Block, ...]
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class Anchor:
    name: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class UnsupportedBlock:
    token_type: str
    source: str
    span: SourceSpan


Block = (
    Paragraph
    | Heading
    | HorizontalRule
    | BlockQuote
    | ListBlock
    | TaskList
    | CodeBlock
    | MathBlock
    | Table
    | Callout
    | Directive
    | Anchor
    | UnsupportedBlock
)


@dataclass(frozen=True, slots=True)
class Document:
    blocks: tuple[Block, ...]
    span: SourceSpan
