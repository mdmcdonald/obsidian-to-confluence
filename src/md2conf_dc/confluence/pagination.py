"""Generic bounded pagination helpers for start/limit Confluence collections."""

from __future__ import annotations

from collections.abc import AsyncIterator, Awaitable, Callable, Mapping
from dataclasses import dataclass
from typing import Generic, TypeVar

from md2conf_dc.confluence.errors import ValidationError

T = TypeVar("T")


@dataclass(frozen=True, slots=True)
class Page(Generic[T]):
    items: tuple[T, ...]
    start: int
    limit: int
    size: int
    next_link: str | None


async def paginate(
    first_url: str,
    fetch: Callable[[str], Awaitable[Page[T]]],
    *,
    validate_next: Callable[[str], str],
    max_pages: int = 10_000,
) -> AsyncIterator[T]:
    """Yield all items, detecting loops and unbounded/malformed page sequences."""

    if max_pages < 1:
        raise ValueError("max_pages must be positive")
    seen: set[str] = set()
    url: str | None = first_url
    pages = 0
    while url is not None:
        if url in seen:
            raise ValidationError("Confluence pagination returned a link cycle")
        if pages >= max_pages:
            raise ValidationError("Confluence pagination exceeded its page limit")
        seen.add(url)
        pages += 1
        page = await fetch(url)
        if page.size != len(page.items):
            raise ValidationError("Confluence pagination size does not match results")
        for item in page.items:
            yield item
        if page.next_link is not None:
            url = validate_next(page.next_link)
        elif page.size and page.size >= page.limit:
            # Older 9.2 responses can omit _links.next.  Continue using documented
            # start/limit offsets without inventing a different resource path.
            url = _replace_query(first_url, {"start": page.start + page.size})
        else:
            url = None


def _replace_query(url: str, values: Mapping[str, int]) -> str:
    from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

    parsed = urlsplit(url)
    query = dict(parse_qsl(parsed.query, keep_blank_values=True))
    query.update({key: str(value) for key, value in values.items()})
    return urlunsplit((parsed.scheme, parsed.netloc, parsed.path, urlencode(query), ""))
