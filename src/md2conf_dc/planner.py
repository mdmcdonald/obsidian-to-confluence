"""Read-only remote reconciliation and immutable operation planning."""

from __future__ import annotations

import hashlib
import json
from collections.abc import Mapping, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from enum import StrEnum
from types import MappingProxyType
from typing import Protocol, runtime_checkable

from md2conf_dc.confluence.errors import ConflictError, NotFoundError
from md2conf_dc.confluence.models import (
    AttachmentDisposition,
    AttachmentObservation,
)
from md2conf_dc.interfaces import ConfluenceGateway, StateStore
from md2conf_dc.models import (
    AssetSpec,
    ContentKind,
    Diagnostic,
    OperationKind,
    PageSpec,
    PlanApproval,
    PlannedOperation,
    PublishPlan,
    RemoteContent,
    Selection,
    Severity,
    TargetIdentity,
)
from md2conf_dc.ownership import OwnershipError, assert_in_scope, assert_owned

_ALL_SELECTION = Selection.all()


@runtime_checkable
class LabelObserver(Protocol):
    async def observe_labels(self, content_id: str) -> frozenset[str]: ...


@runtime_checkable
class AttachmentObserver(Protocol):
    async def observe_asset(
        self,
        content_id: str,
        asset: AssetSpec,
    ) -> AttachmentObservation: ...


@runtime_checkable
class VaultIdentityState(Protocol):
    @property
    def vault_id(self) -> str: ...


class OrphanAction(StrEnum):
    OFF = "off"
    REPORT = "report"
    TRASH = "trash"


class PlanError(RuntimeError):
    code = "invalid_plan"


class PlanApprovalError(PlanError):
    code = "approval_required"


