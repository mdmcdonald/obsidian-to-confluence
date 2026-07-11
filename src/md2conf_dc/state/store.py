"""Locked, atomic JSON state persistence with target binding safeguards."""

from __future__ import annotations

import json
import os
import shutil
import tempfile
from collections.abc import Mapping, Sequence
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from uuid import UUID, uuid4

from filelock import FileLock, Timeout
from pydantic import ValidationError

from md2conf_dc.models import Diagnostic, Severity
from md2conf_dc.state.migrations import StateMigrationError, migrate_state_payload
from md2conf_dc.state.models import (
    LastRunState,
    PendingOperationState,
    PublisherState,
    StateEntry,
    StateMoveResult,
    StateTarget,
)

MAX_STATE_BYTES = 32 * 1024 * 1024
_FORBIDDEN_STATE_KEYS = {
    "authorization",
    "cookie",
    "credentials",
    "password",
    "pat",
    "secret",
    "token",
    "source_body",
    "storage_value",
    "rendered_body",
    "attachment_bytes",
    "request_body",
    "response_body",
}


class StateError(RuntimeError):
    pass


class StateLockError(StateError):
    pass


class StateTargetMismatch(StateError):
    pass


class JsonStateStore:
    """StateStore implementation whose lifetime owns an exclusive file lock."""

    def __init__(
        self,
        path: Path,
        state: PublisherState,
        lock: FileLock,
        *,
        diagnostics: tuple[Diagnostic, ...] = (),
    ) -> None:
        self._path = path
        self._state = state
        self._lock = lock
        self._closed = False
        self._diagnostics = diagnostics

    @classmethod
    def open(
        cls,
        path: Path,
        *,
        vault_id: str | None = None,
        tool_version: str = "0.1.0",
        target: StateTarget | None = None,
        lock_timeout: float = 0,
    ) -> JsonStateStore:
        """Acquire the lock and load state; opening a new store does not write it."""

        resolved = path.expanduser().resolve(strict=False)
        lock = FileLock(str(resolved) + ".lock", timeout=lock_timeout)
        try:
            lock.acquire()
        except Timeout as exc:
            raise StateLockError(f"state is locked by another process: {resolved}") from exc

        diagnostics: list[Diagnostic] = []
        try:
            if resolved.exists():
                try:
                    state = _read_state(resolved)
                except StateError:
                    backup = _backup_path(resolved)
                    if not backup.exists():
                        raise
                    state = _read_state(backup)
                    diagnostics.append(
                        Diagnostic(
                            code="STATE_PRIMARY_CORRUPT",
                            severity=Severity.WARNING,
                            message=(
                                "primary state was invalid; loaded the last-known-good backup"
                            ),
                        )
                    )
            elif _backup_path(resolved).exists():
                state = _read_state(_backup_path(resolved))
                diagnostics.append(
                    Diagnostic(
                        code="STATE_PRIMARY_MISSING",
                        severity=Severity.WARNING,
                        message="primary state was missing; loaded the last-known-good backup",
                    )
                )
            else:
                state = PublisherState(
                    tool_version=tool_version,
                    vault_id=str(uuid4()) if vault_id is None else str(UUID(vault_id)),
                    target=target,
                )
            if vault_id is not None and state.vault_id != str(UUID(vault_id)):
                raise StateError("configured vault ID does not match the state file")
            if target is not None and state.target is not None:
                if state.target.fingerprint != target.fingerprint:
                    raise StateTargetMismatch(
                        "state target fingerprint differs; use an explicit rebind workflow"
                    )
            elif target is not None:
                state = state.model_copy(update={"target": target})
            return cls(resolved, state, lock, diagnostics=tuple(diagnostics))
        except Exception:
            lock.release()
            raise

    @property
    def path(self) -> Path:
        return self._path

    @property
    def generation(self) -> int:
        return self._state.generation

    @property
    def vault_id(self) -> str:
        return self._state.vault_id

    @property
    def target(self) -> StateTarget | None:
        return self._state.target

    @property
    def scope_fingerprint(self) -> str | None:
        return self._state.scope_fingerprint

    @property
    def diagnostics(self) -> tuple[Diagnostic, ...]:
        return self._diagnostics

    @property
    def pending_operations(self) -> tuple[PendingOperationState, ...]:
        return self._state.pending_operations

    @property
    def last_run(self) -> LastRunState | None:
        return self._state.last_run

    def page_id_for(self, source_id: str) -> str | None:
        entry = self._state.entries.get(source_id)
        return None if entry is None else entry.page_id

    def entry_for(self, source_id: str) -> Mapping[str, object] | None:
        entry = self._state.entries.get(source_id)
        if entry is None:
            return None
        value = entry.model_dump(mode="json")
        return MappingProxyType(value)

    def tracked_source_ids(self) -> frozenset[str]:
        return frozenset(self._state.entries)

    def source_id_for_path(self, relative_path: str) -> str | None:
        normalized = relative_path.replace("\\", "/")
        matches = [
            source_id
            for source_id, entry in self._state.entries.items()
            if entry.source_path == normalized
        ]
        if len(matches) > 1:
            raise StateError(f"state contains duplicate source path {normalized!r}")
        return matches[0] if matches else None

    def source_ids_by_path(self) -> Mapping[str, str]:
        result: dict[str, str] = {}
        for source_id, entry in self._state.entries.items():
            if entry.source_path is None:
                continue
            if entry.source_path in result:
                raise StateError(f"state contains duplicate source path {entry.source_path!r}")
            result[entry.source_path] = source_id
        return MappingProxyType(result)

    def bind_target(self, target: StateTarget) -> None:
        """Bind an unbound in-memory store; persistence happens at checkpoint/flush."""

        self._ensure_open()
        if self._state.target is not None and self._state.target.fingerprint != target.fingerprint:
            raise StateTargetMismatch(
                "state target fingerprint differs; use an explicit rebind workflow"
            )
        self._state = self._state.model_copy(update={"target": target})

    def bind_scope(self, fingerprint: str) -> None:
        """Bind an empty/unbound state in memory; checkpoints persist the binding."""

        self._ensure_open()
        _validate_scope_fingerprint(fingerprint)
        current = self._state.scope_fingerprint
        if current is not None and current != fingerprint:
            raise StateTargetMismatch(
                "publishing scope differs; use the explicit scope-rebind workflow"
            )
        self._state = self._state.model_copy(update={"scope_fingerprint": fingerprint})

    def rebind_scope(
        self,
        fingerprint: str,
        *,
        expected_fingerprint: str | None,
    ) -> None:
        """Explicitly commit a reviewed publishing-scope change."""

        self._ensure_open()
        _validate_scope_fingerprint(fingerprint)
        if self._state.scope_fingerprint != expected_fingerprint:
            raise StateTargetMismatch("publishing scope changed before explicit rebind")
        self._commit(self._state.model_copy(update={"scope_fingerprint": fingerprint}))

    def rebind_target(self, target: StateTarget, *, expected_fingerprint: str) -> None:
        """Explicitly replace a target binding and commit a new generation."""

        self._ensure_open()
        current = self._state.target
        if current is None or current.fingerprint != expected_fingerprint:
            raise StateTargetMismatch("state target changed before explicit rebind")
        self._commit(self._state.model_copy(update={"target": target}))

    def checkpoint(self, updates: Mapping[str, Mapping[str, object]]) -> None:
        """Merge validated entry updates and atomically commit one generation."""

        self._ensure_open()
        entries = dict(self._state.entries)
        for source_id, update in updates.items():
            normalized_id = str(UUID(source_id))
            _reject_sensitive_state(update)
            current = entries.get(normalized_id)
            combined = {} if current is None else current.model_dump(mode="python")
            combined.update(dict(update))
            try:
                entries[normalized_id] = StateEntry.model_validate(combined)
            except ValidationError as exc:
                raise StateError(f"invalid checkpoint for source {normalized_id}") from exc
        self._commit(self._state.model_copy(update={"entries": entries}))

    def remove_entries(self, source_ids: Sequence[str]) -> None:
        self._ensure_open()
        entries = dict(self._state.entries)
        for source_id in source_ids:
            entries.pop(str(UUID(source_id)), None)
        self._commit(self._state.model_copy(update={"entries": entries}))

    def move_source(
        self,
        old_path: str,
        new_path: str,
        *,
        expected_source_id: str | None = None,
    ) -> StateMoveResult:
        """Atomically repair path-only identity after a note move.

        The destination must not already belong to another source.  The optional source
        ID provides compare-and-swap protection for a GUI that previewed the move.
        """

        self._ensure_open()
        old_normalized = _normalized_source_path(old_path)
        new_normalized = _normalized_source_path(new_path)
        source_id = self.source_id_for_path(old_normalized)
        if source_id is None:
            raise StateError(f"state does not track source path {old_normalized!r}")
        expected = None if expected_source_id is None else str(UUID(expected_source_id))
        if expected is not None and source_id != expected:
            raise StateError("source identity changed before state move")
        destination_id = self.source_id_for_path(new_normalized)
        if destination_id is not None and destination_id != source_id:
            raise StateError(f"destination path is already tracked: {new_normalized!r}")
        if old_normalized == new_normalized:
            return StateMoveResult(
                source_id=source_id,
                old_path=old_normalized,
                new_path=new_normalized,
                changed=False,
                generation=self.generation,
            )
        entries = dict(self._state.entries)
        current = entries[source_id]
        value = current.model_dump(mode="python")
        value["source_path"] = new_normalized
        entries[source_id] = StateEntry.model_validate(value)
        self._commit(self._state.model_copy(update={"entries": entries}))
        return StateMoveResult(
            source_id=source_id,
            old_path=old_normalized,
            new_path=new_normalized,
            changed=True,
            generation=self.generation,
        )

    def set_pending_operations(self, operations: Sequence[PendingOperationState]) -> None:
        self._ensure_open()
        for operation in operations:
            _reject_sensitive_state(operation.model_dump(mode="python"))
        self._commit(self._state.model_copy(update={"pending_operations": tuple(operations)}))

    def set_last_run(self, last_run: LastRunState) -> None:
        self._ensure_open()
        self._commit(self._state.model_copy(update={"last_run": last_run}))

    def flush(self) -> None:
        """Persist current in-memory state without advancing its generation."""

        self._ensure_open()
        _write_state(self._path, self._state)

    def backup(self, destination: Path) -> Path:
        """Create an explicit validated snapshot without changing state."""

        self._ensure_open()
        destination = destination.expanduser().resolve(strict=False)
        _write_state(destination, self._state, retain_backup=False)
        return destination

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        self._lock.release()

    def __enter__(self) -> JsonStateStore:
        self._ensure_open()
        return self

    def __exit__(self, exc_type: object, exc: object, traceback: object) -> None:
        self.close()

    def _commit(self, proposed: PublisherState) -> None:
        committed = proposed.model_copy(update={"generation": self._state.generation + 1})
        _write_state(self._path, committed)
        self._state = committed

    def _ensure_open(self) -> None:
        if self._closed:
            raise StateError("state store is closed")


