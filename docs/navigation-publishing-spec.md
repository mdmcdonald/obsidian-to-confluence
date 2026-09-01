# Navigation publishing features — implementation specification

**Status:** Ready for implementation, 2026-09-01
**Target:** `obsidian-to-confluence` v5.8.x (Obsidian plugin, Confluence Data Center 9.2, wrapping the pinned `@markdown-confluence/lib@5.5.2`)
**Driving use case:** publishing the `Knowledge/` folder of the Engineering-knowledge-vault (about 2,700 pages after exclusions, 222 folders) as a page tree that a reader can navigate by clicking alone. The companion content specifications live in `engineering-tools/docs/specifications/knowledge-navigation-content.md` and `knowledge-navigation-tooling.md`.

This document is written so an implementing agent can work from it without the review that produced it. Every feature names the files to change, the settings it adds, the behaviour, the edge cases, and the tests to add. Features are ordered by priority; F1 to F6 are required before the first bulk publish, F7 to F9 before the publish is left unattended, F10 to F12 are optional.

## 0. Ground rules

1. **Do not modify `@markdown-confluence/lib`.** All behaviour lives in `src/`. Where the library must agree with the plugin (page titles), feed it through the frontmatter it already reads (`connie-title`).
2. **Pure logic in dependency-free modules, tested under `tests/` with `node:test` and `node:assert/strict`**, matching `tests/folderTree.test.ts`. Obsidian-dependent code stays thin. `npm test`, `npm run lint`, `npm run prettier-check`, `npm run typecheck` and `npm run build` must pass; the committed `main.js` is rebuilt.
3. **Every new setting has a default that preserves current behaviour.** New behaviour is opt-in through `ConfluenceSettingTab.ts`. Settings are added to `ObsidianPluginSettings` in `main.ts` and to the `DEFAULT_SETTINGS` block.
4. **Changing conversion semantics bumps `PUBLISH_HASH_SCHEMA_VERSION`** in `adaptors/obsidian.ts` (currently `dc-storage-v2`) so skip-unchanged republishes affected pages. F1, F2, F5 (folder links), F7 and F9 all change rendered output; bump once to `dc-storage-v3` when the batch lands.
5. **Diagnostics are data, not console lines.** Anything a user must act on goes into `UploadResults` (`publishResults.ts`) and the `CompletedModal`, and into the dry-run report (F6).
6. **Confluence page titles are the navigation labels.** Titles must be unique in the space, human-readable, and taken from the author's frontmatter wherever it exists.

## 1. Vocabulary

- **Publish set:** the files `isPublishable()` accepts. Today: inside `folderToPublish` and not `connie-publish: false`, or anywhere with `connie-publish: true`. F3 adds exclusion globs.
- **Landing file:** the file promoted to a folder's page (`deriveStructure` in `folderTree.ts`): a file whose stem is `index` or `readme`, else a file named like its folder.
- **Final title:** the title a page is published under after precedence and deduplication, held in `publishTitleByPath`.
- **Container folder:** a folder with no landing file; today it gets a blank page holding a Page Tree macro (`FolderFile.js`).

## 2. Current behaviour the features change

| Area | Today | After |
|---|---|---|
| File title | basename, or first H1 when `firstHeadingPageTitle`; `connie-title` overrides via the library | `connie-title` › frontmatter `title` › first H1 › basename, per `titleSource`; first H1 optionally consumed |
| Folder title | folder segment name, parent-qualified on collision; landing file's title discarded | landing file's resolved title › display map › segment; collision qualification kept as fallback |
| Landing selection | first of `index`/`readme` found in vault order | explicit priority `index.md` › `README.md` › eponymous; both present is a diagnostic |
| Exclusion | per-file `connie-publish: false` only | glob list in settings and/or a vault-relative list file |
| Ambiguous wikilink | Obsidian's first match; if unpublished, plain text | prefer a publishable file with the same stem; diagnostic either way |
| Folder links, asset links | left as dead relative `href` | folder link resolves to the folder page; asset link attaches, rewrites to a base URL, or falls back to text |
| Link failures | `console.log` only | counted per page, surfaced in the modal and in a dry-run report note |
| Root landing | never promoted; becomes a child page | optionally becomes the configured parent page's body |
| Labels | `tags` verbatim, optional `subject` and `type` slugs; page labels replaced wholesale | normalised, vocabulary-filtered, plugin-owned labels only removed |
| Failures at scale | no retry; state persisted at the end of the run | bounded retry on 429/5xx; state checkpointed per batch |
| LaTeX | Appfire macros only | fallback rendering when the macros are absent |

