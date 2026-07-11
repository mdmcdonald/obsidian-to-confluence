"""Strict layered configuration for library, CLI, and future GUI callers."""

from __future__ import annotations

import ipaddress
import os
import tomllib
from collections.abc import Mapping
from pathlib import Path, PurePosixPath
from types import MappingProxyType
from typing import Annotated, Literal, TypeAlias
from urllib.parse import unquote, urlsplit, urlunsplit

from pydantic import (
    BaseModel,
    ConfigDict,
    Field,
    PrivateAttr,
    StrictBool,
    StrictFloat,
    StrictInt,
    StrictStr,
    ValidationError,
    field_validator,
    model_validator,
)
from pydantic.json_schema import SkipJsonSchema

from md2conf_dc.models import Diagnostic, Severity
from md2conf_dc.secrets import (
    REDACTED,
    RedactedSecret,
    SecretRequest,
    SecretResolutionError,
    SecretResolver,
)

PositiveInt: TypeAlias = Annotated[StrictInt, Field(gt=0)]
NonNegativeInt: TypeAlias = Annotated[StrictInt, Field(ge=0)]
PositiveFloat: TypeAlias = Annotated[StrictFloat, Field(gt=0)]


class ConfigurationError(ValueError):
    """Typed configuration failure suitable for a GUI validation panel."""

    def __init__(self, diagnostics: tuple[Diagnostic, ...]) -> None:
        self.diagnostics = diagnostics
        super().__init__("configuration is invalid")


class _StrictModel(BaseModel):
    model_config = ConfigDict(
        extra="forbid",
        frozen=True,
        validate_default=True,
        arbitrary_types_allowed=True,
    )


class ConfluenceConfig(_StrictModel):
    base_url: StrictStr
    parent_page_id: StrictStr
    target_release: StrictStr = "9.2"
    auth: Literal["pat", "basic"] = "pat"
    username: StrictStr | None = None
    verify_tls: StrictBool = True
    allow_http_localhost: StrictBool = False
    connect_timeout_seconds: PositiveFloat = 10.0
    read_timeout_seconds: PositiveFloat = 60.0
    write_timeout_seconds: PositiveFloat = 120.0
    pool_timeout_seconds: PositiveFloat = 10.0
    pat_keyring: StrictStr | None = None
    password_keyring: StrictStr | None = None
    pat: SkipJsonSchema[RedactedSecret | None] = Field(
        default=None,
        exclude=True,
        repr=False,
    )
    password: SkipJsonSchema[RedactedSecret | None] = Field(
        default=None,
        exclude=True,
        repr=False,
    )

    @field_validator("base_url")
    @classmethod
    def validate_base_url(cls, value: str) -> str:
        return _normalize_base_url(value)

    @field_validator("parent_page_id")
    @classmethod
    def validate_parent_page_id(cls, value: str) -> str:
        if not value.isdecimal() or int(value) <= 0:
            raise ValueError("parent_page_id must be a positive decimal string")
        return value

    @field_validator("target_release")
    @classmethod
    def validate_target_release(cls, value: str) -> str:
        if value != "9.2":
            raise ValueError("target_release must be '9.2'")
        return value

    @field_validator("username", "pat_keyring", "password_keyring")
    @classmethod
    def reject_blank(cls, value: str | None) -> str | None:
        if value is not None and not value.strip():
            raise ValueError("value must not be blank")
        return value

    @model_validator(mode="after")
    def validate_transport(self) -> ConfluenceConfig:
        parsed = urlsplit(self.base_url)
        if parsed.scheme == "http" and not self.allow_http_localhost:
            raise ValueError(
                "HTTP requires allow_http_localhost=true and is limited to loopback hosts"
            )
        if not self.verify_tls and not _is_loopback_host(parsed.hostname or ""):
            raise ValueError(
                "verify_tls=false is permitted only for localhost or a loopback IP address"
            )
        return self


