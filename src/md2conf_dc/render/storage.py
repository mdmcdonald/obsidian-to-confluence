"""Render the semantic IR to deterministic Confluence DC storage XHTML."""

from __future__ import annotations

import hashlib
import html
import json
import posixpath
import re
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Protocol
from urllib.parse import unquote, urlsplit

from md2conf_dc.assets.images import ImageOptions, ImageReference, resolve_image
from md2conf_dc.markdown.ir import (
    Anchor,
    Block,
    BlockQuote,
    Break,
    BreakKind,
    Callout,
    CodeBlock,
    Directive,
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
    ListKind,
    MacroName,
    MathBlock,
    Paragraph,
    RawHtml,
    Strike,
    Strong,
    Table,
    TaskList,
    Text,
    UnsupportedBlock,
    UnsupportedInline,
    WikiLink,
)
from md2conf_dc.markdown.obsidian import plain_text
from md2conf_dc.markdown.parser import parse_markdown
from md2conf_dc.models import AssetSpec, Diagnostic, RenderContext, Severity, SourceSpan
from md2conf_dc.render.policy import (
    MetadataField,
    PagePolicy,
    decorate_with_metadata,
    resolve_policy,
)
from md2conf_dc.render.xml import validate_storage

_ANCHOR = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_.:-]{0,254}$")
_LABEL = re.compile(r"^[a-z0-9][a-z0-9_.:-]{0,254}$")


class UnresolvedLinkPolicy(StrEnum):
    WARN = "warn"
    TEXT = "text"
    FAIL = "fail"


class RawHtmlPolicy(StrEnum):
    ESCAPE = "escape"
    FAIL = "fail"


class TocMode(StrEnum):
    AUTO = "auto"
    ALWAYS = "always"
    NEVER = "never"


class MathFallbackPolicy(StrEnum):
    STOCK_CODE = "stock-code"
    FAIL = "fail"


@dataclass(frozen=True, slots=True)
class LatexCapability:
    """An explicitly enabled and versioned Appfire LaTeX macro contract."""

    version: str
    inline_macro: str = "mathinline"
    block_macro: str = "mathblock"

    @property
    def identity(self) -> str:
        return f"appfire-latex:{self.version}:inline={self.inline_macro}:block={self.block_macro}"


@dataclass(frozen=True, slots=True)
class MathOptions:
    capability: LatexCapability | None = None
    fallback: MathFallbackPolicy = MathFallbackPolicy.STOCK_CODE

    @property
    def identity(self) -> str:
        if self.capability is not None:
            return self.capability.identity
        return f"no-latex-capability:fallback={self.fallback.value}"


@dataclass(frozen=True, slots=True)
class InternalLinkReference:
    target: str
    source_path: Path
    heading: str | None = None
    block_id: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedInternalLink:
    title: str
    anchor: str | None = None
    published: bool = True


class InternalLinkResolver(Protocol):
    @property
    def identity(self) -> str: ...

    def resolve(self, reference: InternalLinkReference) -> ResolvedInternalLink | None: ...


@dataclass(frozen=True, slots=True)
class RenderLimits:
    max_blocks: int = 20_000
    max_links: int = 10_000
    max_macros: int = 2_000
    max_table_cells: int = 50_000
    max_assets: int = 5_000
    max_storage_characters: int = 10_000_000


@dataclass(frozen=True, slots=True)
class StorageOptions:
    image_options: ImageOptions = field(default_factory=ImageOptions)
    unresolved_link_policy: UnresolvedLinkPolicy = UnresolvedLinkPolicy.WARN
    raw_html_policy: RawHtmlPolicy = RawHtmlPolicy.ESCAPE
    toc_mode: TocMode = TocMode.AUTO
    link_resolver: InternalLinkResolver | None = None
    math: MathOptions = field(default_factory=MathOptions)
    unknown_callout_fallback: str = "info"
    max_directive_depth: int = 8
    max_image_width: int = 1600
    limits: RenderLimits = field(default_factory=RenderLimits)
    mermaid_assets: Mapping[str, AssetSpec] = field(default_factory=lambda: MappingProxyType({}))
    mermaid_asset_sources: Mapping[str, Path] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class ResolvedAssetSource:
    asset_id: str
    path: Path


@dataclass(frozen=True, slots=True)
class StorageRenderResult:
    storage_value: str
    canonical_value: str
    storage_sha256: str
    input_sha256: str
    assets: tuple[AssetSpec, ...]
    diagnostics: tuple[Diagnostic, ...]
    policy_id: str
    resolved_asset_sources: tuple[ResolvedAssetSource, ...] = ()

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


def render_markdown(
    source: str,
    *,
    source_path: Path,
    context: RenderContext,
    policy: PagePolicy | None = None,
    image_options: ImageOptions | None = None,
    options: StorageOptions | None = None,
    metadata_fields: Sequence[MetadataField] = (),
) -> StorageRenderResult:
    """Parse, decorate, render, validate, and hash one Markdown document."""

    parsed = parse_markdown(source, path=source_path)
    rendered = render_document_ir(
        parsed.document,
        context=context,
        policy=policy,
        image_options=image_options,
        options=options,
        metadata_fields=metadata_fields,
    )
    return StorageRenderResult(
        rendered.storage_value,
        rendered.canonical_value,
        rendered.storage_sha256,
        rendered.input_sha256,
        rendered.assets,
        (*parsed.diagnostics, *rendered.diagnostics),
        rendered.policy_id,
        rendered.resolved_asset_sources,
    )


