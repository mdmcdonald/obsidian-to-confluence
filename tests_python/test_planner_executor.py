from __future__ import annotations

import hashlib
from collections.abc import AsyncIterator, Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from md2conf_dc.confluence.errors import (
    AmbiguousWriteError,
    ConflictError,
    ConfluenceError,
    NotFoundError,
    TransportError,
)
from md2conf_dc.confluence.models import AttachmentDisposition, AttachmentObservation
from md2conf_dc.events import EventKind, PublishEvent
from md2conf_dc.executor import PlanExecutionError, PlanExecutor, PlanStaleError
from md2conf_dc.models import (
    AssetSpec,
    CancellationToken,
    ContentKind,
    OperationKind,
    OutcomeStatus,
    OwnershipMarker,
    PageSpec,
    PlanApproval,
    RemoteContent,
    Selection,
    SourceIdentity,
    SourceKind,
    TargetIdentity,
)
from md2conf_dc.ownership import MutationExpectation, assert_mutation_expectation
from md2conf_dc.planner import (
    OrphanAction,
    PlanApprovalError,
    RemotePlanner,
    validate_plan_approval,
)
from md2conf_dc.render.xml import storage_sha256

VAULT_ID = "a76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83"
SOURCE_ID = "dc3e7bc5-0832-44f1-9132-c80cb50a8250"
ORPHAN_ID = "17e0efef-abcd-4bac-9b11-7b0f36c2ec01"
SECOND_ORPHAN_ID = "6ed2f4be-1539-4e67-bf2d-69c117971e45"
PARENT_SOURCE_ID = "915bb49e-f2d3-450a-b61d-b0af99e0453a"


class MemoryState:
    def __init__(self) -> None:
        self.entries: dict[str, dict[str, object]] = {}
        self._generation = 0

    @property
    def generation(self) -> int:
        return self._generation

    @property
    def vault_id(self) -> str:
        return VAULT_ID

    def page_id_for(self, source_id: str) -> str | None:
        value = self.entries.get(source_id, {}).get("page_id")
        return value if isinstance(value, str) else None

    def entry_for(self, source_id: str) -> Mapping[str, object] | None:
        return self.entries.get(source_id)

    def tracked_source_ids(self) -> frozenset[str]:
        return frozenset(self.entries)

    def checkpoint(self, updates: Mapping[str, Mapping[str, object]]) -> None:
        for source_id, update in updates.items():
            self.entries.setdefault(source_id, {}).update(update)
        self._generation += 1

    def close(self) -> None:
        pass


class RemovableMemoryState(MemoryState):
    def remove_entries(self, source_ids: tuple[str, ...]) -> None:
        for source_id in source_ids:
            self.entries.pop(source_id, None)
        self._generation += 1


class MemoryGateway:
    supports_guarded_mutations = True

    def __init__(self) -> None:
        self.contents: dict[str, RemoteContent] = {}
        self.create_calls = 0
        self.update_calls = 0
        self.label_calls = 0
        self.trash_calls = 0
        self.target = _target()

    async def preflight(self, parent_page_id: str) -> TargetIdentity:
        del parent_page_id
        return self.target

    async def get_content(self, content_id: str) -> RemoteContent:
        try:
            return self.contents[content_id]
        except KeyError:
            raise NotFoundError("Content does not exist") from None

    async def find_owned_content(
        self, *, vault_id: str, root_page_id: str
    ) -> AsyncIterator[RemoteContent]:
        for content in self.contents.values():
            marker = content.ownership
            if marker and marker.vault_id == vault_id and marker.root_page_id == root_page_id:
                yield content

    async def create_content(
        self,
        *,
        title: str,
        content_type: str,
        space_key: str,
        parent_id: str | None,
        storage_value: str,
        parent_expectation: MutationExpectation | None = None,
    ) -> RemoteContent:
        if parent_expectation is not None:
            if parent_id is None:
                raise AssertionError("Parent expectation requires a parent ID")
            assert_mutation_expectation(self.contents[parent_id], parent_expectation)
        self.create_calls += 1
        content_id = str(1000 + self.create_calls)
        content = RemoteContent(
            content_id=content_id,
            kind=ContentKind(content_type),
            status="current",
            title=title,
            space_key=space_key,
            direct_parent_id=parent_id,
            ancestor_ids=(parent_id,) if parent_id else (),
            version=1,
            storage_value=storage_value,
            storage_sha256=storage_sha256(storage_value),
            ownership=None,
            ownership_property_version=None,
        )
        self.contents[content_id] = content
        return content

    async def update_content(
        self,
        *,
        content: RemoteContent,
        title: str,
        parent_id: str | None,
        storage_value: str,
        parent_expectation: MutationExpectation | None = None,
    ) -> RemoteContent:
        if parent_expectation is not None:
            if parent_id is None:
                raise AssertionError("Parent expectation requires a parent ID")
            assert_mutation_expectation(self.contents[parent_id], parent_expectation)
        self.update_calls += 1
        updated = replace(
            content,
            title=title,
            direct_parent_id=parent_id,
            ancestor_ids=("123", parent_id)
            if parent_id is not None and parent_id != "123"
            else (parent_id,)
            if parent_id
            else (),
            version=content.version + 1,
            storage_value=storage_value,
            storage_sha256=storage_sha256(storage_value),
        )
        self.contents[content.content_id] = updated
        return updated

    async def set_ownership(
        self,
        content_id: str,
        marker: OwnershipMarker,
        property_version: int | None,
        *,
        expectation: MutationExpectation,
    ) -> int:
        assert_mutation_expectation(self.contents[content_id], expectation)
        version = 1 if property_version is None else property_version + 1
        self.contents[content_id] = replace(
            self.contents[content_id],
            ownership=marker,
            ownership_property_version=version,
        )
        return version

    async def reconcile_labels(
        self,
        content_id: str,
        desired: Sequence[str],
        previously_managed: Sequence[str],
        *,
        expectation: MutationExpectation,
    ) -> None:
        assert_mutation_expectation(self.contents[content_id], expectation)
        del desired, previously_managed
        self.label_calls += 1

    async def reconcile_asset(
        self,
        content_id: str,
        asset: AssetSpec,
        source: Path,
        *,
        expectation: MutationExpectation,
    ) -> str:
        assert_mutation_expectation(self.contents[content_id], expectation)
        del asset, source
        return "2001"

    async def trash_content(
        self,
        content_id: str,
        *,
        expectation: MutationExpectation,
    ) -> None:
        assert_mutation_expectation(self.contents[content_id], expectation)
        self.trash_calls += 1
        self.contents.pop(content_id)

    async def close(self) -> None:
        pass


