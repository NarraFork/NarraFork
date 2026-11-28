import { afterAll, afterEach, beforeAll, describe, expect, spyOn, test } from "bun:test";
import { readFile, writeFile } from "node:fs/promises";
import type { CredentialNetwork } from "@shared/credential-network";
import { readLegacyQuotaCache } from "../../services/provider-quota-legacy-cache";
import { createProviderQuotaPersistence } from "../../services/provider-quota-persistence";
import { ProviderQuotaService, toQuotaSnapshot } from "../../services/provider-quota-service";
import { getNarraforkPath } from "../narrafork-home";
import { createPersistedCredentialCache } from "../persisted-credential-cache";
import {
	getProviderKeyStore,
	isTokenDanceLoginKey,
	TOKENDANCE_KEY_OWNER,
	withProviderKey,
} from "../provider-keys";
import { type CustomApiProviderConfig, saveSettings, settings } from "../settings";
import { quotaStore } from "../sourcing/quota-store";
import { WorkerHandle } from "../worker-runtime/lifecycle";
import {
	archivedQuotaFixture,
	closeQuotaTestPackage,
	deferred,
	required,
} from "./provider-quota-legacy-fixture";

const originalFetch = globalThis.fetch;
let archive: Awaited<ReturnType<typeof archivedQuotaFixture>>;
beforeAll(async () => {
	archive = await archivedQuotaFixture({
		fetch: async () => {
			throw new Error("legacy reads must stay offline");
		},
	});
	archive.service.stop();
});
afterAll(async () => {
	await archive?.close();
	await closeQuotaTestPackage();
});
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
				const id = `${source}-legacy-${crypto.randomUUID().slice(0, 16)}`;
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
				await archive.prepareProviders([config]);
				await archive.platform.providerSettingsService.list("custom-api", id);
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
				if (change.compatible) expect(legacy.restore(id, legacyIdentity)).toEqual(value);
				archive.directory.sync();
				const connection = required(archive.directory.getKey(key.id));
				const currentSource = required(
					archive.platform.quotaRegistry
						.listSources()
						.find((item) => item.contributionId === source),
				);
				const context = {
					pluginId: currentSource.pluginId,
					installationId: required(currentSource.installationId),
					sourceId: currentSource.id,
					sourceRevision: currentSource.revision,
					providerId: id,
					credentialId: key.id,
					isCurrent: () =>
						archive.platform.quotaRegistry
							.listSources()
							.some(
								(item) => item.id === currentSource.id && item.revision === currentSource.revision,
							) && archive.directory.getKey(key.id)?.identity === connection.identity,
				};
				const path = getNarraforkPath(
					source === "opencode" ? "opencode-usages.json" : "deepseek-balances.json",
				);
				const bytes = await readFile(path);
				if (change.compatible) {
					expect(currentSource.revision).toMatch(
						/^[^:]+:[a-f0-9]{64}:(opencode|deepseek):[a-f0-9]{64}\/[^/]+\/\d+$/,
					);
					const fields = JSON.parse(connection.identity);
					expect(fields.length).toBe(17);
					expect([fields[8], fields[9], fields[10], fields[11], fields[12], fields[13]]).toEqual([
						"claude-code",
						null,
						[],
						null,
						null,
						null,
					]);
				}
				const persistence = createProviderQuotaPersistence();
				const loaded = await persistence.load(connection.cacheId, connection.identity, context);
				await persistence.flush();
				const coldPersistence = createProviderQuotaPersistence();
				expect(
					await coldPersistence.load(connection.cacheId, connection.identity, context),
				).toEqual(loaded);
				await coldPersistence.flush();
				const service = new ProviderQuotaService({
					directory: archive.directory,
					persistence: coldPersistence,
					driver: {
						listSources: () => archive.platform.quotaRegistry.listSources(),
						query: async () => {
							throw new Error("unexpected probe");
						},
					},
					onChanged: () => {},
				});
				service.start();
				try {
					await coldPersistence.flush();
					const restored = service.peekKey(key.id);
					const snapshot = toQuotaSnapshot(restored);
					if (change.compatible) {
						expect(loaded).toMatchObject({ legacyDisplayOnly: true, fetchedAt: value.fetchedAt });
						expect(restored).toMatchObject({ stale: true, fetchedAt: value.fetchedAt });
						expect(
							source === "opencode"
								? snapshot?.windows[0]?.usedRatio
								: snapshot?.balances[0]?.remaining,
						).toBe(source === "opencode" ? 1 : 3.25);
					} else {
						expect(loaded).toBeUndefined();
						expect(snapshot).toBeUndefined();
					}
					expect(service.peekKeyForSelection(key.id)).toBeNull();
					expect(quotaStore.peek(key.id)).toBeUndefined();
				} finally {
					service.dispose();
					await coldPersistence.flush();
				}
				expect(await readFile(path)).toEqual(bytes);
				if (change.name === "original connection") {
					const late = deferred<typeof loaded>();
					const live = new ProviderQuotaService({
						directory: archive.directory,
						driver: {
							listSources: () => [currentSource],
							query: async () => ({
								status: "supported",
								error: null,
								data: {
									scope: "wallet",
									windows: [],
									amounts: [{ id: "live", unit: "USD", remaining: 7 }],
								},
							}),
						},
						persistence: {
							restore: () => undefined,
							load: () => late.promise,
							save() {},
							remove() {},
							async flush() {},
						},
						onChanged: () => {},
					});
					try {
						live.start();
						await live.refreshKey(key.id);
						late.resolve(loaded);
						await new Promise<void>((resolve) => setImmediate(resolve));
						expect(live.peekKey(key.id)).toMatchObject({
							stale: false,
							data: { amounts: [{ remaining: 7 }] },
						});
						expect(live.peekKeyForSelection(key.id)?.data?.amounts[0]?.remaining).toBe(7);
					} finally {
						live.dispose();
					}
					for (const denied of [
						{ ...context, pluginId: "third.party", sourceId: `third.party/${source}` },
						{ ...context, sourceId: `${context.pluginId}/relay` },
						{
							...context,
							sourceRevision: context.sourceRevision.replace(
								/:[a-f0-9]{64}:/,
								`:${"0".repeat(64)}:`,
							),
						},
						{ ...context, installationId: "different-installation" },
						{ ...context, isCurrent: () => false },
						{ ...context, isCurrent: undefined },
					])
						expect(
							await readLegacyQuotaCache(
								connection.cacheId,
								connection.identity,
								undefined,
								denied,
							),
						).toBeFalsy();
					await expect(
						readLegacyQuotaCache(
							connection.cacheId,
							connection.identity,
							AbortSignal.abort(),
							context,
						),
					).rejects.toThrow();
					const worker = spyOn(WorkerHandle, "thread").mockImplementation(() => {
						throw new Error("worker unavailable");
					});
					try {
						await expect(
							readLegacyQuotaCache(connection.cacheId, connection.identity, undefined, context),
						).rejects.toThrow("worker unavailable");
					} finally {
						worker.mockRestore();
					}
					try {
						for (const bad of ["{broken", " ".repeat(1024 * 1024 + 1)]) {
							await writeFile(path, bad);
							expect(
								await readLegacyQuotaCache(
									connection.cacheId,
									connection.identity,
									undefined,
									context,
								),
							).toBeNull();
							expect(await readFile(path, "utf8")).toBe(bad);
						}
						const oversized = JSON.parse(bytes.toString());
						oversized.entries[id].value.extra = "x".repeat(16 * 1024);
						await writeFile(path, JSON.stringify(oversized));
						expect(
							await readLegacyQuotaCache(
								connection.cacheId,
								connection.identity,
								undefined,
								context,
							),
						).toBeNull();
					} finally {
						await writeFile(path, bytes);
					}
					expect(await readFile(path)).toEqual(bytes);
				}
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
			const restored = service.getTokenDanceQuotaSnapshot(key.id);
			const identity = service.tokenDanceQuotaIdentity(withProviderKey(config, key));
			const snapshot = quotaStore.peekForIdentity(key.id, identity);
			expect(restored?.credentialId).toBe(key.id);
			if (change.compatible) {
				expect(snapshot?.balances[0]?.remaining).toBe(5);
				expect(restored?.snapshot?.detail).toMatchObject({ balance: 5_000_000 });
			} else {
				expect(snapshot).toBeUndefined();
				expect(restored?.snapshot).toBeUndefined();
			}
			await expect(service.refreshTokenDanceBalance(false, key.id)).rejects.toMatchObject({
				code: "TOKENDANCE_ERROR",
				statusCode: 502,
			});
			expect(service.getTokenDanceQuotaSnapshot(key.id)?.snapshot?.detail).toMatchObject({
				balance: change.compatible ? 5_000_000 : null,
				hasError: true,
			});
			// A legacy balance proves this key's allowance, never OAuth/portal provenance.
			expect(getProviderKeyStore().list(TOKENDANCE_KEY_OWNER).some(isTokenDanceLoginKey)).toBe(
				false,
			);
			expect(service.getTokenDanceQuotaSnapshot()).toBeUndefined();
			expect(service.getTokenDanceBalance().balance).toBeNull();
			await expect(service.refreshTokenDanceBalance(false)).rejects.toThrow("login");
		});
	}

	test.each([
		"getter",
		"ttl",
	] as const)("another manual key's first %s cannot consume the matching key's legacy balance", async (reader) => {
		settings.proxy = { mode: "direct" };
		settings.tokendance = { apiKey: "legacy-matching-key", disabled: false, generation: 321 };
		const config = structuredClone(settings.tokendance);
		const keys = getProviderKeyStore();
		// First in the pool is deliberately not the key named by the old fingerprint.
		// The TTL case also uses a transport the old serializer could not identify.
		const other = keys.add(TOKENDANCE_KEY_OWNER, {
			apiKey: "unrelated-manual-key",
			...(reader === "ttl" ? { network: { userAgentMode: "codex" as const } } : {}),
		});
		const matching = keys.add(TOKENDANCE_KEY_OWNER, { apiKey: config.apiKey });
		for (const key of [other, matching])
			owned.push({ providerId: TOKENDANCE_KEY_OWNER, keyId: key.id });
		const legacy = createPersistedCredentialCache("tokendance-balance.json", (raw) => raw);
		legacy.save("tokendance", JSON.stringify([config.apiKey, config.generation]), {
			credits: 8_000_000,
			creditsUsed: 3_000_000,
			balance: 5_000_000,
			updatedAt: Date.now(),
		});
		await legacy.flush();
		globalThis.fetch = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
		const service = (await import(
			`../../services/tokendance-service.ts?legacy=${crypto.randomUUID()}`
		)) as typeof import("../../services/tokendance-service");
		if (reader === "getter") {
			expect(service.getTokenDanceQuotaSnapshot(other.id)).toEqual({
				credentialId: other.id,
				snapshot: undefined,
			});
		} else {
			await expect(service.refreshTokenDanceBalance(false, other.id)).rejects.toMatchObject({
				code: "TOKENDANCE_ERROR",
				statusCode: 502,
			});
			expect(service.getTokenDanceQuotaSnapshot(other.id)?.snapshot?.detail).toMatchObject({
				balance: null,
				hasError: true,
			});
		}
		const restored = service.getTokenDanceQuotaSnapshot(matching.id);
		expect(restored?.credentialId).toBe(matching.id);
		expect(restored?.snapshot?.balances[0]?.remaining).toBe(5);
		expect(restored?.snapshot?.detail).toMatchObject({ balance: 5_000_000, hasError: false });
		expect(keys.list(TOKENDANCE_KEY_OWNER).some(isTokenDanceLoginKey)).toBe(false);
		expect(service.getTokenDanceQuotaSnapshot()).toBeUndefined();
		const connection = service.getTokenDanceConnection();
		if (!connection.billingInstance) throw new Error("Missing billing instance");
		await expect(
			service.createTokenDancePaymentSession("legacy-admin", {
				amount: 10,
				generation: connection.generation,
				billingInstance: connection.billingInstance,
				requestId: "legacy-nonportal-check",
			}),
		).rejects.toThrow("sign in again");
	});
});
