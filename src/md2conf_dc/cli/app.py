"""Thin Typer adapter over :mod:`md2conf_dc.api`."""

from __future__ import annotations

import asyncio
import json
import shutil
import signal
import sys
import unicodedata
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from types import FrameType
from typing import Annotated

import typer
from rich.console import Console
from rich.table import Table

from md2conf_dc import __version__
from md2conf_dc.api import (
    Publisher,
    PublisherDependencies,
    load_publisher_config,
    render_document,
)
from md2conf_dc.assets.cache import (
    CACHE_SENTINEL,
    CacheSafetyError,
    initialize_managed_cache_root,
    require_managed_cache_root,
)
from md2conf_dc.cli.output import ConsoleEventSink
from md2conf_dc.config import ConfigurationError
from md2conf_dc.confluence.errors import (
    AuthenticationError,
    CompatibilityError,
    ConflictError,
    ConfluenceError,
)
from md2conf_dc.discovery import discover_sources
from md2conf_dc.errors import Md2ConfError
from md2conf_dc.executor import PlanExecutionError
from md2conf_dc.frontmatter import set_publish_frontmatter
from md2conf_dc.models import (
    CancellationToken,
    PlanApproval,
    RenderContext,
    Selection,
    Severity,
)
from md2conf_dc.ownership import OwnershipError
from md2conf_dc.planner import PlanError
from md2conf_dc.serialization import dumps
from md2conf_dc.state.legacy import plan_obsidian_import
from md2conf_dc.state.models import CURRENT_STATE_SCHEMA_VERSION
from md2conf_dc.state.store import JsonStateStore, StateError

app = typer.Typer(
    name="md2conf",
    help="Publish Markdown and Obsidian vaults to Confluence Data Center 9.2.",
    no_args_is_help=True,
)
state_app = typer.Typer(help="Inspect and maintain durable publisher state.")
cache_app = typer.Typer(help="Inspect and clear derived caches.")
note_app = typer.Typer(help="Safely update per-note publishing controls.")
app.add_typer(state_app, name="state")
app.add_typer(cache_app, name="cache")
app.add_typer(note_app, name="note")

stdout = Console()
stderr = Console(stderr=True)


@dataclass(slots=True)
class CliContext:
    config_path: Path | None
    profile: str
    quiet: bool
    pat_stdin: bool
    password_stdin: bool


@app.callback(invoke_without_command=True)
def root(
    ctx: typer.Context,
    config: Annotated[
        Path | None,
        typer.Option("--config", help="Path to .md2conf.toml."),
    ] = None,
    profile: Annotated[str, typer.Option("--profile", help="Configuration profile.")] = "default",
    quiet: Annotated[bool, typer.Option("--quiet", help="Suppress progress output.")] = False,
    pat_stdin: Annotated[
        bool,
        typer.Option("--pat-stdin", help="Read the PAT from one line of standard input."),
    ] = False,
    password_stdin: Annotated[
        bool,
        typer.Option("--password-stdin", help="Read the Basic password from standard input."),
    ] = False,
    version: Annotated[
        bool | None,
        typer.Option("--version", help="Show the package version and exit.", is_eager=True),
    ] = None,
) -> None:
    if version:
        stdout.print(__version__)
        raise typer.Exit
    ctx.obj = CliContext(config, profile, quiet, pat_stdin, password_stdin)


@app.command()
def init(
    destination: Annotated[Path, typer.Argument(help="Vault directory.")] = Path("."),
    force: Annotated[bool, typer.Option("--force", help="Replace an existing config.")] = False,
) -> None:
    """Create a safe starter configuration without storing a credential."""

    destination = destination.resolve()
    config_path = destination / ".md2conf.toml"
    if config_path.exists() and not force:
        raise typer.BadParameter(f"{config_path} already exists; use --force to replace it")
    destination.mkdir(parents=True, exist_ok=True)
    config_path.write_text(_starter_config(), encoding="utf-8")
    state_directory = destination / ".md2conf"
    state_directory.mkdir(exist_ok=True)
    with JsonStateStore.open(state_directory / "state.json") as store:
        store.flush()
    _initialize_cache_root(state_directory / "cache")
    stdout.print(f"Created {config_path}")
    stdout.print("Set MD2CONF_PAT, then run: md2conf doctor")


