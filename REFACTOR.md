# Modernization roadmap

The original refactor notes described a Cloud-era build repair and are no longer the
source of truth. This fork now targets **Confluence Data Center 9.2 LTS**.

Use these maintained documents instead:

- [Codebase audit](docs/codebase-audit.md) — verified 9.2 API mismatches, resolved items,
  remaining risks, dependency findings, and recommended implementation order.
- [Relocated Python implementation specification](https://github.com/mdmcdonald/theunderclass/blob/main/tools/md2conf/docs/spec.md) —
  the Data Center-native CLI and reusable-library replacement plan.

The strategic direction is to retire the abandoned `@markdown-confluence/lib`, use
Confluence storage format end to end, own page/attachment/label reconciliation, and
enforce managed-content ownership before every mutation.