class EventCollector:
    def __init__(self) -> None:
        self.events: list[PublishEvent] = []

    async def emit(self, event: PublishEvent) -> None:
        self.events.append(event)


class ObservingGateway(MemoryGateway):
    def __init__(self) -> None:
        super().__init__()
        self.observed_labels: frozenset[str] = frozenset()
        self.asset_observation = AttachmentObservation(
            AttachmentDisposition.MISSING,
            None,
            None,
            None,
        )

    async def observe_labels(self, content_id: str) -> frozenset[str]:
        del content_id
        return self.observed_labels

    async def observe_asset(
        self,
        content_id: str,
        asset: AssetSpec,
    ) -> AttachmentObservation:
        del content_id, asset
        return self.asset_observation


@pytest.mark.asyncio
async def test_new_page_plan_executes_then_replans_to_noop() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    planner = RemotePlanner(gateway, state)
    plan = await planner.build(
        target=_target(),
        pages=(page,),
        source_set_sha256="1" * 64,
    )

    assert [operation.kind for operation in plan.operations] == [
        OperationKind.CREATE_PAGE,
        OperationKind.CREATE_PROPERTY,
        OperationKind.READBACK,
        OperationKind.COMMIT_STATE,
    ]
    report = await PlanExecutor(gateway, state, concurrency=2).execute(plan)
    assert report.succeeded
    assert gateway.create_calls == 1
    assert all(
        outcome.status not in {OutcomeStatus.FAILED, OutcomeStatus.CONFLICTED}
        for outcome in report.outcomes
    )

    second = await planner.build(
        target=_target(),
        pages=(page,),
        source_set_sha256="1" * 64,
    )
    assert [operation.kind for operation in second.operations] == [OperationKind.READBACK]
    assert second.operations[0].after["verify_only"] is True
    generation = state.generation
    second_report = await PlanExecutor(gateway, state).execute(second)
    assert [outcome.status for outcome in second_report.outcomes] == [OutcomeStatus.UNCHANGED]
    assert state.generation == generation


@pytest.mark.asyncio
async def test_cancelled_run_does_not_schedule_remote_writes() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(_page(),),
        source_set_sha256="2" * 64,
    )
    cancellation = CancellationToken()
    cancellation.cancel()

    report = await PlanExecutor(gateway, state).execute(plan, cancellation=cancellation)
    assert gateway.create_calls == 0
    assert report.outcomes
    assert all(outcome.status is OutcomeStatus.CANCELLED for outcome in report.outcomes)


@pytest.mark.asyncio
async def test_trash_plan_requires_its_exact_digest_approval() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    state.entries[ORPHAN_ID] = {
        "page_id": "900",
        "source_path": "removed/orphan.md",
        "remote_version": 1,
        "remote_storage_sha256": storage_sha256("<p>orphan</p>"),
    }
    gateway.contents["900"] = _owned_remote(ORPHAN_ID, content_id="900")
    plan = await RemotePlanner(
        gateway,
        state,
        orphan_action=OrphanAction.TRASH,
        max_trash_count=2,
    ).build(
        target=_target(),
        pages=(_page(),),
        source_set_sha256="3" * 64,
        selection=Selection.all(),
    )
    assert plan.has_destructive_operations
    trash = next(
        operation for operation in plan.operations if operation.kind is OperationKind.TRASH_PAGE
    )
    assert trash.before["source_path"] == "removed/orphan.md"
    assert trash.after["reason"] == "source_absent_from_authoritative_corpus"
    with pytest.raises(PlanApprovalError):
        validate_plan_approval(plan, None)

    approval = PlanApproval(
        plan_id=plan.plan_id,
        digest=plan.digest,
        approved_at=datetime.now(UTC),
        actor="operator",
    )
    validate_plan_approval(plan, approval)
    with pytest.raises(PlanApprovalError):
        validate_plan_approval(plan, replace(approval, digest="0" * 64))


@pytest.mark.asyncio
async def test_checkpointed_create_recovers_ownership_without_duplicate_page() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    state.entries[SOURCE_ID] = {
        "source_path": page.identity.relative_path,
        "source_kind": page.identity.kind.value,
        "page_id": "700",
        "content_type": page.content_kind.value,
        "parent_page_id": "123",
        "input_sha256": page.input_sha256,
        "remote_version": 1,
        "remote_storage_sha256": page.desired_storage_sha256,
        "ownership_property_version": None,
        "managed_labels": (),
        "last_successful_stage": "created",
        "last_run_id": "interrupted",
    }
    gateway.contents["700"] = RemoteContent(
        content_id="700",
        kind=ContentKind.PAGE,
        status="current",
        title=page.final_title,
        space_key="DOCS",
        direct_parent_id="123",
        ancestor_ids=("123",),
        version=1,
        storage_value=page.storage_value,
        storage_sha256=page.desired_storage_sha256,
        ownership=None,
        ownership_property_version=None,
    )

    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="4" * 64,
    )
    assert plan.operations[0].kind is OperationKind.CREATE_PROPERTY
    assert not any(operation.kind is OperationKind.CREATE_PAGE for operation in plan.operations)
    assert any(item.code == "PLAN_RECOVER_OWNERSHIP" for item in plan.diagnostics)

    report = await PlanExecutor(gateway, state).execute(plan)
    assert report.succeeded
    assert gateway.create_calls == 0
    assert gateway.contents["700"].ownership is not None


