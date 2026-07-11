"""Token-local Obsidian extensions.

Only text tokens are scanned.  Code tokens never pass through these functions, so
literal examples containing comments, highlights, or wikilinks are preserved.
"""

from __future__ import annotations

import re
from dataclasses import dataclass

from md2conf_dc.markdown.ir import (
    Break,
    Emphasis,
    Highlight,
    Image,
    Inline,
    InlineCode,
    InlineMath,
    Link,
    RawHtml,
    Strike,
    Strong,
    Text,
    WikiLink,
)
from md2conf_dc.models import Diagnostic, Severity, SourceSpan

_COMMENT = re.compile(r"%%.*?%%", re.DOTALL)
_SPECIAL = re.compile(r"%%|!\[\[|\[\[|==")
_DIMENSION = re.compile(r"^(?P<width>[1-9]\d*)(?:x(?P<height>[1-9]\d*))?$")


@dataclass(frozen=True, slots=True)
class InlineTransformResult:
    nodes: tuple[Inline, ...]
    diagnostics: tuple[Diagnostic, ...]


def transform_text(value: str, *, span: SourceSpan) -> InlineTransformResult:
    """Split one markdown text token into safe Obsidian-aware inline nodes."""

    nodes: list[Inline] = []
    diagnostics: list[Diagnostic] = []
    position = 0
    while match := _SPECIAL.search(value, position):
        if match.start() > position:
            nodes.append(Text(value[position : match.start()], span))
        marker = match.group(0)
        if marker == "%%":
            end = value.find("%%", match.end())
            if end < 0:
                # An unterminated marker is ordinary author text.
                nodes.append(Text("%%", span))
                position = match.end()
            else:
                position = end + 2
            continue
        if marker == "==":
            end = value.find("==", match.end())
            if end < 0:
                nodes.append(Text("==", span))
                position = match.end()
            else:
                highlighted = value[match.end() : end]
                nodes.append(Highlight((Text(highlighted, span),), span))
                position = end + 2
            continue

        embed = marker.startswith("!")
        content_start = match.end()
        end = value.find("]]", content_start)
        if end < 0:
            nodes.append(Text(marker, span))
            position = content_start
            continue
        content = value[content_start:end]
        parsed, diagnostic = _parse_wikilink(content, embed=embed, span=span)
        if diagnostic is not None:
            diagnostics.append(diagnostic)
            nodes.append(Text(value[match.start() : end + 2], span))
        elif parsed is not None:
            nodes.append(parsed)
        position = end + 2

    if position < len(value):
        nodes.append(Text(value[position:], span))
    return InlineTransformResult(tuple(nodes), tuple(diagnostics))


def _parse_wikilink(
    content: str, *, embed: bool, span: SourceSpan
) -> tuple[WikiLink | Image | None, Diagnostic | None]:
    pieces = [piece.strip() for piece in content.split("|")]
    target_part = pieces[0] if pieces else ""
    if not target_part:
        return None, Diagnostic(
            "MD_EMPTY_WIKILINK",
            Severity.ERROR,
            "A wikilink must have a target.",
            span,
        )

    target, heading, block_id = _split_target(target_part)
    alias = pieces[1] if len(pieces) > 1 and pieces[1] else None
    if not embed:
        return WikiLink(target, alias, heading, block_id, False, span), None

    if not _looks_like_image(target):
        return None, Diagnostic(
            "MD_NOTE_TRANSCLUSION_UNSUPPORTED",
            Severity.ERROR,
            f"Note transclusion is not supported: {target_part}",
            span,
            "Link to the note or publish the content directly instead.",
        )

    width: int | None = None
    height: int | None = None
    alt = alias or ""
    for piece in pieces[1:]:
        dimension = _DIMENSION.fullmatch(piece)
        if dimension:
            width = int(dimension.group("width"))
            height_text = dimension.group("height")
            height = int(height_text) if height_text else None
            if alt == piece:
                alt = ""
    return Image(target, alt, None, width, height, span), None


def _split_target(value: str) -> tuple[str, str | None, str | None]:
    if "#^" in value:
        target, block_id = value.split("#^", 1)
        return target, None, block_id or None
    if value.startswith("^"):
        return "", None, value[1:] or None
    if "#" in value:
        target, heading = value.split("#", 1)
        return target, heading or None, None
    return value, None, None


def _looks_like_image(target: str) -> bool:
    lower = target.casefold().split("?", 1)[0]
    return lower.endswith((".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg"))


def remove_task_marker(nodes: tuple[Inline, ...]) -> tuple[bool | None, tuple[Inline, ...]]:
    if not nodes or not isinstance(nodes[0], Text):
        return None, nodes
    match = re.match(r"^\[([ xX])\]\s+", nodes[0].value)
    if match is None:
        return None, nodes
    first = Text(nodes[0].value[match.end() :], nodes[0].span)
    remainder: tuple[Inline, ...] = ((first,) if first.value else ()) + nodes[1:]
    return match.group(1).casefold() == "x", remainder


def extract_block_id(nodes: tuple[Inline, ...]) -> tuple[tuple[Inline, ...], str | None]:
    if not nodes or not isinstance(nodes[-1], Text):
        return nodes, None
    match = re.search(r"(?:^|\s)\^([A-Za-z0-9][A-Za-z0-9_.:-]*)\s*$", nodes[-1].value)
    if match is None:
        return nodes, None
    value = nodes[-1].value[: match.start()].rstrip()
    final: tuple[Inline, ...] = nodes[:-1] + ((Text(value, nodes[-1].span),) if value else ())
    return final, match.group(1)


def plain_text(nodes: tuple[Inline, ...]) -> str:
    values: list[str] = []
    for node in nodes:
        if isinstance(node, Text):
            values.append(node.value)
        elif isinstance(node, (Emphasis, Strong, Strike, Highlight, Link)):
            values.append(plain_text(node.children))
        elif isinstance(node, (InlineCode, InlineMath, RawHtml)):
            values.append(node.value)
        elif isinstance(node, Break):
            values.append("\n")
        elif isinstance(node, WikiLink):
            values.append(node.alias or node.target or node.heading or node.block_id or "")
        elif isinstance(node, Image):
            values.append(node.alt_text)
    return "".join(values)
