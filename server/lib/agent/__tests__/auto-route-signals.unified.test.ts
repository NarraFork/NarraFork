import { afterAll, expect, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../../provider-keys";
import { settings } from "../../settings";
import { autoSourceFacts } from "../auto-route-signals";

const credentials = seedUnifiedCredentials();
const saved = settings.customApiProviders;
const owner = "unified-auto-route";
afterAll(() => {
	settings.customApiProviders = saved;
	getProviderKeyStore().removeProvider(owner);
});

test("auto routing observes persisted disabled state after rebuilding the unified store", () => {
	settings.customApiProviders = [
		{
			id: owner,
			name: "Unified auto",
			prefix: "unified-auto",
			apiKey: "",
			baseUrl: "https://relay.invalid/v1",
			defaultModel: "m",
			protocol: "completions-compatible",
		},
	];
	const key = getProviderKeyStore().add(owner, { apiKey: "unified-auto-key" });
	getProviderKeyStore().update(key.id, { disabled: true });
	resetProviderKeyStoreForTests();
	expect(autoSourceFacts("unified-auto").available).toBe(false);
	getProviderKeyStore().update(key.id, { disabled: false });
	resetProviderKeyStoreForTests();
	expect(autoSourceFacts("unified-auto").available).toBe(true);
	expect(credentials.written()).toBe(true);
});