@pytest.mark.asyncio
async def test_adoption_is_read_only_until_exact_approval_then_writes_only_identity() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    remote_storage = "<p>Existing remote body</p>"
    gateway.contents["900"] = RemoteContent(
        content_id="900",
        kind=ContentKind.PAGE,
        status="current",
        title="Existing remote title",
        space_key="DOCS",
        direct_parent_id="123",
        ancestor_ids=("123",),
        version=7,
        storage_value=remote_storage,
        storage_sha256=storage_sha256(remote_storage),
        ownership=None,
        ownership_property_version=None,
    )
    plan = await RemotePlanner(gateway, state).build_adoption(
        target=_target(),
        page=_page(),
        content_id="900",
    )
    assert [operation.kind for operation in plan.operations] == [OperationKind.ADOPT_PAGE]
    with pytest.raises(PlanApprovalError):
        validate_plan_approval(plan, None)
    approval = PlanApproval(
        plan_id=plan.plan_id,
        digest=plan.digest,
        approved_at=datetime.now(UTC),
        actor="operator",
    )

    report = await PlanExecutor(gateway, state).execute(plan, approval=approval)
    assert report.succeeded
    assert gateway.create_calls == 0
    assert gateway.update_calls == 0
    adopted = gateway.contents["900"]
    assert adopted.storage_value == remote_storage
    assert adopted.title == "Existing remote title"
    assert adopted.ownership is not None
    assert adopted.ownership.last_render_sha256 == storage_sha256(remote_storage)
    assert state.entries[SOURCE_ID]["last_successful_stage"] == "adopted"


@pytest.mark.asyncio
async def test_adoption_crash_recovery_blocks_create_and_repairs_state_only() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    already_owned = _owned_remote(SOURCE_ID, content_id="900")
    gateway.contents["900"] = already_owned

    ordinary = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="4" * 64
    )
    assert not any(operation.kind is OperationKind.CREATE_PAGE for operation in ordinary.operations)
    assert any(item.code == "PLAN_UNTRACKED_OWNED_SOURCE" for item in ordinary.diagnostics)

    recovery = await RemotePlanner(gateway, state).build_adoption(
        target=_target(),
        page=page,
        content_id="900",
    )
    assert [operation.kind for operation in recovery.operations] == [OperationKind.ADOPT_PAGE]
    assert recovery.operations[0].after["state_repair_only"] is True
    approval = PlanApproval(
        plan_id=recovery.plan_id,
        digest=recovery.digest,
        approved_at=datetime.now(UTC),
        actor="operator",
    )

    report = await PlanExecutor(gateway, state).execute(recovery, approval=approval)
    assert report.succeeded
    assert state.page_id_for(SOURCE_ID) == "900"
    assert state.entries[SOURCE_ID]["last_successful_stage"] == "adopted"
    assert gateway.contents["900"].ownership == already_owned.ownership


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("case", "expected_code"),
    [
        ("scope", "SCOPE_VIOLATION"),
        ("kind", "ADOPT_CONTENT_KIND_CONFLICT"),
        ("foreign", "ADOPT_FOREIGN_OWNERSHIP"),
        ("duplicate", "ADOPT_DUPLICATE_PAGE_ID"),
    ],
)
async def test_adoption_rejects_scope_kind_foreign_owner_and_duplicate_mapping(
    case: str,
    expected_code: str,
) -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    if case == "duplicate":
        state.entries[ORPHAN_ID] = {"page_id": "900"}
    remote = replace(
        _owned_remote(ORPHAN_ID, content_id="900"),
        ownership=None,
        ownership_property_version=None,
    )
    if case == "scope":
        remote = replace(remote, space_key="OTHER")
    elif case == "kind":
        remote = replace(
            remote,
            kind=ContentKind.BLOGPOST,
            direct_parent_id=None,
            ancestor_ids=(),
        )
    elif case == "foreign":
        foreign = _owned_remote(ORPHAN_ID, content_id="900")
        remote = replace(
            remote,
            ownership=foreign.ownership,
            ownership_property_version=1,
        )
    gateway.contents["900"] = remote

    plan = await RemotePlanner(gateway, state).build_adoption(
        target=_target(),
        page=_page(),
        content_id="900",
    )
    assert plan.has_errors
    assert any(item.code == expected_code for item in plan.diagnostics)
    assert plan.operations == ()


@pytest.mark.asyncio
async def test_orphan_off_report_zero_source_and_cap_safety() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    state.entries[ORPHAN_ID] = {"page_id": "900"}
    gateway.contents["900"] = _owned_remote(ORPHAN_ID, content_id="900")

    off = await RemotePlanner(gateway, state, orphan_action=OrphanAction.OFF).build(
        target=_target(),
        pages=(),
        source_set_sha256="5" * 64,
    )
    assert off.operations == ()
    assert not any(item.code.startswith("PLAN_ORPHAN") for item in off.diagnostics)

    reported = await RemotePlanner(gateway, state, orphan_action=OrphanAction.REPORT).build(
        target=_target(),
        pages=(),
        source_set_sha256="5" * 64,
    )
    assert any(item.code == "PLAN_ORPHAN_REPORTED" for item in reported.diagnostics)
    reported_result = await PlanExecutor(gateway, state).execute(reported)
    assert reported_result.succeeded
    assert [outcome.status for outcome in reported_result.outcomes] == [
        OutcomeStatus.REPORTED_ORPHAN
    ]

    zero_source = await RemotePlanner(
        gateway, state, orphan_action=OrphanAction.TRASH, max_trash_count=2
    ).build(target=_target(), pages=(), source_set_sha256="5" * 64)
    assert any(item.code == "PLAN_ZERO_SOURCE_TRASH_REFUSED" for item in zero_source.diagnostics)
    assert not zero_source.has_destructive_operations

    state.entries[SECOND_ORPHAN_ID] = {"page_id": "901"}
    gateway.contents["901"] = _owned_remote(SECOND_ORPHAN_ID, content_id="901")
    capped = await RemotePlanner(
        gateway, state, orphan_action=OrphanAction.TRASH, max_trash_count=1
    ).build(target=_target(), pages=(_page(),), source_set_sha256="6" * 64)
    assert any(item.code == "PLAN_TRASH_CAP_EXCEEDED" for item in capped.diagnostics)
    assert not capped.has_destructive_operations


