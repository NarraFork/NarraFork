import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CredentialNetwork } from "@shared/credential-network";
import { getNarraforkPath } from "../narrafork-home";
import {
	buildNugQuotaCache,
	captureNugQuotaSubject,
	getAllNugCachedQuotas,
	getNugCachedQuota,
	nugQuotaIdentity,
	setNugCachedQuota,
	updateNugQuotaByPrefix,
} from "../nug-quota-cache";
import { streamQuotaIdentity, streamQuotaIdentityForPrefix } from "../provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { quotaStore } from "../sourcing/quota-store";
import { getServiceTemplate } from "../sourcing/templates";

const original = structuredClone(settings);
const originalFetch = globalThis.fetch;
const providerId = "nug-quota-test";

function useProvider() {
	saveSettings({
		...settings,
		nugProviders: [
			{
				id: providerId,
				name: "NUG quota",
				prefix: "nug-quota",
				baseUrl: "https://nug.example",
				apiKey: "key-one",
				defaultModel: "model",
			},
		],
	});
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("NUG test provider was not saved");
	return config;
}

function reportNugQuota(
	prefix: string,
	balance: number | null,
	detail?: string | null,
	extra?: unknown,
	identity = streamQuotaIdentityForPrefix(prefix),
): void {
	updateNugQuotaByPrefix(prefix, balance, detail, extra, identity);
}

function expectLateNugQuotaRejected(expectedIdentity: string): void {
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("NUG quota test provider missing");
	const key = getProviderKeyStore().listGroup(config.id)[0];
	const effectiveConfig = key ? withProviderKey(config, key) : config;
	expect(streamQuotaIdentity(config)).not.toBe(expectedIdentity);
	reportNugQuota("nug-quota", 99, null, undefined, expectedIdentity);
	expect(
		quotaStore.peekForIdentity(key?.id ?? config.id, nugQuotaIdentity(effectiveConfig)),
	).toBeUndefined();
	expect(getNugCachedQuota(providerId)).toBeUndefined();
	// A newly captured request is still allowed to publish under the new identity.
	reportNugQuota("nug-quota", 7);
	expect(getNugCachedQuota(providerId)?.balance).toBe(7);
}

afterEach(() => {
	for (const key of getProviderKeyStore().list(nugKeyOwner(providerId))) quotaStore.remove(key.id);
	quotaStore.remove(providerId);
	getProviderKeyStore().removeProvider(nugKeyOwner(providerId));
	saveSettings(original);
	globalThis.fetch = originalFetch;
});

