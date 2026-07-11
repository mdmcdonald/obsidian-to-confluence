from __future__ import annotations

from pathlib import Path

import pytest

from md2conf_dc.config import ConfigurationError, PublisherConfig, load_config
from md2conf_dc.secrets import REDACTED


def _write_config(path: Path, *, extra: str = "") -> None:
    path.write_text(
        """
[profiles.docs.confluence]
base_url = "https://example.test/confluence/"
parent_page_id = "123"
auth = "pat"

[profiles.docs.source]
vault_root = "."
publish_root = "Docs"

[profiles.docs.state]
path = ".state/state.json"
"""
        + extra,
        encoding="utf-8",
    )


def test_layered_config_normalizes_paths_and_redacts_secret(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf.toml"
    _write_config(path)

    config = load_config(
        path,
        profile="docs",
        environ={
            "MD2CONF_PAT": "do-not-leak",
            "MD2CONF_PARENT_PAGE_ID": "456",
        },
        overrides={"confluence.parent_page_id": "789"},
    )

    assert config.confluence.base_url == "https://example.test/confluence"
    assert config.confluence.parent_page_id == "789"
    assert config.confluence.pat is not None
    assert str(config.confluence.pat) == REDACTED
    assert config.redacted_dict()["confluence"]["pat"] == REDACTED  # type: ignore[index]
    assert config.source.vault_root == tmp_path
    assert config.source.publish_root == tmp_path / "Docs"
    assert config.source.publish_root_relative.as_posix() == "Docs"
    assert config.state.path == tmp_path / ".state/state.json"


def test_config_rejects_toml_secret_and_unknown_key(tmp_path: Path) -> None:
    secret = tmp_path / "secret.toml"
    _write_config(secret, extra='pat = "forbidden"\n')
    with pytest.raises(ConfigurationError) as caught:
        load_config(secret, profile="docs", environ={})
    assert "forbidden" in caught.value.diagnostics[0].message

    unknown = tmp_path / "unknown.toml"
    _write_config(unknown, extra="surprise = true\n")
    with pytest.raises(ConfigurationError):
        load_config(unknown, profile="docs", environ={"MD2CONF_PAT": "value"})


def test_http_requires_explicit_loopback_override(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf.toml"
    path.write_text(
        """
[profiles.local.confluence]
base_url = "http://localhost:8090/confluence"
parent_page_id = "1"
auth = "pat"
allow_http_localhost = true
""",
        encoding="utf-8",
    )
    config = load_config(path, profile="local", environ={"MD2CONF_PAT": "value"})
    assert config.diagnostics[0].code == "CONFIG_HTTP_LOOPBACK"

    path.write_text(path.read_text().replace("allow_http_localhost = true\n", ""))
    with pytest.raises(ConfigurationError):
        load_config(path, profile="local", environ={"MD2CONF_PAT": "value"})


def test_tls_verification_can_only_be_disabled_for_loopback(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf.toml"
    path.write_text(
        """
[profiles.docs.confluence]
base_url = "https://example.test/confluence"
parent_page_id = "1"
verify_tls = false
""",
        encoding="utf-8",
    )
    with pytest.raises(ConfigurationError, match="configuration is invalid") as caught:
        load_config(path, profile="docs", environ={"MD2CONF_PAT": "value"})
    assert "loopback" in caught.value.diagnostics[0].message

    path.write_text(
        path.read_text(encoding="utf-8").replace("example.test", "127.0.0.1"),
        encoding="utf-8",
    )
    config = load_config(path, profile="docs", environ={"MD2CONF_PAT": "value"})
    assert any(item.code == "CONFIG_TLS_VERIFICATION_DISABLED" for item in config.diagnostics)


def test_root_scope_and_custom_state_paths_are_normalized(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf.toml"
    path.write_text(
        """
[profiles.docs.confluence]
base_url = "https://example.test/confluence"
parent_page_id = "1"

[profiles.docs.source]
vault_root = "vault"
publish_root = "/"
write_back = "none"

[profiles.docs.state]
path = "vault/private/state.md"
cache_dir = "vault/private/cache"
""",
        encoding="utf-8",
    )
    config = load_config(path, profile="docs", environ={"MD2CONF_PAT": "value"})

    assert config.source.publish_root == tmp_path / "vault"
    assert "private/state.md" in config.source.exclude
    assert "private/cache/**" in config.source.exclude
    assert any(item.code == "CONFIG_IDENTITY_WRITEBACK_DISABLED" for item in config.diagnostics)


@pytest.mark.parametrize(
    "state_table",
    (
        'cache_dir = "vault"',
        'path = "vault/cache/mermaid/state.json"\ncache_dir = "vault/cache"',
    ),
)
def test_config_rejects_dangerous_cache_state_overlap(
    tmp_path: Path,
    state_table: str,
) -> None:
    path = tmp_path / ".md2conf.toml"
    path.write_text(
        f"""
[profiles.docs.confluence]
base_url = "https://example.test/confluence"
parent_page_id = "1"

[profiles.docs.source]
vault_root = "vault"

[profiles.docs.state]
{state_table}
""",
        encoding="utf-8",
    )
    with pytest.raises(ConfigurationError):
        load_config(path, profile="docs", environ={"MD2CONF_PAT": "value"})


def test_offline_config_validation_does_not_require_or_resolve_secret(tmp_path: Path) -> None:
    path = tmp_path / ".md2conf.toml"
    _write_config(path)

    config = load_config(path, profile="docs", environ={}, require_secrets=False)

    assert config.confluence.auth == "pat"
    assert config.confluence.pat is None
    with pytest.raises(ConfigurationError):
        load_config(path, profile="docs", environ={})


def test_public_config_schema_is_gui_safe_and_secret_free() -> None:
    schema = PublisherConfig.model_json_schema()
    confluence_ref = schema["$defs"]["ConfluenceConfig"]
    properties = confluence_ref["properties"]
    assert "pat" not in properties
    assert "password" not in properties
    assert "pat_keyring" in properties
    assert "password_keyring" in properties

    render_properties = schema["$defs"]["RenderConfig"]["properties"]
    publish_properties = schema["$defs"]["PublishConfig"]["properties"]
    assert render_properties["theme"]["const"] == "default"
    assert render_properties["breadcrumbs"]["const"] is True
    assert publish_properties["skip_unchanged"]["const"] is True
    assert publish_properties["batch_delay_ms"]["const"] == 0


def test_unimplemented_frontend_toggles_are_rejected_not_silently_ignored(
    tmp_path: Path,
) -> None:
    path = tmp_path / ".md2conf.toml"
    _write_config(
        path,
        extra="""

[profiles.docs.render]
breadcrumbs = false

[profiles.docs.publish]
skip_unchanged = false
""",
    )
    with pytest.raises(ConfigurationError):
        load_config(path, profile="docs", environ={"MD2CONF_PAT": "value"})
