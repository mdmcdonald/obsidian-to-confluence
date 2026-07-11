"""Confluence Data Center 9.2 transport implementation.

Only this package knows REST paths or wire payloads.  Application services depend on
the transport-neutral :class:`~md2conf_dc.interfaces.ConfluenceGateway` protocol.
"""

from md2conf_dc.confluence.client import (
    BasicAuth,
    BearerAuth,
    ConfluenceClient,
    ConfluenceTimeouts,
)
from md2conf_dc.confluence.errors import (
    AmbiguousWriteError,
    AuthenticationError,
    CompatibilityError,
    ConflictError,
    ConfluenceError,
    NotFoundError,
    ResponseLimitError,
    TransportError,
    ValidationError,
)
from md2conf_dc.confluence.models import AttachmentDisposition, AttachmentObservation
from md2conf_dc.confluence.retry import RetryPolicy

__all__ = [
    "AmbiguousWriteError",
    "AttachmentDisposition",
    "AttachmentObservation",
    "AuthenticationError",
    "BasicAuth",
    "BearerAuth",
    "CompatibilityError",
    "ConflictError",
    "ConfluenceClient",
    "ConfluenceError",
    "ConfluenceTimeouts",
    "NotFoundError",
    "ResponseLimitError",
    "RetryPolicy",
    "TransportError",
    "ValidationError",
]
