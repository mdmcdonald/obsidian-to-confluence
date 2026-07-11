import hashlib
import struct
from pathlib import Path
from types import MappingProxyType

from md2conf_dc.models import AssetSpec, RenderContext
from md2conf_dc.render.policy import MetadataField, MetadataValue
from md2conf_dc.render.storage import (
    InternalLinkReference,
    LatexCapability,
    MathFallbackPolicy,
    MathOptions,
    RawHtmlPolicy,
    RenderLimits,
    ResolvedInternalLink,
    StorageOptions,
    TocMode,
    UnresolvedLinkPolicy,
    render_markdown,
)
from md2conf_dc.render.xml import canonicalize_storage, validate_storage


def _context(tmp_path: Path, *, policy: str = "minimal") -> RenderContext:
    return RenderContext(
        vault_root=tmp_path,
        final_titles=MappingProxyType(
            {"docs/target.md": "Published Target", "Target.md": "Target"}
        ),
        policy=policy,
    )


def test_core_storage_is_well_formed_deterministic_and_resolves_links(
    tmp_path: Path,
) -> None:
    source = (
        "## Unicode & escaping <ok>\n\n"
        "Paragraph **strong** ~~gone~~ [target](target.md#Part).\n\n"
        "3. third\n4. fourth\n\n"
        "~~~python\nvalue contains a CDATA terminator: ]]>\n~~~\n\n"
        "| Name | Value |\n| :--- | ---: |\n| A | B |\n"
    )
    context = _context(tmp_path)

    first = render_markdown(
        source,
        source_path=Path("docs/source.md"),
        context=context,
    )
    second = render_markdown(
        source,
        source_path=Path("docs/source.md"),
        context=context,
    )

    assert first.ok, first.diagnostics
    assert first.storage_value == second.storage_value
    assert first.storage_sha256 == second.storage_sha256
    assert '<ol start="3">' in first.storage_value
    assert 'ri:content-title="Published Target"' in first.storage_value
    assert "]]]]><![CDATA[>" in first.storage_value
    assert validate_storage(first.storage_value).ok
    assert canonicalize_storage(first.storage_value) == first.canonical_value


def test_tasks_are_not_wrapped_in_a_normal_list(tmp_path: Path) -> None:
    result = render_markdown(
        "- [x] done\n- [ ] later\n",
        source_path=Path("tasks.md"),
        context=_context(tmp_path),
    )

    assert result.ok
    assert result.storage_value.startswith("<ac:task-list>")
    assert "<ul>" not in result.storage_value
    assert "<li>" not in result.storage_value


def test_directive_parameter_allowlist_fails_closed(tmp_path: Path) -> None:
    result = render_markdown(
        "::: confluence:children {depth=999 injected=yes}\n:::\n",
        source_path=Path("directive.md"),
        context=_context(tmp_path),
    )

    assert not result.ok
    assert {item.code for item in result.diagnostics} >= {
        "DIRECTIVE_INVALID_PARAMETER",
        "DIRECTIVE_UNKNOWN_PARAMETER",
    }
    assert "injected" not in result.storage_value


def test_raw_html_is_rendered_as_text(tmp_path: Path) -> None:
    result = render_markdown(
        '<script data-x="1">bad()</script>\n',
        source_path=Path("safe.md"),
        context=_context(tmp_path),
    )

    assert result.ok
    assert "<script" not in result.storage_value
    assert "&lt;script" in result.storage_value


def test_policy_identity_and_output_participate_in_hash(tmp_path: Path) -> None:
    source = "## One\n\n## Two\n\n## Three\n"

    minimal = render_markdown(
        source,
        source_path=Path("page.md"),
        context=_context(tmp_path, policy="minimal"),
    )
    knowledge = render_markdown(
        source,
        source_path=Path("page.md"),
        context=_context(tmp_path, policy="knowledge-base"),
    )

    assert minimal.ok and knowledge.ok
    assert minimal.policy_id != knowledge.policy_id
    assert minimal.input_sha256 != knowledge.input_sha256
    assert 'ac:name="toc"' in knowledge.storage_value


