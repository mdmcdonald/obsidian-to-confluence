from __future__ import annotations

import hashlib
import json
from dataclasses import replace
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import pytest

from md2conf_dc.confluence import BearerAuth, ConfluenceClient, RetryPolicy
from md2conf_dc.confluence.errors import ConflictError
from md2conf_dc.confluence.models import canonical_storage_sha256
from md2conf_dc.confluence.retry import retry_delay
from md2conf_dc.events import EventKind, PublishEvent
from md2conf_dc.models import (
    AssetSpec,
    ContentKind,
    OwnershipMarker,
    RemoteContent,
    SourceKind,
    TargetIdentity,
)
from md2conf_dc.ownership import MutationExpectation, OwnershipError

VAULT_ID = "a76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83"
SOURCE_ID = "dc3e7bc5-0832-44f1-9132-c80cb50a8250"
PROPERTY_KEY = "markdown-confluence.publisher"
ASSET_KEY = "markdown-confluence.asset"


class EventCollector:
    def __init__(self) -> None:
        self.events: list[PublishEvent] = []

    async def emit(self, event: PublishEvent) -> None:
        self.events.append(event)


def _marker_value(*, labels: tuple[str, ...] = ()) -> dict[str, object]:
    return {
        "schema": 1,
        "managed": True,
        "publisher": "md2conf-dc",
        "vault_id": VAULT_ID,
        "source_id": SOURCE_ID,
        "source_kind": "note",
        "source_path": "page.md",
        "root_page_id": "123",
        "space_key": "DOCS",
        "managed_labels": list(labels),
        "last_render_sha256": "a" * 64,
        "last_run_id": "previous",
    }


def _property(
    value: dict[str, object], *, key: str = PROPERTY_KEY, version: int = 3
) -> dict[str, object]:
    return {"id": "77", "key": key, "value": value, "version": {"number": version}}


def _content_wire(
    *,
    content_id: str = "456",
    title: str = "Page",
    storage: str = "<p>old</p>",
    version: int = 1,
    ancestors: tuple[str, ...] = ("123",),
    content_type: str = "page",
) -> dict[str, object]:
    return {
        "id": content_id,
        "type": content_type,
        "status": "current",
        "title": title,
        "space": {"key": "DOCS"},
        "ancestors": [{"id": item} for item in ancestors],
        "version": {"number": version},
        "body": {"storage": {"value": storage, "representation": "storage"}},
    }


def _attachment_wire(content_id: str, title: str) -> dict[str, object]:
    return {
        "id": content_id,
        "type": "attachment",
        "status": "current",
        "title": title,
    }


def _remote() -> RemoteContent:
    storage = "<p>old</p>"
    marker = OwnershipMarker(
        schema=1,
        managed=True,
        publisher="md2conf-dc",
        vault_id=VAULT_ID,
        source_id=SOURCE_ID,
        source_kind=SourceKind.NOTE,
        source_path="page.md",
        root_page_id="123",
        space_key="DOCS",
        managed_labels=(),
        last_render_sha256="a" * 64,
        last_run_id="previous",
    )
    return RemoteContent(
        content_id="456",
        kind=ContentKind.PAGE,
        status="current",
        title="Page",
        space_key="DOCS",
        direct_parent_id="555",
        ancestor_ids=("123", "555"),
        version=1,
        storage_value=storage,
        storage_sha256=canonical_storage_sha256(storage),
        ownership=marker,
        ownership_property_version=3,
    )


def _prime_target(client: ConfluenceClient) -> None:
    client._target = TargetIdentity(
        base_url="https://confluence.example.test/confluence",
        server_version="9.2.4",
        server_build="9204",
        space_key="DOCS",
        root_page_id="123",
        current_user="publisher",
        fingerprint="sha256:" + "a" * 64,
    )


def _expectation(
    remote: RemoteContent,
    *,
    require_owned: bool = True,
) -> MutationExpectation:
    marker = remote.ownership
    if marker is None:
        raise AssertionError("Test expectation requires an ownership marker")
    return MutationExpectation(
        vault_id=marker.vault_id,
        source_id=marker.source_id,
        source_kind=marker.source_kind,
        space_key=marker.space_key,
        root_page_id=marker.root_page_id,
        content_kind=remote.kind,
        status=remote.status,
        title=remote.title,
        version=remote.version,
        property_version=remote.ownership_property_version,
        storage_sha256=remote.storage_sha256,
        parent_id=remote.direct_parent_id,
        require_owned=require_owned,
    )


