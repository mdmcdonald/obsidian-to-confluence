"""Bounded execution of immutable publish-plan DAGs."""

from __future__ import annotations

import asyncio
import hashlib
import os
import stat
import time
from collections.abc import Mapping
from contextlib import suppress
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import MappingProxyType
from typing import Protocol, runtime_checkable
from uuid import uuid4

from md2conf_dc.confluence.errors import (
    AmbiguousWriteError,
    ConflictError,
    ConfluenceError,
    NotFoundError,
)
from md2conf_dc.confluence.models import canonical_storage_sha256
from md2conf_dc.events import EventKind, EventSink, NullEventSink, PublishEvent
from md2conf_dc.interfaces import ConfluenceGateway, StateStore
from md2conf_dc.models import (
    AssetSpec,
    CancellationToken,
    ContentKind,
    Diagnostic,
    OperationKind,
    OperationOutcome,
    OutcomeStatus,
    OwnershipMarker,
    PageSpec,
    PlanApproval,
    PlannedOperation,
    PublishPlan,
    PublishReport,
    RemoteContent,
    Severity,
)
from md2conf_dc.ownership import (
    PUBLISHER_ID,
    MutationExpectation,
    ObservationConflict,
    OwnershipError,
    assert_in_scope,
    assert_observation,
    assert_owned,
)
from md2conf_dc.planner import PlanApprovalError, calculate_plan_digest, validate_plan_approval

_ISOLATABLE_PLAN_ERRORS = {
    "OWNERSHIP_CONFLICT",
    "SCOPE_VIOLATION",
    "PLAN_ATTACHMENT_CONFLICT",
    "PLAN_CONTENT_KIND_CONFLICT",
    "PLAN_CREATE_PENDING_RECONCILIATION",
    "PLAN_LABEL_CONFLICT",
    "PLAN_ORPHAN_OWNERSHIP_CONFLICT",
    "PLAN_PARENT_CONFLICT",
    "PLAN_REMOTE_DRIFT",
    "PLAN_REMOTE_OWNERSHIP_INVALID",
    "PLAN_TRASH_LIVE_CONFLICT_REFUSED",
    "PLAN_UNTRACKED_OWNED_SOURCE",
}
_ASSET_STAGING_STORAGE = "<p>Managed page assets are being prepared.</p>"
_DEFAULT_MAX_ASSET_BYTES = 100 * 1024 * 1024


@runtime_checkable
class EntryRemover(Protocol):
    def remove_entries(self, source_ids: tuple[str, ...]) -> None: ...


@runtime_checkable
class GuardedMutationGateway(Protocol):
    """Concrete gateway seam that performs the final authoritative write guard."""

    supports_guarded_mutations: bool

    async def create_content(
        self,
        *,
        title: str,
        content_type: str,
        space_key: str,
        parent_id: str | None,
        storage_value: str,
        parent_expectation: MutationExpectation | None,
    ) -> RemoteContent: ...

    async def update_content(
        self,
        *,
        content: RemoteContent,
        title: str,
        parent_id: str | None,
        storage_value: str,
        parent_expectation: MutationExpectation | None,
    ) -> RemoteContent: ...

    async def set_ownership(
        self,
        content_id: str,
        marker: OwnershipMarker,
        property_version: int | None,
        *,
        expectation: MutationExpectation,
    ) -> int: ...

    async def reconcile_labels(
        self,
        content_id: str,
        desired: tuple[str, ...],
        previously_managed: tuple[str, ...],
        *,
        expectation: MutationExpectation,
    ) -> None: ...

    async def reconcile_asset(
        self,
        content_id: str,
        asset: AssetSpec,
        source: Path,
        *,
        expectation: MutationExpectation,
    ) -> str: ...

    async def trash_content(
        self,
        content_id: str,
        *,
        expectation: MutationExpectation,
    ) -> None: ...


class PlanExecutionError(RuntimeError):
    code = "plan_execution_refused"


class PlanStaleError(PlanExecutionError):
    code = "stale_plan"


@dataclass(frozen=True, slots=True)
class _ExecutionResult:
    outcome: OperationOutcome
    remote: RemoteContent | None = None