## 3. Features

### F1. Title resolution for files

**Files:** `src/adaptors/obsidian.ts` (`computePublishContext`, `loadMarkdownFile`, new helper `resolveTitle`), `src/main.ts` (settings), `src/ConfluenceSettingTab.ts`.

**Settings**

```ts
titleSource: "frontmatter" | "first-heading" | "filename";   // default "filename" (current behaviour)
consumeFirstHeading: "never" | "when-matching" | "always";  // default "never"
```

`firstHeadingPageTitle` (library setting) is kept for compatibility: `titleSource: "first-heading"` maps to it. When `titleSource` is `"frontmatter"`, the plugin sets the library's `firstHeadingPageTitle` to `false` internally so the library cannot override the title.

**Behaviour**

`resolveTitle(file, frontmatter, content, settings)` returns the raw title before deduplication:

1. `frontmatter["connie-title"]` if a non-empty string.
2. If `titleSource === "frontmatter"`: `frontmatter.title` if a non-empty string (strip surrounding quotes, collapse whitespace).
3. If `titleSource` is `"frontmatter"` or `"first-heading"`: the first ATX heading outside a fence (`findFirstHeadingLine`), stripped of leading emoji and symbol characters (`^[\p{Extended_Pictographic}\p{S}\s]+`).
4. `file.basename`.

The resolved title is stored in `publishTitleByPath` exactly as today, then deduplicated as today. In `loadMarkdownFile`, set `pageTitle` to the final title and, when no explicit `connie-title` exists, inject `parsedFrontMatter["connie-title"] = finalTitle` so the library's `ConniePageConfig` agrees with the plugin. Do not write `connie-title` back to the vault file.

**Heading consumption.** After title resolution, when `consumeFirstHeading` is `"always"`, remove the first body ATX heading line (and one following blank line). When `"when-matching"`, remove it only if it equals the final title after normalisation: strip leading emoji and symbols, strip a leading identifier prefix matching `^[A-Z]{1,3}\d?[A-Z]?-\d{2}(-\d{2})?:?\s*`, collapse whitespace, compare case-insensitively. The existing dedup path that rewrites the H1 to the renamed title is kept only for `titleSource: "first-heading"`.

**Edge cases**

- A `title` that is not a string (YAML date, number) is stringified.
- A title longer than 255 characters is truncated at 252 with an ellipsis and reported.
- Titles are trimmed; a title that becomes empty falls through to the next source.
- `computePublishHash` already folds `pageTitle` into the hash; no change beyond the schema bump.

**Tests** (`tests/titleResolution.test.ts`): precedence order for all four sources; emoji and identifier stripping; `when-matching` consumes `# L3-01-01: Convert Platform Supply` for title `L3-01-01 Convert Platform Supply (Radar)`; `never` leaves the body untouched; `connie-title` injection does not overwrite an explicit one; long-title truncation.

### F2. Folder page titles and deterministic landing selection

**Files:** `src/folderTree.ts` (`deriveStructure`, `computeFolderTitles`, `buildTree`), `src/adaptors/obsidian.ts` (`computePublishContext`).

**Settings**

```ts
folderTitleSource: "segment" | "landing";   // default "segment" (current behaviour)
folderDisplayNames: Record<string, string>; // default {}; JSON text area in settings
```

