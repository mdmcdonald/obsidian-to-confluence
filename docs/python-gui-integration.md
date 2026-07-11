# GUI integration contract

The Python implementation is an application library with two adapters: the current CLI
and a future GUI. The GUI must call `md2conf_dc.api.Publisher`; it must not invoke the
CLI, parse terminal output, construct REST payloads, or write publisher state directly.

## Stable frontend boundary

```python
import asyncio

from md2conf_dc.api import Publisher, load_publisher_config
from md2conf_dc.models import CancellationToken, PlanApproval, Selection

config = load_publisher_config(profile="docs")
publisher = await Publisher.create(config)

# Consume events concurrently; iterating this stream inline would wait for close.
async def consume_events() -> None:
    async for event in publisher.events():
        update_view(event)

event_task = asyncio.create_task(consume_events())
await asyncio.sleep(0)  # let the subscription register before the first operation
try:
    report = await publisher.validate(Selection.all())
    plan = await publisher.plan(Selection.all())
    result = await publisher.publish(
        plan,
        approval=PlanApproval(...),
        cancellation=CancellationToken(),
    )
finally:
    await publisher.close()
    await event_task
```

The public results are immutable dataclasses and enums. `md2conf_dc.serialization`
converts them to versionable JSON values when a GUI needs a process or web boundary.
No public model contains a Typer, Rich, HTTPX, Pydantic wire, or GUI-toolkit type.

## Long-running operations

- `Publisher.events()` is a typed asynchronous event stream. Events carry safe IDs,
  progress, stage, retry, conflict, safety, and completion information without source or
  storage bodies.
- Local discovery, hashing, parsing, and rendering run in a worker thread so they do not
  block a GUI event loop. A frontend should still present these as whole-corpus stages;
  cooperative per-page cancellation of local preparation is not yet exposed.
- `CancellationToken` provides cooperative cancellation. Closing a window should call
  `cancel()` and continue consuming events until the operation checkpoints and finishes.
- Plans are immutable. A confirmation screen displays the plan and retains its digest;
  destructive approval uses `PlanApproval(plan_id, digest, actor, approved_at)`, not a
  Boolean.
- Validation, planning, and execution return structured diagnostics. A GUI can group
  them by source and navigate to line/column without interpreting exception strings.

## Dependency injection

`PublisherDependencies` accepts gateway, state-store, event-sink, and approved Mermaid
renderer implementations.
This permits:

- an in-memory demo/test GUI without a Confluence server;
- a native credential-store adapter without changing publishing logic;
- an IPC gateway if the UI and publisher later run in separate processes;
- deterministic UI tests driven by fake plans, conflicts, retries, and progress events.

Injected Confluence gateways must implement the guarded-mutation protocol. The executor
refuses an adapter before its first write unless every mutator accepts and enforces the
final expected vault, source, kind, space, root, version, body, property, and parent
observation. This applies equally to in-process GUI adapters and future IPC adapters.

Event subscribers have independent bounded buffers, and injected observers are isolated
behind bounded nonblocking adapters. A frozen or closed window cannot delay a remote
readback or durable checkpoint. The GUI should still close `Publisher` explicitly so the
last completion event is flushed and owned resources are released.

The production REST and state implementations remain behind the same protocols. A GUI
must never bypass ownership, scope, plan-digest, conflict, or destructive-operation
checks by supplying a custom adapter in normal builds.

Mermaid rendering uses the configured managed cache and never adopts or creates an
unbound cache root implicitly. A GUI setup screen may offer an explicit cache action via
`md2conf_dc.assets.initialize_managed_cache_root`; ordinary validate/plan/publish calls
return a `MERMAID_CACHE_UNMANAGED` diagnostic when the path-bound sentinel is absent or
invalid.

## Suggested GUI structure

Keep a toolkit-specific view layer over these application screens:

1. profile/configuration editor using the strict config schema and redacted effective
   configuration;
2. connection doctor;
3. local validation/diagnostics;
4. immutable plan review, with create/update/move/asset/label/orphan filters;
5. execution progress and cancellation;
6. final report and recovery/resume actions.

Only one doctor, validate, plan, adoption, rebind, or publish operation may run through a
`Publisher` instance at a time. The `busy` property is suitable for disabling conflicting
GUI actions; the application service also fails fast if a second operation races the UI.

Configuration editors should render the generated `PublisherConfig` JSON schema. Secret
values are absent from that schema and from effective-config serialization. Controls that
are not implemented are represented as constants or rejected by validation, so a GUI must
not manufacture additional toggles and assume the core will honor them.

An ambiguous create without a returned content ID is intentionally not matched by title.
The recovery screen should present the `PLAN_CREATE_PENDING_RECONCILIATION` diagnostic and
route an operator to the exact-ID adoption flow. Likewise, an unmarked attachment left by
a lost create response requires explicit operator reconciliation. These cases remain
blocked across restart instead of risking duplicate or foreign ownership.

The first GUI should use the async API in-process. Introduce IPC only if packaging or
crash isolation creates a demonstrated need; the JSON serializer and protocols preserve
that option without making it part of the initial runtime.