class SourceConfig(_StrictModel):
    vault_root: Path = Path(".")
    publish_root: Path = Path(".")
    include: tuple[StrictStr, ...] = ("**/*.md",)
    exclude: tuple[StrictStr, ...] = (
        ".obsidian/**",
        ".md2conf/**",
        "**/*.excalidraw.md",
    )
    first_heading_page_title: StrictBool = False
    deduplicate_titles: StrictBool = True
    preserve_folder_structure: StrictBool = True
    outside_scope_placement: Literal["root", "source"] = "root"
    write_back: Literal["none", "identity"] = "identity"
    max_source_bytes: PositiveInt = 5 * 1024 * 1024
    max_frontmatter_bytes: PositiveInt = 1024 * 1024
    max_documents: PositiveInt = 5_000

    @field_validator("include", "exclude")
    @classmethod
    def validate_globs(cls, value: tuple[str, ...]) -> tuple[str, ...]:
        for pattern in value:
            if not pattern or "\x00" in pattern or "\\" in pattern:
                raise ValueError("glob patterns must be non-empty POSIX patterns")
            if PurePosixPath(pattern).is_absolute():
                raise ValueError("glob patterns must be relative")
        return value

    @property
    def publish_root_relative(self) -> PurePosixPath:
        relative = self.publish_root.relative_to(self.vault_root)
        return PurePosixPath(relative.as_posix())


class RenderConfig(_StrictModel):
    policy: StrictStr = "knowledge-base"
    theme: Literal["default"] = "default"
    metadata_panel: StrictBool = True
    taxonomy_labels: StrictBool = True
    unresolved_links: Literal["warn", "text", "fail"] = "warn"
    raw_html: Literal["escape", "fail"] = "escape"
    toc: Literal["auto", "always", "never"] = "auto"
    breadcrumbs: Literal[True] = True
    child_index: Literal["children", "page-tree", "links", "none"] = "children"
    mermaid_quality: Literal["standard", "high"] = "high"
    max_image_bytes: PositiveInt = 20 * 1024 * 1024

    @field_validator("policy")
    @classmethod
    def reject_blank(cls, value: str) -> str:
        if not value.strip():
            raise ValueError("value must not be blank")
        return value


class AppfireLatexConfig(_StrictModel):
    enabled: StrictBool = False
    fallback: Literal["code", "text", "fail"] = "code"


class CapabilitiesConfig(_StrictModel):
    appfire_latex: AppfireLatexConfig = Field(default_factory=AppfireLatexConfig)


class PublishConfig(_StrictModel):
    page_concurrency: PositiveInt = 4
    asset_concurrency: PositiveInt = 2
    batch_size: Literal[20] = 20
    batch_delay_ms: Literal[0] = 0
    skip_unchanged: Literal[True] = True
    verify_skipped: StrictBool = True
    conflict_policy: Literal["fail"] = "fail"
    orphan_action: Literal["off", "report", "trash"] = "report"
    max_trash_per_publish: NonNegativeInt = 25
    retry_attempts: PositiveInt = 5
    retry_cap_seconds: PositiveFloat = 30.0


class StateConfig(_StrictModel):
    path: Path = Path(".md2conf/state.json")
    cache_dir: Path = Path(".md2conf/cache")
    lock_timeout_seconds: Annotated[StrictFloat, Field(ge=0)] = 0.0


class LoggingConfig(_StrictModel):
    level: Literal["debug", "info", "warning", "error"] = "info"
    format: Literal["text", "json"] = "text"


class PublisherConfig(_StrictModel):
    """Normalized effective configuration with transport-neutral diagnostics."""

    profile: StrictStr
    config_path: Path
    confluence: ConfluenceConfig
    source: SourceConfig = Field(default_factory=SourceConfig)
    render: RenderConfig = Field(default_factory=RenderConfig)
    capabilities: CapabilitiesConfig = Field(default_factory=CapabilitiesConfig)
    publish: PublishConfig = Field(default_factory=PublishConfig)
    state: StateConfig = Field(default_factory=StateConfig)
    logging: LoggingConfig = Field(default_factory=LoggingConfig)
    diagnostics: tuple[Diagnostic, ...] = ()
    _raw_profile: Mapping[str, object] = PrivateAttr(default_factory=dict)

    def redacted_dict(self) -> dict[str, object]:
        """Return a JSON-serializable effective config without secret disclosure."""

        value = self.model_dump(mode="json", exclude={"diagnostics"})
        confluence = value["confluence"]
        assert isinstance(confluence, dict)
        if self.confluence.pat is not None:
            confluence["pat"] = REDACTED
        if self.confluence.password is not None:
            confluence["password"] = REDACTED
        return value


_PROFILE_SECTIONS = {
    "confluence",
    "source",
    "render",
    "capabilities",
    "publish",
    "state",
    "logging",
}
_SECRET_NAMES = {"pat", "password", "secret", "token", "api_token"}


