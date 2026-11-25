import { afterAll, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";
import {
	getProviderKeyStore,
	peekProviderKeyStore,
	resetProviderKeyStoreForTests,
} from "../../provider-keys";
import { saveSettings, settings } from "../../settings";
import { getSourceGroupByPrefix } from "../../sourcing/source-groups";
import { autoSourceFacts } from "../auto-route-signals";

const credentials = seedUnifiedCredentials();
const saved = structuredClone(settings.customApiProviders);
const owner = "unified-auto-route";
afterAll(() => {
	getProviderKeyStore().removeProvider(owner);
	saveSettings({ ...settings, customApiProviders: saved });
});

test("unified disabled state survives rebuild and Auto reads only the warmed owner view", () => {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: owner,
				name: "Unified auto",
				prefix: "unified-auto",
				apiKey: "",
				baseUrl: "https://relay.invalid/v1",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
	});
	const key = getProviderKeyStore().add(owner, { apiKey: "unified-auto-key" });
	for (const disabled of [true, false]) {
		getProviderKeyStore().update(key.id, { disabled });
		resetProviderKeyStoreForTests();
		expect(peekProviderKeyStore()).toBeUndefined();
		// Startup owns disk reads and warms credentials before the pure routing hot path.
		const restored = getProviderKeyStore().listGroup(owner);
		expect(restored).toHaveLength(1);
		expect(restored[0]?.id).toBe(key.id);
		expect(!!restored[0]?.disabled).toBe(disabled);
		expect(getSourceGroupByPrefix("unified-auto")?.id).toBe(owner);
		const read = spyOn(fs, "readFileSync").mockImplementation(() => {
			throw new Error("Auto routing must not read credential files");
		});
		try {
			expect(autoSourceFacts("unified-auto").available).toBe(!disabled);
			expect(read).not.toHaveBeenCalled();
		} finally {
			read.mockRestore();
		}
	}
	expect(credentials.written()).toBe(true);
});
