import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import * as outbound from "../lib/net/outbound-fetch";
import * as quota from "../lib/nug-quota-cache";
import { getProviderKeyStore, nugKeyOwner } from "../lib/provider-keys";
import { getSettingsRevision, saveSettings, settings } from "../lib/settings";
import * as snapshots from "../lib/sourcing/quota-snapshots";
import { quotaStore } from "../lib/sourcing/quota-store";
import type { AuthSessionStore } from "../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../services/auth/store";
import { fetchAllNugQuotas } from "./nug";
import { quotaSnapshotRoutes } from "./quota-snapshots";

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
	outbound.setOutboundFetchOverrideForTest(null);
	quota.purgeNugQuotaCache([id]);
	getProviderKeyStore().removeProvider(nugKeyOwner(id));
	saveSettings(structuredClone(saved));
});

for (const source of ["startup", "unified refresh"] as const) {
	test(`${source} partial A response cannot inherit B's wallet after reorder`, async () => {
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
			finish.resolve(Response.json(source === "startup" ? { balance: 5 } : {}));
			await ownerTask;
			const response = await task;
			if (response) expect(response.status).toBe(200);
			expect(auth).toEqual(["Bearer credential-A"]);
			// Q's explicit probes keep absent fields unknown; only startup uses legacy fallback.
			const expectedA =
				source === "startup"
					? {
							balance: 5,
							totalGranted: 111,
							detailedQuotaBalance: "A probe details",
							extra: { owner: "A" },
						}
					: { balance: null, totalGranted: null, detailedQuotaBalance: null };
			expect(quotaStore.peek(first.id)?.detail).toEqual(expectedA);
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
			expect(quota.getNugQuotaSnapshot(id, first.id)?.snapshot?.detail).toEqual(expectedA);
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
