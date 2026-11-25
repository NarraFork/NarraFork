import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import * as outbound from "../lib/net/outbound-fetch";
import * as quota from "../lib/nug-quota-cache";
import { getSettingsRevision, settings } from "../lib/settings";
import * as snapshots from "../lib/sourcing/quota-snapshots";
import { quotaSnapshotRoutes } from "./quota-snapshots";

const app = new Hono();
app.use("*", async (c, next) => {
	c.set("user", { sub: "u1", role: "user", iat: 0, exp: Number.MAX_SAFE_INTEGER });
	c.set("auth", { type: "session", user: c.get("user") });
	await next();
});
app.route("/api/quota-snapshots", quotaSnapshotRoutes);
const id = "runtime-cached-nug";
const original = structuredClone(settings.nugProviders);
const originalCustom = structuredClone(settings.customApiProviders);
afterEach(() => {
	quota.purgeNugQuotaCache([id]);
	settings.nugProviders = original;
	settings.customApiProviders = originalCustom;
});
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
