import { afterEach, expect, setSystemTime, spyOn, test } from "bun:test";
import { QuotaSnapshotIndicator } from "@frontend/components/narrator/model/QuotaSnapshotIndicator";
import { selectQuotaEntries } from "@frontend/hooks/useQuotaSnapshots";
import narratorLocale from "@frontend/locales/en/narrator.json";
import { MantineProvider } from "@mantine/core";
import type { PublicQuotaSnapshot, QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { Hono } from "hono";
import { createInstance } from "i18next";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nextProvider } from "react-i18next";
import { NugProvider } from "../lib/agent/nug-provider";
import * as outbound from "../lib/net/outbound-fetch";
import * as quota from "../lib/nug-quota-cache";
import { streamQuotaIdentityForRequest } from "../lib/provider-key-subjects";
import { getProviderKeyStore, nugKeyOwner } from "../lib/provider-keys";
import { getSettingsRevision, saveSettings, settings } from "../lib/settings";
import * as snapshots from "../lib/sourcing/quota-snapshots";
import { quotaStore, STREAM_QUOTA_SOURCE } from "../lib/sourcing/quota-store";
import type { AuthSessionStore } from "../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../services/auth/store";
import { fetchAllNugQuotas } from "./nug";
import { quotaSnapshotRoutes } from "./quota-snapshots";

const i18n = createInstance();
await i18n.init({
	lng: "en",
	defaultNS: "narrator",
	resources: { en: { narrator: narratorLocale } },
});
function renderQuota(snapshot: PublicQuotaSnapshot | null) {
	return renderToStaticMarkup(
		createElement(
			I18nextProvider,
			{ i18n },
			createElement(
				MantineProvider,
				null,
				createElement(QuotaSnapshotIndicator, { snapshot, title: "NUG", now: Date.now() }),
			),
		),
	);
}

