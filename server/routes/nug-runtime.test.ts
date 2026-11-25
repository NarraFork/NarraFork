import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import { setOutboundFetchOverrideForTest } from "../lib/net/outbound-fetch";
import * as quota from "../lib/nug-quota-cache";
import { streamQuotaIdentityForRequest } from "../lib/provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner } from "../lib/provider-keys";
import { getSettingsRevision, saveSettings, settings } from "../lib/settings";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../lib/sourcing/quota-store";
import { fetchAllNugQuotas, nugRoutes } from "./nug";

const app = new Hono().route("/api/nug", nugRoutes);
const id = "runtime-cached-nug";
const saved = structuredClone(settings);
afterEach(() => {
	setSystemTime();
	setOutboundFetchOverrideForTest(null);
	quota.purgeNugQuotaCache([id]);
	getProviderKeyStore().removeProvider(nugKeyOwner(id));
	saveSettings(structuredClone(saved));
});

for (const source of ["startup", "manual"] as const) {
	test(`${source} partial A quota response keeps A fallback after B becomes primary`, async () => {
		saveSettings({
			...settings,
			proxy: { mode: "direct" },
			nugProviders: [
				{
					id,
					name: "Captured quota",
					prefix: "cached-nug",
					apiKey: "credential-A",
					baseUrl: "https://quota-partial.invalid",
					defaultModel: "anthropic:test",
					proxy: { mode: "direct" },
				},
			],
		});
		const config = settings.nugProviders?.[0];
		if (!config) throw new Error("missing captured quota connection");
		const keys = getProviderKeyStore();
		const first = keys.list(nugKeyOwner(id))[0];
		if (!first) throw new Error("missing A credential");
		const capturedA = quota.captureNugQuotaSubject(config);
		quota.setNugCachedQuota(
			id,
			quota.buildNugQuotaCache({
				balance: 11,
				totalGranted: 111,
				detailedQuotaBalance: "A probe details",
				extra: { owner: "A" },
			}),
			capturedA,
		);
		const observedA = quotaStore.peek(first.id)?.fetchedAt;
		const backup = keys.add(nugKeyOwner(id), { apiKey: "credential-B" });
		keys.reorder(nugKeyOwner(id), [backup.id, first.id]);
		const capturedB = quota.captureNugQuotaSubject(config);
		quota.setNugCachedQuota(
			id,
			quota.buildNugQuotaCache({
				balance: 22,
				totalGranted: 222,
				detailedQuotaBalance: "B probe details",
				extra: { owner: "B" },
			}),
			capturedB,
		);
		const beforeB = structuredClone(quotaStore.peek(backup.id));
		keys.reorder(nugKeyOwner(id), [first.id, backup.id]);
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<Response>();
		const auth: Array<string | null> = [];
		setOutboundFetchOverrideForTest(async (_input, init) => {
			auth.push(new Headers(init?.headers).get("Authorization"));
			started.resolve();
			return finish.promise;
		});
		const task =
			source === "startup" ? fetchAllNugQuotas() : app.request(`/api/nug/providers/${id}/quota`);
		const settled = Promise.allSettled([task]);
		try {
			await started.promise;
			keys.reorder(nugKeyOwner(id), [backup.id, first.id]);
			finish.resolve(Response.json(source === "startup" ? { balance: 5 } : {}));
			const response = await task;
			if (response) expect(response.status).toBe(200);
			expect(auth).toEqual(["Bearer credential-A"]);
			const expectedA = {
				balance: source === "startup" ? 5 : 11,
				totalGranted: 111,
				detailedQuotaBalance: "A probe details",
				extra: { owner: "A" },
			};
			expect(quotaStore.peek(first.id)?.detail).toMatchObject(expectedA);
			const probe = quota.getNugCachedQuota(id, capturedA);
			expect(probe?._totalObservedAt ?? probe?.fetchedAt).toBe(observedA);
			if (source === "manual")
				expect(probe?._remainingObservedAt ?? probe?.fetchedAt).toBe(observedA);
			expect(quotaStore.peek(backup.id)).toEqual(beforeB);
			expect(quota.getNugCachedQuota(id)).toMatchObject({
				balance: 22,
				detailedQuotaBalance: "B probe details",
			});
			await quotaStore.flush();
			quotaStore.forget(first.id);
			expect(quota.getNugQuotaSnapshot(id, first.id)?.snapshot?.detail).toMatchObject(expectedA);
			expect(quotaStore.peek(backup.id)).toEqual(beforeB);
		} finally {
			finish.resolve(Response.json({}));
			await settled;
			setOutboundFetchOverrideForTest(null);
		}
	});
}

