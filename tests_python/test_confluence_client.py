from __future__ import annotations

import asyncio
import base64
import json
from collections.abc import Callable

import httpx
import pytest

from md2conf_dc.confluence import BasicAuth, BearerAuth, CompatibilityError, ConfluenceClient
from md2conf_dc.confluence.client import _WireResponse
from md2conf_dc.confluence.errors import (
    AmbiguousWriteError,
    TransportError,
    ValidationError,
)
from md2conf_dc.confluence.retry import RetryPolicy, classify_status, retry_delay
from md2conf_dc.confluence.urls import ConfluenceBaseUrl
from md2conf_dc.models import TargetIdentity


def _content(content_id: str = "123") -> dict[str, object]:
    return {
        "id": content_id,
        "type": "page",
        "status": "current",
        "title": "Boundary",
        "space": {"key": "DOCS"},
        "ancestors": [],
        "version": {"number": 1},
        "body": {"storage": {"value": "<p>Body</p>", "representation": "storage"}},
        "_links": {
            "base": "https://confluence.example.test",
            "context": "/confluence",
            "webui": "/pages/viewpage.action?pageId=123",
        },
    }


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


def _exception_graph_text(error: BaseException) -> str:
    pending: list[BaseException] = [error]
    seen: set[int] = set()
    values: list[str] = []
    while pending:
        current = pending.pop()
        if id(current) in seen:
            continue
        seen.add(id(current))
        values.extend((str(current), repr(current), repr(vars(current))))
        if current.__cause__ is not None:
            pending.append(current.__cause__)
        if current.__context__ is not None:
            pending.append(current.__context__)
    return "\n".join(values)


def test_deep_json_mapping_is_typed_and_does_not_retain_input() -> None:
    sentinel = "DEEP-JSON-SECRET-SENTINEL"
    content = b'{"' + sentinel.encode() + b'":' + (b"[" * 2_000) + b"0" + (b"]" * 2_000) + b"}"
    response = _WireResponse(200, httpx.Headers(), "https://example.test", content)
    with pytest.raises(ValidationError) as captured:
        response.mapping()
    assert captured.value.__context__ is None
    assert sentinel not in _exception_graph_text(captured.value)


@pytest.mark.asyncio
async def test_preflight_preserves_context_and_uses_bearer_auth() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.url.path.endswith("/settings/systemInfo"):
            return httpx.Response(200, json={"version": "9.2.4", "buildNumber": "9204"})
        if request.url.path.endswith("/user/current"):
            return httpx.Response(200, json={"username": "publisher"})
        return httpx.Response(200, json=_content())

    client = ConfluenceClient(
        "https://confluence.example.test/confluence/",
        BearerAuth("top-secret"),
        transport=httpx.MockTransport(handler),
    )
    try:
        target = await client.preflight("123")
    finally:
        await client.close()

    assert target.space_key == "DOCS"
    assert target.root_page_id == "123"
    assert target.web_url == (
        "https://confluence.example.test/confluence/pages/viewpage.action?pageId=123"
    )
    assert [request.url.path for request in requests] == [
        "/confluence/rest/api/settings/systemInfo",
        "/confluence/rest/api/user/current",
        "/confluence/rest/api/content/123",
    ]
    assert all(request.headers["authorization"] == "Bearer top-secret" for request in requests)
    assert all(request.headers["accept-encoding"] == "identity" for request in requests)


@pytest.mark.asyncio
async def test_basic_auth_and_create_payload_use_dc_storage_and_one_parent() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        if request.method == "POST":
            created = _content("456")
            created["title"] = "Created"
            created["ancestors"] = [{"id": "123"}]
            return httpx.Response(200, json=created)
        if request.url.path.endswith("/property/markdown-confluence.publisher"):
            return httpx.Response(404, json={"statusCode": 404})
        if request.url.path.endswith("/content/123"):
            return httpx.Response(200, json=_content("123"))
        created = _content("456")
        created["title"] = "Created"
        created["ancestors"] = [{"id": "123"}]
        return httpx.Response(200, json=created)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BasicAuth("svc", "password"),
        transport=httpx.MockTransport(handler),
    )
    _prime_target(client)
    try:
        created = await client.create_content(
            title="Created",
            content_type="page",
            space_key="DOCS",
            parent_id="123",
            storage_value="<p>Body</p>",
        )
    finally:
        await client.close()

    post = next(request for request in requests if request.method == "POST")
    payload = json.loads(post.content)
    assert payload == {
        "type": "page",
        "title": "Created",
        "space": {"key": "DOCS"},
        "body": {"storage": {"value": "<p>Body</p>", "representation": "storage"}},
        "ancestors": [{"id": "123"}],
    }
    expected = base64.b64encode(b"svc:password").decode("ascii")
    assert post.headers["authorization"] == f"Basic {expected}"
    assert created.content_id == "456"


