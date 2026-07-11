"""Safe, typed errors from the Confluence boundary.

These exceptions intentionally never include response bodies, request bodies, or
headers.  Their messages are therefore suitable for typed GUI diagnostics and logs.
"""

from __future__ import annotations


class ConfluenceError(RuntimeError):
    """Base class for a classified Confluence failure."""

    code = "confluence_error"

    def __init__(self, message: str, *, status_code: int | None = None) -> None:
        super().__init__(message)
        self.status_code = status_code


class AuthenticationError(ConfluenceError):
    code = "authentication_failed"


class CompatibilityError(ConfluenceError):
    code = "unsupported_confluence"


class NotFoundError(ConfluenceError):
    code = "not_found"


class ConflictError(ConfluenceError):
    code = "remote_conflict"


class ValidationError(ConfluenceError):
    code = "remote_validation"


class TransportError(ConfluenceError):
    code = "transport_error"


class ResponseLimitError(ConfluenceError):
    code = "response_too_large"


class AmbiguousWriteError(ConfluenceError):
    """The server may have applied a mutation whose response was not observed."""

    code = "ambiguous_write"
