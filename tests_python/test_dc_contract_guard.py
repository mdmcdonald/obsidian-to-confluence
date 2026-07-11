from pathlib import Path

import pytest


@pytest.mark.parametrize(
    "forbidden",
    [
        "/wiki/api/v2",
        "atlas_doc_format",
        "/rest/api/content/archive",
        "/move/append/",
        'representation": "atlas_doc_format',
    ],
)
def test_python_implementation_contains_no_cloud_or_undocumented_contracts(
    forbidden: str,
) -> None:
    root = Path(__file__).parents[1] / "src" / "md2conf_dc"
    production = "\n".join(
        path.read_text(encoding="utf-8")
        for path in root.rglob("*.py")
        if path.name != "__init__.py"
    )
    assert forbidden not in production


def test_trash_request_does_not_request_permanent_purge() -> None:
    client = (
        Path(__file__).parents[1] / "src" / "md2conf_dc" / "confluence" / "client.py"
    ).read_text(encoding="utf-8")
    assert 'params={"status": "trashed"}' not in client
    assert 'params={"status":' not in client
