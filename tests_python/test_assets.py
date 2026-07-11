import asyncio
import struct
from pathlib import Path

import pytest

from md2conf_dc.assets.images import ImageOptions, ImageReference, resolve_image
from md2conf_dc.assets.mermaid import (
    MermaidOptions,
    MermaidQuality,
    MermaidService,
    UnavailableMermaidRenderer,
)


def _write_png(path: Path, *, width: int = 2, height: int = 3) -> None:
    # The asset inspector intentionally needs only the signature and IHDR header.
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", width, height)
        + b"\x08\x06\x00\x00\x00"
    )


def test_local_image_resolution_is_bounded_and_stable(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    notes = vault / "notes"
    images = vault / "images"
    notes.mkdir(parents=True)
    images.mkdir()
    image = images / "diagram.png"
    _write_png(image, width=640, height=480)

    relative = resolve_image(
        ImageReference("../images/diagram.png", "Architecture"),
        source_path=notes / "page.md",
        options=ImageOptions(vault_root=vault),
    )

    # Obsidian-relative parent links work when their canonical target remains in-root.
    assert relative.ok
    assert relative.source_path == image.resolve()

    traversal = resolve_image(
        ImageReference("../../../outside.png", "Outside"),
        source_path=notes / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    encoded = resolve_image(
        ImageReference("%2e%2e/images/diagram.png", "Encoded"),
        source_path=notes / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    assert not traversal.ok and not encoded.ok
    assert traversal.diagnostics[0].code == "ASSET_PATH_TRAVERSAL"
    assert encoded.diagnostics[0].code == "ASSET_PATH_TRAVERSAL"

    result = resolve_image(
        ImageReference("images/diagram.png", "Architecture"),
        source_path=vault / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    assert result.ok
    assert result.spec is not None
    assert (result.spec.width, result.spec.height) == (640, 480)
    assert result.spec.source == "images/diagram.png"
    assert result.spec.attachment_filename is not None
    assert result.spec.attachment_filename.startswith("diagram-")

    first_id = result.spec.asset_id
    first_name = result.spec.attachment_filename
    first_checksum = result.spec.sha256
    _write_png(image, width=800, height=480)
    changed = resolve_image(
        ImageReference("images/diagram.png", "Architecture"),
        source_path=vault / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    assert changed.spec is not None
    assert changed.spec.asset_id == first_id
    assert changed.spec.attachment_filename == first_name
    assert changed.spec.sha256 != first_checksum


def test_external_image_is_not_downloaded_and_unsafe_scheme_is_rejected(
    tmp_path: Path,
) -> None:
    options = ImageOptions(vault_root=tmp_path)
    external = resolve_image(
        ImageReference("https://static.example.test/a.png", "A"),
        source_path=tmp_path / "page.md",
        options=options,
    )
    unsafe = resolve_image(
        ImageReference("data:image/png;base64,AAAA", "A"),
        source_path=tmp_path / "page.md",
        options=options,
    )

    assert external.ok and external.external_url is not None
    assert external.spec is None and external.source_path is None
    assert not unsafe.ok
    assert unsafe.diagnostics[0].code == "ASSET_UNSAFE_SCHEME"


class _FakeMermaidRenderer:
    calls = 0

    @property
    def identity(self) -> str:
        return "fake-mermaid-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del source, scale
        self.calls += 1
        _write_png(destination, width=20, height=10)


@pytest.mark.asyncio
async def test_mermaid_service_caches_and_verifies_png(tmp_path: Path) -> None:
    backend = _FakeMermaidRenderer()
    service = MermaidService(
        backend,
        MermaidOptions(cache_dir=tmp_path, quality=MermaidQuality.HIGH),
    )

    first = await service.render("graph TD; A-->B", alt_text="Flow")
    second = await service.render("graph TD; A-->B", alt_text="Flow")

    assert first.ok and second.ok
    assert backend.calls == 1
    assert not first.cache_hit and second.cache_hit
    assert first.spec is not None and second.spec is not None
    assert first.spec.attachment_filename == second.spec.attachment_filename


def test_image_errors_are_typed_and_missing_alt_is_visible(tmp_path: Path) -> None:
    png = tmp_path / "large.png"
    _write_png(png, width=640, height=480)

    missing_root = resolve_image(
        ImageReference("large.png", "A"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(),
    )
    missing_file = resolve_image(
        ImageReference("missing.png", "A"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )
    oversized = resolve_image(
        ImageReference("large.png", "A"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path, max_bytes=8),
    )
    clamped = resolve_image(
        ImageReference("large.png", "", width=1000, height=900),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )
    limited = resolve_image(
        ImageReference("large.png", "A"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path, max_width=100, max_height=100),
    )

    assert missing_root.diagnostics[0].code == "ASSET_MISSING_VAULT_ROOT"
    assert missing_file.diagnostics[0].code == "ASSET_NOT_FOUND"
    assert oversized.diagnostics[0].code == "ASSET_TOO_LARGE"
    assert clamped.spec is not None
    assert (clamped.spec.width, clamped.spec.height) == (640, 480)
    assert {item.code for item in clamped.diagnostics} >= {
        "ASSET_DIMENSION_CLAMPED",
        "ASSET_MISSING_ALT",
    }
    assert not limited.ok
    assert {item.code for item in limited.diagnostics} >= {
        "ASSET_WIDTH_LIMIT",
        "ASSET_HEIGHT_LIMIT",
    }


def test_external_image_policy_and_url_safety(tmp_path: Path) -> None:
    options = ImageOptions(vault_root=tmp_path)
    disabled = resolve_image(
        ImageReference("https://example.test/image.png", "A"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path, allow_external=False),
    )
    no_host = resolve_image(
        ImageReference("https:///image.png", "A"),
        source_path=tmp_path / "page.md",
        options=options,
    )
    credentials = resolve_image(
        ImageReference("https://user:secret@example.test/image.png", "A"),
        source_path=tmp_path / "page.md",
        options=options,
    )
    fragment = resolve_image(
        ImageReference("https://example.test/image.png#fragment", "A"),
        source_path=tmp_path / "page.md",
        options=options,
    )

    assert disabled.diagnostics[0].code == "ASSET_EXTERNAL_DISABLED"
    assert no_host.diagnostics[0].code == "ASSET_INVALID_EXTERNAL_URL"
    assert credentials.diagnostics[0].code == "ASSET_INVALID_EXTERNAL_URL"
    assert fragment.diagnostics[0].code == "ASSET_INVALID_EXTERNAL_URL"


def test_ambiguous_unsupported_and_external_symlink_assets_fail(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    (vault / "one").mkdir(parents=True)
    (vault / "two").mkdir()
    _write_png(vault / "one" / "same.png")
    _write_png(vault / "two" / "same.png")
    (vault / "bad.bmp").write_bytes(b"BM")

    ambiguous = resolve_image(
        ImageReference("same.png", "Same"),
        source_path=vault / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    unsupported = resolve_image(
        ImageReference("bad.bmp", "Bitmap"),
        source_path=vault / "page.md",
        options=ImageOptions(vault_root=vault),
    )
    outside = tmp_path / "outside.png"
    _write_png(outside)
    (vault / "escape.png").symlink_to(outside)
    escaped = resolve_image(
        ImageReference("escape.png", "Escape"),
        source_path=vault / "page.md",
        options=ImageOptions(vault_root=vault),
    )

    assert ambiguous.diagnostics[0].code == "ASSET_AMBIGUOUS"
    assert unsupported.diagnostics[0].code == "ASSET_UNSUPPORTED_FORMAT"
    assert escaped.diagnostics[0].code == "ASSET_PATH_TRAVERSAL"


def test_hostile_image_reference_is_bounded_and_never_echoed(tmp_path: Path) -> None:
    sentinel = "TOPSECRET-IMAGE-REFERENCE"
    reference = f"{sentinel}-{'x' * 1_000}"

    result = resolve_image(
        ImageReference(reference, "Hostile"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )

    assert not result.ok
    assert result.diagnostics[0].code in {
        "ASSET_PATH_TRAVERSAL",
        "ASSET_REFERENCE_INVALID",
    }
    assert sentinel not in repr(result.diagnostics)


def test_supported_gif_jpeg_webp_and_safe_svg_dimensions(tmp_path: Path) -> None:
    gif = tmp_path / "sample.gif"
    gif.write_bytes(b"GIF89a" + struct.pack("<HH", 7, 9))
    jpeg = tmp_path / "sample.jpg"
    jpeg.write_bytes(b"\xff\xd8\xff\xc0\x00\x07\x08" + struct.pack(">HH", 11, 13) + b"\xff\xd9")
    webp = tmp_path / "sample.webp"
    webp_header = bytearray(b"RIFF\x16\x00\x00\x00WEBPVP8X\x0a\x00\x00\x00" + b"\x00" * 10)
    webp_header[24:27] = (16).to_bytes(3, "little")
    webp_header[27:30] = (18).to_bytes(3, "little")
    webp.write_bytes(webp_header)
    svg = tmp_path / "sample.svg"
    svg.write_text('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 30"/>')

    expected = {
        "sample.gif": (7, 9),
        "sample.jpg": (13, 11),
        "sample.webp": (17, 19),
        "sample.svg": (20, 30),
    }
    for filename, dimensions in expected.items():
        result = resolve_image(
            ImageReference(filename, "Sample"),
            source_path=tmp_path / "page.md",
            options=ImageOptions(vault_root=tmp_path),
        )
        assert result.ok, result.diagnostics
        assert result.spec is not None
        assert (result.spec.width, result.spec.height) == dimensions


def test_active_svg_is_rejected(tmp_path: Path) -> None:
    svg = tmp_path / "active.svg"
    svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        "<script>alert(1)</script></svg>"
    )

    result = resolve_image(
        ImageReference("active.svg", "Active"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )

    assert not result.ok
    assert result.diagnostics[0].code == "ASSET_INVALID_IMAGE"


def test_invalid_svg_diagnostic_does_not_echo_source_markup(tmp_path: Path) -> None:
    sentinel = "TOPSECRET-SVG-TAG"
    svg = tmp_path / "invalid.svg"
    svg.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><{sentinel}></svg>',
        encoding="utf-8",
    )

    result = resolve_image(
        ImageReference("invalid.svg", "Invalid"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )

    assert not result.ok
    assert result.diagnostics[0].code == "ASSET_INVALID_IMAGE"
    assert sentinel not in repr(result.diagnostics)


@pytest.mark.parametrize(
    "active_content",
    [
        "<style>@import url(https://evil.example/x.css);</style>",
        '<set href="#x" attributeName="href" to="https://evil.example/"/>',
        "<?xml-stylesheet href='https://evil.example/x.css'?>",
        '<image href="/rest/api/content/123" width="10" height="10"/>',
        '<image href="relative.png" width="10" height="10"/>',
        '<image href="../relative.png" width="10" height="10"/>',
        '<rect style="fill: red" width="10" height="10"/>',
        '<rect fill="url(https://evil.example/pattern.svg)" width="10" height="10"/>',
        '<rect fill="u\\72l(https://evil.example/pattern.svg)" width="10" height="10"/>',
        '<use xml:base="https://evil.example/" href="#shape"/>',
    ],
)
def test_svg_css_smil_and_processing_instructions_are_rejected(
    tmp_path: Path, active_content: str
) -> None:
    svg = tmp_path / "active.svg"
    svg.write_text(
        f'<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">{active_content}</svg>'
    )
    result = resolve_image(
        ImageReference("active.svg", "Active"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )
    assert not result.ok
    assert result.diagnostics[0].code == "ASSET_INVALID_IMAGE"


def test_svg_local_fragment_reference_is_allowed(tmp_path: Path) -> None:
    svg = tmp_path / "fragment.svg"
    svg.write_text(
        '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10">'
        '<path id="shape" d="M0 0h1v1z"/><use href="#shape"/></svg>',
        encoding="utf-8",
    )
    result = resolve_image(
        ImageReference("fragment.svg", "Fragment"),
        source_path=tmp_path / "page.md",
        options=ImageOptions(vault_root=tmp_path),
    )
    assert result.ok


class _NoOutputRenderer:
    @property
    def identity(self) -> str:
        return "no-output-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del source, scale, destination


class _SlowRenderer:
    @property
    def identity(self) -> str:
        return "slow-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del source, scale, destination
        await asyncio.sleep(0.1)


class _TinyRenderer:
    @property
    def identity(self) -> str:
        return "tiny-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del source, scale
        _write_png(destination, width=1, height=1)


class _LeakyRenderer:
    @property
    def identity(self) -> str:
        return "leaky-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del scale, destination
        raise RuntimeError(f"backend copied source: {source}")


@pytest.mark.asyncio
async def test_mermaid_failure_modes_are_visible(tmp_path: Path) -> None:
    unavailable = await MermaidService(
        UnavailableMermaidRenderer(), MermaidOptions(cache_dir=tmp_path / "unavailable")
    ).render("A-->B", alt_text="A")
    no_output = await MermaidService(
        _NoOutputRenderer(), MermaidOptions(cache_dir=tmp_path / "none")
    ).render("A-->B", alt_text="A")
    timeout = await MermaidService(
        _SlowRenderer(),
        MermaidOptions(cache_dir=tmp_path / "slow", timeout_seconds=0.001),
    ).render("A-->B", alt_text="A")
    tiny = await MermaidService(
        _TinyRenderer(), MermaidOptions(cache_dir=tmp_path / "tiny")
    ).render("A-->B", alt_text="A")
    too_large = await MermaidService(
        _FakeMermaidRenderer(),
        MermaidOptions(cache_dir=tmp_path / "large", max_source_characters=2),
    ).render("A-->B", alt_text="A")
    wrong_format = await MermaidService(
        _FakeMermaidRenderer(),
        MermaidOptions(cache_dir=tmp_path / "format", output_format="svg"),
    ).render("A-->B", alt_text="A")
    sentinel = "TOPSECRET-MERMAID-SOURCE"
    leaky = await MermaidService(
        _LeakyRenderer(), MermaidOptions(cache_dir=tmp_path / "leaky")
    ).render(sentinel, alt_text="A")

    assert unavailable.diagnostics[0].code == "MERMAID_RENDER_FAILED"
    assert no_output.diagnostics[0].code == "MERMAID_RENDER_FAILED"
    assert timeout.diagnostics[0].code == "MERMAID_TIMEOUT"
    assert tiny.diagnostics[0].code == "MERMAID_INVALID_OUTPUT"
    assert too_large.diagnostics[0].code == "MERMAID_SOURCE_TOO_LARGE"
    assert wrong_format.diagnostics[0].code == "MERMAID_OUTPUT_UNSUPPORTED"
    assert leaky.diagnostics[0].code == "MERMAID_RENDER_FAILED"
    assert sentinel not in repr(leaky.diagnostics)


@pytest.mark.asyncio
async def test_mermaid_version_participates_in_cache_filename(tmp_path: Path) -> None:
    backend = _FakeMermaidRenderer()
    one = await MermaidService(
        backend,
        MermaidOptions(cache_dir=tmp_path, mermaid_version="10.9.0"),
    ).render("A-->B", alt_text="A")
    two = await MermaidService(
        backend,
        MermaidOptions(cache_dir=tmp_path, mermaid_version="11.0.0"),
    ).render("A-->B", alt_text="A")

    assert one.ok and two.ok
    assert one.spec is not None and two.spec is not None
    assert one.spec.attachment_filename != two.spec.attachment_filename
