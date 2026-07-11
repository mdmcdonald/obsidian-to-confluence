from __future__ import annotations

import asyncio
import struct
from collections.abc import AsyncIterator, Sequence
from dataclasses import replace
from datetime import UTC, datetime
from pathlib import Path

import pytest

from md2conf_dc.api import (
    Publisher,
    PublisherBusyError,
    PublisherDependencies,
    SyncPublisher,
    load_publisher_config,
    render_document,
)
from md2conf_dc.assets.cache import initialize_managed_cache_root
from md2conf_dc.config import PublisherConfig
from md2conf_dc.events import EventSink, PublishEvent
from md2conf_dc.executor import PlanStaleError
from md2conf_dc.models import (
    AssetSpec,
    ContentKind,
    OperationKind,
    OwnershipMarker,
    PlanApproval,
    RemoteContent,
    RenderContext,
    Selection,
    TargetIdentity,
)
from md2conf_dc.ownership import MutationExpectation, assert_mutation_expectation
from md2conf_dc.render.xml import storage_sha256
from md2conf_dc.serialization import dumps
from md2conf_dc.state.store import JsonStateStore


class RecordingSink(EventSink):
    def __init__(self) -> None:
        self.events: list[PublishEvent] = []

    async def emit(self, event: PublishEvent) -> None:
        self.events.append(event)


class ApplicationGateway:
    supports_guarded_mutations = True

    def __init__(self) -> None:
        self.contents: dict[str, RemoteContent] = {}
        self.asset_sources: list[Path] = []
        self.closed = False

    async def preflight(self, parent_page_id: str) -> TargetIdentity:
        assert parent_page_id == "123"
        return TargetIdentity(
            base_url="https://confluence.example.test/confluence",
            server_version="9.2.4",
            server_build="9204",
            space_key="DOCS",
            root_page_id="123",
            current_user="publisher",
            fingerprint="target-fingerprint",
        )

    async def get_content(self, content_id: str) -> RemoteContent:
        return self.contents[content_id]

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
        if parent_expectation is not None and parent_id is not None:
            assert_mutation_expectation(self.contents[parent_id], parent_expectation)
        content_id = str(1000 + len(self.contents))
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
        if parent_expectation is not None and parent_id is not None:
            assert_mutation_expectation(self.contents[parent_id], parent_expectation)
        updated = replace(
            content,
            title=title,
            direct_parent_id=parent_id,
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

    async def trash_content(
        self,
        content_id: str,
        *,
        expectation: MutationExpectation,
    ) -> None:
        assert_mutation_expectation(self.contents[content_id], expectation)
        self.contents.pop(content_id)

    async def close(self) -> None:
        self.closed = True


class BlockingGateway(ApplicationGateway):
    def __init__(self) -> None:
        super().__init__()
        self.started = asyncio.Event()
        self.release = asyncio.Event()

    async def preflight(self, parent_page_id: str) -> TargetIdentity:
        self.started.set()
        await self.release.wait()
        return await super().preflight(parent_page_id)


class FailingCloseGateway(ApplicationGateway):
    async def close(self) -> None:
        self.closed = True
        raise RuntimeError("gateway close failed")


class ConstructionFailPublisher(Publisher):
    def __init__(self, *args: object, **kwargs: object) -> None:
        del args, kwargs
        raise RuntimeError("publisher construction failed")


class FakeMermaidRenderer:
    def __init__(self) -> None:
        self.calls: list[tuple[str, float, Path]] = []
        self.active = 0
        self.max_active = 0

    @property
    def identity(self) -> str:
        return "fake-api-mermaid-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        self.calls.append((source, scale, destination))
        self.active += 1
        self.max_active = max(self.max_active, self.active)
        try:
            await asyncio.sleep(0)
            destination.write_bytes(
                b"\x89PNG\r\n\x1a\n"
                + struct.pack(">I", 13)
                + b"IHDR"
                + struct.pack(">II", 40, 20)
                + b"\x08\x06\x00\x00\x00"
            )
        finally:
            self.active -= 1


class FailingMermaidRenderer:
    @property
    def identity(self) -> str:
        return "failing-api-mermaid-v1"

    async def render(self, source: str, *, scale: float, destination: Path) -> None:
        del scale, destination
        if "slow" in source:
            await asyncio.sleep(0.01)
        raise RuntimeError(source.strip())


def _config(tmp_path: Path) -> PublisherConfig:
    config_path = tmp_path / ".md2conf.toml"
    config_path.write_text(
        """
[profiles.default.confluence]
base_url = "https://confluence.example.test/confluence"
parent_page_id = "123"
auth = "pat"

[profiles.default.source]
vault_root = "."
publish_root = "."
first_heading_page_title = true

[profiles.default.state]
path = ".md2conf/state.json"
cache_dir = ".md2conf/cache"
""",
        encoding="utf-8",
    )
    return load_publisher_config(config_path)


@pytest.mark.asyncio
async def test_publisher_drives_validate_plan_publish_and_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "Guide.md").write_text(
        "---\nsubject: Architecture\nstatus: Approved\n---\n# Final Guide\n\nHello **team**.\n",
        encoding="utf-8",
    )
    gateway = ApplicationGateway()
    sink = RecordingSink()
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(gateway=gateway, event_sink=sink),
    )
    async with publisher:
        doctor = await publisher.doctor()
        assert doctor.ok
        validation = await publisher.validate()
        assert validation.ok
        assert [page.final_title for page in validation.pages] == ["Final Guide"]
        assert "<h1" not in validation.pages[0].storage_value
        assert 'ac:name="details"' in validation.pages[0].storage_value
        assert validation.pages[0].labels == ("architecture",)

        plan = await publisher.plan(Selection.all())
        assert plan.operations
        serialized_plan = dumps(plan)
        assert "storage_value" not in serialized_plan
        assert "Hello **team**" not in serialized_plan
        report = await publisher.publish(plan)
        assert report.succeeded
        written_back = (tmp_path / "Guide.md").read_text(encoding="utf-8")
        assert "connie-source-id:" in written_back
        assert "connie-page-id:" in written_back
        second = await publisher.plan()
        assert [operation.kind for operation in second.operations] == [OperationKind.READBACK]
        assert (await publisher.publish(second)).succeeded

    assert sink.events[0].message == "Checking Confluence connection"
    assert any(event.message == "Publish run finished" for event in sink.events)
    assert gateway.closed is False  # injected dependencies remain caller-owned


