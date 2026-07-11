"""Ownership property schema and write-path scope guards."""

from __future__ import annotations

from collections.abc import Mapping
from dataclasses import dataclass
from typing import Annotated, Literal

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    field_validator,
    model_validator,
)
from pydantic import (
    ValidationError as PydanticError,
)

from md2conf_dc.models import ContentKind, OwnershipMarker, RemoteContent, SourceKind

OWNERSHIP_PROPERTY_KEY = "markdown-confluence.publisher"
ATTACHMENT_PROPERTY_KEY = "markdown-confluence.asset"
PUBLISHER_ID = "md2conf-dc"

PositiveId = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$")]
Sha256 = Annotated[str, StringConstraints(pattern=r"^[a-f0-9]{64}$")]
LabelText = Annotated[
    str,
    StringConstraints(pattern=r"^[a-z0-9][a-z0-9_-]{0,254}$"),
]
UuidText = Annotated[
    str,
    StringConstraints(
        pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$"
    ),
]


class OwnershipError(RuntimeError):
    code = "ownership_conflict"


class ScopeError(OwnershipError):
    code = "scope_violation"


class ObservationConflict(OwnershipError):
    code = "stale_remote_observation"


@dataclass(frozen=True, slots=True)
class MutationExpectation:
    """Authoritative identity and observation required immediately before a write.

    Unlike :func:`assert_observation`, every observation field is compared exactly,
    including ``None``.  This is the write-path hand-off from the planner/executor to
    the concrete Confluence client, so a last-moment content-ID remap, ownership swap,
    move, or property change cannot authorize itself from the newly observed marker.
    """

    vault_id: str
    source_id: str
    source_kind: SourceKind
    space_key: str
    root_page_id: str
    content_kind: ContentKind
    status: str
    title: str
    version: int
    property_version: int | None
    storage_sha256: str | None
    parent_id: str | None
    require_owned: bool = True


