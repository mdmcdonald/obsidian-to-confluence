# Confluence Data Center 9.2 codebase audit

**Audit date:** 11 July 2026

**Repository:** `obsidian-to-confluence`

**Target confirmed by the owner:** Confluence Data Center 9.2 LTS

**Scope:** architecture, REST/API compatibility, storage rendering, bulk-publish safety,
tests, dependencies, documentation, and redundant code.

## Executive assessment

The plugin has useful migration features and a strong set of pure conversion tests, but
its core is an abandoned Cloud-first ADF publisher wrapped by a custom Data Center HTTP
adapter. That split is the dominant source of risk.

The audit fixed several deterministic 9.2 incompatibilities: Data Center credentials now
pass publish validation, create and update operations emit storage format, unsupported
page archive behavior is gone, documented storage structures are used for tasks and
mentions, folder checks are segment-aware, relative Markdown link paths are preserved,
and Cloud URL replacement no longer mutates page content.

The implementation is **not yet safe for unattended destructive synchronization** of a
large corpus. The highest remaining concern is content ownership: a stale or malicious
`connie-page-id` can direct the inherited publisher outside the configured tree, and
orphan deletion currently proves only that the ID is numeric. Attachment reconciliation,
retry policy, synthetic folder identity, and the undocumented move workaround also need
replacement before claiming production-grade bulk synchronization.

## Documentation baseline

Confluence 9.2 is an Atlassian Long Term Support release. This audit uses versioned 9.2
documentation wherever Atlassian publishes it:

- [Confluence 9.2 release notes](https://confluence.atlassian.com/doc/confluence-9-2-release-notes-1456345480.html)
- [9.2 REST content resource](https://developer.atlassian.com/server/confluence/rest/v9214/api-group-content-resource/)
- [Confluence REST API examples](https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/)
- [9.2 storage format](https://confluence.atlassian.com/conf92/confluence-storage-format-1477576006.html)
- [9.2 attachment resource](https://developer.atlassian.com/server/confluence/rest/v9213/api-group-attachments/)
- [REST pagination](https://developer.atlassian.com/server/confluence/pagination-in-the-rest-api/)
- [9.2 labels](https://confluence.atlassian.com/conf92/add-remove-and-search-for-labels-1477575723.html)
- [Personal Access Tokens](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
- [9.2 macros](https://confluence.atlassian.com/conf92/macros-1477576130.html)
- [9.2 Page Properties macro](https://confluence.atlassian.com/conf92/page-properties-macro-1477576306.html)

The policy should be “support every maintained 9.2.x patch,” with behavior based on the
documented 9.2 contract. A future server-information probe should record the actual patch
and disable optional capabilities that are absent; it must not silently enable Cloud or
new-major-version endpoints.

## Current architecture

1. `main.ts` loads settings, constructs the Obsidian adaptor, Mermaid renderer, REST
   client, and either the stock or structured publisher.
2. `adaptors/obsidian.ts` discovers notes, builds the global title/link context, converts
   Obsidian syntax, derives labels, and calculates skip hashes.
3. `@markdown-confluence/lib` parses Markdown to Atlassian Document Format, resolves or
   creates pages, uploads attachments, updates labels, and writes `connie-*` frontmatter.
4. `MyBaseClient.ts` intercepts the inherited library's Cloud-shaped HTTP requests,
   converts outgoing ADF to storage XHTML, rewrites attachment methods, and polyfills
   response fields.
5. `StructuredPublisher.ts` mirrors private library behavior to build a folder tree and
   then applies a hierarchy workaround.
6. `main.ts` records path/page/hash state and optionally reports or trashes pages whose
   source path disappeared.

This creates two competing models: the inherited publisher reasons in Cloud-era ADF and
the adapter writes Data Center storage. Correctness therefore depends on private library
shapes and request interception rather than one owned, typed Data Center pipeline.

## Official 9.2 conformance matrix

| Area | Official 9.2 behavior | State after audit | Remaining work |
| --- | --- | --- | --- |
| Authentication | PAT is sent as `Authorization: Bearer`; Basic auth remains available | PAT/Basic settings now validate against the credentials actually used | Move secrets out of synced plugin data; require HTTPS except explicit local development |
| Base URL | REST paths are relative to the application base/context path | Trailing slashes are normalized and context paths are retained | Probe server info and use returned `_links` for all web URLs |
| Page create/update | REST v1 examples use `body.storage`; update increments `version.number` | Both POST and PUT content bodies are converted to storage; conversion fails closed | Remove ADF as an internal representation and XML-validate every page before write |
| Parent hierarchy | A content write supplies the intended ancestor/direct parent | Existing tree code still supplies inherited ancestor shapes | Own update payloads and send one verified direct parent |
| Move | No `/content/{id}/move/append/{targetId}` operation is documented in the 9.2 content resource | Existing workaround remains | Treat it as unsupported/experimental, then remove it in favor of documented ancestor updates |
| Delete | Deleting current content moves it to the space trash | `trash` uses content DELETE with a removal cap | Verify managed ownership, expected space, and allowed root before deletion |
| Page archive | Not a documented Data Center page-content operation | Removed; old `archive` settings migrate to report-only | None unless Atlassian documents a 9.2 page operation |
| Attachments | POST creates; POST `/{attachmentId}/data` updates; collections paginate | PUT is adapted to POST, but duplicate discovery parses English errors and lists only 200 | Page/query by filename first, select create/update deterministically, and store a reliable hash |
| Labels | 9.2 labels are lowercase, no spaces, limited special characters, max 255 | Derived taxonomy labels are slugified | Normalize all labels, enforce length, preserve label ownership instead of replacing hand labels |
| Tasks | Storage uses `<ac:task-list><ac:task>…` | Corrected and regression-tested | Add XML-schema/golden validation |
| Mentions | 9.2 storage uses `ri:userkey` | Corrected and regression-tested | Resolve human identifiers safely; do not accept arbitrary account IDs |
| Status | Stock macro accepts Grey, Red, Yellow, Green, or Blue | ADF values are mapped to documented colors | Define configurable fallbacks for unsupported colors |
| Code | Macro bodies use safe plain text/CDATA | Literal `]]>` is split safely | Validate control characters and oversized blocks |
| Optional math | `math`/`mathinline` are not stock 9.2 macros | Kept as an Appfire-dependent feature | Capability-gate and provide a stock image/plain-text fallback |
| Rate limiting | Recent 9.2 patches can rate-limit content operations | Static inter-batch delay only | Add timeouts, bounded retry, jitter, `Retry-After`, cancellation, and idempotency rules |

## Changes made during the audit

### Compatibility and correctness

- Added `DataCenterSettingsLoader.ts`, which validates the selected PAT or Basic mode,
  positive parent IDs, absolute HTTP(S) URLs, and context-aware base URLs. This removes a
  publish blocker caused by the inherited Cloud email/API-token validator.
- Converted ADF bodies on both content creation and update, and now refuse the write when
  local conversion fails instead of sending a representation known to be unreliable on
  Data Center.
- Removed unsupported page archive handling and migrated persisted `archive` selections
  to safe report-only behavior.
- Replaced arbitrary `/wiki/spaces/` body rewriting with a page-ID Data Center view URL.
- Corrected storage serialization for task lists, `ri:userkey` mentions, documented
  status colors, ordered-list starts, strike markup, emoji escaping, media widths, and
  CDATA terminators.
- Added a conversion-schema salt to the publish hash, intentionally forcing one
  republish so unchanged notes receive the corrected storage output.
- Made folder membership segment-aware, with empty or `/` consistently meaning vault
  root.
- Preserved relative paths when resolving Markdown `.md` links, avoiding wrong targets
  in vaults with duplicate basenames; Obsidian block references now fall back to the page
  without inventing a heading anchor.
- Expanded Markdown code protection to arbitrary backtick runs, longer fences, and
  indented code blocks.

### Cleanup and maintainability

- Consolidated duplicate publish result interfaces into `publishResults.ts`.
- Removed the empty plugin unload hook and redundant imports/ESLint suppression comments.
- Restored an ESLint 9 flat configuration and a runnable lint script.
- Added a separate TypeScript configuration so tests are type-checked instead of only
  having their annotations stripped by esbuild.
- Pinned the abandoned `@markdown-confluence/lib` to exactly `5.5.2` so a compatible
  build cannot drift under a caret range.
- Pinned the Obsidian build API version and moved Mermaid/type-only packages to
  development dependencies; the Mermaid import is type-only.
- Replaced the redundant `builtin-modules` package with Node's built-in module list,
  consolidated duplicate callout maps, and removed a tracked machine-local Claude
  permission file while ignoring it going forward.
- Replaced stale Cloud setup/refactor documentation with the Data Center support policy,
  limitations, and migration guidance.

## Open findings, prioritized

### P0 — Managed-content ownership is not enforced

Frontmatter `connie-page-id` takes the inherited page-ID path, which does not prove the
page is beneath the configured parent. The same unverified ID can later be moved or
trashed. A typo, copied frontmatter, stale state, or malicious note can overwrite content
outside the intended tree using the service account's permissions.

Required fix:

1. Assign every managed page a content property containing a schema version, tool ID,
   source-root ID, canonical source path/ID, and content fingerprint.
2. Before update, move, label mutation, attachment mutation, or deletion, fetch the page
   and verify property, space, root ancestry, and expected source identity.
3. Reject duplicate page IDs and duplicate source identities during preflight.
4. Adopt existing pages only through an explicit command and reviewable plan.

### P1 — Hierarchy relies on an undocumented move route

`StructuredPublisher.ts` calls `PUT /rest/api/content/{id}/move/append/{targetId}`. That
route is not present in the official 9.2 content resource. The inherited update also
supplies a root-first ancestor chain while Data Center needs a verified intended parent.

Own page creation/update in a Data Center client, send the direct parent through the
documented content payload, and delete the workaround. Until then, label it experimental
and never call it for an unowned or unsuccessfully published page.

### P1 — Attachment reconciliation is non-deterministic

The adapter waits for an English “same file name” failure, lists at most 200 attachments,
then retries a guessed existing attachment. Missing Cloud `metadata.comment` values are
polyfilled as empty strings even though the inherited library treats that field as the
hash, causing repeated uploads and inaccurate reports.

Resolve by paginated filename lookup before upload, compare a tool-owned digest, and
choose the documented create or data-update operation directly. Do not parse localized
error prose.

### P1 — Synthetic folder identity and scope can drift

Folder landing placeholders have fake paths and no persisted page IDs. The common path is
derived from the current file set, so adding or removing notes can shift hierarchy.
Unchanged landing notes may also be revisited per batch.

Root hierarchy at the configured publish scope, assign stable source IDs to folder pages,
persist them like notes, and include them in orphan planning and ownership checks.

### P1 — Network resilience is insufficient for hundreds of files

Requests have no explicit timeout, cancellation, bounded retry, jitter, or `Retry-After`
handling. A static delay between batches is not a retry strategy. Partial failures can
leave page body, labels, attachments, hierarchy, and local state inconsistent.

Use operation-specific retry rules, conservative concurrency, durable checkpoints, and a
resume command. Version-conflict writes must be re-read and re-planned, never blindly
retried.

### P1 — The ADF/storage interception layer should be retired

The application imports private package paths and mirrors private fields from an
unmaintained library. It creates and compares Cloud-era ADF while the adapter transforms
requests to storage at the boundary. Unknown ADF nodes can disappear while a publish is
reported successful, and the old Atlaskit dependency tree carries substantial security
and peer-dependency debt.

Replace it with an owned Markdown AST → typed page model → storage renderer → typed 9.2
REST client. The Python successor and its specification now live in the
[`md2conf` tool](https://github.com/mdmcdonald/theunderclass/tree/main/tools/md2conf).

### P1 — Credentials and transport need hardening

PATs/passwords are persisted in ordinary Obsidian plugin data, commonly under a synced
vault, and HTTP URLs are accepted. Integrate a keychain when available or accept secrets
from a session/environment provider; reject plaintext transport except an explicit
localhost development override. Document PAT scope and rotation.

### P2 — Labels can destroy manual taxonomy

The inherited publisher replaces page labels with the generated set. Normalize every
label to 9.2 rules and track which labels the tool owns so it adds/removes only that
managed subset. Preserve labels added by people or other automations.

### P2 — Mermaid rendering can exhaust resources or hide failures

SVG dimensions flow into canvas allocation without a maximum pixel count. A render error
produces a transparent 1×1 image and the page can still be reported successful. Clamp
dimensions, version cache keys by renderer/theme, and surface a visible fallback plus a
failed/warned operation result.

### P2 — UI lifecycle and diagnostics need consolidation

Every settings keystroke saves and reconstructs the publisher, page settings assume
frontmatter exists, four command handlers repeat similar publish/modal/error flows, and
reparent verification failures can be counted as applied. Debounce settings, share one
`runPublish` workflow, create frontmatter safely, and use typed operation outcomes.

## Dependencies and supply-chain review

The production audit is dominated by `@markdown-confluence/lib` and its obsolete Atlaskit
tree. The baseline `npm audit --omit=dev` reported **60 production findings: 2 low, 33
moderate, and 25 high**, with no critical findings. Moving build-only dependencies reduced
the final production report to **53: 2 low, 26 moderate, and 25 high**; the remaining high
risk is still dominated by the publisher/Atlaskit tree. The direct publisher finding has
no available compatible fix, so blindly running `npm audit fix` is not appropriate. The
durable remediation is dependency removal, not forced transitive upgrades.

The exact pin added in this audit improves reproducibility but does not make the package
safe. Lockfile changes and generated bundles should be reviewed like source code, and a
software-bill-of-materials plus dependency/license scan should be part of releases.

## Tests and quality gates

Baseline results before cleanup:

- `npm test`: 105 tests passed.
- `npm run build`: passed.
- `npm run lint`: failed before checking source because ESLint 9 had no flat config.
- `npm run prettier-check`: failed on 18 source files.

After the audit changes, the unit suite contains 117 passing tests, including new PAT and
Basic settings validation, folder boundary behavior, Data Center storage structures,
CDATA safety, relative Markdown paths, block references, longer fences, multi-backtick
code, and indented code. Source and test TypeScript, ESLint, and Prettier checks pass. The
final handoff records a fresh production build.

Important missing coverage:

- contract tests against a disposable Confluence 9.2 instance;
- PAT and Basic end-to-end publish tests, not validator-only tests;
- storage XML parsing/validation and larger golden fixtures;
- page create/update/version-conflict and direct-parent integration tests;
- paginated attachment create/update/deduplication tests;
- ownership escape, duplicate-ID, and destructive-plan rejection tests;
- interruption/resume, retry, timeout, 429, and partial-failure tests;
- scale tests for hundreds or thousands of notes and attachments;
- rendered-page visual acceptance fixtures.

The three unreferenced `docs/screenshots/*.png` files still depict the obsolete Cloud
settings UI. Replace them with Data Center 9.2 screenshots when a test instance is
available, or remove them in the next documentation-assets pass.

## Recommended implementation order

1. Add a typed server-info/capability probe and record the 9.2.x patch in every run.
2. Introduce managed content properties and block every unverified mutation.
3. Build a Data Center-native REST client with timeouts, pagination, retries, and typed
   errors.
4. Make storage format the only internal/API representation and validate XHTML locally.
5. Replace hierarchy moves with documented direct-parent page writes.
6. Rebuild attachment reconciliation around paginated lookup and managed digests.
7. Stabilize note/folder source identities and implement a reviewable dry-run plan.
8. Add checkpoint/resume and conservative bulk scheduling.
9. Remove the abandoned publisher/Atlaskit tree and duplicate command/UI flows.
10. Validate against a real 9.2 test instance with functional and visual golden fixtures.

The relocated [Python implementation specification](https://github.com/mdmcdonald/theunderclass/blob/main/tools/md2conf/docs/spec.md)
turns this order into a standalone CLI and reusable-library product plan, with parity as
the minimum and navigability/visual quality as first-class requirements.