function quotaApp(role: "user" | "admin" = "user") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: `runtime-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		c.set("auth", { type: "session", user: c.get("user") });
		await next();
	});
	return app.route("/api/quota-snapshots", quotaSnapshotRoutes);
}
const app = quotaApp();
const id = "runtime-cached-nug";
const saved = structuredClone(settings);
afterEach(() => {
	setAuthStores(undefined);
	setSystemTime();
	outbound.setOutboundFetchOverrideForTest(null);
	quota.purgeNugQuotaCache([id]);
	getProviderKeyStore().removeProvider(nugKeyOwner(id));
	saveSettings(structuredClone(saved));
});

for (const source of ["startup", "unified refresh"] as const) {
	test(`${source} partial A response cannot inherit B's wallet after reorder`, async () => {
		const startedAt = Date.now();
		setSystemTime(startedAt);
		const session: AuthSessionStore = {
			...authSessionStore,
			findSessionState: async (userId) => ({
				id: userId,
				role: userId === "runtime-admin" ? "admin" : "user",
				tokenVersion: 0,
			}),
		};
		setAuthStores({ session, mfa: authMfaStore });
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
		if (!keys.list(nugKeyOwner(id)).length)
			keys.add(nugKeyOwner(id), { id, apiKey: "credential-A" });
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
		outbound.setOutboundFetchOverrideForTest(async (_input, init) => {
			auth.push(new Headers(init?.headers).get("Authorization"));
			started.resolve();
			return finish.promise;
		});
		const admin = quotaApp("admin");
		const task =
			source === "startup"
				? fetchAllNugQuotas()
				: admin.request("/api/quota-snapshots/refresh", {
						method: "POST",
						headers: { "Content-Type": "application/json" },
						body: JSON.stringify({ groupId: id, credentialId: capturedA.id }),
					});
		let ownerTask: Promise<void> | undefined;
		const settled = Promise.allSettled([task]);
		try {
			if (source === "unified refresh") {
				const response = await task;
				if (!response) throw new Error("missing Unified refresh response");
				expect(response.status).toBe(200);
			}
			await started.promise;
			keys.reorder(nugKeyOwner(id), [backup.id, first.id]);
			if (source === "unified refresh") {
				expect(quota.isNugQuotaRefreshing(id, capturedA.id)).toBe(true);
				// Join the existing CID owner started by the real Unified API, never start B.
				ownerTask = quota.refreshNugQuota(id, capturedA.id);
			}
			setSystemTime(startedAt + 1000);
			finish.resolve(Response.json(source === "startup" ? { balance: 5 } : {}));
			await ownerTask;
			const response = await task;
			if (response) expect(response.status).toBe(200);
			expect(auth).toEqual(["Bearer credential-A"]);
			// Q's explicit probes keep absent fields unknown; only startup uses captured fallback.
			const expectedA =
				source === "startup"
					? {
							balance: 5,
							totalGranted: 111,
							detailedQuotaBalance: "A probe details",
							extra: { owner: "A" },
							_totalObservedAt: observedA,
						}
					: {
							balance: null,
							totalGranted: null,
							detailedQuotaBalance: null,
							_remainingObservedAt: null,
							_totalObservedAt: null,
						};
			expect(quotaStore.peek(first.id)?.detail).toEqual(expectedA);
			const probe = quota.getNugCachedQuota(id, capturedA);
			if (source === "startup") expect(probe?._totalObservedAt ?? probe?.fetchedAt).toBe(observedA);
			else expect(probe?._remainingObservedAt).toBeNull();
			expect(quotaStore.peek(backup.id)).toEqual(beforeB);
			const view = await (await admin.request(url())).json();
			expect(
				view.entries.find(
					(entry: { credentialId: string; source: string }) =>
						entry.credentialId === backup.id && entry.source === "probe",
				)?.snapshot?.balances[0]?.remaining,
			).toBe(22);
			expect(
				view.entries.find(
					(entry: { credentialId: string; source: string }) =>
						entry.credentialId === first.id && entry.source === "probe",
				)?.snapshot?.balances[0]?.remaining,
			).toBe(expectedA.balance);
			await quotaStore.flush();
			quotaStore.forget(first.id);
			expect(quota.getNugQuotaSnapshot(id, first.id)?.snapshot?.detail).toMatchObject(expectedA);
			expect(quotaStore.peek(backup.id)).toEqual(beforeB);
		} finally {
			finish.resolve(Response.json({}));
			await settled;
			await ownerTask;
			outbound.setOutboundFetchOverrideForTest(null);
		}
	});
}

const url = (revision = getSettingsRevision()) =>
	`/api/quota-snapshots?groupId=${id}&cachedOnly=true&expectedGeneration=${revision}`;