**Landing selection.** Replace the "first found" rule in `deriveStructure` with a fixed priority, case-insensitive: `index.md`, then `readme.md`, then the eponymous file. Return, alongside `indexFileByFolder`, a list `landingConflicts: { folderRelPath, candidates[] }` for folders with more than one candidate. `computePublishContext` records these as diagnostics (F6). The root folder (`""`) is still never promoted (F7 changes that).

**Folder title.** `computeFolderTitles(folders, takenTitles, opts)` gains an `opts.preferredTitle: (folderRelPath) => string | undefined`. When `folderTitleSource === "landing"`:

1. If the folder has a landing file, the preferred title is that file's resolved title from F1 (before dedup).
2. Else if `folderDisplayNames` has an entry for the folder's basename or its relative path (path wins), use it.
3. Else the segment name.

Uniqueness is then enforced as today: if the preferred title is already taken by a file page or another folder, fall back to the parent-qualified form (`Parent / Name`) and finally the hash form. The landing file's own entry in `publishTitleByPath` is set to the folder's final title, as today, so inbound links and the hash follow the folder.

**Display names for the Engineering-knowledge-vault** are supplied by the content specification; the plugin only needs the mechanism. Example entries: `"01A_Operational_Functions": "Operational functions (L1A)"`, `"03_Functional_Decomposition": "Functional decomposition (L3)"`, `"04_Nodes": "Node catalogue"`.

**Edge cases**

- The preferred title is applied before the collision check, so two domains both titling their layer folder "Operational functions (L1A)" collide and both get parent-qualified ("Radar Architecture / Operational functions (L1A)") using the parent's *final title*, not its segment. Update `computeFolderTitles` to qualify with parent final titles once known (process parent-before-child, which the existing ordering guarantees).
- A container folder with no landing and no display entry keeps today's behaviour.

**Tests** (extend `tests/folderTree.test.ts`): index beats README beats eponymous; conflict list populated; landing title used as folder title; display map by basename and by path; collision falls back to parent-qualified using parent final titles; `segment` mode reproduces existing test expectations unchanged.

### F3. Exclusion globs and list file

**Files:** `src/adaptors/obsidian.ts` (`isPublishable`), new `src/publishFilter.ts` (pure), `src/main.ts`, `src/ConfluenceSettingTab.ts`.

**Settings**

```ts
excludeGlobs: string[];        // default []; one pattern per line in the settings text area
excludeListFile: string;       // default ""; vault-relative path to a YAML or plain-text file of patterns
```

**Behaviour**

`publishFilter.ts` exports `compileExcludes(patterns: string[]): (vaultPath: string) => boolean` supporting `*`, `**`, `?`, character classes and a leading `!` negation, matched against the path relative to `folderToPublish` (POSIX separators, case-sensitive). Implement with a small glob-to-RegExp converter; no dependency.

`isPublishable(file)` becomes: not excalidraw; in the publish folder or `connie-publish: true`; not `connie-publish: false`; and **not matched by any exclusion pattern unless** `connie-publish: true` is set explicitly (an explicit opt-in beats a glob). The list file, when set, is read once per `computePublishContext` through `vault.cachedRead`; a YAML file uses the top-level key `exclude:` (list of strings); a plain-text file is one pattern per line, `#` comments allowed. Inline globs and file globs are concatenated.

Because exclusion runs inside `isPublishable`, every downstream structure (folder derivation, title maps, orphan detection, skip-unchanged) sees the same set. Excluded files that are link targets are reported by F5/F6 as "target excluded".

**Tests** (`tests/publishFilter.test.ts`): `**` across directories; `*.canvas`; negation; explicit `connie-publish: true` survives a matching glob; YAML and text list parsing; patterns are relative to the publish folder, not the vault root.

### F4. Link resolution: ambiguous stems, folder links, asset links, absolute paths

