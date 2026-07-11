from __future__ import annotations

import importlib
import json
from datetime import UTC, datetime
from pathlib import Path

import pytest
from typer.testing import CliRunner

from md2conf_dc.events import EventKind, PublishEvent
from md2conf_dc.models import (
    Diagnostic,
    DoctorReport,
    OperationKind,
    PlannedOperation,
    PublishPlan,
    PublishReport,
    Selection,
    Severity,
    TargetIdentity,
    ValidationReport,
)

cli_module = importlib.import_module("md2conf_dc.cli.app")
runner = CliRunner()
_ALL_SELECTION = Selection.all()


def test_cli_version_init_render_validate_and_state(tmp_path: Path) -> None:
    version = runner.invoke(cli_module.app, ["--version"])
    assert version.exit_code == 0
    assert "0.1.0" in version.stdout

    initialized = runner.invoke(cli_module.app, ["init", str(tmp_path)])
    assert initialized.exit_code == 0
    config = tmp_path / ".md2conf.toml"
    assert config.exists()
    assert "MD2CONF_PAT" not in config.read_text(encoding="utf-8")
    initial_state = json.loads((tmp_path / ".md2conf" / "state.json").read_text())
    assert initial_state["schema_version"] == 1
    assert initial_state["vault_id"]

    duplicate = runner.invoke(cli_module.app, ["init", str(tmp_path)])
    assert duplicate.exit_code != 0

    note = tmp_path / "note.md"
    note.write_text("# Hello\n\nBody", encoding="utf-8")
    rendered = runner.invoke(cli_module.app, ["render", str(note)])
    assert rendered.exit_code == 0
    assert "<h1>Hello</h1>" in rendered.stdout

    validated = runner.invoke(
        cli_module.app,
        ["--config", str(config), "validate"],
    )
    assert validated.exit_code == 0, validated.output
    assert "Validated 1 pages" in validated.stdout

    state = runner.invoke(
        cli_module.app,
        ["--config", str(config), "state", "status"],
    )
    assert state.exit_code == 0
    assert "State generation 0" in state.stdout

    disabled = runner.invoke(
        cli_module.app,
        ["--config", str(config), "note", "disable", str(note)],
    )
    assert disabled.exit_code == 0, disabled.output
    assert "connie-publish: false" in note.read_text(encoding="utf-8")

    migrated = runner.invoke(
        cli_module.app,
        ["--config", str(config), "state", "migrate"],
    )
    assert migrated.exit_code == 0, migrated.output
    assert "schema 1" in migrated.stdout

    plugin_data = tmp_path / "legacy.json"
    plugin_data.write_text(
        '{"publishedPages":{"note.md":{"pageId":"789"}}}',
        encoding="utf-8",
    )
    imported = runner.invoke(
        cli_module.app,
        [
            "--config",
            str(config),
            "state",
            "import-obsidian",
            str(plugin_data),
            "--json",
        ],
    )
    assert imported.exit_code == 0, imported.output
    assert '"page_id":"789"' in imported.stdout

    cache = runner.invoke(
        cli_module.app,
        ["--config", str(config), "cache", "status"],
    )
    assert cache.exit_code == 0
    assert "0 cached files" in cache.stdout

    cached = tmp_path / ".md2conf" / "cache" / "mermaid" / "item.png"
    cached.parent.mkdir(parents=True)
    cached.write_bytes(b"png")
    cleared = runner.invoke(
        cli_module.app,
        ["--config", str(config), "cache", "clear", "mermaid"],
    )
    assert cleared.exit_code == 0
    assert not cached.exists()

    scope = runner.invoke(
        cli_module.app,
        ["--config", str(config), "state", "scope"],
    )
    assert scope.exit_code == 0, scope.output
    configured_scope = next(
        line.removeprefix("Configured scope: ")
        for line in scope.stdout.splitlines()
        if line.startswith("Configured scope: ")
    )
    rebound = runner.invoke(
        cli_module.app,
        [
            "--config",
            str(config),
            "state",
            "rebind-scope",
            "--from-unbound",
            "--approve-fingerprint",
            configured_scope,
        ],
    )
    assert rebound.exit_code == 0, rebound.output


def test_cache_clear_refuses_unmanaged_directory(tmp_path: Path) -> None:
    initialized = runner.invoke(cli_module.app, ["init", str(tmp_path)])
    assert initialized.exit_code == 0
    config = tmp_path / ".md2conf.toml"
    unmanaged = tmp_path / "unmanaged-cache" / "mermaid"
    unmanaged.mkdir(parents=True)
    valuable = unmanaged / "keep.txt"
    valuable.write_text("keep", encoding="utf-8")
    config.write_text(
        config.read_text(encoding="utf-8").replace(
            'cache_dir = ".md2conf/cache"', 'cache_dir = "unmanaged-cache"'
        ),
        encoding="utf-8",
    )

    cleared = runner.invoke(
        cli_module.app,
        ["--config", str(config), "cache", "clear", "all"],
    )

    assert cleared.exit_code != 0
    assert valuable.read_text(encoding="utf-8") == "keep"


