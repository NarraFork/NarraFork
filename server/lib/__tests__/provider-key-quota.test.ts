/**
 * Usage per key: a Kimi provider with two keys keeps one usage entry per key, the
 * status bar keeps reporting the provider's first usable key, and the key pool skips
 * a key whose window the cache has seen used up.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

const actualOutbound = { ...(await import("../net/outbound-fetch")) };
const RESET = new Date(Date.now() + 2 * 60 * 60_000).toISOString();

mock.module("../net/outbound-fetch", () => ({
	...actualOutbound,
	outboundFetch: async (_url: URL, init: RequestInit) => {
		const auth = new Headers(init.headers).get("Authorization");
		// The first key has used its whole 5-hour window; the second has room.
		const used = auth === "Bearer sk-kimi-1" ? 100 : 20;
		const body = {
			limits: [
				{
					window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" },
					detail: { used, limit: 100, resetTime: RESET },
				},
			],
		};
		return new Response(JSON.stringify(body), {
			status: 200,
			headers: { "content-type": "application/json" },
		});
	},
}));

const { getProviderKeyStore } = await import("../provider-keys");
const { saveSettings, settings } = await import("../settings");
const { getAllKimiCachedUsages, getKimiKeyUsages, refreshAllKimiUsages, purgeKimiUsageCache } =
	await import("../kimi-usage-cache");
const { keyCooldown, resetProviderKeyRuntimeForTests, selectProviderKey } = await import(
	"../agent/pooled-provider"
);

afterAll(() => {
	mock.module("../net/outbound-fetch", () => actualOutbound);
	mock.restore();
});

const PROVIDER = "kimiQ";
let saved: typeof settings.customApiProviders;

beforeEach(() => {
	resetProviderKeyRuntimeForTests();
	saved = structuredClone(settings.customApiProviders);
	saveSettings({
		...settings,
		customApiProviders: [
			{
				id: PROVIDER,
				name: "Kimi Code",
				prefix: "kimiq",
				apiKey: "sk-kimi-1",
				baseUrl: "https://api.kimi.com/coding/v1",
				defaultModel: "kimi-for-coding",
				protocol: "anthropic-messages",
			},
		],
	});
});

afterEach(() => {
	purgeKimiUsageCache([PROVIDER]);
	saveSettings({ ...settings, customApiProviders: saved });
	getProviderKeyStore().removeProvider(PROVIDER);
});

describe("usage per key", () => {
	test("each key has its own usage; the provider reports its first key", async () => {
		const second = getProviderKeyStore().add(PROVIDER, { apiKey: "sk-kimi-2" });
		await refreshAllKimiUsages();
		const perKey = getKimiKeyUsages();
		expect(perKey[PROVIDER]?.fiveHour?.used).toBe(100);
		expect(perKey[second.id]?.fiveHour?.used).toBe(20);
		expect(getAllKimiCachedUsages()[PROVIDER]?.fiveHour?.used).toBe(100);

		// Putting the second key first changes what the provider reports.
		getProviderKeyStore().reorder(PROVIDER, [second.id]);
		expect(getAllKimiCachedUsages()[PROVIDER]?.fiveHour?.used).toBe(20);
	});

	test("the pool rests a used-up key until its window resets", async () => {
		const second = getProviderKeyStore().add(PROVIDER, { apiKey: "sk-kimi-2" });
		await refreshAllKimiUsages();
		expect(keyCooldown(PROVIDER)).toEqual({ until: Date.parse(RESET), reason: "quota" });
		expect(keyCooldown(second.id)).toBeUndefined();
		expect(selectProviderKey(PROVIDER, "new-session")?.id).toBe(second.id);
	});
});