@app.command()
def doctor(
    ctx: typer.Context,
    json_output: Annotated[bool, typer.Option("--json", help="Emit a JSON report.")] = False,
) -> None:
    """Check auth, server version, context path, and publishing boundary."""

    cli = _context(ctx)
    _run(_doctor(cli, json_output))


@app.command()
def validate(
    ctx: typer.Context,
    paths: Annotated[list[Path] | None, typer.Argument(help="Optional paths to validate.")] = None,
    strict: Annotated[bool, typer.Option("--strict", help="Promote warnings to failure.")] = False,
    json_output: Annotated[bool, typer.Option("--json", help="Emit a JSON report.")] = False,
) -> None:
    """Discover, parse, resolve, render, and XML-check without remote writes."""

    cli = _context(ctx)
    _run(_validate(cli, paths or [], strict, json_output))


@app.command()
def render(
    path: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    output: Annotated[
        Path | None,
        typer.Option("--output", help="Write storage XHTML to this file."),
    ] = None,
    json_output: Annotated[
        bool, typer.Option("--json", help="Emit page and diagnostics JSON.")
    ] = False,
) -> None:
    """Render one Markdown file locally; no Confluence connection is needed."""

    _run(_render(path, output, json_output))


@app.command()
def plan(
    ctx: typer.Context,
    paths: Annotated[
        list[Path] | None, typer.Argument(help="Optional non-authoritative paths.")
    ] = None,
    json_output: Annotated[bool, typer.Option("--json", help="Emit plan JSON.")] = False,
) -> None:
    """Build an immutable read-only remote-aware publish plan."""

    cli = _context(ctx)
    _run(_plan(cli, paths or [], json_output))


@app.command()
def publish(
    ctx: typer.Context,
    paths: Annotated[
        list[Path] | None, typer.Argument(help="Optional non-authoritative paths.")
    ] = None,
    dry_run: Annotated[
        bool, typer.Option("--dry-run", help="Plan without mutating Confluence.")
    ] = False,
    approve_plan: Annotated[
        str | None,
        typer.Option("--approve-plan", help="Approve this exact destructive plan digest."),
    ] = None,
    actor: Annotated[
        str, typer.Option("--actor", help="Approval actor recorded in reports.")
    ] = "cli",
    json_output: Annotated[bool, typer.Option("--json", help="Emit plan/report JSON.")] = False,
) -> None:
    """Plan, revalidate, and apply safe Confluence mutations."""

    cli = _context(ctx)
    _run(_publish(cli, paths or [], dry_run, approve_plan, actor, json_output))