def render_document_ir(
    document: Document,
    *,
    context: RenderContext,
    policy: PagePolicy | None = None,
    image_options: ImageOptions | None = None,
    options: StorageOptions | None = None,
    metadata_fields: Sequence[MetadataField] = (),
) -> StorageRenderResult:
    """Render an already-parsed document; useful for GUI inspection/edit pipelines."""

    diagnostics: list[Diagnostic] = []
    selected_policy = policy
    if selected_policy is None:
        resolution = resolve_policy(context.policy)
        diagnostics.extend(resolution.diagnostics)
        selected_policy = resolution.policy
    if selected_policy is None:
        selected_policy_id = f"invalid:{context.policy}"
        decorated = document
    else:
        selected_policy_id = selected_policy.identity
        policy_result = selected_policy.decorate(document, context=context)
        diagnostics.extend(policy_result.diagnostics)
        decorated = policy_result.document

    selected_options = options or StorageOptions()
    decorated = _apply_toc_mode(decorated, selected_options.toc_mode)
    metadata_result = decorate_with_metadata(decorated, metadata_fields)
    diagnostics.extend(metadata_result.diagnostics)
    decorated = metadata_result.document

    selected_image_options = image_options or selected_options.image_options
    selected_image_options = replace(selected_image_options, vault_root=context.vault_root)
    selected_options = replace(selected_options, image_options=selected_image_options)
    render_profile_id = (
        f"{selected_policy_id}|storage-contract=dc-9.2-v1|"
        f"math={selected_options.math.identity}|"
        f"raw-html={selected_options.raw_html_policy.value}|"
        f"toc={selected_options.toc_mode.value}|"
        f"links={_link_resolver_identity(selected_options)}"
    )
    renderer = _StorageRenderer(
        context=context,
        options=selected_options,
        source_path=document.span.path,
    )
    storage_value = renderer.blocks(decorated.blocks)
    diagnostics.extend(renderer.diagnostics)
    if len(storage_value) > selected_options.limits.max_storage_characters:
        diagnostics.append(
            Diagnostic(
                "STORAGE_SIZE_LIMIT",
                Severity.ERROR,
                "Rendered storage exceeds the configured character limit; output was discarded.",
                document.span,
            )
        )
        storage_value = ""
    validation = validate_storage(storage_value, span=document.span)
    diagnostics.extend(validation.diagnostics)
    canonical = validation.canonical_value or ""
    storage_hash = hashlib.sha256(canonical.encode("utf-8")).hexdigest()
    assets = tuple(renderer.assets.values())
    input_payload = {
        "schema": "md2conf-storage-v1",
        "canonical": canonical,
        "policy": render_profile_id,
        "assets": [
            {
                "id": asset.asset_id,
                "sha256": asset.sha256,
                "width": asset.width,
                "height": asset.height,
                "filename": asset.attachment_filename,
            }
            for asset in assets
        ],
    }
    input_hash = hashlib.sha256(
        json.dumps(input_payload, sort_keys=True, separators=(",", ":")).encode("utf-8")
    ).hexdigest()
    return StorageRenderResult(
        storage_value,
        canonical,
        storage_hash,
        input_hash,
        assets,
        tuple(diagnostics),
        render_profile_id,
        tuple(renderer.asset_sources.values()),
    )