**Files:** `src/adaptors/obsidian.ts` (`resolveWikilink`, new `resolveAssetLink`, `resolveFolderLink`), `src/obsidianPreprocess.ts` (`preprocessMarkdownLinks`, new `preprocessFolderAndAssetLinks`), `src/AdfToStorageFormat.ts` (attachment link rendering).

**Settings**

```ts
assetLinkMode: "text" | "attach" | "base-url";   // default "text" (current: dead href) — see note
assetLinkBaseUrl: string;                          // default ""; used by "base-url"
assetLinkExtensions: string[];                     // default ["m","mlx","ipynb","yaml","yml","json","py","html","svg","pdf","csv","txt"]
```

Note: today a non-markdown relative link is emitted as a relative `href`, which is dead in Confluence. `"text"` renders the label as plain text with a diagnostic, which is the honest default.

**4a. Ambiguous stems.** In `resolveWikilink(rawTarget, sourcePath)`: after `getFirstLinkpathDest`, if the destination is not publishable, or the raw target contains no `/`, collect all markdown files whose basename (without extension) equals the target's last segment, case-insensitive. If exactly one of them is publishable, resolve to it and emit diagnostic `ambiguous-stem-resolved`. If more than one is publishable, keep Obsidian's choice when it is publishable, else the first by path order, and emit `ambiguous-stem-unresolved` (severity error). If none is publishable, keep today's plain-text fallback with `target-excluded` (severity warning) rather than `target-not-published`.

**4b. Folder links.** In `preprocessMarkdownLinks`, a relative target with no extension, or ending in `/`, that resolves (from the source directory, percent-decoded) to a directory inside the publish folder is treated as a link to that folder's page: look up the folder's relative path in `folderTitleByPath` and encode a page wikilink to that title. If the folder is not in the derived structure (all its files excluded), fall back to text with `folder-not-published`.

**4c. Asset links.** A relative target whose extension is in `assetLinkExtensions`, resolved from the source directory to a file that exists in the vault:

- `"attach"`: read the file bytes through the existing `readBinary` path (extend `SUPPORTED_IMAGE_EXTENSIONS` handling with a parallel `SUPPORTED_ATTACHMENT_EXTENSIONS` so non-images are uploaded but never rendered as images), attach it to the *linking* page, and emit a wikilink sentinel of a new kind `"attachment"` carrying the filename; `AdfToStorageFormat.renderWikilink` renders `<ac:link><ri:attachment ri:filename="…"/><ac:plain-text-link-body>…</ac:plain-text-link-body></ac:link>`. The attachment upload goes through the library's existing image pipeline; the adaptor returns the file with its real MIME type. Attachment bytes must be folded into `computePublishHash` (hash of file contents) so an edited script republishes.
- `"base-url"`: rewrite the href to `assetLinkBaseUrl` joined with the target's path relative to the vault root, keeping the link text.
- `"text"`: render the label as plain text, diagnostic `asset-link-dropped`.

**4d. Absolute site paths.** A markdown link whose target starts with `/` and does not start with `//` or a scheme: strip the leading `/`, try to resolve it as a vault path relative to `folderToPublish` (with and without `.md`); if it resolves to a publishable file, link it; else plain text with `absolute-link-unresolved`.

**Tests** (extend `tests/preprocess.test.ts`, mock resolver): ambiguous stem prefers the publishable candidate; unresolved ambiguity reported; folder link resolves to folder title; folder with all files excluded falls back; asset link in each of the three modes; absolute path resolution; attachment sentinel renders `ri:attachment`.

### F5. Link diagnostics in results

**Files:** `src/obsidianPreprocess.ts` (replace `onWarning` strings with typed diagnostics), `src/publishResults.ts`, `src/adaptors/obsidian.ts`, `src/CompletedModal.tsx`.

**Types**