class PlanExecutor:
    """Execute ready DAG operations and checkpoint every proven page stage."""

    def __init__(
        self,
        gateway: ConfluenceGateway,
        state: StateStore,
        *,
        event_sink: EventSink | None = None,
        concurrency: int = 4,
        fail_fast: bool = False,
        asset_root: Path | None = None,
        asset_cache_root: Path | None = None,
        asset_sources: Mapping[str, Path] | None = None,
        max_asset_bytes: int = _DEFAULT_MAX_ASSET_BYTES,
    ) -> None:
        if concurrency < 1:
            raise ValueError("concurrency must be positive")
        if max_asset_bytes < 1:
            raise ValueError("max_asset_bytes must be positive")
        self._gateway = gateway
        self._state = state
        self._events = event_sink or NullEventSink()
        self._concurrency = concurrency
        self._fail_fast = fail_fast
        if asset_root is not None:
            resolved_root = asset_root.expanduser().resolve(strict=True)
            if not resolved_root.is_dir():
                raise ValueError("asset_root must be an existing directory")
            self._asset_root: Path | None = resolved_root
        else:
            self._asset_root = None
        if asset_cache_root is not None:
            resolved_cache = asset_cache_root.expanduser().resolve(strict=True)
            if not resolved_cache.is_dir():
                raise ValueError("asset_cache_root must be an existing directory")
            self._asset_cache_root: Path | None = resolved_cache
        else:
            self._asset_cache_root = None
        allowed_asset_roots = tuple(
            root for root in (self._asset_root, self._asset_cache_root) if root is not None
        )
        resolved_sources: dict[str, Path] = {}
        for asset_id, source in (asset_sources or {}).items():
            if not isinstance(asset_id, str) or not asset_id:
                raise ValueError("asset_sources keys must be non-empty asset IDs")
            resolved = source.expanduser().resolve(strict=True)
            if not resolved.is_file():
                raise ValueError("asset_sources values must be existing files")
            if not allowed_asset_roots or not any(
                _is_relative_to(resolved, root) for root in allowed_asset_roots
            ):
                raise ValueError("Resolved asset source is outside the allowed asset roots")
            resolved_sources[asset_id] = resolved
        self._asset_sources: Mapping[str, Path] = MappingProxyType(resolved_sources)
        self._max_asset_bytes = max_asset_bytes
        self._checkpoint_lock = asyncio.Lock()

    async def execute(
        self,
        plan: PublishPlan,
        *,
        approval: PlanApproval | None = None,
        cancellation: CancellationToken | None = None,
    ) -> PublishReport:
        _validate_plan_page_specs(plan)
        _validate_runtime_asset_sources(
            plan,
            self._asset_sources,
            max_asset_bytes=self._max_asset_bytes,
        )
        if _has_remote_mutations(plan) and self._guarded_gateway() is None:
            raise PlanExecutionError(
                "Gateway does not implement mandatory guarded mutation expectations"
            )
        blocking_errors = tuple(
            diagnostic
            for diagnostic in plan.diagnostics
            if diagnostic.severity is Severity.ERROR
            and diagnostic.code not in _ISOLATABLE_PLAN_ERRORS
        )
        if blocking_errors:
            raise PlanExecutionError("Plan contains error diagnostics and cannot be applied")
        isolated_conflicts = tuple(
            diagnostic
            for diagnostic in plan.diagnostics
            if diagnostic.severity is Severity.ERROR and diagnostic.code in _ISOLATABLE_PLAN_ERRORS
        )
        reported_orphans = tuple(
            diagnostic
            for diagnostic in plan.diagnostics
            if diagnostic.code == "PLAN_ORPHAN_REPORTED"
        )
        if calculate_plan_digest(plan) != plan.digest:
            raise PlanStaleError("Plan digest changed after construction")
        if self._state.generation != plan.state_generation:
            raise PlanStaleError("State generation changed after planning")
        try:
            validate_plan_approval(plan, approval)
        except PlanApprovalError as exc:
            raise PlanExecutionError(str(exc)) from exc
        current_target = await self._gateway.preflight(plan.target.root_page_id)
        if current_target.fingerprint != plan.target.fingerprint:
            raise PlanStaleError("Confluence target changed after planning")

        token = cancellation or CancellationToken()
        run_id = str(uuid4())
        started_at = datetime.now(UTC)
        await self._events.emit(
            PublishEvent(
                kind=EventKind.RUN_STARTED,
                run_id=run_id,
                message="Publish run started",
                completed=0,
                total=len(plan.operations),
            )
        )
        for diagnostic in isolated_conflicts:
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.CONFLICT,
                    run_id=run_id,
                    message=diagnostic.message,
                    outcome="conflicted",
                )
            )
        if plan.has_destructive_operations or any(
            operation.kind is OperationKind.ADOPT_PAGE for operation in plan.operations
        ):
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.SAFETY,
                    run_id=run_id,
                    message="Exact plan-digest approval accepted",
                    outcome="approved",
                )
            )

        pending = {operation.operation_id: operation for operation in plan.operations}
        outcomes: dict[str, OperationOutcome] = {}
        runtime_ids: dict[str, str] = {}
        runtime_content: dict[str, RemoteContent] = {}
        diagnostics: list[Diagnostic] = list(plan.diagnostics)
        completed = 0
        stop_scheduling = False

        while pending:
            if token.cancelled:
                stop_scheduling = True
            if self._fail_fast and any(
                outcome.status in {OutcomeStatus.FAILED, OutcomeStatus.CONFLICTED}
                for outcome in outcomes.values()
            ):
                stop_scheduling = True

            if stop_scheduling:
                status = OutcomeStatus.CANCELLED if token.cancelled else OutcomeStatus.SKIPPED
                unscheduled_count = len(pending)
                for operation in pending.values():
                    outcomes[operation.operation_id] = OperationOutcome(
                        operation_id=operation.operation_id,
                        kind=operation.kind,
                        status=status,
                        attempts=0,
                        duration_seconds=0.0,
                        content_id=operation.content_id,
                        error_code="cancelled" if token.cancelled else "fail_fast",
                        message=(
                            "Operation was not scheduled after cancellation"
                            if token.cancelled
                            else "Operation was not scheduled after fail-fast"
                        ),
                    )
                pending.clear()
                completed += unscheduled_count
                break

            failed_dependencies = [
                operation
                for operation in pending.values()
                if any(
                    prerequisite in outcomes
                    and outcomes[prerequisite].status
                    in {
                        OutcomeStatus.FAILED,
                        OutcomeStatus.CONFLICTED,
                        OutcomeStatus.CANCELLED,
                        OutcomeStatus.SKIPPED,
                    }
                    for prerequisite in operation.prerequisites
                )
            ]
            for operation in failed_dependencies:
                outcomes[operation.operation_id] = OperationOutcome(
                    operation_id=operation.operation_id,
                    kind=operation.kind,
                    status=OutcomeStatus.SKIPPED,
                    attempts=0,
                    duration_seconds=0.0,
                    content_id=operation.content_id,
                    error_code="dependency_failed",
                    message="A prerequisite operation did not succeed",
                )
                pending.pop(operation.operation_id)
                completed += 1

            ready = [
                operation
                for operation in pending.values()
                if all(prerequisite in outcomes for prerequisite in operation.prerequisites)
            ]
            if not ready:
                if pending:
                    raise PlanExecutionError("Operation graph became unschedulable")
                break
            batch = ready[: self._concurrency]
            results = await asyncio.gather(
                *(
                    self._execute_one(
                        operation,
                        plan=plan,
                        run_id=run_id,
                        token=token,
                        runtime_ids=runtime_ids,
                        runtime_content=runtime_content,
                    )
                    for operation in batch
                )
            )
            for operation, result in zip(batch, results, strict=True):
                outcomes[operation.operation_id] = result.outcome
                pending.pop(operation.operation_id)
                completed += 1
                if operation.source_id is not None and result.remote is not None:
                    runtime_ids[operation.source_id] = result.remote.content_id
                    runtime_content[operation.source_id] = result.remote
                if result.outcome.status in {OutcomeStatus.FAILED, OutcomeStatus.CONFLICTED}:
                    diagnostics.append(
                        Diagnostic(
                            code=result.outcome.error_code or "EXECUTION_FAILED",
                            severity=Severity.ERROR,
                            message=result.outcome.message or "Publish operation failed",
                        )
                    )

        finished_at = datetime.now(UTC)
        operation_outcomes = tuple(
            outcomes[operation.operation_id]
            for operation in plan.operations
            if operation.operation_id in outcomes
        )
        diagnostic_outcomes = tuple(
            OperationOutcome(
                operation_id=f"diagnostic-{index}-{diagnostic.code.lower()}",
                kind=OperationKind.READBACK,
                status=OutcomeStatus.CONFLICTED,
                attempts=0,
                duration_seconds=0.0,
                error_code=diagnostic.code,
                message=diagnostic.message,
            )
            for index, diagnostic in enumerate(isolated_conflicts, start=1)
        )
        orphan_outcomes = tuple(
            OperationOutcome(
                operation_id=f"orphan-{index}",
                kind=OperationKind.READBACK,
                status=OutcomeStatus.REPORTED_ORPHAN,
                attempts=0,
                duration_seconds=0.0,
                message=diagnostic.message,
            )
            for index, diagnostic in enumerate(reported_orphans, start=1)
        )
        ordered = (*operation_outcomes, *diagnostic_outcomes, *orphan_outcomes)
        report = PublishReport(
            schema_version=1,
            run_id=run_id,
            plan_id=plan.plan_id,
            started_at=started_at,
            finished_at=finished_at,
            outcomes=ordered,
            diagnostics=tuple(diagnostics),
        )
        await self._events.emit(
            PublishEvent(
                kind=EventKind.RUN_FINISHED,
                run_id=run_id,
                message="Publish run finished",
                completed=completed,
                total=len(plan.operations),
                outcome="succeeded" if report.succeeded else "failed",
            )
        )
        return report

    async def _execute_one(
        self,
        operation: PlannedOperation,
        *,
        plan: PublishPlan,
        run_id: str,
        token: CancellationToken,
        runtime_ids: Mapping[str, str],
        runtime_content: Mapping[str, RemoteContent],
    ) -> _ExecutionResult:
        started = time.monotonic()
        await self._events.emit(
            PublishEvent(
                kind=EventKind.OPERATION_STARTED,
                run_id=run_id,
                message=f"{operation.kind.value} started",
                source_id=operation.source_id,
                operation_id=operation.operation_id,
            )
        )
        await self._events.emit(
            PublishEvent(
                kind=EventKind.STAGE_STARTED,
                run_id=run_id,
                message=f"{operation.kind.value} stage started",
                source_id=operation.source_id,
                operation_id=operation.operation_id,
            )
        )
        try:
            token.raise_if_cancelled()
            result = await self._apply_operation(
                operation,
                plan=plan,
                run_id=run_id,
                runtime_ids=runtime_ids,
                runtime_content=runtime_content,
            )
            outcome = OperationOutcome(
                operation_id=operation.operation_id,
                kind=operation.kind,
                status=result[0],
                attempts=1,
                duration_seconds=time.monotonic() - started,
                content_id=result[1].content_id if result[1] is not None else operation.content_id,
                resulting_version=result[1].version if result[1] is not None else None,
            )
            execution = _ExecutionResult(outcome=outcome, remote=result[1])
        except asyncio.CancelledError:
            execution = _ExecutionResult(
                outcome=OperationOutcome(
                    operation_id=operation.operation_id,
                    kind=operation.kind,
                    status=OutcomeStatus.CANCELLED,
                    attempts=0,
                    duration_seconds=time.monotonic() - started,
                    content_id=operation.content_id,
                    error_code="cancelled",
                    message="Operation was cancelled; no mutation was reported as completed",
                )
            )
        except (
            ObservationConflict,
            ConflictError,
            OwnershipError,
            PlanExecutionError,
        ) as exc:
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.CONFLICT,
                    run_id=run_id,
                    message=str(exc),
                    source_id=operation.source_id,
                    operation_id=operation.operation_id,
                    outcome="conflicted",
                )
            )
            execution = _ExecutionResult(
                outcome=OperationOutcome(
                    operation_id=operation.operation_id,
                    kind=operation.kind,
                    status=OutcomeStatus.CONFLICTED,
                    attempts=1,
                    duration_seconds=time.monotonic() - started,
                    content_id=operation.content_id,
                    error_code=getattr(exc, "code", "remote_conflict"),
                    message=str(exc),
                )
            )
        except (ConfluenceError, OSError, ValueError) as exc:
            execution = _ExecutionResult(
                outcome=OperationOutcome(
                    operation_id=operation.operation_id,
                    kind=operation.kind,
                    status=OutcomeStatus.FAILED,
                    attempts=1,
                    duration_seconds=time.monotonic() - started,
                    content_id=operation.content_id,
                    error_code=getattr(exc, "code", "operation_failed"),
                    message=_safe_error_message(exc),
                )
            )
        await self._events.emit(
            PublishEvent(
                kind=EventKind.OPERATION_FINISHED,
                run_id=run_id,
                message=f"{operation.kind.value} finished",
                source_id=operation.source_id,
                operation_id=operation.operation_id,
                outcome=execution.outcome.status.value,
            )
        )
        await self._events.emit(
            PublishEvent(
                kind=EventKind.STAGE_FINISHED,
                run_id=run_id,
                message=f"{operation.kind.value} stage finished",
                source_id=operation.source_id,
                operation_id=operation.operation_id,
                outcome=execution.outcome.status.value,
            )
        )
        if execution.outcome.status is OutcomeStatus.FAILED:
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.DIAGNOSTIC,
                    run_id=run_id,
                    message=execution.outcome.message or "Publish operation failed",
                    source_id=operation.source_id,
                    operation_id=operation.operation_id,
                    outcome="failed",
                )
            )
        return execution

    async def _apply_operation(
        self,
        operation: PlannedOperation,
        *,
        plan: PublishPlan,
        run_id: str,
        runtime_ids: Mapping[str, str],
        runtime_content: Mapping[str, RemoteContent],
    ) -> tuple[OutcomeStatus, RemoteContent | None]:
        page = _page_for(operation, plan)
        if operation.kind is OperationKind.CREATE_PAGE:
            if page is None:
                raise PlanStaleError("Create operation has no page specification")
            stored_id = self._state.page_id_for(page.identity.source_id)
            previous_entry_value = self._state.entry_for(page.identity.source_id)
            previous_entry = (
                dict(previous_entry_value) if previous_entry_value is not None else None
            )
            missing_value = operation.before.get("missing_content_id")
            missing_id = missing_value if isinstance(missing_value, str) else None
            if stored_id is not None and stored_id != missing_id:
                raise PlanStaleError("Source acquired a different page ID after planning")
            recheck_id = stored_id or missing_id
            if recheck_id is not None:
                try:
                    await self._gateway.get_content(recheck_id)
                except NotFoundError:
                    pass
                else:
                    raise PlanStaleError(
                        "Previously missing tracked content exists again; replan before create"
                    )
            parent_id, parent_expectation = await self._resolve_mutation_parent(
                page,
                plan,
                runtime_ids,
            )
            await self._checkpoint(
                page.identity.source_id,
                _pending_create_update(page, parent_id=parent_id, run_id=run_id),
            )
            storage_value = (
                _ASSET_STAGING_STORAGE
                if operation.after.get("defer_storage") is True
                else page.storage_value
            )
            guarded = self._require_guarded_gateway()
            try:
                created = await guarded.create_content(
                    title=page.final_title,
                    content_type=page.content_kind.value,
                    space_key=plan.target.space_key,
                    parent_id=parent_id,
                    storage_value=storage_value,
                    parent_expectation=parent_expectation,
                )
                _assert_created_readback(
                    created,
                    page=page,
                    plan=plan,
                    parent_id=parent_id,
                    storage_value=storage_value,
                )
            except AmbiguousWriteError:
                # The server may have created content.  Preserve create_pending so a
                # later plan cannot issue a duplicate POST without reconciliation.
                raise
            except ConfluenceError:
                # Mandatory gateways classify definitely-unsent/rejected creates as a
                # non-ambiguous ConfluenceError.  Restore the prior mapping so a later
                # plan may safely retry after rechecking the exact old ID.
                await self._rollback_pending_create(
                    page,
                    previous_entry=previous_entry,
                    run_id=run_id,
                )
                raise
            await self._checkpoint(
                page.identity.source_id,
                _state_update(page, created, run_id=run_id, stage="created"),
            )
            return OutcomeStatus.CREATED, created

        content_id = _content_id(operation, page, runtime_ids, self._state)
        if operation.kind in {OperationKind.UPDATE_PAGE, OperationKind.MOVE_PAGE}:
            if page is None:
                raise PlanStaleError("Content update has no page specification")
            current = await self._revalidate(operation, plan, page=page, content_id=content_id)
            parent_id, parent_expectation = await self._resolve_mutation_parent(
                page,
                plan,
                runtime_ids,
                current=current,
            )
            guarded = self._require_guarded_gateway()
            updated = await guarded.update_content(
                content=current,
                title=page.final_title,
                parent_id=parent_id,
                storage_value=page.storage_value,
                parent_expectation=parent_expectation,
            )
            await self._checkpoint(
                page.identity.source_id,
                _state_update(page, updated, run_id=run_id, stage="content"),
            )
            status = (
                OutcomeStatus.MOVED
                if operation.kind is OperationKind.MOVE_PAGE
                else OutcomeStatus.UPDATED
            )
            return status, updated

        if operation.kind in {OperationKind.CREATE_PROPERTY, OperationKind.UPDATE_PROPERTY}:
            if page is None:
                raise PlanStaleError("Ownership operation has no page specification")
            property_current = runtime_content.get(page.identity.source_id)
            if property_current is None:
                property_current = await self._gateway.get_content(content_id)
            if operation.kind is OperationKind.UPDATE_PROPERTY:
                assert_owned(
                    property_current,
                    vault_id=page.identity.vault_id,
                    source_id=page.identity.source_id,
                    space_key=plan.target.space_key,
                    root_page_id=plan.target.root_page_id,
                    source_kind=page.identity.kind,
                )
                if page.identity.source_id not in runtime_content:
                    _assert_planned_observation(property_current, operation)
            elif operation.content_id is not None:
                if property_current.ownership is not None:
                    raise ConflictError("Recovery target acquired an ownership marker")
                _assert_planned_observation(property_current, operation)
            marker_storage_sha256 = page.desired_storage_sha256
            if (
                operation.kind is OperationKind.CREATE_PROPERTY
                and property_current.storage_sha256 is not None
            ):
                marker_storage_sha256 = property_current.storage_sha256
            marker = OwnershipMarker(
                schema=1,
                managed=True,
                publisher=PUBLISHER_ID,
                vault_id=page.identity.vault_id,
                source_id=page.identity.source_id,
                source_kind=page.identity.kind,
                source_path=page.identity.relative_path,
                root_page_id=plan.target.root_page_id,
                space_key=plan.target.space_key,
                managed_labels=tuple(sorted(page.labels)),
                last_render_sha256=marker_storage_sha256,
                last_run_id=run_id,
            )
            property_version = _optional_int(operation.before.get("property_version"))
            if operation.after.get("runtime_property_version") is True:
                property_version = property_current.ownership_property_version
            guarded = self._require_guarded_gateway()
            written_version = await guarded.set_ownership(
                content_id,
                marker,
                property_version,
                expectation=_mutation_expectation(
                    page,
                    property_current,
                    plan,
                    require_owned=operation.kind is OperationKind.UPDATE_PROPERTY,
                ),
            )
            refreshed = await self._gateway.get_content(content_id)
            if refreshed.ownership_property_version != written_version:
                raise ConflictError("Ownership property readback version does not match the write")
            await self._checkpoint(
                page.identity.source_id,
                _state_update(page, refreshed, run_id=run_id, stage="ownership"),
            )
            status = (
                OutcomeStatus.CREATED
                if operation.kind is OperationKind.CREATE_PROPERTY
                else OutcomeStatus.UPDATED
            )
            return status, refreshed

        if operation.kind in {OperationKind.CREATE_ATTACHMENT, OperationKind.UPDATE_ATTACHMENT}:
            if page is None:
                raise PlanStaleError("Attachment operation has no page specification")
            asset_current = await self._revalidate_if_needed(
                operation, plan, page, content_id, runtime_content
            )
            asset_id = operation.after.get("asset_id")
            if not isinstance(asset_id, str):
                raise PlanStaleError("Attachment operation has no asset ID")
            asset = next((item for item in page.assets if item.asset_id == asset_id), None)
            if asset is None:
                raise PlanStaleError("Attachment specification changed after planning")
            asset_source = _resolve_asset_source(
                asset,
                self._asset_root,
                self._asset_sources,
            )
            guarded = self._require_guarded_gateway()
            attachment_id = await guarded.reconcile_asset(
                content_id,
                asset,
                asset_source,
                expectation=_mutation_expectation(page, asset_current, plan),
            )
            if asset.sha256 is None:
                raise PlanStaleError("Managed attachment lost its checksum after planning")
            entry = self._state.entry_for(page.identity.source_id)
            managed_assets = _managed_assets(entry)
            managed_assets[asset.asset_id] = {
                "attachment_id": attachment_id,
                "sha256": asset.sha256,
            }
            await self._checkpoint(
                page.identity.source_id,
                {
                    "managed_assets": managed_assets,
                    "last_successful_stage": "asset",
                    "last_run_id": run_id,
                },
            )
            return OutcomeStatus.SUCCEEDED, await self._gateway.get_content(content_id)

        if operation.kind in {OperationKind.ADD_LABEL, OperationKind.REMOVE_LABEL}:
            if page is None:
                raise PlanStaleError("Label operation has no page specification")
            label_current = await self._revalidate_if_needed(
                operation, plan, page, content_id, runtime_content
            )
            previous = _string_sequence(operation.before.get("managed_labels"))
            guarded = self._require_guarded_gateway()
            await guarded.reconcile_labels(
                content_id,
                page.labels,
                previous,
                expectation=_mutation_expectation(page, label_current, plan),
            )
            return OutcomeStatus.UPDATED, await self._gateway.get_content(content_id)

        if operation.kind is OperationKind.READBACK:
            if page is None:
                raise PlanStaleError("Readback operation has no page specification")
            current = await self._gateway.get_content(content_id)
            if operation.after.get("verify_only") is True:
                _assert_planned_observation(current, operation)
            _verify_desired_readback(current, page, plan, runtime_ids, self._state)
            if operation.after.get("verify_only") is True:
                return OutcomeStatus.UNCHANGED, current
            await self._checkpoint(
                page.identity.source_id,
                _state_update(page, current, run_id=run_id, stage="readback"),
            )
            return OutcomeStatus.SUCCEEDED, current

        if operation.kind is OperationKind.COMMIT_STATE:
            if page is None:
                raise PlanStaleError("State operation has no page specification")
            commit_current = runtime_content.get(page.identity.source_id)
            if commit_current is None:
                commit_current = await self._gateway.get_content(content_id)
            await self._checkpoint(
                page.identity.source_id,
                _state_update(page, commit_current, run_id=run_id, stage="committed"),
            )
            return OutcomeStatus.SUCCEEDED, commit_current

        if operation.kind is OperationKind.TRASH_PAGE:
            current = await self._gateway.get_content(content_id)
            trash_marker = current.ownership
            if trash_marker is None:
                raise ConflictError("Orphan lost its ownership marker after planning")
            source_id = operation.source_id
            if not isinstance(source_id, str):
                raise PlanStaleError("Orphan trash operation has no authoritative source ID")
            if current.status != "current" or current.kind not in {
                ContentKind.PAGE,
                ContentKind.BLOGPOST,
            }:
                raise ConflictError("Only current managed content may be moved to trash")
            vault_id = _authoritative_vault_id(plan, self._state)
            assert_owned(
                current,
                vault_id=vault_id,
                source_id=source_id,
                space_key=plan.target.space_key,
                root_page_id=plan.target.root_page_id,
            )
            _assert_planned_observation(current, operation)
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.SAFETY,
                    run_id=run_id,
                    message="Revalidated owned orphan immediately before trash",
                    source_id=operation.source_id,
                    operation_id=operation.operation_id,
                    outcome="approved",
                )
            )
            trash_expectation = MutationExpectation(
                vault_id=vault_id,
                source_id=source_id,
                source_kind=trash_marker.source_kind,
                space_key=plan.target.space_key,
                root_page_id=plan.target.root_page_id,
                content_kind=current.kind,
                status=current.status,
                title=current.title,
                version=current.version,
                property_version=current.ownership_property_version,
                storage_sha256=current.storage_sha256,
                parent_id=current.direct_parent_id,
            )
            guarded = self._require_guarded_gateway()
            await guarded.trash_content(content_id, expectation=trash_expectation)
            if isinstance(self._state, EntryRemover):
                async with self._checkpoint_lock:
                    self._state.remove_entries((source_id,))
            else:
                await self._checkpoint(
                    source_id,
                    {
                        "page_id": content_id,
                        "last_successful_stage": "trashed",
                        "last_run_id": run_id,
                    },
                )
            return OutcomeStatus.TRASHED, None

        if operation.kind is OperationKind.ADOPT_PAGE:
            if page is None:
                raise PlanStaleError("Adoption operation has no page specification")
            current = await self._gateway.get_content(content_id)
            if operation.after.get("state_repair_only") is True:
                assert_owned(
                    current,
                    vault_id=page.identity.vault_id,
                    source_id=page.identity.source_id,
                    space_key=plan.target.space_key,
                    root_page_id=plan.target.root_page_id,
                    source_kind=page.identity.kind,
                )
                if current.kind is not page.content_kind or current.status != "current":
                    raise ConflictError("Adoption recovery target kind or status changed")
                _assert_planned_observation(current, operation)
                if current.storage_sha256 is None:
                    raise ConflictError("Adoption recovery storage hash is unavailable")
                await self._events.emit(
                    PublishEvent(
                        kind=EventKind.SAFETY,
                        run_id=run_id,
                        message="Revalidated existing ownership before repairing local state",
                        source_id=operation.source_id,
                        operation_id=operation.operation_id,
                        outcome="approved",
                    )
                )
                await self._checkpoint(
                    page.identity.source_id,
                    _adoption_state_update(page, current, run_id=run_id),
                )
                return OutcomeStatus.SUCCEEDED, current
            if current.ownership is not None:
                raise ConflictError("Adoption target acquired an ownership marker")
            assert_in_scope(
                current,
                space_key=plan.target.space_key,
                root_page_id=plan.target.root_page_id,
            )
            if current.kind is not page.content_kind or current.status != "current":
                raise ConflictError("Adoption target kind or status changed after planning")
            _assert_planned_observation(current, operation)
            if current.storage_sha256 is None:
                raise ConflictError("Adoption target storage hash is unavailable")
            await self._events.emit(
                PublishEvent(
                    kind=EventKind.SAFETY,
                    run_id=run_id,
                    message="Revalidated adoption target immediately before ownership write",
                    source_id=operation.source_id,
                    operation_id=operation.operation_id,
                    outcome="approved",
                )
            )
            marker = OwnershipMarker(
                schema=1,
                managed=True,
                publisher=PUBLISHER_ID,
                vault_id=page.identity.vault_id,
                source_id=page.identity.source_id,
                source_kind=page.identity.kind,
                source_path=page.identity.relative_path,
                root_page_id=plan.target.root_page_id,
                space_key=plan.target.space_key,
                managed_labels=(),
                last_render_sha256=current.storage_sha256,
                last_run_id=run_id,
            )
            guarded = self._require_guarded_gateway()
            written_version = await guarded.set_ownership(
                content_id,
                marker,
                None,
                expectation=_mutation_expectation(
                    page,
                    current,
                    plan,
                    require_owned=False,
                ),
            )
            adopted = await self._gateway.get_content(content_id)
            assert_owned(
                adopted,
                vault_id=page.identity.vault_id,
                source_id=page.identity.source_id,
                space_key=plan.target.space_key,
                root_page_id=plan.target.root_page_id,
                source_kind=page.identity.kind,
            )
            if adopted.ownership_property_version != written_version:
                raise ConflictError("Adoption ownership readback version does not match")
            await self._checkpoint(
                page.identity.source_id,
                _adoption_state_update(page, adopted, run_id=run_id),
            )
            return OutcomeStatus.UPDATED, adopted

        raise PlanExecutionError(f"Unsupported operation kind: {operation.kind.value}")

    async def _revalidate(
        self,
        operation: PlannedOperation,
        plan: PublishPlan,
        *,
        page: PageSpec,
        content_id: str,
    ) -> RemoteContent:
        current = await self._gateway.get_content(content_id)
        assert_owned(
            current,
            vault_id=page.identity.vault_id,
            source_id=page.identity.source_id,
            space_key=plan.target.space_key,
            root_page_id=plan.target.root_page_id,
            source_kind=page.identity.kind,
        )
        _assert_planned_observation(current, operation)
        return current

    async def _resolve_mutation_parent(
        self,
        page: PageSpec,
        plan: PublishPlan,
        runtime_ids: Mapping[str, str],
        *,
        current: RemoteContent | None = None,
    ) -> tuple[str | None, MutationExpectation | None]:
        if page.content_kind is ContentKind.BLOGPOST:
            return None, None
        if current is not None and not _change_parent(page):
            return current.direct_parent_id, None
        parent_source_id = page.parent_source_id
        if parent_source_id is None:
            return plan.target.root_page_id, None
        parent_page = plan.page_specs.get(parent_source_id)
        if parent_page is None or parent_page.content_kind is not ContentKind.PAGE:
            raise PlanStaleError("Managed parent specification is unavailable or not a page")
        parent_id = runtime_ids.get(parent_source_id)
        if parent_id is None:
            parent_id = self._state.page_id_for(parent_source_id)
        if parent_id is None:
            raise PlanStaleError("Parent page ID is unavailable at execution time")
        parent_current = await self._gateway.get_content(parent_id)
        assert_owned(
            parent_current,
            vault_id=parent_page.identity.vault_id,
            source_id=parent_source_id,
            space_key=plan.target.space_key,
            root_page_id=plan.target.root_page_id,
            source_kind=parent_page.identity.kind,
        )
        if parent_current.kind is not ContentKind.PAGE or parent_current.status != "current":
            raise ConflictError("Managed parent is not a current Confluence page")
        return parent_id, _mutation_expectation(parent_page, parent_current, plan)

    async def _revalidate_if_needed(
        self,
        operation: PlannedOperation,
        plan: PublishPlan,
        page: PageSpec,
        content_id: str,
        runtime_content: Mapping[str, RemoteContent],
    ) -> RemoteContent:
        current = runtime_content.get(page.identity.source_id)
        if current is not None:
            assert_owned(
                current,
                vault_id=page.identity.vault_id,
                source_id=page.identity.source_id,
                space_key=plan.target.space_key,
                root_page_id=plan.target.root_page_id,
                source_kind=page.identity.kind,
            )
            return current
        return await self._revalidate(operation, plan, page=page, content_id=content_id)

    async def _checkpoint(self, source_id: str, update: Mapping[str, object]) -> None:
        async with self._checkpoint_lock:
            self._state.checkpoint({source_id: update})

    async def _rollback_pending_create(
        self,
        page: PageSpec,
        *,
        previous_entry: Mapping[str, object] | None,
        run_id: str,
    ) -> None:
        async with self._checkpoint_lock:
            if previous_entry is None and isinstance(self._state, EntryRemover):
                self._state.remove_entries((page.identity.source_id,))
                return
            self._state.checkpoint(
                {
                    page.identity.source_id: _restore_create_update(
                        page,
                        previous_entry=previous_entry,
                        run_id=run_id,
                    )
                }
            )

    def _guarded_gateway(self) -> GuardedMutationGateway | None:
        if (
            isinstance(self._gateway, GuardedMutationGateway)
            and self._gateway.supports_guarded_mutations is True
        ):
            return self._gateway
        return None

    def _require_guarded_gateway(self) -> GuardedMutationGateway:
        gateway = self._guarded_gateway()
        if gateway is None:
            raise PlanExecutionError(
                "Gateway does not implement mandatory guarded mutation expectations"
            )
        return gateway