@app.command()
def resume(
    ctx: typer.Context,
    approve_plan: Annotated[str | None, typer.Option("--approve-plan")] = None,
    json_output: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Re-observe source/remote state and safely continue incomplete work."""

    cli = _context(ctx)
    _run(_publish(cli, [], False, approve_plan, "cli-resume", json_output))


@app.command()
def adopt(
    ctx: typer.Context,
    path: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    page_id: Annotated[str, typer.Argument(help="Existing Confluence content ID.")],
    approve_plan: Annotated[
        str | None,
        typer.Option("--approve-plan", help="Apply only this exact adoption-plan digest."),
    ] = None,
    actor: Annotated[str, typer.Option("--actor")] = "cli",
    json_output: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Verify an existing page, then explicitly adopt it without updating its body."""

    cli = _context(ctx)
    _run(_adopt(cli, path, page_id, approve_plan, actor, json_output))


@state_app.command("status")
def state_status(ctx: typer.Context) -> None:
    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    path = config.state.path
    if not path.exists():
        stdout.print("No durable state has been written yet.")
        return
    raw = json.loads(path.read_text(encoding="utf-8"))
    entries = raw.get("entries", {})
    pending = raw.get("pending_operations", [])
    pending_creates = sum(
        1
        for entry in entries.values()
        if isinstance(entry, dict) and entry.get("last_successful_stage") == "create_pending"
    )
    stdout.print(
        f"State generation {raw.get('generation', 0)}; "
        f"{len(entries)} tracked sources; "
        f"{len(pending) + pending_creates} pending operations"
    )


@state_app.command("backup")
def state_backup(ctx: typer.Context, destination: Path | None = None) -> None:
    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    source = config.state.path
    if not source.exists():
        raise typer.BadParameter("No state file exists")
    target = destination or source.with_name(
        f"{source.name}.{datetime.now(UTC).strftime('%Y%m%d%H%M%S')}.bak"
    )
    with JsonStateStore.open(
        source,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        store.backup(target)
    stdout.print(f"Created {target}")


@state_app.command("move")
def state_move(ctx: typer.Context, old_path: str, new_path: str) -> None:
    """Repair path-only state after a source move."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    with JsonStateStore.open(
        config.state.path,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        result = store.move_source(old_path, new_path)
    stdout.print(
        f"{'Moved' if result.changed else 'Already mapped'} {result.source_id}: "
        f"{result.old_path} -> {result.new_path}"
    )


@state_app.command("import-obsidian")
def state_import_obsidian(
    ctx: typer.Context,
    plugin_data: Annotated[Path, typer.Argument(exists=True, dir_okay=False)],
    json_output: Annotated[bool, typer.Option("--json")] = False,
) -> None:
    """Build a read-only migration/adoption-candidate plan."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    with JsonStateStore.open(
        config.state.path,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        result = plan_obsidian_import(
            plugin_data,
            vault_root=config.source.vault_root,
            vault_id=store.vault_id,
            source_ids_by_path=store.source_ids_by_path(),
        )
    if json_output:
        _emit_json(result)
    else:
        stdout.print(f"Migration plan: {len(result.candidates)} candidates")
        for candidate in result.candidates:
            stdout.print(
                f"- {candidate.source_path}: {candidate.page_id or 'no page ID'} "
                f"({candidate.status.value})"
            )
        stdout.print(f"Digest: {result.digest}")
        _print_diagnostics(result.diagnostics)
    if not result.ok:
        raise typer.Exit(2)


@state_app.command("rebind")
def state_rebind(
    ctx: typer.Context,
    expected_fingerprint: Annotated[str, typer.Option("--expected-fingerprint")],
    approved_fingerprint: Annotated[str, typer.Option("--approve-fingerprint")],
) -> None:
    """Verify the configured target online and approve its exact fingerprint."""

    cli = _context(ctx)
    _run(_state_rebind(cli, expected_fingerprint, approved_fingerprint))


@state_app.command("scope")
def state_scope(ctx: typer.Context) -> None:
    """Show the durable and currently configured source-scope fingerprints."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    with JsonStateStore.open(
        config.state.path,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        discovery = discover_sources(
            config.source,
            vault_id=store.vault_id,
            state=store,
            selection=Selection.all(),
        )
        current = store.scope_fingerprint
    # Fingerprints must be copyable byte-for-byte; Rich may wrap or crop long tokens.
    sys.stdout.write(f"Durable scope: {current or 'unbound'}\n")
    sys.stdout.write(f"Configured scope: {discovery.scope_fingerprint}\n")
    _print_diagnostics(discovery.diagnostics)
    if not discovery.ok:
        raise typer.Exit(2)


@state_app.command("rebind-scope")
def state_rebind_scope(
    ctx: typer.Context,
    approved_fingerprint: Annotated[str, typer.Option("--approve-fingerprint")],
    expected_fingerprint: Annotated[str | None, typer.Option("--expected-fingerprint")] = None,
    from_unbound: Annotated[
        bool,
        typer.Option(
            "--from-unbound",
            help="Confirm that legacy state has no durable scope fingerprint.",
        ),
    ] = False,
) -> None:
    """Explicitly approve the exact scope derived from the current configuration."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    with JsonStateStore.open(
        config.state.path,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        discovery = discover_sources(
            config.source,
            vault_id=store.vault_id,
            state=store,
            selection=Selection.all(),
        )
        _print_diagnostics(discovery.diagnostics)
        if not discovery.ok:
            raise typer.Exit(2)
        current = store.scope_fingerprint
        if current is None:
            if not from_unbound or expected_fingerprint is not None:
                raise typer.BadParameter(
                    "unbound state requires --from-unbound and no expected fingerprint"
                )
        elif from_unbound or expected_fingerprint != current:
            raise typer.BadParameter("--expected-fingerprint must exactly match the durable scope")
        if approved_fingerprint != discovery.scope_fingerprint:
            raise typer.BadParameter("--approve-fingerprint does not match the configured scope")
        store.rebind_scope(
            discovery.scope_fingerprint,
            expected_fingerprint=current,
        )
    stdout.print(f"State scope binding updated to {discovery.scope_fingerprint}")


@state_app.command("migrate")
def state_migrate(ctx: typer.Context) -> None:
    """Validate and persist state through the current ordered schema migrators."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    with JsonStateStore.open(
        config.state.path,
        lock_timeout=config.state.lock_timeout_seconds,
    ) as store:
        if config.state.path.exists():
            store.backup(config.state.path.with_suffix(config.state.path.suffix + ".pre-migrate"))
        store.flush()
    stdout.print(f"State is at schema {CURRENT_STATE_SCHEMA_VERSION}")


@cache_app.command("status")
def cache_status(ctx: typer.Context) -> None:
    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    path = config.state.cache_dir
    _require_managed_cache(path)
    files = [item for item in path.rglob("*") if item.is_file() and item.name != CACHE_SENTINEL]
    stdout.print(f"{len(files)} cached files ({sum(item.stat().st_size for item in files)} bytes)")


@cache_app.command("init")
def cache_init(ctx: typer.Context) -> None:
    """Initialize an empty configured directory as a managed derived cache."""

    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    _initialize_cache_root(config.state.cache_dir)
    stdout.print(f"Initialized managed cache at {config.state.cache_dir}")


@cache_app.command("clear")
def cache_clear(
    ctx: typer.Context,
    kind: Annotated[str, typer.Argument(help="mermaid or all")] = "all",
) -> None:
    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    if kind not in {"mermaid", "all"}:
        raise typer.BadParameter("cache kind must be 'mermaid' or 'all'")
    cache_root = config.state.cache_dir
    _require_managed_cache(cache_root)
    # Only named derived-cache children are removable. The sentinel-bound cache root
    # itself is never recursively deleted.
    target = cache_root / "mermaid"
    if target.is_symlink():
        raise typer.BadParameter("refusing to clear a symlinked cache directory")
    if target.exists():
        shutil.rmtree(target)
    stdout.print(f"Cleared {kind} cache")


@note_app.command("enable")
def note_enable(ctx: typer.Context, paths: list[Path]) -> None:
    _set_note_publish(ctx, paths, publish=True)


@note_app.command("disable")
def note_disable(ctx: typer.Context, paths: list[Path]) -> None:
    _set_note_publish(ctx, paths, publish=False)


@note_app.command("set")
def note_set(
    ctx: typer.Context,
    paths: list[Path],
    publish: Annotated[bool, typer.Option("--publish/--no-publish")] = True,
) -> None:
    _set_note_publish(ctx, paths, publish=publish)


def _set_note_publish(ctx: typer.Context, paths: list[Path], *, publish: bool) -> None:
    if not paths:
        raise typer.BadParameter("at least one Markdown path is required")
    cli = _context(ctx)
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=False,
    )
    for path in paths:
        result = set_publish_frontmatter(
            path,
            publish,
            vault_root=config.source.vault_root,
        )
        stdout.print(f"{'Updated' if result.changed else 'Unchanged'} {path}")


async def _doctor(cli: CliContext, json_output: bool) -> None:
    publisher = await _publisher(cli, json_output)
    async with publisher:
        report = await publisher.doctor()
    if json_output:
        _emit_json(report)
    else:
        if report.target is not None:
            table = Table(title="Confluence Data Center")
            table.add_column("Field")
            table.add_column("Value")
            table.add_row("Version", report.target.server_version)
            table.add_row("Build", report.target.server_build)
            table.add_row("Space", report.target.space_key)
            table.add_row("Boundary page", report.target.root_page_id)
            table.add_row("User", report.target.current_user)
            stdout.print(table)
        _print_diagnostics(report.diagnostics)
    if not report.ok:
        raise typer.Exit(3)


async def _validate(
    cli: CliContext,
    paths: list[Path],
    strict: bool,
    json_output: bool,
) -> None:
    publisher = await _publisher(cli, json_output, offline=True)
    async with publisher:
        report = await publisher.validate(_selection(paths))
    if json_output:
        _emit_json(report)
    else:
        stdout.print(f"Validated {len(report.pages)} pages")
        _print_diagnostics(report.diagnostics)
    has_warning = any(item.severity is Severity.WARNING for item in report.diagnostics)
    if not report.ok or (strict and has_warning):
        raise typer.Exit(2)


async def _render(path: Path, output: Path | None, json_output: bool) -> None:
    page = await render_document(path, context=RenderContext(path.parent))
    if output is not None:
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(page.page.storage_value, encoding="utf-8")
    if json_output:
        _emit_json(page)
    elif output is None:
        stdout.print(page.page.storage_value)
    _print_diagnostics(page.diagnostics)
    if any(item.severity is Severity.ERROR for item in page.diagnostics):
        raise typer.Exit(2)


async def _plan(cli: CliContext, paths: list[Path], json_output: bool) -> None:
    publisher = await _publisher(cli, json_output)
    async with publisher:
        result = await publisher.plan(_selection(paths))
    if json_output:
        _emit_json(result)
    else:
        _print_plan(result)
    if result.has_errors:
        raise typer.Exit(2)


async def _publish(
    cli: CliContext,
    paths: list[Path],
    dry_run: bool,
    approve_plan: str | None,
    actor: str,
    json_output: bool,
) -> None:
    publisher = await _publisher(cli, json_output)
    cancellation = CancellationToken()
    async with publisher:
        with _sigint_cancellation(cancellation):
            result = await publisher.plan(_selection(paths))
            if dry_run or result.has_errors:
                if json_output:
                    _emit_json(result)
                else:
                    _print_plan(result)
                if result.has_errors:
                    raise typer.Exit(2)
                return
            approval = None
            if approve_plan is not None:
                approval = PlanApproval(result.plan_id, approve_plan, datetime.now(UTC), actor)
            report = await publisher.publish(
                result,
                approval=approval,
                cancellation=cancellation,
            )
    if json_output:
        _emit_json(report)
    else:
        stdout.print(
            f"Run {report.run_id}: {len(report.outcomes)} operations; "
            f"{'success' if report.succeeded else 'partial/failure'}"
        )
        _print_diagnostics(report.diagnostics)
    if cancellation.cancelled:
        stderr.print("Cancelled after checkpointing completed operations")
        raise typer.Exit(130)
    if not report.succeeded:
        raise typer.Exit(1)


async def _adopt(
    cli: CliContext,
    path: Path,
    page_id: str,
    approve_plan: str | None,
    actor: str,
    json_output: bool,
) -> None:
    publisher = await _publisher(cli, json_output)
    cancellation = CancellationToken()
    async with publisher:
        with _sigint_cancellation(cancellation):
            result = await publisher.plan_adoption(path, page_id)
            if approve_plan is None or result.has_errors:
                if json_output:
                    _emit_json(result)
                else:
                    _print_plan(result)
                if result.has_errors:
                    raise typer.Exit(4)
                return
            approval = PlanApproval(result.plan_id, approve_plan, datetime.now(UTC), actor)
            report = await publisher.publish(
                result,
                approval=approval,
                cancellation=cancellation,
            )
    if json_output:
        _emit_json(report)
    else:
        stdout.print(f"Adopted {path} as Confluence content {page_id}")
    if cancellation.cancelled:
        stderr.print("Cancelled after checkpointing completed operations")
        raise typer.Exit(130)
    if not report.succeeded:
        raise typer.Exit(1)


async def _state_rebind(
    cli: CliContext,
    expected_fingerprint: str,
    approved_fingerprint: str,
) -> None:
    publisher = await _publisher(cli, json_output=False)
    async with publisher:
        target = await publisher.rebind_target(
            expected_fingerprint=expected_fingerprint,
            approved_fingerprint=approved_fingerprint,
        )
    stdout.print(
        f"State target binding updated to {target.base_url} / "
        f"{target.space_key} / {target.root_page_id}"
    )


async def _publisher(cli: CliContext, json_output: bool, *, offline: bool = False) -> Publisher:
    config = load_publisher_config(
        cli.config_path,
        profile=cli.profile,
        require_secrets=not offline,
        pat_stdin=cli.pat_stdin and not offline,
        password_stdin=cli.password_stdin and not offline,
    )
    sink = ConsoleEventSink(quiet=cli.quiet or json_output)
    return await Publisher.create(
        config,
        dependencies=PublisherDependencies(event_sink=sink),
        offline=offline,
    )


def _selection(paths: list[Path]) -> Selection:
    return Selection.selected(paths) if paths else Selection.all()


def _initialize_cache_root(path: Path) -> None:
    try:
        initialize_managed_cache_root(path)
    except CacheSafetyError as exc:
        raise typer.BadParameter(str(exc)) from exc


def _require_managed_cache(path: Path) -> None:
    try:
        require_managed_cache_root(path)
    except CacheSafetyError as exc:
        raise typer.BadParameter(str(exc)) from exc


@contextmanager
def _sigint_cancellation(token: CancellationToken) -> Iterator[None]:
    """Convert the first Ctrl-C into cooperative publish cancellation."""

    loop = asyncio.get_running_loop()
    previous = signal.getsignal(signal.SIGINT)
    interrupts = 0

    def handler(signum: int, frame: FrameType | None) -> None:
        del signum, frame
        nonlocal interrupts
        interrupts += 1
        if interrupts == 1:
            loop.call_soon_threadsafe(token.cancel)
            return
        raise KeyboardInterrupt

    signal.signal(signal.SIGINT, handler)
    try:
        yield
    finally:
        signal.signal(signal.SIGINT, previous)


def _emit_json(value: object) -> None:
    sys.stdout.write(dumps(value))
    sys.stdout.write("\n")


def _print_diagnostics(diagnostics: tuple[object, ...]) -> None:
    for item in diagnostics:
        severity = getattr(item, "severity", "error")
        message = getattr(item, "message", str(item))
        code = getattr(item, "code", "MD2CONF")
        console = stderr if severity in {Severity.WARNING, Severity.ERROR} else stdout
        console.print(
            f"[{_terminal_text(severity, 16)}] {_terminal_text(code, 80)}: "
            f"{_terminal_text(message, 500)}",
            markup=False,
            highlight=False,
        )


def _print_plan(plan_result: object) -> None:
    operations = getattr(plan_result, "operations", ())
    digest = getattr(plan_result, "digest", "")
    pages = getattr(plan_result, "page_specs", {})
    destructive_count = sum(
        1 for operation in operations if getattr(operation, "destructive", False)
    )
    stdout.print(f"Plan contains {len(operations)} operations; {destructive_count} destructive")
    for operation in operations:
        source_id = getattr(operation, "source_id", None)
        page = pages.get(source_id) if source_id is not None else None
        before = getattr(operation, "before", {})
        after = getattr(operation, "after", {})
        source_path = getattr(getattr(page, "identity", None), "relative_path", None)
        if source_path is None:
            source_path = before.get("source_path", "")
        title = getattr(page, "final_title", None) or before.get("title", "")
        reason = (
            before.get("reason")
            or after.get("reason")
            or _operation_reason(str(getattr(operation, "kind", "operation")))
        )
        safety = "DESTRUCTIVE" if getattr(operation, "destructive", False) else "ordinary"
        sys.stdout.write(
            f"- {_terminal_text(getattr(operation, 'kind', ''), 80)} [{safety}]\n"
            f"  source: {_terminal_text(source_path or source_id or 'n/a', 300)}\n"
            f"  content: "
            f"{_terminal_text(getattr(operation, 'content_id', None) or 'pending', 80)}\n"
            f"  title: {_terminal_text(title or 'n/a', 300)}\n"
            f"  reason: {_terminal_text(reason, 300)}\n"
        )
    # Exact approval tokens must never be cropped or line-wrapped by Rich.
    sys.stdout.write(f"Digest: {_terminal_text(digest, 128)}\n")
    _print_diagnostics(getattr(plan_result, "diagnostics", ()))


def _operation_reason(kind: str) -> str:
    normalized = kind.rsplit(".", 1)[-1].casefold()
    return {
        "create_page": "source has no managed remote page",
        "update_page": "managed content changed",
        "move_page": "managed parent changed",
        "set_property": "ownership metadata reconciliation",
        "reconcile_labels": "managed label reconciliation",
        "reconcile_asset": "managed attachment reconciliation",
        "readback": "remote state verification",
        "commit_state": "durable checkpoint",
        "trash_page": "source absent from authoritative corpus",
        "adopt_page": "explicit page adoption",
    }.get(normalized, "planned reconciliation")


def _terminal_text(value: object, maximum: int) -> str:
    """Render untrusted human text as one bounded, non-controlling terminal line."""

    raw = str(value)
    result: list[str] = []
    for character in raw:
        category = unicodedata.category(character)
        if not character.isprintable() or category in {"Cc", "Cf", "Cs", "Zl", "Zp"}:
            codepoint = ord(character)
            escaped = f"\\u{codepoint:04x}" if codepoint <= 0xFFFF else f"\\U{codepoint:08x}"
            result.append(escaped)
        else:
            result.append(character)
        if sum(len(item) for item in result) >= maximum:
            break
    rendered = "".join(result)
    if len(rendered) > maximum:
        rendered = rendered[:maximum]
    if len(raw) > len(result):
        rendered = f"{rendered.rstrip()}…"
    return rendered or "n/a"


def _context(ctx: typer.Context) -> CliContext:
    value = ctx.ensure_object(CliContext)
    if not isinstance(value, CliContext):
        raise RuntimeError("CLI context was not initialized")
    return value


def _run(awaitable: object) -> None:
    try:
        asyncio.run(awaitable)  # type: ignore[arg-type]
    except Md2ConfError as exc:
        stderr.print(f"{exc.code}: {exc.message}")
        _print_diagnostics(exc.diagnostics)
        raise typer.Exit(exc.exit_code) from exc
    except ConfigurationError as exc:
        _print_diagnostics(exc.diagnostics)
        raise typer.Exit(2) from exc
    except (AuthenticationError, CompatibilityError) as exc:
        stderr.print(f"{exc.code}: {exc}")
        raise typer.Exit(3) from exc
    except (ConflictError, OwnershipError) as exc:
        stderr.print(f"{getattr(exc, 'code', 'conflict')}: {exc}")
        raise typer.Exit(4) from exc
    except (PlanError, PlanExecutionError) as exc:
        stderr.print(f"{getattr(exc, 'code', 'plan_refused')}: {exc}")
        raise typer.Exit(5) from exc
    except StateError as exc:
        stderr.print(f"{getattr(exc, 'code', 'state_error')}: {exc}")
        raise typer.Exit(6) from exc
    except ConfluenceError as exc:
        stderr.print(f"{exc.code}: {exc}")
        raise typer.Exit(1) from exc
    except KeyboardInterrupt as exc:
        stderr.print("Cancelled; in-flight operations were given a chance to checkpoint")
        raise typer.Exit(130) from exc


def _starter_config() -> str:
    return """[profiles.default.confluence]
base_url = "https://confluence.example.test/confluence"
parent_page_id = "12345"
target_release = "9.2"
auth = "pat"
verify_tls = true

[profiles.default.source]
vault_root = "."
publish_root = "."
include = ["**/*.md"]
exclude = [".obsidian/**", ".md2conf/**", "**/*.excalidraw.md"]
write_back = "identity"

[profiles.default.render]
policy = "knowledge-base"
unresolved_links = "warn"
breadcrumbs = true
child_index = "children"

[profiles.default.publish]
page_concurrency = 4
asset_concurrency = 2
orphan_action = "report"
max_trash_per_publish = 25

[profiles.default.state]
path = ".md2conf/state.json"
cache_dir = ".md2conf/cache"
"""


def main() -> None:
    app()


if __name__ == "__main__":  # pragma: no cover
    main()