```ts
export type LinkDiagnosticKind =
  | "target-not-in-vault" | "target-excluded" | "target-not-published"
  | "ambiguous-stem-resolved" | "ambiguous-stem-unresolved"
  | "folder-not-published" | "asset-link-dropped" | "absolute-link-unresolved"
  | "block-ref-dropped" | "landing-conflict" | "title-truncated";
export interface LinkDiagnostic { kind: LinkDiagnosticKind; severity: "error" | "warning"; sourcePath: string; target: string; display?: string; }
```

`preprocessWikilinks` and `preprocessMarkdownLinks` accept `onDiagnostic(d: LinkDiagnostic)`; keep `onWarning` as a thin adapter for existing callers. `loadMarkdownFile` collects diagnostics per file into a map on the adaptor, cleared in `computePublishContext`. `UploadResults` gains `diagnostics: LinkDiagnostic[]` and `diagnosticSummary: Record<LinkDiagnosticKind, number>`. `CompletedModal` shows the summary counts and the ten pages with the most errors, each expandable to its diagnostics. Errors do not fail the publish; the dry run (F6) is where they are meant to be fixed.

**Tests** (`tests/diagnostics.test.ts`): each kind is emitted exactly once for its trigger; the summary counts match; existing `onWarning` callers still receive a string.

### F6. Dry run: "Check Confluence links and titles"

**Files:** `src/main.ts` (new command `check-links`), `src/adaptors/obsidian.ts`, new `src/dryRun.ts` (pure report formatter).

**Behaviour**

The command runs `computePublishContext`, then `loadMarkdownFile` for every publishable file, collecting F5 diagnostics, title renames, landing conflicts, and folder titles. It publishes nothing and touches no frontmatter. It writes a markdown report to the vault at `dryRunReportPath` (setting, default `_confluence-check.md`, excluded from publishing automatically) and opens it. Report sections, in order:

1. Summary table: publishable pages, folder pages, excluded by glob, excluded by frontmatter; diagnostics per kind.
2. Title renames the dedup would apply (path, original, renamed).
3. Landing conflicts.
4. Folder titles: relative folder path, final title, source (landing / display map / segment / qualified).
5. Diagnostics grouped by kind, then by source page, each line `source → target (display)`.
6. Label preview (F8): total distinct labels, labels dropped by the vocabulary filter, top 30 by frequency.

`dryRun.ts` exports `formatDryRunReport(input): string` and is tested with a fixture. The command is also exposed as `plugin.runDryRun(): Promise<DryRunResult>` so a test harness can call it.

**Tests** (`tests/dryRun.test.ts`): report contains every section; counts agree with the diagnostics passed in; the report path is excluded from the publish set.

### F7. Root landing into the configured parent page

**Files:** `src/folderTree.ts` (`deriveStructure`, `buildTree`), `src/StructuredPublisher.ts`, `src/adaptors/obsidian.ts`.

**Setting**

```ts
publishRootLanding: boolean;   // default false
```

**Behaviour**

When on, and the publish root (the `commonPath` folder) contains a landing file by F2's priority, that file is promoted into the root carrier: `buildTree` converts it and sets `file.pageTitle` to the configured parent page's current title (the parent page is never renamed). `StructuredPublisher.publish` then includes the root node in the pages to publish, targeting `parentPage.id` directly: it must call the library's `publishFile` with a node whose `file.pageId` is the parent id, `version` is the parent's current version, `existingPageData` is fetched from the parent, and `dontChangeParentPageId` is `true` so no ancestors are sent.

**Safety.** Before the first write, fetch the parent page's `version.by` and `history.createdBy`; proceed only if the page body is empty, or the last editor is the publishing account, or the page already carries a `connie-managed-root` content property set by a previous run. Otherwise skip with diagnostic `root-landing-refused` and publish the landing as a child page as today. After a successful write, set the content property `connie-managed-root = { source: <vault path>, schema: 1 }` through `PUT /rest/api/content/{id}/property/connie-managed-root` (create on 404).