def _page_for(operation: PlannedOperation, plan: PublishPlan) -> PageSpec | None:
    if operation.source_id is None:
        return None
    return plan.page_specs.get(operation.source_id)


def _mutation_expectation(
    page: PageSpec,
    current: RemoteContent,
    plan: PublishPlan,
    *,
    require_owned: bool = True,
) -> MutationExpectation:
    return MutationExpectation(
        vault_id=page.identity.vault_id,
        source_id=page.identity.source_id,
        source_kind=page.identity.kind,
        space_key=plan.target.space_key,
        root_page_id=plan.target.root_page_id,
        content_kind=current.kind,
        status=current.status,
        title=current.title,
        version=current.version,
        property_version=current.ownership_property_version,
        storage_sha256=current.storage_sha256,
        parent_id=current.direct_parent_id,
        require_owned=require_owned,
    )


def _assert_created_readback(
    created: RemoteContent,
    *,
    page: PageSpec,
    plan: PublishPlan,
    parent_id: str | None,
    storage_value: str,
) -> None:
    expected_storage = canonical_storage_sha256(storage_value)
    if (
        created.kind is not page.content_kind
        or created.status != "current"
        or created.title != page.final_title
        or created.space_key != plan.target.space_key
        or created.direct_parent_id != parent_id
        or created.storage_sha256 != expected_storage
        or created.version != 1
        or created.ownership is not None
        or created.ownership_property_version is not None
        or (
            created.kind is ContentKind.PAGE
            and plan.target.root_page_id not in created.ancestor_ids
        )
    ):
        raise AmbiguousWriteError(
            "Created content readback does not exactly match the planned request"
        )


