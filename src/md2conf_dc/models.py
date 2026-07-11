"""Public, transport-neutral domain models.

These models deliberately contain no Typer, Rich, HTTPX, or GUI framework types.  A
future GUI can consume the same immutable values returned to the command line adapter.
"""

from __future__ import annotations

import asyncio
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from datetime import datetime
from enum import StrEnum
from pathlib import Path
from types import MappingProxyType
from typing import Self


class Severity(StrEnum):
    INFO = "info"
    WARNING = "warning"
    ERROR = "error"


class SourceKind(StrEnum):
    NOTE = "note"
    FOLDER = "folder"


class ContentKind(StrEnum):
    PAGE = "page"
    BLOGPOST = "blogpost"


class OperationKind(StrEnum):
    CREATE_PAGE = "create_page"
    UPDATE_PAGE = "update_page"
    MOVE_PAGE = "move_page"
    CREATE_PROPERTY = "create_property"
    UPDATE_PROPERTY = "update_property"
    CREATE_ATTACHMENT = "create_attachment"
    UPDATE_ATTACHMENT = "update_attachment"
    ADD_LABEL = "add_label"
    REMOVE_LABEL = "remove_label"
    READBACK = "readback"
    COMMIT_STATE = "commit_state"
    TRASH_PAGE = "trash_page"
    ADOPT_PAGE = "adopt_page"


class OutcomeStatus(StrEnum):
    CREATED = "created"
    UPDATED = "updated"
    MOVED = "moved"
    UNCHANGED = "unchanged"
    SKIPPED = "skipped"
    SUCCEEDED = "succeeded"
    PARTIAL = "partial"
    FAILED = "failed"
    CONFLICTED = "conflicted"
    REPORTED_ORPHAN = "reported_orphan"
    TRASHED = "trashed"
    CANCELLED = "cancelled"


@dataclass(frozen=True, slots=True)
class SourceSpan:
    path: Path
    line: int | None = None
    column: int | None = None
    end_line: int | None = None
    end_column: int | None = None


@dataclass(frozen=True, slots=True)
class Diagnostic:
    code: str
    severity: Severity
    message: str
    span: SourceSpan | None = None
    hint: str | None = None
    source_id: str | None = None
    content_id: str | None = None


@dataclass(frozen=True, slots=True)
class Selection:
    paths: tuple[Path, ...] = ()
    authoritative: bool = True

    @classmethod
    def all(cls) -> Self:
        return cls()

    @classmethod
    def selected(cls, paths: Sequence[Path]) -> Self:
        return cls(tuple(paths), authoritative=False)


class CancellationToken:
    """Framework-neutral cooperative cancellation primitive."""

    def __init__(self) -> None:
        self._event = asyncio.Event()

    @property
    def cancelled(self) -> bool:
        return self._event.is_set()

    def cancel(self) -> None:
        self._event.set()

    async def wait(self) -> None:
        await self._event.wait()

    def raise_if_cancelled(self) -> None:
        if self.cancelled:
            raise asyncio.CancelledError


@dataclass(frozen=True, slots=True)
class TargetIdentity:
    base_url: str
    server_version: str
    server_build: str
    space_key: str
    root_page_id: str
    current_user: str
    fingerprint: str
    web_url: str | None = None


@dataclass(frozen=True, slots=True)
class SourceIdentity:
    vault_id: str
    source_id: str
    relative_path: str
    kind: SourceKind


@dataclass(frozen=True, slots=True)
class FrontmatterSettings:
    publish: bool | None = None
    title: str | None = None
    frontmatter_to_publish: tuple[str, ...] = ()
    tags: tuple[str, ...] = ()
    page_id: str | None = None
    source_id: str | None = None
    dont_change_parent_page: bool = False
    blog_post_date: str | None = None
    content_type: ContentKind = ContentKind.PAGE
    metadata: Mapping[str, object] = field(default_factory=lambda: MappingProxyType({}))


@dataclass(frozen=True, slots=True)
class SourceDocument:
    identity: SourceIdentity
    absolute_path: Path
    source_sha256: str
    body: str
    frontmatter: FrontmatterSettings
    title_candidate: str
    diagnostics: tuple[Diagnostic, ...] = ()


@dataclass(frozen=True, slots=True)
class FolderNode:
    identity: SourceIdentity
    relative_path: str
    final_title: str
    parent_source_id: str | None
    landing_source_id: str | None
    children: tuple[str, ...]


