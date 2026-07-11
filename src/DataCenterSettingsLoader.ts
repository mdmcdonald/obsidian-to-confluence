import { ConfluenceUploadSettings, SettingsLoader } from "@markdown-confluence/lib";

export interface DataCenterAuthSettings {
	usePersonalAccessToken: boolean;
	accessToken: string;
	atlassianPassword: string;
}

export type DataCenterPublisherSettings = ConfluenceUploadSettings.ConfluenceSettings & DataCenterAuthSettings;

/**
 * Settings validation for the Data Center-only client.
 *
 * The upstream loader validates Cloud email/API-token fields, so a valid Data
 * Center PAT or username/password configuration can pass "Test connection" and
 * then fail before publishing. This loader validates the credentials that the
 * Data Center client actually uses while retaining the fields required by the
 * inherited publisher.
 */
export class DataCenterSettingsLoader extends SettingsLoader {
	constructor(private readonly settings: DataCenterPublisherSettings) {
		super();
	}

	override loadPartial(): Partial<ConfluenceUploadSettings.ConfluenceSettings> {
		return this.settings;
	}

	override load(): ConfluenceUploadSettings.ConfluenceSettings {
		const settings = this.settings;
		settings.confluenceBaseUrl = settings.confluenceBaseUrl.trim().replace(/\/+$/, "");
		settings.confluenceParentId = settings.confluenceParentId.trim();

		if (!settings.confluenceBaseUrl) {
			throw new Error("Confluence base URL is required");
		}
		let baseUrl: URL;
		try {
			baseUrl = new URL(settings.confluenceBaseUrl);
		} catch {
			throw new Error("Confluence base URL must be an absolute HTTP(S) URL");
		}
		if (baseUrl.protocol !== "https:" && baseUrl.protocol !== "http:") {
			throw new Error("Confluence base URL must use HTTP or HTTPS");
		}
		if (!/^[1-9][0-9]*$/.test(settings.confluenceParentId)) {
			throw new Error("Confluence parent page ID must be a positive integer");
		}

		if (settings.usePersonalAccessToken) {
			if (!settings.accessToken.trim()) {
				throw new Error("Confluence Personal Access Token is required");
			}
		} else {
			if (!settings.atlassianUserName.trim()) {
				throw new Error("Confluence username is required");
			}
			if (!settings.atlassianPassword) {
				throw new Error("Confluence password is required");
			}
		}

		// The inherited publisher expects both values to be non-empty even though
		// the Obsidian adaptor does not use them as filesystem paths. Empty folder
		// means vault root in this plugin; "/" is the loader-safe equivalent.
		if (!settings.folderToPublish) settings.folderToPublish = "/";
		if (!settings.contentRoot) settings.contentRoot = "/";
		if (!settings.contentRoot.endsWith("/")) settings.contentRoot += "/";
		settings.firstHeadingPageTitle ??= false;

		return settings;
	}
}