def _wire_expectation(
    *,
    property_version: int | None = 3,
    require_owned: bool = True,
) -> MutationExpectation:
    storage = "<p>old</p>"
    return MutationExpectation(
        vault_id=VAULT_ID,
        source_id=SOURCE_ID,
        source_kind=SourceKind.NOTE,
        space_key="DOCS",
        root_page_id="123",
        content_kind=ContentKind.PAGE,
        status="current",
        title="Page",
        version=1,
        property_version=property_version,
        storage_sha256=canonical_storage_sha256(storage),
        parent_id="123",
        require_owned=require_owned,
    )


@pytest.mark.asyncio
async def test_label_reconciliation_paginates_and_preserves_unmanaged_labels() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value(labels=("old-managed",))))
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith("/content/456/label") and request.method == "GET":
            if request.url.params.get("start") == "2":
                return httpx.Response(
                    200,
                    json={
                        "results": [{"prefix": "global", "name": "desired-existing"}],
                        "start": 2,
                        "limit": 2,
                        "size": 1,
                        "_links": {},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [
                        {"prefix": "global", "name": "manual-label"},
                        {"prefix": "global", "name": "old-managed"},
                    ],
                    "start": 0,
                    "limit": 2,
                    "size": 2,
                    "_links": {"next": "/confluence/rest/api/content/456/label?start=2&limit=2"},
                },
            )
        return httpx.Response(204)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        await client.reconcile_labels(
            "456",
            desired=("desired-existing", "desired-new"),
            previously_managed=("old-managed",),
            expectation=_wire_expectation(),
        )
    finally:
        await client.close()

    additions = [
        json.loads(request.content)
        for request in requests
        if request.method == "POST" and request.url.path.endswith("/content/456/label")
    ]
    deletes = [request.url.path for request in requests if request.method == "DELETE"]
    assert additions == [[{"prefix": "global", "name": "desired-new"}]]
    assert deletes == ["/confluence/rest/api/content/456/label/old-managed"]
    assert all("manual-label" not in path for path in deletes)


@pytest.mark.asyncio
async def test_guarded_label_write_rejects_last_moment_owner_swap() -> None:
    requests: list[httpx.Request] = []
    content_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal content_reads
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            marker = _marker_value()
            if content_reads >= 2:
                marker["vault_id"] = "b76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83"
            return httpx.Response(200, json=_property(marker))
        if path.endswith("/content/456"):
            content_reads += 1
            return httpx.Response(
                200,
                json=_content_wire(ancestors=("123", "555")),
            )
        if path.endswith("/label"):
            return httpx.Response(
                200,
                json={"results": [], "start": 0, "limit": 100, "size": 0},
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(OwnershipError):
            await client.reconcile_labels(
                "456",
                ("managed",),
                (),
                expectation=_expectation(_remote()),
            )
    finally:
        await client.close()
    assert not any(request.method == "POST" for request in requests)


@pytest.mark.asyncio
async def test_label_delete_requires_exact_planned_managed_label_authority() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(
                200,
                json=_property(_marker_value(labels=("different-label",))),
            )
        if path.endswith("/content/456"):
            return httpx.Response(
                200,
                json=_content_wire(ancestors=("123", "555")),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ConflictError, match="label authority"):
            await client.reconcile_labels(
                "456",
                (),
                ("old-managed",),
                expectation=_expectation(_remote()),
            )
    finally:
        await client.close()
    assert not any(request.method == "DELETE" for request in requests)


@pytest.mark.asyncio
async def test_unchanged_attachment_is_found_beyond_first_page_and_not_uploaded(
    tmp_path: Path,
) -> None:
    source = tmp_path / "diagram.png"
    source.write_bytes(b"managed-image")
    sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/content/456/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith("/content/456/child/attachment"):
            if request.url.params.get("start") == "1":
                return httpx.Response(
                    200,
                    json={
                        "results": [_attachment_wire("55", "diagram.png")],
                        "start": 1,
                        "limit": 100,
                        "size": 1,
                        "_links": {},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [_attachment_wire("54", "other.png")],
                    "start": 0,
                    "limit": 1,
                    "size": 1,
                    "_links": {
                        "next": (
                            "/confluence/rest/api/content/456/child/attachment"
                            "?start=1&limit=100&expand=version"
                        )
                    },
                },
            )
        if path.endswith(f"/content/55/property/{ASSET_KEY}"):
            value = {
                "schema": 1,
                "publisher": "md2conf-dc",
                "vault_id": VAULT_ID,
                "source_id": SOURCE_ID,
                "asset_id": "asset-1",
                "filename": "diagram.png",
                "sha256": sha256,
                "renderer": "image",
            }
            return httpx.Response(200, json=_property(value, key=ASSET_KEY, version=4))
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source=str(source),
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256=sha256,
        size=source.stat().st_size,
    )
    try:
        attachment_id = await client.reconcile_asset(
            "456", asset, source, expectation=_wire_expectation()
        )
    finally:
        await client.close()

    assert attachment_id == "55"
    assert (
        sum(
            request.method == "GET" and "child/attachment" in request.url.path
            for request in requests
        )
        == 2
    )
    assert not any(request.method == "POST" for request in requests)