class RemotePlanner:
    """Build a complete plan while performing only gateway reads."""

    def __init__(
        self,
        gateway: ConfluenceGateway,
        state: StateStore,
        *,
        orphan_action: OrphanAction = OrphanAction.REPORT,
        max_trash_count: int = 20,
        verify_skipped: bool = True,
    ) -> None:
        if max_trash_count < 0:
            raise ValueError("max_trash_count cannot be negative")
        self._gateway = gateway
        self._state = state
        self._orphan_action = orphan_action
        self._max_trash_count = max_trash_count
        self._verify_skipped = verify_skipped

    async def build(
        self,
        *,
        target: TargetIdentity,
        pages: Sequence[PageSpec],
        source_set_sha256: str,
        selection: Selection = _ALL_SELECTION,
        run_id: str | None = None,
    ) -> PublishPlan:
        """Observe state and remote content, then return a frozen operation DAG."""

        del run_id  # execution run IDs do not affect deterministic plans
        diagnostics: list[Diagnostic] = []
        specs: dict[str, PageSpec] = {}
        for page in pages:
            source_id = page.identity.source_id
            if source_id in specs:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_DUPLICATE_SOURCE_ID",
                        severity=Severity.ERROR,
                        message=f"Source ID {source_id} appears more than once",
                    )
                )
            specs[source_id] = page

        observed: dict[str, RemoteContent | None] = {}
        conflicted: set[str] = set()
        recovering: set[str] = set()
        missing_tracked: dict[str, str] = {}
        unmapped_source_ids = {
            source_id for source_id in specs if self._state.page_id_for(source_id) is None
        }
        untracked_owned: dict[str, RemoteContent] = {}
        duplicate_untracked: set[str] = set()
        vault_ids = {page.identity.vault_id for page in specs.values()}
        if unmapped_source_ids and len(vault_ids) == 1:
            vault_id = next(iter(vault_ids))
            async for candidate in self._gateway.find_owned_content(
                vault_id=vault_id,
                root_page_id=target.root_page_id,
            ):
                marker = candidate.ownership
                if marker is None or marker.source_id not in unmapped_source_ids:
                    continue
                previous = untracked_owned.get(marker.source_id)
                if previous is not None and previous.content_id != candidate.content_id:
                    duplicate_untracked.add(marker.source_id)
                else:
                    untracked_owned[marker.source_id] = candidate
        for source_id, page in sorted(specs.items()):
            content_id = self._state.page_id_for(source_id)
            if content_id is None:
                observed[source_id] = None
                state_entry = self._state.entry_for(source_id)
                if (
                    state_entry is not None
                    and state_entry.get("last_successful_stage") == "create_pending"
                ):
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_CREATE_PENDING_RECONCILIATION",
                            severity=Severity.ERROR,
                            message=(
                                f"Source {source_id} has an unresolved pending create; "
                                "reconcile or explicitly adopt it before another create"
                            ),
                        )
                    )
                    conflicted.add(source_id)
                    continue
                if source_id in duplicate_untracked:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_DUPLICATE_REMOTE_SOURCE_ID",
                            severity=Severity.ERROR,
                            message=(
                                f"More than one owned content item claims source {source_id}; "
                                "repair the duplicate before publishing"
                            ),
                        )
                    )
                    conflicted.add(source_id)
                    continue
                discovered = untracked_owned.get(source_id)
                if discovered is not None:
                    try:
                        assert_owned(
                            discovered,
                            vault_id=page.identity.vault_id,
                            source_id=source_id,
                            space_key=target.space_key,
                            root_page_id=target.root_page_id,
                            source_kind=page.identity.kind,
                        )
                    except OwnershipError as exc:
                        diagnostics.append(
                            Diagnostic(
                                code="PLAN_REMOTE_OWNERSHIP_INVALID",
                                severity=Severity.ERROR,
                                message=f"Source {source_id}: {exc}",
                            )
                        )
                    else:
                        diagnostics.append(
                            Diagnostic(
                                code="PLAN_UNTRACKED_OWNED_SOURCE",
                                severity=Severity.ERROR,
                                message=(
                                    f"Owned content {discovered.content_id} already claims "
                                    f"source {source_id}, but local state has no mapping; "
                                    "run explicit adoption to repair state"
                                ),
                            )
                        )
                    conflicted.add(source_id)
                continue
            try:
                remote_content = await self._gateway.get_content(content_id)
            except NotFoundError:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_TRACKED_PAGE_MISSING",
                        severity=Severity.WARNING,
                        message=f"Tracked content for source {source_id} no longer exists",
                    )
                )
                observed[source_id] = None
                missing_tracked[source_id] = content_id
                continue
            except ConflictError as exc:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_REMOTE_OWNERSHIP_INVALID",
                        severity=Severity.ERROR,
                        message=f"Source {source_id}: {exc}",
                    )
                )
                observed[source_id] = None
                conflicted.add(source_id)
                continue
            observed[source_id] = remote_content
            state_entry = self._state.entry_for(source_id)
            if remote_content.ownership is None and _recoverable_created_page(
                state_entry,
                page,
                remote_content,
                target,
            ):
                recovering.add(source_id)
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_RECOVER_OWNERSHIP",
                        severity=Severity.WARNING,
                        message=(
                            f"Source {source_id} will resume ownership marking for its "
                            "checkpointed new content"
                        ),
                    )
                )
                continue
            try:
                assert_owned(
                    remote_content,
                    vault_id=page.identity.vault_id,
                    source_id=source_id,
                    space_key=target.space_key,
                    root_page_id=target.root_page_id,
                    source_kind=page.identity.kind,
                )
            except OwnershipError as exc:
                diagnostics.append(
                    Diagnostic(
                        code=exc.code.upper(),
                        severity=Severity.ERROR,
                        message=f"Source {source_id}: {exc}",
                    )
                )
                conflicted.add(source_id)
                observed[source_id] = None
                continue
            if remote_content.kind is not page.content_kind:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_CONTENT_KIND_CONFLICT",
                        severity=Severity.ERROR,
                        message=f"Source {source_id} cannot change content kind in place",
                    )
                )
                conflicted.add(source_id)
                observed[source_id] = None
                continue
            drift = _remote_drift(state_entry, remote_content)
            if drift is not None:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_REMOTE_DRIFT",
                        severity=Severity.ERROR,
                        message=f"Source {source_id}: {drift}",
                    )
                )
                conflicted.add(source_id)
                observed[source_id] = None

        # A child must never derive a parent ID from a source whose ownership, scope,
        # kind, or drift observation failed. Propagate that conflict through the tree.
        changed = True
        while changed:
            changed = False
            for source_id, page in sorted(specs.items()):
                parent_source_id = page.parent_source_id
                if source_id in conflicted or parent_source_id is None:
                    continue
                # An existing page with parent management disabled deliberately keeps
                # its already scope-validated remote parent; its frontmatter parent is
                # informational and must not block an unrelated body update.
                if observed.get(source_id) is not None and not _change_parent(page):
                    continue
                if parent_source_id not in specs or parent_source_id in conflicted:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_PARENT_CONFLICT",
                            severity=Severity.ERROR,
                            message=(
                                f"Source {source_id} cannot use unavailable or conflicted "
                                f"parent source {parent_source_id}"
                            ),
                        )
                    )
                    conflicted.add(source_id)
                    observed[source_id] = None
                    changed = True

        operations: list[PlannedOperation] = []
        ownership_ready: dict[str, str] = {}
        final_stage: dict[str, str] = {}

        # Create stages are established first so child dependencies can point to a
        # stable parent ownership operation regardless of lexical source ordering.
        for source_id, page in sorted(specs.items()):
            if source_id in conflicted or observed[source_id] is not None:
                continue
            parent_dependency: tuple[str, ...] = ()
            if page.parent_source_id is not None:
                parent_op = ownership_ready.get(page.parent_source_id)
                if parent_op is not None:
                    parent_dependency = (parent_op,)
            create = _operation(
                kind=OperationKind.CREATE_PAGE,
                source_id=source_id,
                content_id=None,
                prerequisites=parent_dependency,
                before={"missing_content_id": missing_tracked.get(source_id)},
                after={
                    "title": page.final_title,
                    "content_kind": page.content_kind.value,
                    "parent_source_id": page.parent_source_id,
                    "storage_sha256": page.desired_storage_sha256,
                    "defer_storage": _has_managed_attachments(page),
                },
            )
            owner = _operation(
                kind=OperationKind.CREATE_PROPERTY,
                source_id=source_id,
                content_id=None,
                prerequisites=(create.operation_id,),
                before={"property_version": None},
                after={"storage_sha256": page.desired_storage_sha256},
            )
            operations.extend((create, owner))
            ownership_ready[source_id] = owner.operation_id
            final_stage[source_id] = owner.operation_id

        # Existing pages have ownership already.  Create parent dependencies that were
        # not known in the first pass are patched into child create operations now.
        patched: list[PlannedOperation] = []
        for operation in operations:
            if operation.kind is OperationKind.CREATE_PAGE and operation.source_id is not None:
                parent_source = operation.after.get("parent_source_id")
                if isinstance(parent_source, str) and parent_source in ownership_ready:
                    operation = replace(
                        operation,
                        prerequisites=(ownership_ready[parent_source],),
                    )
            patched.append(operation)
        operations = patched

        for source_id, page in sorted(specs.items()):
            if source_id in conflicted:
                continue
            remote: RemoteContent | None = observed[source_id]
            current_stage = final_stage.get(source_id)
            expected_property_version: int | None = None
            previous_labels: tuple[str, ...] = ()
            pending_mutation: PlannedOperation | None = None
            if remote is not None:
                if source_id in recovering:
                    recovery_owner = _operation(
                        kind=OperationKind.CREATE_PROPERTY,
                        source_id=source_id,
                        content_id=remote.content_id,
                        prerequisites=(),
                        before={
                            **_remote_summary(remote),
                            "property_version": None,
                        },
                        after={"storage_sha256": page.desired_storage_sha256},
                        expected_version=remote.version,
                    )
                    operations.append(recovery_owner)
                    current_stage = recovery_owner.operation_id
                    ownership_ready[source_id] = recovery_owner.operation_id
                expected_parent = _desired_parent_id(page, observed, target, self._state)
                content_changed = (
                    remote.title != page.final_title
                    or remote.storage_sha256 != page.desired_storage_sha256
                )
                parent_unknown = (
                    page.content_kind is ContentKind.PAGE
                    and page.parent_source_id is not None
                    and expected_parent is None
                )
                parent_changed = parent_unknown or (
                    page.content_kind is ContentKind.PAGE
                    and expected_parent is not None
                    and remote.direct_parent_id != expected_parent
                )
                if content_changed or parent_changed:
                    parent_ready = (
                        ownership_ready.get(page.parent_source_id)
                        if page.parent_source_id is not None
                        else None
                    )
                    kind = (
                        OperationKind.MOVE_PAGE
                        if parent_changed and not content_changed
                        else OperationKind.UPDATE_PAGE
                    )
                    mutation = _operation(
                        kind=kind,
                        source_id=source_id,
                        content_id=remote.content_id,
                        prerequisites=(parent_ready,) if parent_ready else (),
                        before=_remote_summary(remote),
                        after={
                            "title": page.final_title,
                            "parent_source_id": page.parent_source_id,
                            "parent_id": expected_parent,
                            "storage_sha256": page.desired_storage_sha256,
                        },
                        expected_version=remote.version,
                    )
                    pending_mutation = mutation
                ownership_ready[source_id] = current_stage or ""
                expected_property_version = remote.ownership_property_version
                if remote.ownership is not None:
                    previous_labels = remote.ownership.managed_labels

            if remote is None and _has_managed_attachments(page):
                pending_mutation = _operation(
                    kind=OperationKind.UPDATE_PAGE,
                    source_id=source_id,
                    content_id=None,
                    prerequisites=(),
                    before={},
                    after={
                        "title": page.final_title,
                        "parent_source_id": page.parent_source_id,
                        "parent_id": None,
                        "storage_sha256": page.desired_storage_sha256,
                        "finalize_after_assets": True,
                    },
                )

            for asset in page.assets:
                if asset.attachment_filename is None:
                    continue
                observation: AttachmentObservation | None = None
                if (
                    remote is not None
                    and source_id not in recovering
                    and isinstance(self._gateway, AttachmentObserver)
                ):
                    try:
                        observation = await self._gateway.observe_asset(remote.content_id, asset)
                    except (ConflictError, OwnershipError) as exc:
                        diagnostics.append(
                            Diagnostic(
                                code="PLAN_ATTACHMENT_CONFLICT",
                                severity=Severity.ERROR,
                                message=f"Source {source_id}, asset {asset.asset_id}: {exc}",
                            )
                        )
                        conflicted.add(source_id)
                        continue
                if (
                    observation is not None
                    and observation.disposition is AttachmentDisposition.UNCHANGED
                    and _state_asset_matches(
                        self._state.entry_for(source_id),
                        asset,
                        observation,
                    )
                ):
                    continue
                asset_kind = (
                    OperationKind.UPDATE_ATTACHMENT
                    if observation is not None
                    and observation.disposition is AttachmentDisposition.CHANGED
                    else OperationKind.CREATE_ATTACHMENT
                )
                asset_op = _operation(
                    kind=asset_kind,
                    source_id=source_id,
                    content_id=remote.content_id if remote else None,
                    prerequisites=(current_stage,) if current_stage else (),
                    before={
                        **(_remote_summary(remote) if remote is not None else {}),
                        "attachment_id": observation.attachment_id if observation else None,
                        "attachment_sha256": (observation.observed_sha256 if observation else None),
                    },
                    after={
                        "asset_id": asset.asset_id,
                        "filename": asset.attachment_filename,
                        "sha256": asset.sha256,
                    },
                    expected_version=remote.version if remote is not None else None,
                    suffix=asset.asset_id,
                )
                operations.append(asset_op)
                current_stage = asset_op.operation_id

            if pending_mutation is not None:
                prerequisites = list(pending_mutation.prerequisites)
                if current_stage and current_stage not in prerequisites:
                    prerequisites.append(current_stage)
                pending_mutation = replace(
                    pending_mutation,
                    prerequisites=tuple(prerequisites),
                )
                operations.append(pending_mutation)
                current_stage = pending_mutation.operation_id

            current_labels: frozenset[str] | None = None
            if (
                remote is not None
                and source_id not in recovering
                and isinstance(self._gateway, LabelObserver)
            ):
                try:
                    current_labels = await self._gateway.observe_labels(remote.content_id)
                except (ConflictError, OwnershipError) as exc:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_LABEL_CONFLICT",
                            severity=Severity.ERROR,
                            message=f"Source {source_id}: {exc}",
                        )
                    )
                    conflicted.add(source_id)
            desired_label_set = set(page.labels)
            previous_label_set = set(previous_labels)
            label_marker_changed = desired_label_set != previous_label_set
            label_remote_changed = (
                bool(desired_label_set)
                if current_labels is None and remote is None
                else label_marker_changed
                if current_labels is None
                else bool(
                    (desired_label_set - current_labels)
                    or ((previous_label_set - desired_label_set) & current_labels)
                )
            )
            if label_remote_changed:
                label_op = _operation(
                    kind=OperationKind.ADD_LABEL,
                    source_id=source_id,
                    content_id=remote.content_id if remote else None,
                    prerequisites=(current_stage,) if current_stage else (),
                    before={
                        **(_remote_summary(remote) if remote is not None else {}),
                        "managed_labels": tuple(sorted(previous_labels)),
                        "current_labels": tuple(sorted(current_labels or ())),
                    },
                    after={"managed_labels": tuple(sorted(page.labels))},
                    expected_version=remote.version if remote is not None else None,
                )
                operations.append(label_op)
                current_stage = label_op.operation_id

            marker_changed = (
                remote is not None
                and remote.ownership is not None
                and (
                    remote.ownership.last_render_sha256 != page.desired_storage_sha256
                    or remote.ownership.source_path != page.identity.relative_path
                    or label_marker_changed
                )
            )
            finalize_initial_marker = (
                pending_mutation is not None
                and (remote is None or source_id in recovering)
                and _has_managed_attachments(page)
            )
            if (marker_changed and remote is not None) or finalize_initial_marker:
                property_op = _operation(
                    kind=OperationKind.UPDATE_PROPERTY,
                    source_id=source_id,
                    content_id=remote.content_id if remote is not None else None,
                    prerequisites=(current_stage,) if current_stage else (),
                    before={"property_version": expected_property_version},
                    after={
                        "storage_sha256": page.desired_storage_sha256,
                        "runtime_property_version": finalize_initial_marker,
                    },
                    expected_version=remote.version if remote is not None else None,
                )
                operations.append(property_op)
                current_stage = property_op.operation_id

            state_needs_commit = remote is not None and _state_out_of_date(
                self._state.entry_for(source_id), page, remote
            )
            if current_stage or state_needs_commit:
                readback = _operation(
                    kind=OperationKind.READBACK,
                    source_id=source_id,
                    content_id=remote.content_id if remote else None,
                    prerequisites=(current_stage,) if current_stage else (),
                    before={},
                    after={"storage_sha256": page.desired_storage_sha256},
                )
                commit = _operation(
                    kind=OperationKind.COMMIT_STATE,
                    source_id=source_id,
                    content_id=remote.content_id if remote else None,
                    prerequisites=(readback.operation_id,),
                    before={"state_generation": self._state.generation},
                    after={"input_sha256": page.input_sha256},
                )
                operations.extend((readback, commit))
                final_stage[source_id] = commit.operation_id
            elif remote is not None and self._verify_skipped:
                verify = _operation(
                    kind=OperationKind.READBACK,
                    source_id=source_id,
                    content_id=remote.content_id,
                    prerequisites=(),
                    before=_remote_summary(remote),
                    after={
                        "storage_sha256": page.desired_storage_sha256,
                        "verify_only": True,
                    },
                    expected_version=remote.version,
                )
                operations.append(verify)
                final_stage[source_id] = verify.operation_id

        # Label/attachment observation failures are discovered while constructing
        # stages.  Quarantine that entire source (and every child that would depend on
        # it) so no content/property mutation can run with an unresolved side effect.
        changed = True
        while changed:
            changed = False
            for source_id, page in sorted(specs.items()):
                parent_source_id = page.parent_source_id
                if source_id in conflicted or parent_source_id is None:
                    continue
                if observed.get(source_id) is not None and not _change_parent(page):
                    continue
                if parent_source_id in conflicted:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_PARENT_CONFLICT",
                            severity=Severity.ERROR,
                            message=(
                                f"Source {source_id} cannot use conflicted parent source "
                                f"{parent_source_id}"
                            ),
                        )
                    )
                    conflicted.add(source_id)
                    changed = True
        if conflicted:
            operations = [
                operation
                for operation in operations
                if operation.source_id is None or operation.source_id not in conflicted
            ]
            final_stage = {
                source_id: stage
                for source_id, stage in final_stage.items()
                if source_id not in conflicted
            }

        operations = _bind_parent_dependencies(operations, specs, final_stage)

        await self._append_orphans(
            target=target,
            specs=specs,
            selection=selection,
            operations=operations,
            final_stage=final_stage,
            conflicted=conflicted,
            diagnostics=diagnostics,
        )
        _validate_dag(operations)
        frozen_specs: Mapping[str, PageSpec] = MappingProxyType(dict(specs))
        digest = calculate_plan_digest_values(
            target_fingerprint=target.fingerprint,
            source_set_sha256=source_set_sha256,
            state_generation=self._state.generation,
            operations=operations,
            page_specs=specs,
        )
        return PublishPlan(
            plan_id=f"plan-{digest[:24]}",
            target=target,
            source_set_sha256=source_set_sha256,
            state_generation=self._state.generation,
            operations=tuple(operations),
            page_specs=frozen_specs,
            diagnostics=tuple(diagnostics),
            digest=digest,
            created_at=datetime.now(UTC),
        )

    async def build_adoption(
        self,
        *,
        target: TargetIdentity,
        page: PageSpec,
        content_id: str,
    ) -> PublishPlan:
        """Build a read-only, exact-target adoption plan for one source and page ID.

        Adoption proves scope and identity but deliberately does not compare or plan a
        body update.  A subsequent ordinary plan may publish the local body after the
        adopted remote version/hash have become the explicit baseline.
        """

        diagnostics: list[Diagnostic] = []
        source_id = page.identity.source_id
        mapped_id = self._state.page_id_for(source_id)
        if mapped_id is not None and mapped_id != content_id:
            diagnostics.append(
                Diagnostic(
                    code="ADOPT_SOURCE_ALREADY_MAPPED",
                    severity=Severity.ERROR,
                    message="Source is already mapped to a different Confluence content ID",
                )
            )
        for tracked_source_id in sorted(self._state.tracked_source_ids()):
            if (
                tracked_source_id != source_id
                and self._state.page_id_for(tracked_source_id) == content_id
            ):
                diagnostics.append(
                    Diagnostic(
                        code="ADOPT_DUPLICATE_PAGE_ID",
                        severity=Severity.ERROR,
                        message="Confluence content ID is already mapped to another source",
                    )
                )
                break

        remote = await self._gateway.get_content(content_id)
        try:
            assert_in_scope(
                remote,
                space_key=target.space_key,
                root_page_id=target.root_page_id,
            )
        except OwnershipError as exc:
            diagnostics.append(
                Diagnostic(
                    code=exc.code.upper(),
                    severity=Severity.ERROR,
                    message=str(exc),
                )
            )
        if remote.kind is not page.content_kind:
            diagnostics.append(
                Diagnostic(
                    code="ADOPT_CONTENT_KIND_CONFLICT",
                    severity=Severity.ERROR,
                    message="Adoption target has a different content kind",
                )
            )
        if remote.status != "current":
            diagnostics.append(
                Diagnostic(
                    code="ADOPT_CONTENT_NOT_CURRENT",
                    severity=Severity.ERROR,
                    message="Only current content can be adopted",
                )
            )
        marker = remote.ownership
        repair_existing_ownership = False
        if marker is not None:
            if marker.vault_id == page.identity.vault_id and marker.source_id == source_id:
                try:
                    assert_owned(
                        remote,
                        vault_id=page.identity.vault_id,
                        source_id=source_id,
                        space_key=target.space_key,
                        root_page_id=target.root_page_id,
                        source_kind=page.identity.kind,
                    )
                except OwnershipError as exc:
                    diagnostics.append(
                        Diagnostic(
                            code="ADOPT_OWNERSHIP_SCOPE_CONFLICT",
                            severity=Severity.ERROR,
                            message=str(exc),
                        )
                    )
                else:
                    repair_existing_ownership = True
                    diagnostics.append(
                        Diagnostic(
                            code="ADOPT_ALREADY_OWNED",
                            severity=Severity.WARNING,
                            message=(
                                "Content is already owned by this source; adoption "
                                "will repair the durable local mapping only"
                            ),
                        )
                    )
            else:
                diagnostics.append(
                    Diagnostic(
                        code="ADOPT_FOREIGN_OWNERSHIP",
                        severity=Severity.ERROR,
                        message="Content is already owned by a different vault or source",
                    )
                )
        if remote.storage_sha256 is None:
            diagnostics.append(
                Diagnostic(
                    code="ADOPT_STORAGE_UNOBSERVED",
                    severity=Severity.ERROR,
                    message="Adoption requires a storage-body readback hash",
                )
            )

        operations: list[PlannedOperation] = []
        if not any(item.severity is Severity.ERROR for item in diagnostics) and marker is None:
            operations.append(
                _operation(
                    kind=OperationKind.ADOPT_PAGE,
                    source_id=source_id,
                    content_id=remote.content_id,
                    prerequisites=(),
                    before=_remote_summary(remote),
                    after={
                        "storage_sha256": remote.storage_sha256,
                        "managed_labels": (),
                    },
                    expected_version=remote.version,
                )
            )
        elif (
            not any(item.severity is Severity.ERROR for item in diagnostics)
            and repair_existing_ownership
        ):
            operations.append(
                _operation(
                    kind=OperationKind.ADOPT_PAGE,
                    source_id=source_id,
                    content_id=remote.content_id,
                    prerequisites=(),
                    before=_remote_summary(remote),
                    after={
                        "storage_sha256": remote.storage_sha256,
                        "managed_labels": tuple(sorted(marker.managed_labels)) if marker else (),
                        "state_repair_only": True,
                    },
                    expected_version=remote.version,
                    suffix="state-repair",
                )
            )
        source_set_sha256 = hashlib.sha256(
            f"adopt|{source_id}|{content_id}|{page.input_sha256}".encode()
        ).hexdigest()
        _validate_dag(operations)
        digest = calculate_plan_digest_values(
            target_fingerprint=target.fingerprint,
            source_set_sha256=source_set_sha256,
            state_generation=self._state.generation,
            operations=operations,
            page_specs={source_id: page},
        )
        return PublishPlan(
            plan_id=f"plan-{digest[:24]}",
            target=target,
            source_set_sha256=source_set_sha256,
            state_generation=self._state.generation,
            operations=tuple(operations),
            page_specs=MappingProxyType({source_id: page}),
            diagnostics=tuple(diagnostics),
            digest=digest,
            created_at=datetime.now(UTC),
        )

    async def _append_orphans(
        self,
        *,
        target: TargetIdentity,
        specs: Mapping[str, PageSpec],
        selection: Selection,
        operations: list[PlannedOperation],
        final_stage: Mapping[str, str],
        conflicted: set[str],
        diagnostics: list[Diagnostic],
    ) -> None:
        if not selection.authoritative:
            return
        if self._orphan_action is OrphanAction.OFF:
            return
        vault_ids = {page.identity.vault_id for page in specs.values()}
        if len(vault_ids) > 1:
            diagnostics.append(
                Diagnostic(
                    code="PLAN_MULTIPLE_VAULTS",
                    severity=Severity.ERROR,
                    message="One publish plan cannot reconcile more than one vault identity",
                )
            )
            return
        vault_id = next(iter(vault_ids), None)
        if vault_id is None and isinstance(self._state, VaultIdentityState):
            vault_id = self._state.vault_id

        remote_by_source: dict[str, RemoteContent] = {}
        if vault_id is not None:
            async for search_remote in self._gateway.find_owned_content(
                vault_id=vault_id,
                root_page_id=target.root_page_id,
            ):
                marker = search_remote.ownership
                if marker is None or marker.source_id in specs:
                    continue
                previous = remote_by_source.get(marker.source_id)
                if previous is not None and previous.content_id != search_remote.content_id:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_DUPLICATE_REMOTE_SOURCE_ID",
                            severity=Severity.ERROR,
                            message=(
                                f"More than one owned content item claims source {marker.source_id}"
                            ),
                        )
                    )
                    continue
                remote_by_source[marker.source_id] = search_remote

        orphan_ids = sorted(
            (self._state.tracked_source_ids() - specs.keys()) | remote_by_source.keys()
        )
        candidates: list[RemoteContent] = []
        for source_id in orphan_ids:
            candidate_remote = remote_by_source.get(source_id)
            if candidate_remote is None:
                page_id = self._state.page_id_for(source_id)
                if page_id is None:
                    continue
                try:
                    candidate_remote = await self._gateway.get_content(page_id)
                except NotFoundError:
                    continue
                except ConflictError as exc:
                    diagnostics.append(
                        Diagnostic(
                            code="PLAN_ORPHAN_OWNERSHIP_CONFLICT",
                            severity=Severity.ERROR,
                            message=f"Orphan {source_id}: {exc}",
                        )
                    )
                    continue
            expected_vault_id: object = vault_id
            if not isinstance(expected_vault_id, str):
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_ORPHAN_VAULT_UNAVAILABLE",
                        severity=Severity.ERROR,
                        message="Cannot reconcile orphans without an authoritative local vault ID",
                    )
                )
                continue
            try:
                assert_owned(
                    candidate_remote,
                    vault_id=str(expected_vault_id),
                    source_id=source_id,
                    space_key=target.space_key,
                    root_page_id=target.root_page_id,
                )
            except OwnershipError as exc:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_ORPHAN_OWNERSHIP_CONFLICT",
                        severity=Severity.ERROR,
                        message=f"Orphan {source_id}: {exc}",
                    )
                )
                continue
            candidates.append(candidate_remote)

        if self._orphan_action is OrphanAction.REPORT:
            for remote in candidates:
                diagnostics.append(
                    Diagnostic(
                        code="PLAN_ORPHAN_REPORTED",
                        severity=Severity.WARNING,
                        message=f"Owned content {remote.content_id} is no longer in the source set",
                    )
                )
            return
        if not specs and candidates:
            diagnostics.append(
                Diagnostic(
                    code="PLAN_ZERO_SOURCE_TRASH_REFUSED",
                    severity=Severity.ERROR,
                    message="Refusing to trash orphans from an empty authoritative source set",
                )
            )
            return
        if len(candidates) > self._max_trash_count:
            diagnostics.append(
                Diagnostic(
                    code="PLAN_TRASH_CAP_EXCEEDED",
                    severity=Severity.ERROR,
                    message="Orphan count exceeds the configured trash safety cap",
                )
            )
            return
        if conflicted and candidates:
            diagnostics.append(
                Diagnostic(
                    code="PLAN_TRASH_LIVE_CONFLICT_REFUSED",
                    severity=Severity.ERROR,
                    message=(
                        "Refusing orphan trash while one or more live sources have "
                        "unresolved ownership, scope, hierarchy, or drift conflicts"
                    ),
                )
            )
            return
        all_live = tuple(sorted(value for value in final_stage.values() if value))
        for remote in candidates:
            marker = remote.ownership
            candidate_source_id = marker.source_id if marker else None
            entry = (
                self._state.entry_for(candidate_source_id)
                if candidate_source_id is not None
                else None
            )
            tracked_path = entry.get("source_path") if entry is not None else None
            source_path = tracked_path if isinstance(tracked_path, str) else None
            reason = "source_absent_from_authoritative_corpus"
            operations.append(
                _operation(
                    kind=OperationKind.TRASH_PAGE,
                    source_id=candidate_source_id,
                    content_id=remote.content_id,
                    prerequisites=all_live,
                    before={
                        **_remote_summary(remote),
                        "source_path": source_path,
                        "reason": reason,
                    },
                    after={
                        "status": "trashed",
                        "source_path": source_path,
                        "reason": reason,
                    },
                    expected_version=remote.version,
                    destructive=True,
                )
            )