def _read_state(path: Path) -> PublisherState:
    invalid = False
    try:
        if path.stat().st_size > MAX_STATE_BYTES:
            raise StateError(f"state exceeds the {MAX_STATE_BYTES}-byte limit")
        with path.open("r", encoding="utf-8") as stream:
            raw = json.load(stream)
        if not isinstance(raw, Mapping):
            raise StateError("state root must be a JSON object")
        migrated = migrate_state_payload(raw)
        _reject_sensitive_state(migrated)
        return PublisherState.model_validate(migrated)
    except (OSError, json.JSONDecodeError, ValidationError, StateMigrationError):
        invalid = True
    if invalid:
        # Raise after leaving the parser exception handler: JSONDecodeError retains
        # the complete source document on the exception object.
        raise StateError(f"invalid state file: {path}")
    raise AssertionError("unreachable state parser branch")


def _write_state(path: Path, state: PublisherState, *, retain_backup: bool = True) -> None:
    payload = state.model_dump(mode="json")
    _reject_sensitive_state(payload)
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as stream:
            json.dump(payload, stream, ensure_ascii=False, sort_keys=True, indent=2)
            stream.write("\n")
            stream.flush()
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        if retain_backup and path.exists():
            try:
                _read_state(path)
            except StateError:
                # Never replace a known-good backup with a corrupt primary recovered
                # during open().  The new atomic state will become the primary below.
                pass
            else:
                _write_backup(path)
        os.replace(temporary, path)
        _fsync_directory(path.parent)
    finally:
        temporary.unlink(missing_ok=True)