@dataclass(frozen=True, slots=True)
class AssetSpec:
    asset_id: str
    kind: str
    source: str
    attachment_filename: str | None
    mime_type: str | None
    sha256: str | None
    size: int | None
    width: int | None = None
    height: int | None = None
    alt_text: str | None = None


@dataclass(frozen=True, slots=True)
class ResolvedLink:
    label: str
    target_source_id: str | None
    target_title: str | None
    anchor: str | None = None
    external_url: str | None = None


@dataclass(frozen=True, slots=True)
class PageSpec:
    identity: SourceIdentity
    final_title: str
    content_kind: ContentKind
    parent_source_id: str | None
    storage_value: str
    desired_storage_sha256: str
    input_sha256: str
    labels: tuple[str, ...]
    assets: tuple[AssetSpec, ...]
    policy_id: str
    change_parent: bool = True
    diagnostics: tuple[Diagnostic, ...] = ()


@dataclass(frozen=True, slots=True)
class OwnershipMarker:
    schema: int
    managed: bool
    publisher: str
    vault_id: str
    source_id: str
    source_kind: SourceKind
    source_path: str | None
    root_page_id: str
    space_key: str
    managed_labels: tuple[str, ...]
    last_render_sha256: str
    last_run_id: str


@dataclass(frozen=True, slots=True)
class RemoteContent:
    content_id: str
    kind: ContentKind
    status: str
    title: str
    space_key: str
    direct_parent_id: str | None
    ancestor_ids: tuple[str, ...]
    version: int
    storage_value: str | None
    storage_sha256: str | None
    ownership: OwnershipMarker | None
    ownership_property_version: int | None


@dataclass(frozen=True, slots=True)
class PlannedOperation:
    operation_id: str
    kind: OperationKind
    source_id: str | None
    content_id: str | None
    prerequisites: tuple[str, ...]
    before: Mapping[str, object]
    after: Mapping[str, object]
    expected_version: int | None = None
    destructive: bool = False


@dataclass(frozen=True, slots=True)
class PublishPlan:
    plan_id: str
    target: TargetIdentity
    source_set_sha256: str
    state_generation: int
    operations: tuple[PlannedOperation, ...]
    page_specs: Mapping[str, PageSpec]
    diagnostics: tuple[Diagnostic, ...]
    digest: str
    created_at: datetime

    @property
    def has_errors(self) -> bool:
        return any(item.severity is Severity.ERROR for item in self.diagnostics)

    @property
    def has_destructive_operations(self) -> bool:
        return any(operation.destructive for operation in self.operations)


@dataclass(frozen=True, slots=True)
class PlanApproval:
    plan_id: str
    digest: str
    approved_at: datetime
    actor: str


@dataclass(frozen=True, slots=True)
class OperationOutcome:
    operation_id: str
    kind: OperationKind
    status: OutcomeStatus
    attempts: int
    duration_seconds: float
    content_id: str | None = None
    resulting_version: int | None = None
    error_code: str | None = None
    message: str | None = None


@dataclass(frozen=True, slots=True)
class DoctorReport:
    target: TargetIdentity | None
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return self.target is not None and not any(
            diagnostic.severity is Severity.ERROR for diagnostic in self.diagnostics
        )


@dataclass(frozen=True, slots=True)
class ValidationReport:
    pages: tuple[PageSpec, ...]
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return not any(diagnostic.severity is Severity.ERROR for diagnostic in self.diagnostics)


@dataclass(frozen=True, slots=True)
class RenderContext:
    vault_root: Path
    final_titles: Mapping[str, str] = field(default_factory=lambda: MappingProxyType({}))
    policy: str = "knowledge-base"


@dataclass(frozen=True, slots=True)
class RenderedPage:
    page: PageSpec
    diagnostics: tuple[Diagnostic, ...]


@dataclass(frozen=True, slots=True)
class PublishReport:
    schema_version: int
    run_id: str
    plan_id: str
    started_at: datetime
    finished_at: datetime
    outcomes: tuple[OperationOutcome, ...]
    diagnostics: tuple[Diagnostic, ...]

    @property
    def succeeded(self) -> bool:
        failed = {OutcomeStatus.FAILED, OutcomeStatus.CONFLICTED, OutcomeStatus.CANCELLED}
        return not any(outcome.status in failed for outcome in self.outcomes)