@pytest.mark.asyncio
async def test_approved_trash_revalidates_then_removes_only_orphan_state() -> None:
    gateway = MemoryGateway()
    state = RemovableMemoryState()
    page = _page()
    live = _remote_matching(page)
    gateway.contents["900"] = live
    state.entries[SOURCE_ID] = _synced_entry(page, live)
    gateway.contents["901"] = _owned_remote(ORPHAN_ID, content_id="901")
    state.entries[ORPHAN_ID] = {"page_id": "901"}
    plan = await RemotePlanner(
        gateway,
        state,
        orphan_action=OrphanAction.TRASH,
        max_trash_count=1,
    ).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="6" * 64,
    )
    approval = PlanApproval(
        plan_id=plan.plan_id,
        digest=plan.digest,
        approved_at=datetime.now(UTC),
        actor="operator",
    )
    report = await PlanExecutor(gateway, state).execute(plan, approval=approval)
    assert report.succeeded
    assert gateway.trash_calls == 1
    assert ORPHAN_ID not in state.entries
    assert SOURCE_ID in state.entries


@pytest.mark.asyncio
async def test_full_plan_discovers_owned_remote_orphan_missing_from_local_state() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    live = _remote_matching(page)
    gateway.contents["900"] = live
    state.entries[SOURCE_ID] = _synced_entry(page, live)
    gateway.contents["901"] = _owned_remote(ORPHAN_ID, content_id="901")

    plan = await RemotePlanner(
        gateway,
        state,
        orphan_action=OrphanAction.REPORT,
    ).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="6" * 64,
    )
    assert any(
        item.code == "PLAN_ORPHAN_REPORTED" and "901" in item.message for item in plan.diagnostics
    )


@pytest.mark.asyncio
async def test_executor_rejects_state_target_and_digest_staleness() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(_page(),), source_set_sha256="7" * 64
    )
    state.checkpoint({SOURCE_ID: {}})
    with pytest.raises(PlanStaleError):
        await PlanExecutor(gateway, state).execute(plan)

    fresh_state = MemoryState()
    fresh_plan = await RemotePlanner(gateway, fresh_state).build(
        target=_target(), pages=(_page(),), source_set_sha256="7" * 64
    )
    gateway.target = replace(_target(), fingerprint="sha256:" + "0" * 64)
    with pytest.raises(PlanStaleError):
        await PlanExecutor(gateway, fresh_state).execute(fresh_plan)

    gateway.target = _target()
    with pytest.raises(PlanStaleError):
        await PlanExecutor(gateway, fresh_state).execute(replace(fresh_plan, digest="0" * 64))


@pytest.mark.asyncio
async def test_asset_outcome_is_checkpointed_and_events_are_typed() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    collector = EventCollector()
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source="diagram.png",
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="d" * 64,
        size=10,
    )
    page = replace(_page(), assets=(asset,))
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="8" * 64
    )
    report = await PlanExecutor(gateway, state, event_sink=collector).execute(plan)
    assert report.succeeded
    assert state.entries[SOURCE_ID]["managed_assets"] == {
        "asset-1": {"attachment_id": "2001", "sha256": "d" * 64}
    }
    published = next(iter(gateway.contents.values()))
    assert published.storage_value == page.storage_value
    assert published.ownership is not None
    assert published.ownership.last_render_sha256 == page.desired_storage_sha256
    kinds = {event.kind for event in collector.events}
    assert {
        EventKind.RUN_STARTED,
        EventKind.STAGE_STARTED,
        EventKind.STAGE_FINISHED,
        EventKind.OPERATION_STARTED,
        EventKind.OPERATION_FINISHED,
        EventKind.RUN_FINISHED,
    } <= kinds


@pytest.mark.asyncio
async def test_failed_required_asset_leaves_safe_staging_body_not_final_body() -> None:
    class FailingAssetGateway(MemoryGateway):
        async def reconcile_asset(
            self,
            content_id: str,
            asset: AssetSpec,
            source: Path,
            *,
            expectation: MutationExpectation,
        ) -> str:
            assert_mutation_expectation(self.contents[content_id], expectation)
            del asset, source
            raise ConfluenceError("classified asset failure")

    gateway = FailingAssetGateway()
    state = MemoryState()
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source="diagram.png",
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="f" * 64,
        size=10,
    )
    page = replace(_page(), assets=(asset,))
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="f" * 64
    )
    kinds = [operation.kind for operation in plan.operations]
    assert kinds.index(OperationKind.CREATE_ATTACHMENT) < kinds.index(OperationKind.UPDATE_PAGE)

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    remote = next(iter(gateway.contents.values()))
    assert remote.storage_value != page.storage_value
    assert remote.storage_value == "<p>Managed page assets are being prepared.</p>"
    assert any(outcome.status is OutcomeStatus.SKIPPED for outcome in report.outcomes)


@pytest.mark.asyncio
async def test_executor_resolves_assets_under_injected_root_and_rejects_traversal(
    tmp_path: Path,
) -> None:
    class AssetPathGateway(MemoryGateway):
        def __init__(self) -> None:
            super().__init__()
            self.asset_sources: list[Path] = []

        async def reconcile_asset(
            self,
            content_id: str,
            asset: AssetSpec,
            source: Path,
            *,
            expectation: MutationExpectation,
        ) -> str:
            assert_mutation_expectation(self.contents[content_id], expectation)
            del asset
            self.asset_sources.append(source)
            return "2001"

    vault = tmp_path / "vault"
    image = vault / "images" / "diagram.png"
    image.parent.mkdir(parents=True)
    image.write_bytes(b"image")
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source="images/diagram.png",
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="1" * 64,
        size=5,
    )
    gateway = AssetPathGateway()
    state = MemoryState()
    page = replace(_page(), assets=(asset,))
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="1" * 64
    )
    report = await PlanExecutor(gateway, state, asset_root=vault).execute(plan)
    assert report.succeeded
    assert gateway.asset_sources == [image.resolve()]

    outside = tmp_path / "outside.png"
    outside.write_bytes(b"outside")
    unsafe_asset = replace(asset, source="../outside.png")
    unsafe_gateway = AssetPathGateway()
    unsafe_state = MemoryState()
    unsafe_page = replace(_page(), assets=(unsafe_asset,))
    unsafe_plan = await RemotePlanner(unsafe_gateway, unsafe_state).build(
        target=_target(), pages=(unsafe_page,), source_set_sha256="2" * 64
    )
    unsafe_report = await PlanExecutor(
        unsafe_gateway,
        unsafe_state,
        asset_root=vault,
    ).execute(unsafe_plan)
    assert not unsafe_report.succeeded
    assert unsafe_gateway.asset_sources == []


