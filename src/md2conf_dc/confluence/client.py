"""Async, context-aware Confluence Data Center 9.2 REST gateway."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import re
import stat
import tempfile
from collections.abc import AsyncIterator, Mapping, Sequence
from contextlib import suppress
from dataclasses import dataclass, field
from pathlib import Path
from typing import BinaryIO, TypeVar, cast
from urllib.parse import urlencode, urlsplit

import httpx
from pydantic import BaseModel
from pydantic import ValidationError as PydanticValidationError

from md2conf_dc.confluence.errors import (
    AmbiguousWriteError,
    AuthenticationError,
    CompatibilityError,
    ConflictError,
    ConfluenceError,
    NotFoundError,
    ResponseLimitError,
    TransportError,
    ValidationError,
)
from md2conf_dc.confluence.models import (
    AttachmentDisposition,
    AttachmentObservation,
    AttachmentWire,
    ContentIdWire,
    ContentWire,
    LabelWire,
    PageEnvelope,
    PropertyWire,
    SystemInfoWire,
    UserWire,
    canonical_storage_sha256,
)
from md2conf_dc.confluence.pagination import Page, paginate
from md2conf_dc.confluence.retry import (
    RetryPolicy,
    classify_exception,
    classify_status,
    retry_delay,
)
from md2conf_dc.confluence.urls import ConfluenceBaseUrl, path_segment, text_segment
from md2conf_dc.events import EventKind, EventSink, NullEventSink, PublishEvent
from md2conf_dc.models import (
    AssetSpec,
    ContentKind,
    OwnershipMarker,
    RemoteContent,
    TargetIdentity,
)
from md2conf_dc.ownership import (
    ATTACHMENT_PROPERTY_KEY,
    OWNERSHIP_PROPERTY_KEY,
    MutationExpectation,
    OwnershipError,
    assert_in_scope,
    assert_mutation_expectation,
    assert_observation,
    assert_owned,
    attachment_marker_value,
    ownership_marker_value,
    parse_ownership_marker,
    validate_attachment_marker,
)

WireT = TypeVar("WireT", bound=BaseModel)
_SPACE_KEY = re.compile(r"^[A-Za-z0-9_-]{1,255}$")
_LABEL = re.compile(r"^[a-z0-9][a-z0-9_-]{0,254}$")
_READ_REDIRECTS = {301, 302, 303, 307, 308}
_DEFAULT_MAX_ATTACHMENT_BYTES = 100 * 1024 * 1024


@dataclass(frozen=True, slots=True)
class BearerAuth:
    token: str = field(repr=False)

    def __post_init__(self) -> None:
        if not self.token:
            raise ValueError("PAT token cannot be empty")


@dataclass(frozen=True, slots=True)
class BasicAuth:
    username: str
    password: str = field(repr=False)

    def __post_init__(self) -> None:
        if not self.username or not self.password:
            raise ValueError("Basic authentication requires username and password")


@dataclass(frozen=True, slots=True)
class ConfluenceTimeouts:
    connect_seconds: float = 10.0
    read_seconds: float = 60.0
    write_seconds: float = 120.0
    pool_seconds: float = 10.0

    def __post_init__(self) -> None:
        if (
            min(
                self.connect_seconds,
                self.read_seconds,
                self.write_seconds,
                self.pool_seconds,
            )
            <= 0
        ):
            raise ValueError("All Confluence timeouts must be positive")


_DEFAULT_TIMEOUTS = ConfluenceTimeouts()
_DEFAULT_RETRY_POLICY = RetryPolicy()


@dataclass(frozen=True, slots=True)
class _WireResponse:
    status_code: int
    headers: httpx.Headers
    url: str
    content: bytes

    def mapping(self) -> Mapping[str, object]:
        try:
            value = json.loads(self.content)
        except (UnicodeDecodeError, ValueError, RecursionError):
            pass
        else:
            if not isinstance(value, dict):
                raise ValidationError("Confluence returned a non-object JSON response")
            return value
        # Raise outside the handler so the decoder exception (which can retain the
        # response bytes) is not attached as ``__context__``.
        raise ValidationError("Confluence returned malformed JSON")

    def model(self, model_type: type[WireT]) -> WireT:
        try:
            return model_type.model_validate_json(self.content)
        except (PydanticValidationError, RecursionError):
            pass
        # Pydantic validation errors retain the complete JSON input.  Do not chain or
        # retain that object across the public boundary.
        raise ValidationError("Confluence response did not match the DC 9.2 contract")


class ConfluenceClient:
    """Typed implementation of ``ConfluenceGateway`` for Data Center 9.2.

    Mutations do not follow redirects.  Generic retries are limited to reads and writes
    known not to have been sent; ambiguous outcomes are surfaced for reconciliation.
    """

    supports_guarded_mutations = True

    def __init__(
        self,
        base_url: str,
        auth: BearerAuth | BasicAuth,
        *,
        expected_release: str = "9.2",
        verify_tls: bool = True,
        timeouts: ConfluenceTimeouts = _DEFAULT_TIMEOUTS,
        retry_policy: RetryPolicy = _DEFAULT_RETRY_POLICY,
        transport: httpx.AsyncBaseTransport | None = None,
        event_sink: EventSink | None = None,
        response_limit_bytes: int = 10 * 1024 * 1024,
        max_connections: int = 20,
        max_attachment_bytes: int = _DEFAULT_MAX_ATTACHMENT_BYTES,
    ) -> None:
        self._base = ConfluenceBaseUrl.parse(base_url)
        parsed = urlsplit(self._base.origin)
        if parsed.scheme == "http" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
            raise ValidationError("Plain HTTP is allowed only for loopback development")
        if not re.fullmatch(r"[0-9]+\.[0-9]+", expected_release):
            raise ValueError("expected_release must be a major.minor value")
        if response_limit_bytes < 1024:
            raise ValueError("response_limit_bytes is too small")
        if max_connections < 1:
            raise ValueError("max_connections must be positive")
        if max_attachment_bytes < 1:
            raise ValueError("max_attachment_bytes must be positive")

        headers = {
            "Accept": "application/json",
            # Bound response bytes without allowing transparent decompression to
            # materialize an oversized chunk before the streaming limit check.
            "Accept-Encoding": "identity",
        }
        if isinstance(auth, BearerAuth):
            headers["Authorization"] = f"Bearer {auth.token}"
        else:
            encoded = base64.b64encode(f"{auth.username}:{auth.password}".encode()).decode("ascii")
            headers["Authorization"] = f"Basic {encoded}"

        self._expected_release = expected_release
        self._retry_policy = retry_policy
        self._event_sink = event_sink or NullEventSink()
        self._response_limit_bytes = response_limit_bytes
        self._max_attachment_bytes = max_attachment_bytes
        self._target: TargetIdentity | None = None
        self._closed = False
        self._http = httpx.AsyncClient(
            headers=headers,
            verify=verify_tls,
            timeout=httpx.Timeout(
                connect=timeouts.connect_seconds,
                read=timeouts.read_seconds,
                write=timeouts.write_seconds,
                pool=timeouts.pool_seconds,
            ),
            limits=httpx.Limits(
                max_connections=max_connections,
                max_keepalive_connections=max_connections,
            ),
            follow_redirects=False,
            transport=transport,
        )

    @property
    def base_url(self) -> str:
        return self._base.value

    async def __aenter__(self) -> ConfluenceClient:
        return self

    async def __aexit__(self, *exc_info: object) -> None:
        await self.close()

    async def preflight(self, parent_page_id: str) -> TargetIdentity:
        parent_page_id = _validated_id(parent_page_id)
        info_response = await self._request("GET", "/rest/api/settings/systemInfo")
        info = info_response.model(SystemInfoWire)
        deployment = (info.deployment_type or "").lower()
        if (
            info.cloud is True
            or "cloud" in deployment
            or self._base.origin.endswith(".atlassian.net")
        ):
            raise CompatibilityError("Confluence Cloud is not supported")
        if deployment and "server" in deployment and "data center" not in deployment:
            raise CompatibilityError("Confluence Server is not a supported deployment")
        if not re.fullmatch(
            rf"{re.escape(self._expected_release)}\.[0-9]+(?:[-.][A-Za-z0-9]+)*", info.version
        ):
            raise CompatibilityError(
                f"Confluence {self._expected_release}.x is required",
            )
        if info.base_url is not None:
            try:
                reported_base = ConfluenceBaseUrl.parse(info.base_url)
            except ValidationError:
                raise CompatibilityError("Confluence reported an invalid application URL") from None
            if reported_base != self._base:
                raise CompatibilityError(
                    "Confluence system information identifies another origin or context"
                )

        user_response = await self._request("GET", "/rest/api/user/current")
        user = user_response.model(UserWire)
        current_user = user.username or user.key or user.user_key
        if not current_user:
            raise CompatibilityError("Current-user response lacks a Data Center identity")

        parent_wire = await self._read_content_wire(
            parent_page_id,
            expand="space,ancestors,version,body.storage",
        )
        parent = self._content_to_remote(parent_wire, ownership=None, property_version=None)
        if parent.kind is not ContentKind.PAGE or parent.status != "current":
            raise CompatibilityError("Configured parent must be a current Confluence page")
        if not _SPACE_KEY.fullmatch(parent.space_key):
            raise CompatibilityError("Configured parent has an invalid space key")

        fingerprint_input = {
            "base_url": self._base.value,
            "server_version": info.version,
            "server_build": info.build_number,
            "space_key": parent.space_key,
            "root_page_id": parent_page_id,
        }
        fingerprint = (
            "sha256:"
            + hashlib.sha256(
                json.dumps(fingerprint_input, sort_keys=True, separators=(",", ":")).encode()
            ).hexdigest()
        )
        web_url = self._content_web_url(parent_wire)
        target = TargetIdentity(
            base_url=self._base.value,
            server_version=info.version,
            server_build=info.build_number,
            space_key=parent.space_key,
            root_page_id=parent_page_id,
            current_user=current_user,
            fingerprint=fingerprint,
            web_url=web_url,
        )
        self._target = target
        return target

    async def get_content(self, content_id: str) -> RemoteContent:
        content_id = _validated_id(content_id)
        wire = await self._read_content_wire(
            content_id,
            expand="space,ancestors,version,body.storage",
        )
        property_wire = await self._get_property(content_id, OWNERSHIP_PROPERTY_KEY)
        ownership: OwnershipMarker | None = None
        property_version: int | None = None
        if property_wire is not None:
            try:
                ownership = parse_ownership_marker(property_wire.value)
            except OwnershipError:
                pass
            else:
                property_version = property_wire.version.number if property_wire.version else None
            if ownership is None:
                raise ConflictError("Content has an invalid ownership property")
        return self._content_to_remote(
            wire,
            ownership=ownership,
            property_version=property_version,
        )

    async def find_owned_content(
        self,
        *,
        vault_id: str,
        root_page_id: str,
    ) -> AsyncIterator[RemoteContent]:
        target = self._require_target()
        if root_page_id != target.root_page_id:
            raise ValidationError("Requested ownership search has a different root")
        if not _SPACE_KEY.fullmatch(target.space_key):
            raise ValidationError("Target space key is not safe for CQL")
        query = f'space = "{target.space_key}" and type in (page, blogpost)'
        async for raw in self._iter_collection(
            "/rest/api/content/search",
            params={
                "cql": query,
                "limit": "100",
            },
        ):
            wire = _model_from_mapping(ContentIdWire, raw)
            # Search is intentionally ID-only.  Inspect the small managed property
            # before fetching any title/body so unrelated space content is neither
            # over-read nor able to break orphan discovery with a huge body.
            property_wire = await self._get_property(wire.id, OWNERSHIP_PROPERTY_KEY)
            if property_wire is None:
                continue
            try:
                property_marker = parse_ownership_marker(property_wire.value)
            except OwnershipError:
                continue
            if (
                property_marker.vault_id != vault_id
                or property_marker.root_page_id != root_page_id
                or property_marker.space_key != target.space_key
            ):
                continue
            candidate = await self.get_content(wire.id)
            marker = candidate.ownership
            if (
                marker is not None
                and marker.vault_id == vault_id
                and marker.root_page_id == root_page_id
                and marker.space_key == target.space_key
            ):
                yield candidate

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
        kind = _content_kind(content_type)
        _validate_space(space_key)
        target = self._require_target()
        if space_key != target.space_key:
            raise ConflictError("Create target differs from the preflighted space")
        desired_storage_sha256 = canonical_storage_sha256(storage_value)
        payload: dict[str, object] = {
            "type": kind.value,
            "title": title,
            "space": {"key": space_key},
            "body": {"storage": {"value": storage_value, "representation": "storage"}},
        }
        if kind is ContentKind.PAGE:
            if parent_id is None:
                raise ValidationError("Managed pages require one direct parent")
            payload["ancestors"] = [{"id": _validated_id(parent_id)}]
        elif parent_id is not None:
            raise ValidationError("Blog posts cannot have ancestors")

        if parent_id is not None:
            await self._require_parent_current(
                parent_id,
                space_key=space_key,
                expectation=parent_expectation,
            )
        response = await self._request("POST", "/rest/api/content", json_body=payload)
        try:
            created = response.model(ContentWire)
            readback = await self.get_content(created.id)
            if (
                readback.kind is not kind
                or readback.status != "current"
                or readback.title != title
                or readback.space_key != space_key
                or readback.direct_parent_id != parent_id
                or readback.storage_sha256 != desired_storage_sha256
                or readback.version != 1
                or readback.ownership is not None
                or readback.ownership_property_version is not None
                or (kind is ContentKind.PAGE and target.root_page_id not in readback.ancestor_ids)
            ):
                raise ConflictError("Created content readback does not match the request")
            return readback
        except ConfluenceError:
            pass
        # A 2xx create response was observed, so any parse/readback failure occurs
        # after the server may have committed the page.  Raise outside the handler to
        # avoid retaining a response-bearing validation exception as context.
        raise AmbiguousWriteError("Confluence create readback is ambiguous")

    async def update_content(
        self,
        *,
        content: RemoteContent,
        title: str,
        parent_id: str | None,
        storage_value: str,
        parent_expectation: MutationExpectation | None = None,
    ) -> RemoteContent:
        marker = content.ownership
        if marker is None:
            raise ConflictError("Cannot update content without an ownership marker")
        current = await self.get_content(content.content_id)
        assert_owned(
            current,
            vault_id=marker.vault_id,
            source_id=marker.source_id,
            space_key=marker.space_key,
            root_page_id=marker.root_page_id,
            source_kind=marker.source_kind,
        )
        assert_observation(
            current,
            expected_version=content.version,
            expected_property_version=content.ownership_property_version,
            expected_storage_sha256=content.storage_sha256,
            expected_parent_id=content.direct_parent_id,
        )
        desired_hash = canonical_storage_sha256(storage_value)
        payload: dict[str, object] = {
            "id": current.content_id,
            "type": current.kind.value,
            "title": title,
            "version": {"number": current.version + 1},
            "body": {"storage": {"value": storage_value, "representation": "storage"}},
        }
        if current.kind is ContentKind.PAGE:
            if parent_id is None:
                raise ValidationError("Managed pages require one direct parent")
            payload["ancestors"] = [{"id": _validated_id(parent_id)}]
        elif parent_id is not None:
            raise ValidationError("Blog posts cannot have ancestors")

        path = f"/rest/api/content/{path_segment(current.content_id)}"
        if parent_id is not None:
            await self._require_parent_current(
                parent_id,
                space_key=current.space_key,
                expectation=parent_expectation,
            )
        try:
            await self._request("PUT", path, json_body=payload)
        except (AmbiguousWriteError, ConflictError) as first_error:
            observed = await self._try_get_content(current.content_id)
            if observed is None:
                if isinstance(first_error, AmbiguousWriteError):
                    raise AmbiguousWriteError(
                        "Versioned content update readback is ambiguous"
                    ) from None
                raise
            if _valid_updated_readback(
                observed,
                previous=current,
                title=title,
                parent_id=parent_id,
                storage_hash=desired_hash,
            ):
                return observed
            if _same_content_observation(observed, current):
                try:
                    if parent_id is not None:
                        await self._require_parent_current(
                            parent_id,
                            space_key=current.space_key,
                            expectation=parent_expectation,
                        )
                    await self._request("PUT", path, json_body=payload)
                except (AmbiguousWriteError, ConflictError) as retry_error:
                    reconciled = await self._try_get_content(current.content_id)
                    if reconciled is not None and _valid_updated_readback(
                        reconciled,
                        previous=current,
                        title=title,
                        parent_id=parent_id,
                        storage_hash=desired_hash,
                    ):
                        return reconciled
                    if isinstance(retry_error, AmbiguousWriteError):
                        raise AmbiguousWriteError(
                            "Versioned content update retry is ambiguous"
                        ) from None
                    raise ConflictError(
                        "Versioned content update could not be reconciled safely"
                    ) from None
                retry_readback = await self._try_get_content(current.content_id)
                if retry_readback is not None and _valid_updated_readback(
                    retry_readback,
                    previous=current,
                    title=title,
                    parent_id=parent_id,
                    storage_hash=desired_hash,
                ):
                    return retry_readback
                raise AmbiguousWriteError(
                    "Versioned content update retry readback is ambiguous"
                ) from None
            raise ConflictError(
                "Content changed concurrently and does not match the desired state"
            ) from None
        successful_readback = await self._try_get_content(current.content_id)
        if successful_readback is not None and _valid_updated_readback(
            successful_readback,
            previous=current,
            title=title,
            parent_id=parent_id,
            storage_hash=desired_hash,
        ):
            return successful_readback
        raise AmbiguousWriteError("Versioned content update readback is ambiguous")

    async def set_ownership(
        self,
        content_id: str,
        marker: OwnershipMarker,
        property_version: int | None,
        *,
        expectation: MutationExpectation,
    ) -> int:
        content_id = _validated_id(content_id)
        current = await self.get_content(content_id)
        assert_mutation_expectation(current, expectation)
        desired_value = ownership_marker_value(marker)
        observed_property = await self._get_property(content_id, OWNERSHIP_PROPERTY_KEY)
        if observed_property is None:
            if property_version is not None:
                raise ConflictError("Ownership property disappeared after planning")
            payload: dict[str, object] = {
                "key": OWNERSHIP_PROPERTY_KEY,
                "value": desired_value,
            }
            path = f"/rest/api/content/{path_segment(content_id)}/property"
            method = "POST"
        else:
            observed_marker = parse_ownership_marker(observed_property.value)
            if (
                observed_marker.vault_id != marker.vault_id
                or observed_marker.source_id != marker.source_id
                or observed_marker.root_page_id != marker.root_page_id
                or observed_marker.space_key != marker.space_key
            ):
                raise ConflictError("Ownership property belongs to a different source or target")
            observed_version = (
                observed_property.version.number if observed_property.version is not None else None
            )
            if property_version != observed_version:
                raise ConflictError("Ownership property version changed after planning")
            if observed_version is None:
                raise ConflictError("Ownership property update requires an observed version")
            payload = {
                "key": OWNERSHIP_PROPERTY_KEY,
                "value": desired_value,
                "version": {"number": observed_version + 1},
            }
            path = (
                f"/rest/api/content/{path_segment(content_id)}/property/"
                f"{text_segment(OWNERSHIP_PROPERTY_KEY)}"
            )
            method = "PUT"
        # The property observation above can involve multiple REST reads.  Re-read the
        # page at the final write seam so an identity/scope/content swap cannot borrow
        # authority from its own marker.
        final_current = await self.get_content(content_id)
        if expectation is None:
            assert_in_scope(
                final_current,
                space_key=marker.space_key,
                root_page_id=marker.root_page_id,
            )
        else:
            assert_mutation_expectation(final_current, expectation)
        try:
            response = await self._request(method, path, json_body=payload)
        except (AmbiguousWriteError, ConflictError):
            reconciled_version = await self._try_property_version(
                content_id,
                OWNERSHIP_PROPERTY_KEY,
                desired_value,
            )
            if reconciled_version is not None:
                return reconciled_version
            raise
        try:
            written = response.model(PropertyWire)
        except ConfluenceError:
            written = None
        if (
            written is not None
            and written.key == OWNERSHIP_PROPERTY_KEY
            and dict(written.value) == desired_value
            and written.version is not None
        ):
            return written.version.number
        reconciled_version = await self._try_property_version(
            content_id,
            OWNERSHIP_PROPERTY_KEY,
            desired_value,
        )
        if reconciled_version is not None:
            return reconciled_version
        raise AmbiguousWriteError("Ownership property write readback is ambiguous")

    async def reconcile_labels(
        self,
        content_id: str,
        desired: Sequence[str],
        previously_managed: Sequence[str],
        *,
        expectation: MutationExpectation,
    ) -> None:
        content_id = _validated_id(content_id)
        desired_set = {_validated_label(item) for item in desired}
        previous_set = {_validated_label(item) for item in previously_managed}
        await self._require_label_authority(
            content_id,
            previously_managed=previous_set,
            expectation=expectation,
        )
        current = await self._list_labels(content_id)
        additions = sorted(desired_set - current)
        removals = sorted((previous_set - desired_set) & current)
        if additions:
            await self._require_label_authority(
                content_id,
                previously_managed=previous_set,
                expectation=expectation,
            )
            path = f"/rest/api/content/{path_segment(content_id)}/label"
            payload = [{"prefix": "global", "name": label} for label in additions]
            try:
                await self._request("POST", path, json_body=payload)
            except AmbiguousWriteError:
                observed = await self._try_list_labels(content_id)
                if observed is None:
                    raise AmbiguousWriteError("Label-add readback is ambiguous") from None
                if not set(additions).issubset(observed):
                    raise
        for label in removals:
            await self._require_label_authority(
                content_id,
                previously_managed=previous_set,
                expectation=expectation,
            )
            path = f"/rest/api/content/{path_segment(content_id)}/label/{text_segment(label)}"
            try:
                # No status parameter: this removes exactly one label, not content.
                await self._request("DELETE", path)
            except AmbiguousWriteError:
                observed = await self._try_list_labels(content_id)
                if observed is None:
                    raise AmbiguousWriteError("Label-remove readback is ambiguous") from None
                if label in observed:
                    raise

    async def observe_labels(self, content_id: str) -> frozenset[str]:
        """Return all current global labels after revalidating page ownership."""

        content_id = _validated_id(content_id)
        await self._require_owned_current(content_id)
        return frozenset(await self._list_labels(content_id))

    async def observe_asset(
        self,
        content_id: str,
        asset: AssetSpec,
    ) -> AttachmentObservation:
        """Classify one attachment by paginated filename and managed checksum."""

        content_id = _validated_id(content_id)
        current = await self._require_owned_current(content_id)
        marker = current.ownership
        if marker is None:  # defensive; _require_owned_current proves this
            raise ConflictError("Cannot inspect an asset on unowned content")
        filename = asset.attachment_filename
        if not filename or not asset.sha256:
            raise ValidationError("Managed attachment requires filename and checksum")
        matches = [
            item async for item in self._iter_attachments(content_id) if item.title == filename
        ]
        if len(matches) > 1:
            raise ConflictError("Multiple attachments have the managed filename")
        if not matches:
            return AttachmentObservation(AttachmentDisposition.MISSING, None, None, None)
        attachment = matches[0]
        property_wire = await self._get_property(attachment.id, ATTACHMENT_PROPERTY_KEY)
        if property_wire is None:
            raise ConflictError("Existing attachment filename is not managed by this publisher")
        observed_sha = validate_attachment_marker(
            property_wire.value,
            vault_id=marker.vault_id,
            source_id=marker.source_id,
            asset_id=asset.asset_id,
            filename=filename,
        )
        disposition = (
            AttachmentDisposition.UNCHANGED
            if observed_sha == asset.sha256
            else AttachmentDisposition.CHANGED
        )
        property_version = property_wire.version.number if property_wire.version else None
        return AttachmentObservation(
            disposition,
            attachment.id,
            observed_sha,
            property_version,
        )

    async def reconcile_asset(
        self,
        content_id: str,
        asset: AssetSpec,
        source: Path,
        *,
        expectation: MutationExpectation,
    ) -> str:
        content_id = _validated_id(content_id)
        current = await self._require_owned_current(content_id, expectation=expectation)
        marker = current.ownership
        if marker is None:  # defensive; _require_owned_current already proves this
            raise ConflictError("Cannot upload an asset to unowned content")
        filename = asset.attachment_filename
        if not filename or not asset.sha256:
            raise ValidationError("Managed attachment requires filename and checksum")
        # Snapshot one no-follow, regular-file descriptor and upload the exact bytes
        # that were hashed.  A path replacement or in-place write after this copy can
        # no longer change the multipart payload while retaining the expected marker.
        with tempfile.SpooledTemporaryFile(max_size=8 * 1024 * 1024, mode="w+b") as raw_handle:
            handle = cast(BinaryIO, raw_handle)
            expected_limit = asset.size if asset.size is not None else self._max_attachment_bytes
            if expected_limit < 0 or expected_limit > self._max_attachment_bytes:
                raise ValidationError("Managed attachment exceeds the configured size limit")
            digest, size = _snapshot_asset(source, handle, max_bytes=expected_limit)
            if digest != asset.sha256 or (asset.size is not None and size != asset.size):
                raise ConflictError("Attachment source changed after planning")

            observation = await self.observe_asset(content_id, asset)
            existing_id = observation.attachment_id
            if (
                existing_id is not None
                and observation.disposition is AttachmentDisposition.UNCHANGED
            ):
                return existing_id

            # Recheck both the parent identity and the exact attachment marker observed
            # by the planner before sending attachment bytes.
            await self._require_owned_current(content_id, expectation=expectation)
            await self._assert_attachment_observation(
                content_id,
                asset=asset,
                expected=observation,
                vault_id=marker.vault_id,
                source_id=marker.source_id,
            )
            await self._require_owned_current(content_id, expectation=expectation)
            if existing_id is None:
                path = f"/rest/api/content/{path_segment(content_id)}/child/attachment"
            else:
                path = (
                    f"/rest/api/content/{path_segment(content_id)}/child/attachment/"
                    f"{path_segment(existing_id)}/data"
                )
            headers = {"X-Atlassian-Token": "no-check"}
            try:
                handle.seek(0)
                response = await self._request(
                    "POST",
                    path,
                    headers=headers,
                    files={
                        "file": (filename, handle, asset.mime_type or "application/octet-stream")
                    },
                )
            except AmbiguousWriteError:
                try:
                    reconciled = await self._reconcile_attachment_marker(
                        content_id,
                        filename=filename,
                        vault_id=marker.vault_id,
                        source_id=marker.source_id,
                        asset_id=asset.asset_id,
                        sha256=asset.sha256,
                    )
                except (ConfluenceError, OwnershipError):
                    reconciled = None
                if reconciled is None:
                    raise AmbiguousWriteError(
                        "Attachment upload outcome remains ambiguous"
                    ) from None
                return reconciled

            validation_failed = False
            try:
                attachment = _attachment_from_upload(response)
                if (
                    attachment.type != "attachment"
                    or attachment.status != "current"
                    or attachment.title != filename
                    or (existing_id is not None and attachment.id != existing_id)
                ):
                    raise ConflictError("Attachment upload readback does not match the request")
                if existing_id is None:
                    matches = [
                        item
                        async for item in self._iter_attachments(content_id)
                        if item.title == filename
                    ]
                    if len(matches) != 1 or matches[0].id != attachment.id:
                        raise ConflictError(
                            "Created attachment is not uniquely bound to the parent page"
                        )
            except ConfluenceError:
                validation_failed = True
            if validation_failed:
                # Bytes may have been committed; never treat a malformed/misdirected
                # upload response as a definitely failed write.
                raise AmbiguousWriteError("Attachment upload readback is ambiguous")

        marker_value = attachment_marker_value(
            vault_id=marker.vault_id,
            source_id=marker.source_id,
            asset_id=asset.asset_id,
            filename=filename,
            sha256=asset.sha256,
            renderer=asset.kind,
        )
        await self._require_owned_current(content_id, expectation=expectation)
        await self._set_generic_property(
            attachment.id,
            ATTACHMENT_PROPERTY_KEY,
            marker_value,
            property_version=observation.property_version,
        )
        return attachment.id

    async def trash_content(
        self,
        content_id: str,
        *,
        expectation: MutationExpectation,
    ) -> None:
        content_id = _validated_id(content_id)
        observed = await self._require_owned_current(content_id, expectation=expectation)
        if observed.status != "current" or observed.kind not in {
            ContentKind.PAGE,
            ContentKind.BLOGPOST,
        }:
            raise ConflictError("Only current managed content may be moved to trash")
        path = f"/rest/api/content/{path_segment(content_id)}"
        try:
            # Deliberately omit the status query: DELETE current content moves it to
            # trash on DC 9.2; status=trashed would permanently purge it.
            await self._request("DELETE", path)
        except AmbiguousWriteError:
            readback_failed = False
            try:
                await self.get_content(content_id)
            except NotFoundError:
                return
            except ConfluenceError:
                readback_failed = True
            if readback_failed:
                raise AmbiguousWriteError("Trash readback is ambiguous") from None
            raise AmbiguousWriteError("Trash outcome remains ambiguous") from None
        except NotFoundError:
            # Only safe because the owned page was observed immediately above.
            del observed
            return

    async def close(self) -> None:
        if not self._closed:
            self._closed = True
            await self._http.aclose()

    async def _request(
        self,
        method: str,
        path_or_url: str,
        *,
        params: Mapping[str, str] | None = None,
        headers: Mapping[str, str] | None = None,
        json_body: object | None = None,
        files: Mapping[str, tuple[str, BinaryIO, str]] | None = None,
    ) -> _WireResponse:
        if self._closed:
            raise TransportError("Confluence client is closed")
        method = method.upper()
        url = (
            self._base.resolve_same_context(path_or_url)
            if path_or_url.startswith(("http://", "https://"))
            else self._base.rest(path_or_url)
        )
        attempt = 0
        redirects = 0
        while True:
            attempt += 1
            boundary_error: ConfluenceError | None = None
            try:
                response = await self._send_once(
                    method,
                    url,
                    params=params,
                    headers=headers,
                    json_body=json_body,
                    files=files,
                )
            except asyncio.CancelledError:
                if method not in {"GET", "HEAD"}:
                    boundary_error = AmbiguousWriteError(
                        f"Outcome of {method} request is ambiguous"
                    )
                else:
                    raise
            except ResponseLimitError:
                if method not in {"GET", "HEAD"}:
                    boundary_error = AmbiguousWriteError(
                        f"Outcome of {method} request is ambiguous"
                    )
                else:
                    raise
            except httpx.HTTPError as exc:
                classification = classify_exception(method, exc)
                if (
                    classification.retryable
                    and attempt < self._retry_policy.max_attempts
                    and files is None
                ):
                    delay = retry_delay(self._retry_policy, attempt=attempt)
                    try:
                        await self._emit_retry(method, attempt, delay)
                        await asyncio.sleep(delay)
                    except asyncio.CancelledError:
                        if method in {"GET", "HEAD"}:
                            raise
                        # This retry branch is reachable for writes only when the
                        # transport proved the request was not sent.
                        boundary_error = TransportError(
                            f"Confluence {method} request was cancelled before sending"
                        )
                    else:
                        continue
                if classification.ambiguous:
                    boundary_error = AmbiguousWriteError(
                        f"Outcome of {method} request is ambiguous"
                    )
                else:
                    boundary_error = TransportError(
                        f"Confluence {method} request failed before completion"
                    )

            # Raise after leaving the handler.  httpx exceptions retain Request and
            # Response objects, including the Authorization header.
            if boundary_error is not None:
                raise boundary_error

            if method in {"GET", "HEAD"} and response.status_code in _READ_REDIRECTS:
                location = response.headers.get("location")
                if location is None or redirects >= 3:
                    raise CompatibilityError("Confluence returned an invalid redirect")
                try:
                    url = self._base.resolve_same_context(location)
                except ValidationError:
                    raise CompatibilityError(
                        "Confluence read redirect leaves the configured origin or context"
                    ) from None
                params = None
                redirects += 1
                continue
            if method not in {"GET", "HEAD"} and response.status_code in _READ_REDIRECTS:
                raise AmbiguousWriteError("Mutation redirect was refused")
            if 200 <= response.status_code < 300:
                return response

            classification = classify_status(method, response.status_code)
            if classification.retryable and attempt < self._retry_policy.max_attempts:
                delay = retry_delay(
                    self._retry_policy,
                    attempt=attempt,
                    retry_after=response.headers.get("retry-after"),
                )
                await self._emit_retry(method, attempt, delay)
                await asyncio.sleep(delay)
                continue
            if classification.ambiguous:
                raise AmbiguousWriteError(
                    f"Outcome of {method} request is ambiguous",
                    status_code=response.status_code,
                )
            self._raise_status(method, response.status_code)

    async def _send_once(
        self,
        method: str,
        url: str,
        *,
        params: Mapping[str, str] | None,
        headers: Mapping[str, str] | None,
        json_body: object | None,
        files: Mapping[str, tuple[str, BinaryIO, str]] | None,
    ) -> _WireResponse:
        request = self._http.build_request(
            method,
            url,
            params=params,
            headers=headers,
            json=json_body,
            files=files,
        )
        response = await self._http.send(request, stream=True)
        chunks: list[bytes] = []
        size = 0
        try:
            content_encoding = response.headers.get("content-encoding", "identity")
            if content_encoding.strip().lower() not in {"", "identity"}:
                raise ResponseLimitError("Compressed Confluence responses are refused")
            content_length = response.headers.get("content-length")
            if content_length is not None:
                if not content_length.isdecimal():
                    raise ResponseLimitError("Confluence response has an invalid length")
                if int(content_length) > self._response_limit_bytes:
                    raise ResponseLimitError("Confluence response exceeded the configured limit")
            async for chunk in response.aiter_bytes(chunk_size=64 * 1024):
                size += len(chunk)
                if size > self._response_limit_bytes:
                    raise ResponseLimitError("Confluence response exceeded the configured limit")
                chunks.append(chunk)
        finally:
            await response.aclose()
        return _WireResponse(
            status_code=response.status_code,
            headers=response.headers,
            url=str(response.url),
            content=b"".join(chunks),
        )

    def _raise_status(self, method: str, status_code: int) -> None:
        message = f"Confluence {method} request failed with HTTP {status_code}"
        if status_code in {401, 403}:
            raise AuthenticationError(message, status_code=status_code)
        if status_code == 404:
            raise NotFoundError(message, status_code=status_code)
        if status_code == 409:
            raise ConflictError(message, status_code=status_code)
        if status_code == 400:
            raise ValidationError(message, status_code=status_code)
        raise ConfluenceError(message, status_code=status_code)

    async def _emit_retry(self, method: str, attempt: int, delay: float) -> None:
        await self._event_sink.emit(
            PublishEvent(
                kind=EventKind.RETRY,
                run_id="transport",
                message=f"Retrying {method} request after {delay:.3f}s",
                attempt=attempt,
            )
        )

    async def _read_content_wire(self, content_id: str, *, expand: str) -> ContentWire:
        response = await self._request(
            "GET",
            f"/rest/api/content/{path_segment(content_id)}",
            params={"expand": expand},
        )
        wire = response.model(ContentWire)
        if wire.id != content_id:
            raise ValidationError("Confluence content readback returned a different ID")
        return wire

    async def _get_property(self, content_id: str, key: str) -> PropertyWire | None:
        path = f"/rest/api/content/{path_segment(content_id)}/property/{text_segment(key)}"
        try:
            response = await self._request("GET", path)
        except NotFoundError:
            return None
        return response.model(PropertyWire)

    async def _set_generic_property(
        self,
        content_id: str,
        key: str,
        value: Mapping[str, object],
        *,
        property_version: int | None,
    ) -> int:
        if property_version is None:
            method = "POST"
            path = f"/rest/api/content/{path_segment(content_id)}/property"
            payload: dict[str, object] = {"key": key, "value": dict(value)}
        else:
            method = "PUT"
            path = f"/rest/api/content/{path_segment(content_id)}/property/{text_segment(key)}"
            payload = {
                "key": key,
                "value": dict(value),
                "version": {"number": property_version + 1},
            }
        try:
            response = await self._request(method, path, json_body=payload)
        except (AmbiguousWriteError, ConflictError):
            reconciled_version = await self._try_property_version(content_id, key, value)
            if reconciled_version is not None:
                return reconciled_version
            raise
        try:
            written = response.model(PropertyWire)
        except ConfluenceError:
            written = None
        if (
            written is not None
            and written.key == key
            and dict(written.value) == dict(value)
            and written.version is not None
        ):
            return written.version.number
        reconciled_version = await self._try_property_version(content_id, key, value)
        if reconciled_version is not None:
            return reconciled_version
        raise AmbiguousWriteError("Content property write readback is ambiguous")

    async def _iter_collection(
        self,
        path: str,
        *,
        params: Mapping[str, str],
    ) -> AsyncIterator[Mapping[str, object]]:
        first_url = f"{self._base.rest(path)}?{urlencode(params)}"

        async def fetch(url: str) -> Page[Mapping[str, object]]:
            response = await self._request("GET", url)
            envelope = response.model(PageEnvelope)
            return Page(
                items=tuple(envelope.results),
                start=envelope.start,
                limit=envelope.limit,
                size=envelope.size,
                next_link=envelope.links.next,
            )

        async for item in paginate(
            first_url,
            fetch,
            validate_next=self._base.resolve_same_context,
        ):
            yield item

    async def _list_labels(self, content_id: str) -> set[str]:
        labels: set[str] = set()
        path = f"/rest/api/content/{path_segment(content_id)}/label"
        async for raw in self._iter_collection(path, params={"limit": "100"}):
            label = _model_from_mapping(LabelWire, raw)
            if label.prefix == "global":
                labels.add(label.name)
        return labels

    async def _try_list_labels(self, content_id: str) -> set[str] | None:
        try:
            return await self._list_labels(content_id)
        except ConfluenceError:
            return None

    async def _iter_attachments(self, content_id: str) -> AsyncIterator[AttachmentWire]:
        path = f"/rest/api/content/{path_segment(content_id)}/child/attachment"
        async for raw in self._iter_collection(path, params={"limit": "100", "expand": "version"}):
            yield _model_from_mapping(AttachmentWire, raw)

    async def _require_owned_current(
        self,
        content_id: str,
        *,
        expectation: MutationExpectation | None = None,
    ) -> RemoteContent:
        current = await self.get_content(content_id)
        if expectation is not None:
            assert_mutation_expectation(current, expectation)
            return current
        marker = current.ownership
        if marker is None:
            raise ConflictError("Content is not owned by this publisher")
        assert_owned(
            current,
            vault_id=marker.vault_id,
            source_id=marker.source_id,
            space_key=marker.space_key,
            root_page_id=marker.root_page_id,
            source_kind=marker.source_kind,
        )
        return current

    async def _try_get_content(self, content_id: str) -> RemoteContent | None:
        try:
            return await self.get_content(content_id)
        except ConfluenceError:
            return None

    async def _try_property_version(
        self,
        content_id: str,
        key: str,
        value: Mapping[str, object],
    ) -> int | None:
        try:
            observed = await self._get_property(content_id, key)
        except ConfluenceError:
            return None
        if (
            observed is None
            or observed.key != key
            or dict(observed.value) != dict(value)
            or observed.version is None
        ):
            return None
        return observed.version.number

    async def _require_label_authority(
        self,
        content_id: str,
        *,
        previously_managed: set[str],
        expectation: MutationExpectation | None,
    ) -> RemoteContent:
        current = await self._require_owned_current(content_id, expectation=expectation)
        marker = current.ownership
        if marker is None:  # defensive; the ownership guard proves this
            raise ConflictError("Content is not owned by this publisher")
        if set(marker.managed_labels) != previously_managed:
            raise ConflictError("Managed label authority changed after planning")
        return current

    async def _require_parent_current(
        self,
        parent_id: str,
        *,
        space_key: str,
        expectation: MutationExpectation | None,
    ) -> RemoteContent:
        target = self._require_target()
        if space_key != target.space_key:
            raise ConflictError("Mutation target differs from the preflighted space")
        parent_id = _validated_id(parent_id)
        parent = await self.get_content(parent_id)
        if parent.content_id != parent_id:
            raise ConflictError("Desired parent readback returned a different content ID")
        if parent.kind is not ContentKind.PAGE or parent.status != "current":
            raise ConflictError("Desired parent is not a current Confluence page")
        if parent.space_key != target.space_key:
            raise ConflictError("Desired parent is outside the preflighted space")
        if parent_id != target.root_page_id and target.root_page_id not in parent.ancestor_ids:
            raise ConflictError("Desired parent moved outside the configured root tree")
        if expectation is not None:
            assert_mutation_expectation(parent, expectation)
        return parent

    async def _assert_attachment_observation(
        self,
        content_id: str,
        *,
        asset: AssetSpec,
        expected: AttachmentObservation,
        vault_id: str,
        source_id: str,
    ) -> None:
        filename = asset.attachment_filename
        if filename is None:
            raise ValidationError("Managed attachment requires a filename")
        matches = [
            item async for item in self._iter_attachments(content_id) if item.title == filename
        ]
        if expected.attachment_id is None:
            if matches:
                raise ConflictError("Attachment appeared after planning")
            return
        if len(matches) != 1 or matches[0].id != expected.attachment_id:
            raise ConflictError("Managed attachment identity changed after planning")
        property_wire = await self._get_property(expected.attachment_id, ATTACHMENT_PROPERTY_KEY)
        if property_wire is None:
            raise ConflictError("Managed attachment property disappeared after planning")
        observed_sha = validate_attachment_marker(
            property_wire.value,
            vault_id=vault_id,
            source_id=source_id,
            asset_id=asset.asset_id,
            filename=filename,
        )
        observed_version = property_wire.version.number if property_wire.version else None
        if (
            observed_sha != expected.observed_sha256
            or observed_version != expected.property_version
        ):
            raise ConflictError("Managed attachment property changed after planning")

    async def _reconcile_attachment_marker(
        self,
        content_id: str,
        *,
        filename: str,
        vault_id: str,
        source_id: str,
        asset_id: str,
        sha256: str,
    ) -> str | None:
        for attachment in [
            item async for item in self._iter_attachments(content_id) if item.title == filename
        ]:
            marker = await self._get_property(attachment.id, ATTACHMENT_PROPERTY_KEY)
            if marker is None:
                continue
            observed = validate_attachment_marker(
                marker.value,
                vault_id=vault_id,
                source_id=source_id,
                asset_id=asset_id,
                filename=filename,
            )
            if observed == sha256:
                return attachment.id
        return None

    def _content_to_remote(
        self,
        wire: ContentWire,
        *,
        ownership: OwnershipMarker | None,
        property_version: int | None,
    ) -> RemoteContent:
        if wire.space is None:
            raise ValidationError("Confluence content response lacks its space")
        try:
            kind = ContentKind(wire.type)
        except ValueError:
            raise ValidationError("Confluence returned an unsupported content type") from None
        storage_value: str | None = None
        storage_hash: str | None = None
        if wire.body is not None and wire.body.storage is not None:
            if wire.body.storage.representation != "storage":
                raise ValidationError("Confluence returned a non-storage body representation")
            storage_value = wire.body.storage.value
            storage_hash = canonical_storage_sha256(storage_value)
        ancestor_ids = tuple(item.id for item in wire.ancestors)
        direct_parent_id = ancestor_ids[-1] if kind is ContentKind.PAGE and ancestor_ids else None
        return RemoteContent(
            content_id=wire.id,
            kind=kind,
            status=wire.status,
            title=wire.title,
            space_key=wire.space.key,
            direct_parent_id=direct_parent_id,
            ancestor_ids=ancestor_ids,
            version=wire.version.number,
            storage_value=storage_value,
            storage_sha256=storage_hash,
            ownership=ownership,
            ownership_property_version=property_version,
        )

    def _content_web_url(self, wire: ContentWire) -> str | None:
        if wire.links.webui is None:
            return None
        if wire.links.base:
            server_base = ConfluenceBaseUrl.parse(wire.links.base)
            if wire.links.context:
                returned_context = ConfluenceBaseUrl.parse(
                    f"{server_base.origin}{wire.links.context}"
                ).context_path
                if not server_base.context_path:
                    server_base = ConfluenceBaseUrl.parse(f"{server_base.origin}{returned_context}")
                elif server_base.context_path != returned_context:
                    raise CompatibilityError("Confluence content links disagree on context")
            if (
                server_base.origin != self._base.origin
                or server_base.context_path != self._base.context_path
            ):
                raise CompatibilityError(
                    "Confluence content links identify another origin or context"
                )
        webui = wire.links.webui
        if (
            webui.startswith("/")
            and self._base.context_path
            and not webui.startswith(f"{self._base.context_path}/")
        ):
            webui = f"{self._base.context_path}{webui}"
        return self._base.resolve_same_context(webui)

    def _require_target(self) -> TargetIdentity:
        if self._target is None:
            raise CompatibilityError("Confluence preflight must run before this operation")
        return self._target


def _model_from_mapping(model_type: type[WireT], value: Mapping[str, object]) -> WireT:
    try:
        return model_type.model_validate(value)
    except PydanticValidationError:
        pass
    raise ValidationError("Confluence collection item violated the DC 9.2 contract")


def _validated_id(value: str) -> str:
    path_segment(value)
    return value


def _validate_space(value: str) -> None:
    if not _SPACE_KEY.fullmatch(value):
        raise ValidationError("Confluence space key is invalid")


def _validated_label(value: str) -> str:
    if not _LABEL.fullmatch(value):
        raise ValidationError("Managed label is not normalized or exceeds its limit")
    return value


def _content_kind(value: str) -> ContentKind:
    try:
        return ContentKind(value)
    except ValueError:
        raise ValidationError("Unsupported Confluence content type") from None


def _matches_desired(
    content: RemoteContent,
    *,
    title: str,
    parent_id: str | None,
    storage_hash: str,
) -> bool:
    return (
        content.title == title
        and content.direct_parent_id == parent_id
        and content.storage_sha256 == storage_hash
    )


def _valid_updated_readback(
    observed: RemoteContent,
    *,
    previous: RemoteContent,
    title: str,
    parent_id: str | None,
    storage_hash: str,
) -> bool:
    marker = previous.ownership
    if marker is None:
        return False
    try:
        assert_owned(
            observed,
            vault_id=marker.vault_id,
            source_id=marker.source_id,
            space_key=marker.space_key,
            root_page_id=marker.root_page_id,
            source_kind=marker.source_kind,
        )
    except OwnershipError:
        return False
    return (
        observed.content_id == previous.content_id
        and observed.kind is previous.kind
        and observed.status == "current"
        and observed.version > previous.version
        and observed.ownership == previous.ownership
        and observed.ownership_property_version == previous.ownership_property_version
        and _matches_desired(
            observed,
            title=title,
            parent_id=parent_id,
            storage_hash=storage_hash,
        )
    )


def _same_content_observation(left: RemoteContent, right: RemoteContent) -> bool:
    return (
        left.content_id == right.content_id
        and left.kind is right.kind
        and left.status == right.status
        and left.title == right.title
        and left.space_key == right.space_key
        and left.direct_parent_id == right.direct_parent_id
        and left.version == right.version
        and left.storage_sha256 == right.storage_sha256
        and left.ownership == right.ownership
        and left.ownership_property_version == right.ownership_property_version
    )


def _snapshot_asset(
    path: Path,
    destination: BinaryIO,
    *,
    max_bytes: int,
) -> tuple[str, int]:
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
        raise ValidationError("Managed attachment source is not a readable regular file")
    digest = hashlib.sha256()
    size = 0
    try:
        with os.fdopen(descriptor, "rb", closefd=True) as handle:
            if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
                raise ValidationError("Managed attachment source is not a regular file")
            while True:
                read_size = min(1024 * 1024, max_bytes - size + 1)
                chunk = handle.read(read_size)
                if not chunk:
                    break
                size += len(chunk)
                if size > max_bytes:
                    raise ValidationError("Managed attachment source exceeds its approved size")
                digest.update(chunk)
                destination.write(chunk)
    except OSError:
        pass
    else:
        destination.flush()
        destination.seek(0)
        return digest.hexdigest(), size
    # Raise after the handler so OS exceptions do not retain absolute local paths.
    with suppress(OSError):
        os.close(descriptor)
    raise ValidationError("Managed attachment source could not be read safely")


def _attachment_from_upload(response: _WireResponse) -> AttachmentWire:
    mapping = response.mapping()
    results = mapping.get("results")
    if isinstance(results, list) and len(results) == 1 and isinstance(results[0], dict):
        return _model_from_mapping(AttachmentWire, results[0])
    return response.model(AttachmentWire)