def _write_backup(path: Path) -> None:
    backup = _backup_path(path)
    descriptor, temporary_name = tempfile.mkstemp(prefix=f".{backup.name}.", dir=path.parent)
    temporary = Path(temporary_name)
    try:
        os.close(descriptor)
        shutil.copyfile(path, temporary)
        with temporary.open("rb") as stream:
            os.fsync(stream.fileno())
        os.chmod(temporary, 0o600)
        os.replace(temporary, backup)
    finally:
        temporary.unlink(missing_ok=True)


def _backup_path(path: Path) -> Path:
    return path.with_name(f"{path.name}.bak")


def _normalized_source_path(value: str) -> str:
    if not value or "\x00" in value or "\\" in value:
        raise StateError("source path must be a non-empty relative POSIX path")
    path = PurePosixPath(value)
    if path.is_absolute() or any(part in {"", ".", ".."} for part in path.parts):
        raise StateError("source path must be a normalized relative POSIX path")
    return path.as_posix()


def _fsync_directory(path: Path) -> None:
    try:
        descriptor = os.open(path, os.O_RDONLY)
    except OSError:  # pragma: no cover - platform/filesystem dependent
        return
    try:
        os.fsync(descriptor)
    except OSError:  # pragma: no cover - platform/filesystem dependent
        pass
    finally:
        os.close(descriptor)


def _validate_scope_fingerprint(value: str) -> None:
    if len(value) != 64 or any(character not in "0123456789abcdef" for character in value):
        raise StateError("scope fingerprint must be a lowercase SHA-256 digest")


def _reject_sensitive_state(value: object, *, path: str = "state") -> None:
    if isinstance(value, Mapping):
        for key, item in value.items():
            name = str(key)
            normalized = name.casefold().replace("-", "_")
            if normalized in _FORBIDDEN_STATE_KEYS or normalized.endswith(
                ("_password", "_secret", "_token")
            ):
                raise StateError(f"sensitive field is forbidden in state: {path}.{name}")
            _reject_sensitive_state(item, path=f"{path}.{name}")
    elif isinstance(value, (list, tuple)):
        for index, item in enumerate(value):
            _reject_sensitive_state(item, path=f"{path}[{index}]")
    elif isinstance(value, (bytes, bytearray, memoryview)):
        raise StateError(f"binary data is forbidden in state: {path}")
