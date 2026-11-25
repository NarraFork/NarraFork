import { afterEach, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { NugProvider } from "../lib/agent/nug-provider";
import * as quota from "../lib/nug-quota-cache";
import { getSettingsRevision, settings } from "../lib/settings";
import { nugRoutes } from "./nug";

const app = new Hono().route("/api/nug", nugRoutes);
const id = "runtime-cached-nug";
afterEach(() => quota.purgeNugQuotaCache([id]));

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