def load_config(
    config_path: Path | str | None = None,
    *,
    profile: str = "default",
    overrides: Mapping[str, object] | None = None,
    environ: Mapping[str, str] | None = None,
    secret_resolver: SecretResolver | None = None,
    pat_stdin: bool = False,
    password_stdin: bool = False,
    require_secrets: bool = True,
) -> PublisherConfig:
    """Load one TOML profile with CLI > environment > profile > default precedence.

    ``overrides`` contains non-secret CLI/application overrides.  It may be nested or
    use dotted names such as ``confluence.base_url``.  Validation failures raise one
    :class:`ConfigurationError` carrying structured diagnostics; warnings are returned
    on the immutable config for GUI and CLI presentation.
    """

    path = Path(".md2conf.toml") if config_path is None else Path(config_path)
    path = path.expanduser().resolve(strict=False)
    env = os.environ if environ is None else environ
    diagnostics: list[Diagnostic] = []

    try:
        document = _read_toml(path)
        raw_profile = _select_profile(document, profile)
        _reject_secrets(raw_profile, location=f"profile {profile!r}")
        profile_data = _copy_mapping(raw_profile)
        _deep_merge(profile_data, _environment_overrides(env))
        normalized_overrides = _normalize_overrides(overrides or {})
        _reject_secrets(normalized_overrides, location="application overrides")
        _deep_merge(profile_data, normalized_overrides)

        confluence_data = profile_data.setdefault("confluence", {})
        if not isinstance(confluence_data, dict):
            raise ValueError("confluence must be a table")
        auth = confluence_data.get("auth", "pat")
        _validate_secret_mode(env, auth, pat_stdin, password_stdin, confluence_data)
        if require_secrets:
            resolver = secret_resolver or SecretResolver(environ=env)
            confluence_data["pat"] = resolver.resolve(
                SecretRequest(
                    "MD2CONF_PAT",
                    _optional_string(confluence_data.get("pat_keyring")),
                    pat_stdin,
                )
            )
            confluence_data["password"] = resolver.resolve(
                SecretRequest(
                    "MD2CONF_PASSWORD",
                    _optional_string(confluence_data.get("password_keyring")),
                    password_stdin,
                )
            )
        else:
            confluence_data["pat"] = None
            confluence_data["password"] = None

        config = PublisherConfig(
            profile=profile,
            config_path=path,
            diagnostics=(),
            **profile_data,
        )
        config = _resolve_paths(config, path.parent)
        _validate_auth_shape(config.confluence)
        if require_secrets:
            _validate_auth(config.confluence)
        if urlsplit(config.confluence.base_url).scheme == "http":
            diagnostics.append(
                Diagnostic(
                    code="CONFIG_HTTP_LOOPBACK",
                    severity=Severity.WARNING,
                    message="HTTP is enabled for loopback development only",
                )
            )
        if not config.confluence.verify_tls:
            diagnostics.append(
                Diagnostic(
                    code="CONFIG_TLS_VERIFICATION_DISABLED",
                    severity=Severity.WARNING,
                    message="TLS verification is disabled for loopback development only",
                )
            )
        if config.source.write_back == "none":
            diagnostics.append(
                Diagnostic(
                    code="CONFIG_IDENTITY_WRITEBACK_DISABLED",
                    severity=Severity.WARNING,
                    message=(
                        "identity writeback is disabled; moving a note requires an explicit "
                        "state move to preserve its source identity"
                    ),
                )
            )
        config = config.model_copy(update={"diagnostics": tuple(diagnostics)})
        config._raw_profile = MappingProxyType(_copy_mapping(raw_profile))
        return config
    except ConfigurationError:
        raise
    except (OSError, tomllib.TOMLDecodeError, ValidationError, ValueError) as exc:
        raise ConfigurationError((_configuration_diagnostic(exc, path),)) from exc


def _read_toml(path: Path) -> Mapping[str, object]:
    try:
        with path.open("rb") as stream:
            value = tomllib.load(stream)
    except FileNotFoundError as exc:
        raise ValueError(f"configuration file does not exist: {path}") from exc
    if not isinstance(value, dict):  # pragma: no cover - tomllib always returns dict
        raise ValueError("configuration root must be a table")
    unknown = set(value) - {"profiles"}
    if unknown:
        raise ValueError(f"unknown top-level configuration key(s): {', '.join(sorted(unknown))}")
    return value


