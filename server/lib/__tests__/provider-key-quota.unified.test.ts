import { afterAll, beforeAll, expect, mock, test } from "bun:test";
import { seedUnifiedCredentials } from "../../../tests/unified-credentials";
import { getProviderKeyStore, resetProviderKeyStoreForTests } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import {
	archivedQuotaFixture,
	bindLegacyQuotaService,
	closeQuotaTestPackage,
} from "./provider-quota-legacy-fixture";

const credentials = seedUnifiedCredentials();
const saved = structuredClone(settings);
const owner = "unified-key-quota";
const outbound = { ...(await import("../net/outbound-fetch")) };
const seen: string[] = [];
mock.module("../net/outbound-fetch", () => ({
	...outbound,
	outboundFetch: async (_url: URL, init: RequestInit) => {
		seen.push(new Headers(init.headers).get("Authorization") ?? "");
		return Response.json({
			limits: [
				{
					window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
					detail: { used: 20, limit: 100, resetTime: new Date(Date.now() + 3600000).toISOString() },
				},
			],
		});
	},
}));
const { getKimiKeyUsages, refreshAllKimiUsages, purgeKimiUsageCache } = await import(
	"../kimi-usage-cache"
);
let fixture: Awaited<ReturnType<typeof archivedQuotaFixture>>;
beforeAll(async () => {
	fixture = await archivedQuotaFixture();
	bindLegacyQuotaService(fixture.service);
});
afterAll(async () => {
	await fixture?.close();
	await closeQuotaTestPackage();
	purgeKimiUsageCache([owner]);
	getProviderKeyStore().removeProvider(owner);
	saveSettings(saved);
	mock.module("../net/outbound-fetch", () => outbound);
	mock.restore();
});

test("quota refresh reads both persisted unified credentials after store rebuild", async () => {
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: owner,
				name: "Unified quota",
				prefix: "unified-quota",
				apiKey: "first-quota-key",
				baseUrl: "https://api.kimi.com/coding/v1",
				defaultModel: "m",
				protocol: "anthropic-messages",
			},
		],
	});
	const first = getProviderKeyStore().list(owner)[0];
	const second = getProviderKeyStore().add(owner, { apiKey: "second-quota-key" });
	resetProviderKeyStoreForTests();
	await fixture.prepareProviders(settings.customApiProviders ?? []);
	await refreshAllKimiUsages();
	expect(seen.sort()).toEqual(["Bearer first-quota-key", "Bearer second-quota-key"]);
	for (const id of [first.id, second.id]) expect(getKimiKeyUsages()[id]?.fiveHour?.used).toBe(20);
	expect(credentials.written()).toBe(true);
});
