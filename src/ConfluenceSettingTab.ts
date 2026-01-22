import { App, Setting, PluginSettingTab } from "obsidian";
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
			text: "Settings for connecting to Atlassian Confluence",
		});

		new Setting(containerEl)
			.setName("Use Confluence Data Center")
			.setDesc("Enable this if you are using a self-hosted Confluence instance (Data Center or Server).")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.isDataCenter)
					.onChange(async (value) => {
						this.plugin.settings.isDataCenter = value;
						await this.plugin.saveSettings();
						this.display();
					}),
			);

		new Setting(containerEl)
			.setName("Confluence Domain")
			.setDesc(
				this.plugin.settings.isDataCenter
				? 'Base URL of your Confluence instance (e.g. "https://confluence.mycompany.com"). Do NOT include "/wiki" or "/rest".'
				: 'Confluence Cloud Domain (e.g. "https://mysite.atlassian.net")'
			)
			.addText((text) =>
				text
					.setPlaceholder(
						this.plugin.settings.isDataCenter
						? "https://confluence.mycompany.com"
						: "https://mysite.atlassian.net"
					)
					.setValue(this.plugin.settings.confluenceBaseUrl)
					.onChange(async (value) => {
						this.plugin.settings.confluenceBaseUrl = value;
						await this.plugin.saveSettings();
					}),
			);

		if (this.plugin.settings.isDataCenter) {
			new Setting(containerEl)
				.setName("API Suffix")
				.setDesc(
					'The suffix to append to the Confluence Domain for API requests. Defaults to "/rest". Change this if your Confluence instance uses a different context path (e.g., "/wiki/rest").',
				)
				.addText((text) =>
					text
						.setPlaceholder("/rest")
						.setValue(this.plugin.settings.apiSuffix)
						.onChange(async (value) => {
							this.plugin.settings.apiSuffix = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Authentication Method")
				.setDesc("Use Personal Access Token (PAT) instead of Username/Password.")
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
					.setDesc("Your Confluence Username.")
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
					.setDesc("Your Confluence Password.")
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
		} else {
			new Setting(containerEl)
				.setName("Atlassian Username")
				.setDesc('eg "username@domain.com"')
				.addText((text) =>
					text
						.setPlaceholder("username@domain.com")
						.setValue(this.plugin.settings.atlassianUserName)
						.onChange(async (value) => {
							this.plugin.settings.atlassianUserName = value;
							await this.plugin.saveSettings();
						}),
				);

			new Setting(containerEl)
				.setName("Atlassian API Token")
				.setDesc("")
				.addText((text) =>
					text
						.setPlaceholder("")
						.setValue(this.plugin.settings.atlassianApiToken)
						.onChange(async (value) => {
							this.plugin.settings.atlassianApiToken = value;
							await this.plugin.saveSettings();
						}),
				);
		}

		new Setting(containerEl)
			.setName("Confluence Parent Page ID")
			.setDesc("Page ID to publish files under")
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
			.setDesc(
				"Publish all files except notes that are excluded using YAML Frontmatter",
			)
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
			.setName("First Header Page Name")
			.setDesc("First header replaces file name as page title")
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.firstHeadingPageTitle)
					.onChange(async (value) => {
						this.plugin.settings.firstHeadingPageTitle = value;
						await this.plugin.saveSettings();
					}),
			);

		new Setting(containerEl)
			.setName("Mermaid Diagram Quality")
			.setDesc("PNG export quality for Mermaid diagrams (higher = better quality, larger files)")
			.addDropdown((dropdown) => {
				dropdown
					.addOptions({
						low: "Low (1x scale, smallest files)",
						medium: "Medium (1.5x scale, balanced)",
						high: "High (2x scale, best quality)",
					})
					.setValue(this.plugin.settings.mermaidQuality || "high")
					.onChange(async (value) => {
						// @ts-expect-error
						this.plugin.settings.mermaidQuality = value;
						await this.plugin.saveSettings();
					});
			});
	}
}
