"""Typed public API for md2conf-dc."""

from importlib.metadata import PackageNotFoundError, version

try:
    __version__ = version("md2conf-dc")
except PackageNotFoundError:  # pragma: no cover - editable source without metadata
    __version__ = "0.1.0"

from md2conf_dc.api import (
    Publisher,
    PublisherDependencies,
    SyncPublisher,
    load_publisher_config,
    render_document,
)
from md2conf_dc.models import (
    CancellationToken,
    Diagnostic,
    DoctorReport,
    PlanApproval,
    PublishPlan,
    PublishReport,
    RenderContext,
    RenderedPage,
    Selection,
    ValidationReport,
)

__all__ = [
    "CancellationToken",
    "Diagnostic",
    "DoctorReport",
    "PlanApproval",
    "PublishPlan",
    "PublishReport",
    "Publisher",
    "PublisherDependencies",
    "RenderContext",
    "RenderedPage",
    "Selection",
    "SyncPublisher",
    "ValidationReport",
    "__version__",
    "load_publisher_config",
    "render_document",
]
