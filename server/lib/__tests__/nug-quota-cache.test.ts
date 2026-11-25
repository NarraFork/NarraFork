import { afterEach, describe, expect, setSystemTime, spyOn, test } from "bun:test";
import { existsSync } from "node:fs";
import type { CredentialNetwork } from "@shared/credential-network";
import { Hono } from "hono";
import { getNarraforkPath } from "../narrafork-home";
import * as outbound from "../net/outbound-fetch";
import {
	buildNugQuotaCache,
	captureNugQuotaSubject,
	getAllNugCachedQuotas,
	getNugCachedQuota,
	getNugQuotaSnapshot,
	isNugQuotaRefreshing,
	nugQuotaIdentity,
	probeNugQuota,
	purgeNugQuotaCache,
	refreshNugQuota,
	setNugCachedQuota,
	updateNugQuotaByPrefix,
} from "../nug-quota-cache";
import { streamQuotaIdentityForRequest } from "../provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner, withProviderKey } from "../provider-keys";
import { saveSettings, settings } from "../settings";
import { readQuotaSnapshots, refreshQuotaSnapshots } from "../sourcing/quota-snapshots";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../sourcing/quota-store";
import { getSourceGroup } from "../sourcing/source-groups";
import { getServiceTemplate } from "../sourcing/templates";

const original = structuredClone(settings);
const originalFetch = globalThis.fetch;
const providerId = "nug-quota-test";

/** 真实路由请求沿用普通会话权限；没有失败请求的 fixture 明确声明独立充值。 */
function requestNugRoute(routes: Hono, path: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const user = {
			sub: "quota-test-user",
			role: "user" as const,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		};
		c.set("auth", { type: "session", user });
		c.set("user", user);
		await next();
	});
	app.route("/", routes);
	return app.request(`${path}${path.endsWith("billing/config") ? "?mode=standalone" : ""}`);
}

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
	const keys = getProviderKeyStore();
	if (!keys.listGroup(providerId).length)
		keys.add(nugKeyOwner(providerId), { id: providerId, apiKey: config.apiKey });
	return config;
}

function reportNugQuota(
	prefix: string,
	balance: number | null,
	detail?: string | null,
	extra?: unknown,
	identity = streamQuotaIdentityForRequest(prefix, {
		credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
	}),
): void {
	updateNugQuotaByPrefix(prefix, balance, detail, extra, identity);
}

function expectLateNugQuotaRejected(expectedIdentity: string): void {
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("NUG quota test provider missing");
	const key = getProviderKeyStore().listGroup(config.id)[0];
	const effectiveConfig = key ? withProviderKey(config, key) : config;
	expect(streamQuotaIdentityForRequest("nug-quota", { credentialId: key?.id })).not.toBe(
		expectedIdentity,
	);
	reportNugQuota("nug-quota", 99, null, undefined, expectedIdentity);
	expect(
		quotaStore.peekForIdentity(
			key?.id ?? config.id,
			nugQuotaIdentity(effectiveConfig),
			STREAM_QUOTA_SOURCE,
		),
	).toBeUndefined();
	expect(getNugCachedQuota(providerId)).toBeUndefined();
	// A newly captured request is still allowed to publish under the new identity.
	reportNugQuota("nug-quota", 7);
	expect(getNugCachedQuota(providerId)?.balance).toBe(7);
}

afterEach(() => {
	setSystemTime();
	purgeNugQuotaCache([providerId]);
	getProviderKeyStore().removeProvider(nugKeyOwner(providerId));
	saveSettings(original);
	globalThis.fetch = originalFetch;
});