@pytest.mark.asyncio
async def test_logical_mermaid_asset_requires_safe_runtime_mapping(tmp_path: Path) -> None:
    class MappedAssetGateway(MemoryGateway):
        def __init__(self) -> None:
            super().__init__()
            self.upload_sources: list[Path] = []

        async def reconcile_asset(
            self,
            content_id: str,
            asset: AssetSpec,
            source: Path,
            *,
            expectation: MutationExpectation,
        ) -> str:
            assert_mutation_expectation(self.contents[content_id], expectation)
            del asset
            self.upload_sources.append(source)
            return "2001"

    vault = tmp_path / "vault"
    vault.mkdir()
    cache = tmp_path / "cache"
    cache.mkdir()
    rendered = cache / "diagram.png"
    rendered.write_bytes(b"rendered-mermaid")
    sha256 = hashlib.sha256(rendered.read_bytes()).hexdigest()
    asset = AssetSpec(
        asset_id="mermaid-asset",
        kind="mermaid",
        source="mermaid:" + "a" * 64,
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256=sha256,
        size=rendered.stat().st_size,
    )
    page = replace(_page(), assets=(asset,))
    gateway = MappedAssetGateway()
    state = MemoryState()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="3" * 64
    )

    with pytest.raises(PlanExecutionError, match="no runtime-resolved"):
        await PlanExecutor(gateway, state, asset_root=vault).execute(plan)
    assert gateway.create_calls == 0

    report = await PlanExecutor(
        gateway,
        state,
        asset_root=vault,
        asset_cache_root=cache,
        asset_sources={"mermaid-asset": rendered},
    ).execute(plan)
    assert report.succeeded
    assert gateway.upload_sources == [rendered.resolve()]


@pytest.mark.asyncio
async def test_runtime_asset_mapping_tamper_fails_before_remote_work(tmp_path: Path) -> None:
    vault = tmp_path / "vault"
    vault.mkdir()
    rendered = vault / "diagram.png"
    rendered.write_bytes(b"tampered")
    asset = AssetSpec(
        asset_id="mermaid-asset",
        kind="mermaid",
        source="mermaid:" + "b" * 64,
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="0" * 64,
        size=rendered.stat().st_size,
    )
    gateway = MemoryGateway()
    state = MemoryState()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(replace(_page(), assets=(asset,)),),
        source_set_sha256="4" * 64,
    )

    with pytest.raises(PlanExecutionError, match="changed after rendering"):
        await PlanExecutor(
            gateway,
            state,
            asset_root=vault,
            asset_sources={"mermaid-asset": rendered},
        ).execute(plan)
    assert gateway.create_calls == 0


@pytest.mark.asyncio
async def test_remote_version_drift_is_a_plan_conflict() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    state.entries[SOURCE_ID] = {
        "page_id": "900",
        "remote_version": 1,
        "remote_storage_sha256": storage_sha256("<p>orphan</p>"),
    }
    owned = _owned_remote(SOURCE_ID, content_id="900")
    gateway.contents["900"] = replace(
        owned,
        version=2,
        ownership=replace(owned.ownership, source_path="hello.md")
        if owned.ownership is not None
        else None,
    )
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(_page(),), source_set_sha256="9" * 64
    )
    assert plan.has_errors
    assert any(item.code == "PLAN_REMOTE_DRIFT" for item in plan.diagnostics)
    assert plan.operations == ()
    conflicted_report = await PlanExecutor(gateway, state).execute(plan)
    assert not conflicted_report.succeeded
    assert [outcome.status for outcome in conflicted_report.outcomes] == [OutcomeStatus.CONFLICTED]

    working = replace(
        _page(),
        identity=replace(_page().identity, source_id=SECOND_ORPHAN_ID, relative_path="works.md"),
        final_title="Works",
    )
    partial_plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(_page(), working),
        source_set_sha256="a" * 64,
    )
    partial_report = await PlanExecutor(gateway, state).execute(partial_plan)
    statuses = {outcome.status for outcome in partial_report.outcomes}
    assert OutcomeStatus.CONFLICTED in statuses
    assert OutcomeStatus.CREATED in statuses


@pytest.mark.asyncio
async def test_dont_change_parent_preserves_remote_parent_during_body_update() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    remote = replace(
        _owned_remote(SOURCE_ID, content_id="900"),
        direct_parent_id="555",
        ancestor_ids=("123", "555"),
    )
    gateway.contents["900"] = remote
    state.entries[SOURCE_ID] = {
        "page_id": "900",
        "remote_version": remote.version,
        "remote_storage_sha256": remote.storage_sha256,
    }
    state.entries[PARENT_SOURCE_ID] = {"page_id": "777"}
    page = replace(
        _page(),
        parent_source_id=PARENT_SOURCE_ID,
        change_parent=False,
    )
    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="b" * 64,
        selection=Selection.selected((Path("hello.md"),)),
    )
    mutation = next(
        operation
        for operation in plan.operations
        if operation.kind in {OperationKind.UPDATE_PAGE, OperationKind.MOVE_PAGE}
    )
    assert mutation.kind is OperationKind.UPDATE_PAGE
    assert mutation.after["parent_id"] == "555"
    assert mutation.prerequisites == ()

    report = await PlanExecutor(gateway, state).execute(plan)
    assert report.succeeded
    assert gateway.contents["900"].direct_parent_id == "555"


@pytest.mark.asyncio
async def test_independent_page_continues_after_another_page_fails() -> None:
    class IsolatedFailureGateway(MemoryGateway):
        async def create_content(
            self,
            *,
            title: str,
            content_type: str,
            space_key: str,
            parent_id: str | None,
            storage_value: str,
            parent_expectation: MutationExpectation | None = None,
        ) -> RemoteContent:
            if title == "Fails":
                raise ConfluenceError("classified remote failure")
            return await super().create_content(
                title=title,
                content_type=content_type,
                space_key=space_key,
                parent_id=parent_id,
                storage_value=storage_value,
                parent_expectation=parent_expectation,
            )

    gateway = IsolatedFailureGateway()
    state = MemoryState()
    failing = replace(_page(), final_title="Fails")
    working = replace(
        _page(),
        identity=replace(_page().identity, source_id=SECOND_ORPHAN_ID, relative_path="works.md"),
        final_title="Works",
    )
    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(failing, working),
        source_set_sha256="c" * 64,
    )
    report = await PlanExecutor(gateway, state, concurrency=2).execute(plan)
    statuses = {outcome.status for outcome in report.outcomes}
    assert OutcomeStatus.FAILED in statuses
    assert OutcomeStatus.CREATED in statuses
    assert any(content.title == "Works" for content in gateway.contents.values())