def _authoritative_vault_id(plan: PublishPlan, state: StateStore) -> str:
    vault_ids = {page.identity.vault_id for page in plan.page_specs.values()}
    if len(vault_ids) == 1:
        return next(iter(vault_ids))
    state_vault_id = getattr(state, "vault_id", None)
    if not vault_ids and isinstance(state_vault_id, str) and state_vault_id:
        return state_vault_id
    raise PlanStaleError("Plan has no single authoritative local vault identity")


def _has_remote_mutations(plan: PublishPlan) -> bool:
    return any(
        operation.kind not in {OperationKind.READBACK, OperationKind.COMMIT_STATE}
        for operation in plan.operations
    )


def _content_id(
    operation: PlannedOperation,
    page: PageSpec | None,
    runtime_ids: Mapping[str, str],
    state: StateStore,
) -> str:
    if page is not None and page.identity.source_id in runtime_ids:
        return runtime_ids[page.identity.source_id]
    if operation.content_id is not None:
        return operation.content_id
    if page is not None:
        stored = state.page_id_for(page.identity.source_id)
        if stored is not None:
            return stored
    raise PlanStaleError("Operation cannot resolve its Confluence content ID")


def _resolve_parent(
    page: PageSpec,
    plan: PublishPlan,
    runtime_ids: Mapping[str, str],
    state: StateStore,
    current: RemoteContent | None = None,
) -> str | None:
    if page.content_kind is ContentKind.BLOGPOST:
        return None
    if current is not None and not _change_parent(page):
        return current.direct_parent_id
    if page.parent_source_id is None:
        return plan.target.root_page_id
    runtime = runtime_ids.get(page.parent_source_id)
    if runtime is not None:
        return runtime
    stored = state.page_id_for(page.parent_source_id)
    if stored is None:
        raise PlanStaleError("Parent page ID is unavailable at execution time")
    return stored