def calculate_plan_digest(plan: PublishPlan) -> str:
    return calculate_plan_digest_values(
        target_fingerprint=plan.target.fingerprint,
        source_set_sha256=plan.source_set_sha256,
        state_generation=plan.state_generation,
        operations=plan.operations,
        page_specs=plan.page_specs,
    )


def calculate_plan_digest_values(
    *,
    target_fingerprint: str,
    source_set_sha256: str,
    state_generation: int,
    operations: Sequence[PlannedOperation],
    page_specs: Mapping[str, PageSpec],
) -> str:
    canonical = {
        "target_fingerprint": target_fingerprint,
        "source_set_sha256": source_set_sha256,
        "state_generation": state_generation,
        "page_specs": {
            source_id: _page_spec_summary(page) for source_id, page in sorted(page_specs.items())
        },
        "operations": [
            {
                "operation_id": operation.operation_id,
                "kind": operation.kind.value,
                "source_id": operation.source_id,
                "content_id": operation.content_id,
                "prerequisites": list(operation.prerequisites),
                "before": _json_safe(operation.before),
                "after": _json_safe(operation.after),
                "expected_version": operation.expected_version,
                "destructive": operation.destructive,
            }
            for operation in operations
        ],
    }
    payload = json.dumps(canonical, sort_keys=True, separators=(",", ":"), ensure_ascii=False)
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _page_spec_summary(page: PageSpec) -> Mapping[str, object]:
    return {
        "identity": {
            "vault_id": page.identity.vault_id,
            "source_id": page.identity.source_id,
            "relative_path": page.identity.relative_path,
            "kind": page.identity.kind.value,
        },
        "final_title": page.final_title,
        "content_kind": page.content_kind.value,
        "parent_source_id": page.parent_source_id,
        "desired_storage_sha256": page.desired_storage_sha256,
        "input_sha256": page.input_sha256,
        "labels": list(page.labels),
        "assets": [
            {
                "asset_id": asset.asset_id,
                "kind": asset.kind,
                "source": asset.source,
                "attachment_filename": asset.attachment_filename,
                "mime_type": asset.mime_type,
                "sha256": asset.sha256,
                "size": asset.size,
                "width": asset.width,
                "height": asset.height,
                "alt_text": asset.alt_text,
            }
            for asset in page.assets
        ],
        "policy_id": page.policy_id,
        "change_parent": page.change_parent,
    }


