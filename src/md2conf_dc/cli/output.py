"""CLI-only presentation. Application services never import this module."""

from __future__ import annotations

from rich.console import Console

from md2conf_dc.events import EventKind, PublishEvent


class ConsoleEventSink:
    def __init__(self, console: Console | None = None, *, quiet: bool = False) -> None:
        self._console = console or Console(stderr=True)
        self._quiet = quiet

    async def emit(self, event: PublishEvent) -> None:
        if self._quiet:
            return
        if event.kind in {EventKind.STAGE_STARTED, EventKind.OPERATION_STARTED}:
            style = "cyan"
        elif event.kind in {EventKind.CONFLICT, EventKind.SAFETY}:
            style = "bold red"
        elif event.kind is EventKind.RETRY:
            style = "yellow"
        elif event.kind is EventKind.RUN_FINISHED:
            style = "green"
        else:
            style = None
        progress = ""
        if event.completed is not None and event.total is not None:
            progress = f" [{event.completed}/{event.total}]"
        self._console.print(f"{event.message}{progress}", style=style)
