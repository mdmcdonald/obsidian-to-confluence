"""Safe, bounded asset discovery and rendering services."""

from md2conf_dc.assets.cache import (
    CACHE_SENTINEL,
    CacheSafetyError,
    initialize_managed_cache_root,
    require_managed_cache_root,
)
from md2conf_dc.assets.images import (
    ImageOptions,
    ImageReference,
    ImageResolution,
    resolve_image,
)
from md2conf_dc.assets.mermaid import (
    MermaidOptions,
    MermaidQuality,
    MermaidResult,
    MermaidService,
    UnavailableMermaidRenderer,
)

__all__ = [
    "CACHE_SENTINEL",
    "CacheSafetyError",
    "ImageOptions",
    "ImageReference",
    "ImageResolution",
    "MermaidOptions",
    "MermaidQuality",
    "MermaidResult",
    "MermaidService",
    "UnavailableMermaidRenderer",
    "initialize_managed_cache_root",
    "require_managed_cache_root",
    "resolve_image",
]