def validate_plan_approval(plan: PublishPlan, approval: PlanApproval | None) -> None:
    if calculate_plan_digest(plan) != plan.digest:
        raise PlanApprovalError("Plan digest does not match its immutable contents")
    requires_approval = plan.has_destructive_operations or any(
        operation.kind is OperationKind.ADOPT_PAGE for operation in plan.operations
    )
    if not requires_approval:
        return
    if approval is None:
        raise PlanApprovalError("Plan requires explicit digest approval")
    if (
        approval.plan_id != plan.plan_id
        or approval.digest != plan.digest
        or not approval.actor.strip()
    ):
        raise PlanApprovalError("Approval does not match this exact plan")


def _operation(
    *,
    kind: OperationKind,
    source_id: str | None,
    content_id: str | None,
    prerequisites: Sequence[str],
    before: Mapping[str, object],
    after: Mapping[str, object],
    expected_version: int | None = None,
    destructive: bool = False,
    suffix: str = "",
) -> PlannedOperation:
    identity = "|".join((kind.value, source_id or "", content_id or "", suffix))
    operation_id = f"op-{hashlib.sha256(identity.encode()).hexdigest()[:24]}"
    return PlannedOperation(
        operation_id=operation_id,
        kind=kind,
        source_id=source_id,
        content_id=content_id,
        prerequisites=tuple(prerequisites),
        before=MappingProxyType(dict(before)),
        after=MappingProxyType(dict(after)),
        expected_version=expected_version,
        destructive=destructive,
    )