def test_invalid_storage_returns_typed_diagnostic() -> None:
    sentinel = "TOPSECRET-ALPHA"
    result = validate_storage(f"<p><{sentinel}></p>")
    assert not result.ok
    assert result.diagnostics[0].code == "STORAGE_INVALID_XML"
    assert sentinel not in repr(result.diagnostics)


def test_raw_html_policy_is_safe_and_fail_mode_is_visible(tmp_path: Path) -> None:
    sentinel = "TOPSECRET-HTML-VALUE"
    escaped = render_markdown(
        f"<unsafe>{sentinel}</unsafe>",
        source_path=tmp_path / "page.md",
        context=_context(tmp_path, policy="minimal"),
    )
    assert escaped.ok
    assert "&lt;unsafe&gt;" in escaped.storage_value

    refused = render_markdown(
        f"<unsafe>{sentinel}</unsafe>",
        source_path=tmp_path / "page.md",
        context=_context(tmp_path, policy="minimal"),
        options=StorageOptions(raw_html_policy=RawHtmlPolicy.FAIL),
    )
    assert not refused.ok
    assert any(item.code == "RAW_HTML_FORBIDDEN" for item in refused.diagnostics)
    assert sentinel not in repr(refused.diagnostics)


def test_toc_mode_overrides_automatic_policy_decoration(tmp_path: Path) -> None:
    source = "# One\n\n## Two\n\n### Three\n"
    always = render_markdown(
        "Short page",
        source_path=tmp_path / "always.md",
        context=_context(tmp_path, policy="minimal"),
        options=StorageOptions(toc_mode=TocMode.ALWAYS),
    )
    never = render_markdown(
        source,
        source_path=tmp_path / "never.md",
        context=_context(tmp_path, policy="knowledge-base"),
        options=StorageOptions(toc_mode=TocMode.NEVER),
    )
    assert 'ac:name="toc"' in always.storage_value
    assert 'ac:name="toc"' not in never.storage_value


def test_math_uses_explicit_capability_or_visible_stock_fallback(tmp_path: Path) -> None:
    source = "Inline $x < y$.\n\n$$\na^2 + b^2\n$$\n"

    fallback = render_markdown(
        source,
        source_path=Path("math.md"),
        context=_context(tmp_path),
    )
    capable = render_markdown(
        source,
        source_path=Path("math.md"),
        context=_context(tmp_path),
        options=StorageOptions(math=MathOptions(capability=LatexCapability(version="6.0.0"))),
    )
    strict = render_markdown(
        source,
        source_path=Path("math.md"),
        context=_context(tmp_path),
        options=StorageOptions(math=MathOptions(fallback=MathFallbackPolicy.FAIL)),
    )

    assert fallback.ok
    assert "MATH_STOCK_FALLBACK" in {item.code for item in fallback.diagnostics}
    assert "fallback=stock-code" in fallback.policy_id
    assert 'ac:name="mathinline"' in capable.storage_value
    assert 'ac:name="mathblock"' in capable.storage_value
    assert "x &lt; y" not in capable.storage_value  # Math is safely CDATA encoded.
    assert capable.ok
    assert not strict.ok
    assert "MATH_CAPABILITY_REQUIRED" in {item.code for item in strict.diagnostics}


class _IndexResolver:
    @property
    def identity(self) -> str:
        return "test-global-index-v1"

    def resolve(self, reference: InternalLinkReference) -> ResolvedInternalLink | None:
        if reference.target == "Draft":
            return ResolvedInternalLink("Draft Page", published=False)
        if reference.target == "ById":
            return ResolvedInternalLink("Resolved by source ID", "canonical-anchor")
        return None


class _LeakyResolver:
    @property
    def identity(self) -> str:
        return "leaky-resolver-v1"

    def resolve(self, reference: InternalLinkReference) -> ResolvedInternalLink | None:
        raise RuntimeError(f"resolver copied target: {reference.target}")


def test_internal_link_resolver_hook_and_unpublished_policy(tmp_path: Path) -> None:
    result = render_markdown(
        "[[ById#Requested|Resolved]] and [[Draft]].\n",
        source_path=Path("source.md"),
        context=_context(tmp_path),
        options=StorageOptions(
            link_resolver=_IndexResolver(),
            unresolved_link_policy=UnresolvedLinkPolicy.FAIL,
        ),
    )

    assert not result.ok
    assert 'ri:content-title="Resolved by source ID"' in result.storage_value
    assert 'ac:anchor="canonical-anchor"' in result.storage_value
    assert "Draft Page" not in result.storage_value
    assert "LINK_UNPUBLISHED" in {item.code for item in result.diagnostics}
    assert "test-global-index-v1" in result.policy_id