@pytest.mark.asyncio
async def test_planner_observes_missing_managed_label_but_preserves_manual_label() -> None:
    gateway = ObservingGateway()
    state = MemoryState()
    page = replace(_page(), labels=("managed",))
    remote = _remote_matching(page, labels=("managed",))
    gateway.contents["900"] = remote
    gateway.observed_labels = frozenset({"manual-label"})
    state.entries[SOURCE_ID] = _synced_entry(page, remote)

    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="d" * 64,
        selection=Selection.selected((Path("hello.md"),)),
    )
    label_operations = [
        operation for operation in plan.operations if operation.kind is OperationKind.ADD_LABEL
    ]
    assert len(label_operations) == 1
    assert label_operations[0].before["current_labels"] == ("manual-label",)
    assert label_operations[0].after["managed_labels"] == ("managed",)
    assert not any(operation.kind is OperationKind.UPDATE_PROPERTY for operation in plan.operations)


@pytest.mark.asyncio
async def test_changed_attachment_is_planned_before_body_update_and_unchanged_is_noop() -> None:
    gateway = ObservingGateway()
    state = MemoryState()
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source="diagram.png",
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="e" * 64,
        size=10,
    )
    page = replace(_page(), assets=(asset,))
    remote = _remote_matching(page)
    remote = replace(
        remote,
        storage_value="<p>old body</p>",
        storage_sha256=storage_sha256("<p>old body</p>"),
        ownership=replace(
            remote.ownership,
            last_render_sha256=storage_sha256("<p>old body</p>"),
        )
        if remote.ownership is not None
        else None,
    )
    gateway.contents["900"] = remote
    state.entries[SOURCE_ID] = _synced_entry(page, remote)
    gateway.asset_observation = AttachmentObservation(
        AttachmentDisposition.CHANGED,
        "55",
        "0" * 64,
        4,
    )

    plan = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="e" * 64,
        selection=Selection.selected((Path("hello.md"),)),
    )
    asset_operation = next(
        operation
        for operation in plan.operations
        if operation.kind is OperationKind.UPDATE_ATTACHMENT
    )
    content_operation = next(
        operation for operation in plan.operations if operation.kind is OperationKind.UPDATE_PAGE
    )
    assert asset_operation.operation_id in content_operation.prerequisites

    unchanged_remote = _remote_matching(page)
    gateway.contents["900"] = unchanged_remote
    state.entries[SOURCE_ID] = _synced_entry(
        page,
        unchanged_remote,
        managed_assets={"asset-1": {"attachment_id": "55", "sha256": "e" * 64}},
    )
    gateway.asset_observation = AttachmentObservation(
        AttachmentDisposition.UNCHANGED,
        "55",
        "e" * 64,
        4,
    )
    no_op = await RemotePlanner(gateway, state).build(
        target=_target(),
        pages=(page,),
        source_set_sha256="e" * 64,
        selection=Selection.selected((Path("hello.md"),)),
    )
    assert [operation.kind for operation in no_op.operations] == [OperationKind.READBACK]
    assert no_op.operations[0].after["verify_only"] is True


@pytest.mark.asyncio
async def test_ambiguous_create_checkpoints_pending_and_replan_refuses_duplicate() -> None:
    class AmbiguousCreateGateway(MemoryGateway):
        async def create_content(
            self,
            *,
            title: str,
            content_type: str,
            space_key: str,
            parent_id: str | None,
            storage_value: str,
            parent_expectation: MutationExpectation | None = None,
        ) -> RemoteContent:
            del title, content_type, space_key, parent_id, storage_value, parent_expectation
            self.create_calls += 1
            raise AmbiguousWriteError("Create response was not observed")

    gateway = AmbiguousCreateGateway()
    state = MemoryState()
    page = _page()
    planner = RemotePlanner(gateway, state)
    plan = await planner.build(target=_target(), pages=(page,), source_set_sha256="1" * 64)

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    assert gateway.create_calls == 1
    assert state.entries[SOURCE_ID]["last_successful_stage"] == "create_pending"
    assert state.entries[SOURCE_ID]["page_id"] is None

    retry_plan = await planner.build(target=_target(), pages=(page,), source_set_sha256="1" * 64)
    assert not any(
        operation.kind is OperationKind.CREATE_PAGE for operation in retry_plan.operations
    )
    assert any(
        diagnostic.code == "PLAN_CREATE_PENDING_RECONCILIATION"
        for diagnostic in retry_plan.diagnostics
    )


@pytest.mark.asyncio
async def test_definitely_unsent_create_rolls_back_pending_and_can_replan() -> None:
    class UnsentCreateGateway(MemoryGateway):
        async def create_content(
            self,
            *,
            title: str,
            content_type: str,
            space_key: str,
            parent_id: str | None,
            storage_value: str,
            parent_expectation: MutationExpectation | None = None,
        ) -> RemoteContent:
            del title, content_type, space_key, parent_id, storage_value, parent_expectation
            self.create_calls += 1
            raise TransportError("Create request was definitely not sent")

    gateway = UnsentCreateGateway()
    state = MemoryState()
    page = _page()
    planner = RemotePlanner(gateway, state)
    plan = await planner.build(target=_target(), pages=(page,), source_set_sha256="1" * 64)

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    assert state.entries[SOURCE_ID]["last_successful_stage"] == "create_not_sent"
    retry_plan = await planner.build(target=_target(), pages=(page,), source_set_sha256="1" * 64)
    assert any(operation.kind is OperationKind.CREATE_PAGE for operation in retry_plan.operations)
    assert not any(
        item.code == "PLAN_CREATE_PENDING_RECONCILIATION" for item in retry_plan.diagnostics
    )


