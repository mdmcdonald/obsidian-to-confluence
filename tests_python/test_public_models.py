from __future__ import annotations

import asyncio
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest

from md2conf_dc.events import CompositeEventSink, EventBus, EventKind, PublishEvent
from md2conf_dc.models import (
    CancellationToken,
    Diagnostic,
    DoctorReport,
    Severity,
    SourceSpan,
)
from md2conf_dc.serialization import dumps, to_json_value


def test_doctor_report_is_ok_only_without_errors() -> None:
    warning = Diagnostic("W1", Severity.WARNING, "warning")
    error = Diagnostic("E1", Severity.ERROR, "error")
    assert DoctorReport(None, (warning,)).ok is False
    assert DoctorReport(None, (error,)).ok is False


def test_cancellation_token_is_cooperative() -> None:
    token = CancellationToken()
    assert token.cancelled is False
    token.cancel()
    assert token.cancelled is True
    with pytest.raises(asyncio.CancelledError):
        token.raise_if_cancelled()


@pytest.mark.asyncio
async def test_event_bus_fans_out_and_closes() -> None:
    bus = EventBus()
    seen: list[PublishEvent] = []

    async def consume() -> None:
        async for event in bus.subscribe():
            seen.append(event)

    consumer = asyncio.create_task(consume())
    await asyncio.sleep(0)
    event = PublishEvent(EventKind.RUN_STARTED, "run-1", "Starting")
    await bus.emit(event)
    await bus.close()
    await consumer
    assert seen == [event]


@pytest.mark.asyncio
async def test_event_bus_drops_only_lossy_progress_when_full() -> None:
    bus = EventBus(queue_size=1)
    stream = bus.subscribe()
    first_read = asyncio.ensure_future(anext(stream))
    await asyncio.sleep(0)
    await bus.emit(PublishEvent(EventKind.RUN_STARTED, "run", "start"))
    assert (await first_read).kind is EventKind.RUN_STARTED

    await bus.emit(PublishEvent(EventKind.STAGE_STARTED, "run", "progress one"))
    await bus.emit(PublishEvent(EventKind.STAGE_FINISHED, "run", "progress two"))
    await bus.emit(PublishEvent(EventKind.SAFETY, "run", "approval required"))
    assert (await anext(stream)).kind is EventKind.SAFETY
    await bus.close()
    with pytest.raises(StopAsyncIteration):
        await anext(stream)


@pytest.mark.asyncio
async def test_observer_failure_does_not_escape_composite_sink() -> None:
    seen: list[PublishEvent] = []

    class RecordingSink:
        async def emit(self, event: PublishEvent) -> None:
            seen.append(event)

    class BrokenSink:
        async def emit(self, event: PublishEvent) -> None:
            del event
            raise BrokenPipeError("GUI closed")

    event = PublishEvent(EventKind.RUN_STARTED, "run", "start")
    sink = CompositeEventSink(RecordingSink(), BrokenSink())
    await sink.emit(event)
    await asyncio.sleep(0)
    await sink.close()
    assert seen == [event]


@pytest.mark.asyncio
async def test_stalled_observer_never_blocks_event_delivery_or_cleanup() -> None:
    stalled = asyncio.Event()

    class StalledSink:
        async def emit(self, event: PublishEvent) -> None:
            del event
            await stalled.wait()

    sink = CompositeEventSink(StalledSink(), sink_timeout_seconds=0.01)
    event = PublishEvent(EventKind.RUN_STARTED, "run", "start")

    await asyncio.wait_for(sink.emit(event), timeout=0.05)
    await asyncio.wait_for(sink.close(), timeout=0.1)


def test_json_serialization_handles_public_values() -> None:
    diagnostic = Diagnostic(
        "EXAMPLE",
        Severity.WARNING,
        "Example",
        SourceSpan(Path("docs/example.md"), 2, 4),
    )
    value = to_json_value(diagnostic)
    assert isinstance(value, dict)
    assert value["severity"] == "warning"
    assert value["span"]["path"] == "docs/example.md"
    encoded = json.loads(dumps({"at": datetime(2025, 1, 1, tzinfo=UTC), "item": diagnostic}))
    assert encoded["at"] == "2025-01-01T00:00:00+00:00"
