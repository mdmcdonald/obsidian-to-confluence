"""Bounded image resolution without retaining asset bytes in page models."""

from __future__ import annotations

import hashlib
import mimetypes
import re
import struct
from dataclasses import dataclass, replace
from pathlib import Path
from urllib.parse import unquote, urlsplit

from lxml import etree  # type: ignore[import-untyped]

from md2conf_dc.assets.model import asset_id, attachment_filename
from md2conf_dc.models import AssetSpec, Diagnostic, Severity, SourceSpan

_MIME_BY_SUFFIX = {
    ".gif": "image/gif",
    ".jpeg": "image/jpeg",
    ".jpg": "image/jpeg",
    ".png": "image/png",
    ".svg": "image/svg+xml",
    ".webp": "image/webp",
}


@dataclass(frozen=True, slots=True)
class ImageReference:
    source: str
    alt_text: str
    width: int | None = None
    height: int | None = None
    span: SourceSpan | None = None


@dataclass(frozen=True, slots=True)
class ImageOptions:
    vault_root: Path | None = None
    additional_roots: tuple[Path, ...] = ()
    max_bytes: int = 25 * 1024 * 1024
    max_width: int = 8192
    max_height: int = 8192
    allow_external: bool = True
    require_alt_text: bool = True

    def for_vault(self, vault_root: Path) -> ImageOptions:
        return self if self.vault_root is not None else replace(self, vault_root=vault_root)


@dataclass(frozen=True, slots=True)
class ImageResolution:
    spec: AssetSpec | None
    source_path: Path | None
    external_url: str | None
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not any(item.severity is Severity.ERROR for item in self.diagnostics)


