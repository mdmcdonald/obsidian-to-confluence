from __future__ import annotations

from io import StringIO

import pytest

from md2conf_dc.secrets import (
    REDACTED,
    RedactedSecret,
    SecretRequest,
    SecretResolutionError,
    SecretResolver,
    redact_mapping,
)


class MemoryKeyring:
    def get_password(self, service_name: str, username: str) -> str | None:
        return "keyring-value" if (service_name, username) == ("md2conf", "docs") else None


def test_secret_resolver_supports_each_explicit_source() -> None:
    environment = SecretResolver(environ={"TOKEN": "environment-value"})
    value = environment.resolve(SecretRequest("TOKEN"))
    assert value is not None and value.reveal() == "environment-value"

    standard_input = SecretResolver(environ={}, stdin=StringIO("stdin-value\n"))
    value = standard_input.resolve(SecretRequest("TOKEN", read_stdin=True))
    assert value is not None and value.reveal() == "stdin-value"

    keyring = SecretResolver(environ={}, keyring_provider=MemoryKeyring())
    value = keyring.resolve(SecretRequest("TOKEN", "md2conf/docs"))
    assert value is not None and value.reveal() == "keyring-value"


def test_secret_resolver_rejects_ambiguous_empty_and_missing_values() -> None:
    resolver = SecretResolver(environ={"TOKEN": "environment-value"}, stdin=StringIO("x\n"))
    with pytest.raises(SecretResolutionError, match="multiple secret sources"):
        resolver.resolve(SecretRequest("TOKEN", read_stdin=True))

    with pytest.raises(SecretResolutionError, match="ended"):
        SecretResolver(environ={}, stdin=StringIO("")).resolve(
            SecretRequest("TOKEN", read_stdin=True)
        )
    with pytest.raises(SecretResolutionError, match="contains no value"):
        SecretResolver(environ={}, keyring_provider=MemoryKeyring()).resolve(
            SecretRequest("TOKEN", "other/user")
        )


def test_secret_values_and_nested_mappings_are_redacted() -> None:
    secret = RedactedSecret("do-not-print")
    assert str(secret) == REDACTED
    assert "do-not-print" not in repr(secret)
    assert redact_mapping(
        {"authorization": "Bearer secret", "nested": {"api_token": secret}, "safe": 1}
    ) == {
        "authorization": REDACTED,
        "nested": {"api_token": REDACTED},
        "safe": 1,
    }
