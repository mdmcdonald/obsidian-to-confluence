from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from md2conf_dc.frontmatter import (
    parse_frontmatter,
    plan_identity_writeback,
    plan_publish_frontmatter,
    set_publish_frontmatter,
    write_identity_frontmatter,
)
from md2conf_dc.models import ContentKind


def test_frontmatter_parses_legacy_controls_strictly() -> None:
    source_id = str(uuid4())
    parsed = parse_frontmatter(
        f"""---
connie-publish: true
connie-title: Guide
connie-frontmatter-to-publish: [owner, status]
tags: alpha, beta
connie-page-id: '123'
connie-source-id: {source_id}
connie-dont-change-parent-page: true
connie-blog-post-date: 2026-07-11
connie-content-type: blogpost
owner: Team
---
Body
""",
        Path("Guide.md"),
    )

    assert parsed.ok
    assert parsed.settings.title == "Guide"
    assert parsed.settings.tags == ("alpha", "beta")
    assert parsed.settings.content_type is ContentKind.BLOGPOST
    assert parsed.settings.metadata["owner"] == "Team"
    assert parsed.body == "Body\n"


def test_frontmatter_type_errors_are_diagnostics() -> None:
    parsed = parse_frontmatter(
        "---\nconnie-publish: yes please\nconnie-page-id: 123\n---\nBody\n",
        Path("Bad.md"),
    )
    assert not parsed.ok
    assert [item.code for item in parsed.diagnostics].count("FRONTMATTER_TYPE") == 2


def test_invalid_yaml_diagnostics_never_echo_source_values() -> None:
    sentinel = "TOP_SECRET_PERSONNEL_VALUE"
    parsed = parse_frontmatter(
        f"---\nowner: {sentinel}\nowner: duplicate\n---\nBody\n",
        Path("Secret.md"),
    )

    assert not parsed.ok
    assert parsed.diagnostics[0].code == "FRONTMATTER_YAML_INVALID"
    assert sentinel not in repr(parsed.diagnostics)


def test_flow_nesting_is_bounded_before_yaml_parsing() -> None:
    parsed = parse_frontmatter(
        f"---\nvalue: {'[' * 500}{']' * 500}\n---\nBody\n",
        Path("Nested.md"),
    )

    assert not parsed.ok
    assert parsed.diagnostics[0].code == "FRONTMATTER_DEPTH_LIMIT"


def test_default_parent_compatibility_and_roundtrip_identity_writeback(tmp_path: Path) -> None:
    path = tmp_path / "Guide.md"
    original = b'\xef\xbb\xbf---\r\n# keep this comment\r\ntitle: "Keep me"\r\n---\r\nBody\r\n'
    path.write_bytes(original)
    source_id = str(uuid4())

    preview = plan_identity_writeback(
        path,
        source_id=source_id,
        page_id="123",
        publish=True,
        vault_root=tmp_path,
    )
    assert preview.changed
    assert "Body" not in repr(preview)
    assert path.read_bytes() == original

    result = write_identity_frontmatter(
        path,
        source_id=source_id,
        page_id="123",
        publish=True,
        vault_root=tmp_path,
        expected_sha256=preview.source_sha256_before,
    )
    assert result.changed
    updated = path.read_bytes()
    assert updated.startswith(b"\xef\xbb\xbf")
    assert b"# keep this comment\r\n" in updated
    assert b'title: "Keep me"\r\n' in updated
    assert updated.endswith(b"---\r\nBody\r\n")
    parsed = parse_frontmatter(updated.decode("utf-8-sig"), path)
    assert parsed.settings.source_id == source_id
    assert parsed.settings.page_id == "123"
    assert parsed.settings.publish is True
    assert parsed.settings.dont_change_parent_page is True

    unchanged = write_identity_frontmatter(
        path,
        source_id=source_id,
        page_id="123",
        publish=True,
        vault_root=tmp_path,
    )
    assert not unchanged.changed


def test_publish_toggle_changes_only_publish_control_and_supports_preview(tmp_path: Path) -> None:
    source_id = str(uuid4())
    path = tmp_path / "Toggle.md"
    original = (
        b"\xef\xbb\xbf---\r\n"
        b"# retained\r\n"
        + f"connie-source-id: {source_id}\r\n".encode()
        + b"connie-page-id: '88'\r\n"
        + b"connie-publish: true\r\n"
        + b'title: "Quoted"\r\n'
        + b"---\r\nBody stays byte-for-byte\r\n"
    )
    path.write_bytes(original)

    preview = plan_publish_frontmatter(path, False, vault_root=tmp_path)
    assert preview.changed
    assert "Body stays" not in repr(preview)
    assert path.read_bytes() == original
    result = set_publish_frontmatter(
        path,
        False,
        vault_root=tmp_path,
        expected_sha256=preview.source_sha256_before,
    )

    assert result.changed
    updated = path.read_bytes()
    assert updated.startswith(b"\xef\xbb\xbf")
    assert b"# retained\r\n" in updated
    assert b'title: "Quoted"\r\n' in updated
    assert updated.endswith(b"---\r\nBody stays byte-for-byte\r\n")
    parsed = parse_frontmatter(updated.decode("utf-8-sig"), path)
    assert parsed.settings.publish is False
    assert parsed.settings.source_id == source_id
    assert parsed.settings.page_id == "88"

    unchanged = set_publish_frontmatter(path, False)
    assert not unchanged.changed
    with pytest.raises(ValueError):
        set_publish_frontmatter(path, True, expected_sha256="0" * 64)


def test_publish_toggle_does_not_invent_identity(tmp_path: Path) -> None:
    path = tmp_path / "Plain.md"
    path.write_text("Body\n", encoding="utf-8")

    result = set_publish_frontmatter(path, True)

    assert result.changed
    parsed = parse_frontmatter(path.read_text(encoding="utf-8"), path)
    assert parsed.settings.publish is True
    assert parsed.settings.source_id is None
    assert parsed.settings.page_id is None