class _OwnershipValue(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    schema_version: Annotated[int, Field(alias="schema", ge=1, le=1)]
    managed: bool
    publisher: Annotated[str, StringConstraints(pattern=r"^md2conf-dc$")]
    vault_id: UuidText
    source_id: UuidText
    source_kind: Literal["note", "folder"]
    source_path: str | None
    root_page_id: PositiveId
    space_key: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    managed_labels: list[LabelText]
    last_render_sha256: Sha256
    last_run_id: Annotated[str, StringConstraints(min_length=1, max_length=255)]

    @field_validator("source_path")
    @classmethod
    def safe_source_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value or value.startswith(("/", "\\")) or "\\" in value:
            raise ValueError("source_path must be a normalized relative POSIX path")
        if any(part in {"", ".", ".."} for part in value.split("/")):
            raise ValueError("source_path must be a normalized relative POSIX path")
        return value

    @model_validator(mode="after")
    def unique_labels(self) -> _OwnershipValue:
        if len(self.managed_labels) != len(set(self.managed_labels)):
            raise ValueError("managed labels must be unique")
        return self


class _AttachmentValue(BaseModel):
    model_config = ConfigDict(strict=True, extra="forbid")

    schema_version: Annotated[int, Field(alias="schema", ge=1, le=1)]
    publisher: Annotated[str, StringConstraints(pattern=r"^md2conf-dc$")]
    vault_id: UuidText
    source_id: UuidText
    asset_id: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    filename: Annotated[str, StringConstraints(min_length=1, max_length=255)]
    sha256: Sha256
    renderer: str | None = None


def parse_ownership_marker(value: Mapping[str, object]) -> OwnershipMarker:
    """Parse a property value without coercing wire types."""

    try:
        parsed = _OwnershipValue.model_validate(value)
    except PydanticError:
        pass
    else:
        if not parsed.managed:
            raise OwnershipError("Ownership property is explicitly unmanaged")
        return OwnershipMarker(
            schema=parsed.schema_version,
            managed=parsed.managed,
            publisher=parsed.publisher,
            vault_id=str(parsed.vault_id),
            source_id=str(parsed.source_id),
            source_kind=SourceKind(parsed.source_kind),
            source_path=parsed.source_path,
            root_page_id=parsed.root_page_id,
            space_key=parsed.space_key,
            managed_labels=tuple(parsed.managed_labels),
            last_render_sha256=parsed.last_render_sha256,
            last_run_id=parsed.last_run_id,
        )
    raise OwnershipError("Managed ownership property is malformed or unsupported")


def ownership_marker_value(marker: OwnershipMarker) -> dict[str, object]:
    """Validate and serialize the public marker to its stable wire schema."""

    value = {
        "schema": marker.schema,
        "managed": marker.managed,
        "publisher": marker.publisher,
        "vault_id": marker.vault_id,
        "source_id": marker.source_id,
        "source_kind": marker.source_kind.value,
        "source_path": marker.source_path,
        "root_page_id": marker.root_page_id,
        "space_key": marker.space_key,
        "managed_labels": list(marker.managed_labels),
        "last_render_sha256": marker.last_render_sha256,
        "last_run_id": marker.last_run_id,
    }
    # JSON-mode validation accepts the wire list while retaining strict scalar checks.
    try:
        _OwnershipValue.model_validate(value)
    except PydanticError:
        pass
    else:
        return value
    raise OwnershipError("Cannot serialize an invalid ownership marker")


def attachment_marker_value(
    *,
    vault_id: str,
    source_id: str,
    asset_id: str,
    filename: str,
    sha256: str,
    renderer: str | None = None,
) -> dict[str, object]:
    value: dict[str, object] = {
        "schema": 1,
        "publisher": PUBLISHER_ID,
        "vault_id": vault_id,
        "source_id": source_id,
        "asset_id": asset_id,
        "filename": filename,
        "sha256": sha256,
        "renderer": renderer,
    }
    try:
        _AttachmentValue.model_validate(value)
    except PydanticError:
        pass
    else:
        return value
    raise OwnershipError("Cannot serialize an invalid attachment marker")


def validate_attachment_marker(
    value: Mapping[str, object],
    *,
    vault_id: str,
    source_id: str,
    asset_id: str,
    filename: str,
) -> str:
    try:
        marker = _AttachmentValue.model_validate(value)
    except PydanticError:
        pass
    else:
        expected = (vault_id, source_id, asset_id, filename)
        observed = (marker.vault_id, marker.source_id, marker.asset_id, marker.filename)
        if observed != expected:
            raise OwnershipError("Attachment is owned by a different source or asset")
        return marker.sha256
    raise OwnershipError("Managed attachment property is malformed")


def assert_in_scope(
    content: RemoteContent,
    *,
    space_key: str,
    root_page_id: str,
) -> None:
    if content.space_key != space_key:
        raise ScopeError("Content is outside the configured Confluence space")
    if content.kind is ContentKind.PAGE and root_page_id not in content.ancestor_ids:
        raise ScopeError("Page is outside the configured root page tree")


def assert_owned(
    content: RemoteContent,
    *,
    vault_id: str,
    source_id: str,
    space_key: str,
    root_page_id: str,
    source_kind: SourceKind | None = None,
) -> OwnershipMarker:
    assert_in_scope(content, space_key=space_key, root_page_id=root_page_id)
    marker = content.ownership
    if marker is None:
        raise OwnershipError("Content has no managed ownership property")
    if not marker.managed or marker.publisher != PUBLISHER_ID:
        raise OwnershipError("Content is not managed by this publisher")
    if marker.vault_id != vault_id or marker.source_id != source_id:
        raise OwnershipError("Content is owned by a different vault or source")
    if marker.space_key != space_key or marker.root_page_id != root_page_id:
        raise ScopeError("Ownership marker names a different target scope")
    if marker.source_kind is SourceKind.FOLDER and content.kind is not ContentKind.PAGE:
        raise OwnershipError("Folder ownership marker cannot belong to a blog post")
    if source_kind is not None and marker.source_kind is not source_kind:
        raise OwnershipError("Ownership marker has a different source kind")
    return marker


def assert_observation(
    content: RemoteContent,
    *,
    expected_version: int | None,
    expected_property_version: int | None,
    expected_storage_sha256: str | None,
    expected_parent_id: str | None,
) -> None:
    if expected_version is not None and content.version != expected_version:
        raise ObservationConflict("Remote content version changed after planning")
    if (
        expected_property_version is not None
        and content.ownership_property_version != expected_property_version
    ):
        raise ObservationConflict("Remote ownership property changed after planning")
    if expected_storage_sha256 is not None and content.storage_sha256 != expected_storage_sha256:
        raise ObservationConflict("Remote storage changed after planning")
    if expected_parent_id is not None and content.direct_parent_id != expected_parent_id:
        raise ObservationConflict("Remote parent changed after planning")


def assert_mutation_expectation(
    content: RemoteContent,
    expectation: MutationExpectation,
) -> None:
    """Require an exact, externally supplied observation before a mutation."""

    assert_in_scope(
        content,
        space_key=expectation.space_key,
        root_page_id=expectation.root_page_id,
    )
    if content.kind is not expectation.content_kind:
        raise ObservationConflict("Remote content kind changed before mutation")
    if content.status != expectation.status:
        raise ObservationConflict("Remote content status changed before mutation")
    if content.title != expectation.title:
        raise ObservationConflict("Remote title changed before mutation")
    if content.version != expectation.version:
        raise ObservationConflict("Remote content version changed before mutation")
    if content.ownership_property_version != expectation.property_version:
        raise ObservationConflict("Remote ownership property changed before mutation")
    if content.storage_sha256 != expectation.storage_sha256:
        raise ObservationConflict("Remote storage changed before mutation")
    if content.direct_parent_id != expectation.parent_id:
        raise ObservationConflict("Remote parent changed before mutation")
    if expectation.require_owned:
        assert_owned(
            content,
            vault_id=expectation.vault_id,
            source_id=expectation.source_id,
            space_key=expectation.space_key,
            root_page_id=expectation.root_page_id,
            source_kind=expectation.source_kind,
        )
    elif content.ownership is not None:
        raise OwnershipError("Content acquired an ownership property before mutation")
