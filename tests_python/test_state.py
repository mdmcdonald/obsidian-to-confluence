from __future__ import annotations

from pathlib import Path
from uuid import uuid4

import pytest

from md2conf_dc.state import (
    JsonStateStore,
    LegacyCandidateStatus,
    StateError,
    StateLockError,
    StateTarget,
    StateTargetMismatch,
    plan_obsidian_import,
)


def _target(fingerprint: str = "sha256:one") -> StateTarget:
    return StateTarget(
        base_url="https://example.test/confluence",
        space_key="DOCS",
        root_page_id="123",
        fingerprint=fingerprint,
    )


def test_state_checkpoint_is_atomic_versioned_and_reopenable(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf/state.json"
    source_id = str(uuid4())
    with JsonStateStore.open(path, target=_target()) as store:
        vault_id = store.vault_id
        assert not path.exists()
        store.checkpoint(
            {
                source_id: {
                    "source_path": "Docs/Guide.md",
                    "page_id": "456",
                    "remote_version": 1,
                    "managed_labels": ("docs",),
                }
            }
        )
        assert store.generation == 1
        assert store.page_id_for(source_id) == "456"

    with JsonStateStore.open(path, vault_id=vault_id, target=_target()) as reopened:
        assert reopened.generation == 1
        assert reopened.source_id_for_path("Docs/Guide.md") == source_id
        reopened.checkpoint({source_id: {"remote_version": 2}})
        assert reopened.generation == 2
    assert path.with_name("state.json.bak").exists()


def test_state_lock_target_and_sensitive_data_guards(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    first = JsonStateStore.open(path, target=_target())
    try:
        with pytest.raises(StateLockError):
            JsonStateStore.open(path, lock_timeout=0)
        with pytest.raises(StateError):
            first.checkpoint({str(uuid4()): {"password": "never"}})
        first.flush()
    finally:
        first.close()

    with pytest.raises(StateTargetMismatch):
        JsonStateStore.open(path, target=_target("sha256:other"))


@pytest.mark.parametrize(
    "base_url",
    (
        "https://user:password@example.test/confluence",
        "https://example.test/confluence?token=secret",
        "http://example.test/confluence",
    ),
)
def test_state_target_rejects_credentialed_or_unsafe_urls(base_url: str) -> None:
    with pytest.raises(ValueError):
        StateTarget(
            base_url=base_url,
            space_key="DOCS",
            root_page_id="123",
            fingerprint="sha256:target",
        )


def test_scope_binding_requires_explicit_compare_and_swap(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    scope_one = "1" * 64
    scope_two = "2" * 64
    with JsonStateStore.open(path) as store:
        store.bind_scope(scope_one)
        store.flush()
        with pytest.raises(StateTargetMismatch):
            store.bind_scope(scope_two)
        with pytest.raises(StateTargetMismatch):
            store.rebind_scope(scope_two, expected_fingerprint="wrong")
        store.rebind_scope(scope_two, expected_fingerprint=scope_one)
        assert store.scope_fingerprint == scope_two


def test_state_move_is_guarded_and_atomic(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    source_id = str(uuid4())
    with JsonStateStore.open(path) as store:
        store.checkpoint({source_id: {"source_path": "Old/Guide.md", "page_id": "12"}})
        result = store.move_source(
            "Old/Guide.md",
            "New/Guide.md",
            expected_source_id=source_id,
        )
        assert result.changed
        assert result.generation == 2
        assert store.source_id_for_path("New/Guide.md") == source_id
        with pytest.raises(StateError):
            store.move_source("Old/Guide.md", "Other.md")
        with pytest.raises(StateError):
            store.move_source("New/Guide.md", "../escape.md")


def test_corrupt_primary_recovers_without_destroying_good_backup(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    source_id = str(uuid4())
    with JsonStateStore.open(path) as store:
        store.checkpoint({source_id: {"source_path": "A.md", "remote_version": 1}})
        store.checkpoint({source_id: {"remote_version": 2}})
    backup = path.with_name("state.json.bak")
    good_backup = backup.read_bytes()
    path.write_text("{broken", encoding="utf-8")

    with JsonStateStore.open(path) as recovered:
        assert recovered.diagnostics[0].code == "STATE_PRIMARY_CORRUPT"
        recovered.checkpoint({source_id: {"remote_version": 3}})
    assert backup.read_bytes() == good_backup


def test_corrupt_state_exception_does_not_retain_source_document(tmp_path: Path) -> None:
    path = tmp_path / "state.json"
    sentinel = "TOPSECRET-STATE-PAT"
    path.write_text(f'{{"pat":"{sentinel}"', encoding="utf-8")

    with pytest.raises(StateError) as caught:
        JsonStateStore.open(path)

    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert sentinel not in repr(caught.value)


def test_legacy_import_is_read_only_redacted_and_unverified(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    source_id = str(uuid4())
    (vault / "Guide.md").write_text(
        f"---\nconnie-source-id: {source_id}\nconnie-page-id: '42'\n---\nGuide\n",
        encoding="utf-8",
    )
    plugin = tmp_path / "data.json"
    plugin.write_text(
        """{
  "accessToken": "must-not-escape",
  "atlassianPassword": "also-secret",
  "publishedPages": {"Guide.md": {"pageId": "42", "hash": "obsolete"}}
}
""",
        encoding="utf-8",
    )

    plan = plan_obsidian_import(plugin, vault_root=vault, vault_id=str(uuid4()))

    assert plan.ok
    assert len(plan.candidates) == 1
    candidate = plan.candidates[0]
    assert candidate.status is LegacyCandidateStatus.UNVERIFIED
    assert candidate.source_id == source_id
    assert candidate.page_id == "42"
    assert "must-not-escape" not in repr(plan)
    assert "also-secret" not in repr(plan)
    assert not (tmp_path / "state.json").exists()


def test_invalid_legacy_json_exception_does_not_retain_secrets(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    plugin = tmp_path / "legacy.json"
    sentinel = "TOPSECRET-LEGACY-TOKEN"
    plugin.write_text(f'{{"accessToken":"{sentinel}"', encoding="utf-8")

    with pytest.raises(ValueError) as caught:
        plan_obsidian_import(plugin, vault_root=vault, vault_id=str(uuid4()))

    assert caught.value.__cause__ is None
    assert caught.value.__context__ is None
    assert sentinel not in repr(caught.value)