**Tests** (extend `tests/folderTree.test.ts`): root landing promoted only when the setting is on; the root carrier carries the converted content; `dcNesting.test.ts` gains a case proving no move is planned for the root.

### F8. Label policy

**Files:** `src/taxonomyLabels.ts`, `src/publishState.ts`, `src/adaptors/obsidian.ts`, `src/main.ts` (label ownership in publish records), `src/ConfluenceSettingTab.ts`.

**Settings**

```ts
labelSources: { tags: boolean; subject: boolean; type: boolean; domain: boolean; status: boolean; lifecycle_phase: boolean };
   // default { tags: true, subject: true, type: true, others false } when mapTaxonomyToLabels is on; tags only when off
labelAllowlistFile: string;     // default ""; vault-relative YAML: every string under any top-level list is allowed
labelPrefixes: Record<string, string>;   // default {}; e.g. { "type": "type-" } prefixes derived labels from that source
labelMaxPerPage: number;        // default 0 (no cap)
```

**Behaviour**

1. **Normalise** every candidate label: trim, strip a `namespace:` prefix, lowercase, replace any run of characters outside `[a-z0-9]` and Unicode letters/digits with `-`, trim hyphens, cap at 255 characters. Existing `slugifyLabel` is the base; apply it to `tags` too (today they pass through verbatim).
2. **Filter** through the allowlist when set: a label survives if its normalised form equals the normalised form of any allowlisted entry. Dropped labels are counted in the F6 report.
3. **Prefix** derived labels per `labelPrefixes` before uniqueness, so `type-hub` and a tag `hub` can coexist.
4. **Ownership.** The publish record (`PublishRecord`) gains `labels: string[]`, the set the plugin last applied. On publish, the plugin computes `toRemove = previousOwned − current` and `toAdd = current − remote`, and performs those two operations itself against `/rest/api/content/{id}/label` *after* the library's publish, restoring any remote label the library removed that was not plugin-owned. Implement by intercepting the library's two label calls in `MyBaseClient.sendRequest`: record the labels the library removes, and re-add those not in the previous owned set. Simpler alternative if interception is fragile: pre-fetch remote labels, let the library run, then re-add `remote − previousOwned`.
5. Labels participate in `computePublishHash` as today.

**Tests** (extend `tests/taxonomyLabels.test.ts`, `tests/publishState.test.ts`): normalisation of `DO-178C`, `L3`, `Risk & Compliance`; allowlist filtering; prefixing; owned-label diff logic (pure function `planLabelChanges(previousOwned, current, remote)`).

### F9. Bounded retry and per-batch checkpoint

**Files:** `src/MyBaseClient.ts` (`sendRequest`), `src/main.ts` (`doPublish`, `persistPublishState`).

**Settings**

```ts
retryMax: number;        // default 3
retryBaseMs: number;     // default 1000
requestTimeoutMs: number; // default 60000
```

**Behaviour**

In `sendRequest`, wrap the transport call: on HTTP 429, 502, 503, 504, or a network error, wait `min(retryBaseMs × 2^attempt + jitter(0..250ms), Retry-After header if present)` and retry up to `retryMax` times; never retry 4xx other than 429; never retry a request whose body is an attachment upload after the server may have accepted it (treat 5xx on `/child/attachment` POST as non-retryable and let the existing duplicate handling recover on the next run). Apply `requestTimeoutMs` through `AbortController`.

In `doPublish`, after each batch, merge that batch's successful results into `settings.publishedPages` and save, instead of only at the end. Orphan reconciliation still runs once at the end of a full publish.

**Tests** (`tests/retry.test.ts`): pure `retryDelay(attempt, base, retryAfter)`; classification of retryable statuses; a fake transport that fails twice then succeeds is called three times; a 400 is not retried.

### F10. LaTeX fallback (optional)

**Files:** `src/AdfToStorageFormat.ts`, `src/LatexPreprocessor.ts`, `src/ConfluenceSettingTab.ts`.

**Setting**