for (const source of ["startup", "startup reverse"] as const) {
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
		if (source === "startup reverse") stream();
		else probe();
		setSystemTime(start + 1000);
		if (source === "startup reverse") probe();
		else stream();
		const streamBefore = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
		const started = Promise.withResolvers<void>();
		const finish = Promise.withResolvers<void>();
		let payload: Record<string, unknown> = { totalGranted: 111 };
		let calls = 0;
		outbound.setOutboundFetchOverrideForTest(async () => {
			calls++;
			started.resolve();
			await finish.promise;
			return Response.json(payload);
		});
		const task = fetchAllNugQuotas();
		const settled = Promise.allSettled([task]);
		try {
			await started.promise;
			setSystemTime(start + 2000);
			finish.resolve();
			await task;
			expect(quotaStore.peek(captured.id)?.fetchedAt).toBe(start + 2000);
			expect(quotaStore.peek(captured.id)?.balances[0]?.remaining).toBe(11);
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
			const header = await app.request(url());
			expect(header.status).toBe(200);
			const publicView: QuotaSnapshotsResponse = await header.json();
			const projection = selectQuotaEntries(publicView.entries)[0]?.snapshot;
			expect(projection?.balances[0]).toMatchObject({
				remaining: source === "startup reverse" ? 11 : 0,
				total: 111,
			});
			const balance = projection?.balances[0];
			expect(
				balance?.remainingObservedAt === undefined
					? projection?.fetchedAt
					: balance.remainingObservedAt,
			).toBe(start + 1000);
			expect(
				balance?.totalObservedAt === undefined ? projection?.fetchedAt : balance.totalObservedAt,
			).toBe(start + 2000);
			const html = renderQuota(projection ?? null);
			expect(html).toContain(source === "startup reverse" ? "Balance: 11" : "Balance: 0");
			expect(html).toContain("Total: 111");
			expect(JSON.stringify(publicView)).not.toMatch(
				/credential-A|_remainingObservedAt|_totalObservedAt|detail|extra/,
			);
			expect(quota.getNugCachedQuota(id, captured)?._remainingObservedAt).toBe(
				start + (source === "startup reverse" ? 1000 : 0),
			);
			await quotaStore.flush();
			quotaStore.forget(captured.id);
			quotaStore.forget(captured.id, STREAM_QUOTA_SOURCE);
			expect(quota.getNugCachedQuota(id)).toMatchObject({
				balance: source === "startup reverse" ? 11 : 0,
				totalGranted: 111,
			});
			setSystemTime(start + 3000);
			payload = { balance: 11 };
			await fetchAllNugQuotas();
			expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 11, totalGranted: 111 });
			const recovered: QuotaSnapshotsResponse = await (await app.request(url())).json();
			const recoveredProjection = selectQuotaEntries(recovered.entries)[0]?.snapshot;
			expect(recoveredProjection?.balances[0]?.remaining).toBe(11);
			expect(renderQuota(recoveredProjection ?? null)).toContain("Balance: 11");
			expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
			expect(calls).toBe(2);
		} finally {
			finish.resolve();
			await settled;
			outbound.setOutboundFetchOverrideForTest(null);
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
	outbound.setOutboundFetchOverrideForTest(async () => Response.json(payload, { status }));
	const probe = () => fetchAllNugQuotas();
	setSystemTime(start + 1000);
	await probe();
	expect(quota.getNugCachedQuota(id, captured)).toMatchObject({
		balance: null,
		totalGranted: 111,
		_remainingObservedAt: null,
	});
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 0, totalGranted: 111 });
	const body: QuotaSnapshotsResponse = await (await app.request(url())).json();
	const rawProbe = body.entries.find((entry) => entry.source === "probe");
	expect(rawProbe?.snapshot?.balances[0]?.remaining).toBeNull();
	expect(rawProbe?.snapshot?.balances[0]?.remainingObservedAt).toBeNull();
	const display = selectQuotaEntries(body.entries)[0]?.snapshot;
	expect(renderQuota(display ?? null)).toContain("Balance: 0");
	expect(renderQuota(display ?? null)).toContain("Total: 111");
	expect(JSON.stringify(body)).not.toMatch(
		/_remainingObservedAt|_totalObservedAt|credential-A|detail/,
	);
	await quotaStore.flush();
	quotaStore.forget(captured.id);
	quotaStore.forget(captured.id, STREAM_QUOTA_SOURCE);
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: 0, totalGranted: 111 });
	setSystemTime(start + 2000);
	payload = { balance: null, _remainingObservedAt: null };
	await probe();
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	const beforeFailure = structuredClone(quotaStore.peek(captured.id));
	setSystemTime(start + 3000);
	status = 502;
	await probe();
	expect(quotaStore.peek(captured.id)).toEqual(beforeFailure);
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	setSystemTime(start + 4000);
	status = 200;
	payload = { balance: "invalid", _remainingObservedAt: null };
	await probe();
	expect(quota.getNugCachedQuota(id)?.balance).toBeNull();
	setSystemTime(start + 5000);
	payload = { totalGranted: 222 };
	await probe();
	expect(quota.getNugCachedQuota(id, captured)?._remainingObservedAt).toBe(start + 4000);
	expect(quota.getNugCachedQuota(id)).toMatchObject({ balance: null, totalGranted: 222 });
	expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
});