for (const source of ["startup", "manual", "manual reverse"] as const) {
	test(`${source} metadata-only probe keeps the real observation order against stream 0`, async () => {
		saveSettings({
			...settings,
			proxy: { mode: "direct" },
			nugProviders: [
				{
					id,
					name: "Timed quota",
					prefix: "cached-nug",
					apiKey: "credential-A",
					baseUrl: "https://quota-timed.invalid",
					defaultModel: "anthropic:test",
					proxy: { mode: "direct" },
				},
			],
		});
		const config = settings.nugProviders?.[0];
		if (!config) throw new Error("missing timed quota connection");
		const captured = quota.captureNugQuotaSubject(config);
		const start = Date.now();
		const probe = () =>
			quota.setNugCachedQuota(
				id,
				quota.buildNugQuotaCache({ balance: 11, totalGranted: 100 }),
				captured,
			);
		const stream = () =>
			quota.updateNugQuotaByPrefix(
				config.prefix,
				0,
				null,
				undefined,
				streamQuotaIdentityForRequest(config.prefix, { credentialId: captured.id }),
			);
		setSystemTime(start);
		if (source === "manual reverse") stream();
		else probe();
		setSystemTime(start + 1000);
		if (source === "manual reverse") probe();
		else stream();
		const streamBefore = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let payload: Record<string, unknown> = { totalGranted: 111 };
		let calls = 0;
		setOutboundFetchOverrideForTest(async () => {
			calls++;
			started.resolve();
			await finish.promise;
			return Response.json(payload);
		});
		const task =
			source === "startup" ? fetchAllNugQuotas() : app.request(`/api/nug/providers/${id}/quota`);
		const settled = Promise.allSettled([task]);
		try {
			await started.promise;
			setSystemTime(start + 2000);
			finish.resolve();
			await task;
			expect(quotaStore.peek(captured.id)?.fetchedAt).toBe(start + 2000);
			expect(quotaStore.peek(captured.id)?.balances[0]?.remaining).toBe(11);
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
			const header = await app.request(
				`/api/nug/quotas?providerId=${id}&expectedGeneration=${getSettingsRevision()}`,
			);
			expect((await header.json()).quota).toMatchObject({
				balance: source === "manual reverse" ? 11 : 0,
				totalGranted: 111,
			});
			expect(quota.getNugCachedQuota(id, captured)?._remainingObservedAt).toBe(
				start + (source === "manual reverse" ? 1000 : 0),
			);
			await quotaStore.flush();
			quotaStore.forget(captured.id);
			quotaStore.forget(captured.id, STREAM_QUOTA_SOURCE);
			expect(quota.getNugCachedQuota(id)).toMatchObject({
				balance: source === "manual reverse" ? 11 : 0,
				totalGranted: 111,
			});
			setSystemTime(start + 3000);
			payload = { balance: 11 };
			expect((await app.request(`/api/nug/providers/${id}/quota`)).status).toBe(200);
			expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 11, totalGranted: 111 });
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
			expect(calls).toBe(2);
		} finally {
			finish.resolve();
			await settled;
			setOutboundFetchOverrideForTest(null);
		}
	});
}