def _remote_summary(remote: RemoteContent) -> Mapping[str, object]:
    return {
        "version": remote.version,
        "property_version": remote.ownership_property_version,
        "storage_sha256": remote.storage_sha256,
        "parent_id": remote.direct_parent_id,
        "title": remote.title,
        "space_key": remote.space_key,
    }


def _desired_parent_id(
    page: PageSpec,
    observed: Mapping[str, RemoteContent | None],
    target: TargetIdentity,
    state: StateStore,
) -> str | None:
    if page.content_kind is ContentKind.BLOGPOST:
        return None
    current = observed.get(page.identity.source_id)
    if current is not None and not _change_parent(page):
        return current.direct_parent_id
    if page.parent_source_id is None:
        return target.root_page_id
    parent = observed.get(page.parent_source_id)
    if parent is not None:
        return parent.content_id
    return state.page_id_for(page.parent_source_id)


def _remote_drift(entry: Mapping[str, object] | None, remote: RemoteContent) -> str | None:
    if entry is None:
        return None
    expected_version = entry.get("remote_version")
    expected_hash = entry.get("remote_storage_sha256")
    if isinstance(expected_version, int) and expected_version != remote.version:
        return f"remote version changed from {expected_version} to {remote.version}"
    if isinstance(expected_hash, str) and expected_hash != remote.storage_sha256:
        return "remote storage hash changed after the last successful readback"
    return None


