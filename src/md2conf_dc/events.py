"""Typed event transport suitable for CLI, GUI, and embedded callers."""

from __future__ import annotations

import asyncio
from collections import deque
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from datetime import UTC, datetime
from enum import StrEnum
from typing import Protocol


class EventKind(StrEnum):
    RUN_STARTED = "run_started"
    RUN_FINISHED = "run_finished"
    STAGE_STARTED = "stage_started"
    STAGE_FINISHED = "stage_finished"
    OPERATION_STARTED = "operation_started"
    OPERATION_FINISHED = "operation_finished"
    RETRY = "retry"
    CONFLICT = "conflict"
    SAFETY = "safety"
    DIAGNOSTIC = "diagnostic"


@dataclass(frozen=True, slots=True)
class PublishEvent:
    kind: EventKind
    run_id: str
    message: str
    timestamp: datetime = field(default_factory=lambda: datetime.now(UTC))
    source_id: str | None = None
    operation_id: str | None = None
    completed: int | None = None
    total: int | None = None
    attempt: int | None = None
    outcome: str | None = None


class EventSink(Protocol):
    async def emit(self, event: PublishEvent) -> None: ...


class NullEventSink:
    async def emit(self, event: PublishEvent) -> None:
        del event


_LOSSY_EVENT_KINDS = {
    EventKind.STAGE_STARTED,
    EventKind.STAGE_FINISHED,
    EventKind.OPERATION_STARTED,
    EventKind.OPERATION_FINISHED,
}


@dataclass(eq=False, slots=True)
class _SubscriberBuffer:
    maximum: int
    items: deque[PublishEvent] = field(default_factory=deque)
    wake: asyncio.Event = field(default_factory=asyncio.Event)
    closed: bool = False

    def put(self, event: PublishEvent) -> None:
        if self.closed:
            return
        if len(self.items) < self.maximum:
            self.items.append(event)
            self.wake.set()
            return
        if event.kind in _LOSSY_EVENT_KINDS:
            return
        lossy_index = next(
            (index for index, queued in enumerate(self.items) if queued.kind in _LOSSY_EVENT_KINDS),
            None,
        )
        if lossy_index is not None:
            del self.items[lossy_index]
            self.items.append(event)
        else:
            # A non-consuming observer filled its bounded buffer with critical events.
            # Disconnect it without blocking publishing, retaining the newest event.
            self.items.clear()
            self.items.append(event)
            self.closed = True
        self.wake.set()

    async def get(self) -> PublishEvent | None:
        while not self.items:
            if self.closed:
                return None
            await self.wake.wait()
            self.wake.clear()
        event = self.items.popleft()
        if self.items:
            self.wake.set()
        return event

    def close(self) -> None:
        self.closed = True
        self.wake.set()


class EventBus:
    """Fan-out event bus; every subscriber gets its own bounded queue.

    Slow UI subscribers cannot block publishing. If a subscriber falls behind, its
    oldest progress event is dropped in favour of current state.
    """

    def __init__(self, *, queue_size: int = 256) -> None:
        if queue_size < 1:
            raise ValueError("event queue size must be positive")
        self._queue_size = queue_size
        self._subscribers: set[_SubscriberBuffer] = set()
        self._closed = False

    async def emit(self, event: PublishEvent) -> None:
        for subscriber in tuple(self._subscribers):
            subscriber.put(event)

    async def subscribe(self) -> AsyncIterator[PublishEvent]:
        subscriber = _SubscriberBuffer(self._queue_size)
        if self._closed:
            return
        self._subscribers.add(subscriber)
        try:
            while True:
                event = await subscriber.get()
                if event is None:
                    return
                yield event
        finally:
            self._subscribers.discard(subscriber)

    async def close(self) -> None:
        self._closed = True
        for subscriber in tuple(self._subscribers):
            subscriber.close()


class CompositeEventSink:
    """Best-effort bounded adapters for sinks supplied by frontends/extensions."""

    def __init__(
        self,
        *sinks: EventSink,
        queue_size: int = 256,
        sink_timeout_seconds: float = 0.25,
    ) -> None:
        if queue_size < 1:
            raise ValueError("event queue size must be positive")
        if sink_timeout_seconds <= 0:
            raise ValueError("sink timeout must be positive")
        self._observers = tuple(
            _BufferedObserver(sink, queue_size, sink_timeout_seconds) for sink in sinks
        )
        self._closed = False

    async def emit(self, event: PublishEvent) -> None:
        # Enqueue only: observers are never on the remote mutation/checkpoint path.
        if self._closed:
            return
        for observer in self._observers:
            observer.enqueue(event)

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await asyncio.gather(*(observer.close() for observer in self._observers))


class _BufferedObserver:
    def __init__(self, sink: EventSink, queue_size: int, timeout_seconds: float) -> None:
        self._sink = sink
        self._buffer = _SubscriberBuffer(queue_size)
        self._timeout_seconds = timeout_seconds
        self._task: asyncio.Task[None] | None = None
        self._disabled = False
        self._closing = False

    def enqueue(self, event: PublishEvent) -> None:
        if self._disabled or self._closing:
            return
        self._buffer.put(event)
        if self._task is None:
            self._task = asyncio.create_task(self._drain())

    async def _drain(self) -> None:
        try:
            while self._buffer.items:
                event = self._buffer.items.popleft()
                try:
                    await asyncio.wait_for(
                        self._sink.emit(event),
                        timeout=self._timeout_seconds,
                    )
                except (Exception, asyncio.CancelledError):
                    self._disabled = True
                    self._buffer.items.clear()
                    return
                if self._buffer.closed:
                    self._disabled = True
                    self._buffer.items.clear()
                    return
        finally:
            self._task = None
            if self._buffer.items and not self._disabled and not self._closing:
                self._task = asyncio.create_task(self._drain())

    async def close(self) -> None:
        self._closing = True
        task = self._task
        if task is None:
            self._buffer.close()
            self._disabled = True
            return
        done, pending = await asyncio.wait(
            (task,),
            timeout=self._timeout_seconds + 0.05,
        )
        del done
        for item in pending:
            item.cancel()
        self._buffer.close()
        self._disabled = True