def test_link_resolver_failures_do_not_echo_source_or_extension_errors(tmp_path: Path) -> None:
    sentinel = "TOPSECRET-LINK-TARGET"
    result = render_markdown(
        f"[[{sentinel}]]",
        source_path=Path("source.md"),
        context=_context(tmp_path),
        options=StorageOptions(link_resolver=_LeakyResolver()),
    )

    assert not result.ok
    assert any(item.code == "LINK_RESOLVER_FAILED" for item in result.diagnostics)
    resolver_diagnostics = tuple(
        item for item in result.diagnostics if item.code == "LINK_RESOLVER_FAILED"
    )
    assert sentinel not in repr(resolver_diagnostics)


def test_unresolved_link_diagnostics_are_bounded_and_body_free(tmp_path: Path) -> None:
    sentinel = "TOPSECRET-LINK-REFERENCE"
    result = render_markdown(
        f"[[{sentinel}{'x' * 1_000}]]",
        source_path=Path("source.md"),
        context=_context(tmp_path),
    )

    assert any(item.code == "LINK_UNRESOLVED" for item in result.diagnostics)
    assert sentinel not in repr(result.diagnostics)


def test_mixed_task_and_normal_list_preserves_both_semantics(tmp_path: Path) -> None:
    result = render_markdown(
        "- [x] task\n- ordinary\n- [ ] another task\n",
        source_path=Path("mixed.md"),
        context=_context(tmp_path),
    )

    assert result.ok
    assert result.storage_value.count("<ac:task-list>") == 2
    assert "<ul><li><p>ordinary</p></li></ul>" in result.storage_value
    assert "<ul><li><ac:task" not in result.storage_value


def test_nested_callout_panel_is_flattened_with_diagnostic(tmp_path: Path) -> None:
    source = "> [!NOTE] Outer\n> > [!TIP] Inner\n> > Nested body\n"

    result = render_markdown(
        source,
        source_path=Path("callouts.md"),
        context=_context(tmp_path),
    )

    assert result.ok
    assert result.storage_value.count('ac:name="note"') == 1
    assert 'ac:name="tip"' not in result.storage_value
    assert "NESTED_PANEL_FLATTENED" in {item.code for item in result.diagnostics}


def test_macro_registry_covers_layout_and_stock_index_macros(tmp_path: Path) -> None:
    source = (
        "::: confluence:page-tree {root=Home start-depth=2 search-box=true}\n:::\n\n"
        "::: confluence:page-properties-report {labels=approved title=Portfolio}\n:::\n\n"
        "::: confluence:content-by-label {labels=architecture,approved operator=and}\n:::\n\n"
        "::: confluence:layout {type=two-equal}\nLeft\n\n---\n\nRight\n:::\n"
    )

    result = render_markdown(
        source,
        source_path=Path("macros.md"),
        context=_context(tmp_path),
    )

    assert result.ok, result.diagnostics
    assert 'ac:name="pagetree"' in result.storage_value
    assert 'ac:name="detailssummary"' in result.storage_value
    assert 'ac:name="contentbylabel"' in result.storage_value
    assert '<ac:layout-section ac:type="two_equal">' in result.storage_value


def test_empty_rich_macro_is_rejected(tmp_path: Path) -> None:
    result = render_markdown(
        "::: confluence:expand {title=Empty}\n:::\n",
        source_path=Path("empty.md"),
        context=_context(tmp_path),
    )

    assert not result.ok
    assert "DIRECTIVE_BODY_REQUIRED" in {item.code for item in result.diagnostics}


def _write_png(path: Path, *, width: int = 640, height: int = 480) -> None:
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + struct.pack(">I", 13)
        + b"IHDR"
        + struct.pack(">II", width, height)
        + b"\x08\x06\x00\x00\x00"
    )