describe("NUG quota snapshots", () => {
	test("legacy quotas round-trip field for field and stream updates stay partial", async () => {
		useProvider();
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({
				balance: 12,
				totalGranted: 30,
				detailedQuotaBalance: "wallet details",
				extra: { region: "test" },
			}),
		);
		expect(getAllNugCachedQuotas()).toEqual({
			[providerId]: {
				balance: 12,
				totalGranted: 30,
				detailedQuotaBalance: "wallet details",
				extra: { region: "test" },
			},
		});
		const credentialId = getProviderKeyStore().list(nugKeyOwner(providerId))[0]?.id ?? providerId;
		expect(quotaStore.peek(credentialId)?.balances).toEqual([
			{ unit: "", remaining: 12, total: 30 },
		]);

		reportNugQuota("nug-quota", 7);
		expect(getNugCachedQuota(providerId)).toEqual({
			balance: 7,
			totalGranted: 30,
			detailedQuotaBalance: "wallet details",
			extra: { region: "test" },
			fetchedAt: expect.any(Number),
		});
		await quotaStore.flush();
		expect(existsSync(getNarraforkPath("nug-quotas.json"))).toBe(false);
	});

	test("storage follows the first credential and rejects a late old-key publication", () => {
		const config = structuredClone(useProvider());
		const second = getProviderKeyStore().add(nugKeyOwner(providerId), { apiKey: "key-two" });
		getProviderKeyStore().reorder(nugKeyOwner(providerId), [second.id]);
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 5, totalGranted: 10 }));
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(5);
		expect(getNugCachedQuota(providerId)?.balance).toBe(5);

		// An answer fetched with key-one cannot replace key-two's snapshot.
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 99 }), config);
		expect(getNugCachedQuota(providerId)?.balance).toBe(5);
		getProviderKeyStore().update(second.id, { apiKey: "key-other" });
		expect(getNugCachedQuota(providerId)).toBeUndefined();
		quotaStore.remove(second.id);
	});

	const networkChanges: Array<[string, CredentialNetwork]> = [
		["proxy", { proxy: { mode: "custom", url: "http://new-proxy.example:8080" } }],
		["UA", { userAgentMode: "custom", customUserAgent: "new-stream-agent" }],
		["headers", { extraHeaders: { "X-Account": "new-stream-network" } }],
	];
	for (const [name, network] of networkChanges) {
		test(`a late event after the first key's ${name} changes cannot publish a new-network snapshot`, () => {
			useProvider();
			const key = getProviderKeyStore().listGroup(providerId)[0];
			if (!key) throw new Error("NUG quota test key missing");
			reportNugQuota("nug-quota", 12);
			const expectedIdentity = streamQuotaIdentityForPrefix("nug-quota");
			if (!expectedIdentity) throw new Error("NUG stream identity missing");
			getProviderKeyStore().update(key.id, { network });
			expectLateNugQuotaRejected(expectedIdentity);
		});
	}

	test("a late event after a global proxy change cannot publish a new-network snapshot", () => {
		useProvider();
		settings.proxy = { mode: "direct" };
		reportNugQuota("nug-quota", 12);
		const expectedIdentity = streamQuotaIdentityForPrefix("nug-quota");
		if (!expectedIdentity) throw new Error("NUG stream identity missing");
		settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
		expectLateNugQuotaRejected(expectedIdentity);
	});

	test("a late event cannot follow a same-secret replacement of the first credential", () => {
		useProvider();
		reportNugQuota("nug-quota", 12);
		const expectedIdentity = streamQuotaIdentityForPrefix("nug-quota");
		if (!expectedIdentity) throw new Error("NUG stream identity missing");
		const replacement = getProviderKeyStore().add(nugKeyOwner(providerId), { apiKey: "key-one" });
		getProviderKeyStore().reorder(nugKeyOwner(providerId), [replacement.id]);
		expectLateNugQuotaRejected(expectedIdentity);
	});

	test("a late event cannot follow a first-key secret edit hidden by the settings projection", () => {
		useProvider();
		const key = getProviderKeyStore().listGroup(providerId)[0];
		if (!key) throw new Error("NUG quota test key missing");
		reportNugQuota("nug-quota", 12);
		const expectedIdentity = streamQuotaIdentityForPrefix("nug-quota");
		if (!expectedIdentity) throw new Error("NUG stream identity missing");
		getProviderKeyStore().update(key.id, { apiKey: "key-secret-edited" });
		expectLateNugQuotaRejected(expectedIdentity);
	});

	test("a stream event from before a provider identity change is discarded", () => {
		const config = structuredClone(useProvider());
		const expectedIdentity = streamQuotaIdentity(config);
		saveSettings({ ...settings, nugProviders: [{ ...config, apiKey: "key-replacement" }] });
		reportNugQuota("nug-quota", 99, null, undefined, expectedIdentity);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
		updateNugQuotaByPrefix("nug-quota", 100, null, undefined, undefined);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
	});

	test("an actual secondary-key stream balance never overwrites the first key's wallet", () => {
		const config = useProvider();
		const keys = getProviderKeyStore();
		const first = keys.listGroup(config.id)[0];
		if (!first) throw new Error("NUG quota test key missing");
		const second = keys.add(nugKeyOwner(config.id), {
			apiKey: "secondary-key",
			network: { extraHeaders: { "X-Account": "secondary" } },
		});
		setNugCachedQuota(config.id, buildNugQuotaCache({ balance: 12, totalGranted: 30 }));
		const identity = streamQuotaIdentity(config, second.id);
		updateNugQuotaByPrefix(config.prefix, 0, "secondary balance", undefined, identity, second.id);
		expect(getNugCachedQuota(config.id)?.balance).toBe(12);
		expect(
			quotaStore.peekForIdentity(second.id, nugQuotaIdentity(withProviderKey(config, second)))
				?.balances[0]?.remaining,
		).toBe(0);
		keys.update(second.id, { network: { userAgentMode: "codex" } });
		updateNugQuotaByPrefix(config.prefix, 99, null, undefined, identity, second.id);
		expect(
			quotaStore.peekForIdentity(second.id, nugQuotaIdentity(withProviderKey(config, second))),
		).toBeUndefined();
		expect(getNugCachedQuota(config.id)?.balance).toBe(12);
	});

	test("a captured quota request cannot publish after a same-secret first-key switch", () => {
		const config = useProvider();
		const request = captureNugQuotaSubject(config);
		const replacement = getProviderKeyStore().add(nugKeyOwner(config.id), {
			apiKey: config.apiKey,
		});
		getProviderKeyStore().reorder(nugKeyOwner(config.id), [replacement.id]);
		setNugCachedQuota(config.id, buildNugQuotaCache({ balance: 99 }), request);
		expect(getNugCachedQuota(config.id)).toBeUndefined();
	});

	for (const endpoint of ["quota", "billing/config", "startup"] as const) {
		test(`${endpoint} requests use the effective credential proxy and publish matching snapshots`, async () => {
			settings.proxy = { mode: "direct" };
			const config = useProvider();
			const keys = getProviderKeyStore();
			const key = keys.listGroup(config.id)[0];
			if (!key) throw new Error("NUG quota test key missing");
			keys.update(key.id, {
				apiKey: "effective-request-key",
				network: { proxy: { mode: "custom", url: "http://quota-proxy.example:8080" } },
			});
			globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
				expect(new URL(String((init as RequestInit & { proxy?: string }).proxy)).host).toBe(
					"quota-proxy.example:8080",
				);
				expect(new Headers(init?.headers).get("Authorization")).toBe(
					"Bearer effective-request-key",
				);
				return Response.json({ balance: 5, totalGranted: 20 });
			}) as unknown as typeof fetch;
			const { nugRoutes, fetchAllNugQuotas } = await import("../../routes/nug");
			if (endpoint === "startup") {
				await fetchAllNugQuotas();
			} else {
				const response = await nugRoutes.request(`/providers/${config.id}/${endpoint}`);
				expect(response.status).toBe(200);
				expect(await response.json()).toMatchObject({ balance: 5, totalGranted: 20 });
			}
			expect(getNugCachedQuota(config.id)?.balance).toBe(5);
			expect(
				quotaStore.peekForIdentity(key.id, nugQuotaIdentity(withProviderKey(config, key)))
					?.balances[0]?.remaining,
			).toBe(5);
		});

		for (const change of ["global proxy", "key network"] as const) {
			test(`${endpoint} discards a response after its ${change} changes in flight`, async () => {
				settings.proxy = { mode: "direct" };
				const config = useProvider();
				const key = getProviderKeyStore().listGroup(config.id)[0];
				if (!key) throw new Error("NUG quota test key missing");
				let settle!: (response: Response) => void;
				let started!: () => void;
				const reached = new Promise<void>((resolve) => {
					started = resolve;
				});
				globalThis.fetch = (async () => {
					started();
					return new Promise<Response>((resolve) => {
						settle = resolve;
					});
				}) as unknown as typeof fetch;
				const { nugRoutes, fetchAllNugQuotas } = await import("../../routes/nug");
				const task =
					endpoint === "startup"
						? fetchAllNugQuotas()
						: nugRoutes.request(`/providers/${config.id}/${endpoint}`);
				await reached;
				if (change === "global proxy") {
					settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
				} else {
					getProviderKeyStore().update(key.id, { network: { userAgentMode: "codex" } });
				}
				settle(Response.json({ balance: 99, totalGranted: 100 }));
				await task;
				expect(getNugCachedQuota(config.id)).toBeUndefined();
			});
		}
	}

	test("the nug template probes into the shared shape", async () => {
		const config = useProvider();
		globalThis.fetch = (async () =>
			Response.json({
				balance: 4,
				totalGranted: 9,
				detailedQuotaBalance: "details",
			})) as unknown as typeof fetch;
		const snapshot = await getServiceTemplate("nug").probeQuota?.(
			{} as never,
			{ id: providerId, providerId, config },
			AbortSignal.timeout(1000),
		);
		expect(snapshot?.scope).toBe("wallet");
		expect(snapshot?.windows).toEqual([]);
		expect(snapshot?.balances).toEqual([{ unit: "", remaining: 4, total: 9 }]);
		expect(snapshot?.detail).toEqual({
			balance: 4,
			totalGranted: 9,
			detailedQuotaBalance: "details",
		});
	});
});
