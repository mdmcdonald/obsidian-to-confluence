[PRD]
# PRD: Python Markdown-to-Confluence Data Center 9.2 Publisher

## 1. Overview

Build a new Python implementation of the repository's Markdown-to-Confluence publisher as both a standalone command-line application and a reusable, typed library. The Python implementation must treat feature parity with the current Obsidian publisher as the floor, while replacing its Cloud-first ADF dependency and HTTP interception layer with a native Confluence Data Center 9.2.x publishing engine.

The product is intended for Obsidian vaults and ordinary Markdown repositories containing hundreds of files. It must publish navigable, polished Confluence knowledge bases rather than dump converted text. It therefore owns the full pipeline: source discovery, Obsidian-aware parsing, global link and title resolution, information architecture, storage-format generation, assets, labels, dry-run planning, safe remote reconciliation, resumable state, and reporting.

The implementation must use only officially documented Confluence Data Center 9.2 REST operations and the 9.2 XHTML-based storage representation. It must not inherit Cloud paths, ADF payloads, page archive calls, or undocumented move endpoints from the TypeScript implementation.

### 1.1 Audit-derived design imperatives

The current codebase establishes the required user-facing behavior, but its implementation exposes several risks that the Python design must remove:

- DC authentication must be validated independently; no Cloud API-token settings loader may be reused.
- Storage format is the only page-body representation. Conversion failure is fatal for the affected page; there is no ADF fallback.
- Parent changes use a normal content update with one direct parent in `ancestors`.
- Every update, reparent, label removal, attachment mutation, or trash operation requires positive ownership and scope proof.
- Page archive is not part of the supported DC 9.2 page contract. Orphans can be reported or moved to trash, never silently archived or purged.
- Attachments are reconciled by documented list/create/update-data endpoints, pagination, stable filenames, and explicit checksums, not localized error text.
- Folder identity and hierarchy are rooted at configured publishing scope, not the common path of the current batch.
- Markdown transformations operate on a parsed token/AST stream, so comments, links, math, and callouts cannot corrupt code spans or fences.
- Requests have bounded concurrency, timeouts, cancellation, retry classification, and ambiguous-write reconciliation.
- Credentials are never stored in repository config, state, frontmatter, logs, or command history.

### 1.2 Official contract baseline

The normative external references are:

