"""Parse CommonMark/GFM and Obsidian syntax into the closed semantic IR."""

from __future__ import annotations

import re
import shlex
from dataclasses import dataclass
from pathlib import Path

from markdown_it import MarkdownIt
from markdown_it.rules_block import StateBlock
from markdown_it.token import Token
from markdown_it.tree import SyntaxTreeNode
from mdit_py_plugins.dollarmath import dollarmath_plugin

from md2conf_dc.markdown.ir import (
    Anchor,
    Block,
    BlockQuote,
    Break,
    BreakKind,
    Callout,
    CodeBlock,
    Directive,
    DirectiveParameter,
    Document,
    Emphasis,
    Heading,
    Highlight,
    HorizontalRule,
    Image,
    Inline,
    InlineCode,
    InlineMath,
    Link,
    ListBlock,
    ListItem,
    ListKind,
    MacroName,
    MathBlock,
    Paragraph,
    RawHtml,
    Strike,
    Strong,
    Table,
    TableCell,
    TableRow,
    TaskList,
    Text,
    UnsupportedBlock,
    UnsupportedInline,
)
from md2conf_dc.markdown.obsidian import extract_block_id, plain_text, remove_task_marker
from md2conf_dc.markdown.obsidian import transform_text as transform_obsidian_text
from md2conf_dc.models import Diagnostic, Severity, SourceSpan

_DIRECTIVE_OPEN = re.compile(
    r"^ {0,3}:::\s+confluence:(?P<name>[a-z][a-z0-9-]*)\s*(?P<attrs>\{.*\})?\s*$"
)
_DIRECTIVE_CLOSE = re.compile(r"^ {0,3}:::\s*$")
_FENCE = re.compile(r"^ {0,3}(?P<marker>`{3,}|~{3,})")
_CALLOUT = re.compile(
    r"^\[!(?P<kind>[A-Za-z][A-Za-z0-9_-]*)\](?P<fold>[+-])?(?:\s+(?P<title>.*))?$"
)
_MAX_PARSE_DIRECTIVE_DEPTH = 32


@dataclass(frozen=True, slots=True)
class ParseResult:
    document: Document
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


