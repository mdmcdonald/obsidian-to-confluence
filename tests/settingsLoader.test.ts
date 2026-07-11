import assert from "node:assert/strict";
import test from "node:test";
import { ConfluenceUploadSettings } from "@markdown-confluence/lib";
import {
	DataCenterPublisherSettings,
	DataCenterSettingsLoader,
} from "../src/DataCenterSettingsLoader";

function settings(
	overrides: Partial<DataCenterPublisherSettings> = {},
): DataCenterPublisherSettings {
	return {
		...ConfluenceUploadSettings.DEFAULT_SETTINGS,
		confluenceBaseUrl: "https://confluence.example.test/context/",
		confluenceParentId: "123",
		folderToPublish: "",
		usePersonalAccessToken: true,
		accessToken: "pat",
		atlassianPassword: "",
		...overrides,
	};
}

test("accepts Data Center PAT auth and preserves a context path", () => {
	const loaded = new DataCenterSettingsLoader(settings()).load();
	assert.equal(loaded.confluenceBaseUrl, "https://confluence.example.test/context");
	assert.equal(loaded.folderToPublish, "/");
});

test("accepts Data Center basic auth without a Cloud API token", () => {
	const loaded = new DataCenterSettingsLoader(
		settings({
			usePersonalAccessToken: false,
			accessToken: "",
			atlassianUserName: "publisher",
			atlassianPassword: "secret",
			atlassianApiToken: "",
		}),
	).load();
	assert.equal(loaded.atlassianUserName, "publisher");
});

test("rejects missing credentials for the selected auth mode", () => {
	assert.throws(
		() => new DataCenterSettingsLoader(settings({ accessToken: "" })).load(),
		/Personal Access Token is required/,
	);
	assert.throws(
		() =>
			new DataCenterSettingsLoader(
				settings({
					usePersonalAccessToken: false,
					atlassianUserName: "publisher",
					atlassianPassword: "",
				}),
			).load(),
		/password is required/,
	);
});

test("rejects invalid parent IDs and non-HTTP URLs", () => {
	assert.throws(
		() => new DataCenterSettingsLoader(settings({ confluenceParentId: "0" })).load(),
		/positive integer/,
	);
	assert.throws(
		() => new DataCenterSettingsLoader(settings({ confluenceBaseUrl: "file:///tmp/wiki" })).load(),
		/HTTP or HTTPS/,
	);
});
