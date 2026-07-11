"""Deterministic retry classification and delay calculation."""

from __future__ import annotations

import email.utils
import random
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime

import httpx


@dataclass(frozen=True, slots=True)
class RetryPolicy:
    max_attempts: int = 4
    base_delay_seconds: float = 0.5
    max_delay_seconds: float = 10.0

    def __post_init__(self) -> None:
        if self.max_attempts < 1:
            raise ValueError("max_attempts must be positive")
        if self.base_delay_seconds < 0 or self.max_delay_seconds < 0:
            raise ValueError("retry delays cannot be negative")
        if self.base_delay_seconds > self.max_delay_seconds:
            raise ValueError("base retry delay cannot exceed the maximum")


@dataclass(frozen=True, slots=True)
class RetryClassification:
    retryable: bool
    ambiguous: bool
    reason: str


def classify_status(method: str, status_code: int) -> RetryClassification:
    method = method.upper()
    read = method in {"GET", "HEAD"}
    transient = status_code in {408, 429} or 500 <= status_code <= 599
    if read and transient:
        return RetryClassification(True, False, "transient_read_status")
    if not read and transient:
        return RetryClassification(False, True, "ambiguous_write_status")
    return RetryClassification(False, False, "non_retryable_status")


def classify_exception(method: str, error: httpx.HTTPError) -> RetryClassification:
    method = method.upper()
    read = method in {"GET", "HEAD"}
    definitely_unsent = isinstance(
        error, (httpx.ConnectError, httpx.ConnectTimeout, httpx.PoolTimeout)
    )
    if read:
        return RetryClassification(True, False, "transient_read_transport")
    if definitely_unsent:
        return RetryClassification(True, False, "write_not_sent")
    return RetryClassification(False, True, "ambiguous_write_transport")


def retry_delay(
    policy: RetryPolicy,
    *,
    attempt: int,
    retry_after: str | None = None,
    now: datetime | None = None,
    random_source: Callable[[], float] = random.random,
) -> float:
    """Return Retry-After or bounded full-jitter exponential delay."""

    parsed = _parse_retry_after(retry_after, now=now)
    if parsed is not None:
        return min(parsed, policy.max_delay_seconds)
    exponent = max(0, attempt - 1)
    ceiling = min(policy.max_delay_seconds, policy.base_delay_seconds * (2.0**exponent))
    sample = min(1.0, max(0.0, float(random_source())))
    return ceiling * sample


def _parse_retry_after(value: str | None, *, now: datetime | None) -> float | None:
    if value is None:
        return None
    stripped = value.strip()
    if stripped.isdecimal():
        return float(stripped)
    try:
        parsed = email.utils.parsedate_to_datetime(stripped)
    except (TypeError, ValueError, OverflowError):
        return None
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=UTC)
    reference = now or datetime.now(UTC)
    return max(0.0, (parsed - reference).total_seconds())