def _assert_planned_observation(current: RemoteContent, operation: PlannedOperation) -> None:
    expected_hash = operation.before.get("storage_sha256")
    expected_parent = operation.before.get("parent_id")
    expected_property = operation.before.get("property_version")
    assert_observation(
        current,
        expected_version=operation.expected_version,
        expected_property_version=_optional_int(expected_property),
        expected_storage_sha256=expected_hash if isinstance(expected_hash, str) else None,
        expected_parent_id=expected_parent if isinstance(expected_parent, str) else None,
    )


def _verify_desired_readback(
    current: RemoteContent,
    page: PageSpec,
    plan: PublishPlan,
    runtime_ids: Mapping[str, str],
    state: StateStore,
) -> None:
    assert_owned(
        current,
        vault_id=page.identity.vault_id,
        source_id=page.identity.source_id,
        space_key=plan.target.space_key,
        root_page_id=plan.target.root_page_id,
        source_kind=page.identity.kind,
    )
    if current.title != page.final_title:
        raise ConflictError("Readback title does not match the desired page")
    if current.storage_sha256 != page.desired_storage_sha256:
        raise ConflictError("Readback storage hash does not match the desired page")
    desired_parent = _resolve_parent(page, plan, runtime_ids, state, current=current)
    if current.direct_parent_id != desired_parent:
        raise ConflictError("Readback parent does not match the desired hierarchy")