@pytest.mark.asyncio
async def test_render_document_is_local_and_typed(tmp_path: Path) -> None:
    note = tmp_path / "note.md"
    note.write_text("---\nconnie-title: Custom\ntags: [One, Two]\n---\nBody", encoding="utf-8")
    result = await render_document(note, context=RenderContext(tmp_path))
    assert result.page.final_title == "Custom"
    assert result.page.labels == ("one", "two")
    assert result.page.storage_value == "<p>Body</p>"


@pytest.mark.asyncio
async def test_publisher_prepares_mermaid_assets_through_injected_renderer(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "diagrams.md").write_text(
        "~~~mermaid\ngraph TD; A-->B\n~~~\n\n"
        "~~~mermaid\ngraph TD; C-->D\n~~~\n\n"
        "~~~mermaid\ngraph TD; E-->F\n~~~\n\n"
        "~~~mermaid\ngraph TD; A-->B\n~~~\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    backend = FakeMermaidRenderer()
    gateway = ApplicationGateway()
    config = _config(tmp_path)
    initialize_managed_cache_root(config.state.cache_dir)
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(
            gateway=gateway,
            mermaid_renderer=backend,
        ),
    )

    async with publisher:
        validation = await publisher.validate()
        plan = await publisher.plan()
        report = await publisher.publish(plan)

    assert validation.ok
    assert len(validation.pages) == 1
    page = validation.pages[0]
    assert len(page.assets) == 3
    assert page.storage_value.count('ac:image ac:alt="Mermaid diagram"') == 4
    assert "MERMAID_RENDER_REQUIRED" not in {
        diagnostic.code for diagnostic in validation.diagnostics
    }
    assert len(backend.calls) == 3
    assert backend.max_active == 2
    assert {scale for _, scale, _ in backend.calls} == {2.0}
    assert all(
        destination.parent == tmp_path / ".md2conf" / "cache" / "mermaid"
        for _, _, destination in backend.calls
    )
    assert report.succeeded
    assert len(gateway.asset_sources) == 3
    assert all(
        source.is_file() and source.parent == tmp_path / ".md2conf" / "cache" / "mermaid"
        for source in gateway.asset_sources
    )


@pytest.mark.asyncio
async def test_publisher_without_mermaid_renderer_fails_visibly(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "diagram.md").write_text(
        "~~~mermaid\ngraph TD; A-->B\n~~~\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    publisher = await Publisher.create(_config(tmp_path), offline=True)

    async with publisher:
        validation = await publisher.validate()

    assert not validation.ok
    assert "MERMAID_RENDER_REQUIRED" in {diagnostic.code for diagnostic in validation.diagnostics}


@pytest.mark.asyncio
async def test_publisher_maps_standard_mermaid_quality_to_medium_scale(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "diagram.md").write_text(
        "~~~mermaid\ngraph TD; A-->B\n~~~\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    config = config.model_copy(
        update={"render": config.render.model_copy(update={"mermaid_quality": "standard"})}
    )
    initialize_managed_cache_root(config.state.cache_dir)
    backend = FakeMermaidRenderer()
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(mermaid_renderer=backend),
        offline=True,
    )

    async with publisher:
        assert (await publisher.validate()).ok

    assert {scale for _, scale, _ in backend.calls} == {1.5}