describe("NUG quota snapshots", () => {
	test("a failed first refresh preserves never-observed fields through a metadata-only startup", async () => {
		const config = useProvider();
		const captured = captureNugQuotaSubject(config);
		const start = Date.now();
		setSystemTime(start);
		const transport = spyOn(outbound, "outboundFetch").mockRejectedValue(new Error("offline"));
		try {
			await refreshNugQuota(providerId, captured.id);
			expect(getNugQuotaSnapshot(providerId, captured.id)?.snapshot).toMatchObject({
				error: "quota_unavailable",
				balances: [{ unit: "", remaining: null, remainingObservedAt: null, totalObservedAt: null }],
				detail: { _remainingObservedAt: null, _totalObservedAt: null },
			});
			setSystemTime(start + 1000);
			transport.mockResolvedValue(
				Response.json({ totalGranted: 111, _remainingObservedAt: 999999 }),
			);
			const { fetchAllNugQuotas } = await import("../../routes/nug");
			await fetchAllNugQuotas();
			const snapshot = getNugQuotaSnapshot(providerId, captured.id)?.snapshot;
			expect(snapshot?.error).toBeUndefined();
			expect(snapshot?.balances[0]).toEqual({
				unit: "",
				remaining: null,
				total: 111,
				remainingObservedAt: null,
			});
			expect(getNugCachedQuota(providerId, captured)?._remainingObservedAt).toBeNull();
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		} finally {
			transport.mockRestore();
		}
	});

	test("legacy quotas round-trip field for field and stream updates stay partial", async () => {
		useProvider();
		const start = Date.now();
		setSystemTime(start);
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

		setSystemTime(start + 1000);
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

	test("a non-first inference key owns stream balances without replacing its direct probe", () => {
		const config = useProvider();
		const store = getProviderKeyStore();
		const first = store.list(nugKeyOwner(providerId))[0];
		if (!first) throw new Error("Missing first NUG key");
		const second = store.add(nugKeyOwner(providerId), { apiKey: "key-two" });
		const expected = streamQuotaIdentityForRequest("nug-quota", { credentialId: second.id });
		quotaStore.set(second.id, nugQuotaIdentity(withProviderKey(config, second)), {
			fetchedAt: Date.now(),
			scope: "key",
			windows: [],
			balances: [{ unit: "", remaining: 22 }],
		});
		store.reorder(nugKeyOwner(providerId), [second.id, first.id]);
		store.reorder(nugKeyOwner(providerId), [first.id, second.id]);
		reportNugQuota("nug-quota", 7, null, undefined, expected);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
		expect(quotaStore.peek(second.id)?.balances[0]?.remaining).toBe(22);
		expect(quotaStore.peek(first.id, STREAM_QUOTA_SOURCE)).toBeUndefined();
		store.update(second.id, { apiKey: "key-replaced" });
		reportNugQuota("nug-quota", 99, null, undefined, expected);
		expect(quotaStore.peek(second.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(7);
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

	test("Auto excludes a newer stream zero through partial probes and recovers on a real newer balance", async () => {
		const config = useProvider();
		const captured = captureNugQuotaSubject(config);
		const { autoSourceFacts } = await import("../agent/auto-route-signals");
		const start = Date.now();
		setSystemTime(start);
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 11, totalGranted: 100 }), captured);
		setSystemTime(start + 1000);
		reportNugQuota(config.prefix, 0);
		expect(autoSourceFacts(config.prefix).available).toBe(false);
		setSystemTime(start + 2000);
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({ totalGranted: 111 }, getNugCachedQuota(providerId, captured)),
			captured,
		);
		expect(autoSourceFacts(config.prefix).available).toBe(false);
		setSystemTime(start + 3000);
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({ balance: 11 }, getNugCachedQuota(providerId, captured)),
			captured,
		);
		expect(autoSourceFacts(config.prefix).available).toBe(true);
	});

	for (const [probeBalance, streamBalance, available] of [
		[11, 0, true],
		[0, 11, false],
	] as const) {
		test(`same-ms probe ${probeBalance} wins stream ${streamBalance} in both legacy view and Auto`, async () => {
			const config = useProvider();
			const captured = captureNugQuotaSubject(config);
			const { autoSourceFacts } = await import("../agent/auto-route-signals");
			const now = Date.now();
			setSystemTime(now);
			setNugCachedQuota(
				providerId,
				buildNugQuotaCache({ balance: probeBalance, totalGranted: 100 }),
				captured,
			);
			reportNugQuota(config.prefix, streamBalance);
			expect(quotaStore.peek(captured.id)?.fetchedAt).toBe(now);
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)?.fetchedAt).toBe(now);
			expect(getNugCachedQuota(providerId)?.balance).toBe(probeBalance);
			expect(autoSourceFacts(config.prefix).available).toBe(available);
			expect(quotaStore.peek(captured.id)?.balances[0]?.remaining).toBe(probeBalance);
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)?.balances[0]?.remaining).toBe(
				streamBalance,
			);
		});
	}

	for (const invalid of ["not-a-time", Number.NaN, -1]) {
		test(`invalid stored observation ${String(invalid)} falls back to legacy authority, never to never-observed`, async () => {
			const config = useProvider();
			const captured = captureNugQuotaSubject(config);
			const start = Date.now();
			setSystemTime(start);
			reportNugQuota(config.prefix, 0);
			setSystemTime(start + 1000);
			quotaStore.set(
				captured.id,
				captured.identity,
				{
					fetchedAt: start + 1000,
					scope: "wallet",
					windows: [],
					balances: [{ unit: "", remaining: null, total: 111 }],
					detail: {
						balance: null,
						totalGranted: 111,
						detailedQuotaBalance: null,
						_remainingObservedAt: invalid,
					},
				},
				Number.isFinite(invalid) || typeof invalid === "string",
			);
			expect(getNugCachedQuota(providerId)?.balance).toBeNull();
			expect(getNugCachedQuota(providerId, captured)?._remainingObservedAt).toBeUndefined();
			if (!Number.isNaN(invalid)) {
				await quotaStore.flush();
				quotaStore.forget(captured.id);
				quotaStore.forget(captured.id, STREAM_QUOTA_SOURCE);
				expect(getNugCachedQuota(providerId)?.balance).toBeNull();
				expect(getNugCachedQuota(providerId, captured)?._remainingObservedAt).toBeUndefined();
			}
		});
	}

	test("owner clocks keep the stream TTL, restore errors and do not overlay an expired source", async () => {
		const config = useProvider();
		const captured = captureNugQuotaSubject(config);
		const { autoSourceFacts } = await import("../agent/auto-route-signals");
		const start = Date.now();
		setSystemTime(start);
		setNugCachedQuota(providerId, buildNugQuotaCache({ balance: 11, totalGranted: 100 }), captured);
		setSystemTime(start + 1000);
		reportNugQuota(config.prefix, 0);
		const stream = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
		setSystemTime(start + 2000);
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({ totalGranted: 111 }, getNugCachedQuota(providerId, captured)),
			captured,
		);
		const probe = structuredClone(quotaStore.peek(captured.id));
		if (!probe || !stream) throw new Error("missing timed owner snapshots");
		expect(autoSourceFacts(config.prefix).available).toBe(false);
		setSystemTime(start + 61001);
		expect(autoSourceFacts(config.prefix).available).toBe(true);
		setSystemTime(start + 3000);
		quotaStore.set(captured.id, captured.identity, {
			...probe,
			fetchedAt: start + 3000,
			error: "quota_unavailable",
		});
		expect(getNugQuotaSnapshot(providerId)?.snapshot?.error).toBe("quota_unavailable");
		expect(autoSourceFacts(config.prefix).available).toBe(false);
		await quotaStore.flush();
		quotaStore.forget(captured.id);
		expect(getNugQuotaSnapshot(providerId, captured.id)?.snapshot?.error).toBe("quota_unavailable");
		quotaStore.set(captured.id, captured.identity, probe);
		const expiredStream = { ...stream, expiresAt: start + 1500 };
		quotaStore.set(captured.id, captured.identity, expiredStream, true, STREAM_QUOTA_SOURCE);
		expect(getNugCachedQuota(providerId)?.balance).toBe(11);
		expect(autoSourceFacts(config.prefix).available).toBe(true);
		expect(
			getNugQuotaSnapshot(providerId, captured.id, STREAM_QUOTA_SOURCE)?.snapshot,
		).toHaveProperty("expiresAt", start + 1500);
		expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)?.fetchedAt).toBe(start + 1000);
	});

	test("captured fallback stays on A's probe slot across reorder while legacy keeps its merged first-key view", () => {
		const config = useProvider();
		const store = getProviderKeyStore();
		const capturedA = captureNugQuotaSubject(config);
		setNugCachedQuota(
			providerId,
			{
				...buildNugQuotaCache({
					balance: 11,
					totalGranted: 111,
					detailedQuotaBalance: "A probe",
					extra: { owner: "A" },
				}),
				fetchedAt: 100,
			},
			capturedA,
		);
		quotaStore.set(
			capturedA.id,
			capturedA.identity,
			{
				fetchedAt: 200,
				scope: "wallet",
				windows: [],
				balances: [{ unit: "", remaining: 0, total: 999 }],
				detail: {
					balance: 0,
					totalGranted: 999,
					detailedQuotaBalance: "A stream",
					extra: { owner: "A-stream" },
				},
			},
			false,
			STREAM_QUOTA_SOURCE,
		);
		expect(getNugCachedQuota(providerId)?.detailedQuotaBalance).toBe("A stream");
		const streamBefore = structuredClone(quotaStore.peek(capturedA.id, STREAM_QUOTA_SOURCE));
		const backup = store.add(nugKeyOwner(providerId), { apiKey: "key-two" });
		store.reorder(nugKeyOwner(providerId), [backup.id, capturedA.id]);
		const capturedB = captureNugQuotaSubject(config);
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({ balance: 22, totalGranted: 222, detailedQuotaBalance: "B probe" }),
			capturedB,
		);
		const beforeB = structuredClone(quotaStore.peek(backup.id));
		expect(getNugCachedQuota(providerId)?.balance).toBe(22);
		expect(getNugCachedQuota(providerId, capturedA)).toMatchObject({
			balance: 11,
			totalGranted: 111,
			detailedQuotaBalance: "A probe",
		});
		setNugCachedQuota(
			providerId,
			buildNugQuotaCache({ balance: 5 }, getNugCachedQuota(providerId, capturedA)),
			capturedA,
		);
		expect(getNugQuotaSnapshot(providerId, capturedA.id)?.snapshot?.detail).toEqual({
			_totalObservedAt: 100,
			balance: 5,
			totalGranted: 111,
			detailedQuotaBalance: "A probe",
			extra: { owner: "A" },
		});
		expect(getNugQuotaSnapshot(providerId, capturedA.id, STREAM_QUOTA_SOURCE)?.snapshot).toEqual(
			streamBefore,
		);
		expect(quotaStore.peek(backup.id)).toEqual(beforeB);
	});

	for (const change of ["secret", "network", "deleted CID"] as const) {
		test(`a captured fallback cannot inherit a new subject after ${change} changes`, () => {
			const config = useProvider();
			const store = getProviderKeyStore();
			const captured = captureNugQuotaSubject(config);
			setNugCachedQuota(
				providerId,
				buildNugQuotaCache({ balance: 11, detailedQuotaBalance: "retired A" }),
				captured,
			);
			if (change === "secret") store.update(captured.id, { apiKey: "rotated-key" });
			else if (change === "network")
				store.update(captured.id, {
					network: { userAgentMode: "custom", customUserAgent: "rotated-network" },
				});
			else {
				store.add(nugKeyOwner(providerId), { apiKey: captured.config.apiKey });
				store.remove(captured.id);
			}
			const current = captureNugQuotaSubject(config);
			setNugCachedQuota(
				providerId,
				buildNugQuotaCache({ balance: 99, detailedQuotaBalance: "new subject" }),
				current,
			);
			const before = structuredClone(quotaStore.peek(current.id));
			expect(getNugCachedQuota(providerId, captured)).toBeUndefined();
			setNugCachedQuota(
				providerId,
				buildNugQuotaCache({}, getNugCachedQuota(providerId, captured)),
				captured,
			);
			expect(quotaStore.peek(current.id)).toEqual(before);
			expect(getNugCachedQuota(providerId, current)?.detailedQuotaBalance).toBe("new subject");
		});
	}

	test("an empty credential probe preserves unknown amounts instead of manufacturing zero", async () => {
		const config = useProvider();
		const captured = captureNugQuotaSubject(config);
		expect(getNugCachedQuota(providerId, captured)).toBeUndefined();
		globalThis.fetch = (async () => Response.json({})) as unknown as typeof fetch;
		const snapshot = await probeNugQuota(captured, new AbortController().signal);
		expect(snapshot?.balances).toEqual([
			{ unit: "", remaining: null, remainingObservedAt: null, totalObservedAt: null },
		]);
		expect(snapshot?.detail).toEqual({
			balance: null,
			totalGranted: null,
			detailedQuotaBalance: null,
			_remainingObservedAt: null,
			_totalObservedAt: null,
		});
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
			const expectedIdentity = streamQuotaIdentityForRequest("nug-quota", {
				credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
			});
			if (!expectedIdentity) throw new Error("NUG stream identity missing");
			getProviderKeyStore().update(key.id, { network });
			expectLateNugQuotaRejected(expectedIdentity);
		});
	}

	test("a late event after a global proxy change cannot publish a new-network snapshot", () => {
		useProvider();
		settings.proxy = { mode: "direct" };
		reportNugQuota("nug-quota", 12);
		const expectedIdentity = streamQuotaIdentityForRequest("nug-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		if (!expectedIdentity) throw new Error("NUG stream identity missing");
		settings.proxy = { mode: "custom", url: "http://new-global-proxy.example:8080" };
		expectLateNugQuotaRejected(expectedIdentity);
	});

	test("a late event cannot follow a same-secret replacement of the first credential", () => {
		useProvider();
		reportNugQuota("nug-quota", 12);
		const expectedIdentity = streamQuotaIdentityForRequest("nug-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
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
		const expectedIdentity = streamQuotaIdentityForRequest("nug-quota", {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		if (!expectedIdentity) throw new Error("NUG stream identity missing");
		getProviderKeyStore().update(key.id, { apiKey: "key-secret-edited" });
		expectLateNugQuotaRejected(expectedIdentity);
	});

	test("a stream event from before a provider identity change is discarded", () => {
		const config = structuredClone(useProvider());
		const expectedIdentity = streamQuotaIdentityForRequest(config.prefix, {
			credentialId: getProviderKeyStore().listGroup(providerId)[0]?.id,
		});
		saveSettings({ ...settings, nugProviders: [{ ...config, apiKey: "key-replacement" }] });
		reportNugQuota("nug-quota", 99, null, undefined, expectedIdentity);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
		updateNugQuotaByPrefix("nug-quota", 100, null, undefined, undefined);
		expect(getNugCachedQuota(providerId)).toBeUndefined();
	});

	test("second-key probes use that key's transport and cannot replace the first view or a new identity", async () => {
		const config = useProvider();
		const store = getProviderKeyStore();
		const first = store.list(nugKeyOwner(providerId))[0];
		if (!first) throw new Error("Missing first NUG key");
		const second = store.add(nugKeyOwner(providerId), {
			apiKey: "key-two",
			network: { proxy: { mode: "custom", url: "http://second.proxy:8080" } },
		});
		let gate: ReturnType<typeof Promise.withResolvers<Response>> | undefined;
		const transport = spyOn(outbound, "outboundFetch").mockImplementation(
			async (_url, init, options) => {
				const auth = new Headers(init?.headers).get("Authorization");
				if (auth === "Bearer key-one") return Response.json({ balance: 9, totalGranted: 10 });
				expect(auth).toBe("Bearer key-two");
				expect(options?.proxyUrl).toBe("http://second.proxy:8080");
				return gate ? gate.promise : Response.json({ balance: 20, totalGranted: 30 });
			},
		);
		try {
			await refreshNugQuota(providerId);
			gate = Promise.withResolvers<Response>();
			const probing = refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
			expect(isNugQuotaRefreshing(providerId, second.id)).toBe(true);
			expect(isNugQuotaRefreshing(providerId)).toBe(false);
			expect(
				readQuotaSnapshots(true, false).entries.find((entry) => entry.credentialId === second.id)
					?.refreshing,
			).toBe(true);
			gate.resolve(Response.json({ balance: 20, totalGranted: 30 }));
			await probing;
			expect(getNugCachedQuota(providerId)?.balance).toBe(9);
			expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot?.balances[0]?.remaining).toBe(20);
			// Auto keyRouting consumes this exact exported effective-config fingerprint.
			expect(
				quotaStore.peekForIdentity(second.id, nugQuotaIdentity(withProviderKey(config, second)))
					?.balances[0]?.remaining,
			).toBe(20);
			reportNugQuota(
				"nug-quota",
				7,
				null,
				undefined,
				streamQuotaIdentityForRequest("nug-quota", { credentialId: second.id }),
			);
			const entries = readQuotaSnapshots(true, false).entries.filter(
				(entry) => entry.credentialId === second.id,
			);
			expect(
				entries.find((entry) => entry.source === "probe")?.snapshot?.balances[0]?.remaining,
			).toBe(20);
			expect(
				entries.find((entry) => entry.source === "quota_balance")?.snapshot?.balances[0]?.remaining,
			).toBe(7);
			for (const change of ["network", "headers", "key"] as const) {
				const late = Promise.withResolvers<Response>();
				transport.mockImplementation(async () => late.promise);
				const stale = refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
				if (change === "network")
					store.update(second.id, { network: { proxy: { mode: "direct" } } });
				else if (change === "headers")
					store.update(second.id, {
						network: { proxy: { mode: "direct" }, extraHeaders: { "X-Key-Route": "new" } },
					});
				else store.update(second.id, { apiKey: "key-replaced" });
				expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot).toBeUndefined();
				transport.mockImplementation(async () => Response.json({ balance: 30, totalGranted: 40 }));
				await refreshQuotaSnapshots({ groupId: providerId, credentialId: second.id });
				late.resolve(Response.json({ balance: 99, totalGranted: 100 }));
				await stale;
				expect(getNugQuotaSnapshot(providerId, second.id)?.snapshot?.balances[0]?.remaining).toBe(
					30,
				);
				expect(getNugCachedQuota(providerId)?.balance).toBe(9);
			}
		} finally {
			transport.mockRestore();
		}
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
		const identity = streamQuotaIdentityForRequest(config.prefix, { credentialId: second.id });
		updateNugQuotaByPrefix(config.prefix, 0, "secondary balance", undefined, identity);
		expect(getNugCachedQuota(config.id)?.balance).toBe(12);
		expect(
			quotaStore.peekForIdentity(
				second.id,
				nugQuotaIdentity(withProviderKey(config, second)),
				STREAM_QUOTA_SOURCE,
			)?.balances[0]?.remaining,
		).toBe(0);
		const updated = keys.update(second.id, { network: { userAgentMode: "codex" } });
		updateNugQuotaByPrefix(config.prefix, 99, null, undefined, identity);
		expect(
			quotaStore.peekForIdentity(
				second.id,
				nugQuotaIdentity(withProviderKey(config, updated)),
				STREAM_QUOTA_SOURCE,
			),
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
				const response = await requestNugRoute(nugRoutes, `/providers/${config.id}/${endpoint}`);
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
						: requestNugRoute(nugRoutes, `/providers/${config.id}/${endpoint}`);
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

	test("the leaf probe keeps unknown amounts distinct from explicit zero", async () => {
		const request = captureNugQuotaSubject(useProvider());
		globalThis.fetch = (async () =>
			Response.json({ balance: false, totalGranted: "" })) as unknown as typeof fetch;
		const unknown = await probeNugQuota(request, AbortSignal.timeout(1_000));
		expect(unknown.balances[0]?.remaining).toBeNull();
		expect(unknown.balances[0]).not.toHaveProperty("total");
		globalThis.fetch = (async () =>
			Response.json({ balance: 0, totalGranted: 0 })) as unknown as typeof fetch;
		expect((await probeNugQuota(request, AbortSignal.timeout(1_000))).balances).toEqual([
			{ unit: "", remaining: 0, total: 0 },
		]);
	});

	test("the nug template probes into the shared shape", async () => {
		useProvider();
		globalThis.fetch = (async () =>
			Response.json({
				balance: 4,
				totalGranted: 9,
				detailedQuotaBalance: "details",
			})) as unknown as typeof fetch;
		const credentialId = getProviderKeyStore().list(nugKeyOwner(providerId))[0]?.id;
		const group = getSourceGroup(providerId);
		if (!credentialId || !group) throw new Error("NUG template fixture is not registered");
		await getServiceTemplate("nug").probeQuota?.(group, credentialId);
		const snapshot = quotaStore.peek(credentialId);
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
