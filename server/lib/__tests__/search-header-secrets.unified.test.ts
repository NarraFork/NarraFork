import { afterAll, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { getNarraforkPath } from "../narrafork-home";
import {
	getProviderKeyStore,
	resetProviderKeyStoreForTests,
	searchKeyOwner,
} from "../provider-keys";
import { reloadSettings, saveSettings, settings } from "../settings";
import { SearchHeaderSecrets } from "../settings/search-header-secrets";

const credentials = seedUnifiedCredentials();
const saved = structuredClone(settings);
afterAll(() => saveSettings(saved));

test("unified model keys and legacy search secrets survive independent storage rebuilds", () => {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: "unified-model",
				name: "Model",
				prefix: "unified-model",
				apiKey: "model-secret",
				baseUrl: "https://model.invalid/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
		search: {
			...settings.search,
			channels: [],
			customProviders: [
				{
					id: "unified-search",
					name: "Search",
					protocol: "tavily",
					baseUrl: "https://search.invalid",
					apiKey: "search-secret",
					headers: { Authorization: "Bearer header-secret", "X-Public": "kept" },
				},
			],
		},
	});
	resetProviderKeyStoreForTests();
	const loaded = reloadSettings();
	expect(getProviderKeyStore().firstKey("unified-model")).toBe("model-secret");
	expect(getProviderKeyStore().firstKey(searchKeyOwner("unified-search"))).toBe("search-secret");
	const disk = JSON.parse(readFileSync(getNarraforkPath("settings.json"), "utf8"));
	expect(disk.search.customProviders[0].headers).toEqual({ "X-Public": "kept" });
	new SearchHeaderSecrets().hydrate(disk);
	expect(disk.search.customProviders[0].headers).toEqual(
		loaded.search?.customProviders[0]?.headers,
	);
	expect(disk.search.customProviders[0].headers.Authorization).toBe("Bearer header-secret");
	expect(credentials.written()).toBe(true);
});
