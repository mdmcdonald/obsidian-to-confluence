"""Secret resolution primitives with deliberately explicit disclosure.

This module contains no CLI concerns.  A CLI, GUI, or embedding application can supply
an environment mapping and an input stream while the rest of the application only sees
``RedactedSecret`` values.
"""

from __future__ import annotations

import os
import sys
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Protocol, TextIO, cast

REDACTED = "***REDACTED***"


class SecretResolutionError(ValueError):
    """Raised when a configured secret source cannot be read safely."""


class KeyringProvider(Protocol):
    """Small seam around the optional keyring dependency."""

    def get_password(self, service_name: str, username: str) -> str | None: ...


class RedactedSecret:
    """A secret whose string and representation forms are always redacted.

    Calling :meth:`reveal` is intentionally conspicuous and should happen only while
    constructing an authentication header.  The value is never included in equality,
    hashing, model serialization, or exception messages by this class.
    """

    __slots__ = ("__value",)

    def __init__(self, value: str) -> None:
        if not isinstance(value, str) or not value:
            raise SecretResolutionError("a secret must be a non-empty string")
        self.__value = value

    def reveal(self) -> str:
        """Return the clear value for the transport authentication boundary."""

        return self.__value

    def __bool__(self) -> bool:
        return True

    def __repr__(self) -> str:
        return f"RedactedSecret({REDACTED!r})"

    def __str__(self) -> str:
        return REDACTED


@dataclass(frozen=True, slots=True)
class SecretRequest:
    """Declarative description of one permitted secret lookup."""

    environment_variable: str
    keyring_reference: str | None = None
    read_stdin: bool = False


class SecretResolver:
    """Resolve secrets from environment, stdin, or an optional keyring.

    Resolution order is environment, stdin, then keyring.  More than one configured
    source is rejected rather than silently choosing one, which makes GUI configuration
    mistakes visible before any network request.
    """

    def __init__(
        self,
        *,
        environ: Mapping[str, str] | None = None,
        stdin: TextIO | None = None,
        keyring_provider: KeyringProvider | None = None,
    ) -> None:
        self._environ = os.environ if environ is None else environ
        self._stdin = sys.stdin if stdin is None else stdin
        self._keyring_provider = keyring_provider

    def resolve(self, request: SecretRequest) -> RedactedSecret | None:
        """Resolve *request* without echoing or retaining provenance in the result."""

        environment_value = self._environ.get(request.environment_variable)
        configured = sum(
            (
                bool(environment_value),
                request.read_stdin,
                request.keyring_reference is not None,
            )
        )
        if configured > 1:
            raise SecretResolutionError(
                f"multiple secret sources configured for {request.environment_variable}"
            )

        if environment_value is not None:
            return self._wrap(environment_value, request.environment_variable)
        if request.read_stdin:
            value = self._stdin.readline()
            if value == "":
                raise SecretResolutionError("standard input ended before the secret was read")
            return self._wrap(value.rstrip("\r\n"), "standard input")
        if request.keyring_reference is not None:
            service, username = _parse_keyring_reference(request.keyring_reference)
            provider = self._keyring_provider or _load_keyring()
            value = provider.get_password(service, username)
            if value is None:
                raise SecretResolutionError(
                    f"keyring contains no value for reference {request.keyring_reference!r}"
                )
            return self._wrap(value, "keyring")
        return None

    @staticmethod
    def _wrap(value: str, source: str) -> RedactedSecret:
        if not value:
            raise SecretResolutionError(f"{source} supplied an empty secret")
        if "\x00" in value:
            raise SecretResolutionError(f"{source} supplied an invalid secret")
        return RedactedSecret(value)


def _parse_keyring_reference(reference: str) -> tuple[str, str]:
    """Parse ``service/username`` (or ``service:username``) references."""

    separator = "/" if "/" in reference else ":"
    if separator not in reference:
        raise SecretResolutionError("a keyring reference must use the form 'service/username'")
    service, username = reference.split(separator, 1)
    if not service or not username or any(char in reference for char in "\r\n\x00"):
        raise SecretResolutionError("invalid keyring reference")
    return service, username


def _load_keyring() -> KeyringProvider:
    try:
        import keyring  # type: ignore[import-not-found]
    except ImportError as exc:  # pragma: no cover - depends on optional installation
        raise SecretResolutionError(
            "keyring secret requested, but the optional 'keyring' package is not installed"
        ) from exc
    return cast(KeyringProvider, keyring)


def redact_mapping(value: object) -> object:
    """Return a JSON-friendly copy with common credential fields redacted.

    This is defense in depth for effective-configuration and diagnostic views.  It does
    not mutate the supplied mapping.
    """

    if isinstance(value, RedactedSecret):
        return REDACTED
    if isinstance(value, Mapping):
        result: dict[str, object] = {}
        for key, item in value.items():
            name = str(key)
            if _looks_secret(name):
                result[name] = REDACTED if item is not None else None
            else:
                result[name] = redact_mapping(item)
        return result
    if isinstance(value, (list, tuple)):
        return [redact_mapping(item) for item in value]
    return value


def _looks_secret(key: str) -> bool:
    normalized = key.casefold().replace("-", "_")
    return normalized in {
        "authorization",
        "cookie",
        "credentials",
        "password",
        "pat",
        "secret",
        "token",
    } or normalized.endswith(("_password", "_secret", "_token"))
