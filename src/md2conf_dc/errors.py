"""Stable application errors shared by CLI and future GUI adapters."""

from __future__ import annotations

from dataclasses import dataclass

from md2conf_dc.models import Diagnostic


@dataclass(eq=False)
class Md2ConfError(Exception):
    message: str
    code: str
    exit_code: int
    diagnostics: tuple[Diagnostic, ...] = ()

    def __str__(self) -> str:
        return self.message


class ValidationError(Md2ConfError):
    def __init__(
        self,
        message: str,
        *,
        code: str = "MD2CONF_VALIDATION",
        diagnostics: tuple[Diagnostic, ...] = (),
    ) -> None:
        super().__init__(message, code, 2, diagnostics)


class CompatibilityError(Md2ConfError):
    def __init__(self, message: str, *, code: str = "MD2CONF_COMPATIBILITY") -> None:
        super().__init__(message, code, 3)


class ConflictError(Md2ConfError):
    def __init__(self, message: str, *, code: str = "MD2CONF_CONFLICT") -> None:
        super().__init__(message, code, 4)


class SafetyError(Md2ConfError):
    def __init__(self, message: str, *, code: str = "MD2CONF_SAFETY") -> None:
        super().__init__(message, code, 5)


class StateError(Md2ConfError):
    def __init__(self, message: str, *, code: str = "MD2CONF_STATE") -> None:
        super().__init__(message, code, 6)


class AuthenticationError(CompatibilityError):
    def __init__(self, message: str, *, code: str = "MD2CONF_AUTH") -> None:
        super().__init__(message, code=code)


class PlanStaleError(SafetyError):
    def __init__(
        self,
        message: str = "The publish plan is stale; create and approve a new plan",
    ) -> None:
        super().__init__(message, code="MD2CONF_PLAN_STALE")


class ApprovalRequiredError(SafetyError):
    def __init__(
        self,
        message: str = "This operation requires approval of the exact plan digest",
    ) -> None:
        super().__init__(message, code="MD2CONF_APPROVAL_REQUIRED")