@pytest.mark.asyncio
async def test_cross_origin_read_redirect_fails_closed() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        del request
        return httpx.Response(302, headers={"Location": "https://evil.example/rest/api/x"})

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(CompatibilityError):
            await client.preflight("123")
    finally:
        await client.close()


@pytest.mark.parametrize(
    "system_info",
    [
        {"version": "9.1.9", "buildNumber": "9199"},
        {"version": "10.0.0", "buildNumber": "10000"},
        {"version": "9.2.4", "buildNumber": "9204", "cloud": True},
        {
            "version": "9.2.4",
            "buildNumber": "9204",
            "deploymentType": "Server",
        },
        {
            "version": "9.2.4",
            "buildNumber": "9204",
            "baseUrl": "https://other.example.test/confluence",
        },
    ],
)
@pytest.mark.asyncio
async def test_preflight_rejects_unsupported_or_mismatched_deployment(
    system_info: dict[str, object],
) -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(200, json=system_info)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(CompatibilityError):
            await client.preflight("123")
    finally:
        await client.close()
    assert len(requests) == 1


@pytest.mark.asyncio
async def test_blogpost_payload_never_contains_ancestors() -> None:
    requests: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        blog = _content("600")
        blog.update({"type": "blogpost", "title": "News", "ancestors": []})
        blog["body"] = {"storage": {"value": "<p>News</p>", "representation": "storage"}}
        if request.url.path.endswith("/property/markdown-confluence.publisher"):
            return httpx.Response(404, json={"statusCode": 404})
        return httpx.Response(200, json=blog)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    _prime_target(client)
    try:
        created = await client.create_content(
            title="News",
            content_type="blogpost",
            space_key="DOCS",
            parent_id=None,
            storage_value="<p>News</p>",
        )
    finally:
        await client.close()

    payload = json.loads(next(item for item in requests if item.method == "POST").content)
    assert payload["type"] == "blogpost"
    assert "ancestors" not in payload
    assert created.kind.value == "blogpost"


@pytest.mark.asyncio
async def test_invalid_wire_error_does_not_retain_response_body() -> None:
    sentinel = "SECRET-BODY-SENTINEL-42"

    def handler(request: httpx.Request) -> httpx.Response:
        del request
        wire = _content("456")
        wire["version"] = {"number": sentinel}
        wire["body"] = {"storage": {"value": f"<p>{sentinel}</p>", "representation": "storage"}}
        return httpx.Response(200, json=wire)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(ValidationError) as captured:
            await client.get_content("456")
    finally:
        await client.close()

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert sentinel not in _exception_graph_text(captured.value)


@pytest.mark.asyncio
async def test_transport_error_does_not_retain_authorization_request() -> None:
    secret = "PAT-SECRET-SENTINEL-99"

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("Connection failed", request=request)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth(secret),
        transport=httpx.MockTransport(handler),
    )
    try:
        with pytest.raises(TransportError) as captured:
            await client.preflight("123")
    finally:
        await client.close()

    assert captured.value.__cause__ is None
    assert captured.value.__context__ is None
    assert secret not in _exception_graph_text(captured.value)


@pytest.mark.asyncio
@pytest.mark.parametrize("failure", ["oversized", "compressed", "cancelled"])
async def test_mutation_response_loss_is_classified_as_ambiguous(failure: str) -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        if request.method != "POST":
            raise AssertionError(f"Unexpected request: {request.method} {request.url}")
        if failure == "cancelled":
            raise asyncio.CancelledError
        if failure == "compressed":
            return httpx.Response(
                200,
                content=b"compressed-response",
                headers={"Content-Encoding": "gzip"},
            )
        return httpx.Response(200, content=b"x" * 2048)

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
        response_limit_bytes=1024,
    )
    _prime_target(client)
    try:
        with pytest.raises(AmbiguousWriteError):
            await client.create_content(
                title="News",
                content_type="blogpost",
                space_key="DOCS",
                parent_id=None,
                storage_value="<p>News</p>",
            )
    finally:
        await client.close()