def _state_out_of_date(
    entry: Mapping[str, object] | None,
    page: PageSpec,
    remote: RemoteContent,
) -> bool:
    if entry is None:
        return True
    labels = entry.get("managed_labels")
    observed_labels = (
        tuple(labels)
        if isinstance(labels, (tuple, list)) and all(isinstance(item, str) for item in labels)
        else ()
    )
    return any(
        (
            entry.get("source_path") != page.identity.relative_path,
            entry.get("source_kind") != page.identity.kind.value,
            entry.get("page_id") != remote.content_id,
            entry.get("content_type") != page.content_kind.value,
            entry.get("parent_page_id") != remote.direct_parent_id,
            entry.get("input_sha256") != page.input_sha256,
            entry.get("remote_version") != remote.version,
            entry.get("remote_storage_sha256") != remote.storage_sha256,
            entry.get("ownership_property_version") != remote.ownership_property_version,
            tuple(sorted(observed_labels)) != tuple(sorted(page.labels)),
        )
    )


def _recoverable_created_page(
    entry: Mapping[str, object] | None,
    page: PageSpec,
    remote: RemoteContent,
    target: TargetIdentity,
) -> bool:
    if entry is None or entry.get("last_successful_stage") != "created":
        return False
    expected_parent = entry.get("parent_page_id")
    return all(
        (
            remote.status == "current",
            remote.ownership is None,
            remote.ownership_property_version is None,
            remote.version == 1,
            entry.get("page_id") == remote.content_id,
            entry.get("source_path") == page.identity.relative_path,
            entry.get("source_kind") == page.identity.kind.value,
            entry.get("content_type") == page.content_kind.value,
            entry.get("input_sha256") == page.input_sha256,
            remote.kind is page.content_kind,
            remote.title == page.final_title,
            remote.space_key == target.space_key,
            target.root_page_id in remote.ancestor_ids if remote.kind is ContentKind.PAGE else True,
            remote.direct_parent_id == expected_parent,
            remote.storage_sha256 == entry.get("remote_storage_sha256"),
        )
    )


