import { App, Setting, PluginSettingTab, Notice } from "obsidian";
import ConfluencePlugin from "./main";
import type { TaxonomyLabelField } from "./taxonomyLabels";

/** Frontmatter fields offered as label sources (F8), in the order they appear. */
const LABEL_SOURCE_FIELDS: TaxonomyLabelField[] = ["tags", "subject", "type", "domain", "status", "lifecycle_phase"];

/** Text-area value -> trimmed, comment-free, non-empty lines. */
function parseLines(value: string): string[] {
	return value
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line.length > 0 && !line.startsWith("#"));
}

export class ConfluenceSettingTab extends PluginSettingTab {
	plugin: ConfluencePlugin;

	constructor(app: App, plugin: ConfluencePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;

		containerEl.empty();

		containerEl.createEl("h2", {
			text: "Confluence Data Center 9.2 connection",
		});

		new Setting(containerEl)
			.setName("Confluence base URL")
			.setDesc(
				'Full application base URL, including any context path, e.g. "https://confluence.mycompany.com/confluence". Do not append "/rest/api".',
			)
			.addText((text) =>
				text
					.setPlaceholder("https://confluence.mycompany.com")
					.setValue(this.plugin.settings.confluenceBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.confluenceBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Authentication method")
			.setDesc("Use a Personal Access Token (PAT) instead of username/password.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.usePersonalAccessToken).onChange(async (value) => {
					this.plugin.settings.usePersonalAccessToken = value;
					await this.plugin.saveSettings();
					this.display();
				}),
			);

		if (this.plugin.settings.usePersonalAccessToken) {
			new Setting(containerEl)
				.setName("Personal Access Token")
				.setDesc("Your Confluence Personal Access Token.")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("Token...")
						.setValue(this.plugin.settings.accessToken)
						.onChange(async (value) => {
							this.plugin.settings.accessToken = value;
							await this.plugin.saveSettings();
						});
				});
		} else {
			new Setting(containerEl)
				.setName("Username")
				.setDesc("Your Confluence username.")
				.addText((text) =>
					text
						.setPlaceholder("username")
						.setValue(this.plugin.settings.atlassianUserName)
						.onChange(async (value) => {
							this.plugin.settings.atlassianUserName = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Password")
				.setDesc("Your Confluence password.")
				.addText((text) => {
					text.inputEl.type = "password";
					text
						.setPlaceholder("password")
						.setValue(this.plugin.settings.atlassianPassword)
						.onChange(async (value) => {
							this.plugin.settings.atlassianPassword = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc(
				"Verify the base URL and credentials reach Confluence. Calls /api/user/current and reports who you're authenticated as.",
			)
			.addButton((btn) =>
				btn.setButtonText("Test").onClick(async () => {
					btn.setDisabled(true).setButtonText("Testing…");
					try {
						const client = this.plugin.getConfluenceClient();
						const user = await client.users.getCurrentUser();
						// DC returns username; Cloud-shaped clients return displayName/accountId
						const name =
							(user as any).displayName || (user as any).username || (user as any).accountId || "(unknown user)";
						new Notice(`✓ Connected as ${name}`, 5000);
					} catch (err) {
						const msg = err instanceof Error ? err.message : String(err);
						new Notice(`✗ Connection failed: ${msg.substring(0, 200)}`, 8000);
						console.error("[Confluence] Test connection failed:", err);
					} finally {
						btn.setDisabled(false).setButtonText("Test");
					}
				}),
			);

		new Setting(containerEl)
			.setName("Confluence parent page ID")
			.setDesc("Page ID under which notes are published as children.")
			.addText((text) =>
				text
					.setPlaceholder("23232345645")
					.setValue(this.plugin.settings.confluenceParentId)
					.onChange(async (value) => {
						this.plugin.settings.confluenceParentId = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Folder to publish")
			.setDesc("Folder to publish from. Leave empty to publish the entire vault.")
			.addText((text) =>
				text
					.setPlaceholder("")
					.setValue(this.plugin.settings.folderToPublish)
					.onChange(async (value) => {
						this.plugin.settings.folderToPublish = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("First header page name")
			.setDesc("Use the first heading as the page title instead of the filename.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.firstHeadingPageTitle).onChange(async (value) => {
					this.plugin.settings.firstHeadingPageTitle = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Deduplicate page titles")
			.setDesc(
				"If multiple notes would publish with the same Confluence title (e.g. several README files), append a short hash to each so they can all upload. Without this, Confluence rejects duplicates and the whole batch fails. Renamed pages are listed in the upload report.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.deduplicateTitles).onChange(async (value) => {
					this.plugin.settings.deduplicateTitles = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Preserve folder structure")
			.setDesc(
				"Mirror your vault's folder hierarchy as nested Confluence pages (each folder becomes a page; a folder's README/index becomes its landing page). When off, pages are published flat under the parent. Folder names that repeat across the vault are disambiguated by their parent folder (e.g. \"Radar / Architecture\").",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.preserveFolderStructure).onChange(async (value) => {
					this.plugin.settings.preserveFolderStructure = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Metadata panel")
			.setDesc(
				"Add a Page Properties panel at the top of each page built from the note's frontmatter (id, type, status, subject, and ontology relationships like parent / wasInfluencedBy / requires — resolved to page links where possible). Also feeds Confluence Page Properties Reports.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showMetadataPanel).onChange(async (value) => {
					this.plugin.settings.showMetadataPanel = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Taxonomy terms as labels")
			.setDesc(
				"Project each note's taxonomy frontmatter (subject + type) onto Confluence labels, so the terms become clickable and feed label search, the Content by Label macro, and label pages. Terms are slugified (\"Machine Learning\" → machine-learning). Note: on publish the library replaces a page's labels with this set, so labels added by hand in Confluence will be removed.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.mapTaxonomyToLabels).onChange(async (value) => {
					this.plugin.settings.mapTaxonomyToLabels = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Mermaid diagram quality")
			.setDesc("PNG export quality for Mermaid diagrams (higher = better quality, larger files).")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						low: "Low (1x scale, smallest files)",
						medium: "Medium (1.5x scale, balanced)",
						high: "High (2x scale, best quality)",
					})
					.setValue(this.plugin.settings.mermaidQuality || "high")
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.mermaidQuality = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h2", { text: "Sync behaviour" });

		new Setting(containerEl)
			.setName("Skip unchanged notes")
			.setDesc(
				'On "Publish All", skip notes whose rendered content is unchanged since the last publish — a big speed-up on large vaults. Use the "Force republish all" command to override. Caveats: changes to embedded images that don\'t alter the note text are not detected, and a page you delete manually in Confluence won\'t be recreated while its note is unchanged — force-republish (or reset the publish cache) in those cases.',
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.skipUnchanged).onChange(async (value) => {
					this.plugin.settings.skipUnchanged = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("When a note is deleted")
			.setDesc(
				'On "Publish All", what to do with a locally tracked page whose source note was deleted or unpublished. Trash uses the documented Data Center DELETE operation to move it to the space trash; Report only logs without touching Confluence. Review cached/frontmatter page IDs before enabling Trash; remote managed-ownership verification is not implemented yet.',
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						off: "Do nothing (off)",
						report: "Report only (log)",
						trash: "Move the page to trash",
					})
					.setValue(this.plugin.settings.onDeletedNote)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.onDeletedNote = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Max pages to remove per publish")
			.setDesc(
				'Safety limit: if a single "Publish All" would trash more pages than this, removal is skipped and the pages are only reported (guards against a "Folder to publish" typo orphaning your whole space). Set 0 to disable the limit.',
			)
			.addText((text) =>
				text
					.setPlaceholder("25")
					.setValue(String(this.plugin.settings.maxDeletePerPublish))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!Number.isFinite(n) || n < 0) return;
						this.plugin.settings.maxDeletePerPublish = n;
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h2", { text: "Navigation: titles" });

		new Setting(containerEl)
			.setName("Page title source")
			.setDesc(
				"Where a page title comes from. A connie-title in frontmatter always wins. Frontmatter title tries the title field, then the first heading, then the filename; First heading skips the title field; Filename is the current behaviour.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						filename: "Filename (default)",
						"first-heading": "First heading, then filename",
						frontmatter: "Frontmatter title, then first heading, then filename",
					})
					.setValue(this.plugin.settings.titleSource)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.titleSource = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Remove the body's first heading")
			.setDesc(
				"Confluence shows the page title above the body, so a note that opens with its own H1 renders it twice. When it matches the title removes the heading only where it restates the title, ignoring emoji, an identifier prefix and case.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						never: "Never (default)",
						"when-matching": "When it matches the title",
						always: "Always",
					})
					.setValue(this.plugin.settings.consumeFirstHeading)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.consumeFirstHeading = value;
						await this.plugin.saveSettings();
					});
			});

		new Setting(containerEl)
			.setName("Folder page title source")
			.setDesc(
				"What a folder's page is called. Landing file uses the title of the folder's index/README/eponymous note, falling back to the display-name map and then the folder name. Folder name is the current behaviour.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						segment: "Folder name (default)",
						landing: "Landing file's title, then display names",
					})
					.setValue(this.plugin.settings.folderTitleSource)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.folderTitleSource = value;
						await this.plugin.saveSettings();
					});
			});

		this.addJsonMapSetting(
			containerEl,
			"Folder display names",
			"JSON map of folder name (or path relative to the publish folder) to the title its page should carry. A path entry beats a bare-name entry. Only used when the folder title source is Landing file.",
			'{\n  "04_Nodes": "Node catalogue"\n}',
			() => this.plugin.settings.folderDisplayNames,
			(value) => {
				this.plugin.settings.folderDisplayNames = value;
			},
		);

		new Setting(containerEl)
			.setName("Publish the root landing note into the parent page")
			.setDesc(
				"When the publish folder itself has an index/README note, write it into the configured parent page instead of creating a child page. The parent page is only overwritten if it is empty, was last edited by this account, or was already claimed by a previous run; otherwise the note publishes as a child, as it does today.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.publishRootLanding).onChange(async (value) => {
					this.plugin.settings.publishRootLanding = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Children Display macro on folder pages")
			.setDesc(
				"Append a Children Display macro (depth 1, sorted by title) to folder pages, giving each one a clickable index. Generated landing notes only applies it to landing notes with generated: true in frontmatter.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						off: "Off (default)",
						"container-only": "Folders with no landing note",
						"generated-landings": "Generated landing notes",
						all: "All folder pages",
					})
					.setValue(this.plugin.settings.childrenMacro)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.childrenMacro = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h2", { text: "Navigation: what gets published" });

		this.addLinesSetting(
			containerEl,
			"Exclusion patterns",
			"One glob per line, matched against each note's path relative to the publish folder. Supports *, **, ? and [abc]; a leading ! re-includes. A note with connie-publish: true is published even if a pattern matches it. Lines starting with # are comments.",
			"**/_drafts/**\n*.canvas\n!keep/**",
			() => this.plugin.settings.excludeGlobs,
			(value) => {
				this.plugin.settings.excludeGlobs = value;
			},
		);

		new Setting(containerEl)
			.setName("Exclusion list file")
			.setDesc(
				"Vault-relative path to a file of more exclusion patterns, concatenated with the list above. A .yaml/.yml file uses a top-level exclude: list; anything else is one pattern per line with # comments.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Knowledge/corpus-governance/confluence-exclusions.yaml")
					.setValue(this.plugin.settings.excludeListFile)
					.onChange(async (value) => {
						this.plugin.settings.excludeListFile = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Link and title check report")
			.setDesc(
				"Vault path the Check Confluence links and titles command writes its report to. The report is never published back to Confluence.",
			)
			.addText((text) =>
				text
					.setPlaceholder("_confluence-check.md")
					.setValue(this.plugin.settings.dryRunReportPath)
					.onChange(async (value) => {
						this.plugin.settings.dryRunReportPath = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		containerEl.createEl("h2", { text: "Navigation: links to non-markdown files" });

		new Setting(containerEl)
			.setName("Asset link handling")
			.setDesc(
				"What to do with a relative link to a script, notebook, PDF or other non-markdown file. Plain text is the honest default, because the relative link would be dead in Confluence; Attach uploads the file to the linking page; Base URL rewrites the link to point at a repository or web host.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						text: "Render as plain text (default)",
						attach: "Attach the file to the page",
						"base-url": "Rewrite to a base URL",
					})
					.setValue(this.plugin.settings.assetLinkMode)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.assetLinkMode = value;
						await this.plugin.saveSettings();
						this.display();
					});
			});

		if (this.plugin.settings.assetLinkMode === "base-url") {
			new Setting(containerEl)
				.setName("Asset base URL")
				.setDesc("Joined with the file's path relative to the vault root, e.g. a repository browse URL.")
				.addText((text) =>
					text
						.setPlaceholder("https://git.example.com/vault/-/blob/main")
						.setValue(this.plugin.settings.assetLinkBaseUrl)
						.onChange(async (value) => {
							this.plugin.settings.assetLinkBaseUrl = value.trim();
							await this.plugin.saveSettings();
						}),
				);
		}

		this.addLinesSetting(
			containerEl,
			"Asset file extensions",
			"Extensions (without the dot) treated as linkable assets, one per line. Images are always handled by the existing image pipeline regardless of this list.",
			"py\nipynb\npdf",
			() => this.plugin.settings.assetLinkExtensions,
			(value) => {
				this.plugin.settings.assetLinkExtensions = value.map((e) => e.replace(/^\./, "").toLowerCase());
			},
		);

		containerEl.createEl("h2", { text: "Navigation: labels" });

		new Setting(containerEl)
			.setName("Frontmatter fields used as labels")
			.setDesc(
				"Which frontmatter fields are projected onto Confluence labels. Every value is normalised to a label-safe slug. Only applies when Map taxonomy terms to labels is on, except tags, which the library publishes regardless.",
			);
		for (const field of LABEL_SOURCE_FIELDS) {
			new Setting(containerEl)
				.setName(field)
				.setClass("setting-item-nested")
				.addToggle((toggle) =>
					toggle.setValue(this.plugin.settings.labelSources?.[field] ?? false).onChange(async (value) => {
						this.plugin.settings.labelSources = { ...this.plugin.settings.labelSources, [field]: value };
						await this.plugin.saveSettings();
					}),
				);
		}

		new Setting(containerEl)
			.setName("Label vocabulary file")
			.setDesc(
				"Vault-relative YAML controlled vocabulary. Every string under any top-level list is an allowed label; anything else is dropped and counted in the check report. Leave empty to allow all labels.",
			)
			.addText((text) =>
				text
					.setPlaceholder("Knowledge/corpus-governance/tag-vocabulary.yaml")
					.setValue(this.plugin.settings.labelAllowlistFile)
					.onChange(async (value) => {
						this.plugin.settings.labelAllowlistFile = value.trim();
						await this.plugin.saveSettings();
					}),
			);

		this.addJsonMapSetting(
			containerEl,
			"Label prefixes",
			"JSON map of frontmatter field to a prefix for the labels derived from it, so a type: hub becomes type-hub and can coexist with a plain hub tag.",
			'{\n  "type": "type-"\n}',
			() => this.plugin.settings.labelPrefixes,
			(value) => {
				this.plugin.settings.labelPrefixes = value;
			},
		);

		this.addNumberSetting(
			containerEl,
			"Maximum labels per page",
			"Cap on how many labels one page receives. 0 means no cap.",
			"0",
			() => this.plugin.settings.labelMaxPerPage,
			(value) => {
				this.plugin.settings.labelMaxPerPage = value;
			},
		);

		containerEl.createEl("h2", { text: "Navigation: maths rendering" });

		new Setting(containerEl)
			.setName("LaTeX rendering")
			.setDesc(
				"How maths is published. Appfire macros needs the LaTeX Math add-on installed, so check your Confluence macro browser first. The readable fallback publishes the TeX source in a code block instead, which is legible everywhere.",
			)
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						appfire: "Appfire LaTeX macros (default)",
						fallback: "Readable code-block fallback",
					})
					.setValue(this.plugin.settings.latexRendering)
					.onChange(async (value) => {
						// @ts-expect-error narrowed by addOptions
						this.plugin.settings.latexRendering = value;
						await this.plugin.saveSettings();
					});
			});

		containerEl.createEl("h2", { text: "Large-vault tuning" });

		new Setting(containerEl)
			.setName("Batch size")
			.setDesc(
				"How many files to publish concurrently per batch. The bundled library fans out without a limit on its own, so this caps fan-out. Default 20.",
			)
			.addText((text) =>
				text
					.setPlaceholder("20")
					.setValue(String(this.plugin.settings.batchSize))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!Number.isFinite(n) || n < 1 || n > 100) return;
						this.plugin.settings.batchSize = n;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Delay between batches (ms)")
			.setDesc("Pause between batches. Increase if your Confluence instance rate-limits. Default 0.")
			.addText((text) =>
				text
					.setPlaceholder("0")
					.setValue(String(this.plugin.settings.batchDelayMs))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!Number.isFinite(n) || n < 0) return;
						this.plugin.settings.batchDelayMs = n;
						await this.plugin.saveSettings();
					}),
			);

		this.addNumberSetting(
			containerEl,
			"Request retries",
			"How many times to retry a request that fails with 429, 502, 503, 504 or a network error. Other 4xx responses are never retried. Default 3.",
			"3",
			() => this.plugin.settings.retryMax,
			(value) => {
				this.plugin.settings.retryMax = value;
			},
		);

		this.addNumberSetting(
			containerEl,
			"Retry backoff (ms)",
			"Base delay before the first retry, doubled each attempt and jittered. A Retry-After header from the server wins. Default 1000.",
			"1000",
			() => this.plugin.settings.retryBaseMs,
			(value) => {
				this.plugin.settings.retryBaseMs = value;
			},
		);

		this.addNumberSetting(
			containerEl,
			"Request timeout (ms)",
			"Abort a single API request after this long. 0 disables the timeout. Default 60000.",
			"60000",
			() => this.plugin.settings.requestTimeoutMs,
			(value) => {
				this.plugin.settings.requestTimeoutMs = value;
			},
		);

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc(
				"Log every API request, response, and ADF conversion to the developer console. Off by default — keep off for large publishes.",
			)
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.debugLogging).onChange(async (value) => {
					this.plugin.settings.debugLogging = value;
					await this.plugin.saveSettings();
				}),
			);

		new Setting(containerEl)
			.setName("Mermaid cache")
			.setDesc(
				"Rendered Mermaid PNGs are cached on disk so unchanged diagrams aren't re-rendered. Clear this if a diagram looks wrong after editing.",
			)
			.addButton((btn) =>
				btn.setButtonText("Clear cache").onClick(async () => {
					const removed = await this.plugin.clearMermaidCache();
					new Notice(`Cleared ${removed} cached diagram(s).`);
				}),
			);

		new Setting(containerEl)
			.setName("Publish cache")
			.setDesc(
				"Per-note record of what was published (drives skip-unchanged and deletion detection). Reset it to force a full republish; deletion tracking re-seeds from the next publish (so nothing is treated as orphaned until then).",
			)
			.addButton((btn) =>
				btn.setButtonText("Reset publish cache").onClick(async () => {
					try {
						this.plugin.settings.publishedPages = {};
						await this.plugin.saveSettings();
						new Notice("Publish cache reset — the next publish will re-send everything.");
					} catch (err) {
						console.error("[Confluence] Failed to reset publish cache:", err);
						new Notice(`Failed to reset publish cache: ${err instanceof Error ? err.message : String(err)}`);
					}
				}),
			);
	}

	/**
	 * A multi-line text area whose value is a list of strings, one per line.
	 * Blank lines and `#` comments are dropped, so a user can annotate a glob
	 * list in place.
	 */
	private addLinesSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		get: () => string[],
		set: (value: string[]) => void,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((area) => {
				area.inputEl.rows = 5;
				area.inputEl.style.width = "100%";
				area
					.setPlaceholder(placeholder)
					.setValue(get().join("\n"))
					.onChange(async (value) => {
						set(parseLines(value));
						await this.plugin.saveSettings();
					});
			});
	}

	/**
	 * A multi-line text area holding a JSON object. Invalid JSON is left in the
	 * box and NOT saved — silently discarding a half-typed map would lose a long
	 * display-name list one keystroke at a time — and the reason is shown below
	 * the field.
	 */
	private addJsonMapSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		get: () => Record<string, string>,
		set: (value: Record<string, string>) => void,
	): void {
		let errorEl: HTMLElement | null = null;
		const setting = new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addTextArea((area) => {
				area.inputEl.rows = 6;
				area.inputEl.style.width = "100%";
				area
					.setPlaceholder(placeholder)
					.setValue(JSON.stringify(get() ?? {}, null, 2))
					.onChange(async (value) => {
						const text = value.trim();
						errorEl?.setText("");
						if (text === "") {
							set({});
							await this.plugin.saveSettings();
							return;
						}
						let parsed: unknown;
						try {
							parsed = JSON.parse(text);
						} catch (e) {
							errorEl?.setText(`Not valid JSON, so nothing was saved. ${e instanceof Error ? e.message : ""}`);
							return;
						}
						if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
							errorEl?.setText("Expected a JSON object of key/title pairs, so nothing was saved.");
							return;
						}
						const out: Record<string, string> = {};
						for (const [key, val] of Object.entries(parsed as Record<string, unknown>)) {
							if (typeof val === "string") out[key] = val;
						}
						set(out);
						await this.plugin.saveSettings();
					});
			});
		errorEl = setting.descEl.createDiv({ cls: "setting-item-description" });
		errorEl.style.color = "var(--text-error)";
	}

	/** Non-negative integer text field. Out-of-range input is ignored, not saved. */
	private addNumberSetting(
		containerEl: HTMLElement,
		name: string,
		desc: string,
		placeholder: string,
		get: () => number,
		set: (value: number) => void,
		min = 0,
	): void {
		new Setting(containerEl)
			.setName(name)
			.setDesc(desc)
			.addText((text) =>
				text
					.setPlaceholder(placeholder)
					.setValue(String(get()))
					.onChange(async (value) => {
						const n = parseInt(value, 10);
						if (!Number.isFinite(n) || n < min) return;
						set(n);
						await this.plugin.saveSettings();
					}),
			);
	}
}