test("legacy error → metadata-only startup → real stream keeps amount clocks, public UI and Auto on one owner", async () => {
	configure();
	const config = settings.nugProviders?.[0];
	if (!config) throw new Error("missing legacy error fixture");
	const captured = quota.captureNugQuotaSubject(config);
	const { autoSourceFacts } = await import("../lib/agent/auto-route-signals");
	const start = Date.now();
	setSystemTime(start);
	quota.setNugCachedQuota(
		id,
		{
			balance: 11,
			totalGranted: 100,
			detailedQuotaBalance: "private old quota",
			fetchedAt: start,
			extra: { token: "private old token" },
		},
		captured,
	);
	const old = quotaStore.peek(captured.id);
	if (!old) throw new Error("missing legacy probe");
	const window = { kind: "weekly" as const, usedRatio: 0.2, resetsAt: start + 10_000 };
	quotaStore.set(captured.id, captured.identity, {
		...old,
		plan: "Probe plan",
		windows: [window],
		expiresAt: start + 10_000,
	});
	setSystemTime(start + 1000);
	quota.updateNugQuotaByPrefix(
		config.prefix,
		0,
		null,
		undefined,
		streamQuotaIdentityForRequest(config.prefix, { credentialId: captured.id }),
	);
	const streamBefore = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
	outbound.setOutboundFetchOverrideForTest(async () =>
		Response.json({ error: "failed" }, { status: 502 }),
	);
	setSystemTime(start + 2000);
	await quota.refreshNugQuota(id, captured.id);
	const failed = quotaStore.peek(captured.id);
	expect(failed).toMatchObject({
		fetchedAt: start + 2000,
		error: "quota_unavailable",
		plan: "Probe plan",
		expiresAt: start + 10_000,
		windows: [window],
		balances: [{ remaining: 11, total: 100, remainingObservedAt: start, totalObservedAt: start }],
		detail: { _remainingObservedAt: start, _totalObservedAt: start },
	});
	let body: QuotaSnapshotsResponse = await (await app.request(url())).json();
	const failedDisplay = selectQuotaEntries(body.entries)[0]?.snapshot;
	expect(renderQuota(failedDisplay ?? null)).toContain("figures may be out of date");
	expect(autoSourceFacts(config.prefix).available).toBe(false);
	outbound.setOutboundFetchOverrideForTest(async () => Response.json({ totalGranted: 111 }));
	setSystemTime(start + 3000);
	await fetchAllNugQuotas();
	expect(quotaStore.peek(captured.id)?.balances[0]).toMatchObject({
		remaining: 11,
		total: 111,
		remainingObservedAt: start,
	});
	expect(quotaStore.peek(captured.id)?.error).toBeUndefined();
	expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamBefore);
	body = await (await app.request(url())).json();
	let display = selectQuotaEntries(body.entries)[0]?.snapshot;
	expect(display?.balances[0]).toMatchObject({
		remaining: 0,
		total: 111,
		remainingObservedAt: start + 1000,
		totalObservedAt: start + 3000,
	});
	expect(renderQuota(display ?? null)).toContain("Balance: 0");
	expect(renderQuota(display ?? null)).toContain("Total: 111");
	expect(autoSourceFacts(config.prefix).available).toBe(false);
	const probeBefore = structuredClone(quotaStore.peek(captured.id));
	setSystemTime(start + 4000);
	quota.updateNugQuotaByPrefix(
		config.prefix,
		7,
		null,
		undefined,
		streamQuotaIdentityForRequest(config.prefix, { credentialId: captured.id }),
	);
	expect(quotaStore.peek(captured.id)).toEqual(probeBefore);
	body = await (await app.request(url())).json();
	display = selectQuotaEntries(body.entries)[0]?.snapshot;
	expect(display?.balances[0]).toMatchObject({ remaining: 7, total: 111 });
	expect(renderQuota(display ?? null)).toContain("Balance: 7");
	expect(autoSourceFacts(config.prefix).available).toBe(true);
	const streamAfter = structuredClone(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE));
	setSystemTime(start + 5000);
	outbound.setOutboundFetchOverrideForTest(async () =>
		Response.json({ balance: 11, totalGranted: 111 }),
	);
	await quota.refreshNugQuota(id, captured.id);
	body = await (await app.request(url())).json();
	expect(renderQuota(selectQuotaEntries(body.entries)[0]?.snapshot ?? null)).toContain(
		"Balance: 11",
	);
	expect(autoSourceFacts(config.prefix).available).toBe(true);
	expect(quotaStore.peek(captured.id, STREAM_QUOTA_SOURCE)).toEqual(streamAfter);
	expect(JSON.stringify(body)).not.toMatch(
		/private old|credential-A|_remainingObservedAt|_totalObservedAt|detail|extra/,
	);
});