test("stream-only metadata stays displayable but explicit unknown and failed probes cannot revive it", async () => {
	saveSettings({
		...settings,
		proxy: { mode: "direct" },
		nugProviders: [
			{
				id,
				name: "Unknown quota",
				prefix: "cached-nug",
				apiKey: "credential-A",
				baseUrl: "https://quota-unknown.invalid",
				defaultModel: "anthropic:test",
				proxy: { mode: "direct" },
			},
		],
	});
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("missing unknown quota connection");
	const captured = quota.captureNugQuotaSubject(config);
	const start = Date.now();
	setSystemTime(start);
	quota.updateNugQuotaByPrefix(
		config.prefix,
		0,
		null,
		undefined,
		streamQuotaIdentityForRequest(config.prefix, { credentialId: captured.id }),
	);
	const streamBefore = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
	let payload: Record<string, unknown> = { totalGranted: 111, _remainingObservedAt: 987654321 };
	let status = 200;
	setOutboundFetchOverrideForTest(async () => Response.json(payload, { status }));
	const probe = () => app.request(`/api/nug/providers/${id}/quota`);
	setSystemTime(start + 1000);
	expect((await probe()).status).toBe(200);
	expect(quota.getNugCachedQuota(id, captured)).toMatchObject({
		balance: null,
		totalGranted: 111,
		_remainingObservedAt: null,
	});
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 0, totalGranted: 111 });
	await quotaStore.flush();
	quotaStore.forget(captured.id);
	quotaStore.forget(captured.id, STREAM_QUOTA_SOURCE);
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 0, totalGranted: 111 });
	setSystemTime(start + 2000);
	payload = { balance: null, _remainingObservedAt: null };
	expect((await probe()).status).toBe(200);
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	const beforeFailure = structuredClone(quotaStore.peek(captured.id));
	setSystemTime(start + 3000);
	status = 502;
	expect((await probe()).status).toBe(502);
	expect(quotaStore.peek(captured.id)).toEqual(beforeFailure);
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	setSystemTime(start + 4000);
	status = 200;
	payload = { balance: "invalid", _remainingObservedAt: null };
	expect((await probe()).status).toBe(200);
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	setSystemTime(start + 5000);
	payload = { totalGranted: 222 };
	expect((await probe()).status).toBe(200);
	expect(quota.getNugCachedQuota(id, captured)?._remainingObservedAt).toBe(start + 4000);
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: null, totalGranted: 222 });
	expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
});

test("header quota view only reads one identity-protected cache; never calls upstream RPC", async () => {
	settings.nugProviders = [
		{
			id,
			name: "Cached",
			prefix: "cached-nug",
			apiKey: "credential-A",
			baseUrl: "https://never-request.invalid",
			defaultModel: "anthropic:test",
		},
	];
	const rpc = spyOn(NugProvider.prototype, "getQuota").mockImplementation(async () => {
		throw new Error("forbidden quota RPC");
	});
	const fetchQuota = spyOn(quota, "fetchNugQuota").mockImplementation(async () => {
		throw new Error("forbidden quota fetch");
	});
	try {
		const url = `/api/nug/quotas?providerId=${id}&expectedGeneration=${getSettingsRevision()}`;
		const missing = await app.request(url);
		expect(missing.status).toBe(200);
		expect((await missing.json()).quota).toBeNull();
		quota.setNugCachedQuota(id, {
			balance: 12,
			totalGranted: 50,
			detailedQuotaBalance: "cached details",
			fetchedAt: 123,
			extra: { unused: "huge".repeat(300_000) },
		});
		const response = await app.request(url);
		const body = await response.text();
		expect(body.length).toBeLessThan(1024);
		expect(JSON.parse(body)).toEqual({
			generation: getSettingsRevision(),
			quota: {
				balance: 12,
				totalGranted: 50,
				detailedQuotaBalance: "cached details",
				fetchedAt: 123,
			},
		});
		expect(body).not.toContain("extra");
		expect(body).not.toContain("credential-A");
		expect(
			(
				await app.request(
					`/api/nug/quotas?providerId=${id}&expectedGeneration=${getSettingsRevision() + 1}`,
				)
			).status,
		).toBe(409);
		settings.nugProviders = settings.nugProviders.map((provider) => ({
			...provider,
			apiKey: "credential-B",
		}));
		expect((await (await app.request(url)).json()).quota).toBeNull();
		expect(rpc).not.toHaveBeenCalled();
		expect(fetchQuota).not.toHaveBeenCalled();
	} finally {
		rpc.mockRestore();
		fetchQuota.mockRestore();
	}
});