@pytest.mark.asyncio
async def test_changed_attachment_uses_data_endpoint_no_check_and_versioned_property(
    tmp_path: Path,
) -> None:
    source = tmp_path / "diagram.png"
    source.write_bytes(b"new-image")
    sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/content/456/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith("/content/456/child/attachment") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "results": [_attachment_wire("55", "diagram.png")],
                    "start": 0,
                    "limit": 100,
                    "size": 1,
                    "_links": {},
                },
            )
        if path.endswith(f"/content/55/property/{ASSET_KEY}") and request.method == "GET":
            value = {
                "schema": 1,
                "publisher": "md2conf-dc",
                "vault_id": VAULT_ID,
                "source_id": SOURCE_ID,
                "asset_id": "asset-1",
                "filename": "diagram.png",
                "sha256": "0" * 64,
                "renderer": "image",
            }
            return httpx.Response(200, json=_property(value, key=ASSET_KEY, version=4))
        if path.endswith("/content/456/child/attachment/55/data"):
            return httpx.Response(
                200,
                json={"results": [_attachment_wire("55", "diagram.png")]},
            )
        if path.endswith(f"/content/55/property/{ASSET_KEY}") and request.method == "PUT":
            payload = json.loads(request.content)
            return httpx.Response(
                200,
                json=_property(payload["value"], key=ASSET_KEY, version=5),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source=str(source),
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256=sha256,
        size=source.stat().st_size,
    )
    try:
        assert (
            await client.reconcile_asset("456", asset, source, expectation=_wire_expectation())
            == "55"
        )
    finally:
        await client.close()

    upload = next(request for request in requests if request.url.path.endswith("/55/data"))
    property_update = next(
        request
        for request in requests
        if request.method == "PUT" and request.url.path.endswith(f"/property/{ASSET_KEY}")
    )
    assert upload.headers["x-atlassian-token"] == "no-check"
    payload = json.loads(property_update.content)
    assert payload["version"] == {"number": 5}
    assert payload["value"]["sha256"] == sha256


@pytest.mark.asyncio
async def test_attachment_property_version_race_blocks_bytes_upload(tmp_path: Path) -> None:
    source = tmp_path / "diagram.png"
    source.write_bytes(b"new-image")
    sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    requests: list[httpx.Request] = []
    property_reads = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal property_reads
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/content/456/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            return httpx.Response(
                200,
                json=_content_wire(ancestors=("123", "555")),
            )
        if path.endswith("/content/456/child/attachment") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "results": [_attachment_wire("55", "diagram.png")],
                    "start": 0,
                    "limit": 100,
                    "size": 1,
                },
            )
        if path.endswith(f"/content/55/property/{ASSET_KEY}"):
            property_reads += 1
            value = {
                "schema": 1,
                "publisher": "md2conf-dc",
                "vault_id": VAULT_ID,
                "source_id": SOURCE_ID,
                "asset_id": "asset-1",
                "filename": "diagram.png",
                "sha256": "0" * 64,
                "renderer": "image",
            }
            return httpx.Response(
                200,
                json=_property(
                    value,
                    key=ASSET_KEY,
                    version=4 if property_reads == 1 else 5,
                ),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source=str(source),
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256=sha256,
        size=source.stat().st_size,
    )
    try:
        with pytest.raises(ConflictError, match="property changed"):
            await client.reconcile_asset(
                "456",
                asset,
                source,
                expectation=_expectation(_remote()),
            )
    finally:
        await client.close()
    assert not any(request.method == "POST" for request in requests)