class FakePublisher:
    def __init__(self) -> None:
        self.target = TargetIdentity(
            base_url="https://example.test/confluence",
            server_version="9.2.4",
            server_build="9204",
            space_key="DOCS",
            root_page_id="123",
            current_user="publisher",
            fingerprint="fingerprint",
        )

    async def __aenter__(self) -> FakePublisher:
        return self

    async def __aexit__(self, exc_type: object, exc: object, traceback: object) -> None:
        del exc_type, exc, traceback

    async def doctor(self) -> DoctorReport:
        return DoctorReport(self.target, ())

    async def validate(self, selection: Selection) -> ValidationReport:
        del selection
        return ValidationReport((), ())

    async def plan(self, selection: Selection = _ALL_SELECTION) -> PublishPlan:
        del selection
        now = datetime.now(UTC)
        return PublishPlan(
            plan_id="plan-1",
            target=self.target,
            source_set_sha256="1" * 64,
            state_generation=0,
            operations=(),
            page_specs={},
            diagnostics=(),
            digest="2" * 64,
            created_at=now,
        )

    async def publish(self, plan: PublishPlan, **kwargs: object) -> PublishReport:
        del kwargs
        now = datetime.now(UTC)
        return PublishReport(1, "run-1", plan.plan_id, now, now, (), ())


@pytest.fixture
def fake_frontend(monkeypatch: pytest.MonkeyPatch) -> FakePublisher:
    fake = FakePublisher()

    async def make_publisher(
        cli: object, json_output: bool, *, offline: bool = False
    ) -> FakePublisher:
        del cli, json_output, offline
        return fake

    monkeypatch.setattr(cli_module, "_publisher", make_publisher)
    return fake


def test_cli_frontend_commands_consume_typed_application_results(
    fake_frontend: FakePublisher,
) -> None:
    del fake_frontend
    doctor = runner.invoke(cli_module.app, ["doctor", "--json"])
    assert doctor.exit_code == 0, doctor.output
    assert json.loads(doctor.stdout)["target"]["server_version"] == "9.2.4"

    plan = runner.invoke(cli_module.app, ["plan"])
    assert plan.exit_code == 0, plan.output
    assert "Plan contains 0 operations" in plan.stdout

    published = runner.invoke(cli_module.app, ["publish", "--json"])
    assert published.exit_code == 0, published.output
    assert json.loads(published.stdout)["run_id"] == "run-1"

    dry_run = runner.invoke(cli_module.app, ["publish", "--dry-run"])
    assert dry_run.exit_code == 0, dry_run.output
    assert "Digest:" in dry_run.stdout

    resumed = runner.invoke(cli_module.app, ["resume", "--json"])
    assert resumed.exit_code == 0, resumed.output


@pytest.mark.asyncio
async def test_console_event_sink_formats_progress() -> None:
    sink = cli_module.ConsoleEventSink(quiet=True)
    await sink.emit(PublishEvent(EventKind.RETRY, "run", "retrying", completed=1, total=2))


def test_cli_strict_validation_failure_is_exit_two(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fake = FakePublisher()

    async def warning_validate(selection: Selection) -> ValidationReport:
        del selection
        return ValidationReport(
            (),
            (Diagnostic("WARN", Severity.WARNING, "warning"),),
        )

    fake.validate = warning_validate  # type: ignore[method-assign]

    async def make_publisher(
        cli: object, json_output: bool, *, offline: bool = False
    ) -> FakePublisher:
        del cli, json_output, offline
        return fake

    monkeypatch.setattr(cli_module, "_publisher", make_publisher)
    result = runner.invoke(cli_module.app, ["validate", "--strict"])
    assert result.exit_code == 2


def test_human_plan_prints_destructive_review_context(capsys: pytest.CaptureFixture[str]) -> None:
    operation = PlannedOperation(
        operation_id="trash-1",
        kind=OperationKind.TRASH_PAGE,
        source_id="source-1",
        content_id="789",
        prerequisites=(),
        before={
            "source_path": "Retired/Guide.md",
            "title": "Retired Guide",
            "reason": "source_absent_from_authoritative_corpus",
        },
        after={"status": "trashed"},
        expected_version=4,
        destructive=True,
    )
    plan = type(
        "ReviewPlan",
        (),
        {
            "operations": (operation,),
            "page_specs": {},
            "digest": "d" * 64,
            "diagnostics": (),
        },
    )()

    cli_module._print_plan(plan)
    output = capsys.readouterr().out

    assert "1 destructive" in output
    assert "789" in output
    assert "Retired/Guide.md" in output
    assert "Retired Guide" in output
    assert "source_absent_from_authoritative_corpus" in output
    assert f"Digest: {'d' * 64}" in output


def test_human_output_escapes_terminal_and_markup_controls(
    capsys: pytest.CaptureFixture[str],
) -> None:
    hostile = "Safe\nFAKE APPROVAL\x1b]8;;https://evil.test\x07\u202e[red]"
    operation = PlannedOperation(
        operation_id="trash-1",
        kind=OperationKind.TRASH_PAGE,
        source_id="source-1",
        content_id="789",
        prerequisites=(),
        before={"source_path": hostile, "title": hostile, "reason": hostile},
        after={"status": "trashed"},
        destructive=True,
    )
    plan = type(
        "HostilePlan",
        (),
        {
            "operations": (operation,),
            "page_specs": {},
            "digest": "d" * 64,
            "diagnostics": (),
        },
    )()

    cli_module._print_plan(plan)
    cli_module._print_diagnostics((Diagnostic("[red]", Severity.WARNING, hostile),))
    captured = capsys.readouterr()
    combined = captured.out + captured.err

    assert "\x1b" not in combined
    assert "\u202e" not in combined
    assert "\nFAKE APPROVAL" not in combined
    assert "\\u000aFAKE APPROVAL" in combined
    assert "[red]" in combined