function configure() {
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
}

test("header quota view reads only its scoped cache, enforces generation and omits private oversized detail", async () => {
	configure();
	settings.customApiProviders = [
		{
			id: "unrelated-deepseek",
			name: "Other source",
			prefix: "other",
			apiKey: "other-secret",
			baseUrl: "https://api.deepseek.com/v1",
			defaultModel: "m",
			protocol: "completions-compatible",
		},
	];
	const network = spyOn(outbound, "outboundFetch").mockImplementation(async () => {
		throw new Error("cached group read triggered another source");
	});
	const rpc = spyOn(NugProvider.prototype, "getQuota").mockImplementation(async () => {
		throw new Error("forbidden quota RPC");
	});
	const fetchQuota = spyOn(quota, "fetchNugQuota").mockImplementation(async () => {
		throw new Error("forbidden quota fetch");
	});
	try {
		const missing = await app.request(url());
		expect(missing.status).toBe(200);
		expect((await missing.json()).entries[0].snapshot).toBeNull();
		quota.setNugCachedQuota(id, {
			balance: 12,
			totalGranted: 50,
			detailedQuotaBalance: "cached details",
			fetchedAt: 123,
			extra: { unused: "huge".repeat(300_000) },
		});
		const response = await app.request(url());
		const body = await response.text();
		expect(body.length).toBeLessThan(1024);
		const projection = JSON.parse(body);
		expect(projection.entries).toHaveLength(1);
		expect(projection.entries[0]).toMatchObject({
			groupId: id,
			credentialId: null,
			source: "probe",
			snapshot: {
				scope: "wallet",
				fetchedAt: 123,
				windows: [],
				balances: [{ unit: "", remaining: 12, total: 50 }],
			},
		});
		expect(body).not.toContain("extra");
		expect(body).not.toContain("cached details");
		expect(body).not.toContain("credential-A");
		expect((await app.request(url(getSettingsRevision() + 1))).status).toBe(409);
		settings.nugProviders = settings.nugProviders?.map((provider) => ({
			...provider,
			apiKey: "credential-B",
		}));
		expect((await (await app.request(url())).json()).entries[0].snapshot).toBeNull();
		expect(rpc).not.toHaveBeenCalled();
		expect(fetchQuota).not.toHaveBeenCalled();
		expect(network).not.toHaveBeenCalled();
	} finally {
		network.mockRestore();
		rpc.mockRestore();
		fetchQuota.mockRestore();
	}
});

test("scoped cached quota reads fail closed above their 64 KiB response budget", async () => {
	configure();
	const projection = spyOn(snapshots, "readQuotaSnapshots").mockReturnValue({
		entries: [
			{
				groupId: id,
				prefix: "cached-nug",
				templateId: "nug",
				credentialId: null,
				snapshot: {
					scope: "wallet",
					fetchedAt: 1,
					windows: [],
					balances: [],
					plan: "x".repeat(64 * 1024),
				},
			},
		],
	});
	try {
		const response = await app.request(url());
		expect(response.status).toBe(502);
		expect(await response.json()).toMatchObject({ code: "QUOTA_RESPONSE_TOO_LARGE" });
	} finally {
		projection.mockRestore();
	}
});