def test_local_and_external_images_render_with_asset_provenance(tmp_path: Path) -> None:
    images = tmp_path / "images"
    images.mkdir()
    local = images / "diagram.png"
    _write_png(local)
    source = (
        "![[images/diagram.png|Architecture|900x700]]\n\n"
        "![Remote](https://static.example.test/remote.png)\n"
    )

    first = render_markdown(
        source,
        source_path=Path("page.md"),
        context=_context(tmp_path),
    )
    local.write_bytes(local.read_bytes() + b"changed")
    second = render_markdown(
        source,
        source_path=Path("page.md"),
        context=_context(tmp_path),
    )

    assert first.ok and second.ok
    assert len(first.assets) == 1
    assert len(first.resolved_asset_sources) == 1
    assert first.resolved_asset_sources[0].path == local.resolve()
    assert '<ri:attachment ri:filename="diagram-' in first.storage_value
    assert '<ri:url ri:value="https://static.example.test/remote.png"' in first.storage_value
    assert 'ac:width="640"' in first.storage_value
    assert 'ac:height="480"' in first.storage_value
    assert first.input_sha256 != second.input_sha256


def test_unresolved_link_policies_and_unsafe_external_links(tmp_path: Path) -> None:
    source = (
        "[[Missing]] [unsafe](javascript:alert(1)) "
        "[credentials](https://user:secret@example.test/) [relative](//example.test/x)\n"
    )
    text_only = render_markdown(
        source,
        source_path=Path("page.md"),
        context=_context(tmp_path),
        options=StorageOptions(unresolved_link_policy=UnresolvedLinkPolicy.TEXT),
    )
    strict = render_markdown(
        "[[Missing]]\n",
        source_path=Path("page.md"),
        context=_context(tmp_path),
        options=StorageOptions(unresolved_link_policy=UnresolvedLinkPolicy.FAIL),
    )

    assert "LINK_UNRESOLVED" not in {item.code for item in text_only.diagnostics}
    assert {item.code for item in text_only.diagnostics} >= {
        "LINK_CREDENTIALS_REJECTED",
        "LINK_SCHEME_REQUIRED",
    }
    assert "javascript:alert(1)" in text_only.storage_value
    assert not strict.ok
    assert "LINK_UNRESOLVED" in {item.code for item in strict.diagnostics}


def test_remaining_stock_macro_contracts_render_from_typed_directives(tmp_path: Path) -> None:
    source = (
        "::: confluence:toc {min-level=2 max-level=4 printable=true}\n:::\n\n"
        "::: confluence:children {depth=2 reverse=false}\n:::\n\n"
        "::: confluence:status {colour=Blue}\nReady\n:::\n\n"
        "::: confluence:expand {title=Details}\nRich **body**.\n:::\n\n"
        "::: confluence:excerpt {hidden=false}\nSummary.\n:::\n\n"
        "::: confluence:excerpt-include {page=Home}\n:::\n\n"
        "::: confluence:page-properties\n"
        "| Field | Value |\n| --- | --- |\n| Owner | Team |\n:::\n\n"
        "::: confluence:anchor {name=stable-anchor}\n:::\n\n"
        "::: confluence:tip {title=Hint}\nUseful.\n:::\n"
    )

    result = render_markdown(
        source,
        source_path=Path("directives.md"),
        context=_context(tmp_path),
    )

    assert result.ok, result.diagnostics
    for macro in (
        "toc",
        "children",
        "status",
        "expand",
        "excerpt",
        "excerpt-include",
        "details",
        "anchor",
        "tip",
    ):
        assert f'ac:name="{macro}"' in result.storage_value


def test_render_limits_fail_safely_and_discard_oversized_storage(tmp_path: Path) -> None:
    options = StorageOptions(
        limits=RenderLimits(
            max_blocks=1,
            max_links=0,
            max_macros=0,
            max_table_cells=0,
            max_assets=0,
            max_storage_characters=2,
        )
    )

    result = render_markdown(
        "[link](https://example.test)\n\n~~~text\ncode\n~~~\n\n"
        "| H |\n| --- |\n| V |\n\n![A](missing.png)\n",
        source_path=Path("limits.md"),
        context=_context(tmp_path),
        options=options,
    )

    assert not result.ok
    codes = {item.code for item in result.diagnostics}
    assert "RENDER_LINK_LIMIT" in codes
    assert "RENDER_BLOCK_LIMIT" in codes
    assert "STORAGE_SIZE_LIMIT" in codes
    assert result.storage_value == ""