@pytest.mark.asyncio
async def test_mermaid_failures_are_reported_in_source_order(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "a.md").write_text(
        "~~~mermaid\ngraph slow\n~~~\n",
        encoding="utf-8",
    )
    (tmp_path / "b.md").write_text(
        "~~~mermaid\ngraph fast\n~~~\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    initialize_managed_cache_root(config.state.cache_dir)
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(mermaid_renderer=FailingMermaidRenderer()),
        offline=True,
    )

    async with publisher:
        validation = await publisher.validate()

    failures = [
        diagnostic
        for diagnostic in validation.diagnostics
        if diagnostic.code == "MERMAID_RENDER_FAILED"
    ]
    assert [diagnostic.span.path.name for diagnostic in failures if diagnostic.span] == [
        "a.md",
        "b.md",
    ]


@pytest.mark.asyncio
async def test_mermaid_renderer_refuses_an_unmanaged_cache_root(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "diagram.md").write_text(
        "~~~mermaid\ngraph TD; A-->B\n~~~\n",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    backend = FakeMermaidRenderer()
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(mermaid_renderer=backend),
        offline=True,
    )

    async with publisher:
        validation = await publisher.validate()

    assert "MERMAID_CACHE_UNMANAGED" in {diagnostic.code for diagnostic in validation.diagnostics}
    assert backend.calls == []
    assert not config.state.cache_dir.exists()


def test_sync_publisher_uses_one_runner_and_closes(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "note.md").write_text("Body", encoding="utf-8")
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    gateway = ApplicationGateway()
    with SyncPublisher.create(
        _config(tmp_path),
        dependencies=PublisherDependencies(gateway=gateway),
    ) as publisher:
        assert publisher.doctor().ok
        assert publisher.validate().ok
    assert gateway.closed is False


@pytest.mark.asyncio
async def test_publisher_create_rolls_back_owned_resources_on_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    gateway = ApplicationGateway()

    def gateway_factory(*args: object, **kwargs: object) -> ApplicationGateway:
        del args, kwargs
        return gateway

    monkeypatch.setattr("md2conf_dc.api.ConfluenceClient", gateway_factory)
    with pytest.raises(RuntimeError, match="publisher construction failed"):
        await ConstructionFailPublisher.create(config)

    assert gateway.closed
    reopened = JsonStateStore.open(config.state.path)
    reopened.close()


