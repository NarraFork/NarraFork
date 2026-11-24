import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { CredentialNetwork } from "@shared/credential-network";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import { getProviderKeyStore, TOKENDANCE_KEY_OWNER, withProviderKey } from "../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";
import * as quotaStoreModule from "../sourcing/quota-store";
import { quotaStore } from "../sourcing/quota-store";

const originalFetch = globalThis.fetch;
const owned: Array<{ providerId: string; keyId: string }> = [];
afterEach(async () => {
	globalThis.fetch = originalFetch;
	for (const item of owned.splice(0)) {
		quotaStore.remove(item.keyId);
		getProviderKeyStore().removeProvider(item.providerId);
	}
	await quotaStore.flush();
});

type Change = {
	name: string;
	compatible: boolean;
	network?: CredentialNetwork;
	configuredProxy?: CustomApiProviderConfig["proxy"];
	configuredTls?: boolean;
	changedGlobal?: boolean;
	changedSecret?: boolean;
};
const changes: Change[] = [
	{ name: "original connection", compatible: true },
	{
		name: "proxy recorded in the old fingerprint",
		compatible: true,
		configuredProxy: { mode: "custom", url: "http://recorded-proxy.example:8080" },
	},
	{ name: "TLS recorded in the old fingerprint", compatible: true, configuredTls: false },
	{
		name: "unrecorded per-key proxy override",
		compatible: false,
		network: { proxy: { mode: "custom", url: "http://new-proxy.example:8080" } },
	},
	{ name: "unrecorded UA", compatible: false, network: { userAgentMode: "codex" } },
	{
		name: "unrecorded headers",
		compatible: false,
		network: { extraHeaders: { "X-Account": "new-network" } },
	},
	{ name: "changed global proxy", compatible: false, changedGlobal: true },
	{ name: "changed effective secret", compatible: false, changedSecret: true },
];

for (const source of ["opencode", "deepseek"] as const) {
	describe(`${source} real legacy fingerprints`, () => {
		for (const change of changes) {
			test(change.name, async () => {
				settings.proxy = { mode: "direct" };
				const id = `${source}-legacy-${crypto.randomUUID()}`;
				const requested: CustomApiProviderConfig = {
					id,
					name: id,
					prefix: id,
					baseUrl:
						source === "opencode" ? "https://opencode.ai/zen/go/v1" : "https://api.deepseek.com/v1",
					apiKey: "legacy-original-key",
					defaultModel: "model",
					protocol: "anthropic-messages",
					...(change.configuredProxy ? { proxy: change.configuredProxy } : {}),
					...(change.configuredTls !== undefined
						? { tlsRejectUnauthorized: change.configuredTls }
						: {}),
				};
				saveSettings({ ...settings, customApiProviders: [requested] });
				const configured = settings.customApiProviders?.find((p) => p.id === id);
				if (!configured) throw new Error("legacy provider was not saved");
				const config = structuredClone(configured);
				const keyStore = getProviderKeyStore();
				const initial = keyStore.list(id)[0] ?? keyStore.add(id, { id, apiKey: config.apiKey });
				const key = keyStore.update(initial.id, {
					apiKey: change.changedSecret ? "replacement-key" : config.apiKey,
					network: change.network ?? null,
				});
				owned.push({ providerId: id, keyId: key.id });
				// These arrays are the byte-for-byte formats written on main, not the new helper.
				const legacyIdentity = JSON.stringify(
					source === "opencode"
						? [
								config.baseUrl,
								config.apiKey,
								config.proxy,
								config.tlsRejectUnauthorized,
								settings.proxy,
							]
						: [
								config.baseUrl,
								config.protocol,
								config.apiKey,
								config.proxy,
								config.tlsRejectUnauthorized,
								settings.proxy,
							],
				);
				const legacy = createPersistedCredentialCache(
					source === "opencode" ? "opencode-usages.json" : "deepseek-balances.json",
					(raw) => raw,
				);
				const value =
					source === "opencode"
						? {
								rolling: {
									status: "ok",
									percent: 100,
									resetsAt: new Date(Date.now() + 60_000).toISOString(),
								},
								weekly: null,
								monthly: null,
								fetchedAt: Date.now(),
								error: null,
							}
						: {
								isAvailable: true,
								balanceInfos: [
									{
										currency: "USD",
										totalBalance: "3.25",
										grantedBalance: "0",
										toppedUpBalance: "3.25",
									},
								],
								fetchedAt: Date.now(),
								error: null,
							};
				legacy.save(id, legacyIdentity, value);
				await legacy.flush();
				if (change.changedGlobal) {
					settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
				}
				const effective = withProviderKey(config, key);
				if (change.compatible) {
					expect(legacy.restore(id, legacyIdentity)).toEqual(value);
				}
				const migrate = spyOn(quotaStoreModule, "importLegacyQuotaCache");
				let identity: string;
				if (source === "opencode") {
					const cache = (await import(
						`../opencode-usage-cache.ts?legacy=${id}`
					)) as typeof import("../opencode-usage-cache");
					cache.syncOpencodeUsageCache();
					identity = cache.opencodeQuotaIdentity(effective);
				} else {
					const cache = (await import(
						`../deepseek-balance-cache.ts?legacy=${id}`
					)) as typeof import("../deepseek-balance-cache");
					cache.syncDeepSeekBalanceCache();
					identity = cache.deepSeekQuotaIdentity(effective);
				}
				const migratedItems = migrate.mock.calls[0]?.[2];
				migrate.mockRestore();
				const snapshot = quotaStore.peekForIdentity(key.id, identity);
				if (change.compatible) {
					expect(migratedItems).toEqual([
						{ legacyKey: id, id: key.id, identity: legacyIdentity, storeIdentity: identity },
					]);
					expect(snapshot).toBeDefined();
					expect(
						source === "opencode"
							? snapshot?.windows[0]?.usedRatio
							: snapshot?.balances[0]?.remaining,
					).toBe(source === "opencode" ? 1 : 3.25);
				} else {
					expect(snapshot).toBeUndefined();
				}
				await quotaStore.flush();
			});
		}
	});
}