class _Converter:
    def __init__(self, *, path: Path, line_offset: int, directive_depth: int) -> None:
        self.path = path
        self.line_offset = line_offset
        self.directive_depth = directive_depth
        self.diagnostics: list[Diagnostic] = []

    def span(self, node: SyntaxTreeNode, *, fallback_line: int = 1) -> SourceSpan:
        line_map = node.map
        if line_map is None:
            line = fallback_line + self.line_offset
            return SourceSpan(self.path, line=line, column=1, end_line=line)
        return SourceSpan(
            self.path,
            line=line_map[0] + 1 + self.line_offset,
            column=1,
            end_line=line_map[1] + self.line_offset,
        )

    def blocks(self, nodes: list[SyntaxTreeNode]) -> tuple[Block, ...]:
        result: list[Block] = []
        for node in nodes:
            converted = self.block(node)
            if converted is None:
                continue
            result.append(converted)
            if isinstance(converted, (Paragraph, Heading)):
                children, block_id = extract_block_id(converted.children)
                if block_id is not None:
                    if isinstance(converted, Paragraph):
                        result[-1] = Paragraph(children, converted.span)
                    else:
                        result[-1] = Heading(converted.level, children, converted.span)
                    result.append(Anchor(block_id, converted.span))
        return tuple(result)

    def block(self, node: SyntaxTreeNode) -> Block | None:
        span = self.span(node)
        if node.type == "paragraph":
            return Paragraph(self._inline_container(node), span)
        if node.type == "heading":
            return Heading(int(node.tag[1:]), self._inline_container(node), span)
        if node.type == "hr":
            return HorizontalRule(span)
        if node.type == "blockquote":
            body = self.blocks(node.children)
            return self._callout_or_quote(body, span)
        if node.type in {"bullet_list", "ordered_list"}:
            return self._list(node, span)
        if node.type in {"fence", "code_block"}:
            language = node.info.strip().split(maxsplit=1)[0] if node.info.strip() else None
            return CodeBlock(node.content, language, node.type == "fence", span)
        if node.type == "math_block":
            return MathBlock(node.content.strip(), span)
        if node.type == "table":
            return self._table(node, span)
        if node.type == "html_block":
            return Paragraph((RawHtml(node.content, span),), span)
        if node.type == "confluence_directive":
            return self._directive(node, span)
        if node.type in {"thead", "tbody", "tr", "th", "td"}:
            return None
        self.diagnostics.append(
            Diagnostic(
                "MD_UNSUPPORTED_BLOCK",
                Severity.ERROR,
                f"Unsupported Markdown block token: {node.type}",
                span,
            )
        )
        return UnsupportedBlock(node.type, node.content, span)

    def _inline_container(self, node: SyntaxTreeNode) -> tuple[Inline, ...]:
        if not node.children:
            return ()
        inline = node.children[0]
        if inline.type != "inline":
            self.diagnostics.append(
                Diagnostic(
                    "MD_EXPECTED_INLINE",
                    Severity.ERROR,
                    f"Expected inline content, found {inline.type}.",
                    self.span(inline),
                )
            )
            return ()
        return self.inlines(inline.children, self.span(node).line or 1)

    def inlines(self, nodes: list[SyntaxTreeNode], fallback_line: int) -> tuple[Inline, ...]:
        result: list[Inline] = []
        for node in nodes:
            span = self.span(node, fallback_line=fallback_line - self.line_offset)
            if node.type == "text":
                transformed = transform_obsidian_text(node.content, span=span)
                result.extend(transformed.nodes)
                self.diagnostics.extend(transformed.diagnostics)
            elif node.type == "em":
                result.append(Emphasis(self.inlines(node.children, fallback_line), span))
            elif node.type == "strong":
                result.append(Strong(self.inlines(node.children, fallback_line), span))
            elif node.type == "s":
                result.append(Strike(self.inlines(node.children, fallback_line), span))
            elif node.type == "code_inline":
                result.append(InlineCode(node.content, span))
            elif node.type == "math_inline":
                result.append(InlineMath(node.content, span))
            elif node.type in {"softbreak", "hardbreak"}:
                kind = BreakKind.HARD if node.type == "hardbreak" else BreakKind.SOFT
                result.append(Break(kind, span))
            elif node.type == "link":
                result.append(
                    Link(
                        str(node.attrs.get("href", "")),
                        self.inlines(node.children, fallback_line),
                        _optional_attr(node, "title"),
                        span,
                    )
                )
            elif node.type == "image":
                width = _positive_int(node.attrs.get("width"))
                height = _positive_int(node.attrs.get("height"))
                result.append(
                    Image(
                        str(node.attrs.get("src", "")),
                        node.content,
                        _optional_attr(node, "title"),
                        width,
                        height,
                        span,
                    )
                )
            elif node.type == "html_inline":
                result.append(RawHtml(node.content, span))
            else:
                self.diagnostics.append(
                    Diagnostic(
                        "MD_UNSUPPORTED_INLINE",
                        Severity.ERROR,
                        f"Unsupported Markdown inline token: {node.type}",
                        span,
                    )
                )
                result.append(UnsupportedInline(node.type, node.content, span))
        return _strip_multiline_comment_runs(tuple(result))

    def _list(self, node: SyntaxTreeNode, span: SourceSpan) -> Block:
        items: list[ListItem] = []
        for child in node.children:
            if child.type != "list_item":
                continue
            item_span = self.span(child)
            blocks = list(self.blocks(child.children))
            checked: bool | None = None
            if blocks and isinstance(blocks[0], Paragraph):
                checked, children = remove_task_marker(blocks[0].children)
                if checked is not None:
                    blocks[0] = Paragraph(children, blocks[0].span)
            items.append(ListItem(tuple(blocks), checked, item_span))
        if items and all(item.task_checked is not None for item in items):
            return TaskList(tuple(items), span)
        kind = ListKind.ORDERED if node.type == "ordered_list" else ListKind.BULLET
        start = _positive_int(node.attrs.get("start")) or 1
        return ListBlock(kind, tuple(items), start, span)

    def _table(self, node: SyntaxTreeNode, span: SourceSpan) -> Table:
        rows: list[TableRow] = []
        for section in node.children:
            for row in section.children:
                if row.type != "tr":
                    continue
                cells: list[TableCell] = []
                for cell in row.children:
                    if cell.type not in {"th", "td"}:
                        continue
                    style = str(cell.attrs.get("style", ""))
                    alignment = None
                    match = re.search(r"text-align:\s*(left|right|center)", style)
                    if match:
                        alignment = match.group(1)
                    cells.append(
                        TableCell(
                            self._inline_container(cell),
                            cell.type == "th",
                            alignment,
                            self.span(cell, fallback_line=span.line or 1),
                        )
                    )
                rows.append(TableRow(tuple(cells), self.span(row)))
        return Table(tuple(rows), span)

    def _callout_or_quote(self, body: tuple[Block, ...], span: SourceSpan) -> Block:
        if not body or not isinstance(body[0], Paragraph):
            return BlockQuote(body, span)
        first = body[0]
        line_nodes: list[Inline] = []
        remainder: list[Inline] = []
        saw_break = False
        for inline in first.children:
            if isinstance(inline, Break) and not saw_break:
                saw_break = True
                continue
            (remainder if saw_break else line_nodes).append(inline)
        match = _CALLOUT.fullmatch(plain_text(tuple(line_nodes)).strip())
        if match is None:
            return BlockQuote(body, span)
        remaining_blocks = list(body[1:])
        if remainder:
            remaining_blocks.insert(0, Paragraph(tuple(remainder), first.span))
        fold = match.group("fold")
        return Callout(
            match.group("kind").casefold(),
            match.group("title") or None,
            fold is not None,
            fold != "-",
            tuple(remaining_blocks),
            span,
        )

    def _directive(self, node: SyntaxTreeNode, span: SourceSpan) -> Block:
        name_value = str(node.meta.get("name", ""))
        try:
            name = MacroName(name_value)
        except ValueError:
            self.diagnostics.append(
                Diagnostic(
                    "MD_UNKNOWN_DIRECTIVE",
                    Severity.ERROR,
                    f"Unknown Confluence directive: {name_value or '<empty>'}",
                    span,
                )
            )
            return UnsupportedBlock("confluence_directive", node.content, span)

        parameter_result = _parse_parameters(
            str(node.meta.get("attrs", "")),
            span=span,
            attribute_column=int(node.meta.get("attribute_column", span.column or 1)),
            diagnostics=self.diagnostics,
        )
        if self.directive_depth >= _MAX_PARSE_DIRECTIVE_DEPTH:
            self.diagnostics.append(
                Diagnostic(
                    "MD_DIRECTIVE_DEPTH_LIMIT",
                    Severity.ERROR,
                    (
                        "Nested Confluence directives exceed the parser safety limit "
                        f"of {_MAX_PARSE_DIRECTIVE_DEPTH}"
                    ),
                    span,
                )
            )
            return UnsupportedBlock("confluence_directive_depth", "", span)
        body_start = int(node.meta.get("body_start", 0))
        nested = _parse(
            node.content,
            path=self.path,
            line_offset=self.line_offset + body_start,
            directive_depth=self.directive_depth + 1,
        )
        self.diagnostics.extend(nested.diagnostics)
        if bool(node.meta.get("unclosed")):
            self.diagnostics.append(
                Diagnostic(
                    "MD_UNCLOSED_DIRECTIVE",
                    Severity.ERROR,
                    f"Directive confluence:{name.value} has no closing ::: marker.",
                    span,
                )
            )
        return Directive(name, parameter_result, nested.document.blocks, span)