@pytest.mark.asyncio
async def test_publisher_close_finishes_cleanup_after_gateway_failure(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    gateway = FailingCloseGateway()
    sink = RecordingSink()

    def gateway_factory(*args: object, **kwargs: object) -> FailingCloseGateway:
        del args, kwargs
        return gateway

    monkeypatch.setattr("md2conf_dc.api.ConfluenceClient", gateway_factory)
    publisher = await Publisher.create(
        config,
        dependencies=PublisherDependencies(event_sink=sink),
    )
    assert (await publisher.doctor()).ok

    with pytest.raises(RuntimeError, match="gateway close failed"):
        await publisher.close()

    assert gateway.closed
    assert [event.message for event in sink.events] == [
        "Checking Confluence connection",
        "Connection check passed",
    ]
    reopened = JsonStateStore.open(config.state.path)
    reopened.close()
    await publisher.close()
    with pytest.raises(RuntimeError, match="Publisher is closed"):
        await publisher.validate()


def test_sync_publisher_closes_runner_when_async_cleanup_fails(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    gateway = FailingCloseGateway()

    def gateway_factory(*args: object, **kwargs: object) -> FailingCloseGateway:
        del args, kwargs
        return gateway

    monkeypatch.setattr("md2conf_dc.api.ConfluenceClient", gateway_factory)
    publisher = SyncPublisher.create(_config(tmp_path))

    with pytest.raises(RuntimeError, match="gateway close failed"):
        publisher.close()

    with pytest.raises(RuntimeError, match="Runner is closed"):
        publisher._runner.get_loop()


@pytest.mark.asyncio
async def test_sync_publisher_refuses_nested_event_loop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    with pytest.raises(RuntimeError, match="running event loop"):
        SyncPublisher.create(
            _config(tmp_path),
            dependencies=PublisherDependencies(gateway=ApplicationGateway()),
        )


@pytest.mark.asyncio
async def test_selected_plan_is_narrow_but_detects_corpus_drift(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    first = tmp_path / "first.md"
    second = tmp_path / "second.md"
    first.write_text("Link to [[second]].", encoding="utf-8")
    second.write_text("Second", encoding="utf-8")
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    publisher = await Publisher.create(
        _config(tmp_path),
        dependencies=PublisherDependencies(gateway=ApplicationGateway()),
    )
    async with publisher:
        validation = await publisher.validate()
        first_page = next(
            page for page in validation.pages if page.identity.relative_path == "first.md"
        )
        assert 'ri:content-title="second"' in first_page.storage_value
        plan = await publisher.plan(Selection.selected((first,)))
        assert {page.identity.relative_path for page in plan.page_specs.values()} == {"first.md"}
        second.write_text("Changed after planning", encoding="utf-8")
        with pytest.raises(PlanStaleError, match="Source inputs changed"):
            await publisher.publish(plan)


@pytest.mark.asyncio
async def test_publish_rejects_tampered_page_body_even_when_digest_is_unchanged(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "note.md").write_text("Original body", encoding="utf-8")
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    publisher = await Publisher.create(
        _config(tmp_path),
        dependencies=PublisherDependencies(gateway=ApplicationGateway()),
    )
    async with publisher:
        plan = await publisher.plan()
        source_id, page = next(iter(plan.page_specs.items()))
        tampered = replace(page, storage_value="<p>Tampered body</p>")
        tampered_plan = replace(plan, page_specs={source_id: tampered})
        with pytest.raises(PlanStaleError, match="declared hash"):
            await publisher.publish(tampered_plan)


@pytest.mark.asyncio
async def test_durable_scope_change_blocks_before_remote_planning(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    (tmp_path / "note.md").write_text("Body", encoding="utf-8")
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    config = _config(tmp_path)
    first = await Publisher.create(
        config,
        dependencies=PublisherDependencies(gateway=ApplicationGateway()),
    )
    async with first:
        plan = await first.plan()
        report = await first.publish(plan)
        assert report.succeeded

    (tmp_path / "Docs").mkdir()
    config_path = tmp_path / ".md2conf.toml"
    config_path.write_text(
        config_path.read_text(encoding="utf-8").replace(
            'publish_root = "."', 'publish_root = "Docs"'
        ),
        encoding="utf-8",
    )
    changed = await Publisher.create(load_publisher_config(config_path), offline=True)
    async with changed:
        validation = await changed.validate()
    assert any(item.code == "STATE_SCOPE_CHANGED" for item in validation.diagnostics)


@pytest.mark.asyncio
async def test_adoption_plan_requires_digest_and_never_updates_body(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    note = tmp_path / "adopt.md"
    note.write_text(
        "---\nconnie-page-id: '700'\n---\nLocal replacement body",
        encoding="utf-8",
    )
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    gateway = ApplicationGateway()
    remote_storage = "<p>Keep this remote body</p>"
    gateway.contents["700"] = RemoteContent(
        content_id="700",
        kind=ContentKind.PAGE,
        status="current",
        title="Existing",
        space_key="DOCS",
        direct_parent_id="123",
        ancestor_ids=("123",),
        version=4,
        storage_value=remote_storage,
        storage_sha256=storage_sha256(remote_storage),
        ownership=None,
        ownership_property_version=None,
    )
    publisher = await Publisher.create(
        _config(tmp_path),
        dependencies=PublisherDependencies(gateway=gateway),
    )
    async with publisher:
        ordinary = await publisher.validate(Selection.selected((note,)))
        assert not ordinary.ok
        assert any(item.code == "FRONTMATTER_PAGE_ID_UNVERIFIED" for item in ordinary.diagnostics)
        plan = await publisher.plan_adoption(note, "700")
        assert [operation.kind.value for operation in plan.operations] == ["adopt_page"]
        approval = PlanApproval(
            plan.plan_id,
            plan.digest,
            datetime.now(UTC),
            "operator",
        )
        report = await publisher.publish(plan, approval=approval)
        assert report.succeeded
    assert gateway.contents["700"].storage_value == remote_storage
    assert gateway.contents["700"].ownership is not None


@pytest.mark.asyncio
async def test_publisher_rejects_overlapping_operations_before_more_work(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    (tmp_path / "note.md").write_text("Body", encoding="utf-8")
    monkeypatch.setenv("MD2CONF_PAT", "test-token")
    gateway = BlockingGateway()
    publisher = await Publisher.create(
        _config(tmp_path),
        dependencies=PublisherDependencies(gateway=gateway),
    )
    planning = asyncio.create_task(publisher.plan())
    await gateway.started.wait()
    assert publisher.busy
    with pytest.raises(PublisherBusyError):
        await publisher.validate()
    gateway.release.set()
    await planning
    await publisher.close()