@pytest.mark.asyncio
async def test_missing_tracked_page_is_rechecked_then_safely_recreated() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    state.entries[SOURCE_ID] = {
        "page_id": "777",
        "remote_version": 1,
        "remote_storage_sha256": page.desired_storage_sha256,
        "last_successful_stage": "committed",
    }
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="2" * 64
    )
    create = next(
        operation for operation in plan.operations if operation.kind is OperationKind.CREATE_PAGE
    )
    assert create.before["missing_content_id"] == "777"

    report = await PlanExecutor(gateway, state).execute(plan)
    assert report.succeeded
    assert gateway.create_calls == 1
    assert state.page_id_for(SOURCE_ID) == "1001"
    assert state.entries[SOURCE_ID]["last_successful_stage"] == "committed"


@pytest.mark.asyncio
async def test_missing_tracked_page_reappearing_before_apply_blocks_recreate() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    state.entries[SOURCE_ID] = {"page_id": "777"}
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="3" * 64
    )
    gateway.contents["777"] = _owned_remote(SOURCE_ID, content_id="777")

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    assert gateway.create_calls == 0
    assert any(outcome.status is OutcomeStatus.CONFLICTED for outcome in report.outcomes)


@pytest.mark.asyncio
async def test_noop_readback_detects_remote_change_after_planning() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    remote = _remote_matching(page)
    gateway.contents["900"] = remote
    state.entries[SOURCE_ID] = _synced_entry(page, remote)
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="4" * 64
    )
    assert plan.operations[0].after["verify_only"] is True
    gateway.contents["900"] = replace(remote, version=remote.version + 1)

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    assert report.outcomes[0].status is OutcomeStatus.CONFLICTED


@pytest.mark.asyncio
async def test_executor_rejects_tampered_page_body_and_operation_hash() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="5" * 64
    )
    tampered_page = replace(page, storage_value="<p>Tampered</p>")
    with pytest.raises(PlanExecutionError, match="storage body"):
        await PlanExecutor(gateway, state).execute(
            replace(plan, page_specs={SOURCE_ID: tampered_page})
        )

    first = plan.operations[0]
    tampered_operation = replace(
        first,
        after={**first.after, "storage_sha256": "0" * 64},
    )
    with pytest.raises(PlanExecutionError, match="operation storage hash"):
        await PlanExecutor(gateway, state).execute(
            replace(plan, operations=(tampered_operation, *plan.operations[1:]))
        )
    with pytest.raises(PlanStaleError, match="digest"):
        await PlanExecutor(gateway, state).execute(
            replace(
                plan,
                page_specs={SOURCE_ID: replace(page, final_title="Tampered title")},
            )
        )
    assert gateway.create_calls == 0


@pytest.mark.asyncio
async def test_executor_refuses_unguarded_gateway_before_preflight_or_write() -> None:
    class UnguardedGateway(MemoryGateway):
        supports_guarded_mutations = False

        def __init__(self) -> None:
            super().__init__()
            self.preflight_calls = 0

        async def preflight(self, parent_page_id: str) -> TargetIdentity:
            self.preflight_calls += 1
            return await super().preflight(parent_page_id)

    gateway = UnguardedGateway()
    state = MemoryState()
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(_page(),), source_set_sha256="6" * 64
    )
    with pytest.raises(PlanExecutionError, match="mandatory guarded"):
        await PlanExecutor(gateway, state).execute(plan)
    assert gateway.preflight_calls == 0
    assert gateway.create_calls == 0


@pytest.mark.asyncio
async def test_foreign_parent_quarantines_parent_and_child() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    parent = replace(
        _page(),
        identity=replace(
            _page().identity,
            source_id=PARENT_SOURCE_ID,
            relative_path="parent.md",
            kind=SourceKind.FOLDER,
        ),
        final_title="Parent",
    )
    child = replace(
        _page(),
        identity=replace(
            _page().identity,
            source_id=SECOND_ORPHAN_ID,
            relative_path="child.md",
        ),
        final_title="Child",
        parent_source_id=PARENT_SOURCE_ID,
    )
    parent_remote = _remote_matching(parent)
    assert parent_remote.ownership is not None
    parent_remote = replace(
        parent_remote,
        ownership=replace(parent_remote.ownership, vault_id="b76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83"),
    )
    gateway.contents["900"] = parent_remote
    state.entries[PARENT_SOURCE_ID] = _synced_entry(parent, parent_remote)

    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(parent, child), source_set_sha256="7" * 64
    )
    assert plan.operations == ()
    assert any(item.code == "PLAN_PARENT_CONFLICT" for item in plan.diagnostics)


@pytest.mark.asyncio
async def test_executor_rechecks_parent_ownership_immediately_before_child_create() -> None:
    class ParentSwapGateway(MemoryGateway):
        def __init__(self) -> None:
            super().__init__()
            self.parent_reads = 0

        async def get_content(self, content_id: str) -> RemoteContent:
            current = await super().get_content(content_id)
            if content_id != "900":
                return current
            self.parent_reads += 1
            if self.parent_reads < 3:
                return current
            assert current.ownership is not None
            return replace(
                current,
                ownership=replace(
                    current.ownership,
                    vault_id="b76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83",
                ),
            )

    gateway = ParentSwapGateway()
    state = MemoryState()
    parent = replace(
        _page(),
        identity=replace(
            _page().identity,
            source_id=PARENT_SOURCE_ID,
            relative_path="parent.md",
            kind=SourceKind.FOLDER,
        ),
        final_title="Parent",
    )
    child = replace(
        _page(),
        identity=replace(
            _page().identity,
            source_id=SECOND_ORPHAN_ID,
            relative_path="child.md",
        ),
        final_title="Child",
        parent_source_id=PARENT_SOURCE_ID,
    )
    parent_remote = _remote_matching(parent)
    gateway.contents["900"] = parent_remote
    state.entries[PARENT_SOURCE_ID] = _synced_entry(parent, parent_remote)
    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(parent, child), source_set_sha256="8" * 64
    )

    report = await PlanExecutor(gateway, state).execute(plan)
    assert not report.succeeded
    assert gateway.create_calls == 0
    child_create = next(
        outcome for outcome in report.outcomes if outcome.kind is OperationKind.CREATE_PAGE
    )
    assert child_create.status is OutcomeStatus.CONFLICTED


