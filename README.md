# Obsidian to Confluence Data Center

Publish an Obsidian Markdown collection as navigable Confluence Data Center pages. The
current compatibility baseline is **Confluence Data Center 9.2 LTS**; Atlassian Cloud is
not a supported target.

The plugin preserves a note hierarchy, resolves internal links, uploads images and
Mermaid diagrams, and renders richer Confluence content such as panels, status macros,
task lists, code blocks, Page Properties, and labels.

> [!WARNING]
> This repository still depends on the abandoned, Cloud-first
> `@markdown-confluence/lib`. The Data Center adapter corrects several incompatibilities,
> but ownership validation, attachment reconciliation, retries, and the hierarchy move
> workaround still need hardening before unattended destructive synchronization. See the
> [codebase audit](docs/codebase-audit.md).

## Confluence support policy

- Target: Confluence Data Center 9.2.x, using Atlassian's versioned 9.2 documentation.
- Content representation: Confluence storage format for page creation and update.
- Authentication: Data Center Personal Access Token (preferred) or Basic authentication.
- Deletion: report only, do nothing, or the documented content `DELETE` operation, which
  moves a current page to the space trash.
- Page archive is not offered because it is not a documented 9.2 content operation.
- Appfire `math`/`mathinline` macros are optional and require the relevant marketplace app.

Official references: [9.2 release notes](https://confluence.atlassian.com/doc/confluence-9-2-release-notes-1456345480.html),
[9.2 REST content resource](https://developer.atlassian.com/server/confluence/rest/v9214/api-group-content-resource/),
[storage format](https://confluence.atlassian.com/conf92/confluence-storage-format-1477576006.html),
and [REST examples](https://developer.atlassian.com/server/confluence/confluence-rest-api-examples/).

## Installation

### BRAT

1. Install [BRAT](https://github.com/TfTHacker/obsidian42-brat) from Obsidian Community
   Plugins.
2. Choose **Add Beta Plugin** in BRAT settings.
3. Enter `https://github.com/aaronsb/obsidian-to-confluence`.
4. Enable **Confluence Integration**.

### Manual

1. Download `main.js` and `manifest.json` from the
   [latest release](https://github.com/aaronsb/obsidian-to-confluence/releases/latest).
2. Copy them into `.obsidian/plugins/confluence-integration/` in the vault.
3. Enable **Confluence Integration** in Community Plugins.

## Configuration

Open **Settings → Community plugins → Confluence Integration**.

1. **Confluence base URL** — the full Data Center application URL, including a context
   path if the instance uses one. Examples:
   `https://confluence.example.com` or `https://intranet.example.com/confluence`.
   Do not append `/rest/api`.
2. **Authentication method** — use a Personal Access Token when available, or a Data
   Center username and password. Use **Test connection** before publishing.
3. **Confluence parent page ID** — the numeric page ID below which content is managed.
4. **Folder to publish** — an Obsidian folder such as `Work/Documentation`. Leave it
   empty to use the vault root.

Credentials are currently persisted in Obsidian plugin data, which may live in a synced
vault. Restrict the service account to the intended space, use HTTPS, and protect the
vault configuration accordingly.

Useful settings include:

- preserve the folder structure with README/index notes as folder landing pages;
- use the first H1 as the page title and deduplicate colliding titles;
- emit a Page Properties panel from selected frontmatter;
- map taxonomy fields to Confluence labels;
- skip unchanged notes, tune batch size, and add a delay between batches;
- report or trash pages whose source note disappeared, with a removal safety cap.

## Publishing

- **Publish all to Confluence** publishes the configured scope.
- **Publish current file to Confluence** publishes the active note.
- **Force republish all to Confluence** ignores the local content-hash cache.
- The ribbon cloud icon publishes all.

Control individual notes with YAML frontmatter:

```yaml
---
connie-publish: true       # include a note outside the configured folder
connie-title: Guide        # optional explicit Confluence title
tags:
  - operations
---
```

Set `connie-publish: false` to exclude a note. Existing `connie-page-id` values are used
to update pages, but the current implementation does not yet prove that a supplied ID is
owned by this plugin and inside the configured tree. Review frontmatter IDs before a
bulk run.

## Rendering features

- headings, paragraphs, emphasis, strike-through, code, block quotes, lists, ordered-list
  starts, task lists, tables, horizontal rules, links, and images;
- Obsidian wikilinks and relative Markdown links, including heading anchors;
- Obsidian comments and highlights;
- Obsidian callouts mapped to stock Confluence info, note, warning, and tip panels;
- Mermaid diagrams rendered to PNG attachments;
- optional LaTeX rendering through Appfire macros;
- Page Properties metadata and taxonomy-derived labels;
- nested folder pages with deterministic title disambiguation.

## Safe bulk-publish workflow

1. Use a dedicated, least-privilege Confluence account and a non-production parent page.
2. Test the connection and publish a representative subset.
3. Inspect links, attachments, labels, callouts, hierarchy, and non-ASCII content.
4. Leave deleted-note handling on **Report only** until the generated tree is accepted.
5. Back up Confluence and the vault before enabling trash reconciliation.
6. Review console errors after every large run; the client does not yet implement bounded
   retries or transaction-style rollback.

## Development

```bash
npm ci --ignore-scripts
npm test
npm run lint
npm run prettier-check
npm run build
```

`main.js` is the generated Obsidian plugin bundle and is intentionally committed.

The Data Center-native Python successor, its specification, tests and GUI integration
contract now live as the standalone
[`md2conf` tool](https://github.com/mdmcdonald/theunderclass/tree/main/tools/md2conf).
This repository remains the home of the legacy Obsidian plugin.

## Requirements

- Obsidian 1.5.0 or newer (see `manifest.json` for the authoritative minimum)
- Confluence Data Center 9.2.x
- permission to read the target tree and create/update content and attachments

## License

[Apache 2.0](LICENSE)
