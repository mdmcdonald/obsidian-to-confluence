"""GUI-ready application facade.

`Publisher` is the sole orchestration surface used by the CLI.  A future GUI should
instantiate the same class, subscribe to :meth:`Publisher.events`, and pass a
`CancellationToken` for long-running work.  No method writes to stdout or requires a
terminal.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import uuid
from collections.abc import AsyncIterator, Iterator, Mapping, Sequence
from contextlib import asynccontextmanager
from dataclasses import dataclass, replace
from inspect import isawaitable
from pathlib import Path
from types import MappingProxyType
from typing import Self

from md2conf_dc.assets.cache import (
    CacheSafetyError,
    prepare_managed_cache_child,
    require_managed_cache_root,
)
from md2conf_dc.assets.images import ImageOptions
from md2conf_dc.assets.mermaid import (
    MermaidOptions,
    MermaidQuality,
    MermaidResult,
    MermaidService,
)
from md2conf_dc.config import PublisherConfig, load_config
from md2conf_dc.confluence.client import (
    BasicAuth,
    BearerAuth,
    ConfluenceClient,
    ConfluenceTimeouts,
)
from md2conf_dc.confluence.retry import RetryPolicy
from md2conf_dc.discovery import DiscoveryResult, discover_sources
from md2conf_dc.events import CompositeEventSink, EventBus, EventKind, EventSink, PublishEvent
from md2conf_dc.executor import PlanExecutor, PlanStaleError
from md2conf_dc.frontmatter import parse_frontmatter, write_identity_frontmatter
from md2conf_dc.hierarchy import build_hierarchy
from md2conf_dc.index import CorpusIndex, build_index, build_managed_labels
from md2conf_dc.interfaces import ConfluenceGateway, MermaidRenderer, StateStore
from md2conf_dc.markdown.ir import (
    Block,
    BlockQuote,
    Callout,
    CodeBlock,
    Directive,
    ListBlock,
    TaskList,
)
from md2conf_dc.markdown.parser import parse_markdown
from md2conf_dc.models import (
    AssetSpec,
    CancellationToken,
    ContentKind,
    Diagnostic,
    DoctorReport,
    OperationKind,
    OutcomeStatus,
    PageSpec,
    PlanApproval,
    PublishPlan,
    PublishReport,
    RenderContext,
    RenderedPage,
    Selection,
    Severity,
    SourceDocument,
    SourceIdentity,
    SourceKind,
    SourceSpan,
    TargetIdentity,
    ValidationReport,
)
from md2conf_dc.planner import OrphanAction, RemotePlanner
from md2conf_dc.render import MetadataField, MetadataValue
from md2conf_dc.render.storage import (
    InternalLinkReference,
    LatexCapability,
    MathFallbackPolicy,
    MathOptions,
    RawHtmlPolicy,
    ResolvedAssetSource,
    ResolvedInternalLink,
    StorageOptions,
    TocMode,
    UnresolvedLinkPolicy,
    render_markdown,
)
from md2conf_dc.render.xml import storage_sha256
from md2conf_dc.secrets import SecretResolver
from md2conf_dc.state.models import StateTarget
from md2conf_dc.state.store import JsonStateStore

_ALL_SELECTION = Selection.all()


@dataclass(frozen=True, slots=True)
class PublisherDependencies:
    """Embedding overrides; Mermaid rendering requires an approved injected backend."""

    gateway: ConfluenceGateway | None = None
    state: StateStore | None = None
    event_sink: EventSink | None = None
    mermaid_renderer: MermaidRenderer | None = None


@dataclass(frozen=True, slots=True)
class _MermaidRequest:
    key: str
    source: str
    span: SourceSpan


@dataclass(frozen=True, slots=True)
class _PreparedMermaid:
    assets: Mapping[str, AssetSpec]
    sources: Mapping[str, Path]
    diagnostics: tuple[Diagnostic, ...]


def _empty_prepared_mermaid() -> _PreparedMermaid:
    return _PreparedMermaid(MappingProxyType({}), MappingProxyType({}), ())


def _collect_mermaid_requests(
    documents: Sequence[SourceDocument],
) -> tuple[_MermaidRequest, ...]:
    requests: dict[str, _MermaidRequest] = {}
    for document in sorted(documents, key=lambda item: item.identity.relative_path):
        parsed = parse_markdown(document.body, path=document.absolute_path)
        for block in _walk_blocks(parsed.document.blocks):
            if not isinstance(block, CodeBlock) or not block.fenced:
                continue
            if (block.language or "").casefold() != "mermaid":
                continue
            key = hashlib.sha256(block.value.encode("utf-8")).hexdigest()
            requests.setdefault(key, _MermaidRequest(key, block.value, block.span))
    return tuple(requests.values())


def _walk_blocks(blocks: Sequence[Block]) -> Iterator[Block]:
    for block in blocks:
        yield block
        if isinstance(block, BlockQuote):
            yield from _walk_blocks(block.children)
        elif isinstance(block, (Callout, Directive)):
            yield from _walk_blocks(block.body)
        elif isinstance(block, (ListBlock, TaskList)):
            for item in block.items:
                yield from _walk_blocks(item.children)


def _merge_asset_sources(
    target: dict[str, Path],
    sources: Sequence[ResolvedAssetSource],
    diagnostics: list[Diagnostic],
) -> None:
    for source in sources:
        previous = target.get(source.asset_id)
        if previous is None:
            target[source.asset_id] = source.path
        elif previous != source.path:
            diagnostics.append(
                Diagnostic(
                    "ASSET_SOURCE_CONFLICT",
                    Severity.ERROR,
                    f"Asset {source.asset_id} resolved to conflicting local sources.",
                )
            )


def _build_gateway(
    config: PublisherConfig,
    dependencies: PublisherDependencies,
    *,
    offline: bool,
    event_sink: EventSink,
) -> tuple[ConfluenceGateway | None, bool]:
    if dependencies.gateway is not None:
        return dependencies.gateway, False
    if offline:
        return None, False

    confluence = config.confluence
    auth: BearerAuth | BasicAuth
    if confluence.auth == "pat":
        if confluence.pat is None:
            raise ValueError("PAT authentication was selected but no PAT was resolved")
        auth = BearerAuth(confluence.pat.reveal())
    else:
        if confluence.username is None or confluence.password is None:
            raise ValueError(
                "Basic authentication was selected but username/password is incomplete"
            )
        auth = BasicAuth(confluence.username, confluence.password.reveal())
    return (
        ConfluenceClient(
            confluence.base_url,
            auth,
            expected_release=confluence.target_release,
            verify_tls=confluence.verify_tls,
            timeouts=ConfluenceTimeouts(
                connect_seconds=confluence.connect_timeout_seconds,
                read_seconds=confluence.read_timeout_seconds,
                write_seconds=confluence.write_timeout_seconds,
                pool_seconds=confluence.pool_timeout_seconds,
            ),
            retry_policy=RetryPolicy(
                max_attempts=config.publish.retry_attempts,
                max_delay_seconds=config.publish.retry_cap_seconds,
            ),
            event_sink=event_sink,
        ),
        True,
    )


async def _close_event_sink(event_sink: EventSink) -> None:
    close = getattr(event_sink, "close", None)
    if not callable(close):
        return
    result = close()
    if isawaitable(result):
        await result


async def _cleanup_resources(
    *,
    gateway: ConfluenceGateway | None,
    owns_gateway: bool,
    state: StateStore | None,
    owns_state: bool,
    event_sink: EventSink,
    event_bus: EventBus,
) -> list[BaseException]:
    errors: list[BaseException] = []
    if owns_gateway and gateway is not None:
        try:
            await gateway.close()
        except BaseException as exc:
            errors.append(exc)
    if owns_state and state is not None:
        try:
            state.close()
        except BaseException as exc:
            errors.append(exc)
    try:
        await _close_event_sink(event_sink)
    except BaseException as exc:
        errors.append(exc)
    try:
        await event_bus.close()
    except BaseException as exc:
        errors.append(exc)
    return errors


def _raise_cleanup_errors(message: str, errors: Sequence[BaseException]) -> None:
    if not errors:
        return
    if len(errors) == 1:
        raise errors[0]
    raise BaseExceptionGroup(message, list(errors))


@dataclass(frozen=True, slots=True)
class _PreparedCorpus:
    pages: tuple[PageSpec, ...]
    diagnostics: tuple[Diagnostic, ...]
    asset_sources: Mapping[str, Path]
    source_set_sha256: str
    scope_fingerprint: str


@dataclass(frozen=True, slots=True)
class _CorpusLinkResolver:
    corpus: CorpusIndex
    vault_root: Path

    @property
    def identity(self) -> str:
        value = json.dumps(
            dict(sorted(self.corpus.final_titles.items())),
            ensure_ascii=False,
            sort_keys=True,
            separators=(",", ":"),
        )
        return f"corpus-index-v1:{hashlib.sha256(value.encode()).hexdigest()}"

    def resolve(self, reference: InternalLinkReference) -> ResolvedInternalLink | None:
        try:
            relative_source = reference.source_path.resolve(strict=False).relative_to(
                self.vault_root
            )
        except ValueError:
            return None
        source_id = self.corpus.path_to_source_id.get(relative_source.as_posix())
        if source_id is None:
            return None
        target = reference.target
        if reference.heading is not None:
            target = f"{target}#{reference.heading}"
        elif reference.block_id is not None:
            target = f"{target}#^{reference.block_id}"
        resolution = self.corpus.resolve_link(source_id, target)
        link = resolution.link
        if link.target_source_id is None or link.target_title is None:
            return None
        anchor = reference.block_id or reference.heading or link.anchor
        return ResolvedInternalLink(link.target_title, anchor)


class PublisherBusyError(RuntimeError):
    """Raised before work starts when this facade already owns an operation."""


class Publisher:
    """Typed asynchronous application service shared by every frontend."""

    def __init__(
        self,
        config: PublisherConfig,
        *,
        gateway: ConfluenceGateway | None,
        state: StateStore,
        event_bus: EventBus,
        event_sink: EventSink,
        mermaid_renderer: MermaidRenderer | None,
        owns_gateway: bool,
        owns_state: bool,
    ) -> None:
        self.config = config
        self._gateway = gateway
        self._state = state
        self._event_bus = event_bus
        self._event_sink = event_sink
        self._mermaid_renderer = mermaid_renderer
        self._owns_gateway = owns_gateway
        self._owns_state = owns_state
        self._closed = False
        self._operation_lock = asyncio.Lock()

    @property
    def busy(self) -> bool:
        return self._operation_lock.locked()

    @asynccontextmanager
    async def _exclusive_operation(self, name: str) -> AsyncIterator[None]:
        if self._closed:
            raise RuntimeError("Publisher is closed")
        if self._operation_lock.locked():
            raise PublisherBusyError(f"Cannot start {name}; another Publisher operation is active")
        await self._operation_lock.acquire()
        try:
            yield
        finally:
            self._operation_lock.release()

    @classmethod
    async def create(
        cls,
        config: PublisherConfig,
        *,
        dependencies: PublisherDependencies | None = None,
        offline: bool = False,
    ) -> Publisher:
        dependencies = dependencies or PublisherDependencies()
        event_bus = EventBus()
        sink: EventSink
        if dependencies.event_sink is None:
            sink = event_bus
        else:
            sink = CompositeEventSink(event_bus, dependencies.event_sink)

        owns_state = dependencies.state is None
        state: StateStore | None = None
        gateway: ConfluenceGateway | None = None
        owns_gateway = False
        try:
            state = (
                JsonStateStore.open(
                    config.state.path,
                    lock_timeout=config.state.lock_timeout_seconds,
                )
                if dependencies.state is None
                else dependencies.state
            )
            gateway, owns_gateway = _build_gateway(
                config,
                dependencies,
                offline=offline,
                event_sink=sink,
            )
            return cls(
                config,
                gateway=gateway,
                state=state,
                event_bus=event_bus,
                event_sink=sink,
                mermaid_renderer=dependencies.mermaid_renderer,
                owns_gateway=owns_gateway,
                owns_state=owns_state,
            )
        except BaseException as exc:
            cleanup_errors = await _cleanup_resources(
                gateway=gateway,
                owns_gateway=owns_gateway,
                state=state,
                owns_state=owns_state,
                event_sink=sink,
                event_bus=event_bus,
            )
            if cleanup_errors:
                raise BaseExceptionGroup(
                    "Publisher construction and cleanup both failed",
                    [exc, *cleanup_errors],
                ) from exc
            raise

    async def __aenter__(self) -> Publisher:
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        await self.close()

    async def close(self) -> None:
        if self._closed:
            return
        if self.busy:
            raise PublisherBusyError("Cannot close Publisher while an operation is active")
        await self._operation_lock.acquire()
        errors: list[BaseException] = []
        try:
            errors = await _cleanup_resources(
                gateway=self._gateway,
                owns_gateway=self._owns_gateway,
                state=self._state,
                owns_state=self._owns_state,
                event_sink=self._event_sink,
                event_bus=self._event_bus,
            )
        finally:
            self._closed = True
            self._operation_lock.release()
        _raise_cleanup_errors("Publisher cleanup failed", errors)

    async def events(self) -> AsyncIterator[PublishEvent]:
        async for event in self._event_bus.subscribe():
            yield event

    async def doctor(self) -> DoctorReport:
        async with self._exclusive_operation("connection check"):
            return await self._doctor_unlocked()

    async def _doctor_unlocked(self) -> DoctorReport:
        run_id = str(uuid.uuid4())
        await self._event_sink.emit(
            PublishEvent(EventKind.RUN_STARTED, run_id, "Checking Confluence connection")
        )
        if self._gateway is None:
            diagnostic = Diagnostic(
                "CONFLUENCE_OFFLINE",
                Severity.ERROR,
                "This Publisher was created for offline validation",
            )
            return DoctorReport(None, (*self.config.diagnostics, diagnostic))
        try:
            target = await self._gateway.preflight(self.config.confluence.parent_page_id)
            report = DoctorReport(target, self.config.diagnostics)
        except Exception as exc:
            diagnostic = Diagnostic("CONFLUENCE_PREFLIGHT", Severity.ERROR, str(exc))
            report = DoctorReport(None, (*self.config.diagnostics, diagnostic))
        await self._event_sink.emit(
            PublishEvent(
                EventKind.RUN_FINISHED,
                run_id,
                "Connection check passed" if report.ok else "Connection check failed",
                outcome="success" if report.ok else "failed",
            )
        )
        return report

    def _vault_id(self) -> str:
        vault_id = getattr(self._state, "vault_id", None)
        return vault_id if isinstance(vault_id, str) else str(uuid.uuid4())

    def _discover(self, selection: Selection, *, vault_id: str) -> DiscoveryResult:
        return discover_sources(
            self.config.source,
            vault_id=vault_id,
            state=self._state if isinstance(self._state, JsonStateStore) else None,
            selection=selection,
        )

    def _prepare(
        self,
        selection: Selection,
        *,
        allow_unverified_page_ids: bool = False,
        vault_id: str | None = None,
        discovery: DiscoveryResult | None = None,
        mermaid: _PreparedMermaid | None = None,
    ) -> _PreparedCorpus:
        vault_id = vault_id or self._vault_id()
        discovery = discovery or self._discover(selection, vault_id=vault_id)
        mermaid = mermaid or _empty_prepared_mermaid()
        hierarchy = build_hierarchy(
            discovery.documents,
            vault_id=vault_id,
            publish_root=self.config.source.publish_root_relative,
            preserve_folder_structure=self.config.source.preserve_folder_structure,
        )
        corpus_index = build_index(
            discovery.documents,
            folders=hierarchy.folders,
            deduplicate_titles=self.config.source.deduplicate_titles,
        )
        diagnostics: list[Diagnostic] = [
            *self.config.diagnostics,
            *discovery.diagnostics,
            *hierarchy.diagnostics,
            *corpus_index.diagnostics,
            *mermaid.diagnostics,
        ]
        asset_sources: dict[str, Path] = {}
        title_context: dict[str, str] = dict(corpus_index.final_titles)
        title_context.update(
            {
                document.identity.relative_path: corpus_index.final_titles[
                    document.identity.source_id
                ]
                for document in discovery.documents
                if document.identity.source_id in corpus_index.final_titles
            }
        )
        render_context = RenderContext(
            vault_root=self.config.source.vault_root,
            final_titles=MappingProxyType(title_context),
            policy=self.config.render.policy,
        )
        latex = self.config.capabilities.appfire_latex
        render_options = StorageOptions(
            image_options=ImageOptions(
                vault_root=self.config.source.vault_root,
                max_bytes=self.config.render.max_image_bytes,
            ),
            unresolved_link_policy=UnresolvedLinkPolicy(self.config.render.unresolved_links),
            raw_html_policy=RawHtmlPolicy(self.config.render.raw_html),
            toc_mode=TocMode(self.config.render.toc),
            link_resolver=_CorpusLinkResolver(corpus_index, self.config.source.vault_root),
            math=MathOptions(
                capability=LatexCapability("declared") if latex.enabled else None,
                fallback=(
                    MathFallbackPolicy.FAIL
                    if latex.fallback == "fail"
                    else MathFallbackPolicy.STOCK_CODE
                ),
            ),
            mermaid_assets=mermaid.assets,
            mermaid_asset_sources=mermaid.sources,
        )

        pages: list[PageSpec] = []
        landing_source_ids = {
            folder.landing_source_id for folder in hierarchy.folders if folder.landing_source_id
        }
        for document in discovery.documents:
            metadata_fields = (
                _metadata_fields(document) if self.config.render.metadata_panel else ()
            )
            rendered = render_markdown(
                document.body,
                source_path=document.absolute_path,
                context=render_context,
                options=render_options,
                metadata_fields=metadata_fields,
            )
            _merge_asset_sources(
                asset_sources,
                rendered.resolved_asset_sources,
                diagnostics,
            )
            extra_diagnostics: tuple[Diagnostic, ...] = ()
            frontmatter_page_id = document.frontmatter.page_id
            if frontmatter_page_id is not None and not allow_unverified_page_ids:
                mapped_page_id = self._state.page_id_for(document.identity.source_id)
                if mapped_page_id is None:
                    extra_diagnostics = (
                        Diagnostic(
                            "FRONTMATTER_PAGE_ID_UNVERIFIED",
                            Severity.ERROR,
                            (
                                f"{document.identity.relative_path} names page "
                                f"{frontmatter_page_id}, but it has not been adopted; "
                                "run md2conf adopt"
                            ),
                        ),
                    )
                elif mapped_page_id != frontmatter_page_id:
                    extra_diagnostics = (
                        Diagnostic(
                            "FRONTMATTER_PAGE_ID_CONFLICT",
                            Severity.ERROR,
                            "Frontmatter page ID differs from durable managed state",
                        ),
                    )
            document_diagnostics = (
                *document.diagnostics,
                *rendered.diagnostics,
                *extra_diagnostics,
            )
            if self.config.render.taxonomy_labels:
                managed_labels = build_managed_labels(document)
                labels = managed_labels.values
                document_diagnostics = (*document_diagnostics, *managed_labels.diagnostics)
            else:
                labels = _normalise_labels(document.frontmatter.tags)
            diagnostics.extend(document_diagnostics)
            final_title = corpus_index.final_titles.get(
                document.identity.source_id, document.title_candidate
            )
            parent_source_id = hierarchy.parent_by_source_id.get(document.identity.source_id)
            pages.append(
                PageSpec(
                    identity=document.identity,
                    final_title=final_title,
                    content_kind=document.frontmatter.content_type,
                    parent_source_id=parent_source_id,
                    storage_value=rendered.storage_value,
                    desired_storage_sha256=rendered.storage_sha256,
                    input_sha256=_page_input_hash(
                        rendered.input_sha256,
                        final_title=final_title,
                        parent_source_id=parent_source_id,
                        labels=labels,
                    ),
                    labels=labels,
                    assets=rendered.assets,
                    policy_id=rendered.policy_id,
                    change_parent=not document.frontmatter.dont_change_parent_page,
                    diagnostics=document_diagnostics,
                )
            )

        for folder in hierarchy.folders:
            if folder.landing_source_id in landing_source_ids:
                continue
            if folder.landing_source_id is not None:
                continue
            body = (
                f"This section contains {len(folder.children)} managed "
                f"{'page' if len(folder.children) == 1 else 'pages'}."
            )
            if folder.children and self.config.render.child_index != "none":
                directive = (
                    "page-tree" if self.config.render.child_index == "page-tree" else "children"
                )
                body += f"\n\n::: confluence:{directive} {{depth=1}}\n:::"
            rendered = render_markdown(
                body,
                source_path=self.config.source.vault_root / folder.relative_path / "index.md",
                context=render_context,
                options=render_options,
            )
            _merge_asset_sources(
                asset_sources,
                rendered.resolved_asset_sources,
                diagnostics,
            )
            diagnostics.extend(rendered.diagnostics)
            pages.append(
                PageSpec(
                    identity=folder.identity,
                    final_title=folder.final_title,
                    content_kind=ContentKind.PAGE,
                    parent_source_id=folder.parent_source_id,
                    storage_value=rendered.storage_value,
                    desired_storage_sha256=rendered.storage_sha256,
                    input_sha256=_page_input_hash(
                        rendered.input_sha256,
                        final_title=folder.final_title,
                        parent_source_id=folder.parent_source_id,
                        labels=(),
                    ),
                    labels=(),
                    assets=rendered.assets,
                    policy_id=rendered.policy_id,
                    diagnostics=rendered.diagnostics,
                )
            )

        source_set_sha256 = _source_set_hash(pages)
        if not selection.authoritative:
            selected = set(discovery.selected_source_ids)
            pending = list(selected)
            while pending:
                parent = hierarchy.parent_by_source_id.get(pending.pop())
                if parent is not None and parent not in selected:
                    selected.add(parent)
                    pending.append(parent)
            pages = [page for page in pages if page.identity.source_id in selected]
        selected_asset_ids = {asset.asset_id for page in pages for asset in page.assets}
        asset_sources = {
            asset_id: source
            for asset_id, source in asset_sources.items()
            if asset_id in selected_asset_ids
        }
        return _PreparedCorpus(
            tuple(pages),
            tuple(diagnostics),
            MappingProxyType(asset_sources),
            source_set_sha256,
            discovery.scope_fingerprint,
        )

    async def _prepare_async(
        self,
        selection: Selection,
        *,
        allow_unverified_page_ids: bool = False,
    ) -> _PreparedCorpus:
        run_id = str(uuid.uuid4())
        await self._event_sink.emit(
            PublishEvent(EventKind.STAGE_STARTED, run_id, "Preparing local corpus")
        )
        try:
            vault_id = self._vault_id()
            discovery = await asyncio.to_thread(
                self._discover,
                selection,
                vault_id=vault_id,
            )
            mermaid = await self._prepare_mermaid(discovery.documents)
            prepared = await asyncio.to_thread(
                self._prepare,
                selection,
                allow_unverified_page_ids=allow_unverified_page_ids,
                vault_id=vault_id,
                discovery=discovery,
                mermaid=mermaid,
            )
            return self._guard_scope(prepared)
        finally:
            await self._event_sink.emit(
                PublishEvent(EventKind.STAGE_FINISHED, run_id, "Local corpus prepared")
            )

    async def _prepare_mermaid(
        self,
        documents: Sequence[SourceDocument],
    ) -> _PreparedMermaid:
        renderer = self._mermaid_renderer
        if renderer is None:
            return _empty_prepared_mermaid()

        requests = await asyncio.to_thread(_collect_mermaid_requests, documents)
        if not requests:
            return _empty_prepared_mermaid()

        try:
            cache_dir = await asyncio.to_thread(
                prepare_managed_cache_child,
                self.config.state.cache_dir,
                "mermaid",
            )
        except CacheSafetyError as exc:
            return _PreparedMermaid(
                MappingProxyType({}),
                MappingProxyType({}),
                (
                    Diagnostic(
                        "MERMAID_CACHE_UNMANAGED",
                        Severity.ERROR,
                        f"Mermaid cache is unavailable: {exc}",
                        hint="Initialize the configured cache before rendering Mermaid diagrams.",
                    ),
                ),
            )

        quality = (
            MermaidQuality.HIGH
            if self.config.render.mermaid_quality == "high"
            else MermaidQuality.MEDIUM
        )
        service = MermaidService(
            renderer,
            MermaidOptions(
                cache_dir=cache_dir,
                quality=quality,
            ),
        )
        results: list[MermaidResult | None] = [None] * len(requests)
        next_index = 0

        async def worker() -> None:
            nonlocal next_index
            while next_index < len(requests):
                index = next_index
                next_index += 1
                request = requests[index]
                results[index] = await service.render(
                    request.source,
                    alt_text="Mermaid diagram",
                    span=request.span,
                )

        worker_count = min(self.config.publish.asset_concurrency, len(requests))
        await asyncio.gather(*(worker() for _ in range(worker_count)))
        assets: dict[str, AssetSpec] = {}
        sources: dict[str, Path] = {}
        diagnostics: list[Diagnostic] = []
        for request, result in zip(requests, results, strict=True):
            if result is None:  # pragma: no cover - guarded by worker completion
                raise RuntimeError("Mermaid preparation worker did not produce a result")
            diagnostics.extend(result.diagnostics)
            if result.spec is not None and result.source_path is not None:
                assets[request.key] = result.spec
                sources[request.key] = result.source_path
        return _PreparedMermaid(
            MappingProxyType(assets),
            MappingProxyType(sources),
            tuple(diagnostics),
        )

    def _guard_scope(self, prepared: _PreparedCorpus) -> _PreparedCorpus:
        """Bind a fresh state or fail closed when configured source scope changes."""

        if not isinstance(self._state, JsonStateStore):
            return prepared
        current = self._state.scope_fingerprint
        desired = prepared.scope_fingerprint
        if current == desired:
            return prepared
        if current is None and not self._state.tracked_source_ids():
            self._state.bind_scope(desired)
            return prepared
        if current is None:
            diagnostic = Diagnostic(
                "STATE_SCOPE_UNBOUND",
                Severity.ERROR,
                "Tracked state predates source-scope binding; publishing is blocked",
                hint=(
                    "Review `md2conf state scope`, then approve the exact fingerprint with "
                    "`md2conf state rebind-scope`"
                ),
            )
        else:
            diagnostic = Diagnostic(
                "STATE_SCOPE_CHANGED",
                Severity.ERROR,
                "The configured publishing scope differs from the durable state binding",
                hint=(
                    "Review `md2conf state scope`, then approve the exact fingerprint with "
                    "`md2conf state rebind-scope`; orphan reconciliation remains disabled"
                ),
            )
        return replace(prepared, diagnostics=(*prepared.diagnostics, diagnostic))

    async def rebind_target(
        self,
        *,
        expected_fingerprint: str,
        approved_fingerprint: str,
    ) -> TargetIdentity:
        """Rebind state only to the currently verified target with exact approval."""

        async with self._exclusive_operation("target rebinding"):
            if not isinstance(self._state, JsonStateStore):
                raise RuntimeError("Target rebinding requires the durable JSON state store")
            target = await self._require_gateway().preflight(self.config.confluence.parent_page_id)
            if target.fingerprint != approved_fingerprint:
                raise PlanStaleError(
                    "The approved target fingerprint does not match the verified target"
                )
            self._state.rebind_target(
                StateTarget(
                    base_url=target.base_url,
                    space_key=target.space_key,
                    root_page_id=target.root_page_id,
                    fingerprint=target.fingerprint,
                ),
                expected_fingerprint=expected_fingerprint,
            )
            return target

    async def validate(self, selection: Selection = _ALL_SELECTION) -> ValidationReport:
        async with self._exclusive_operation("validation"):
            return await self._validate_unlocked(selection)

    async def _validate_unlocked(self, selection: Selection) -> ValidationReport:
        prepared = await self._prepare_async(selection)
        return ValidationReport(prepared.pages, prepared.diagnostics)

    async def plan(self, selection: Selection = _ALL_SELECTION) -> PublishPlan:
        async with self._exclusive_operation("planning"):
            return await self._plan_unlocked(selection)

    async def _plan_unlocked(self, selection: Selection) -> PublishPlan:
        gateway = self._require_gateway()
        target = await gateway.preflight(self.config.confluence.parent_page_id)
        prepared = await self._prepare_async(selection)
        if isinstance(self._state, JsonStateStore):
            self._state.bind_target(
                StateTarget(
                    base_url=target.base_url,
                    space_key=target.space_key,
                    root_page_id=target.root_page_id,
                    fingerprint=target.fingerprint,
                )
            )
        planner = RemotePlanner(
            gateway,
            self._state,
            orphan_action=OrphanAction(self.config.publish.orphan_action),
            max_trash_count=self.config.publish.max_trash_per_publish,
            verify_skipped=self.config.publish.verify_skipped,
        )
        local_errors = any(item.severity is Severity.ERROR for item in prepared.diagnostics)
        plan = await planner.build(
            target=target,
            pages=() if local_errors else prepared.pages,
            source_set_sha256=prepared.source_set_sha256,
            selection=Selection((), authoritative=False) if local_errors else selection,
        )
        if prepared.diagnostics:
            return PublishPlan(
                plan_id=plan.plan_id,
                target=plan.target,
                source_set_sha256=plan.source_set_sha256,
                state_generation=plan.state_generation,
                operations=plan.operations,
                page_specs=(
                    MappingProxyType({page.identity.source_id: page for page in prepared.pages})
                    if local_errors
                    else plan.page_specs
                ),
                diagnostics=(*prepared.diagnostics, *plan.diagnostics),
                digest=plan.digest,
                created_at=plan.created_at,
            )
        return plan

    async def publish(
        self,
        plan: PublishPlan,
        *,
        approval: PlanApproval | None = None,
        cancellation: CancellationToken | None = None,
    ) -> PublishReport:
        async with self._exclusive_operation("publishing"):
            return await self._publish_unlocked(
                plan,
                approval=approval,
                cancellation=cancellation,
            )

    async def _publish_unlocked(
        self,
        plan: PublishPlan,
        *,
        approval: PlanApproval | None,
        cancellation: CancellationToken | None,
    ) -> PublishReport:
        adoption = any(operation.kind is OperationKind.ADOPT_PAGE for operation in plan.operations)
        current = await self._prepare_async(
            Selection.all(),
            allow_unverified_page_ids=adoption,
        )
        if any(item.severity is Severity.ERROR for item in current.diagnostics):
            raise PlanStaleError("Source validation changed after planning")
        if _current_plan_source_hash(plan, current.pages) != plan.source_set_sha256:
            raise PlanStaleError("Source inputs changed after planning")
        _validate_planned_pages(plan, current.pages)
        planned_assets = tuple(asset for page in plan.page_specs.values() for asset in page.assets)
        planned_asset_ids = {asset.asset_id for asset in planned_assets}
        runtime_asset_sources = MappingProxyType(
            {
                asset_id: source
                for asset_id, source in current.asset_sources.items()
                if asset_id in planned_asset_ids
            }
        )
        asset_cache_root: Path | None = None
        if any(asset.source.startswith("mermaid:") for asset in planned_assets):
            try:
                asset_cache_root = require_managed_cache_root(self.config.state.cache_dir)
            except CacheSafetyError as exc:
                raise PlanStaleError("Managed Mermaid cache changed after rendering") from exc
        executor = PlanExecutor(
            self._require_gateway(),
            self._state,
            event_sink=self._event_sink,
            concurrency=self.config.publish.page_concurrency,
            asset_root=self.config.source.vault_root,
            asset_cache_root=asset_cache_root,
            asset_sources=runtime_asset_sources,
        )
        report = await executor.execute(
            plan,
            approval=approval,
            cancellation=cancellation,
        )
        if self.config.source.write_back == "identity":
            report = self._write_back_committed_identities(plan, report)
        return report

    async def plan_adoption(self, path: Path, content_id: str) -> PublishPlan:
        """Build a read-only plan that claims one verified existing page without updating it."""

        async with self._exclusive_operation("adoption planning"):
            return await self._plan_adoption_unlocked(path, content_id)

    async def _plan_adoption_unlocked(self, path: Path, content_id: str) -> PublishPlan:

        prepared = await self._prepare_async(
            Selection.selected((path,)),
            allow_unverified_page_ids=True,
        )
        try:
            relative = (
                path.resolve(strict=False).relative_to(self.config.source.vault_root).as_posix()
            )
        except ValueError as exc:
            raise ValueError("Adoption source path is outside the configured vault") from exc
        page = next(
            (item for item in prepared.pages if item.identity.relative_path == relative),
            None,
        )
        if page is None:
            raise ValueError("Adoption source is not a publishable Markdown page")
        gateway = self._require_gateway()
        target = await gateway.preflight(self.config.confluence.parent_page_id)
        if isinstance(self._state, JsonStateStore):
            self._state.bind_target(
                StateTarget(
                    base_url=target.base_url,
                    space_key=target.space_key,
                    root_page_id=target.root_page_id,
                    fingerprint=target.fingerprint,
                )
            )
        plan = await RemotePlanner(gateway, self._state).build_adoption(
            target=target,
            page=page,
            content_id=content_id,
        )
        if not prepared.diagnostics:
            return plan
        return PublishPlan(
            plan_id=plan.plan_id,
            target=plan.target,
            source_set_sha256=plan.source_set_sha256,
            state_generation=plan.state_generation,
            operations=plan.operations,
            page_specs=plan.page_specs,
            diagnostics=(*prepared.diagnostics, *plan.diagnostics),
            digest=plan.digest,
            created_at=plan.created_at,
        )

    def _require_gateway(self) -> ConfluenceGateway:
        if self._gateway is None:
            raise RuntimeError("Remote operation requested from an offline Publisher")
        return self._gateway

    def _write_back_committed_identities(
        self,
        plan: PublishPlan,
        report: PublishReport,
    ) -> PublishReport:
        successful = {
            outcome.operation_id
            for outcome in report.outcomes
            if outcome.status
            not in {
                OutcomeStatus.FAILED,
                OutcomeStatus.CONFLICTED,
                OutcomeStatus.CANCELLED,
                OutcomeStatus.SKIPPED,
            }
        }
        committed_sources = {
            operation.source_id
            for operation in plan.operations
            if operation.source_id is not None
            and operation.operation_id in successful
            and operation.kind in {OperationKind.COMMIT_STATE, OperationKind.ADOPT_PAGE}
        }
        diagnostics = list(report.diagnostics)
        for source_id in sorted(committed_sources):
            page = plan.page_specs.get(source_id)
            page_id = self._state.page_id_for(source_id)
            if page is None or page_id is None or page.identity.kind is not SourceKind.NOTE:
                continue
            path = self.config.source.vault_root / page.identity.relative_path
            try:
                write_identity_frontmatter(
                    path,
                    source_id=source_id,
                    page_id=page_id,
                    publish=True,
                    vault_root=self.config.source.vault_root,
                )
            except (OSError, ValueError) as exc:
                diagnostics.append(
                    Diagnostic(
                        "FRONTMATTER_WRITEBACK_FAILED",
                        Severity.WARNING,
                        f"Published successfully but could not persist identity: {exc}",
                    )
                )
        return replace(report, diagnostics=tuple(diagnostics))


class SyncPublisher:
    """Synchronous facade for scripts that do not already run an event loop.

    GUI applications should use :class:`Publisher` directly.  Keeping one Runner for
    the facade ensures the async HTTP client and locks are always used on the same loop.
    """

    def __init__(self, runner: asyncio.Runner, publisher: Publisher) -> None:
        self._runner = runner
        self._publisher = publisher
        self._closed = False

    @classmethod
    def create(
        cls,
        config: PublisherConfig,
        *,
        dependencies: PublisherDependencies | None = None,
        offline: bool = False,
    ) -> Self:
        _require_sync_context()
        runner = asyncio.Runner()
        try:
            publisher = runner.run(
                Publisher.create(
                    config,
                    dependencies=dependencies,
                    offline=offline,
                )
            )
        except BaseException:
            runner.close()
            raise
        return cls(runner, publisher)

    def __enter__(self) -> Self:
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback
        self.close()

    def doctor(self) -> DoctorReport:
        return self._runner.run(self._publisher.doctor())

    def validate(self, selection: Selection = _ALL_SELECTION) -> ValidationReport:
        return self._runner.run(self._publisher.validate(selection))

    def plan(self, selection: Selection = _ALL_SELECTION) -> PublishPlan:
        return self._runner.run(self._publisher.plan(selection))

    def plan_adoption(self, path: Path, content_id: str) -> PublishPlan:
        return self._runner.run(self._publisher.plan_adoption(path, content_id))

    def rebind_target(
        self,
        *,
        expected_fingerprint: str,
        approved_fingerprint: str,
    ) -> TargetIdentity:
        return self._runner.run(
            self._publisher.rebind_target(
                expected_fingerprint=expected_fingerprint,
                approved_fingerprint=approved_fingerprint,
            )
        )

    def publish(
        self,
        plan: PublishPlan,
        *,
        approval: PlanApproval | None = None,
        cancellation: CancellationToken | None = None,
    ) -> PublishReport:
        return self._runner.run(
            self._publisher.publish(
                plan,
                approval=approval,
                cancellation=cancellation,
            )
        )

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._runner.run(self._publisher.close())
        finally:
            self._runner.close()


def _require_sync_context() -> None:
    try:
        asyncio.get_running_loop()
    except RuntimeError:
        return
    raise RuntimeError("SyncPublisher cannot be created inside a running event loop")


async def render_document(
    path: Path,
    *,
    context: RenderContext,
) -> RenderedPage:
    return await asyncio.to_thread(_render_document_sync, path, context)


def _render_document_sync(path: Path, context: RenderContext) -> RenderedPage:
    parsed = parse_frontmatter(path.read_text(encoding="utf-8"), path)
    rendered = render_markdown(parsed.body, source_path=path, context=context)
    source_id = str(uuid.uuid5(uuid.NAMESPACE_URL, path.resolve().as_uri()))
    identity = SourceIdentity("local-render", source_id, path.name, SourceKind.NOTE)
    title = parsed.settings.title or path.stem
    labels = _normalise_labels(parsed.settings.tags)
    diagnostics = (*parsed.diagnostics, *rendered.diagnostics)
    page = PageSpec(
        identity=identity,
        final_title=title,
        content_kind=parsed.settings.content_type,
        parent_source_id=None,
        storage_value=rendered.storage_value,
        desired_storage_sha256=rendered.storage_sha256,
        input_sha256=_page_input_hash(
            rendered.input_sha256,
            final_title=title,
            parent_source_id=None,
            labels=labels,
        ),
        labels=labels,
        assets=rendered.assets,
        policy_id=rendered.policy_id,
        diagnostics=diagnostics,
    )
    return RenderedPage(page, diagnostics)


def load_publisher_config(
    config_path: Path | str | None = None,
    *,
    profile: str = "default",
    overrides: Mapping[str, object] | None = None,
    require_secrets: bool = True,
    environ: Mapping[str, str] | None = None,
    secret_resolver: SecretResolver | None = None,
    pat_stdin: bool = False,
    password_stdin: bool = False,
) -> PublisherConfig:
    return load_config(
        config_path,
        profile=profile,
        overrides=overrides,
        require_secrets=require_secrets,
        environ=environ,
        secret_resolver=secret_resolver,
        pat_stdin=pat_stdin,
        password_stdin=password_stdin,
    )


def _normalise_labels(values: Sequence[str]) -> tuple[str, ...]:
    labels = {
        "-".join(value.strip().lower().replace("_", "-").split())[:255].strip("-")
        for value in values
    }
    return tuple(sorted(label for label in labels if label))


def _metadata_fields(document: SourceDocument) -> tuple[MetadataField, ...]:
    frontmatter = document.frontmatter
    metadata = frontmatter.metadata
    configured = frontmatter.frontmatter_to_publish
    keys = tuple(configured) if configured else ("tags", "subject", "type", "status")
    fields: list[MetadataField] = []
    for key in keys:
        value = metadata.get(key)
        if value is None:
            continue
        raw_values = value if isinstance(value, (tuple, list)) else (value,)
        values: list[MetadataValue] = []
        for item in raw_values:
            if isinstance(item, (str, int, float, bool)):
                values.append(MetadataValue.from_scalar(item))
        if values:
            fields.append(MetadataField(key.replace("_", " ").title(), tuple(values)))
    return tuple(fields)


def _page_input_hash(
    render_hash: str,
    *,
    final_title: str,
    parent_source_id: str | None,
    labels: Sequence[str],
) -> str:
    value = json.dumps(
        {
            "render": render_hash,
            "title": final_title,
            "parent": parent_source_id,
            "labels": list(labels),
            "contract": "confluence-dc-storage-9.2",
        },
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(value.encode()).hexdigest()


def _source_set_hash(pages: Sequence[PageSpec]) -> str:
    value = [
        (page.identity.source_id, page.identity.relative_path, page.input_sha256)
        for page in sorted(pages, key=lambda item: item.identity.source_id)
    ]
    return hashlib.sha256(
        json.dumps(value, ensure_ascii=False, separators=(",", ":")).encode()
    ).hexdigest()


def _current_plan_source_hash(plan: PublishPlan, pages: Sequence[PageSpec]) -> str:
    adoption = next(
        (operation for operation in plan.operations if operation.kind is OperationKind.ADOPT_PAGE),
        None,
    )
    if adoption is None:
        return _source_set_hash(pages)
    if adoption.source_id is None or adoption.content_id is None:
        return "invalid-adoption-plan"
    page = next(
        (item for item in pages if item.identity.source_id == adoption.source_id),
        None,
    )
    if page is None:
        return "missing-adoption-source"
    return hashlib.sha256(
        (f"adopt|{adoption.source_id}|{adoption.content_id}|{page.input_sha256}").encode()
    ).hexdigest()


def _validate_planned_pages(plan: PublishPlan, current_pages: Sequence[PageSpec]) -> None:
    current = {page.identity.source_id: page for page in current_pages}
    for source_id, planned in plan.page_specs.items():
        if source_id != planned.identity.source_id:
            raise PlanStaleError("Plan page-spec key does not match its source identity")
        observed = current.get(source_id)
        if observed is None:
            raise PlanStaleError("A planned source is no longer publishable")
        try:
            actual_hash = storage_sha256(planned.storage_value)
        except ValueError as exc:
            raise PlanStaleError("Planned storage is no longer valid XML") from exc
        if actual_hash != planned.desired_storage_sha256:
            raise PlanStaleError("Planned storage body does not match its declared hash")
        if _page_spec_signature(planned) != _page_spec_signature(observed):
            raise PlanStaleError("Planned page specification changed after planning")

    content_writes = {
        OperationKind.CREATE_PAGE,
        OperationKind.UPDATE_PAGE,
        OperationKind.MOVE_PAGE,
    }
    for operation in plan.operations:
        if operation.kind not in content_writes or operation.source_id is None:
            continue
        page = plan.page_specs.get(operation.source_id)
        expected_hash = operation.after.get("storage_sha256")
        if page is None or expected_hash != page.desired_storage_sha256:
            raise PlanStaleError("Content operation does not match its planned page body")


def _page_spec_signature(page: PageSpec) -> tuple[object, ...]:
    return (
        page.identity,
        page.final_title,
        page.content_kind,
        page.parent_source_id,
        page.storage_value,
        page.desired_storage_sha256,
        page.input_sha256,
        page.labels,
        page.assets,
        page.policy_id,
        page.change_parent,
    )