class _StorageRenderer:
    def __init__(
        self, *, context: RenderContext, options: StorageOptions, source_path: Path
    ) -> None:
        self.context = context
        self.options = options
        self.diagnostics: list[Diagnostic] = []
        self.assets: dict[str, AssetSpec] = {}
        self.asset_sources: dict[str, ResolvedAssetSource] = {}
        self.source_path = source_path
        self._panel_depth = 0
        self._block_count = 0
        self._link_count = 0
        self._macro_count = 0
        self._table_cell_count = 0
        self._asset_count = 0
        self._reported_limits: set[str] = set()

    def blocks(self, blocks: tuple[Block, ...], *, depth: int = 0) -> str:
        rendered: list[str] = []
        for block in blocks:
            self._block_count += 1
            if self._block_count > self.options.limits.max_blocks:
                self._limit_error(
                    "RENDER_BLOCK_LIMIT",
                    "Document exceeds the configured semantic block limit.",
                    block.span,
                )
                break
            rendered.append(self.block(block, depth=depth))
        return "".join(rendered)

    def block(self, block: Block, *, depth: int) -> str:
        if isinstance(block, Paragraph):
            return f"<p>{self.inlines(block.children)}</p>"
        if isinstance(block, Heading):
            return f"<h{block.level}>{self.inlines(block.children)}</h{block.level}>"
        if isinstance(block, HorizontalRule):
            return "<hr />"
        if isinstance(block, BlockQuote):
            return f"<blockquote>{self.blocks(block.children, depth=depth)}</blockquote>"
        if isinstance(block, ListBlock):
            return self._list(block, depth=depth)
        if isinstance(block, TaskList):
            return self._task_list(block, depth=depth)
        if isinstance(block, CodeBlock):
            if not self._allow_macro(block.span):
                return ""
            return self._code(block)
        if isinstance(block, MathBlock):
            if not self._allow_macro(block.span):
                return ""
            return self._math_block(block)
        if isinstance(block, Table):
            return self._table(block)
        if isinstance(block, Callout):
            if not self._allow_macro(block.span):
                return ""
            return self._callout(block, depth=depth)
        if isinstance(block, Directive):
            if not self._allow_macro(block.span):
                return ""
            return self._directive(block, depth=depth)
        if isinstance(block, Anchor):
            if not self._allow_macro(block.span):
                return ""
            return self._anchor(block.name, block.span)
        if isinstance(block, UnsupportedBlock):
            self._error(
                "STORAGE_UNSUPPORTED_BLOCK",
                f"Cannot render unsupported block token: {block.token_type}",
                block.span,
            )
            return ""
        self._error("STORAGE_UNKNOWN_BLOCK", "Unknown semantic block node.", block.span)
        return ""

    def inlines(self, nodes: tuple[Inline, ...]) -> str:
        return "".join(self.inline(node) for node in nodes)

    def inline(self, node: Inline) -> str:
        if isinstance(node, Text):
            return _text(node.value)
        if isinstance(node, Emphasis):
            return f"<em>{self.inlines(node.children)}</em>"
        if isinstance(node, Strong):
            return f"<strong>{self.inlines(node.children)}</strong>"
        if isinstance(node, Strike):
            return f"<s>{self.inlines(node.children)}</s>"
        if isinstance(node, Highlight):
            return (
                '<span style="background-color: rgb(255,248,179)">'
                f"{self.inlines(node.children)}</span>"
            )
        if isinstance(node, InlineCode):
            return f"<code>{_text(node.value)}</code>"
        if isinstance(node, InlineMath):
            return self._inline_math(node)
        if isinstance(node, Break):
            return "<br />" if node.kind is BreakKind.HARD else "\n"
        if isinstance(node, Link):
            if not self._allow_link(node.span):
                return self.inlines(node.children)
            return self._link(node)
        if isinstance(node, WikiLink):
            if not self._allow_link(node.span):
                return _text(
                    node.alias or node.heading or node.block_id or _wiki_default_label(node.target)
                )
            return self._wikilink(node)
        if isinstance(node, Image):
            if not self._allow_asset(node.span):
                return ""
            return self._image(node)
        if isinstance(node, RawHtml):
            if self.options.raw_html_policy is RawHtmlPolicy.FAIL:
                self._error(
                    "RAW_HTML_FORBIDDEN",
                    "Raw HTML is forbidden by the active rendering policy.",
                    node.span,
                )
            return _text(node.value)
        if isinstance(node, UnsupportedInline):
            self._error(
                "STORAGE_UNSUPPORTED_INLINE",
                f"Cannot render unsupported inline token: {node.token_type}",
                node.span,
            )
            return ""
        self._error("STORAGE_UNKNOWN_INLINE", "Unknown semantic inline node.", node.span)
        return ""

    def _list(self, block: ListBlock, *, depth: int) -> str:
        if any(item.task_checked is not None for item in block.items):
            rendered: list[str] = []
            group_start = 0
            while group_start < len(block.items):
                task_group = block.items[group_start].task_checked is not None
                group_end = group_start + 1
                while group_end < len(block.items):
                    next_is_task = block.items[group_end].task_checked is not None
                    if next_is_task != task_group:
                        break
                    group_end += 1
                items = block.items[group_start:group_end]
                if task_group:
                    rendered.append(self._task_list(TaskList(items, block.span), depth=depth))
                else:
                    rendered.append(
                        self._normal_list(
                            ListBlock(
                                block.kind,
                                items,
                                block.start + group_start,
                                block.span,
                            ),
                            depth=depth,
                        )
                    )
                group_start = group_end
            return "".join(rendered)
        return self._normal_list(block, depth=depth)

    def _normal_list(self, block: ListBlock, *, depth: int) -> str:
        tag = "ol" if block.kind is ListKind.ORDERED else "ul"
        start = f' start="{block.start}"' if tag == "ol" and block.start != 1 else ""
        items = "".join(
            f"<li>{self.blocks(item.children, depth=depth)}</li>" for item in block.items
        )
        return f"<{tag}{start}>{items}</{tag}>"

    def _task_list(self, block: TaskList, *, depth: int) -> str:
        tasks: list[str] = []
        for item in block.items:
            status = "complete" if item.task_checked else "incomplete"
            if len(item.children) == 1 and isinstance(item.children[0], Paragraph):
                body = self.inlines(item.children[0].children)
            else:
                body = self.blocks(item.children, depth=depth)
            tasks.append(
                "<ac:task>"
                f"<ac:task-status>{status}</ac:task-status>"
                f"<ac:task-body>{body}</ac:task-body>"
                "</ac:task>"
            )
        return f"<ac:task-list>{''.join(tasks)}</ac:task-list>"

    def _code(self, block: CodeBlock) -> str:
        if (block.language or "").casefold() == "mermaid":
            key = hashlib.sha256(block.value.encode("utf-8")).hexdigest()
            asset = self.options.mermaid_assets.get(key)
            if asset is not None and asset.attachment_filename:
                self.assets.setdefault(asset.asset_id, asset)
                source_path = self.options.mermaid_asset_sources.get(key)
                if source_path is not None:
                    self.asset_sources.setdefault(
                        asset.asset_id,
                        ResolvedAssetSource(asset.asset_id, source_path),
                    )
                return self._attachment_image(asset)
            self._error(
                "MERMAID_RENDER_REQUIRED",
                "Mermaid source requires the asynchronous Mermaid asset preparation stage.",
                block.span,
            )
        language = ""
        if block.language:
            language = f'<ac:parameter ac:name="language">{_text(block.language)}</ac:parameter>'
        return (
            '<ac:structured-macro ac:name="code">'
            f"{language}<ac:plain-text-body><![CDATA[{_cdata(block.value)}]]>"
            "</ac:plain-text-body></ac:structured-macro>"
        )

    def _inline_math(self, node: InlineMath) -> str:
        capability = self.options.math.capability
        if capability is not None and self._valid_math_capability(capability, node.span):
            return self._plain_macro(capability.inline_macro, node.value)
        severity = (
            Severity.ERROR
            if self.options.math.fallback is MathFallbackPolicy.FAIL
            else Severity.WARNING
        )
        self.diagnostics.append(
            Diagnostic(
                "MATH_CAPABILITY_REQUIRED" if severity is Severity.ERROR else "MATH_STOCK_FALLBACK",
                severity,
                "Inline math requires the declared Appfire LaTeX capability; "
                "rendering as inline code."
                if severity is Severity.WARNING
                else "Inline math requires the declared Appfire LaTeX capability.",
                node.span,
            )
        )
        return f"<code>{_text(node.value)}</code>"

    def _math_block(self, block: MathBlock) -> str:
        capability = self.options.math.capability
        if capability is not None and self._valid_math_capability(capability, block.span):
            return self._plain_macro(capability.block_macro, block.value)
        severity = (
            Severity.ERROR
            if self.options.math.fallback is MathFallbackPolicy.FAIL
            else Severity.WARNING
        )
        self.diagnostics.append(
            Diagnostic(
                "MATH_CAPABILITY_REQUIRED" if severity is Severity.ERROR else "MATH_STOCK_FALLBACK",
                severity,
                "Block math requires the declared Appfire LaTeX capability; "
                "rendering as a stock code macro."
                if severity is Severity.WARNING
                else "Block math requires the declared Appfire LaTeX capability.",
                block.span,
            )
        )
        return self._code(CodeBlock(block.value, "latex", False, block.span))

    def _valid_math_capability(self, capability: LatexCapability, span: SourceSpan) -> bool:
        if (
            capability.inline_macro == "mathinline"
            and capability.block_macro == "mathblock"
            and bool(capability.version.strip())
        ):
            return True
        self._error(
            "MATH_CAPABILITY_INVALID",
            "The Appfire LaTeX capability does not match the allowlisted "
            "mathinline/mathblock contract.",
            span,
        )
        return False

    def _table(self, block: Table) -> str:
        rows: list[str] = []
        for row in block.rows:
            cells: list[str] = []
            for cell in row.cells:
                self._table_cell_count += 1
                if self._table_cell_count > self.options.limits.max_table_cells:
                    self._limit_error(
                        "RENDER_TABLE_CELL_LIMIT",
                        "Document exceeds the configured table-cell limit.",
                        cell.span,
                    )
                    break
                tag = "th" if cell.header else "td"
                align = f' data-align="{cell.alignment}"' if cell.alignment else ""
                cells.append(f"<{tag}{align}>{self.inlines(cell.children)}</{tag}>")
            rows.append(f"<tr>{''.join(cells)}</tr>")
        return f"<table><tbody>{''.join(rows)}</tbody></table>"

    def _callout(self, block: Callout, *, depth: int) -> str:
        panel_names = {"info", "note", "tip", "warning"}
        name = block.kind if block.kind in panel_names else self.options.unknown_callout_fallback
        if name not in panel_names:
            name = "info"
        if block.kind not in panel_names:
            self.diagnostics.append(
                Diagnostic(
                    "CALLOUT_FALLBACK",
                    Severity.WARNING,
                    f"Unknown callout type '{block.kind}' rendered as {name}.",
                    block.span,
                )
            )
        if block.collapsible:
            title = block.title or block.kind.replace("-", " ").title()
            body = self.blocks(block.body, depth=depth + 1)
            return self._rich_macro("expand", (("title", title),), body)
        if self._panel_depth:
            self.diagnostics.append(
                Diagnostic(
                    "NESTED_PANEL_FLATTENED",
                    Severity.WARNING,
                    "A panel nested inside another panel was flattened to ordinary content.",
                    block.span,
                )
            )
            title = f"<p><strong>{_text(block.title)}</strong></p>" if block.title else ""
            return f"{title}{self.blocks(block.body, depth=depth + 1)}"
        self._panel_depth += 1
        try:
            body = self.blocks(block.body, depth=depth + 1)
        finally:
            self._panel_depth -= 1
        parameters = (("title", block.title),) if block.title else ()
        return self._rich_macro(name, parameters, body)

    def _directive(self, block: Directive, *, depth: int) -> str:
        if depth >= self.options.max_directive_depth:
            self._error(
                "DIRECTIVE_DEPTH_LIMIT",
                f"Directive nesting exceeds {self.options.max_directive_depth} levels.",
                block.span,
            )
            return ""
        params = {item.name: item.value for item in block.parameters}
        name = block.name
        if name is MacroName.TOC:
            values = self._parameters(
                block,
                params,
                {
                    "min-level": ("minLevel", "int:1:7"),
                    "max-level": ("maxLevel", "int:1:7"),
                    "style": ("style", "enum:disc|circle|square|none"),
                    "include": ("include", "text"),
                    "exclude": ("exclude", "text"),
                    "printable": ("printable", "bool"),
                },
            )
            self._require_bodyless(block)
            return self._bodyless_macro("toc", values)
        if name is MacroName.CHILDREN:
            values = self._parameters(
                block,
                params,
                {
                    "depth": ("depth", "int:1:20"),
                    "sort": ("sort", "enum:title|creation|modified"),
                    "reverse": ("reverse", "bool"),
                    "all": ("all", "bool"),
                },
            )
            self._require_bodyless(block)
            return self._bodyless_macro("children", values)
        if name is MacroName.PAGE_TREE:
            values = self._parameters(
                block,
                params,
                {
                    "root": ("root", "text"),
                    "start-depth": ("startDepth", "int:1:20"),
                    "search-box": ("searchBox", "bool"),
                },
            )
            self._require_bodyless(block)
            return self._bodyless_macro("pagetree", values)
        if name is MacroName.STATUS:
            values = self._parameters(
                block,
                params,
                {"title": ("title", "text"), "colour": ("colour", "colour")},
            )
            body_title = self._plain_body(block)
            if body_title:
                if any(key == "title" for key, _ in values):
                    self._error(
                        "DIRECTIVE_DUPLICATE_TITLE",
                        "Status title must be supplied by either the body or title "
                        "parameter, not both.",
                        block.span,
                    )
                else:
                    values = (*values, ("title", body_title))
            if not any(key == "title" for key, _ in values):
                self._error("DIRECTIVE_STATUS_TITLE", "Status requires text.", block.span)
            return self._bodyless_macro("status", values)
        if name in {MacroName.EXPAND, MacroName.EXCERPT, MacroName.PAGE_PROPERTIES}:
            schemas = {
                MacroName.EXPAND: {"title": ("title", "text")},
                MacroName.EXCERPT: {"hidden": ("hidden", "bool")},
                MacroName.PAGE_PROPERTIES: {},
            }
            storage_names = {
                MacroName.EXPAND: "expand",
                MacroName.EXCERPT: "excerpt",
                MacroName.PAGE_PROPERTIES: "details",
            }
            values = self._parameters(block, params, schemas[name])
            self._require_rich_body(block)
            body = self.blocks(block.body, depth=depth + 1)
            return self._rich_macro(storage_names[name], values, body)
        if name is MacroName.EXCERPT_INCLUDE:
            values = self._parameters(block, params, {"page": ("", "text")})
            self._require_bodyless(block)
            if not values:
                self._error(
                    "DIRECTIVE_PAGE_REQUIRED", "Excerpt Include requires page=.", block.span
                )
            return self._bodyless_macro("excerpt-include", values)
        if name is MacroName.PAGE_PROPERTIES_REPORT:
            values = self._parameters(
                block,
                params,
                {
                    "labels": ("labels", "labels"),
                    "spaces": ("spaces", "text"),
                    "title": ("title", "text"),
                    "sort-by": ("sortBy", "text"),
                },
            )
            self._require_bodyless(block)
            return self._bodyless_macro("detailssummary", values)
        if name is MacroName.CONTENT_BY_LABEL:
            values = self._parameters(
                block,
                params,
                {
                    "labels": ("labels", "labels"),
                    "operator": ("operator", "enum:and|or"),
                    "sort": ("sort", "text"),
                    "max": ("max", "int:1:1000"),
                },
            )
            self._require_bodyless(block)
            if not any(key == "labels" for key, _ in values):
                self._error(
                    "DIRECTIVE_LABELS_REQUIRED",
                    "Content by Label requires labels=.",
                    block.span,
                )
            return self._bodyless_macro("contentbylabel", values)
        if name is MacroName.ANCHOR:
            values = self._parameters(block, params, {"name": ("", "anchor")})
            self._require_bodyless(block)
            if not values:
                self._error("DIRECTIVE_ANCHOR_REQUIRED", "Anchor requires name=.", block.span)
                return ""
            return self._bodyless_macro("anchor", values)
        if name in {MacroName.INFO, MacroName.NOTE, MacroName.TIP, MacroName.WARNING}:
            values = self._parameters(block, params, {"title": ("title", "text")})
            self._require_rich_body(block)
            return self._rich_macro(
                name.value,
                values,
                self.blocks(block.body, depth=depth + 1),
            )
        if name is MacroName.LAYOUT:
            return self._layout(block, params, depth=depth)
        self._error("DIRECTIVE_UNSUPPORTED", f"Unsupported directive: {name.value}", block.span)
        return ""

    def _layout(self, block: Directive, params: dict[str, str], *, depth: int) -> str:
        values = self._parameters(
            block,
            params,
            {
                "type": (
                    "type",
                    "enum:single|two-equal|two-left-sidebar|two-right-sidebar|three-equal",
                )
            },
        )
        layout_type = next((value for key, value in values if key == "type"), "single")
        storage_type = layout_type.replace("-", "_")
        cell_groups: list[list[Block]] = [[]]
        for child in block.body:
            if isinstance(child, HorizontalRule):
                cell_groups.append([])
            else:
                cell_groups[-1].append(child)
        expected = {
            "single": 1,
            "two_equal": 2,
            "two_left_sidebar": 2,
            "two_right_sidebar": 2,
            "three_equal": 3,
        }[storage_type]
        if len(cell_groups) != expected:
            self._error(
                "DIRECTIVE_LAYOUT_CELLS",
                f"Layout {layout_type} requires {expected} cells separated by horizontal rules.",
                block.span,
            )
        cells = "".join(
            f"<ac:layout-cell>{self.blocks(tuple(group), depth=depth + 1)}</ac:layout-cell>"
            for group in cell_groups[:expected]
        )
        return (
            "<ac:layout><ac:layout-section "
            f'ac:type="{_attr(storage_type)}">{cells}</ac:layout-section></ac:layout>'
        )

    def _parameters(
        self,
        block: Directive,
        supplied: dict[str, str],
        schema: dict[str, tuple[str, str]],
    ) -> tuple[tuple[str, str], ...]:
        values: list[tuple[str, str]] = []
        for key, raw in supplied.items():
            rule = schema.get(key)
            if rule is None:
                self._error(
                    "DIRECTIVE_UNKNOWN_PARAMETER",
                    f"Directive confluence:{block.name.value} does not accept '{key}'.",
                    block.span,
                )
                continue
            output_name, validator = rule
            normalized = self._validate_parameter(key, raw, validator, block.span)
            if normalized is not None:
                values.append((output_name, normalized))
        return tuple(values)

    def _validate_parameter(
        self, key: str, raw: str, validator: str, span: SourceSpan
    ) -> str | None:
        if validator == "text":
            return raw
        if validator == "bool":
            if raw.casefold() in {"true", "false"}:
                return raw.casefold()
        elif validator == "colour":
            colours = {"grey", "red", "yellow", "green", "blue"}
            if raw.casefold() in colours:
                return raw.casefold().title()
        elif validator == "anchor":
            if _ANCHOR.fullmatch(raw):
                return raw
        elif validator == "labels":
            labels = tuple(piece.strip().casefold() for piece in raw.split(",") if piece.strip())
            if labels and all(_LABEL.fullmatch(label) for label in labels):
                return ",".join(labels)
        elif validator.startswith("enum:"):
            values = validator.removeprefix("enum:").split("|")
            if raw.casefold() in values:
                return raw.casefold()
        elif validator.startswith("int:"):
            _, minimum, maximum = validator.split(":")
            if raw.isdigit() and int(minimum) <= int(raw) <= int(maximum):
                return str(int(raw))
        self._error(
            "DIRECTIVE_INVALID_PARAMETER",
            f"Invalid value for directive parameter '{key}': {raw}",
            span,
        )
        return None

    def _require_bodyless(self, block: Directive) -> None:
        if block.body:
            self._error(
                "DIRECTIVE_BODY_NOT_ALLOWED",
                f"Directive confluence:{block.name.value} does not accept a body.",
                block.span,
            )

    def _require_rich_body(self, block: Directive) -> None:
        if not block.body:
            self._error(
                "DIRECTIVE_BODY_REQUIRED",
                f"Directive confluence:{block.name.value} requires a Markdown body.",
                block.span,
            )

    def _plain_body(self, block: Directive) -> str:
        if not block.body:
            return ""
        if len(block.body) != 1 or not isinstance(block.body[0], Paragraph):
            self._error(
                "DIRECTIVE_PLAIN_BODY_REQUIRED",
                f"Directive confluence:{block.name.value} accepts only plain inline text.",
                block.span,
            )
            return ""
        value = plain_text(block.body[0].children).strip()
        rendered = self.inlines(block.body[0].children)
        if rendered != _text(value):
            # Formatting in a parameter would otherwise be silently lost.
            self._error(
                "DIRECTIVE_PLAIN_BODY_REQUIRED",
                f"Directive confluence:{block.name.value} body may not contain formatting.",
                block.span,
            )
        return value

    def _link(self, node: Link) -> str:
        parsed = urlsplit(node.destination)
        label = self.inlines(node.children)
        if parsed.scheme:
            if parsed.scheme.casefold() not in {"http", "https", "mailto"}:
                self._error(
                    "LINK_UNSAFE_SCHEME",
                    f"Link scheme is not allowed: {parsed.scheme}",
                    node.span,
                )
                return label
            if parsed.username is not None or parsed.password is not None:
                self._error(
                    "LINK_CREDENTIALS_REJECTED",
                    "Links may not contain embedded credentials.",
                    node.span,
                )
                return label
            title = f' title="{_attr(node.title)}"' if node.title else ""
            return f'<a href="{_attr(node.destination)}"{title}>{label}</a>'
        if parsed.netloc:
            self._error(
                "LINK_SCHEME_REQUIRED",
                "External links must use an explicit http or https scheme.",
                node.span,
            )
            return label
        if node.destination.startswith("#"):
            return self._confluence_link(None, unquote(node.destination[1:]), label)
        destination = unquote(parsed.path)
        resolved = self._resolve_internal(
            destination,
            heading=unquote(parsed.fragment) or None,
            block_id=None,
            span=node.span,
        )
        if resolved is not None and resolved.published:
            return self._confluence_link(
                resolved.title,
                resolved.anchor or unquote(parsed.fragment) or None,
                label,
            )
        if resolved is not None:
            return self._unresolved_link(destination, label, node.span, unpublished=True)
        if destination.casefold().endswith(".md"):
            return self._unresolved_link(destination, label, node.span)
        title_attr = f' title="{_attr(node.title)}"' if node.title else ""
        return f'<a href="{_attr(node.destination)}"{title_attr}>{label}</a>'

    def _wikilink(self, node: WikiLink) -> str:
        label_value = (
            node.alias or node.heading or node.block_id or _wiki_default_label(node.target)
        )
        label = _text(label_value)
        if not node.target:
            return self._confluence_link(None, node.block_id or node.heading, label)
        resolved = self._resolve_internal(
            node.target,
            heading=node.heading,
            block_id=node.block_id,
            span=node.span,
        )
        if resolved is None:
            return self._unresolved_link(node.target, label, node.span)
        if not resolved.published:
            return self._unresolved_link(node.target, label, node.span, unpublished=True)
        return self._confluence_link(
            resolved.title,
            resolved.anchor or node.block_id or node.heading,
            label,
        )

    def _resolve_internal(
        self,
        target: str,
        *,
        heading: str | None,
        block_id: str | None,
        span: SourceSpan,
    ) -> ResolvedInternalLink | None:
        resolver = self.options.link_resolver
        if resolver is not None:
            try:
                resolved = resolver.resolve(
                    InternalLinkReference(
                        target=target,
                        source_path=self.source_path,
                        heading=heading,
                        block_id=block_id,
                    )
                )
            except Exception:
                self._error(
                    "LINK_RESOLVER_FAILED",
                    "The configured internal link resolver failed.",
                    span,
                )
                return None
            if resolved is not None and not resolved.title.strip():
                self._error(
                    "LINK_RESOLVER_INVALID",
                    "The configured internal link resolver returned an invalid result.",
                    span,
                )
                return None
            return resolved
        title = self._resolve_title(target)
        return ResolvedInternalLink(title, block_id or heading) if title is not None else None

    def _resolve_title(self, target: str) -> str | None:
        decoded = unquote(target).replace("\\", "/")
        without_md = decoded[:-3] if decoded.casefold().endswith(".md") else decoded
        candidates: list[str] = []
        source_path = self.source_path
        try:
            relative_source = (
                source_path.relative_to(self.context.vault_root)
                if source_path.is_absolute()
                else source_path
            )
            parent = relative_source.parent.as_posix()
            relative = posixpath.normpath(posixpath.join(parent, decoded))
            relative_no_md = relative[:-3] if relative.casefold().endswith(".md") else relative
            candidates.extend((relative, relative_no_md, f"{relative_no_md}.md"))
        except ValueError:
            pass
        candidates.extend((decoded, without_md, f"{without_md}.md"))
        folded = {
            str(key).replace("\\", "/").casefold(): value
            for key, value in self.context.final_titles.items()
        }
        for candidate in candidates:
            if value := folded.get(candidate.casefold().lstrip("./")):
                return value
        stem = PurePosixPath(without_md).name.casefold()
        basename_matches = {
            value
            for key, value in self.context.final_titles.items()
            if PurePosixPath(str(key).removesuffix(".md")).name.casefold() == stem
        }
        if len(basename_matches) == 1:
            return next(iter(basename_matches))
        return None

    def _unresolved_link(
        self,
        target: str,
        label: str,
        span: SourceSpan,
        *,
        unpublished: bool = False,
    ) -> str:
        if self.options.unresolved_link_policy is not UnresolvedLinkPolicy.TEXT:
            severity = (
                Severity.ERROR
                if self.options.unresolved_link_policy is UnresolvedLinkPolicy.FAIL
                else Severity.WARNING
            )
            self.diagnostics.append(
                Diagnostic(
                    "LINK_UNPUBLISHED" if unpublished else "LINK_UNRESOLVED",
                    severity,
                    "Internal link target is not selected for publication."
                    if unpublished
                    else "Internal link target could not be resolved.",
                    span,
                )
            )
        return label

    def _confluence_link(self, title: str | None, anchor: str | None, label: str) -> str:
        anchor_attr = f' ac:anchor="{_attr(anchor)}"' if anchor else ""
        page = f'<ri:page ri:content-title="{_attr(title)}" />' if title else ""
        return f"<ac:link{anchor_attr}>{page}<ac:link-body>{label}</ac:link-body></ac:link>"

    def _image(self, node: Image) -> str:
        reference = ImageReference(
            node.source,
            node.alt_text,
            node.width,
            node.height,
            node.span,
        )
        source_path = node.span.path
        if not source_path.is_absolute():
            source_path = self.context.vault_root / source_path
        resolution = resolve_image(
            reference,
            source_path=source_path,
            options=self.options.image_options,
        )
        self.diagnostics.extend(resolution.diagnostics)
        if resolution.external_url is not None:
            dimensions = self._image_attributes(
                node.alt_text, node.width, node.height, span=node.span
            )
            return (
                f"<ac:image{dimensions}>"
                f'<ri:url ri:value="{_attr(resolution.external_url)}" />'
                "</ac:image>"
            )
        if resolution.spec is None or not resolution.spec.attachment_filename:
            return ""
        asset = resolution.spec
        dimensions = self._image_attributes(
            node.alt_text,
            asset.width if node.width else None,
            asset.height if node.height else None,
            span=node.span,
        )
        self.assets.setdefault(asset.asset_id, asset)
        if resolution.source_path is not None:
            self.asset_sources.setdefault(
                asset.asset_id,
                ResolvedAssetSource(asset.asset_id, resolution.source_path),
            )
        return self._attachment_image(asset, attributes=dimensions)

    def _image_attributes(
        self,
        alt: str,
        width: int | None,
        height: int | None,
        *,
        span: SourceSpan,
    ) -> str:
        attributes = f' ac:alt="{_attr(alt)}"' if alt else ""
        if width:
            clamped = min(width, self.options.max_image_width)
            if clamped != width:
                self.diagnostics.append(
                    Diagnostic(
                        "IMAGE_WIDTH_CLAMPED",
                        Severity.WARNING,
                        f"Image width {width} was clamped to {clamped}.",
                        span,
                    )
                )
            attributes += f' ac:width="{clamped}"'
        if height:
            attributes += f' ac:height="{height}"'
        return attributes

    def _attachment_image(self, asset: AssetSpec, *, attributes: str = "") -> str:
        alt = f' ac:alt="{_attr(asset.alt_text)}"' if asset.alt_text and not attributes else ""
        return (
            f"<ac:image{attributes}{alt}>"
            f'<ri:attachment ri:filename="{_attr(asset.attachment_filename)}" />'
            "</ac:image>"
        )

    def _anchor(self, name: str, span: SourceSpan) -> str:
        if not _ANCHOR.fullmatch(name):
            self._error("ANCHOR_INVALID", f"Invalid anchor name: {name}", span)
            return ""
        return self._bodyless_macro("anchor", (("", name),))

    def _bodyless_macro(self, name: str, parameters: tuple[tuple[str, str], ...]) -> str:
        rendered = "".join(
            f'<ac:parameter ac:name="{_attr(key)}">{_text(value)}</ac:parameter>'
            for key, value in parameters
        )
        return f'<ac:structured-macro ac:name="{_attr(name)}">{rendered}</ac:structured-macro>'

    def _plain_macro(self, name: str, value: str) -> str:
        return (
            f'<ac:structured-macro ac:name="{_attr(name)}">'
            f"<ac:plain-text-body><![CDATA[{_cdata(value)}]]>"
            "</ac:plain-text-body></ac:structured-macro>"
        )

    def _rich_macro(
        self, name: str, parameters: tuple[tuple[str, str | None], ...], body: str
    ) -> str:
        rendered = "".join(
            f'<ac:parameter ac:name="{_attr(key)}">{_text(value or "")}</ac:parameter>'
            for key, value in parameters
        )
        return (
            f'<ac:structured-macro ac:name="{_attr(name)}">{rendered}'
            f"<ac:rich-text-body>{body}</ac:rich-text-body></ac:structured-macro>"
        )

    def _error(self, code: str, message: str, span: SourceSpan) -> None:
        self.diagnostics.append(Diagnostic(code, Severity.ERROR, message, span))

    def _allow_link(self, span: SourceSpan) -> bool:
        self._link_count += 1
        if self._link_count <= self.options.limits.max_links:
            return True
        self._limit_error(
            "RENDER_LINK_LIMIT",
            "Document exceeds the configured link limit.",
            span,
        )
        return False

    def _allow_macro(self, span: SourceSpan) -> bool:
        self._macro_count += 1
        if self._macro_count <= self.options.limits.max_macros:
            return True
        self._limit_error(
            "RENDER_MACRO_LIMIT",
            "Document exceeds the configured macro limit.",
            span,
        )
        return False

    def _allow_asset(self, span: SourceSpan) -> bool:
        self._asset_count += 1
        if self._asset_count <= self.options.limits.max_assets:
            return True
        self._limit_error(
            "RENDER_ASSET_LIMIT",
            "Document exceeds the configured asset limit.",
            span,
        )
        return False

    def _limit_error(self, code: str, message: str, span: SourceSpan) -> None:
        if code in self._reported_limits:
            return
        self._reported_limits.add(code)
        self._error(code, message, span)


