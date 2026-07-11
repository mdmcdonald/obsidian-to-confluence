"""Bounded, cacheable Mermaid service over an injected renderer protocol."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import uuid
from dataclasses import dataclass
from enum import StrEnum
from pathlib import Path

from md2conf_dc.assets.images import _dimensions, _sha256
from md2conf_dc.assets.model import asset_id
from md2conf_dc.interfaces import MermaidRenderer
from md2conf_dc.models import AssetSpec, Diagnostic, Severity, SourceSpan


class MermaidQuality(StrEnum):
    LOW = "low"
    MEDIUM = "medium"
    HIGH = "high"

    @property
    def scale(self) -> float:
        return {
            MermaidQuality.LOW: 1.0,
            MermaidQuality.MEDIUM: 1.5,
            MermaidQuality.HIGH: 2.0,
        }[self]


@dataclass(frozen=True, slots=True)
class MermaidOptions:
    cache_dir: Path
    quality: MermaidQuality = MermaidQuality.MEDIUM
    timeout_seconds: float = 30.0
    max_source_characters: int = 100_000
    max_bytes: int = 25 * 1024 * 1024
    max_width: int = 8192
    max_height: int = 8192
    max_pixels: int = 40_000_000
    theme: str = "neutral"
    font_fingerprint: str = "system-sans-v1"
    mermaid_version: str = "backend-declared"
    output_format: str = "png"


@dataclass(frozen=True, slots=True)
class MermaidResult:
    spec: AssetSpec | None
    source_path: Path | None
    diagnostics: tuple[Diagnostic, ...]
    cache_hit: bool

    @property
    def ok(self) -> bool:
        return self.spec is not None and not any(
            item.severity is Severity.ERROR for item in self.diagnostics
        )


class UnavailableMermaidRenderer:
    """Explicit backend stub used when no approved renderer is configured."""

    @property
    def identity(self) -> str:
        return "unavailable-mermaid-backend-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del source, scale, destination
        raise RuntimeError(
            "No Mermaid backend is configured; install and allowlist an approved renderer."
        )


class MermaidService:
    """Turns Mermaid source into a verified PNG attachment.

    Network isolation belongs to the injected backend implementation.  This service
    supplies the filesystem, timeout, size, dimension, and cache boundaries that a GUI
    or CLI can configure without depending on browser implementation details.
    """

    def __init__(self, renderer: MermaidRenderer, options: MermaidOptions) -> None:
        self._renderer = renderer
        self._options = options

    @property
    def identity(self) -> str:
        return f"mermaid-service-v1:{self._renderer.identity}"

    async def render(
        self, source: str, *, alt_text: str, span: SourceSpan | None = None
    ) -> MermaidResult:
        diagnostics: list[Diagnostic] = []
        if len(source) > self._options.max_source_characters:
            diagnostics.append(
                Diagnostic(
                    "MERMAID_SOURCE_TOO_LARGE",
                    Severity.ERROR,
                    "Mermaid source exceeds the configured character limit.",
                    span,
                )
            )
            return MermaidResult(None, None, tuple(diagnostics), False)
        if self._options.output_format != "png":
            diagnostics.append(
                Diagnostic(
                    "MERMAID_OUTPUT_UNSUPPORTED",
                    Severity.ERROR,
                    "The stock renderer supports only PNG Mermaid output.",
                    span,
                )
            )
            return MermaidResult(None, None, tuple(diagnostics), False)

        key = self._cache_key(source)
        destination = self._options.cache_dir / f"mermaid-{key[:20]}.png"
        try:
            self._options.cache_dir.mkdir(parents=True, exist_ok=True)
        except OSError as exc:
            diagnostics.append(
                Diagnostic(
                    "MERMAID_CACHE_UNAVAILABLE",
                    Severity.ERROR,
                    f"Could not create the Mermaid cache: {exc}",
                    span,
                )
            )
            return MermaidResult(None, None, tuple(diagnostics), False)

        cache_hit = destination.is_file()
        if not cache_hit:
            temporary = destination.with_name(f".{destination.name}.{uuid.uuid4().hex}.partial")
            try:
                async with asyncio.timeout(self._options.timeout_seconds):
                    await self._renderer.render(
                        source,
                        scale=self._options.quality.scale,
                        destination=temporary,
                    )
                if not temporary.is_file():
                    raise ValueError("renderer did not create an output file")
                temporary.replace(destination)
            except TimeoutError:
                diagnostics.append(
                    Diagnostic(
                        "MERMAID_TIMEOUT",
                        Severity.ERROR,
                        f"Mermaid rendering exceeded {self._options.timeout_seconds:g} seconds.",
                        span,
                    )
                )
            except (OSError, RuntimeError, ValueError):
                diagnostics.append(
                    Diagnostic(
                        "MERMAID_RENDER_FAILED",
                        Severity.ERROR,
                        "Mermaid rendering failed in the configured backend.",
                        span,
                    )
                )
            finally:
                with contextlib.suppress(OSError):
                    temporary.unlink(missing_ok=True)
            if diagnostics:
                return MermaidResult(None, None, tuple(diagnostics), False)

        try:
            size = destination.stat().st_size
            if size > self._options.max_bytes:
                raise ValueError(
                    f"output is {size} bytes; limit is {self._options.max_bytes} bytes"
                )
            width, height = _dimensions(destination, ".png")
            if width is None or height is None:
                raise ValueError("PNG dimensions were not available")
            if width <= 1 or height <= 1:
                raise ValueError("transparent-placeholder-sized output is not accepted")
            if width > self._options.max_width or height > self._options.max_height:
                raise ValueError(
                    f"output dimensions {width}x{height} exceed "
                    f"{self._options.max_width}x{self._options.max_height}"
                )
            if width * height > self._options.max_pixels:
                raise ValueError(
                    f"output has {width * height} pixels; limit is {self._options.max_pixels}"
                )
            checksum = _sha256(destination, max_bytes=self._options.max_bytes)
        except (OSError, ValueError) as exc:
            if not cache_hit:
                destination.unlink(missing_ok=True)
            diagnostics.append(
                Diagnostic(
                    "MERMAID_INVALID_OUTPUT",
                    Severity.ERROR,
                    f"Mermaid renderer produced invalid output: {exc}",
                    span,
                )
            )
            return MermaidResult(None, None, tuple(diagnostics), cache_hit)

        source_id = f"mermaid:{key}"
        spec = AssetSpec(
            asset_id=asset_id(kind="mermaid", source=source_id, checksum=checksum),
            kind="mermaid",
            source=source_id,
            attachment_filename=destination.name,
            mime_type="image/png",
            sha256=checksum,
            size=size,
            width=width,
            height=height,
            alt_text=alt_text or "Mermaid diagram",
        )
        return MermaidResult(spec, destination, tuple(diagnostics), cache_hit)

    def _cache_key(self, source: str) -> str:
        payload = {
            "schema": 1,
            "source": source,
            "renderer": self._renderer.identity,
            "mermaid": self._options.mermaid_version,
            "service": "md2conf-mermaid-v1",
            "theme": self._options.theme,
            "font": self._options.font_fingerprint,
            "scale": self._options.quality.scale,
            "format": self._options.output_format,
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode()
        return hashlib.sha256(encoded).hexdigest()