```ts
latexRendering: "appfire" | "fallback";   // default "appfire" (current)
```

When `"fallback"`: block math renders as a `code` macro with language `latex` and the TeX source as its body; inline math renders as `<code>` with the TeX source. The setting is chosen by the operator after checking the Confluence macro browser for "LaTeX Math" once; no probe is attempted.

**Tests:** both renderings for block and inline math.

### F11. Children Display under folder pages (optional)

**Files:** `src/folderTree.ts`, `src/adaptors/obsidian.ts`.

**Setting**

```ts
childrenMacro: "off" | "container-only" | "generated-landings" | "all";   // default "off"
```

Appends a `children` macro (`depth=1`, `sort=title`) after the landing body for folder pages selected by the mode. `"generated-landings"` selects landings whose frontmatter has `generated: true`. `"container-only"` replaces the Page Tree macro on landing-less folders with Children Display. Emit through the existing extension path as an `inlineExtension` with `extensionKey: "children"`.

### F12. Wider relationship panel (optional)

**Files:** `src/adaptors/obsidian.ts` (`META_REL_FIELDS`).

Add `is-part-of`, `has-part`, `conforms-to`, `replaces`, `broader`, `related` after `references`, with labels "Part of", "Has part", "Conforms to", "Replaces", "Broader", "Related". Values resolve through the existing `resolveMetaRef` (filename, then `id`). Optionally add a computed row "Decomposed into" listing every publishable file whose `parent` resolves to this page, sorted by title; build the inverse map once in `computePublishContext`.

### F13. Update payload ancestors (optional)

`Publisher.updatePageContent` sends the full root-first ancestor chain on update. In `MyBaseClient.sendRequest`, for `PUT /api/content/{id}` bodies with more than one `ancestors` entry, keep only the last. The move pass in `StructuredPublisher` stays as the corrective step and its applied/ignored/failed log is unchanged.

## 4. Settings baseline for the Engineering-knowledge-vault

| Setting | Value |
|---|---|
| Folder to publish | `Knowledge` |
| Preserve folder structure | on |
| `titleSource` / `consumeFirstHeading` | `frontmatter` / `always` |
| `folderTitleSource` / `folderDisplayNames` | `landing` / the map in the content specification §C |
| Deduplicate page titles | on (must report zero renames) |
| `excludeListFile` | `Knowledge/corpus-governance/confluence-exclusions.yaml` |
| `assetLinkMode` | `attach` |
| Metadata panel | on |
| Taxonomy terms as labels / `labelSources` | on / `{ tags: true, type: true }` |
| `labelAllowlistFile` / `labelPrefixes` | `Knowledge/corpus-governance/tag-vocabulary.yaml` (a copy of `tools/tag_vocabulary.yaml`) / `{ "type": "type-" }` |
| `publishRootLanding` | on |
| `latexRendering` | `appfire` if the macro browser lists "LaTeX Math", else `fallback` |
| Skip unchanged | on |
| When a note is deleted | report |
| Batch size / delay | 10 / 500 ms |
| `retryMax` / `retryBaseMs` | 3 / 1000 |
| `childrenMacro` | off |

## 5. Acceptance

1. All existing tests pass; new tests listed per feature exist and pass; lint, prettier, typecheck and build are clean; `main.js` rebuilt.
2. A dry run over `Knowledge/` with the baseline settings reports: zero title renames, zero landing conflicts, zero `ambiguous-stem-unresolved`, and every folder title sourced from a landing or the display map. Remaining `target-*` diagnostics must correspond to items the content specification leaves out of the publish set.
3. Publishing the folder `Knowledge/domain/radar` alone produces a page titled "Radar" (not "radar") whose children are "Radar Architecture", "Radar knowledge articles", the reading journey, the glossary and the equation register; every L3 page shows a breadcrumb line and its parent's page shows a "Decomposed into" list (both come from the content generators, not the plugin).
4. A second publish with no content change reports every page skipped and issues no label removals.