def _state_update(
    page: PageSpec,
    remote: RemoteContent,
    *,
    run_id: str,
    stage: str,
) -> Mapping[str, object]:
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
        "last_successful_stage": stage,
        "last_run_id": run_id,
    }


def _pending_create_update(
    page: PageSpec,
    *,
    parent_id: str | None,
    run_id: str,
) -> Mapping[str, object]:
    return {
        "source_path": page.identity.relative_path,
        "source_kind": page.identity.kind.value,
        "page_id": None,
        "content_type": page.content_kind.value,
        "parent_page_id": parent_id,
        "input_sha256": page.input_sha256,
        "remote_version": None,
        "remote_storage_sha256": None,
        "ownership_property_version": None,
        "managed_labels": tuple(sorted(page.labels)),
        "last_successful_stage": "create_pending",
        "last_run_id": run_id,
    }


def _restore_create_update(
    page: PageSpec,
    *,
    previous_entry: Mapping[str, object] | None,
    run_id: str,
) -> Mapping[str, object]:
    previous = previous_entry or {}
    previous_labels = previous.get("managed_labels")
    managed_labels = (
        tuple(previous_labels)
        if isinstance(previous_labels, (tuple, list))
        and all(isinstance(item, str) for item in previous_labels)
        else ()
    )
    return {
        "source_path": previous.get("source_path", page.identity.relative_path),
        "source_kind": previous.get("source_kind", page.identity.kind.value),
        "page_id": previous.get("page_id"),
        "content_type": previous.get("content_type", page.content_kind.value),
        "parent_page_id": previous.get("parent_page_id"),
        "input_sha256": previous.get("input_sha256"),
        "remote_version": previous.get("remote_version"),
        "remote_storage_sha256": previous.get("remote_storage_sha256"),
        "ownership_property_version": previous.get("ownership_property_version"),
        "managed_labels": managed_labels,
        "last_successful_stage": previous.get("last_successful_stage", "create_not_sent"),
        "last_run_id": previous.get("last_run_id", run_id),
    }


