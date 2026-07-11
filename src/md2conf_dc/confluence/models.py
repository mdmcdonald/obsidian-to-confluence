"""Strict, deliberately narrow Confluence Data Center 9.2 wire models."""

from __future__ import annotations

import hashlib
from collections.abc import Mapping
from dataclasses import dataclass
from enum import StrEnum
from typing import Annotated

from lxml import etree  # type: ignore[import-untyped]
from pydantic import AliasChoices, BaseModel, ConfigDict, Field, StringConstraints

from md2conf_dc.confluence.errors import ValidationError

NonEmpty = Annotated[str, StringConstraints(min_length=1)]
PositiveId = Annotated[str, StringConstraints(pattern=r"^[1-9][0-9]*$")]


class AttachmentDisposition(StrEnum):
    MISSING = "missing"
    UNCHANGED = "unchanged"
    CHANGED = "changed"


@dataclass(frozen=True, slots=True)
class AttachmentObservation:
    disposition: AttachmentDisposition
    attachment_id: str | None
    observed_sha256: str | None
    property_version: int | None


class WireModel(BaseModel):
    """Strict field types with forward-compatible unknown response fields."""

    model_config = ConfigDict(strict=True, extra="ignore", populate_by_name=True)


class LinksWire(WireModel):
    base: str | None = None
    context: str | None = None
    webui: str | None = None
    next: str | None = None


class SystemInfoWire(WireModel):
    version: NonEmpty
    build_number: NonEmpty = Field(validation_alias=AliasChoices("buildNumber", "build_number"))
    base_url: str | None = Field(default=None, validation_alias=AliasChoices("baseUrl", "base_url"))
    deployment_type: str | None = Field(
        default=None, validation_alias=AliasChoices("deploymentType", "deployment_type")
    )
    cloud: bool | None = None


class UserWire(WireModel):
    username: str | None = None
    key: str | None = None
    user_key: str | None = Field(default=None, validation_alias="userKey")
    display_name: str | None = Field(default=None, validation_alias="displayName")
    account_id: str | None = Field(default=None, validation_alias="accountId")


class SpaceWire(WireModel):
    key: NonEmpty


class VersionWire(WireModel):
    number: Annotated[int, Field(ge=1)]


class StorageWire(WireModel):
    value: str
    representation: str


class BodyWire(WireModel):
    storage: StorageWire | None = None


class AncestorWire(WireModel):
    id: PositiveId


class ContentWire(WireModel):
    id: PositiveId
    type: NonEmpty
    status: NonEmpty
    title: str
    space: SpaceWire | None = None
    ancestors: list[AncestorWire] = Field(default_factory=list)
    version: VersionWire
    body: BodyWire | None = None
    links: LinksWire = Field(default_factory=LinksWire, validation_alias="_links")


class ContentIdWire(WireModel):
    id: PositiveId


class PropertyWire(WireModel):
    id: str | None = None
    key: NonEmpty
    value: Mapping[str, object]
    version: VersionWire | None = None


class LabelWire(WireModel):
    prefix: str = "global"
    name: NonEmpty


class AttachmentMetadataWire(WireModel):
    media_type: str | None = Field(default=None, validation_alias="mediaType")


class AttachmentWire(WireModel):
    id: PositiveId
    type: NonEmpty
    status: NonEmpty
    title: NonEmpty
    version: VersionWire | None = None
    metadata: AttachmentMetadataWire | None = None
    links: LinksWire = Field(default_factory=LinksWire, validation_alias="_links")


class PageEnvelope(WireModel):
    results: list[Mapping[str, object]]
    start: Annotated[int, Field(ge=0)] = 0
    limit: Annotated[int, Field(ge=1)] = 25
    size: Annotated[int, Field(ge=0)] = 0
    links: LinksWire = Field(default_factory=LinksWire, validation_alias="_links")


def canonical_storage_sha256(value: str) -> str:
    """Hash a storage fragment after secure XML canonicalization.

    The wrapper is part of the canonical bytes so namespace bindings are stable across
    locally rendered and server-read fragments.
    """

    parser = etree.XMLParser(
        resolve_entities=False,
        no_network=True,
        load_dtd=False,
        dtd_validation=False,
        recover=False,
        huge_tree=False,
        remove_blank_text=False,
    )
    wrapper = (
        '<md2conf-root xmlns:ac="http://atlassian.com/content" '
        'xmlns:ri="http://atlassian.com/resource/identifier">'
        f"{value}</md2conf-root>"
    )
    try:
        root = etree.fromstring(wrapper.encode("utf-8"), parser=parser)
    except (etree.XMLSyntaxError, ValueError):
        pass
    else:
        canonical = b"".join(
            etree.tostring(child, method="c14n", with_comments=False) for child in root
        )
        return hashlib.sha256(canonical).hexdigest()
    # XML parser failures may include source fragments; do not retain them.
    raise ValidationError("Confluence storage body is not well-formed XML")