def _validate_dag(operations: Sequence[PlannedOperation]) -> None:
    identifiers = {operation.operation_id for operation in operations}
    if len(identifiers) != len(operations):
        raise PlanError("Plan contains duplicate operation identifiers")
    dependencies = {
        operation.operation_id: set(operation.prerequisites) for operation in operations
    }
    if any(not prerequisite <= identifiers for prerequisite in dependencies.values()):
        raise PlanError("Plan contains an unknown prerequisite")
    ready = [identifier for identifier, values in dependencies.items() if not values]
    visited: set[str] = set()
    while ready:
        identifier = ready.pop()
        if identifier in visited:
            continue
        visited.add(identifier)
        for candidate, values in dependencies.items():
            values.discard(identifier)
            if not values and candidate not in visited:
                ready.append(candidate)
    if len(visited) != len(operations):
        raise PlanError("Plan operation graph contains a cycle")


def _bind_parent_dependencies(
    operations: Sequence[PlannedOperation],
    specs: Mapping[str, PageSpec],
    final_stage: Mapping[str, str],
) -> list[PlannedOperation]:
    result: list[PlannedOperation] = []
    for operation in operations:
        source_id = operation.source_id
        if (
            operation.kind
            in {
                OperationKind.CREATE_PAGE,
                OperationKind.UPDATE_PAGE,
                OperationKind.MOVE_PAGE,
            }
            and source_id is not None
            and source_id in specs
        ):
            page = specs[source_id]
            parent_source_id = page.parent_source_id
            needs_parent_dependency = operation.kind is OperationKind.CREATE_PAGE or _change_parent(
                page
            )
            if (
                needs_parent_dependency
                and parent_source_id is not None
                and parent_source_id in final_stage
            ):
                prerequisites = list(operation.prerequisites)
                parent_stage = final_stage[parent_source_id]
                if parent_stage not in prerequisites:
                    prerequisites.append(parent_stage)
                operation = replace(
                    operation,
                    prerequisites=tuple(prerequisites),
                )
        result.append(operation)
    return result


def _change_parent(page: PageSpec) -> bool:
    return page.change_parent


def _has_managed_attachments(page: PageSpec) -> bool:
    return any(asset.attachment_filename is not None for asset in page.assets)


def _state_asset_matches(
    entry: Mapping[str, object] | None,
    asset: AssetSpec,
    observation: AttachmentObservation,
) -> bool:
    if entry is None or observation.attachment_id is None or asset.sha256 is None:
        return False
    managed_assets = entry.get("managed_assets")
    if not isinstance(managed_assets, Mapping):
        return False
    value = managed_assets.get(asset.asset_id)
    if not isinstance(value, Mapping):
        return False
    return (
        value.get("attachment_id") == observation.attachment_id
        and value.get("sha256") == asset.sha256
    )


def _json_safe(value: object) -> object:
    if isinstance(value, Mapping):
        return {str(key): _json_safe(item) for key, item in sorted(value.items())}
    if isinstance(value, (tuple, list)):
        return [_json_safe(item) for item in value]
    if value is None or isinstance(value, (str, int, float, bool)):
        return value
    raise PlanError("Plan summaries contain a non-serializable value")