def parse_markdown(source: str, *, path: Path) -> ParseResult:
    """Parse one source string without filesystem or presentation side effects."""

    return _parse(source, path=path, line_offset=0, directive_depth=0)


def _parse(
    source: str,
    *,
    path: Path,
    line_offset: int,
    directive_depth: int,
) -> ParseResult:
    parser = _markdown_parser()
    tokens = parser.parse(source)
    root = SyntaxTreeNode(tokens)
    converter = _Converter(
        path=path,
        line_offset=line_offset,
        directive_depth=directive_depth,
    )
    blocks = converter.blocks(root.children)
    line_count = max(1, source.count("\n") + (0 if source.endswith("\n") else 1))
    document = Document(
        blocks,
        SourceSpan(
            path,
            line=1 + line_offset,
            column=1,
            end_line=line_count + line_offset,
        ),
    )
    converter.diagnostics.extend(_accessibility_diagnostics(document))
    return ParseResult(document, tuple(converter.diagnostics))


def _markdown_parser() -> MarkdownIt:
    parser = MarkdownIt("commonmark", {"html": True})
    parser.enable(["table", "strikethrough"])
    parser.use(
        dollarmath_plugin,
        allow_labels=False,
        allow_space=False,
        allow_digits=False,
        allow_blank_lines=False,
    )
    parser.block.ruler.before("fence", "confluence_directive", _directive_rule)
    return parser