describe("TokenDance real legacy fingerprints", () => {
	for (const change of changes.filter(
		(item) => item.configuredTls === undefined && !item.configuredProxy,
	)) {
		test(change.name, async () => {
			settings.proxy = { mode: "direct" };
			settings.tokendance = { apiKey: "legacy-original-key", disabled: false, generation: 123 };
			const config = structuredClone(settings.tokendance);
			const key = getProviderKeyStore().add(TOKENDANCE_KEY_OWNER, {
				apiKey: change.changedSecret ? "replacement-key" : config.apiKey,
				network: change.network,
			});
			owned.push({ providerId: TOKENDANCE_KEY_OWNER, keyId: key.id });
			const legacy = createPersistedCredentialCache("tokendance-balance.json", (raw) => raw);
			legacy.save("tokendance", JSON.stringify([config.apiKey, config.generation]), {
				credits: 8_000_000,
				creditsUsed: 3_000_000,
				balance: 5_000_000,
				updatedAt: Date.now(),
			});
			await legacy.flush();
			if (change.changedGlobal) {
				settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
			}
			globalThis.fetch = (async () =>
				new Response(null, { status: 503 })) as unknown as typeof fetch;
			const service = (await import(
				`../../services/tokendance-service.ts?legacy=${crypto.randomUUID()}`
			)) as typeof import("../../services/tokendance-service");
			const balance = service.getTokenDanceBalance();
			const identity = service.tokenDanceQuotaIdentity(withProviderKey(config, key));
			const snapshot = quotaStore.peekForIdentity(key.id, identity);
			if (change.compatible) {
				expect(snapshot?.balances[0]?.remaining).toBe(5);
				expect(balance.balance).toBe(5_000_000);
			} else {
				expect(snapshot).toBeUndefined();
				expect(balance.balance).toBeNull();
			}
			await service.refreshTokenDanceBalance();
		});
	}
});