@pytest.mark.asyncio
async def test_successful_create_with_invalid_readback_remains_ambiguous() -> None:
    sentinel = "CREATE-RESPONSE-SECRET-SENTINEL"

    def handler(request: httpx.Request) -> httpx.Response:
        if request.method != "POST":
            raise AssertionError(f"Unexpected request: {request.method} {request.url}")
        return httpx.Response(200, json={"id": "456", "unexpected": sentinel})

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    _prime_target(client)
    try:
        with pytest.raises(AmbiguousWriteError) as captured:
            await client.create_content(
                title="News",
                content_type="blogpost",
                space_key="DOCS",
                parent_id=None,
                storage_value="<p>News</p>",
            )
    finally:
        await client.close()
    assert captured.value.__context__ is None
    assert sentinel not in _exception_graph_text(captured.value)


@pytest.mark.asyncio
async def test_owned_content_search_paginates_and_filters_by_marker() -> None:
    requests: list[httpx.Request] = []

    def marker_property() -> dict[str, object]:
        return {
            "key": "markdown-confluence.publisher",
            "value": {
                "schema": 1,
                "managed": True,
                "publisher": "md2conf-dc",
                "vault_id": "a76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83",
                "source_id": "dc3e7bc5-0832-44f1-9132-c80cb50a8250",
                "source_kind": "note",
                "source_path": "page.md",
                "root_page_id": "123",
                "space_key": "DOCS",
                "managed_labels": [],
                "last_render_sha256": "a" * 64,
                "last_run_id": "previous",
            },
            "version": {"number": 1},
        }

    def handler(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        path = request.url.path
        if path.endswith("/settings/systemInfo"):
            return httpx.Response(200, json={"version": "9.2.4", "buildNumber": "9204"})
        if path.endswith("/user/current"):
            return httpx.Response(200, json={"username": "publisher"})
        if path.endswith("/content/search"):
            if request.url.params.get("start") == "1":
                return httpx.Response(
                    200,
                    json={
                        "results": [{"id": "457"}],
                        "start": 1,
                        "limit": 100,
                        "size": 1,
                        "_links": {},
                    },
                )
            return httpx.Response(
                200,
                json={
                    "results": [{"id": "456"}],
                    "start": 0,
                    "limit": 1,
                    "size": 1,
                    "_links": {"next": "/confluence/rest/api/content/search?start=1&limit=100"},
                },
            )
        if path.endswith("/content/123"):
            return httpx.Response(200, json=_content("123"))
        if path.endswith("/content/456"):
            value = _content("456")
            value["ancestors"] = [{"id": "123"}]
            return httpx.Response(200, json=value)
        if path.endswith("/content/457"):
            value = _content("457")
            value["ancestors"] = [{"id": "123"}]
            return httpx.Response(200, json=value)
        if path.endswith("/content/456/property/markdown-confluence.publisher"):
            return httpx.Response(200, json=marker_property())
        if path.endswith("/content/457/property/markdown-confluence.publisher"):
            return httpx.Response(404, json={"statusCode": 404})
        raise AssertionError(f"Unexpected request: {request.method} {request.url}")

    client = ConfluenceClient(
        "https://confluence.example.test/confluence",
        BearerAuth("token"),
        transport=httpx.MockTransport(handler),
    )
    try:
        await client.preflight("123")
        owned = [
            item
            async for item in client.find_owned_content(
                vault_id="a76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83",
                root_page_id="123",
            )
        ]
    finally:
        await client.close()
    assert [item.content_id for item in owned] == ["456"]
    search_requests = [item for item in requests if item.url.path.endswith("/content/search")]
    assert len(search_requests) == 2
    assert 'space = "DOCS"' in search_requests[0].url.params["cql"]
    assert "expand" not in search_requests[0].url.params
    assert not any(
        item.url.path.endswith("/content/457")
        and not item.url.path.endswith("/property/markdown-confluence.publisher")
        for item in requests
    )


def test_context_url_and_retry_contracts() -> None:
    base = ConfluenceBaseUrl.parse("https://example.test/confluence")
    assert base.rest("/rest/api/content/1") == (
        "https://example.test/confluence/rest/api/content/1"
    )
    assert base.resolve_same_context("/rest/api/content?start=25") == (
        "https://example.test/confluence/rest/api/content?start=25"
    )
    assert classify_status("GET", 429).retryable
    assert classify_status("POST", 503).ambiguous
    assert (
        retry_delay(
            RetryPolicy(max_attempts=2, base_delay_seconds=1, max_delay_seconds=10),
            attempt=1,
            retry_after="7",
            random_source=_constant(0.5),
        )
        == 7
    )


def _constant(value: float) -> Callable[[], float]:
    return lambda: value