@pytest.mark.asyncio
async def test_orphan_reconciliation_uses_local_vault_not_remote_marker() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    orphan = _owned_remote(ORPHAN_ID, content_id="901")
    assert orphan.ownership is not None
    gateway.contents["901"] = replace(
        orphan,
        ownership=replace(
            orphan.ownership,
            vault_id="b76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83",
        ),
    )
    state.entries[ORPHAN_ID] = {"page_id": "901"}

    plan = await RemotePlanner(
        gateway,
        state,
        orphan_action=OrphanAction.TRASH,
        max_trash_count=2,
    ).build(target=_target(), pages=(_page(),), source_set_sha256="9" * 64)
    assert any(item.code == "PLAN_ORPHAN_OWNERSHIP_CONFLICT" for item in plan.diagnostics)
    assert not any(operation.kind is OperationKind.TRASH_PAGE for operation in plan.operations)


@pytest.mark.asyncio
async def test_attachment_observation_conflict_quarantines_all_page_mutations() -> None:
    class ConflictingObserver(ObservingGateway):
        async def observe_asset(
            self,
            content_id: str,
            asset: AssetSpec,
        ) -> AttachmentObservation:
            del content_id, asset
            raise ConflictError("Attachment ownership changed")

    gateway = ConflictingObserver()
    state = MemoryState()
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source="diagram.png",
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256="e" * 64,
        size=10,
    )
    page = replace(_page(), assets=(asset,))
    remote = _remote_matching(page)
    gateway.contents["900"] = remote
    state.entries[SOURCE_ID] = _synced_entry(page, remote)

    plan = await RemotePlanner(gateway, state).build(
        target=_target(), pages=(page,), source_set_sha256="a" * 64
    )
    assert any(item.code == "PLAN_ATTACHMENT_CONFLICT" for item in plan.diagnostics)
    assert not any(operation.source_id == SOURCE_ID for operation in plan.operations)


@pytest.mark.asyncio
async def test_orphan_trash_is_refused_while_any_live_source_is_conflicted() -> None:
    gateway = MemoryGateway()
    state = MemoryState()
    page = _page()
    live = _remote_matching(page)
    gateway.contents["900"] = replace(live, version=live.version + 1)
    state.entries[SOURCE_ID] = _synced_entry(page, live)
    gateway.contents["901"] = _owned_remote(ORPHAN_ID, content_id="901")
    state.entries[ORPHAN_ID] = {"page_id": "901"}

    plan = await RemotePlanner(
        gateway,
        state,
        orphan_action=OrphanAction.TRASH,
        max_trash_count=2,
    ).build(target=_target(), pages=(page,), source_set_sha256="b" * 64)
    assert any(item.code == "PLAN_TRASH_LIVE_CONFLICT_REFUSED" for item in plan.diagnostics)
    assert not any(operation.kind is OperationKind.TRASH_PAGE for operation in plan.operations)


def _target() -> TargetIdentity:
    return TargetIdentity(
        base_url="https://confluence.example.test/confluence",
        server_version="9.2.4",
        server_build="9204",
        space_key="DOCS",
        root_page_id="123",
        current_user="publisher",
        fingerprint="sha256:" + "f" * 64,
    )


def _page() -> PageSpec:
    storage = "<p>Hello</p>"
    return PageSpec(
        identity=SourceIdentity(
            vault_id=VAULT_ID,
            source_id=SOURCE_ID,
            relative_path="hello.md",
            kind=SourceKind.NOTE,
        ),
        final_title="Hello",
        content_kind=ContentKind.PAGE,
        parent_source_id=None,
        storage_value=storage,
        desired_storage_sha256=storage_sha256(storage),
        input_sha256="a" * 64,
        labels=(),
        assets=(),
        policy_id="minimal",
    )


def _owned_remote(source_id: str, *, content_id: str) -> RemoteContent:
    storage = "<p>orphan</p>"
    marker = OwnershipMarker(
        schema=1,
        managed=True,
        publisher="md2conf-dc",
        vault_id=VAULT_ID,
        source_id=source_id,
        source_kind=SourceKind.NOTE,
        source_path="old.md",
        root_page_id="123",
        space_key="DOCS",
        managed_labels=(),
        last_render_sha256=storage_sha256(storage),
        last_run_id="previous",
    )
    return RemoteContent(
        content_id=content_id,
        kind=ContentKind.PAGE,
        status="current",
        title="Old",
        space_key="DOCS",
        direct_parent_id="123",
        ancestor_ids=("123",),
        version=1,
        storage_value=storage,
        storage_sha256=storage_sha256(storage),
        ownership=marker,
        ownership_property_version=1,
    )


def _remote_matching(
    page: PageSpec,
    *,
    labels: tuple[str, ...] = (),
) -> RemoteContent:
    marker = OwnershipMarker(
        schema=1,
        managed=True,
        publisher="md2conf-dc",
        vault_id=page.identity.vault_id,
        source_id=page.identity.source_id,
        source_kind=page.identity.kind,
        source_path=page.identity.relative_path,
        root_page_id="123",
        space_key="DOCS",
        managed_labels=labels,
        last_render_sha256=page.desired_storage_sha256,
        last_run_id="previous",
    )
    return RemoteContent(
        content_id="900",
        kind=page.content_kind,
        status="current",
        title=page.final_title,
        space_key="DOCS",
        direct_parent_id="123" if page.content_kind is ContentKind.PAGE else None,
        ancestor_ids=("123",) if page.content_kind is ContentKind.PAGE else (),
        version=3,
        storage_value=page.storage_value,
        storage_sha256=page.desired_storage_sha256,
        ownership=marker,
        ownership_property_version=2,
    )


def _synced_entry(
    page: PageSpec,
    remote: RemoteContent,
    *,
    managed_assets: Mapping[str, object] | None = None,
) -> dict[str, object]:
    return {
        "source_path": page.identity.relative_path,
        "source_kind": page.identity.kind.value,
        "page_id": remote.content_id,
        "content_type": page.content_kind.value,
        "parent_page_id": remote.direct_parent_id,
        "input_sha256": page.input_sha256,
        "remote_version": remote.version,
        "remote_storage_sha256": remote.storage_sha256,
        "ownership_property_version": remote.ownership_property_version,
        "managed_labels": tuple(sorted(page.labels)),
        "managed_assets": dict(managed_assets or {}),
        "last_successful_stage": "committed",
        "last_run_id": "previous",
    }