def _select_profile(document: Mapping[str, object], profile: str) -> Mapping[str, object]:
    profiles = document.get("profiles")
    if not isinstance(profiles, Mapping):
        raise ValueError("configuration must contain a [profiles.<name>] table")
    selected = profiles.get(profile)
    if not isinstance(selected, Mapping):
        raise ValueError(f"configuration profile {profile!r} does not exist")
    unknown = set(map(str, selected)) - _PROFILE_SECTIONS
    if unknown:
        raise ValueError(f"unknown profile section(s): {', '.join(sorted(unknown))}")
    return selected


def _reject_secrets(value: Mapping[str, object], *, location: str, prefix: str = "") -> None:
    for key, item in value.items():
        name = str(key)
        qualified = f"{prefix}.{name}" if prefix else name
        normalized = name.casefold().replace("-", "_")
        if normalized in _SECRET_NAMES:
            raise ValueError(f"secret field {qualified!r} is forbidden in {location}")
        if isinstance(item, Mapping):
            _reject_secrets(item, location=location, prefix=qualified)


def _environment_overrides(environ: Mapping[str, str]) -> dict[str, object]:
    fields: dict[str, tuple[str, str, str]] = {
        "MD2CONF_BASE_URL": ("confluence", "base_url", "str"),
        "MD2CONF_PARENT_PAGE_ID": ("confluence", "parent_page_id", "str"),
        "MD2CONF_TARGET_RELEASE": ("confluence", "target_release", "str"),
        "MD2CONF_AUTH": ("confluence", "auth", "str"),
        "MD2CONF_USERNAME": ("confluence", "username", "str"),
        "MD2CONF_PAT_KEYRING": ("confluence", "pat_keyring", "str"),
        "MD2CONF_PASSWORD_KEYRING": ("confluence", "password_keyring", "str"),
        "MD2CONF_VERIFY_TLS": ("confluence", "verify_tls", "bool"),
        "MD2CONF_ALLOW_HTTP_LOCALHOST": (
            "confluence",
            "allow_http_localhost",
            "bool",
        ),
        "MD2CONF_CONNECT_TIMEOUT_SECONDS": (
            "confluence",
            "connect_timeout_seconds",
            "float",
        ),
        "MD2CONF_READ_TIMEOUT_SECONDS": (
            "confluence",
            "read_timeout_seconds",
            "float",
        ),
        "MD2CONF_WRITE_TIMEOUT_SECONDS": (
            "confluence",
            "write_timeout_seconds",
            "float",
        ),
        "MD2CONF_POOL_TIMEOUT_SECONDS": (
            "confluence",
            "pool_timeout_seconds",
            "float",
        ),
        "MD2CONF_VAULT_ROOT": ("source", "vault_root", "path"),
        "MD2CONF_PUBLISH_ROOT": ("source", "publish_root", "path"),
        "MD2CONF_DEDUPLICATE_TITLES": ("source", "deduplicate_titles", "bool"),
        "MD2CONF_FIRST_HEADING_PAGE_TITLE": (
            "source",
            "first_heading_page_title",
            "bool",
        ),
        "MD2CONF_PRESERVE_FOLDER_STRUCTURE": (
            "source",
            "preserve_folder_structure",
            "bool",
        ),
        "MD2CONF_WRITE_BACK": ("source", "write_back", "str"),
        "MD2CONF_PAGE_CONCURRENCY": ("publish", "page_concurrency", "int"),
        "MD2CONF_ASSET_CONCURRENCY": ("publish", "asset_concurrency", "int"),
        "MD2CONF_BATCH_SIZE": ("publish", "batch_size", "int"),
        "MD2CONF_STATE_PATH": ("state", "path", "path"),
        "MD2CONF_CACHE_DIR": ("state", "cache_dir", "path"),
        "MD2CONF_LOCK_TIMEOUT_SECONDS": ("state", "lock_timeout_seconds", "float"),
        "MD2CONF_LOG_LEVEL": ("logging", "level", "str"),
        "MD2CONF_LOG_FORMAT": ("logging", "format", "str"),
    }
    result: dict[str, object] = {}
    for variable, (section, key, kind) in fields.items():
        if variable in environ:
            result.setdefault(section, {})
            section_value = result[section]
            assert isinstance(section_value, dict)
            section_value[key] = _parse_environment_value(variable, environ[variable], kind)
    return result