- [Confluence 9.2 Long Term Support release notes](https://confluence.atlassian.com/doc/confluence-9-2-release-notes-1456345480.html)
- [Confluence Data Center 9.2.0 REST API](https://developer.atlassian.com/server/confluence/rest/v920/intro/)
- [9.2.0 Content Resource](https://developer.atlassian.com/server/confluence/rest/v920/api-group-content-resource/)
- [9.2.0 Attachments](https://developer.atlassian.com/server/confluence/rest/v920/api-group-attachments/)
- [9.2.0 Content Properties](https://developer.atlassian.com/server/confluence/rest/v920/api-group-content-property/)
- [9.2.0 Content Labels](https://developer.atlassian.com/server/confluence/rest/v920/api-group-content-labels/)
- [9.2.0 Server Information](https://developer.atlassian.com/server/confluence/rest/v920/api-group-server-information/)
- [Confluence Data Center 9.2 storage format](https://confluence.atlassian.com/conf92/confluence-storage-format-1477576006.html)
- [Confluence Data Center REST examples](https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/)
- [Using Personal Access Tokens in Atlassian Data Center](https://confluence.atlassian.com/enterprise/using-personal-access-tokens-1026032365.html)
- [Stock macros in Confluence Data Center 9.2](https://confluence.atlassian.com/display/CONF92/Macros)

The 9.2.0 REST snapshot is the compatibility floor for all 9.2.x patches. A feature introduced by a later 9.2 patch must be capability-gated and cannot become part of the baseline accidentally.

## 2. Goals

- Publish CommonMark/GFM and Obsidian-aware Markdown to valid Confluence 9.2 storage XHTML with deterministic output.
- Preserve current capabilities: PAT/basic auth, publish one/all/force, frontmatter inclusion and exclusion, title overrides, title deduplication, nested folders, landing files, links, comments, highlights, callouts, tables, images, Mermaid PNGs, Appfire LaTeX when available, metadata panels, taxonomy labels, batching, skip-unchanged, progress/results, and orphan handling.
- Add first-class, stock-9.2 presentation features where useful: panels, statuses, TOCs, children/page-tree navigation, expand, excerpts, Page Properties and reports, Content by Label, code, task lists, anchors, and page layouts.
- Produce stable information architecture: deterministic folder identities, generated landing/index pages, breadcrumbs, child indexes, final-title-aware links, and policy-driven labels.
- Provide a read-only plan/dry-run that exposes every intended remote mutation and a digest that can approve destructive work.
- Make repeat publishes idempotent and resumable after cancellation, timeout, or partial server failure.
- Detect remote edits and version races; default to conflict instead of overwriting human changes.
- Guarantee that unowned or out-of-scope content is never mutated, even when a stale or malicious page ID appears in frontmatter or state.
- Support several hundred documents and thousands of links/assets with bounded memory and server-friendly concurrency.
- Expose a stable typed async Python API with a thin CLI adapter.
- Make every supported behavior verifiable through golden, contract, fault-injection, and DC 9.2 integration tests.

## 3. Quality Gates

These commands must pass for every user story:

- `ruff check .`
- `ruff format --check .`
- `mypy --strict src tests`
- `pytest`

`pytest` configuration must enforce the agreed coverage threshold and include unit and mocked contract tests. Live Confluence certification tests are a separate gated suite because they require a licensed 9.2 environment.

## 4. User Stories

### US-001: Package and typed public surface

**Description:** As a Python user, I want an installable package and typed library API so that I can use the publisher from scripts without invoking the CLI.

**Acceptance Criteria:**

- [ ] A `src/md2conf_dc` package imports on every supported Python version and includes `py.typed`.
- [ ] `Publisher.plan()`, `Publisher.publish()`, `render_document()`, and configuration-loading entry points have fully typed public signatures and no public `Any`.
- [ ] The console entry point `md2conf` invokes only public application services rather than duplicating publishing logic.
- [ ] A wheel and source distribution build from `pyproject.toml`, and the wheel exposes the same package version through import metadata and `md2conf --version`.

### US-002: Layered configuration and secret resolution

**Description:** As an operator, I want profiles, environment overrides, and safe secret lookup so that local and CI publishing use the same declarative configuration without committing credentials.

**Acceptance Criteria:**

- [ ] Configuration precedence is CLI non-secret option > `MD2CONF_*` environment variable > selected TOML profile > documented default.
- [ ] PAT and password values can be read from environment, standard input, or an optional OS keyring reference; serializing effective config redacts them.
- [ ] Config validation rejects a secret in TOML, mutually exclusive auth modes, nonnumeric parent IDs, unknown keys, and an HTTP base URL except an explicit localhost development override.
- [ ] Base URLs with a Confluence context path normalize without removing that path or adding `/wiki` or `/rest` twice.

### US-003: Data Center authentication and compatibility preflight

**Description:** As an operator, I want a connection check against the target server so that publishing stops before discovery or writes when credentials or the release are wrong.

**Acceptance Criteria:**

- [ ] `md2conf doctor` authenticates with a Bearer PAT and with Basic username/password in separate contract tests.
- [ ] The command calls server information and current-user endpoints, reports server version/build and authenticated identity, and never prints the credential.
- [ ] Versions in the configured 9.2.x support range pass; Cloud responses, 9.1, 10.x, malformed server information, and redirects to another origin fail before a mutation.
- [ ] The parent page is fetched with space and ancestors, and preflight records its space key, root ID, and context-aware web URL.

### US-004: Source discovery and frontmatter compatibility

**Description:** As a vault owner, I want deterministic discovery with the existing `connie-*` controls so that the Python tool selects the same intentional source set.

**Acceptance Criteria:**

- [ ] Empty or `/` publish scope means the vault root, and folder matching is path-segment-aware (`Docs-old` is not inside `Docs`).
- [ ] Markdown files inside scope are included unless `connie-publish: false`; files outside scope are included only by `connie-publish: true` and receive a visible placement warning.
- [ ] Excalidraw sidecars, ignored globs, hidden state/cache paths, symlink escapes, and non-Markdown files are excluded according to documented rules.
- [ ] All legacy per-page keys are parsed and type-validated: `connie-publish`, `connie-title`, `connie-frontmatter-to-publish`, `tags`, `connie-page-id`, `connie-dont-change-parent-page`, `connie-blog-post-date`, and `connie-content-type`.
- [ ] Duplicate `connie-source-id` or `connie-page-id` values are fatal preflight errors naming every conflicting path.

### US-005: Global titles and link-resolution context

**Description:** As an author, I want every internal link to follow the final published title so that title overrides and collision suffixes never create dead links.

**Acceptance Criteria:**

- [ ] Title precedence is valid `connie-title` > configured first heading > filename stem, and a heading consumed as title is removed from the page body once.
- [ ] All effective titles are computed before rendering any page or batch.
- [ ] With deduplication off, duplicate page/folder titles fail preflight; with it on, every member receives a stable path-derived suffix and the plan reports each rename.
- [ ] Wikilinks, Markdown `.md` links, metadata relationships, breadcrumbs, and generated indexes use the final title map.
- [ ] Relative Markdown links resolve from the source directory before basename-style Obsidian fallback, including percent-decoded paths and duplicate basenames.

### US-006: Stable hierarchy and landing pages

**Description:** As a knowledge-base reader, I want the source hierarchy reflected in Confluence with useful landing pages so that large vaults remain navigable.

**Acceptance Criteria:**

- [ ] Hierarchy is rooted at configured publish scope and remains identical for full, single-file, skipped, and differently sized batch runs.
- [ ] A folder selects at most one landing source by documented, case-insensitive priority: `README.md`, `index.md`, then an eponymous file; ambiguous case-collisions fail preflight.
- [ ] A folder without a landing source gets a managed synthetic page with stable state identity and configured Children Display, Page Tree, or generated-link index content.
- [ ] Landing pages can append breadcrumbs, child navigation, and taxonomy indexes according to policy without duplicating the source title.
- [ ] A hierarchy update uses exactly one intended direct parent and never calls an undocumented move endpoint.

### US-007: Core Markdown-to-storage rendering

**Description:** As an author, I want standard Markdown rendered into deterministic DC storage markup so that pages preserve structure and formatting.

**Acceptance Criteria:**

- [ ] Golden tests cover paragraphs, headings 1-6, emphasis, strong, strike, highlight, inline code, links, horizontal rules, blockquotes, nested lists, non-1 ordered-list starts, code blocks, tables, and Unicode.
- [ ] Fenced code accepts arbitrary valid delimiter lengths; indented code and multi-backtick spans remain code; `]]>` in code produces well-formed XML.
- [ ] Task lists emit `ac:task-list`/`ac:task`/`ac:task-status`/`ac:task-body`, never a task nested in a normal `<ul><li>` wrapper.
- [ ] Every rendered storage fragment parses successfully inside a namespace wrapper and is deterministic under canonicalization.
- [ ] An unsupported AST node causes a page-level render error with source location instead of disappearing silently.

### US-008: Obsidian syntax and internal anchors

**Description:** As an Obsidian author, I want comments, wikilinks, embeds, callouts, highlights, and anchors handled without changing literal examples in code.

**Acceptance Criteria:**

- [ ] `%%...%%` comments are removed only from text tokens; equivalent text in inline, fenced, and indented code is unchanged.
- [ ] Wikilinks support aliases, same-page headings, cross-page headings, and block IDs; unresolved and unpublished targets follow configurable `warn`, `text`, or `fail` policy.
- [ ] Obsidian block IDs create stock Anchor macros at valid block boundaries, and `#^block-id` links target those anchors.
- [ ] Callouts map to stock info/note/tip/warning or Expand macros with title and rich body; unknown callout types use the configured stock fallback.
- [ ] Local image embeds support Obsidian width/height notation; note transclusions are diagnosed explicitly rather than misclassified as images.

### US-009: Typed stock macro directives

**Description:** As a technical author, I want a safe Markdown syntax for useful Confluence 9.2 macros so that I can create polished pages without raw storage XML.

**Acceptance Criteria:**

- [ ] The parser recognizes the documented `::: confluence:<name> {key=value}` container grammar outside code and produces typed directive nodes with source spans.
- [ ] Built-in renderers cover TOC, Children Display, Page Tree, Status, Expand, Excerpt, Excerpt Include, Page Properties Report, Content by Label, Anchor, stock panels, and supported layouts.
- [ ] Each macro accepts only its documented parameter names/types/enums; unknown macros or parameters fail validation unless policy explicitly selects a safe fallback.
- [ ] Bodyless macros reject non-whitespace bodies, rich-body macros recursively render Markdown, and nesting/depth limits are enforced.
- [ ] Raw ADF and arbitrary macro/storage injection are not required to use any supported stock macro.

### US-010: Page templates, themes, and policy hooks

**Description:** As an information architect, I want reusable policies for page chrome and navigation so that a corpus is consistent without repeating directives in every note.

**Acceptance Criteria:**

- [ ] Built-in `minimal`, `technical-doc`, and `knowledge-base` policies deterministically compose breadcrumbs, metadata/status, TOC, body, children/index, and footer navigation.
- [ ] Declarative rules can match normalized relative globs and validated frontmatter predicates to select a policy, layout, managed labels, TOC behavior, and child-index behavior.
- [ ] Themes change only typed semantic options such as panel kind, status color, table alignment, and image sizing; they cannot inject CSS, JavaScript, or storage XML.
- [ ] A strict `PagePolicy` protocol allows library callers to return typed decoration nodes, and third-party entry-point plugins load only with explicit allowlisting.
- [ ] Policy and plugin identities/versions participate in render hashes and appear in plan output.

### US-011: Metadata panels and managed label strategy

**Description:** As a knowledge manager, I want frontmatter projected into Page Properties and labels so that content is filterable and reportable without deleting labels people added manually.

**Acceptance Criteria:**

- [ ] The metadata panel covers current scalar, taxonomy, and relationship fields and renders a stock `details` Page Properties macro containing a headerless two-column table.
- [ ] Relationship values resolve by wikilink, filename, or frontmatter `id`, and unresolved values remain readable text with a diagnostic.
- [ ] Author `tags` and configurable `subject`/`type` taxonomy facets normalize deterministically, with provenance retained per label.
- [ ] Label reconciliation deletes only labels recorded as tool-managed in the ownership property; unrelated remote labels are preserved.
- [ ] Label pagination, additions, removals, normalization collisions, maximum lengths, and taxonomy-only hash changes have tests.

### US-012: Local and external image handling

**Description:** As an author, I want local images uploaded and external images referenced safely so that pages retain their visual content.

**Acceptance Criteria:**

- [ ] Local image paths resolve using Obsidian link rules but cannot escape the vault or configured asset roots through `..`, symlinks, or encoded traversal.
- [ ] Supported image formats have MIME type, byte size, checksum, dimensions, and alt text recorded in `AssetSpec`; unsupported or oversized assets fail before a page update.
- [ ] Storage uses `ac:image` with `ri:attachment` for managed local assets and `ri:url` for allowed HTTP(S) external images.
- [ ] External images are not downloaded by default, and non-HTTP schemes are rejected.
- [ ] Asset bytes and render-affecting dimensions participate in the page input hash.

### US-013: Bounded Mermaid rendering

**Description:** As an author, I want Mermaid fences rendered to cached PNG attachments so that diagrams work on stock Confluence without risking runaway browser memory.

**Acceptance Criteria:**

- [ ] Mermaid `low`, `medium`, and `high` quality profiles map to documented scales and deterministic filenames.
- [ ] The reference renderer runs with network access disabled, a timeout, maximum width/height/pixel count, and a fixed theme; violations fail the page visibly.
- [ ] Cache keys include diagram source, Mermaid version, renderer/backend version, theme, font inputs, scale, and output format.
- [ ] Rendering failure never substitutes a transparent or 1x1 success image.
- [ ] A fake renderer supports unit tests, and the reference backend has a pinned integration fixture.

### US-014: Capability-gated LaTeX and marketplace macros

**Description:** As an operator, I want optional marketplace macros explicitly declared with stock fallbacks so that a missing app cannot produce broken pages.

**Acceptance Criteria:**

- [ ] Inline and block math are parsed outside code and represented as typed math nodes.
- [ ] When the configured Appfire LaTeX capability is enabled, math renders to its configured `mathinline`/`mathblock` macro contract.
- [ ] When the capability is absent, policy selects either a stock inline/code-block fallback or a page-level failure; the selected fallback is visible in the plan.
- [ ] Optional marketplace macros are never inferred from Cloud behavior or emitted merely because their names appear in source.
- [ ] A capability probe, when requested, uses a safe conversion check and does not mutate a content page.

### US-015: DC-native page and blog publishing

**Description:** As an operator, I want documented create/read/update behavior using storage format so that publishing is compatible with Confluence DC 9.2.x.

**Acceptance Criteria:**

- [ ] Page creation and update payloads use `body.storage` with `representation: "storage"`; no payload or expansion contains `atlas_doc_format`.
- [ ] Updates fetch and increment `version.number`; page parent changes send one direct parent in `ancestors`; blog posts never send ancestors.
- [ ] Content type changes between page and blog post fail preflight.
- [ ] Response URLs are composed from `_links.base`/`_links.context`/`_links.webui` and never by rewriting `/wiki/spaces/` in content.
- [ ] A content readback after a write records the server's actual version and canonical storage hash.

### US-016: Managed ownership and explicit adoption

**Description:** As a Confluence owner, I want remote pages cryptographically tied to a vault/source identity so that a stale page ID cannot overwrite unrelated content.

**Acceptance Criteria:**

- [ ] Every managed page/folder/blog has a versioned `markdown-confluence.publisher` content property containing publisher, vault, source, root, space, kind, and managed-label identity.
- [ ] Before every mutation, the client re-fetches and verifies the marker, expected space, allowed root (for pages), source ID, and local mapping.
- [ ] A frontmatter page ID without a matching marker is treated as an adoption request and is never updated automatically.
- [ ] `md2conf adopt PATH PAGE_ID` produces a read-only verification plan and requires explicit approval before writing the marker.
- [ ] Adoption rejects duplicate IDs, out-of-root pages, wrong spaces, blog/page kind mismatches, and pages already owned by a different vault/source.

### US-017: Idempotent attachment reconciliation

**Description:** As an operator, I want attachments skipped or updated by checksum through documented endpoints so that unchanged assets are not uploaded on every run.

**Acceptance Criteria:**

- [ ] Attachment listing follows pagination or uses documented filename filtering and never assumes a 200-item ceiling.
- [ ] A missing filename uses the create-attachment POST; an existing managed filename with changed bytes uses `POST .../{attachmentId}/data`; an unchanged checksum performs no upload.
- [ ] `X-Atlassian-Token: no-check` is applied only where required and is covered by request-contract tests.
- [ ] Each managed attachment has a `markdown-confluence.asset` content property with asset/source/vault/checksum identity.
- [ ] An ambiguous upload response is reconciled by listing and validating filename/property/checksum before retry or failure; response-message text is never parsed for control flow.

### US-018: Read-only plan and dry run

**Description:** As an operator, I want a complete plan before publishing so that I can inspect creates, updates, moves, labels, assets, conflicts, and trash candidates.

**Acceptance Criteria:**

- [ ] `md2conf plan` and `md2conf publish --dry-run` perform no remote mutation and no durable state transition.
- [ ] Human and JSON output list each source ID/path, final title, content kind, intended parent, page ID if known, operation, reason, asset counts, managed-label delta, warnings, and conflicts without page bodies or secrets.
- [ ] The plan has a deterministic digest over source inputs, state generation, target identity, and observed remote versions.
- [ ] Applying a plan revalidates its observations; changed source/state/remote versions make it stale and require replanning.
- [ ] Destructive operations require the exact plan digest through interactive confirmation or a noninteractive approval option.

### US-019: Incremental, resumable state

**Description:** As an operator, I want a second run to be a no-op and an interrupted run to resume safely so that large publishes do not restart from zero.

**Acceptance Criteria:**

- [ ] State records source identity/path, page identity, desired input hash, server version/storage hash, parent, managed labels/assets, operation outcome, and target fingerprint.
- [ ] Page input hashes include source text, render-relevant frontmatter, resolved final link titles, asset bytes, render profile, policy/plugin versions, and storage contract version.
- [ ] State writes use a process lock and atomic temp-file/fsync/replace sequence; concurrent publishers fail before network writes.
- [ ] A successful second run produces zero content/attachment/label/property writes, while a manually deleted tracked page is detected by verification and planned for safe recreation.
- [ ] Pending and partial operations resume at the first uncommitted stage without repeating a proven-successful remote side effect.

### US-020: Batching, concurrency, retry, and cancellation

**Description:** As an operator of a large vault, I want bounded parallelism and fault-aware retries so that publishing is fast without overwhelming Data Center.

**Acceptance Criteria:**

- [ ] Parent/folder dependencies form a DAG; ready pages run under a configurable concurrency semaphore and reporting/checkpoints use configurable batch size/delay.
- [ ] Timeouts and retries are separately configurable for connect/read/write/pool, attempts, exponential cap, and jitter.
- [ ] GETs and reconciled version-safe operations retry on classified transient failures; `429` honors either form of `Retry-After`.
- [ ] Create/update/delete/attachment operations with an ambiguous outcome follow their documented read-after-write reconciliation and are never blindly repeated.
- [ ] SIGINT stops scheduling, lets in-flight reconciliation/checkpointing finish within a grace period, writes resumable state, and exits 130.

### US-021: Remote edit and version conflict protection

**Description:** As a Confluence editor, I want my manual changes detected so that automation does not overwrite them silently.

**Acceptance Criteria:**

- [ ] A remote version/storage hash that differs from the last successful readback produces a conflict before update even when the same service account made the edit.
- [ ] Version conflicts from concurrent updates trigger one re-fetch and desired-state comparison; desired content already present becomes success, unchanged old state can retry, and divergent state remains conflict.
- [ ] Default conflict policy is `fail`; an explicit overwrite policy appears prominently in the plan and still requires ownership/scope proof.
- [ ] Page-level conflicts do not prevent unrelated independent pages from completing unless `--fail-fast` is selected.
- [ ] Conflict reports include versions and hashes but never log remote or local page bodies.

### US-022: Ownership-safe orphan reconciliation

**Description:** As an operator, I want deleted/unpublished notes reported or trashed with strong safeguards so that a scope typo cannot remove a tree.

**Acceptance Criteria:**

- [ ] Orphans are evaluated only after a full authoritative discovery, never after a single-path publish.
- [ ] Default orphan action is report; supported actions are `off`, `report`, and `trash`; page archive and permanent purge are absent.
- [ ] Zero discovered sources with tracked entries suppresses trash, and a configurable maximum-trash cap converts an oversized destructive plan to report-only.
- [ ] Each trash candidate is re-fetched immediately before DELETE and must pass marker, vault/source, space, root, and plan-digest checks.
- [ ] DELETE omits `status=trashed`, so current content moves to trash rather than being purged; ambiguous results remain tracked until verified.

### US-023: Legacy migration and controlled frontmatter writeback

**Description:** As an existing plugin user, I want to import published-page state and preserve moving-note identity without silently claiming old pages.

**Acceptance Criteria:**

- [ ] `md2conf state import-obsidian` reads an explicit plugin-data path and scans compatible frontmatter into an unverified migration plan.
- [ ] Imported page IDs remain unowned until the operator approves adoption after space/root/identity checks.
- [ ] `write_back = "identity"` can add/update `connie-source-id`, `connie-page-id`, and `connie-publish` after a committed publish while preserving unrelated YAML data and formatting.
- [ ] `write_back = "none"` never edits Markdown and documents/diagnoses the resulting path-move limitation; `md2conf state move OLD NEW` safely repairs it.
- [ ] State schema migrations are ordered, backed up, atomic, locally reversible where possible, and never perform remote mutations implicitly.

### US-024: Structured reporting and observability

**Description:** As an operator, I want concise progress plus machine-readable outcomes so that interactive use and CI can diagnose partial publishes safely.

**Acceptance Criteria:**

- [ ] Every run has a run ID and emits start/finish, page-stage, retry, conflict, safety, and summary events through a typed event sink.
- [ ] Text progress goes to stderr; requested JSON report goes to stdout or a file with a versioned schema.
- [ ] Events include safe IDs, operation, duration, attempt, HTTP status, and outcome, but redact credentials, cookies, request/response bodies, source text, and sensitive frontmatter.
- [ ] Summary distinguishes created, updated, moved, unchanged, skipped, partial, failed, conflicted, reported-orphan, and trashed counts.
- [ ] Exit codes are stable and documented for success/no-op, partial failure, config/preflight, compatibility/auth, conflict, safety refusal, and cancellation.

### US-025: Validation and accessibility diagnostics

**Description:** As an author, I want local validation before writes so that malformed or inaccessible pages fail early with actionable locations.

**Acceptance Criteria:**

- [ ] `md2conf validate` performs discovery, frontmatter, link, macro, asset, hierarchy, and storage XML validation without needing Confluence unless `--online` is requested.
- [ ] Diagnostics carry stable codes, severity, source path, and line/column where available.
- [ ] Validation warns for missing image alt text, skipped heading levels, tables without a usable header, duplicate anchors, empty links/headings, and color-only statuses.
- [ ] Strict mode promotes configured warning codes to errors and is used by CI fixtures.
- [ ] Optional online validation uses documented content-body conversion with no content mutation and clearly labels server-render warnings.

### US-026: DC 9.2 contract and end-to-end certification

**Description:** As a maintainer, I want release-specific contract and live tests so that Cloud regressions or later-version assumptions cannot enter the supported build.

**Acceptance Criteria:**

- [ ] HTTP contract tests assert every used method/path/query/header/payload against 9.2.0 fixtures, including context-path installations and pagination.
- [ ] A test fails if code contains a Cloud `/api/v2` endpoint, `atlas_doc_format`, `/move/append/`, page archive call, or hard-coded `/wiki/spaces/` URL construction.
- [ ] Licensed test environments certify the earliest supported 9.2 patch and the selected current 9.2 maintenance patch for PAT and Basic auth.
- [ ] End-to-end fixtures cover create, no-op rerun, update, reparent, attachment update, label preservation, remote conflict, cancellation/resume, adoption, and report/trash safeguards.
- [ ] Rendered sample pages receive a documented visual review for stock macros, layout, navigation, code, tables, images, Mermaid, metadata, and accessibility.

## 5. Functional Requirements

### 5.1 Compatibility and connection

- **FR-001:** The tool must support Confluence Data Center 9.2.x and must check `GET /rest/api/settings/systemInfo` before any mutating run.
- **FR-002:** The tool must preserve a configured Confluence context path when joining every REST and web URL.
- **FR-003:** The tool must support PAT Bearer authentication and Basic username/password authentication through separate typed providers.
- **FR-004:** The tool must reject Confluence Cloud, unsupported server versions, cross-origin authentication redirects, and an unresolvable or unauthorized parent page before mutation.
- **FR-005:** The parent page defines the allowed page-tree boundary and its space defines the target space. The parent is not itself managed unless separately and explicitly adopted.
- **FR-006:** The normal execution path must use only the endpoint matrix in Section 12. Adding an endpoint requires an official 9.2 reference, contract fixtures, and an update to this PRD.

### 5.2 Discovery and source identity

- **FR-007:** Discovery must normalize paths as vault-relative POSIX paths for identity and comparison while using native paths only for filesystem access.
- **FR-008:** Scope tests must compare path segments, not string prefixes, and must never follow symlinks outside approved roots.
- **FR-009:** Publishability must honor `connie-publish` overrides and configured include/exclude globs in a documented precedence order.
- **FR-010:** Every source note and synthetic folder must have a stable UUID source ID. A valid `connie-source-id` wins; otherwise the state store allocates one and optional writeback persists it.
- **FR-011:** A page ID is a locator, not proof of ownership. State/frontmatter page IDs must be validated remotely before use.
- **FR-012:** Discovery must parse all render-affecting frontmatter and report type errors before network writes.

### 5.3 Information architecture

- **FR-013:** Final titles and the complete source/link index must be calculated over the authoritative source set before any document is rendered.
- **FR-014:** Folder hierarchy must be relative to configured publish scope and independent of batch contents, skipped pages, or common path calculations.
- **FR-015:** Note, folder, and generated-root titles must be unique within the target space or fail before create/update.
- **FR-016:** Folder landing source selection and synthetic-folder identity must be deterministic. Synthetic folders must be present in local state and remote ownership properties.
- **FR-017:** Generated navigation must use typed page-link nodes and final titles, and must never construct page URLs from assumed Cloud/DC routing patterns.
- **FR-018:** Policy may add breadcrumbs, a TOC, status, metadata, child index, taxonomy index, previous/next navigation, or footer, but page chrome order must be deterministic.
- **FR-019:** Blog posts belong to the target space but not the page hierarchy; they must never be used as folder parents.

### 5.4 Rendering

- **FR-020:** Markdown must be parsed once into a source-positioned intermediate document model. Obsidian transforms and policy decoration must operate on that model, not regex passes over protected/unprotected strings.
- **FR-021:** Storage rendering must escape element text, attributes, URLs, CDATA terminators, and macro parameters according to their output context.
- **FR-022:** Raw HTML must be escaped by default. Raw ADF is unsupported. Raw storage XML must not be accepted by the baseline implementation.
- **FR-023:** Local validation must wrap storage fragments with the official `ac` and `ri` namespaces, disable external entities/network access, parse them, and canonicalize deterministically.
- **FR-024:** Rendering must fail on an unknown atomic node or unsupported typed directive. Rendering children is not an acceptable silent fallback.
- **FR-025:** Macro rendering must use a 9.2 stock allowlist and per-macro parameter schema. Marketplace macro renderers require an explicit capability declaration and fallback policy.
- **FR-026:** Page input hashes must include all data capable of changing output, including image bytes and renderer/policy versions.

### 5.5 Planning and remote reconciliation

- **FR-027:** A publish must be generated from an immutable `PublishPlan` whose operations form a dependency DAG and whose digest covers observed state.
- **FR-028:** Dry-run/plan must perform no POST, PUT, or DELETE and must not advance durable local state.
- **FR-029:** New pages must be created with valid storage, recorded as pending, marked with an ownership property immediately, and only then receive dependent attachment/content/label stages.
- **FR-030:** Existing content must pass ownership, scope, kind, and drift checks immediately before its first mutation in a run.
- **FR-031:** Content updates must increment the observed version and, for movable pages, send exactly one direct parent in `ancestors`.
- **FR-032:** `connie-dont-change-parent-page: true` may suppress a parent change but may not bypass ownership, space, or root checks.
- **FR-033:** Remote equality must be based on readback version and canonical storage hash; service-account identity alone must never authorize overwriting divergent content.
- **FR-034:** Label sync must preserve labels outside the last recorded tool-managed set.
- **FR-035:** Attachment sync must select create versus update-data before uploading and must store checksum provenance in an attachment content property.
- **FR-036:** Each page stage must persist an operation outcome sufficient to resume without assuming the whole page transaction was atomic.

### 5.6 Scale and failure behavior

- **FR-037:** Local parsing/rendering may use bounded worker execution, but the default implementation must not hold all asset bytes or full remote bodies for the entire vault simultaneously.
- **FR-038:** Remote work must use separate configurable bounds for page concurrency, asset concurrency, batch checkpoint size, and optional inter-batch delay.
- **FR-039:** Every request must have connect, read, write, and pool timeouts and must accept cooperative cancellation.
- **FR-040:** Retry decisions must depend on HTTP method, status, exception phase, idempotency, and available reconciliation evidence.
- **FR-041:** `Retry-After` must take precedence over exponential backoff for 429/503 when valid; otherwise full jitter with a bounded cap applies.
- **FR-042:** No ambiguous POST/PUT/DELETE may be repeated until a read verifies that the desired effect did not occur.
- **FR-043:** Failure of one independent page must be isolated by default. A page with a failed required asset must not publish a body that references that missing asset.
- **FR-044:** Cancellation must stop scheduling, reconcile in-flight ambiguous operations, checkpoint, and return a resumable report.

### 5.7 Lifecycle and safety

- **FR-045:** Orphan detection must compare stable source IDs on a full authoritative run and must treat a moved path with the same source ID as a move, not a deletion.
- **FR-046:** Default orphan action must be `report`. `trash` must enforce zero-source guard, maximum count, plan approval, and per-page ownership revalidation.
- **FR-047:** The implementation must never call the page archive endpoint or permanently purge trashed content.
- **FR-048:** State target fingerprint mismatch must block publishing until an explicit state rebind/migration plan is approved.
- **FR-049:** Normal publishing must never adopt a title match, unmarked frontmatter ID, or legacy state record implicitly.
- **FR-050:** A failed ownership-property write on a newly created page must leave a pending recovery record; later runs may only recover it using the journal plus strict version/creator/space/root/title evidence, otherwise manual adoption is required.

### 5.8 Interfaces and reporting

- **FR-051:** CLI commands and library methods must return the same versioned models for diagnostics, plans, operations, and reports.
- **FR-052:** JSON output must be stable, machine-readable, and separated from human progress output.
- **FR-053:** Diagnostic codes and exit codes must be documented and backward-compatible within a major package version.
- **FR-054:** Logging content or HTTP bodies must remain disabled even at debug level; a separate explicit local render-artifact option may write sanitized storage to a requested directory.
- **FR-055:** All secrets and auth headers must be redacted before an event, exception, or HTTP trace reaches a log sink.

## 6. Non-Goals

- Confluence Cloud or Cloud REST v2 support.
- Confluence 9.0/9.1, 10.x, or Server editions as certified targets in the first major release.
- A replacement Obsidian graphical plugin, live editor integration, ribbon/status bar, or settings UI.
- Reverse synchronization, importing Confluence edits back into Markdown, or automatic three-way content merging.
- Creating spaces, changing permissions/restrictions, administering users, or managing watchers/comments.
- Updating the configured boundary parent unless it has been separately adopted as an ordinary managed source.
- Permanent deletion/purge, Cloud-style page archive, or automatic deletion of unrelated attachments.
- Trusting title matches or “last modified by the service account” as ownership.
- Executing arbitrary Python plugins, JavaScript, HTML, ADF, storage XML, or arbitrary macro names from untrusted Markdown.
- Complete Obsidian note transclusion or block rendering in phase 1; unsupported `![[Note]]` references must be explicit diagnostics.
- Backdating new blog posts through undocumented request fields. The legacy date key is retained for validation/identity; see Open Questions.
- Guaranteed rendering for an optional Marketplace app that has not been explicitly configured and certified.
- A long-running file watcher/daemon in the initial release; CI and scheduled callers invoke the CLI per run.

## 7. Support Matrix

| Surface | Supported baseline | Explicit boundary |
|---|---|---|
| Confluence | Data Center 9.2.0 through the current certified 9.2 maintenance patch | Other releases fail compatibility preflight unless a future package adds a tested contract profile |
| REST | `/rest/api` resources documented in the 9.2.0 snapshot | No Cloud `/api/v2`, ADF, archive-page, or undocumented move routes |
| Body | `body.storage`, representation `storage` | No `atlas_doc_format`; no fail-open conversion |
| Auth | PAT Bearer; Basic username/password | No Cloud email/API-token semantics; no cookie scraping |
| Deployment URL | Root or arbitrary same-origin context path | No hard-coded `/wiki`; no global URL string replacement |
| Content | Pages, synthetic folder pages, blog posts | Content kind cannot be converted in place; blog posts have no parent |
| Hierarchy | Direct-parent updates using `ancestors: [{"id": ...}]` | No ancestor chain payload; no move/append endpoint |
| Lifecycle | Report or move current owned content to trash | No page archive; no permanent purge |
| Storage features | 9.2 storage HTML/XML, stock macros and layouts enumerated in this spec | Later-patch stock features require a capability profile |
| Marketplace macros | Explicitly declared capability plus tested renderer/fallback | Never emitted optimistically |
| Python | CPython 3.11-3.13 on macOS, Linux, and Windows | Other implementations/versions are best-effort until CI coverage exists |
| Repository scale | Target 500 documents, 2,000 internal links, and 2,000 assets per run; test fixture extends to 1,000 documents | No promise of unbounded in-memory corpus size |

### 7.1 9.2.x patch policy

The source contract is the 9.2.0 REST snapshot and 9.2 storage documentation. CI contract fixtures target that floor. Before each release, a licensed certification job must exercise the earliest supported 9.2 patch available to the project and the nominated current 9.2 maintenance patch. A patch-specific behavior is represented by a named capability; `server.version.startswith("9.2.")` alone is not enough to enable it.

### 7.2 Forbidden compatibility shims

The Python implementation must have static tests preventing these strings/behaviors in production endpoint or payload code:

- `/wiki/api/v2`
- `/rest/api/content/archive`
- `/move/append/`
- `atlas_doc_format`
- `representation: "atlas_doc_format"`
- body-wide replacement of `/wiki/spaces/`
- sending an entire root-first ancestor chain on content update

## 8. Architecture

### 8.1 Processing pipeline

The system is a staged, dependency-injected publishing engine:

1. **Load and validate configuration** — resolve profile and secrets, normalize filesystem and Confluence targets, acquire the state lock.
2. **Compatibility preflight** — authenticate, identify server/current user, fetch boundary parent and target space, load capability profile.
3. **Discover** — enumerate eligible Markdown, parse safe YAML frontmatter, assign stable source identities, and hash referenced local assets.
4. **Index globally** — calculate final titles, folder nodes/landings, taxonomy IDs, outgoing references, anchors, and collision diagnostics over the full authoritative set.
5. **Parse and decorate** — build a source-positioned document IR, resolve Obsidian constructs, apply declarative policy/template/theme, and collect typed assets/macros.
6. **Render and validate** — render deterministic DC 9.2 storage fragments, XML-validate/canonicalize them, and compute complete page input hashes.
7. **Observe remote state** — resolve tracked pages, verify ownership/scope, compare versions/hashes, paginate labels/attachments where needed, and identify orphans.
8. **Plan** — produce an immutable operation DAG, warnings/conflicts, deltas, and digest. Stop here for `plan`/dry-run.
9. **Apply** — execute ready operations with bounded concurrency, ownership rechecks, retry/reconciliation rules, and page-stage checkpoints.
10. **Read back and commit** — capture actual remote versions/storage hashes, persist state atomically, optionally write identity frontmatter, and emit the final report.

No CLI, parser, renderer, or REST model may reach around this pipeline to mutate state or remote content directly.

### 8.2 Proposed package layout and responsibilities

| Module | Responsibility |
|---|---|
| `src/md2conf_dc/__init__.py` | Deliberate public exports and package version |
| `src/md2conf_dc/api.py` | Typed `Publisher`, sync convenience wrapper, and top-level render/validate functions |
| `src/md2conf_dc/models.py` | Cross-layer immutable domain models and enums; no HTTP or CLI dependencies |
| `src/md2conf_dc/config.py` | TOML profiles, environment precedence, validation, normalized effective config/redaction |
| `src/md2conf_dc/secrets.py` | PAT/Basic providers, stdin/keyring/environment lookup, redacted secret wrapper |
| `src/md2conf_dc/discovery.py` | Scope-aware walking, ignore rules, source identity, source/asset size limits |
| `src/md2conf_dc/frontmatter.py` | Safe YAML parsing, legacy/new key validation, controlled writeback |
| `src/md2conf_dc/index.py` | Final titles, note IDs, references, anchor index, collision handling |
| `src/md2conf_dc/hierarchy.py` | Stable folder tree, landing selection, generated folders, direct parents, navigation model |
| `src/md2conf_dc/markdown/parser.py` | CommonMark/GFM plus typed directive parsing into source-positioned IR |
| `src/md2conf_dc/markdown/obsidian.py` | Comments, wikilinks, block IDs, callouts, highlights, embeds, `.md` references |
| `src/md2conf_dc/markdown/ir.py` | Closed union of supported block/inline/directive nodes |
| `src/md2conf_dc/render/storage.py` | IR to DC storage nodes/string; stock macros, links, tables, tasks, layouts |
| `src/md2conf_dc/render/xml.py` | Namespace wrapping, safe parse, CDATA handling, canonicalization, storage hashes |
| `src/md2conf_dc/render/policy.py` | Built-in templates/themes, declarative rules, strict hook protocols |
| `src/md2conf_dc/assets/model.py` | `AssetSpec`, stable attachment filenames, checksum/provenance |
| `src/md2conf_dc/assets/images.py` | Local/external image resolution, MIME/dimensions/limits |
| `src/md2conf_dc/assets/mermaid.py` | Renderer protocol, reference backend, limits, versioned cache |
| `src/md2conf_dc/confluence/models.py` | Strict request/response DTOs for only the 9.2 fields used |
| `src/md2conf_dc/confluence/client.py` | Context-aware typed `httpx.AsyncClient` wrapper and endpoint methods |
| `src/md2conf_dc/confluence/pagination.py` | Generic start/limit/`_links.next` iterator with same-origin checks |
| `src/md2conf_dc/confluence/retry.py` | Retry classification, jitter, `Retry-After`, ambiguous-write reconciliation hooks |
| `src/md2conf_dc/confluence/urls.py` | Safe base/context/relative link joining; origin validation |
| `src/md2conf_dc/ownership.py` | Page/attachment property schemas, validation, adoption, mutation guard |
| `src/md2conf_dc/planner.py` | Remote observation, diffing, operation DAG, plan digest/staleness |
| `src/md2conf_dc/executor.py` | Bounded DAG scheduler, page-stage transaction, cancellation, checkpoints |
| `src/md2conf_dc/state/models.py` | Versioned state and operation-journal models |
| `src/md2conf_dc/state/store.py` | Lock, atomic persistence, backups, target fingerprint checks |
| `src/md2conf_dc/state/migrations/` | Pure ordered schema migrators and legacy import adapters |
| `src/md2conf_dc/events.py` | Typed events, redaction, text/JSON sinks, run summaries |
| `src/md2conf_dc/cli/app.py` | CLI root, global options, exception-to-exit-code mapping |
| `src/md2conf_dc/cli/commands/` | Thin `init`, `doctor`, `validate`, `render`, `plan`, `publish`, `adopt`, `state`, `cache`, and `note` adapters |

### 8.3 Dependency direction

- `models`, Markdown IR, renderer, discovery, hierarchy, and state schema are independent of CLI and HTTP.
- `confluence` depends on its wire models and event interface, never on CLI presentation.
- `planner` may read source/state/remote abstractions but performs no writes.
- `executor` is the only service authorized to invoke mutating client methods.
- The CLI may format domain results but may not alter plans or infer success from text.
- Test fakes implement protocols (`ConfluenceGateway`, `StateStore`, `MermaidRenderer`, `EventSink`, `Clock`, `Sleeper`, `RandomSource`) rather than monkeypatching internals.

### 8.4 Public library API

The primary API is asynchronous; a sync wrapper must refuse use from an already-running event loop rather than nesting one.

```python
from collections.abc import AsyncIterator, Sequence
from pathlib import Path
from typing import Protocol

class Publisher:
    @classmethod
    async def create(cls, config: PublisherConfig) -> "Publisher": ...
    async def doctor(self) -> DoctorReport: ...
    async def validate(self, selection: Selection = Selection.all()) -> ValidationReport: ...
    async def plan(self, selection: Selection = Selection.all()) -> PublishPlan: ...
    async def publish(
        self,
        plan: PublishPlan,
        *,
        approval: PlanApproval | None = None,
        cancellation: CancellationToken | None = None,
    ) -> PublishReport: ...
    async def events(self) -> AsyncIterator[PublishEvent]: ...

async def render_document(
    path: Path,
    *,
    context: RenderContext,
) -> RenderedPage: ...
```

`PublishPlan` is immutable. `publish()` accepts a plan rather than recomputing hidden decisions, then revalidates its state generation and remote observations before mutation.

### 8.5 Implementation dependencies

Preferred runtime components are:

- `httpx` for async HTTP, TLS, timeouts, streaming multipart, and connection limits.
- `markdown-it-py` plus narrowly selected `mdit-py-plugins` for CommonMark/GFM tokenization and custom typed containers.
- `ruamel.yaml` safe/round-trip modes for strict parse and controlled frontmatter writeback.
- `lxml` for namespace-aware safe parsing and canonical XML; entity/network resolution disabled.
- `pydantic` for strict config, state, report, ownership-property, and wire-boundary validation.
- `typer` and `rich` for the thin CLI while preserving plain/JSON noninteractive modes.
- `platformdirs` and `filelock` for cross-platform paths and process locks.
- Optional `keyring` for secret references and optional `playwright` for the reference Mermaid renderer.

Dependencies are implementation guidance, not permission to expose their models in the public domain API. Exact lower/upper bounds must be tested and recorded in the lock used for releases.

## 9. Domain and State Data Model

### 9.1 Core domain models

| Model | Required fields and invariants |
|---|---|
| `TargetIdentity` | Normalized base URL including context, server version/build, space key, positive root page ID, current user key/name; stable fingerprint excludes credentials |
| `SourceIdentity` | UUID `vault_id`, UUID `source_id`, normalized relative path, `note`/`folder` kind; no absolute path leaves local diagnostics |
| `FrontmatterSettings` | Typed legacy keys plus policy/template overrides; unknown `connie-*` keys are errors, ordinary unknown YAML is retained |
| `SourceDocument` | Identity, path, raw content digest, parsed frontmatter, title candidate, content type/date, references, discovered assets, diagnostics |
| `FolderNode` | Source identity, relative folder path, final title, direct parent source ID/root, optional landing source, ordered children, navigation policy |
| `DocumentIR` | Closed typed block/inline union with source spans; no arbitrary HTML/ADF/storage node |
| `PageSpec` | Source identity, final title/type, direct parent ID/source, storage value/hash, render/input hash, labels by provenance, assets, policy/capabilities |
| `AssetSpec` | Stable asset ID, kind, source path or allowed URL, attachment filename, MIME, bytes hash/size, dimensions/alt, render provenance |
| `RemoteContent` | Page ID/type/status/title/space, direct/root ancestors, version, storage hash/value when requested, links, ownership property/version |
| `OwnershipMarker` | Schema, managed flag, publisher, vault/source IDs, source kind/path, root ID, space, managed label set, last render hash/run |
| `AttachmentMarker` | Schema, publisher, vault/source/asset IDs, attachment filename, SHA-256, renderer provenance |
| `PlannedOperation` | Stable operation ID/type, source/page/asset refs, prerequisites, before/after summary, expected versions, retry/reconcile class, destructive flag |
| `PublishPlan` | Target fingerprint, source-set hash, state generation, observed remote versions, ordered operation DAG, conflicts/diagnostics, summary, digest |
| `OperationOutcome` | Operation/stage, attempts, timestamps/duration, status, safe error code/message, observed resulting IDs/version/hash |
| `PublishReport` | Versioned schema, run/plan IDs, target summary, counts, per-source outcomes, orphan summary, diagnostics, timings, retry statistics |

Identifiers crossing the REST boundary are validated as positive decimal strings. They remain strings in Python to avoid accidental numeric truncation or float serialization.

### 9.2 Ownership property

Each managed content entity uses property key `markdown-confluence.publisher` with a value shaped like:

```json
{
  "schema": 1,
  "managed": true,
  "publisher": "md2conf-dc",
  "vault_id": "a76b5ba6-cc17-4f66-a1c6-e6f0e1f95a83",
  "source_id": "dc3e7bc5-0832-44f1-9132-c80cb50a8250",
  "source_kind": "note",
  "source_path": "architecture/overview.md",
  "root_page_id": "12345",
  "space_key": "DOCS",
  "managed_labels": ["architecture", "subject-radar"],
  "last_render_sha256": "...",
  "last_run_id": "..."
}
```

Only a relative source path is stored remotely. A privacy policy may omit it, but `source_id` remains required. Property update requests must use the observed property version when the endpoint requires it. A property belonging to another vault/source is an ownership conflict, not an adoption candidate.

### 9.3 State schema

The initial state is JSON for transparent recovery and strict schema validation:

```json
{
  "schema_version": 1,
  "generation": 42,
  "tool_version": "1.0.0",
  "vault_id": "...",
  "target": {
    "base_url": "https://confluence.example.test/confluence",
    "space_key": "DOCS",
    "root_page_id": "12345",
    "fingerprint": "sha256:..."
  },
  "last_run": {"run_id": "...", "finished_at": "...", "status": "partial"},
  "entries": {
    "source-uuid": {
      "source_path": "architecture/overview.md",
      "source_kind": "note",
      "page_id": "45678",
      "content_type": "page",
      "parent_page_id": "34567",
      "input_sha256": "...",
      "remote_version": 8,
      "remote_storage_sha256": "...",
      "ownership_property_version": 3,
      "managed_labels": ["architecture"],
      "managed_assets": {"asset-uuid": {"attachment_id": "...", "sha256": "..."}},
      "last_successful_stage": "readback",
      "last_run_id": "..."
    }
  },
  "pending_operations": []
}
```

State never stores credentials, auth headers, source bodies, rendered storage bodies, attachment bytes, or remote response bodies. Diagnostic render artifacts are separate, opt-in, and never authoritative.

### 9.4 Input and remote hashes

- `source_sha256`: normalized source bytes plus render-relevant frontmatter.
- `asset_sha256`: raw local bytes or deterministic renderer output bytes.
- `input_sha256`: source hash + final title + final resolved links + labels + asset hashes + render settings + policy/theme/plugin/capability identities + target storage contract.
- `desired_storage_sha256`: canonicalized locally rendered storage.
- `remote_storage_sha256`: canonicalized storage read back after the last successful write.

`input_sha256` drives local incremental planning. `remote_version` plus `remote_storage_sha256` detects remote drift. These hashes serve correctness and identity; they are not described as cryptographic signatures of user intent.

## 10. Configuration and CLI Contract

### 10.1 Configuration file

Default config file is `.md2conf.toml` at the vault root. `--config` and `--profile` select alternatives. An illustrative profile is:

```toml
[profiles.docs.confluence]
base_url = "https://confluence.example.test/confluence"
parent_page_id = "12345"
target_release = "9.2"
auth = "pat"
verify_tls = true
connect_timeout_seconds = 10
read_timeout_seconds = 60
write_timeout_seconds = 120

[profiles.docs.source]
vault_root = "."
publish_root = "Documentation"
include = ["**/*.md"]
exclude = [".obsidian/**", ".md2conf/**", "**/*.excalidraw.md"]
first_heading_page_title = false
deduplicate_titles = true
preserve_folder_structure = true
outside_scope_placement = "root"
write_back = "identity"

[profiles.docs.render]
policy = "knowledge-base"
theme = "default"
metadata_panel = true
taxonomy_labels = true
unresolved_links = "warn"
raw_html = "escape"
toc = "auto"
breadcrumbs = true
child_index = "children"
mermaid_quality = "high"
max_image_bytes = 20971520

[profiles.docs.capabilities.appfire_latex]
enabled = false
fallback = "code"

[profiles.docs.publish]
page_concurrency = 4
asset_concurrency = 2
batch_size = 20
batch_delay_ms = 0
skip_unchanged = true
verify_skipped = true
conflict_policy = "fail"
orphan_action = "report"
max_trash_per_publish = 25
retry_attempts = 5
retry_cap_seconds = 30

[profiles.docs.state]
path = ".md2conf/state.json"
cache_dir = ".md2conf/cache"
lock_timeout_seconds = 0

[profiles.docs.logging]
level = "info"
format = "text"
```

Unknown keys are errors. Paths resolve relative to the config file. `init` creates `.md2conf/` and proposes an appropriate `.gitignore` entry but may modify `.gitignore` only with explicit confirmation.

### 10.2 Secrets and environment

Supported secret sources are:

- PAT: `MD2CONF_PAT`, keyring reference, or `--pat-stdin`.
- Basic username: non-secret config or `MD2CONF_USERNAME`.
- Basic password: `MD2CONF_PASSWORD`, keyring reference, or `--password-stdin`.

There is no `--pat VALUE` or `--password VALUE` option because it leaks through history/process inspection. Environment dumps and effective-config reports redact secret values. HTTPS is mandatory except `http://localhost`/loopback with both `allow_http_localhost = true` and a visible warning.

### 10.3 Commands

| Command | Behavior |
|---|---|
| `md2conf init` | Create config/state/cache skeleton, generate vault ID, show secret setup; no remote write |
| `md2conf doctor [--probe-macros]` | Auth/version/parent/context/TLS/capability diagnostics; no content write |
| `md2conf validate [PATH ...] [--online] [--strict]` | Parse/index/render/XML/accessibility/link validation |
| `md2conf render PATH [--format storage|json] [--output DIR]` | Render one source locally with diagnostics and asset manifest |
| `md2conf plan [PATH ...] [--all] [--offline] [--json]` | Read-only remote-aware plan and digest; omitted paths means full authoritative selection |
| `md2conf publish [PATH ...] [--all] [--force] [--dry-run]` | Plan and apply; path selection is nonauthoritative and cannot reconcile orphans |
| `md2conf resume [RUN_ID]` | Re-observe and resume pending operations from durable state |
| `md2conf adopt PATH PAGE_ID` | Read-only verification plan; `--approve-plan DIGEST` applies marker/state |
| `md2conf note enable|disable|set PATH ...` | Explicit round-trip-safe frontmatter changes corresponding to plugin commands |
| `md2conf state status|migrate|import-obsidian|move|rebind|backup` | State inspection and controlled migration/repair operations |
| `md2conf cache status|clear [mermaid|all]` | Cache management; never deletes state |

`publish --force` bypasses local unchanged decisions but not ownership, drift, validation, capability, or destructive approval checks. `--yes` may approve ordinary non-destructive work; destructive work requires an exact plan digest.

### 10.4 Stable exit codes

| Code | Meaning |
|---:|---|
| 0 | Success or verified no-op |
| 1 | Partial/page-level failure |
| 2 | Configuration, discovery, parse, render, or preflight validation failure |
| 3 | Authentication, TLS, target compatibility, or parent/space failure |
| 4 | Ownership, remote-edit, or concurrent-version conflict |
| 5 | Safety cap, missing destructive approval, or stale plan refusal |
| 6 | State lock, schema, target fingerprint, or migration failure |
| 130 | User cancellation/SIGINT after checkpoint attempt |

If multiple categories occur, the command returns the highest-priority safety/compatibility category documented in the report rather than an arbitrary last exception.

## 11. Rendering and Visual-Experience Contract

### 11.1 Page composition

Rendering is intentionally two-stage. Markdown first becomes semantic IR; a selected
page policy then composes that IR into a `PageSpec`. The default `knowledge-base` policy
uses this order:

1. breadcrumb/navigation row when the page is below the configured root;
2. optional status and Page Properties metadata block;
3. optional TOC when the body exceeds configured heading/word thresholds;
4. source body;
5. child-page or generated index section for landing pages;
6. optional related-content/taxonomy section;
7. previous/next or parent navigation footer.

The Confluence page title is the document's primary heading. A consumed Markdown H1 is
not repeated in the body; remaining body H1 headings are demoted or diagnosed according
to policy so pages do not present multiple indistinguishable top-level headings.

Generated chrome must be useful at the scale of the page. The default policy must not
add an empty TOC, children list, metadata table, related-content block, or footer. A page
with only a paragraph should remain visually quiet; a folder landing page with dozens of
children should emphasize scanning and navigation.

### 11.2 Stock macro and layout registry

The following features are in the first-release typed registry. Exact storage macro
names, parameter keys, allowed values, and body kinds must be captured from the official
9.2 macro/storage documentation in code-owned schemas and golden fixtures.

| Semantic node/directive | Stock 9.2 output intent | Default use |
|---|---|---|
| `Panel(info|note|tip|warning)` | Corresponding stock structured macro with rich body | Obsidian callouts and author directives |
| `Status(text, colour)` | `status`, limited to Grey/Red/Yellow/Green/Blue | Lifecycle/status metadata |
| `TableOfContents` | `toc` | Long technical pages |
| `ChildrenIndex` | `children` or generated typed page links | Folder landing pages |
| `PageTree` | `pagetree` | Optional root/section navigation, never on every leaf by default |
| `Expand(title, body)` | `expand` with rich body | Foldable callouts and secondary detail |
| `Excerpt(body)` | `excerpt` | Explicit reusable summary |
| `ExcerptInclude(page)` | `excerpt-include` with typed page reference | Curated landing content |
| `PageProperties(fields)` | `details` containing a two-column table | Structured frontmatter metadata |
| `PagePropertiesReport(query)` | `detailssummary` | Generated portfolio/status indexes |
| `ContentByLabel(labels)` | `contentbylabel` | Taxonomy landing pages |
| `Code(language, text)` | `code` with plain-text body and safe CDATA splitting | Fenced code |
| `Anchor(name)` | Stock anchor macro with validated local identifier | Obsidian block IDs/explicit anchors |
| `TaskList` | `ac:task-list` and task children | GFM/Obsidian tasks |
| `Layout(sections)` | `ac:layout`/section/cell storage elements with an allowlisted type | Policy-generated landing layouts |

Raw macro names are never accepted from Markdown. A directive name selects a registered
typed renderer. Stock registry entries are immutable for a given storage-contract
version; adding or changing one invalidates render hashes.

### 11.3 Directive examples

Examples are author-facing syntax, not literal storage XML:

```markdown
::: confluence:status {colour=Green}
Approved
:::

::: confluence:expand {title="Implementation detail"}
This body contains **normal Markdown**, links, tables, and code.
:::

::: confluence:children {depth=2 sort=title}
:::

::: confluence:content-by-label {labels="architecture,approved" operator=and}
:::
```

The parser must retain source spans for the container and each attribute. Quoting,
escaping, duplicates, invalid enums, and unknown attributes produce precise diagnostics.
Directive containers inside code remain literal examples.

### 11.4 Visual-quality rules

- Generated landing pages must show purpose/context before a child index. When no source
  landing text exists, a concise generated introduction names the section and child
  count; it must not pretend to be authored prose.
- Breadcrumbs and all indexes use typed Confluence page links, never guessed web URLs.
- Large child sets support deterministic grouping by direct subfolder or selected
  taxonomy; pagination/search macros are preferred over a single enormous bullet list.
- Panels communicate meaning and are not used as generic decoration. Nested panels are
  rejected or flattened with a diagnostic.
- Status colours carry text and may not be the only carrier of meaning.
- Tables require header semantics when Markdown supplies a header, preserve alignment,
  and remain ordinary tables rather than screenshots.
- Images require alt text or an explicit decorative flag. Width is clamped to policy and
  source dimensions; no page may contain a transparent “success” placeholder for a
  failed diagram.
- The generated page must remain readable when optional macros are disabled and when a
  theme is not present.
- Policy snapshot tests must bound macro density and generated-chrome size so a source
  page cannot be overwhelmed by navigation furniture.

## 12. Confluence Data Center 9.2 Endpoint Matrix

Only the gateway module may construct REST paths. This table is the baseline allowlist;
parameters and response fields are narrowed further by typed DTOs.

| Purpose | Method and relative path | Mutation rule |
|---|---|---|
| System information | `GET /rest/api/settings/systemInfo` | Preflight; response must identify Data Center/target compatibility and preserve returned base/context data |
| Current user | `GET /rest/api/user/current` | Preflight/auth identity |
| Resolve/read content | `GET /rest/api/content/{id}` with explicit `expand` | IDs encoded as path segments; expansions allowlisted |
| Search content | `GET /rest/api/content` or documented CQL search | Paginated, read-only; title matches never prove ownership |
| Create page/blog | `POST /rest/api/content` | Valid `body.storage`; page has one direct parent, blog has none |
| Update page/blog | `PUT /rest/api/content/{id}` | Observed version + 1; current ownership recheck; at most one intended direct parent |
| Trash current content | `DELETE /rest/api/content/{id}` | Full authoritative run, owned/in-scope page, safety cap, exact approved digest |
| List properties | `GET /rest/api/content/{id}/property` | Paginated when applicable |
| Read property | `GET /rest/api/content/{id}/property/{key}` | Ownership check input |
| Create property | `POST /rest/api/content/{id}/property` | Newly created/adopted owned entity only |
| Update property | `PUT /rest/api/content/{id}/property/{key}` | Observed property version when required |
| List attachments | `GET /rest/api/content/{id}/child/attachment` | Paginated; optional documented filename filter |
| Create attachment | `POST /rest/api/content/{id}/child/attachment` | Parent ownership rechecked; `X-Atlassian-Token: no-check` |
| Update bytes | `POST /rest/api/content/{id}/child/attachment/{attachmentId}/data` | Attachment identity/checksum and parent ownership verified first |
| List labels | `GET /rest/api/content/{id}/label` | Paginated |
| Add labels | `POST /rest/api/content/{id}/label` | Add only normalized desired labels |
| Remove one label | `DELETE /rest/api/content/{id}/label/{label}` | Remove only a label recorded as tool-managed |

All paths are joined below the normalized application base URL. Following redirects is
disabled for mutating requests. A read redirect is accepted only if it stays on the same
origin and within the same configured context; otherwise preflight fails.

The implementation must not rely on English error strings. HTTP status, structured
error fields, operation context, and reconciliation reads determine behavior. Response
fields not present in official 9.2 examples are optional until proven by contract tests.

## 13. Planning, Ordering, and Recovery Semantics

### 13.1 Operation DAG

A full plan contains stable operation IDs and explicit prerequisites. For a new page the
normal chain is:

```text
create page
  -> create ownership marker
  -> create/update required attachments
  -> update final storage body if attachment names/IDs affect it
  -> reconcile managed labels
  -> read back page/version/storage/property
  -> commit source entry
```

Parent folder create/ownership/readback operations are prerequisites of child page
creates. Independent subtrees may execute concurrently within bounds. Orphan operations
depend on every live source being successfully discovered and ownership-validated; they
never run merely because some pages published successfully.

For an existing page, observation and ownership checks are part of plan construction,
then repeated immediately before its first mutation. If the remote version, ownership
property version, parent, or canonical storage hash differs from the plan observation,
the operation becomes a conflict and the plan is stale.

### 13.2 Plan digest and approval

The plan digest is SHA-256 over canonical JSON containing target fingerprint, source-set
digest, state generation, every operation's stable ID/type/prerequisites, expected remote
IDs/versions, desired hashes, and destructive flags. It excludes timestamps, display
progress, secrets, and absolute local paths.

Destructive approval is `PlanApproval(plan_id, digest, approved_at, actor)` and applies to
that exact plan only. A replan after remote/source drift requires a new digest. Library
callers cannot bypass this by passing a Boolean.

### 13.3 Retry classification

- GET/HEAD may retry transport errors, 408, 429, and eligible 5xx responses within the
  attempt/time budget.
- A create POST with a lost response is ambiguous. Reconcile by source ownership marker,
  journal evidence, target/root/space/title, and bounded search before another create.
- A versioned content/property PUT with a lost response is reconciled by re-read and
  desired hash/property comparison before retry.
- Attachment create/update is reconciled by paginated filename plus attachment marker
  and checksum.
- DELETE is reconciled by content status/read. “Not found” is success only when the
  approved owned page was observed immediately before the delete.
- 400/401/403/404/409 are not generic retry statuses. Each has an explicit typed mapping;
  authentication, validation, scope, and version conflicts fail or replan.

### 13.4 State durability

State writes use a lock, write-to-sibling temporary file, file flush where supported,
atomic replace, and a retained last-known-good backup. The generation increments once per
committed checkpoint. A checkpoint never marks a stage successful until a readback or
unambiguous documented response supplies its resulting ID/version/hash.

`resume` does not replay pending operations blindly. It reloads config/source, verifies
the target fingerprint, observes every ambiguous/pending operation, reconstructs a new
plan, and relates new operations to the prior run for reporting.

## 14. Security and Safety Requirements

- YAML uses safe parsing with aliases/depth/document-size limits. XML parsing disables
  DTDs, external entities, XInclude, and network access.
- Filesystem resolution uses canonical paths and denies symlink/`..`/encoded escapes from
  the vault and configured asset roots.
- URLs are parsed structurally. Credentials, fragments, unsupported schemes, cross-origin
  redirects, and user-info components are rejected where inappropriate.
- HTTP response and attachment size limits are enforced while streaming. Compression
  expansion and decompression errors are bounded.
- Macro/directive, nesting, table, link, page, and attachment counts have configurable
  safe ceilings with conservative defaults.
- Logs never contain Authorization/Cookie headers, secret values, Markdown bodies,
  storage bodies, attachment bytes, or full server error HTML. Diagnostic snippets are
  length-bounded and escaped.
- `--json` writes only JSON to stdout; progress and human diagnostics go to stderr. This
  makes CI consumption deterministic and prevents mixed-output parsing.
- A zero-source full run, a publish root change, target fingerprint change, or unusually
  large orphan set is a hard safety event, not an invitation to continue with `--yes`.
- The default service-account guidance is least privilege to the intended space/tree.
  The tool does not claim application-level checks can compensate for an overprivileged
  credential.

## 15. Verification Strategy

### 15.1 Unit and golden tests

- Path discovery/scope, identity allocation, landing selection, titles, deduplication,
  link/anchor resolution, label normalization, policy selection, and state migrations.
- Markdown/Obsidian IR fixtures with source positions, including malformed and hostile
  input, arbitrary code delimiters, Unicode, nested tables/lists, and directive errors.
- One canonical storage fixture per IR node and stock macro, parsed inside the official
  namespace wrapper and compared after XML canonicalization.
- Property/state/plan JSON schema snapshots, plan digest stability, redaction, and exit
  code mappings.
- Retry timing with fake clock/random/sleeper and every ambiguous-write reconciliation
  branch.

### 15.2 Mock HTTP contract tests

Use `httpx.MockTransport` or an equivalent protocol fake with recorded, hand-reviewed 9.2
fixtures. Assert method, context-aware path, query, headers, multipart fields, request
body, version/ancestor shape, pagination, and typed response decoding. Tests must include:

- PAT and Basic auth, TLS/redirect failures, Cloud detection, wrong releases;
- create/update/readback, 409 version conflict, out-of-tree page and foreign property;
- attachment create/update/deduplication beyond one result page;
- label preservation and managed-only removal;
- 429 `Retry-After`, 5xx, timeout before/after send, cancellation, and lost responses;
- zero-source/orphan caps, stale plan digest, duplicate source/page IDs, and state rebind.

No test may assert correctness only by matching the implementation's own serializer
output; key wire fixtures require independent expected JSON/XML.

### 15.3 Live Confluence 9.2 certification

A gated suite runs against a disposable space under a disposable parent on a licensed
9.2 environment. It publishes a representative corpus, re-runs to prove no-op behavior,
modifies remote content to prove conflict handling, moves/deletes sources, exercises
attachments/labels, interrupts and resumes, and finally trashes only owned fixtures.

Certification records exact server/build, enabled optional apps, test package version,
and fixture digest. It must cover the 9.2 compatibility floor and the nominated current
9.2 maintenance patch before a release claims both.

### 15.4 Visual acceptance

The certification corpus includes short notes, long technical documents, nested folders,
dashboards, image-heavy pages, tables, tasks, callouts, code, Mermaid, and taxonomy
landing pages. Review or automated browser screenshots at standard desktop widths must
verify:

- clear hierarchy and working breadcrumbs/child indexes;
- no duplicate title heading, dead internal link, empty macro, or blank image;
- readable tables/code/panels and bounded diagram dimensions;
- consistent metadata/status/TOC placement under each built-in policy;
- acceptable pages when optional marketplace capabilities are absent;
- keyboard-reachable links and meaningful non-colour labels/alt text.

Storage equivalence alone is not sufficient for this gate: the user requirement is a
navigable, good visual experience in Confluence.

### 15.5 Scale and performance gates

The generated benchmark fixture contains at least 1,000 pages, 5,000 internal links, and
2,000 assets with controlled duplicates and hierarchy depth. CI or scheduled benchmarks
record discovery, parse/render, remote-plan simulation, peak RSS, operation count, and
state size. Acceptance targets for the 500-page supported profile are:

- local discovery/index/render completes in under 60 seconds on the documented reference
  runner, excluding Mermaid browser startup;
- peak local RSS remains under 1 GiB with asset streaming;
- a second unchanged plan performs no mutating calls and only the configured verification
  reads;
- no more than the configured page/asset concurrency is observable;
- cancellation checkpoints within 10 seconds after in-flight requests finish or time out.

Thresholds must be calibrated on the selected release runner and then treated as
regression budgets, not silently weakened when a test fails.

## 16. Delivery Plan and Dependencies

### Phase 0 — Contract fixtures and skeleton

Implement US-001 through US-003 foundations: package/CI, strict models/config/secrets,
9.2 endpoint fixtures, URL joining, auth, server/current-user/parent doctor, and redaction.
Exit requires zero mutating endpoints and a passing doctor against 9.2.

### Phase 1 — Local semantic renderer

Implement US-004 through US-015 local portions: discovery, identities, global index,
stable hierarchy/landing pages, Markdown/Obsidian IR, storage XML, stock directives,
policies, labels, images, bounded Mermaid, and optional-macro fallbacks. Exit requires
golden XML and visual fixture review with no Confluence writes.

### Phase 2 — Read-only remote planner

Implement page/property/attachment/label reads, pagination, managed ownership schema,
legacy import/adoption planning, remote drift detection, immutable operation DAG, plan
digest, JSON report, and `plan --dry-run`. Covers US-016 through US-019 planning behavior.

### Phase 3 — Safe apply and resume

Implement create/update/property/attachment/label mutations, direct parents, readback,
checkpoints, bounded executor, retry/reconciliation, cancellation, resume, and conflict
handling. Destructive orphan action remains report-only until all non-destructive live
certification tests pass.

### Phase 4 — Lifecycle and bulk certification

Enable digest-approved trash with ownership revalidation and caps, complete legacy state
migration, run fault injection and 500/1,000-page scale tests, and pass visual acceptance
on the supported 9.2 patch range. This is the earliest production 1.0 release candidate.

### Phase 5 — Extensibility after 1.0

Add additional certified stock directives, allowlisted third-party policy/render plugins,
and optional marketplace capability packages. No extension may weaken ownership,
validation, endpoint allowlisting, or plan approval.

Dependencies are ordered: remote writes depend on a deterministic validated renderer and
ownership model; orphan trash depends on full-source identity and a certified apply path;
optional visual features depend on stock fallbacks. Parallel teams may work within a
phase only behind the relevant typed protocols and fixtures.

## 17. Migration from the Obsidian Plugin

`md2conf state import-obsidian` reads a copied/exported plugin state file and source
frontmatter; it never reads Obsidian secrets. Legacy page IDs become **unverified
candidates**. Import produces a plan that, for each candidate, reports page kind/title,
space, ancestry, version, marker status, duplicate use, and proposed source ID.

An existing plugin-created page can be adopted only when the operator supplies the exact
approved adoption-plan digest. Adoption writes the ownership property and local state but
does not overwrite the page body in the same operation. The next normal plan compares
remote storage and asks for conflict policy if it differs from the newly rendered source.

Frontmatter compatibility aliases must include the keys observed in the TypeScript
implementation. The importer preserves unrelated YAML and comments through round-trip
editing. Default writeback is identity only (`connie-source-id` and, after successful
ownership readback, `connie-page-id`); `--no-writeback` keeps all mapping solely in state.

The generated migration report groups pages into safe match, explicit adoption required,
duplicate/ambiguous, outside scope, missing, wrong kind/space, and already owned by
another source. There is no “adopt all title matches” shortcut.

## 18. Risks and Mitigations

| Risk | Consequence | Mitigation |
|---|---|---|
| Official Swagger prose/actual 9.2 response differences | Strict DTO rejects legitimate fields or misses a behavior | Allow unknown response fields at the wire boundary while requiring used fields; keep exact-patch live fixtures |
| Editor normalizes storage after write | False remote-drift conflicts | Canonicalize readback and compare semantic/tool-owned regions; certify fixtures on 9.2 |
| Human edits a fully managed page | Accidental overwrite or permanent conflict | Remote version/storage hash conflict by default; explicit rebase/adopt workflow, no identity-based overwrite |
| Create succeeds but property write fails | Stray unmarked page | Durable pending journal and strict recovery evidence; never infer ordinary ownership |
| Optional macro app changes identifiers/parameters | Broken/blank content | Explicit capability package/version, probe fixture, stock fallback, hash participation |
| Mermaid browser is heavy or unavailable in CI | Slow/failing diagram publish | Renderer protocol, bounded subprocess, cache, deterministic external-render option, visible code fallback |
| Huge assets/Markdown or malicious nesting | Resource exhaustion | Streaming, size/count/depth/pixel ceilings and early validation |
| Label reconciliation removes human taxonomy | Information loss | Property-recorded managed label set and remove-only-owned rule |
| Folder/title policy changes reorganize hundreds of pages | Navigation churn and risky moves | Global dry-run, rename/move summary, plan digest, configurable change-count approval threshold |
| 9.2 maintenance patch introduces rate limiting/behavior change | Partial large-run failure | Patch certification, `Retry-After`, checkpoints, resumable idempotent stages |

## 19. Open Decisions Before Implementation

These choices do not block this specification, but Phase 0 must record the selected
defaults and fixtures:

1. Confirm the exact earliest 9.2 maintenance patch available for automated live
   certification; 9.2.0 remains the documented contract floor.
2. Decide whether the distribution name and CLI remain `md2conf-dc`/`md2conf` or use a
   project-specific name before publishing package metadata.
3. Select the default state/writeback policy for teams that do not want frontmatter
   mutation. The proposed default is state plus identity-only writeback.
4. Validate, from official 9.2 documentation and a live fixture, whether legacy
   `connie-blog-post-date` can be honored on create/update without undocumented fields;
   otherwise diagnose it and publish with server time only.
5. Choose the first reference Mermaid backend (local Playwright, external executable, or
   both) and its supported installation story on Windows/macOS/Linux.
6. Confirm the exact stock macro parameter schemas and layout types enabled in the
   default registry; uncertain parameters stay disabled until certified.
7. Choose calibrated default thresholds for TOC generation, child-index grouping,
   maximum page/storage size, attachments, hierarchy change count, and visual screenshots.

## 20. Definition of Done for Version 1.0

Version 1.0 is complete only when:

- all US-001 through US-026 acceptance criteria are implemented or explicitly moved to a
  later signed specification with no safety-critical item deferred;
- all quality gates in Section 3 pass on Python 3.11, 3.12, and 3.13 across the supported
  operating systems;
- the endpoint allowlist has a direct official 9.2 reference and reviewed request fixture
  for every method/path;
- the forbidden Cloud/ADF/archive/move behaviors have static and runtime tests;
- full, single-path, forced, unchanged, interrupted, resumed, conflicted, adopted, moved,
  and deleted-source workflows pass mock contracts and live 9.2 certification;
- no mutation can be reached without target, scope, ownership, and current-plan checks;
- an unchanged second publish makes zero mutating calls;
- a 500-page representative corpus passes scale and visual acceptance;
- build artifacts include typed API docs, CLI reference, config schema, migration guide,
  operator safety guide, support matrix, changelog, hashes/SBOM, and reproducible lock;
- a recovery exercise proves state backup, ambiguous-operation reconciliation, and resume
  after forced termination;
- release notes state the exact certified 9.2 patches and optional macro-app versions.

[PRD]