def _adoption_state_update(
    page: PageSpec,
    remote: RemoteContent,
    *,
    run_id: str,
) -> Mapping[str, object]:
    return {
        "source_path": page.identity.relative_path,
        "source_kind": page.identity.kind.value,
        "page_id": remote.content_id,
        "content_type": page.content_kind.value,
        "parent_page_id": remote.direct_parent_id,
        "remote_version": remote.version,
        "remote_storage_sha256": remote.storage_sha256,
        "ownership_property_version": remote.ownership_property_version,
        "managed_labels": (
            tuple(sorted(remote.ownership.managed_labels)) if remote.ownership is not None else ()
        ),
        "last_successful_stage": "adopted",
        "last_run_id": run_id,
    }


def _optional_int(value: object) -> int | None:
    return value if isinstance(value, int) and not isinstance(value, bool) else None


def _string_sequence(value: object) -> tuple[str, ...]:
    if isinstance(value, (tuple, list)) and all(isinstance(item, str) for item in value):
        return tuple(value)
    return ()


def _managed_assets(entry: Mapping[str, object] | None) -> dict[str, object]:
    if entry is None:
        return {}
    value = entry.get("managed_assets")
    if not isinstance(value, Mapping):
        return {}
    result: dict[str, object] = {}
    for asset_id, metadata in value.items():
        if isinstance(asset_id, str) and isinstance(metadata, Mapping):
            attachment_id = metadata.get("attachment_id")
            sha256 = metadata.get("sha256")
            if isinstance(attachment_id, str) and isinstance(sha256, str):
                result[asset_id] = {"attachment_id": attachment_id, "sha256": sha256}
    return result


