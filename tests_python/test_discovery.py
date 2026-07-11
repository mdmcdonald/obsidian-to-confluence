from __future__ import annotations

from pathlib import Path
from uuid import uuid4

from md2conf_dc.config import SourceConfig
from md2conf_dc.discovery import discover_sources
from md2conf_dc.hierarchy import build_hierarchy
from md2conf_dc.index import build_index, build_managed_labels
from md2conf_dc.models import Selection


def _source_config(root: Path) -> SourceConfig:
    return SourceConfig(
        vault_root=root,
        publish_root=root / "Docs",
        first_heading_page_title=True,
    )


def test_discovery_scope_frontmatter_titles_and_ignores(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    (docs / "Guide.md").write_text("# Effective title\n\nBody\n", encoding="utf-8")
    (docs / "Skip.md").write_text("---\nconnie-publish: false\n---\nNo\n", encoding="utf-8")
    (docs / "drawing.excalidraw.md").write_text("# no\n", encoding="utf-8")
    (tmp_path / "Outside.md").write_text(
        "---\nconnie-publish: true\nconnie-title: Explicit\n---\nBody\n",
        encoding="utf-8",
    )

    result = discover_sources(_source_config(tmp_path), vault_id=str(uuid4()))

    assert result.ok
    assert [item.identity.relative_path for item in result.documents] == [
        "Docs/Guide.md",
        "Outside.md",
    ]
    guide = result.documents[0]
    assert guide.title_candidate == "Effective title"
    assert guide.body == "\nBody\n"
    assert any(item.code == "SOURCE_OUTSIDE_SCOPE" for item in result.diagnostics)
    assert result.orphan_reconciliation_safe
    assert len(result.source_set_sha256) == 64
    assert len(result.scope_fingerprint) == 64


def test_duplicate_source_and_page_ids_are_errors(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    source_id = str(uuid4())
    frontmatter = f"---\nconnie-source-id: {source_id}\nconnie-page-id: '123'\n---\nBody\n"
    (docs / "A.md").write_text(frontmatter, encoding="utf-8")
    (docs / "B.md").write_text(frontmatter, encoding="utf-8")

    result = discover_sources(_source_config(tmp_path), vault_id=str(uuid4()))

    assert not result.ok
    assert {item.code for item in result.diagnostics} >= {
        "DUPLICATE_SOURCE_ID",
        "DUPLICATE_PAGE_ID",
    }


def test_hierarchy_landing_and_title_dedup_are_deterministic(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    (docs / "One").mkdir(parents=True)
    (docs / "Two").mkdir()
    (docs / "One" / "README.md").write_text("Landing one\n", encoding="utf-8")
    (docs / "One" / "topic.md").write_text("One\n", encoding="utf-8")
    (docs / "Two" / "topic.md").write_text("Two\n", encoding="utf-8")
    vault_id = str(uuid4())
    discovered = discover_sources(_source_config(tmp_path), vault_id=vault_id)

    hierarchy = build_hierarchy(
        discovered.documents,
        vault_id=vault_id,
        publish_root="Docs",
    )
    index = build_index(
        discovered.documents,
        folders=hierarchy.folders,
        deduplicate_titles=True,
    )

    one = next(folder for folder in hierarchy.folders if folder.relative_path == "One")
    assert one.landing_source_id is not None
    assert hierarchy.parent_by_source_id[one.landing_source_id] is None
    topic_titles = [
        index.final_titles[item.identity.source_id]
        for item in discovered.documents
        if item.identity.relative_path.endswith("topic.md")
    ]
    assert all(" — " in title for title in topic_titles)
    assert len(set(topic_titles)) == 2


def test_selection_retains_global_context_but_disables_orphan_reconciliation(
    tmp_path: Path,
) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    (docs / "A.md").write_text("A\n", encoding="utf-8")
    (docs / "B.md").write_text("B\n", encoding="utf-8")
    result = discover_sources(
        _source_config(tmp_path),
        vault_id=str(uuid4()),
        selection=Selection.selected((Path("Docs/A.md"),)),
    )
    assert len(result.documents) == 2
    assert len(result.selected_source_ids) == 1
    assert not result.orphan_reconciliation_safe


def test_source_file_symlinks_are_never_followed(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    outside = tmp_path / "outside-secret.md"
    outside.write_text("TOP_SECRET_OUTSIDE_VAULT", encoding="utf-8")
    linked = docs / "Linked.md"
    linked.symlink_to(outside)

    result = discover_sources(_source_config(tmp_path), vault_id=str(uuid4()))

    assert result.documents == ()
    assert any(item.code == "SOURCE_SYMLINK_IGNORED" for item in result.diagnostics)
    assert "TOP_SECRET_OUTSIDE_VAULT" not in repr(result)


def test_source_reads_stop_at_configured_limit(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    (docs / "Large.md").write_bytes(b"x" * 10_000)
    config = _source_config(tmp_path).model_copy(update={"max_source_bytes": 8})

    result = discover_sources(config, vault_id=str(uuid4()))

    assert result.documents == ()
    assert any(item.code == "SOURCE_TOO_LARGE" for item in result.diagnostics)


def test_relationship_resolution_and_label_provenance(tmp_path: Path) -> None:
    docs = tmp_path / "Docs"
    docs.mkdir()
    (docs / "A.md").write_text(
        "---\nid: architecture-a\ntags: [AI, ai]\nsubject: 'Risk & Compliance'\n---\nA\n",
        encoding="utf-8",
    )
    (docs / "B.md").write_text("B\n", encoding="utf-8")
    discovered = discover_sources(_source_config(tmp_path), vault_id=str(uuid4()))
    index = build_index(discovered.documents)
    source_a, source_b = discovered.documents

    relationship = index.resolve_relationship(source_b.identity.source_id, "architecture-a")
    assert relationship.link.target_source_id == source_a.identity.source_id
    unresolved = index.resolve_relationship(source_b.identity.source_id, "unknown")
    assert unresolved.link.label == "unknown"
    assert unresolved.diagnostics[0].code == "RELATIONSHIP_UNRESOLVED"
    empty = index.resolve_link(source_b.identity.source_id, "")
    assert empty.diagnostics[0].code == "LINK_EMPTY"

    labels = build_managed_labels(source_a)
    assert labels.values == ("ai", "risk-compliance")
    assert any(item.code == "LABEL_NORMALIZATION_COLLISION" for item in labels.diagnostics)