def test_individual_macro_table_and_asset_limits(tmp_path: Path) -> None:
    macro = render_markdown(
        "~~~text\ncode\n~~~\n",
        source_path=Path("macro.md"),
        context=_context(tmp_path),
        options=StorageOptions(limits=RenderLimits(max_macros=0)),
    )
    table = render_markdown(
        "| H |\n| --- |\n| V |\n",
        source_path=Path("table.md"),
        context=_context(tmp_path),
        options=StorageOptions(limits=RenderLimits(max_table_cells=0)),
    )
    asset = render_markdown(
        "![A](missing.png)\n",
        source_path=Path("asset.md"),
        context=_context(tmp_path),
        options=StorageOptions(limits=RenderLimits(max_assets=0)),
    )

    assert "RENDER_MACRO_LIMIT" in {item.code for item in macro.diagnostics}
    assert "RENDER_TABLE_CELL_LIMIT" in {item.code for item in table.diagnostics}
    assert "RENDER_ASSET_LIMIT" in {item.code for item in asset.diagnostics}


def test_prepared_mermaid_asset_is_rendered_and_exposes_source(tmp_path: Path) -> None:
    diagram_source = "graph TD; A-->B\n"
    key = hashlib.sha256(diagram_source.encode()).hexdigest()
    png = tmp_path / "mermaid.png"
    _write_png(png, width=20, height=10)
    asset = AssetSpec(
        asset_id="mermaid-asset",
        kind="mermaid",
        source=f"mermaid:{key}",
        attachment_filename="mermaid-test.png",
        mime_type="image/png",
        sha256="a" * 64,
        size=png.stat().st_size,
        width=20,
        height=10,
        alt_text="Diagram",
    )

    result = render_markdown(
        f"~~~mermaid\n{diagram_source}~~~\n",
        source_path=Path("diagram.md"),
        context=_context(tmp_path),
        options=StorageOptions(
            mermaid_assets=MappingProxyType({key: asset}),
            mermaid_asset_sources=MappingProxyType({key: png}),
        ),
    )

    assert result.ok
    assert 'ri:filename="mermaid-test.png"' in result.storage_value
    assert result.resolved_asset_sources[0].path == png


def test_typed_metadata_decorator_escapes_values_and_skips_empty_sets(tmp_path: Path) -> None:
    fields = (
        MetadataField.scalar("<Owner>", 'Team </td><script>alert("x")</script>'),
        MetadataField.scalar("Approved", True),
        MetadataField(
            "Tags",
            (MetadataValue("architecture"), MetadataValue("safety & assurance")),
        ),
        MetadataField("Empty", (MetadataValue("  "),)),
    )

    decorated = render_markdown(
        "Body.\n",
        source_path=Path("metadata.md"),
        context=_context(tmp_path),
        metadata_fields=fields,
    )
    quiet = render_markdown(
        "Body.\n",
        source_path=Path("metadata.md"),
        context=_context(tmp_path),
        metadata_fields=(),
    )

    assert decorated.ok
    assert decorated.storage_value.startswith(
        '<ac:structured-macro ac:name="details"><ac:rich-text-body><table>'
    )
    assert "<th" not in decorated.storage_value
    assert "&lt;Owner&gt;" in decorated.storage_value
    assert "&lt;/td&gt;&lt;script&gt;" in decorated.storage_value
    assert "safety &amp; assurance" in decorated.storage_value
    assert "<script>" not in decorated.storage_value
    assert 'ac:name="details"' not in quiet.storage_value


def test_typed_metadata_validation_is_diagnostic_not_markup(tmp_path: Path) -> None:
    result = render_markdown(
        "Body.\n",
        source_path=Path("metadata.md"),
        context=_context(tmp_path),
        metadata_fields=(
            MetadataField.scalar("Owner", "One"),
            MetadataField.scalar("owner", "Two"),
            MetadataField.scalar(" ", "Bad"),
        ),
    )

    assert not result.ok
    assert {item.code for item in result.diagnostics} >= {
        "METADATA_DUPLICATE_LABEL",
        "METADATA_EMPTY_LABEL",
    }
