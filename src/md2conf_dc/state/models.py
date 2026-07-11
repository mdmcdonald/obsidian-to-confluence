"""Strict versioned models for the durable local state file."""

from __future__ import annotations

import ipaddress
from datetime import datetime
from typing import Annotated
from urllib.parse import urlsplit, urlunsplit
from uuid import UUID

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    StrictBool,
    StrictInt,
    StrictStr,
    field_validator,
)

from md2conf_dc.models import ContentKind, OperationKind, OutcomeStatus, SourceKind

CURRENT_STATE_SCHEMA_VERSION = 1
PositiveInt = Annotated[StrictInt, Field(gt=0)]
NonNegativeInt = Annotated[StrictInt, Field(ge=0)]


class _StateModel(BaseModel):
    model_config = ConfigDict(extra="forbid", frozen=True, validate_default=True)


class StateTarget(_StateModel):
    base_url: StrictStr
    space_key: StrictStr
    root_page_id: StrictStr
    fingerprint: StrictStr

    @field_validator("root_page_id")
    @classmethod
    def positive_page_id(cls, value: str) -> str:
        if not value.isdecimal() or int(value) <= 0:
            raise ValueError("root_page_id must be a positive decimal string")
        return value

    @field_validator("space_key", "fingerprint")
    @classmethod
    def nonempty(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must not be blank")
        return value

    @field_validator("base_url")
    @classmethod
    def safe_base_url(cls, value: str) -> str:
        if not value or any(char in value for char in "\r\n\x00"):
            raise ValueError("base_url is invalid")
        parsed = urlsplit(value)
        if parsed.scheme not in {"https", "http"} or not parsed.hostname:
            raise ValueError("base_url must be an HTTPS URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValueError("base_url must not contain user information")
        if parsed.query or parsed.fragment:
            raise ValueError("base_url must not contain a query or fragment")
        if parsed.scheme == "http" and not _is_loopback(parsed.hostname):
            raise ValueError("HTTP state targets are permitted only for loopback hosts")
        try:
            port = parsed.port
        except ValueError as exc:
            raise ValueError("base_url has an invalid port") from exc
        host = parsed.hostname.casefold()
        display_host = f"[{host}]" if ":" in host else host
        default_port = (parsed.scheme == "https" and port == 443) or (
            parsed.scheme == "http" and port == 80
        )
        netloc = display_host if port is None or default_port else f"{display_host}:{port}"
        return urlunsplit((parsed.scheme, netloc, parsed.path.rstrip("/"), "", ""))


def _is_loopback(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


class LastRunState(_StateModel):
    run_id: StrictStr
    finished_at: datetime
    status: StrictStr


class ManagedAssetState(_StateModel):
    attachment_id: StrictStr
    sha256: StrictStr

    @field_validator("attachment_id")
    @classmethod
    def positive_attachment_id(cls, value: str) -> str:
        if not value.isdecimal() or int(value) <= 0:
            raise ValueError("attachment_id must be a positive decimal string")
        return value


class StateEntry(_StateModel):
    source_path: StrictStr | None = None
    source_kind: SourceKind = SourceKind.NOTE
    page_id: StrictStr | None = None
    content_type: ContentKind = ContentKind.PAGE
    parent_page_id: StrictStr | None = None
    input_sha256: StrictStr | None = None
    remote_version: PositiveInt | None = None
    remote_storage_sha256: StrictStr | None = None
    ownership_property_version: NonNegativeInt | None = None
    managed_labels: tuple[StrictStr, ...] = ()
    managed_assets: dict[StrictStr, ManagedAssetState] = Field(default_factory=dict)
    last_successful_stage: StrictStr | None = None
    last_run_id: StrictStr | None = None
    last_operation_id: StrictStr | None = None
    last_outcome: OutcomeStatus | None = None

    @field_validator("page_id", "parent_page_id")
    @classmethod
    def positive_optional_page_id(cls, value: str | None) -> str | None:
        if value is not None and (not value.isdecimal() or int(value) <= 0):
            raise ValueError("page IDs must be positive decimal strings")
        return value

    @field_validator("source_path")
    @classmethod
    def safe_relative_path(cls, value: str | None) -> str | None:
        if value is None:
            return None
        if not value or value.startswith(("/", "\\")) or "\x00" in value:
            raise ValueError("source_path must be a safe relative POSIX path")
        parts = value.replace("\\", "/").split("/")
        if any(part in {"", ".", ".."} for part in parts):
            raise ValueError("source_path must be a normalized relative POSIX path")
        return "/".join(parts)


class PendingOperationState(_StateModel):
    operation_id: StrictStr
    run_id: StrictStr
    kind: OperationKind
    source_id: StrictStr | None = None
    content_id: StrictStr | None = None
    status: StrictStr = "pending"
    attempts: NonNegativeInt = 0
    safe_metadata: dict[StrictStr, StrictStr | StrictInt | StrictBool | None] = Field(
        default_factory=dict
    )

    @field_validator("source_id")
    @classmethod
    def optional_uuid(cls, value: str | None) -> str | None:
        return None if value is None else str(UUID(value))

    @field_validator("content_id")
    @classmethod
    def optional_content_id(cls, value: str | None) -> str | None:
        if value is not None and (not value.isdecimal() or int(value) <= 0):
            raise ValueError("content_id must be a positive decimal string")
        return value


class StateMoveResult(_StateModel):
    source_id: StrictStr
    old_path: StrictStr
    new_path: StrictStr
    changed: StrictBool
    generation: NonNegativeInt

    @field_validator("source_id")
    @classmethod
    def valid_source_id(cls, value: str) -> str:
        return str(UUID(value))


class PublisherState(_StateModel):
    schema_version: Annotated[StrictInt, Field(ge=1)] = CURRENT_STATE_SCHEMA_VERSION
    generation: NonNegativeInt = 0
    tool_version: StrictStr
    vault_id: StrictStr
    target: StateTarget | None = None
    scope_fingerprint: StrictStr | None = None
    last_run: LastRunState | None = None
    entries: dict[StrictStr, StateEntry] = Field(default_factory=dict)
    pending_operations: tuple[PendingOperationState, ...] = ()

    @field_validator("schema_version")
    @classmethod
    def known_schema(cls, value: int) -> int:
        if value != CURRENT_STATE_SCHEMA_VERSION:
            raise ValueError(f"unsupported state schema version {value}")
        return value

    @field_validator("vault_id")
    @classmethod
    def valid_vault_id(cls, value: str) -> str:
        return str(UUID(value))

    @field_validator("scope_fingerprint")
    @classmethod
    def valid_scope_fingerprint(cls, value: str | None) -> str | None:
        if value is not None and (
            len(value) != 64 or any(character not in "0123456789abcdef" for character in value)
        ):
            raise ValueError("scope_fingerprint must be a lowercase SHA-256 digest")
        return value

    @field_validator("entries")
    @classmethod
    def valid_entry_ids(cls, value: dict[str, StateEntry]) -> dict[str, StateEntry]:
        for source_id in value:
            UUID(source_id)
        return value
