"""Pure ordered state-schema migrations.

Schema 1 is the initial release.  Keeping migration dispatch separate from I/O makes
future migrations deterministic and independently testable.
"""

from __future__ import annotations

from collections.abc import Mapping

from md2conf_dc.state.models import CURRENT_STATE_SCHEMA_VERSION


class StateMigrationError(ValueError):
    pass


def migrate_state_payload(payload: Mapping[str, object]) -> dict[str, object]:
    """Return a migrated copy of *payload* or reject unknown/future schemas."""

    value = dict(payload)
    schema = value.get("schema_version")
    if schema != CURRENT_STATE_SCHEMA_VERSION:
        raise StateMigrationError(
            f"unsupported state schema {schema!r}; expected {CURRENT_STATE_SCHEMA_VERSION}"
        )
    return value