def _directive_rule(state: StateBlock, start_line: int, end_line: int, silent: bool) -> bool:
    opening_line = _line(state, start_line)
    opening = _DIRECTIVE_OPEN.fullmatch(opening_line)
    if opening is None:
        return False
    if silent:
        return True

    nesting = 1
    line = start_line + 1
    fence_marker: str | None = None
    while line < end_line:
        content = _line(state, line)
        fence = _FENCE.match(content)
        if fence is not None:
            marker = fence.group("marker")
            if fence_marker is None:
                fence_marker = marker
            elif marker[0] == fence_marker[0] and len(marker) >= len(fence_marker):
                fence_marker = None
            line += 1
            continue
        if fence_marker is None:
            if _DIRECTIVE_OPEN.fullmatch(content):
                nesting += 1
            elif _DIRECTIVE_CLOSE.fullmatch(content):
                nesting -= 1
                if nesting == 0:
                    break
        line += 1

    closed = line < end_line
    body_end = line if closed else end_line
    token: Token = state.push("confluence_directive", "", 0)
    token.block = True
    token.map = [start_line, line + 1 if closed else end_line]
    token.content = state.getLines(start_line + 1, body_end, state.blkIndent, False)
    token.meta = {
        "name": opening.group("name"),
        "attrs": opening.group("attrs") or "",
        "attribute_column": opening_line.find("{") + 1,
        "body_start": start_line + 1,
        "unclosed": not closed,
    }
    state.line = line + 1 if closed else end_line
    return True


def _line(state: StateBlock, line: int) -> str:
    start = state.bMarks[line] + state.tShift[line]
    return state.src[start : state.eMarks[line]]


def _parse_parameters(
    raw: str,
    *,
    span: SourceSpan,
    attribute_column: int,
    diagnostics: list[Diagnostic],
) -> tuple[DirectiveParameter, ...]:
    if not raw:
        return ()
    if not (raw.startswith("{") and raw.endswith("}")):
        diagnostics.append(
            Diagnostic(
                "MD_INVALID_DIRECTIVE_ATTRIBUTES",
                Severity.ERROR,
                "Directive attributes must be enclosed in braces.",
                span,
            )
        )
        return ()
    try:
        parts = shlex.split(raw[1:-1], posix=True)
    except ValueError as exc:
        diagnostics.append(
            Diagnostic(
                "MD_INVALID_DIRECTIVE_ATTRIBUTES",
                Severity.ERROR,
                f"Invalid directive attributes: {exc}",
                span,
            )
        )
        return ()
    result: list[DirectiveParameter] = []
    seen: set[str] = set()
    cursor = 0
    for part in parts:
        name, separator, value = part.partition("=")
        location = re.search(rf"(?<![A-Za-z0-9_-]){re.escape(name)}\s*=", raw[cursor:])
        offset = cursor + location.start() if location is not None else cursor
        parameter_span = SourceSpan(
            span.path,
            line=span.line,
            column=attribute_column + offset,
            end_line=span.line,
            end_column=attribute_column + offset + len(name),
        )
        cursor = offset + len(name)
        if not separator or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_-]*", name):
            diagnostics.append(
                Diagnostic(
                    "MD_INVALID_DIRECTIVE_ATTRIBUTE",
                    Severity.ERROR,
                    f"Invalid directive attribute: {part}",
                    parameter_span,
                )
            )
            continue
        if name in seen:
            diagnostics.append(
                Diagnostic(
                    "MD_DUPLICATE_DIRECTIVE_ATTRIBUTE",
                    Severity.ERROR,
                    f"Duplicate directive attribute: {name}",
                    parameter_span,
                )
            )
            continue
        seen.add(name)
        result.append(DirectiveParameter(name, value, parameter_span))
    return tuple(result)


def _optional_attr(node: SyntaxTreeNode, name: str) -> str | None:
    value = node.attrs.get(name)
    return str(value) if value not in (None, "") else None


def _positive_int(value: object) -> int | None:
    if isinstance(value, int) and value > 0:
        return value
    if isinstance(value, str) and value.isdigit() and int(value) > 0:
        return int(value)
    return None