def resolve_image(
    reference: ImageReference, *, source_path: Path, options: ImageOptions
) -> ImageResolution:
    """Resolve and inspect one image using approved roots and bounded streaming reads."""

    diagnostics: list[Diagnostic] = []
    if len(reference.source) > 2_048 or any(
        ord(character) < 32 or ord(character) == 127 for character in reference.source
    ):
        diagnostics.append(
            _diagnostic(
                "ASSET_REFERENCE_INVALID",
                Severity.ERROR,
                "Image reference exceeds safe length or character limits.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))
    parsed = urlsplit(reference.source)
    if parsed.scheme:
        if parsed.scheme.casefold() in {"http", "https"}:
            if not options.allow_external:
                diagnostics.append(
                    _diagnostic(
                        "ASSET_EXTERNAL_DISABLED",
                        Severity.ERROR,
                        "External images are disabled by policy.",
                        reference,
                    )
                )
                return ImageResolution(None, None, None, tuple(diagnostics))
            if not parsed.netloc:
                diagnostics.append(
                    _diagnostic(
                        "ASSET_INVALID_EXTERNAL_URL",
                        Severity.ERROR,
                        "External image URL has no host.",
                        reference,
                    )
                )
                return ImageResolution(None, None, None, tuple(diagnostics))
            if parsed.username is not None or parsed.password is not None or parsed.fragment:
                diagnostics.append(
                    _diagnostic(
                        "ASSET_INVALID_EXTERNAL_URL",
                        Severity.ERROR,
                        "External image URLs may not contain credentials or fragments.",
                        reference,
                    )
                )
                return ImageResolution(None, None, None, tuple(diagnostics))
            _check_alt(reference, options, diagnostics)
            return ImageResolution(None, None, reference.source, tuple(diagnostics))
        diagnostics.append(
            _diagnostic(
                "ASSET_UNSAFE_SCHEME",
                Severity.ERROR,
                "Image URL scheme is not allowed.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))

    if options.vault_root is None:
        diagnostics.append(
            _diagnostic(
                "ASSET_MISSING_VAULT_ROOT",
                Severity.ERROR,
                "A vault root is required to resolve local images.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))

    decoded = unquote(reference.source)
    decoded_path = Path(decoded.replace("\\", "/"))
    encoded_parent = decoded != reference.source and any(
        part == ".." for part in decoded_path.parts
    )
    if (
        len(decoded) > 512
        or len(decoded_path.parts) > 64
        or any(len(part.encode("utf-8")) > 255 for part in decoded_path.parts)
        or "\x00" in decoded
        or decoded_path.is_absolute()
        or encoded_parent
    ):
        diagnostics.append(
            _diagnostic(
                "ASSET_PATH_TRAVERSAL",
                Severity.ERROR,
                "Image path is outside the approved local-reference profile.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))

    roots = _resolved_roots(options)
    resolved, ambiguity, escaped = _find_local_image(decoded, source_path=source_path, roots=roots)
    if escaped:
        diagnostics.append(
            _diagnostic(
                "ASSET_PATH_TRAVERSAL",
                Severity.ERROR,
                "Image path escapes an approved asset root.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))
    if ambiguity:
        diagnostics.append(
            _diagnostic(
                "ASSET_AMBIGUOUS",
                Severity.ERROR,
                "Image reference matches more than one approved file.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))
    if resolved is None:
        diagnostics.append(
            _diagnostic(
                "ASSET_NOT_FOUND",
                Severity.ERROR,
                "Local image was not found.",
                reference,
            )
        )
        return ImageResolution(None, None, None, tuple(diagnostics))

    suffix = resolved.suffix.casefold()
    mime_type = _MIME_BY_SUFFIX.get(suffix)
    if mime_type is None:
        guessed, _ = mimetypes.guess_type(resolved.name)
        diagnostics.append(
            _diagnostic(
                "ASSET_UNSUPPORTED_FORMAT",
                Severity.ERROR,
                f"Unsupported image format: {guessed or suffix or '<none>'}.",
                reference,
            )
        )
        return ImageResolution(None, resolved, None, tuple(diagnostics))

    try:
        size = resolved.stat().st_size
    except OSError:
        diagnostics.append(
            _diagnostic(
                "ASSET_READ_FAILED",
                Severity.ERROR,
                "Could not inspect the local image.",
                reference,
            )
        )
        return ImageResolution(None, resolved, None, tuple(diagnostics))
    if size > options.max_bytes:
        diagnostics.append(
            _diagnostic(
                "ASSET_TOO_LARGE",
                Severity.ERROR,
                f"Image is {size} bytes; the configured limit is {options.max_bytes} bytes.",
                reference,
            )
        )
        return ImageResolution(None, resolved, None, tuple(diagnostics))

    try:
        checksum = _sha256(resolved, max_bytes=options.max_bytes)
        natural_width, natural_height = _dimensions(resolved, suffix)
    except (OSError, ValueError, etree.XMLSyntaxError):
        diagnostics.append(
            _diagnostic(
                "ASSET_INVALID_IMAGE",
                Severity.ERROR,
                "Image is invalid or unreadable.",
                reference,
            )
        )
        return ImageResolution(None, resolved, None, tuple(diagnostics))

    width = reference.width or natural_width
    height = reference.height or natural_height
    if reference.width and natural_width and reference.width > natural_width:
        width = natural_width
        diagnostics.append(
            _diagnostic(
                "ASSET_DIMENSION_CLAMPED",
                Severity.WARNING,
                f"Requested image width {reference.width} was clamped to its "
                f"source width {natural_width}.",
                reference,
            )
        )
    if reference.height and natural_height and reference.height > natural_height:
        height = natural_height
        diagnostics.append(
            _diagnostic(
                "ASSET_DIMENSION_CLAMPED",
                Severity.WARNING,
                f"Requested image height {reference.height} was clamped to its "
                f"source height {natural_height}.",
                reference,
            )
        )
    if width is not None and width > options.max_width:
        diagnostics.append(
            _diagnostic(
                "ASSET_WIDTH_LIMIT",
                Severity.ERROR,
                f"Image width {width} exceeds the limit {options.max_width}.",
                reference,
            )
        )
    if height is not None and height > options.max_height:
        diagnostics.append(
            _diagnostic(
                "ASSET_HEIGHT_LIMIT",
                Severity.ERROR,
                f"Image height {height} exceeds the limit {options.max_height}.",
                reference,
            )
        )
    _check_alt(reference, options, diagnostics)

    source = _relative_source(resolved, roots)
    spec = AssetSpec(
        asset_id=asset_id(kind="image", source=source, checksum=checksum),
        kind="image",
        source=source,
        attachment_filename=attachment_filename(resolved, source),
        mime_type=mime_type,
        sha256=checksum,
        size=size,
        width=width,
        height=height,
        alt_text=reference.alt_text or None,
    )
    return ImageResolution(spec, resolved, None, tuple(diagnostics))


def _resolved_roots(options: ImageOptions) -> tuple[Path, ...]:
    assert options.vault_root is not None
    candidates = (options.vault_root, *options.additional_roots)
    result: list[Path] = []
    for candidate in candidates:
        resolved = candidate.expanduser().resolve()
        if resolved not in result:
            result.append(resolved)
    return tuple(result)


def _find_local_image(
    reference: str, *, source_path: Path, roots: tuple[Path, ...]
) -> tuple[Path | None, bool, bool]:
    path = Path(reference.replace("\\", "/"))
    candidates: list[Path] = []
    if not path.is_absolute():
        candidates.append(source_path.parent / path)
        candidates.extend(root / path for root in roots)
    matches: list[Path] = []
    escaped = False
    for candidate in candidates:
        try:
            resolved = candidate.resolve(strict=False)
            inside = _inside_any(resolved, roots)
            regular_file = resolved.is_file()
        except OSError:
            continue
        if not inside:
            escaped = True
            continue
        if not regular_file:
            continue
        if resolved not in matches:
            matches.append(resolved)
    if not matches and len(path.parts) == 1:
        for root in roots:
            try:
                found = sorted(
                    (item.resolve() for item in root.rglob(path.name) if item.is_file()),
                    key=lambda item: item.as_posix().casefold(),
                )
            except OSError:
                continue
            for item in found:
                if _inside_any(item, roots) and item not in matches:
                    matches.append(item)
    return (
        matches[0] if len(matches) == 1 else None,
        len(matches) > 1,
        escaped and not matches,
    )


def _inside_any(path: Path, roots: tuple[Path, ...]) -> bool:
    return any(path == root or path.is_relative_to(root) for root in roots)


def _relative_source(path: Path, roots: tuple[Path, ...]) -> str:
    for index, root in enumerate(roots):
        if path == root or path.is_relative_to(root):
            relative = path.relative_to(root).as_posix()
            return relative if index == 0 else f"@asset-root-{index}/{relative}"
    raise ValueError("asset is outside approved roots")


def _sha256(path: Path, *, max_bytes: int) -> str:
    digest = hashlib.sha256()
    total = 0
    with path.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            total += len(chunk)
            if total > max_bytes:
                raise ValueError("image grew beyond the configured size limit while reading")
            digest.update(chunk)
    return digest.hexdigest()


def _dimensions(path: Path, suffix: str) -> tuple[int | None, int | None]:
    if suffix == ".png":
        with path.open("rb") as stream:
            header = stream.read(24)
        if len(header) < 24 or header[:8] != b"\x89PNG\r\n\x1a\n" or header[12:16] != b"IHDR":
            raise ValueError("invalid PNG header")
        return struct.unpack(">II", header[16:24])
    if suffix == ".gif":
        with path.open("rb") as stream:
            header = stream.read(10)
        if len(header) != 10 or header[:6] not in {b"GIF87a", b"GIF89a"}:
            raise ValueError("invalid GIF header")
        return struct.unpack("<HH", header[6:10])
    if suffix in {".jpg", ".jpeg"}:
        return _jpeg_dimensions(path)
    if suffix == ".webp":
        return _webp_dimensions(path)
    if suffix == ".svg":
        return _svg_dimensions(path)
    raise ValueError("unsupported image format")


def _jpeg_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        if stream.read(2) != b"\xff\xd8":
            raise ValueError("invalid JPEG header")
        while True:
            byte = stream.read(1)
            while byte == b"\xff":
                byte = stream.read(1)
            if not byte:
                break
            marker = byte[0]
            if marker in {0xD8, 0xD9}:
                continue
            length_data = stream.read(2)
            if len(length_data) != 2:
                break
            length = struct.unpack(">H", length_data)[0]
            if marker in {
                0xC0,
                0xC1,
                0xC2,
                0xC3,
                0xC5,
                0xC6,
                0xC7,
                0xC9,
                0xCA,
                0xCB,
                0xCD,
                0xCE,
                0xCF,
            }:
                data = stream.read(5)
                if len(data) != 5:
                    break
                height, width = struct.unpack(">HH", data[1:5])
                return width, height
            stream.seek(max(0, length - 2), 1)
    raise ValueError("JPEG dimensions were not found")


def _webp_dimensions(path: Path) -> tuple[int, int]:
    with path.open("rb") as stream:
        header = stream.read(30)
    if len(header) < 16 or header[:4] != b"RIFF" or header[8:12] != b"WEBP":
        raise ValueError("invalid WebP header")
    kind = header[12:16]
    if kind == b"VP8X" and len(header) >= 30:
        width = 1 + int.from_bytes(header[24:27], "little")
        height = 1 + int.from_bytes(header[27:30], "little")
        return width, height
    if kind == b"VP8 " and len(header) >= 30 and header[23:26] == b"\x9d\x01\x2a":
        width, height = struct.unpack("<HH", header[26:30])
        return width & 0x3FFF, height & 0x3FFF
    if kind == b"VP8L" and len(header) >= 25 and header[20] == 0x2F:
        bits = int.from_bytes(header[21:25], "little")
        return (bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1
    raise ValueError("unsupported WebP bitstream")


def _svg_dimensions(path: Path) -> tuple[int | None, int | None]:
    parser = etree.XMLParser(resolve_entities=False, load_dtd=False, no_network=True)
    tree = etree.parse(str(path), parser)
    if tree.docinfo.doctype:
        raise ValueError("SVG document type declarations are not allowed")
    root = tree.getroot()
    if etree.QName(root).localname.casefold() != "svg":
        raise ValueError("SVG root element is not <svg>")
    if tree.xpath("//processing-instruction()"):
        raise ValueError("SVG processing instructions are not allowed")
    _validate_svg_safety(root)
    width = _svg_number(root.get("width"))
    height = _svg_number(root.get("height"))
    if (width is None or height is None) and root.get("viewBox"):
        pieces = re.split(r"[ ,]+", root.get("viewBox", "").strip())
        if len(pieces) == 4:
            width = width or _positive_float_as_int(pieces[2])
            height = height or _positive_float_as_int(pieces[3])
    return width, height


def _validate_svg_safety(root: etree._Element) -> None:
    forbidden_elements = {
        "script",
        "style",
        "foreignobject",
        "iframe",
        "object",
        "embed",
        "animate",
        "animatemotion",
        "animatetransform",
        "set",
        "discard",
        "audio",
        "video",
    }
    safe_elements = {
        "svg",
        "g",
        "defs",
        "title",
        "desc",
        "path",
        "rect",
        "circle",
        "ellipse",
        "line",
        "polyline",
        "polygon",
        "text",
        "tspan",
        "use",
        "lineargradient",
        "radialgradient",
        "stop",
        "clippath",
        "mask",
        "pattern",
    }
    safe_attributes = {
        "id",
        "version",
        "width",
        "height",
        "viewbox",
        "preserveaspectratio",
        "x",
        "y",
        "x1",
        "x2",
        "y1",
        "y2",
        "cx",
        "cy",
        "r",
        "rx",
        "ry",
        "d",
        "points",
        "transform",
        "opacity",
        "fill",
        "fill-opacity",
        "fill-rule",
        "stroke",
        "stroke-width",
        "stroke-linecap",
        "stroke-linejoin",
        "stroke-opacity",
        "stroke-dasharray",
        "stroke-dashoffset",
        "clip-rule",
        "clip-path",
        "mask",
        "offset",
        "stop-color",
        "stop-opacity",
        "gradientunits",
        "gradienttransform",
        "patternunits",
        "patterncontentunits",
        "text-anchor",
        "dominant-baseline",
        "font-size",
        "font-family",
        "font-weight",
        "letter-spacing",
        "vector-effect",
        "href",
        "role",
        "aria-label",
    }
    local_fragment = re.compile(r"#[A-Za-z_][A-Za-z0-9_.:-]*")
    local_paint = re.compile(r"url\(\s*#[A-Za-z_][A-Za-z0-9_.:-]*\s*\)", re.IGNORECASE)
    simple_paint = re.compile(
        r"(?:none|currentcolor|transparent|#[0-9a-f]{3,8}|[a-z-]{1,32}|"
        r"(?:rgb|rgba|hsl|hsla)\([0-9.% ,+\-]{1,80}\))",
        re.IGNORECASE,
    )
    for element in root.iter():
        if not isinstance(element.tag, str):
            continue
        element_name = etree.QName(element).localname.casefold()
        if element_name in forbidden_elements:
            raise ValueError("SVG contains active content")
        if element_name not in safe_elements:
            raise ValueError("SVG contains an element outside the safe profile")
        for raw_name, value in element.attrib.items():
            name = etree.QName(raw_name).localname.casefold()
            folded_value = value.strip().casefold()
            if name.startswith("on"):
                raise ValueError("SVG event-handler attributes are not allowed")
            if name not in safe_attributes:
                raise ValueError("SVG contains an attribute outside the safe profile")
            if "\\" in folded_value or "/*" in folded_value:
                raise ValueError("SVG active style content is not allowed")
            if name == "href" and not local_fragment.fullmatch(folded_value):
                raise ValueError("SVG external resource references are not allowed")
            if name in {"clip-path", "mask"} and not local_paint.fullmatch(folded_value):
                raise ValueError("SVG external resource references are not allowed")
            if name in {"fill", "stroke"} and not (
                simple_paint.fullmatch(folded_value) or local_paint.fullmatch(folded_value)
            ):
                raise ValueError("SVG paint value is outside the safe profile")
            if "url(" in folded_value and not local_paint.fullmatch(folded_value):
                raise ValueError("SVG external resource references are not allowed")


def _svg_number(value: str | None) -> int | None:
    if value is None:
        return None
    match = re.fullmatch(r"\s*(\d+(?:\.\d+)?)(?:px)?\s*", value)
    return _positive_float_as_int(match.group(1)) if match else None


def _positive_float_as_int(value: str) -> int | None:
    number = float(value)
    return max(1, round(number)) if number > 0 else None


def _check_alt(
    reference: ImageReference, options: ImageOptions, diagnostics: list[Diagnostic]
) -> None:
    if options.require_alt_text and not reference.alt_text.strip():
        diagnostics.append(
            _diagnostic(
                "ASSET_MISSING_ALT",
                Severity.WARNING,
                f"Image has no alternative text: {reference.source}",
                reference,
                "Add descriptive alt text or mark it decorative in page policy.",
            )
        )


def _diagnostic(
    code: str,
    severity: Severity,
    message: str,
    reference: ImageReference,
    hint: str | None = None,
) -> Diagnostic:
    return Diagnostic(code, severity, message, reference.span, hint)
