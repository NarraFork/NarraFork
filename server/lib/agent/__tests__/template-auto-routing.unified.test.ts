import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../../tests/unified-credentials";
import { legacyQuotaFixture, required } from "../../__tests__/provider-quota-legacy-fixture";
import { getCredentialStore } from "../../credential-store";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../../provider-keys";
import { saveSettings, settings } from "../../settings";
import { hydrateProviderKeys } from "../../settings/provider-keys-projection";
import { quotaStore } from "../../sourcing/quota-store";
import { autoSourceFacts, autoSourcePreview } from "../auto-route-signals";

// Only storage boundaries belong here; the in-memory policy matrix runs once in
// template-auto-routing.test.ts. Preload owns HOME isolation.
const saved = structuredClone(settings);
const now = 1_800_000_000_000;
const promotedId = "unified-route-promoted";
const nugId = "unified-route-nug";
const groups = [promotedId, nugId, "tokendance", "CommandCode"];
let fixture: ReturnType<typeof legacyQuotaFixture> | undefined;

function rebuildStore() {
	resetProviderKeyStoreForTests();
	const store = getProviderKeyStore();
	store.onChange(() => hydrateProviderKeys(settings));
	hydrateProviderKeys(settings);
	return store;
}

beforeEach(() => {
	seedUnifiedCredentials();
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: promotedId,
				prefix: promotedId,
				name: "Promoted relay",
				baseUrl: "https://relay.example/v1",
				apiKey: "",
				defaultModel: "m",
				protocol: "completions-compatible",
			},
		],
		nugProviders: [
			{
				id: nugId,
				prefix: nugId,
				name: "NUG",
				baseUrl: "https://nug.example",
				apiKey: "",
				defaultModel: "kiro:m",
			},
		],
		tokendance: { apiKey: "", generation: 0, disabled: false },
		commandCode: { baseUrl: "https://cc.example", apiKey: "", disabled: false },
	});
});

afterEach(() => {
	fixture?.dispose();
	fixture = undefined;
	mock.restore();
	const store = getProviderKeyStore();
	for (const id of groups) {
		quotaStore.forget(id);
		store.removeGroup(id);
	}
	saveSettings(structuredClone(saved));
});

for (const [id, template, projectedKey] of [
	["tokendance", "tokendance", () => settings.tokendance?.apiKey],
	["CommandCode", "command-code", () => settings.commandCode?.apiKey],
	[nugId, "nug", () => settings.nugProviders?.[0]?.apiKey],
] as const) {
	test(`${id}: persisted all-disabled pool never falls back to projected settings or CLI`, () => {
		const store = getProviderKeyStore();
		const first = store.addGroupCredential(id, template, {
			apiKey: `sk-${id}-first`,
			label: "first",
		});
		const second = store.addGroupCredential(id, template, {
			apiKey: `sk-${id}-second`,
			label: "second",
		});
		store.update(first.id, { disabled: true });
		expect(autoSourceFacts(id, now).available).toBe(true);
		store.update(second.id, { disabled: true });
		expect(autoSourceFacts(id, now).available).toBe(false);

		const restarted = rebuildStore();
		expect(getCredentialStore().unified).toBe(true);
		expect(restarted.listGroup(id)).toMatchObject([
			{ id: first.id, apiKey: first.apiKey, disabled: true },
			{ id: second.id, apiKey: second.apiKey, disabled: true },
		]);
		expect(projectedKey()).toBe(first.apiKey);
		expect(autoSourceFacts(id, now).available).toBe(false);
		expect(autoSourcePreview(id, now)?.label).toBeUndefined();
		restarted.update(second.id, { disabled: false });
		expect(autoSourceFacts(id, now).available).toBe(true);
		expect(autoSourcePreview(id, now)).toEqual({ label: "second" });
	});
}

test("promoting a plain settings key retains its quota id across unified-store reconstruction", async () => {
	const config = settings.customApiProviders?.find((entry) => entry.id === promotedId);
	if (!config) throw new Error("missing relay fixture");
	// Legacy config-only routing names the provider itself as the credential id.
	config.apiKey = "sk-promoted";
	fixture = legacyQuotaFixture(settings.customApiProviders, {
		scope: "key",
		windows: [],
		amounts: [{ id: "wallet", unit: "USD", remaining: 0 }],
	});
	fixture.advance(now - 1_000_000);
	await fixture.service.refresh(promotedId);
	expect(getProviderKeyStore().listGroup(promotedId)).toHaveLength(0);
	expect(autoSourceFacts(promotedId, now).available).toBe(false);
	saveSettings({ ...settings });
	// Promotion creates a credential target; query that target before rebuilding its storage facade.
	fixture.advance(10_000);
	await fixture.service.refreshKey(promotedId);
	const generation = required(fixture.service.peekKey(promotedId)).generation;

	const restarted = rebuildStore();
	fixture.service.sync();
	expect(fixture.service.peekKey(promotedId)?.generation).toBe(generation);
	expect(getCredentialStore().unified).toBe(true);
	expect(restarted.listGroup(promotedId)).toMatchObject([
		{ id: promotedId, apiKey: "sk-promoted" },
	]);
	expect(autoSourceFacts(promotedId, now).available).toBe(false);
	restarted.update(promotedId, { apiKey: "sk-replaced" });
	expect(autoSourceFacts(promotedId, now).available).toBe(true);
});
