"""Safe validation and canonicalization of Confluence storage fragments."""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass

from lxml import etree  # type: ignore[import-untyped]

from md2conf_dc.models import Diagnostic, Severity, SourceSpan

AC_NAMESPACE = "http://atlassian.com/content"
RI_NAMESPACE = "http://atlassian.com/resource/identifier"
_FORBIDDEN_DECLARATION = re.compile(r"<!DOCTYPE|<!ENTITY", re.IGNORECASE)


@dataclass(frozen=True, slots=True)
class XmlValidationResult:
    canonical_value: str | None
    diagnostics: tuple[Diagnostic, ...]

    @property
    def ok(self) -> bool:
        return self.canonical_value is not None and not any(
            item.severity is Severity.ERROR for item in self.diagnostics
        )


def validate_storage(fragment: str, *, span: SourceSpan | None = None) -> XmlValidationResult:
    """Parse a fragment in a namespace wrapper with entities and network disabled."""

    if _FORBIDDEN_DECLARATION.search(fragment):
        return XmlValidationResult(
            None,
            (
                Diagnostic(
                    "STORAGE_FORBIDDEN_DECLARATION",
                    Severity.ERROR,
                    "Storage fragments may not contain DTD or entity declarations.",
                    span,
                ),
            ),
        )
    wrapper = (
        f'<md2conf-root xmlns:ac="{AC_NAMESPACE}" xmlns:ri="{RI_NAMESPACE}">'
        f"{fragment}</md2conf-root>"
    )
    parser = etree.XMLParser(
        resolve_entities=False,
        load_dtd=False,
        no_network=True,
        recover=False,
        huge_tree=False,
        remove_comments=False,
    )
    try:
        root = etree.fromstring(wrapper.encode("utf-8"), parser=parser)
    except (etree.XMLSyntaxError, ValueError):
        return XmlValidationResult(
            None,
            (
                Diagnostic(
                    "STORAGE_INVALID_XML",
                    Severity.ERROR,
                    "Rendered Confluence storage is not well-formed XML.",
                    span,
                ),
            ),
        )
    canonical = "".join(
        etree.tostring(child, method="c14n", with_comments=False).decode("utf-8") for child in root
    )
    return XmlValidationResult(canonical, ())


def canonicalize_storage(fragment: str) -> str:
    result = validate_storage(fragment)
    if result.canonical_value is None:
        message = result.diagnostics[0].message if result.diagnostics else "invalid storage XML"
        raise ValueError(message)
    return result.canonical_value


def storage_sha256(fragment: str) -> str:
    canonical = canonicalize_storage(fragment)
    return hashlib.sha256(canonical.encode("utf-8")).hexdigest()
