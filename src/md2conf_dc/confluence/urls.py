"""Context-path-safe URL handling for Confluence Data Center."""

from __future__ import annotations

from dataclasses import dataclass
from urllib.parse import SplitResult, quote, unquote, urlsplit, urlunsplit

from md2conf_dc.confluence.errors import ValidationError


@dataclass(frozen=True, slots=True)
class ConfluenceBaseUrl:
    """A normalized origin and optional application context path."""

    origin: str
    context_path: str

    @classmethod
    def parse(cls, value: str) -> ConfluenceBaseUrl:
        parsed = urlsplit(value.strip())
        if parsed.scheme not in {"http", "https"} or not parsed.hostname:
            raise ValidationError("Confluence base URL must be an absolute HTTP(S) URL")
        if parsed.username is not None or parsed.password is not None:
            raise ValidationError("Confluence base URL must not contain user information")
        if parsed.query or parsed.fragment:
            raise ValidationError("Confluence base URL must not contain a query or fragment")

        try:
            parsed_port = parsed.port
        except ValueError as exc:
            raise ValidationError("Confluence base URL has an invalid port") from exc
        default_port = 443 if parsed.scheme.lower() == "https" else 80
        port = f":{parsed_port}" if parsed_port is not None and parsed_port != default_port else ""
        host = parsed.hostname.lower()
        if ":" in host and not host.startswith("["):
            host = f"[{host}]"
        origin = urlunsplit((parsed.scheme.lower(), f"{host}{port}", "", "", ""))
        path = _normalize_path(parsed.path)
        if path.endswith("/rest") or "/rest/api" in path:
            raise ValidationError("Confluence base URL must identify the application, not REST")
        return cls(origin=origin, context_path=path)

    @property
    def value(self) -> str:
        return f"{self.origin}{self.context_path}"

    def rest(self, relative_path: str) -> str:
        """Join an allowlisted-style REST path below the configured context."""

        if not relative_path.startswith("/rest/api/") and relative_path != "/rest/api":
            raise ValidationError("REST path must be relative to /rest/api")
        if "?" in relative_path or "#" in relative_path:
            raise ValidationError("REST path must not contain a query or fragment")
        return f"{self.origin}{self.context_path}{relative_path}"

    def resolve_same_context(self, link: str) -> str:
        """Resolve a server link while forbidding origin or context changes."""

        if not link or "\\" in link:
            raise ValidationError("Confluence returned an invalid link")
        parsed = urlsplit(link)
        if parsed.fragment:
            raise ValidationError("Confluence link unexpectedly contains a fragment")

        if parsed.scheme or parsed.netloc:
            candidate = link
        elif link.startswith("/"):
            if self.context_path and (
                link == self.context_path or link.startswith(f"{self.context_path}/")
            ):
                candidate = f"{self.origin}{link}"
            elif link.startswith("/rest/"):
                candidate = f"{self.origin}{self.context_path}{link}"
            elif not self.context_path:
                candidate = f"{self.origin}{link}"
            else:
                raise ValidationError("Confluence link escapes the configured context path")
        else:
            candidate = f"{self.value}/{link.lstrip('/')}"

        result = urlsplit(candidate)
        base = urlsplit(self.origin)
        if _origin_tuple(result) != _origin_tuple(base):
            raise ValidationError("Confluence redirect or link changes origin")
        normalized = _normalize_path(result.path)
        if self.context_path and not (
            normalized == self.context_path or normalized.startswith(f"{self.context_path}/")
        ):
            raise ValidationError("Confluence redirect or link escapes the configured context")
        return urlunsplit((result.scheme, result.netloc, normalized, result.query, ""))


def path_segment(value: str) -> str:
    """Validate and encode a positive decimal Confluence identifier."""

    if not value.isdecimal() or int(value) <= 0:
        raise ValidationError("Confluence identifiers must be positive decimal strings")
    return quote(value, safe="")


def text_segment(value: str) -> str:
    if not value or value in {".", ".."}:
        raise ValidationError("REST path segment is empty or unsafe")
    return quote(value, safe="")


def _normalize_path(path: str) -> str:
    parts: list[str] = []
    for part in path.split("/"):
        if not part:
            continue
        decoded = unquote(part)
        if decoded in {".", ".."} or "/" in decoded or "\\" in decoded:
            raise ValidationError("URL path must not contain dot segments")
        parts.append(part)
    return f"/{'/'.join(parts)}" if parts else ""


def _origin_tuple(parsed: SplitResult) -> tuple[str, str | None, int | None]:
    scheme = parsed.scheme.lower()
    port = parsed.port
    if port is None:
        port = 443 if scheme == "https" else 80 if scheme == "http" else None
    return scheme, parsed.hostname, port
