import { App, Setting, PluginSettingTab, Notice } from "obsidian";
import ConfluencePlugin from "./main";

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
			text: "Confluence Data Center connection",
		});

		new Setting(containerEl)
			.setName("Confluence base URL")
			.setDesc('Base URL of your Confluence instance, e.g. "https://confluence.mycompany.com". Do NOT include "/wiki" or "/rest".')
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
				toggle
					.setValue(this.plugin.settings.usePersonalAccessToken)
					.onChange(async (value) => {
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
					text.setPlaceholder("Token...")
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
					text.setPlaceholder("password")
						.setValue(this.plugin.settings.atlassianPassword)
						.onChange(async (value) => {
							this.plugin.settings.atlassianPassword = value;
							await this.plugin.saveSettings();
						});
				});
		}

		new Setting(containerEl)
			.setName("Test connection")
			.setDesc("Verify the base URL and credentials reach Confluence. Calls /api/user/current and reports who you're authenticated as.")
			.addButton((btn) =>
				btn
					.setButtonText("Test")
					.onClick(async () => {
						btn.setDisabled(true).setButtonText("Testing…");
						try {
							const client = this.plugin.getConfluenceClient();
							const user = await client.users.getCurrentUser();
							// DC returns username; Cloud-shaped clients return displayName/accountId
							const name =
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(user as any).displayName ||
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(user as any).username ||
								// eslint-disable-next-line @typescript-eslint/no-explicit-any
								(user as any).accountId ||
								"(unknown user)";
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
				toggle
					.setValue(this.plugin.settings.firstHeadingPageTitle)
					.onChange(async (value) => {
						this.plugin.settings.firstHeadingPageTitle = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Deduplicate page titles")
			.setDesc("If multiple notes would publish with the same Confluence title (e.g. several README files), append a short hash to each so they can all upload. Without this, Confluence rejects duplicates and the whole batch fails. Renamed pages are listed in the upload report.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.deduplicateTitles)
					.onChange(async (value) => {
						this.plugin.settings.deduplicateTitles = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Preserve folder structure")
			.setDesc("Mirror your vault's folder hierarchy as nested Confluence pages (each folder becomes a page; a folder's README/index becomes its landing page). When off, pages are published flat under the parent. Folder names that repeat across the vault are disambiguated by their parent folder (e.g. \"Radar / Architecture\").")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.preserveFolderStructure)
					.onChange(async (value) => {
						this.plugin.settings.preserveFolderStructure = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Metadata panel")
			.setDesc("Add a Page Properties panel at the top of each page built from the note's frontmatter (id, type, status, subject, and ontology relationships like parent / wasInfluencedBy / requires — resolved to page links where possible). Also feeds Confluence Page Properties Reports.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.showMetadataPanel)
					.onChange(async (value) => {
						this.plugin.settings.showMetadataPanel = value;
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
			.setDesc('On "Publish All", skip notes whose rendered content is unchanged since the last publish — a big speed-up on large vaults. Use the "Force republish all" command to override. Caveats: changes to embedded images that don\'t alter the note text are not detected, and a page you delete manually in Confluence won\'t be recreated while its note is unchanged — force-republish (or reset the publish cache) in those cases.')
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.skipUnchanged)
					.onChange(async (value) => {
						this.plugin.settings.skipUnchanged = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("When a note is deleted")
			.setDesc('On "Publish All", what to do with the Confluence page of a note that was deleted or unpublished. Archive is reversible but needs the bulk-archive REST API (newer Data Center) — if your server returns HTTP 405 it isn\'t available, so use Trash instead. Trash moves the page to the space trash; Report only logs without touching Confluence. Only ever acts on pages this plugin previously published.')
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						off: "Do nothing (off)",
						report: "Report only (log)",
						archive: "Archive the page",
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
			.setDesc('Safety limit: if a single "Publish All" would archive/trash more pages than this, removal is skipped and the pages are only reported (guards against a "Folder to publish" typo orphaning your whole space). Set 0 to disable the limit.')
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

		containerEl.createEl("h2", { text: "Large-vault tuning" });

		new Setting(containerEl)
			.setName("Batch size")
			.setDesc("How many files to publish concurrently per batch. The bundled library fans out without a limit on its own, so this caps fan-out. Default 20.")
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

		new Setting(containerEl)
			.setName("Debug logging")
			.setDesc("Log every API request, response, and ADF conversion to the developer console. Off by default — keep off for large publishes.")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.debugLogging)
					.onChange(async (value) => {
						this.plugin.settings.debugLogging = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Mermaid cache")
			.setDesc("Rendered Mermaid PNGs are cached on disk so unchanged diagrams aren't re-rendered. Clear this if a diagram looks wrong after editing.")
			.addButton((btn) =>
				btn
					.setButtonText("Clear cache")
					.onClick(async () => {
						const removed = await this.plugin.clearMermaidCache();
						new Notice(`Cleared ${removed} cached diagram(s).`);
					}),
			);

		new Setting(containerEl)
			.setName("Publish cache")
			.setDesc("Per-note record of what was published (drives skip-unchanged and deletion detection). Reset it to force a full republish; deletion tracking re-seeds from the next publish (so nothing is treated as orphaned until then).")
			.addButton((btn) =>
				btn
					.setButtonText("Reset publish cache")
					.onClick(async () => {
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
}