def _accessibility_diagnostics(document: Document) -> tuple[Diagnostic, ...]:
    diagnostics: list[Diagnostic] = []
    anchors: dict[str, SourceSpan] = {}
    previous_heading_level = 1  # The Confluence page title is the implicit H1.
    for block in _walk_blocks(document.blocks):
        if isinstance(block, Heading):
            if not plain_text(block.children).strip():
                diagnostics.append(
                    Diagnostic(
                        "ACCESS_EMPTY_HEADING",
                        Severity.WARNING,
                        "Heading has no readable text.",
                        block.span,
                    )
                )
            if block.level > previous_heading_level + 1:
                diagnostics.append(
                    Diagnostic(
                        "ACCESS_HEADING_LEVEL_SKIPPED",
                        Severity.WARNING,
                        f"Heading level jumps from {previous_heading_level} to {block.level}.",
                        block.span,
                        "Use consecutive heading levels so assistive navigation is predictable.",
                    )
                )
            previous_heading_level = block.level
            diagnostics.extend(_inline_accessibility(block.children))
        elif isinstance(block, Paragraph):
            diagnostics.extend(_inline_accessibility(block.children))
        elif isinstance(block, Table):
            has_header = bool(block.rows) and any(
                cell.header and plain_text(cell.children).strip() for cell in block.rows[0].cells
            )
            if not has_header:
                diagnostics.append(
                    Diagnostic(
                        "ACCESS_TABLE_WITHOUT_HEADER",
                        Severity.WARNING,
                        "Table has no usable header text.",
                        block.span,
                    )
                )
            for row in block.rows:
                for cell in row.cells:
                    diagnostics.extend(_inline_accessibility(cell.children))
        elif isinstance(block, Anchor):
            previous = anchors.get(block.name)
            if previous is not None:
                diagnostics.append(
                    Diagnostic(
                        "ACCESS_DUPLICATE_ANCHOR",
                        Severity.WARNING,
                        f"Anchor '{block.name}' is defined more than once.",
                        block.span,
                        f"The first definition is on line {previous.line or '?'}.",
                    )
                )
            else:
                anchors[block.name] = block.span
        elif isinstance(block, Directive) and block.name is MacroName.ANCHOR:
            name = next(
                (parameter.value for parameter in block.parameters if parameter.name == "name"),
                None,
            )
            if name:
                previous = anchors.get(name)
                if previous is not None:
                    diagnostics.append(
                        Diagnostic(
                            "ACCESS_DUPLICATE_ANCHOR",
                            Severity.WARNING,
                            f"Anchor '{name}' is defined more than once.",
                            block.span,
                            f"The first definition is on line {previous.line or '?'}.",
                        )
                    )
                else:
                    anchors[name] = block.span
    return tuple(diagnostics)


def _walk_blocks(blocks: tuple[Block, ...]) -> tuple[Block, ...]:
    result: list[Block] = []
    for block in blocks:
        result.append(block)
        children: tuple[Block, ...] = ()
        if isinstance(block, (BlockQuote, Callout, Directive)):
            children = block.children if isinstance(block, BlockQuote) else block.body
        elif isinstance(block, (ListBlock, TaskList)):
            children = tuple(child for item in block.items for child in item.children)
        if children:
            result.extend(_walk_blocks(children))
    return tuple(result)


def _inline_accessibility(nodes: tuple[Inline, ...]) -> tuple[Diagnostic, ...]:
    diagnostics: list[Diagnostic] = []
    for node in nodes:
        if isinstance(node, Link):
            if not plain_text(node.children).strip():
                diagnostics.append(
                    Diagnostic(
                        "ACCESS_EMPTY_LINK",
                        Severity.WARNING,
                        "Link has no readable label.",
                        node.span,
                    )
                )
            diagnostics.extend(_inline_accessibility(node.children))
        elif isinstance(node, (Emphasis, Strong, Strike, Highlight)):
            diagnostics.extend(_inline_accessibility(node.children))
    return tuple(diagnostics)


def _strip_multiline_comment_runs(nodes: tuple[Inline, ...]) -> tuple[Inline, ...]:
    """Remove paired Obsidian comments spanning text/formatting tokens.

    Inline code is a protected boundary: it is preserved byte-for-byte and cannot be
    swallowed by a comment pair on either side.
    """

    result: list[Inline] = []
    buffered: list[Inline] | None = None
    for node in nodes:
        if isinstance(node, InlineCode):
            if buffered is not None:
                result.extend(buffered)
                buffered = None
            result.append(node)
            continue
        if not isinstance(node, Text):
            (buffered if buffered is not None else result).append(node)
            continue

        remaining = node.value
        while remaining:
            marker = remaining.find("%%")
            if marker < 0:
                target = buffered if buffered is not None else result
                target.append(Text(remaining, node.span))
                break
            before = remaining[:marker]
            if buffered is None:
                if before:
                    result.append(Text(before, node.span))
                buffered = [Text("%%", node.span)]
            else:
                if before:
                    buffered.append(Text(before, node.span))
                buffered = None  # A complete comment is discarded.
            remaining = remaining[marker + 2 :]
    if buffered is not None:
        result.extend(buffered)
    return tuple(result)
