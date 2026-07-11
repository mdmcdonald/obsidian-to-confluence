"""Confluence Data Center storage rendering."""

from md2conf_dc.render.policy import MetadataField, MetadataValue, decorate_with_metadata
from md2conf_dc.render.storage import (
    InternalLinkReference,
    InternalLinkResolver,
    LatexCapability,
    MathFallbackPolicy,
    MathOptions,
    RawHtmlPolicy,
    RenderLimits,
    ResolvedInternalLink,
    StorageOptions,
    StorageRenderResult,
    TocMode,
    UnresolvedLinkPolicy,
    render_document_ir,
    render_markdown,
)

__all__ = [
    "InternalLinkReference",
    "InternalLinkResolver",
    "LatexCapability",
    "MathFallbackPolicy",
    "MathOptions",
    "MetadataField",
    "MetadataValue",
    "RawHtmlPolicy",
    "RenderLimits",
    "ResolvedInternalLink",
    "StorageOptions",
    "StorageRenderResult",
    "TocMode",
    "UnresolvedLinkPolicy",
    "decorate_with_metadata",
    "render_document_ir",
    "render_markdown",
]
