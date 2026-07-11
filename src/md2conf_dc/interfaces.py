"""Dependency-injection protocols used by the application services."""

from __future__ import annotations

from collections.abc import AsyncIterator, Mapping, Sequence
from pathlib import Path
from typing import Protocol

from md2conf_dc.models import (
    AssetSpec,
    OwnershipMarker,
    RemoteContent,
    TargetIdentity,
)
from md2conf_dc.ownership import MutationExpectation


class ConfluenceGateway(Protocol):
    """Remote boundary with mandatory final-write guards.

    Mutation implementations must raise ``AmbiguousWriteError`` whenever a request
    may have reached Confluence but its committed outcome was not fully read back.
    A non-ambiguous ``ConfluenceError`` is a promise that the requested mutation was
    definitely not applied; the executor relies on that distinction for recovery.
    """

    @property
    def supports_guarded_mutations(self) -> bool: ...

    async def preflight(self, parent_page_id: str) -> TargetIdentity: ...

    async def get_content(self, content_id: str) -> RemoteContent: ...

    def find_owned_content(
        self, *, vault_id: str, root_page_id: str
    ) -> AsyncIterator[RemoteContent]: ...

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
        desired: Sequence[str],
        previously_managed: Sequence[str],
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

    async def close(self) -> None: ...


class StateStore(Protocol):
    @property
    def generation(self) -> int: ...

    def page_id_for(self, source_id: str) -> str | None: ...

    def entry_for(self, source_id: str) -> Mapping[str, object] | None: ...

    def tracked_source_ids(self) -> frozenset[str]: ...

    def checkpoint(self, updates: Mapping[str, Mapping[str, object]]) -> None: ...

    def close(self) -> None: ...


class MermaidRenderer(Protocol):
    @property
    def identity(self) -> str: ...

    async def render(self, source: str, *, scale: float, destination: Path) -> None: ...
