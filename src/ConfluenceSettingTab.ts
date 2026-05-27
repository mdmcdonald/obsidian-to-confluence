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
	}
}