def _parse_environment_value(variable: str, value: str, kind: str) -> object:
    if kind in {"str", "path"}:
        return value
    if kind == "bool":
        normalized = value.casefold()
        if normalized in {"1", "true", "yes", "on"}:
            return True
        if normalized in {"0", "false", "no", "off"}:
            return False
        raise ValueError(f"{variable} must be a Boolean value")
    if kind == "int":
        try:
            return int(value)
        except ValueError as exc:
            raise ValueError(f"{variable} must be an integer") from exc
    if kind == "float":
        try:
            return float(value)
        except ValueError as exc:
            raise ValueError(f"{variable} must be a number") from exc
    raise AssertionError(f"unknown environment value kind: {kind}")


def _normalize_overrides(overrides: Mapping[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    aliases = {
        "base_url": "confluence.base_url",
        "parent_page_id": "confluence.parent_page_id",
        "auth": "confluence.auth",
        "username": "confluence.username",
        "vault_root": "source.vault_root",
        "publish_root": "source.publish_root",
        "state_path": "state.path",
    }
    for raw_key, value in overrides.items():
        key = aliases.get(str(raw_key), str(raw_key))
        if "." not in key:
            if isinstance(value, Mapping) and key in _PROFILE_SECTIONS:
                result[key] = _copy_mapping(value)
                continue
            raise ValueError(f"override {key!r} must be a known section or dotted field")
        parts = key.split(".")
        if len(parts) != 2 or parts[0] not in _PROFILE_SECTIONS:
            raise ValueError(f"invalid override path: {key!r}")
        section = result.setdefault(parts[0], {})
        assert isinstance(section, dict)
        section[parts[1]] = value
    return result


def _deep_merge(target: dict[str, object], incoming: Mapping[str, object]) -> None:
    for key, value in incoming.items():
        current = target.get(key)
        if isinstance(current, dict) and isinstance(value, Mapping):
            _deep_merge(current, value)
        elif isinstance(value, Mapping):
            target[key] = _copy_mapping(value)
        else:
            target[key] = value


def _copy_mapping(value: Mapping[str, object]) -> dict[str, object]:
    result: dict[str, object] = {}
    for key, item in value.items():
        result[str(key)] = _copy_mapping(item) if isinstance(item, Mapping) else item
    return result


def _resolve_paths(config: PublisherConfig, config_directory: Path) -> PublisherConfig:
    vault_root = _resolve_path(config.source.vault_root, config_directory)
    # Publish scope is the one path setting where empty, '.', and '/' are defined by
    # the compatibility contract as the vault root (rather than the filesystem root).
    if config.source.publish_root in {Path("."), Path("/")}:
        publish_root = vault_root
    else:
        publish_root = _resolve_path(config.source.publish_root, config_directory)
    if not _is_relative_to(publish_root, vault_root):
        raise ValueError("source.publish_root must be inside source.vault_root")
    state = config.state.model_copy(
        update={
            "path": _resolve_path(config.state.path, config_directory),
            "cache_dir": _resolve_path(config.state.cache_dir, config_directory),
        }
    )
    if state.cache_dir == vault_root:
        raise ValueError("state.cache_dir must not be the vault root")
    if _is_relative_to(state.path, state.cache_dir) or _is_relative_to(state.cache_dir, state.path):
        raise ValueError("state.path and state.cache_dir must not overlap")
    excludes = list(config.source.exclude)
    for hidden_path, is_directory in ((state.path, False), (state.cache_dir, True)):
        if not _is_relative_to(hidden_path, vault_root):
            continue
        relative = hidden_path.relative_to(vault_root).as_posix()
        pattern = f"{relative}/**" if is_directory else relative
        if pattern not in excludes:
            excludes.append(pattern)
    source = config.source.model_copy(
        update={
            "vault_root": vault_root,
            "publish_root": publish_root,
            "exclude": tuple(excludes),
        }
    )
    return config.model_copy(update={"source": source, "state": state})


def _resolve_path(value: Path, base: Path) -> Path:
    expanded = value.expanduser()
    if not expanded.is_absolute():
        return (base / expanded).resolve(strict=False)
    return expanded.resolve(strict=False)


def _validate_secret_mode(
    environ: Mapping[str, str],
    auth: object,
    pat_stdin: bool,
    password_stdin: bool,
    confluence: Mapping[str, object],
) -> None:
    pat_configured = (
        "MD2CONF_PAT" in environ or pat_stdin or confluence.get("pat_keyring") is not None
    )
    password_configured = (
        "MD2CONF_PASSWORD" in environ
        or password_stdin
        or confluence.get("password_keyring") is not None
    )
    if pat_configured and password_configured:
        raise ValueError("PAT and Basic password secret sources are mutually exclusive")
    if auth == "pat" and password_configured:
        raise ValueError("a password source cannot be used with PAT authentication")
    if auth == "basic" and pat_configured:
        raise ValueError("a PAT source cannot be used with Basic authentication")


def _validate_auth(config: ConfluenceConfig) -> None:
    if config.auth == "pat":
        if config.pat is None:
            raise ValueError("PAT authentication requires MD2CONF_PAT, --pat-stdin, or pat_keyring")
        if config.username is not None:
            raise ValueError("username is only valid with Basic authentication")
        if config.password is not None:
            raise ValueError("password is incompatible with PAT authentication")
    else:
        if config.username is None:
            raise ValueError("Basic authentication requires a username")
        if config.password is None:
            raise ValueError(
                "Basic authentication requires MD2CONF_PASSWORD, --password-stdin, "
                "or password_keyring"
            )
        if config.pat is not None:
            raise ValueError("PAT is incompatible with Basic authentication")


def _validate_auth_shape(config: ConfluenceConfig) -> None:
    if config.auth == "pat" and config.username is not None:
        raise ValueError("username is only valid with Basic authentication")
    if config.auth == "basic" and config.username is None:
        raise ValueError("Basic authentication requires a username")


def _normalize_base_url(value: str) -> str:
    if not value or any(char in value for char in "\r\n\x00"):
        raise ValueError("base_url is invalid")
    parsed = urlsplit(value)
    if parsed.scheme.casefold() not in {"https", "http"}:
        raise ValueError("base_url must use HTTPS")
    if not parsed.hostname or parsed.username is not None or parsed.password is not None:
        raise ValueError("base_url must have a host and must not contain user information")
    if parsed.query or parsed.fragment:
        raise ValueError("base_url must not contain a query or fragment")
    try:
        port = parsed.port
    except ValueError as exc:
        raise ValueError("base_url has an invalid port") from exc

    scheme = parsed.scheme.casefold()
    host = parsed.hostname.casefold()
    if scheme == "http" and not _is_loopback_host(host):
        raise ValueError("HTTP is permitted only for localhost or a loopback IP address")
    decoded_segments = [unquote(segment) for segment in parsed.path.split("/")]
    if any(
        segment in {".", ".."} or "/" in segment or "\\" in segment for segment in decoded_segments
    ):
        raise ValueError("base_url contains an unsafe encoded or traversal path segment")
    path = parsed.path.rstrip("/")
    if path.casefold().endswith(("/rest", "/rest/api")):
        raise ValueError("base_url must be the Confluence context, not a REST endpoint")

    display_host = f"[{host}]" if ":" in host else host
    default_port = (scheme == "https" and port == 443) or (scheme == "http" and port == 80)
    netloc = display_host if port is None or default_port else f"{display_host}:{port}"
    return urlunsplit((scheme, netloc, path, "", ""))


def _is_loopback_host(host: str) -> bool:
    if host.casefold() == "localhost":
        return True
    try:
        return ipaddress.ip_address(host).is_loopback
    except ValueError:
        return False


def _optional_string(value: object) -> str | None:
    if value is None or isinstance(value, str):
        return value
    raise ValueError("keyring reference must be a string")


def _is_relative_to(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
    except ValueError:
        return False
    return True


def _configuration_diagnostic(exc: Exception, path: Path) -> Diagnostic:
    if isinstance(exc, ValidationError):
        messages: list[str] = []
        for item in exc.errors(include_url=False, include_input=False):
            location = ".".join(str(part) for part in item["loc"])
            messages.append(f"{location}: {item['msg']}" if location else str(item["msg"]))
        message = "; ".join(messages)
    elif isinstance(exc, SecretResolutionError):
        message = str(exc)
    else:
        message = str(exc)
    return Diagnostic(
        code="CONFIG_INVALID",
        severity=Severity.ERROR,
        message=message,
        hint=f"Review {path}",
    )