@pytest.mark.asyncio
async def test_attachment_upload_uses_hashed_snapshot_after_path_replacement(
    tmp_path: Path,
) -> None:
    source = tmp_path / "diagram.png"
    approved = b"approved-image-bytes"
    replacement = b"replaced-after-hash"
    source.write_bytes(approved)
    sha256 = hashlib.sha256(approved).hexdigest()
    uploaded: bytes | None = None
    content_reads = 0
    attachment_created = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attachment_created, content_reads, uploaded
        path = request.url.path
        if path.endswith(f"/content/456/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            content_reads += 1
            if content_reads == 2:
                source.write_bytes(replacement)
            return httpx.Response(200, json=_content_wire())
        if path.endswith("/content/456/child/attachment") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "results": (
                        [_attachment_wire("55", "diagram.png")] if attachment_created else []
                    ),
                    "start": 0,
                    "limit": 100,
                    "size": 1 if attachment_created else 0,
                },
            )
        if path.endswith("/content/456/child/attachment") and request.method == "POST":
            uploaded = request.read()
            attachment_created = True
            return httpx.Response(
                200,
                json={"results": [_attachment_wire("55", "diagram.png")]},
            )
        if path.endswith("/content/55/property") and request.method == "POST":
            payload = json.loads(request.content)
            return httpx.Response(
                200,
                json=_property(payload["value"], key=ASSET_KEY, version=1),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    asset = AssetSpec(
        asset_id="asset-1",
        kind="image",
        source=str(source),
        attachment_filename="diagram.png",
        mime_type="image/png",
        sha256=sha256,
        size=len(approved),
    )
    try:
        assert (
            await client.reconcile_asset("456", asset, source, expectation=_wire_expectation())
            == "55"
        )
    finally:
        await client.close()
    assert uploaded is not None
    assert approved in uploaded
    assert replacement not in uploaded


@pytest.mark.asyncio
async def test_missing_attachment_uses_create_endpoint_then_creates_checksum_property(
    tmp_path: Path,
) -> None:
    source = tmp_path / "new.png"
    source.write_bytes(b"new-attachment")
    sha256 = hashlib.sha256(source.read_bytes()).hexdigest()
    requests: list[httpx.Request] = []
    attachment_created = False

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attachment_created
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/content/456/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith("/content/456/child/attachment") and request.method == "GET":
            return httpx.Response(
                200,
                json={
                    "results": ([_attachment_wire("56", "new.png")] if attachment_created else []),
                    "start": 0,
                    "limit": 100,
                    "size": 1 if attachment_created else 0,
                    "_links": {},
                },
            )
        if path.endswith("/content/456/child/attachment") and request.method == "POST":
            attachment_created = True
            return httpx.Response(
                200,
                json={"results": [_attachment_wire("56", "new.png")]},
            )
        if path.endswith("/content/56/property") and request.method == "POST":
            payload = json.loads(request.content)
            return httpx.Response(
                200,
                json=_property(payload["value"], key=ASSET_KEY, version=1),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    asset = AssetSpec(
        asset_id="asset-new",
        kind="image",
        source=str(source),
        attachment_filename="new.png",
        mime_type="image/png",
        sha256=sha256,
        size=source.stat().st_size,
    )
    try:
        assert (
            await client.reconcile_asset("456", asset, source, expectation=_wire_expectation())
            == "56"
        )
    finally:
        await client.close()

    upload = next(
        request
        for request in requests
        if request.method == "POST" and request.url.path.endswith("/child/attachment")
    )
    marker_create = next(
        request
        for request in requests
        if request.method == "POST" and request.url.path.endswith("/content/56/property")
    )
    assert upload.headers["x-atlassian-token"] == "no-check"
    assert "/data" not in upload.url.path
    marker_payload = json.loads(marker_create.content)
    assert marker_payload["key"] == ASSET_KEY
    assert marker_payload["value"]["sha256"] == sha256


@pytest.mark.parametrize(("first_status", "expected_puts"), [(409, 2), (503, 1)])
@pytest.mark.asyncio
async def test_versioned_update_reconciles_conflict_or_ambiguous_success(
    first_status: int,
    expected_puts: int,
) -> None:
    requests: list[httpx.Request] = []
    updated = False
    put_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal put_calls, updated
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if request.method == "PUT":
            put_calls += 1
            if put_calls == 1 and first_status == 409:
                return httpx.Response(409, json={"statusCode": 409})
            updated = True
            if put_calls == 1 and first_status == 503:
                return httpx.Response(503, json={"statusCode": 503})
            return httpx.Response(
                200,
                json=_content_wire(
                    title="New",
                    storage="<p>new</p>",
                    version=2,
                    ancestors=("123", "999"),
                ),
            )
        if path.endswith("/content/999"):
            return httpx.Response(
                200,
                json=_content_wire(
                    content_id="999",
                    title="Parent",
                    ancestors=("123",),
                ),
            )
        if path.endswith("/content/456"):
            return httpx.Response(
                200,
                json=(
                    _content_wire(
                        title="New",
                        storage="<p>new</p>",
                        version=2,
                        ancestors=("123", "999"),
                    )
                    if updated
                    else _content_wire(ancestors=("123", "555"))
                ),
            )
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    _prime_target(client)
    try:
        result = await client.update_content(
            content=_remote(),
            title="New",
            parent_id="999",
            storage_value="<p>new</p>",
        )
    finally:
        await client.close()

    assert result.version == 2
    assert result.direct_parent_id == "999"
    assert put_calls == expected_puts
    payloads = [json.loads(request.content) for request in requests if request.method == "PUT"]
    assert all(payload["version"] == {"number": 2} for payload in payloads)
    assert all(payload["ancestors"] == [{"id": "999"}] for payload in payloads)


@pytest.mark.asyncio
async def test_divergent_version_conflict_is_never_overwritten() -> None:
    put_calls = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal put_calls
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if request.method == "PUT":
            put_calls += 1
            return httpx.Response(409, json={"statusCode": 409})
        if path.endswith("/content/999"):
            return httpx.Response(
                200,
                json=_content_wire(
                    content_id="999",
                    title="Parent",
                    ancestors=("123",),
                ),
            )
        if path.endswith("/content/456"):
            if put_calls:
                return httpx.Response(
                    200,
                    json=_content_wire(
                        title="Manual edit",
                        storage="<p>manual</p>",
                        version=2,
                        ancestors=("123", "555"),
                    ),
                )
            return httpx.Response(200, json=_content_wire(ancestors=("123", "555")))
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    _prime_target(client)
    try:
        with pytest.raises(ConflictError):
            await client.update_content(
                content=_remote(),
                title="New",
                parent_id="999",
                storage_value="<p>new</p>",
            )
    finally:
        await client.close()
    assert put_calls == 1


@pytest.mark.asyncio
async def test_ambiguous_ownership_create_reconciles_by_property_readback() -> None:
    property_value: dict[str, object] | None = None
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal property_value
        requests.append(request)
        path = request.url.path
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            if property_value is None:
                return httpx.Response(404, json={"statusCode": 404})
            return httpx.Response(200, json=_property(property_value, version=1))
        if request.method == "POST" and path.endswith("/content/456/property"):
            property_value = json.loads(request.content)["value"]
            return httpx.Response(503, json={"statusCode": 503})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    marker = OwnershipMarker(
        schema=1,
        managed=True,
        publisher="md2conf-dc",
        vault_id=VAULT_ID,
        source_id=SOURCE_ID,
        source_kind=SourceKind.NOTE,
        source_path="page.md",
        root_page_id="123",
        space_key="DOCS",
        managed_labels=(),
        last_render_sha256="a" * 64,
        last_run_id="run",
    )
    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        assert (
            await client.set_ownership(
                "456",
                marker,
                None,
                expectation=_wire_expectation(
                    property_version=None,
                    require_owned=False,
                ),
            )
            == 1
        )
    finally:
        await client.close()
    assert sum(request.method == "POST" for request in requests) == 1


@pytest.mark.asyncio
async def test_existing_ownership_update_uses_observed_property_version() -> None:
    requests: list[httpx.Request] = []
    updated_value: dict[str, object] | None = None

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal updated_value
        requests.append(request)
        path = request.url.path
        if path.endswith("/content/456"):
            return httpx.Response(200, json=_content_wire())
        if path.endswith(f"/property/{PROPERTY_KEY}") and request.method == "GET":
            return httpx.Response(200, json=_property(_marker_value(), version=3))
        if path.endswith(f"/property/{PROPERTY_KEY}") and request.method == "PUT":
            payload = json.loads(request.content)
            updated_value = payload["value"]
            return httpx.Response(200, json=_property(updated_value, version=4))
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    marker = OwnershipMarker(
        schema=1,
        managed=True,
        publisher="md2conf-dc",
        vault_id=VAULT_ID,
        source_id=SOURCE_ID,
        source_kind=SourceKind.NOTE,
        source_path="page.md",
        root_page_id="123",
        space_key="DOCS",
        managed_labels=("new-label",),
        last_render_sha256="b" * 64,
        last_run_id="new-run",
    )
    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        assert (
            await client.set_ownership(
                "456",
                marker,
                3,
                expectation=_wire_expectation(),
            )
            == 4
        )
    finally:
        await client.close()

    update = next(request for request in requests if request.method == "PUT")
    payload = json.loads(update.content)
    assert payload["version"] == {"number": 4}
    assert updated_value is not None
    assert updated_value["managed_labels"] == ["new-label"]


@pytest.mark.asyncio
async def test_ambiguous_trash_is_reconciled_by_not_found_without_purge_query() -> None:
    deleted = False
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal deleted
        requests.append(request)
        path = request.url.path
        if request.method == "DELETE":
            deleted = True
            return httpx.Response(503, json={"statusCode": 503})
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            if deleted:
                return httpx.Response(404, json={"statusCode": 404})
            return httpx.Response(200, json=_content_wire())
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        await client.trash_content("456", expectation=_wire_expectation())
    finally:
        await client.close()

    delete = next(request for request in requests if request.method == "DELETE")
    assert delete.url.path == "/confluence/rest/api/content/456"
    assert not delete.url.query


@pytest.mark.asyncio
async def test_trash_refuses_noncurrent_content_before_delete() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith(f"/property/{PROPERTY_KEY}"):
            return httpx.Response(200, json=_property(_marker_value()))
        if path.endswith("/content/456"):
            wire = _content_wire(ancestors=("123", "555"))
            wire["status"] = "trashed"
            return httpx.Response(200, json=wire)
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    remote = replace(_remote(), status="trashed")
    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ConflictError, match="Only current"):
            await client.trash_content("456", expectation=_expectation(remote))
    finally:
        await client.close()
    assert not any(request.method == "DELETE" for request in requests)


@pytest.mark.asyncio
async def test_read_retry_honours_retry_after_and_emits_typed_event() -> None:
    attempts = 0
    collector = EventCollector()

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal attempts
        if request.url.path.endswith("/settings/systemInfo"):
            attempts += 1
            if attempts == 1:
                return httpx.Response(429, headers={"Retry-After": "0"})
            return httpx.Response(
                200,
                json={
                    "version": "9.2.4",
                    "buildNumber": "9204",
                    "baseUrl": "https://confluence.example.test/confluence",
                },
            )
        if request.url.path.endswith("/user/current"):
            return httpx.Response(200, json={"username": "publisher"})
        return httpx.Response(200, json=_content_wire(content_id="123", ancestors=()))

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        retry_policy=RetryPolicy(max_attempts=2, base_delay_seconds=0, max_delay_seconds=0),
        transport=httpx.MockTransport(handler),
        event_sink=collector,
    )
    try:
        await client.preflight("123")
    finally:
        await client.close()
    assert attempts == 2
    assert [event.kind for event in collector.events] == [EventKind.RETRY]


def test_retry_after_http_date_is_supported() -> None:
    now = datetime.now(UTC).replace(microsecond=0)
    value = (now + timedelta(seconds=4)).strftime("%a, %d %b %Y %H:%M:%S GMT")
    assert (
        retry_delay(
            RetryPolicy(max_attempts=2, base_delay_seconds=1, max_delay_seconds=10),
            attempt=1,
            retry_after=value,
            now=now,
        )
        == 4
    )