def _safe_error_message(error: Exception) -> str:
    if isinstance(error, ConfluenceError):
        return str(error)
    if isinstance(error, OSError):
        return "A local file operation failed"
    return "Publish operation failed validation"


def _validate_plan_page_specs(plan: PublishPlan) -> None:
    for source_id, page in plan.page_specs.items():
        if page.identity.source_id != source_id:
            raise PlanExecutionError("Plan page-spec key does not match its source identity")
        try:
            observed_hash = canonical_storage_sha256(page.storage_value)
        except ConfluenceError as exc:
            raise PlanExecutionError("Plan contains invalid storage XML") from exc
        if observed_hash != page.desired_storage_sha256:
            raise PlanExecutionError("Plan storage body does not match its declared hash")
    for operation in plan.operations:
        if operation.kind is OperationKind.ADOPT_PAGE or operation.source_id is None:
            continue
        operation_page = plan.page_specs.get(operation.source_id)
        if operation_page is None:
            continue
        expected_hash = operation.after.get("storage_sha256")
        if (
            isinstance(expected_hash, str)
            and expected_hash != operation_page.desired_storage_sha256
        ):
            raise PlanExecutionError(
                "Plan operation storage hash does not match its page specification"
            )


def _change_parent(page: PageSpec) -> bool:
    return page.change_parent


def _validate_runtime_asset_sources(
    plan: PublishPlan,
    asset_sources: Mapping[str, Path],
    *,
    max_asset_bytes: int,
) -> None:
    required_ids = {
        asset_id
        for operation in plan.operations
        if operation.kind in {OperationKind.CREATE_ATTACHMENT, OperationKind.UPDATE_ATTACHMENT}
        and isinstance((asset_id := operation.after.get("asset_id")), str)
    }
    assets_by_id: dict[str, AssetSpec] = {}
    for page in plan.page_specs.values():
        for asset in page.assets:
            if asset.asset_id not in required_ids:
                continue
            previous = assets_by_id.get(asset.asset_id)
            if previous is not None and previous != asset:
                raise PlanExecutionError("Plan reuses an asset ID with conflicting specifications")
            assets_by_id[asset.asset_id] = asset
    if required_ids != assets_by_id.keys():
        raise PlanExecutionError("Attachment operation has no matching page asset specification")
    for asset in assets_by_id.values():
        mapped = asset_sources.get(asset.asset_id)
        if mapped is None:
            if asset.source.startswith("mermaid:"):
                raise PlanExecutionError(
                    "Logical Mermaid asset has no runtime-resolved local source"
                )
            continue
        if asset.sha256 is None:
            raise PlanExecutionError("Runtime-resolved managed asset has no checksum")
        expected_limit = asset.size if asset.size is not None else max_asset_bytes
        if expected_limit < 0 or expected_limit > max_asset_bytes:
            raise PlanExecutionError("Runtime-resolved asset exceeds the configured size limit")
        digest, size = _local_file_digest(mapped, max_bytes=expected_limit)
        if digest != asset.sha256 or (asset.size is not None and size != asset.size):
            raise PlanExecutionError("Runtime-resolved asset source changed after rendering")


def _resolve_asset_source(
    asset: AssetSpec,
    asset_root: Path | None,
    asset_sources: Mapping[str, Path],
) -> Path:
    mapped = asset_sources.get(asset.asset_id)
    if mapped is not None:
        return mapped
    source = asset.source
    if source.startswith("mermaid:"):
        raise PlanExecutionError("Logical Mermaid asset source was not resolved")
    candidate = Path(source).expanduser()
    if asset_root is None:
        return candidate
    if not candidate.is_absolute():
        candidate = asset_root / candidate
    resolved = candidate.resolve(strict=False)
    try:
        resolved.relative_to(asset_root)
    except ValueError as exc:
        raise ValueError("Managed attachment source escapes the configured asset root") from exc
    return resolved


def _local_file_digest(path: Path, *, max_bytes: int) -> tuple[str, int]:
    flags = (
        os.O_RDONLY
        | getattr(os, "O_BINARY", 0)
        | getattr(os, "O_CLOEXEC", 0)
        | getattr(os, "O_NOFOLLOW", 0)
        | getattr(os, "O_NONBLOCK", 0)
    )
    descriptor: int | None
    try:
        descriptor = os.open(path, flags)
    except OSError:
        descriptor = None
    if descriptor is None:
        raise PlanExecutionError("Runtime-resolved asset source could not be opened safely")
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise PlanExecutionError("Runtime-resolved asset source is not a regular file")
            while True:
                read_size = min(1024 * 1024, max_bytes - size + 1)
                chunk = handle.read(read_size)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise PlanExecutionError(
                        "Runtime-resolved asset source exceeds its approved size"
                    )
                digest.update(chunk)
    except OSError:
        pass
    else:
        return digest.hexdigest(), size
    with suppress(OSError):
        os.close(descriptor)
    raise PlanExecutionError("Runtime-resolved asset source could not be read safely")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True