def _apply_toc_mode(document: Document, mode: TocMode) -> Document:
    has_toc = any(
        isinstance(block, Directive) and block.name is MacroName.TOC for block in document.blocks
    )
    if mode is TocMode.AUTO:
        return document
    if mode is TocMode.ALWAYS:
        if has_toc:
            return document
        return Document(
            (Directive(MacroName.TOC, (), (), document.span), *document.blocks),
            document.span,
        )
    blocks = tuple(
        block
        for block in document.blocks
        if not (isinstance(block, Directive) and block.name is MacroName.TOC)
    )
    return Document(blocks, document.span)


def _text(value: str) -> str:
    return html.escape(value, quote=False)


def _attr(value: object) -> str:
    return html.escape(str(value), quote=True)


def _cdata(value: str) -> str:
    return value.replace("]]>", "]]]]><![CDATA[>")


def _wiki_default_label(target: str) -> str:
    name = PurePosixPath(target.replace("\\", "/")).name
    return name[:-3] if name.casefold().endswith(".md") else name


def _link_resolver_identity(options: StorageOptions) -> str:
    resolver_identity = (
        options.link_resolver.identity
        if options.link_resolver is not None
        else "builtin:title-map-v1"
    )
    return f"{resolver_identity}:unresolved={options.unresolved_link_policy.value}"
