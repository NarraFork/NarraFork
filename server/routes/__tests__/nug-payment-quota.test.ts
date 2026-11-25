import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { NugProvider } from "../../lib/agent/nug-provider";
import { AppError } from "../../lib/errors";
import { getNugCachedQuota } from "../../lib/nug-quota-cache";
import { saveSettings, settings } from "../../lib/settings";
import { requireSessionAuth } from "../../middleware/auth";
import { nugRoutes } from "../nug";

const saved = structuredClone(settings);
const provider = {
	id: "payment-quota-nug",
	name: "Payment NUG",
	prefix: "payment-quota-nug",
	baseUrl: "https://nug-payment.invalid",
	apiKey: "payment-private-key",
	defaultModel: "model",
};
function app(role?: "admin" | "user") {
	const result = new Hono();
	if (role)
		result.use("*", async (c, next) => {
			const user = { sub: `payment-${role}`, role, iat: 0, exp: Number.MAX_SAFE_INTEGER };
			c.set("user", user);
			c.set("auth", { type: "session", user });
			await next();
		});
	result.onError((error) => {
		if (error instanceof AppError)
			return Response.json({ error: error.code }, { status: error.statusCode });
		throw error;
	});
	result.use("*", requireSessionAuth);
	result.route("/api/nug", nugRoutes);
	return result;
}

beforeEach(() => saveSettings({ ...settings, nugProviders: [provider] }));
afterEach(() => {
	mock.restore();
	saveSettings(structuredClone(saved));
});

describe("NUG payment completion quota confirmation", () => {
	test("ordinary payer can obtain the settled balance before resuming; quota lists remain retired", async () => {
		const probe = spyOn(NugProvider.prototype, "getQuota").mockResolvedValue({
			balance: 25,
			totalGranted: 40,
			detailedQuotaBalance: "paid credit",
			extra: { account: "private-account", apiKey: "payment-private-key" },
		});
		const response = await app("user").request(`/api/nug/providers/${provider.id}/quota`);
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual({
			balance: 25,
			totalGranted: 40,
			detailedQuotaBalance: "paid credit",
		});
		expect(probe).toHaveBeenCalledTimes(1);
		expect(probe.mock.calls[0]?.[0]).toBeInstanceOf(AbortSignal);
		expect(getNugCachedQuota(provider.id)?.balance).toBe(25);
		expect((await app("user").request("/api/nug/quotas")).status).toBe(404);
	});
	test("anonymous callers remain rejected and unknown providers cannot trigger outbound reads", async () => {
		const probe = spyOn(NugProvider.prototype, "getQuota");
		expect((await app().request(`/api/nug/providers/${provider.id}/quota`)).status).toBe(401);
		expect((await app("user").request("/api/nug/providers/missing/quota")).status).toBe(404);
		expect(probe).not.toHaveBeenCalled();
	});
	test("upstream failures never expose account/key details to the payer", async () => {
		spyOn(NugProvider.prototype, "getQuota").mockRejectedValue(
			new Error("payment-private-key private-account Authorization"),
		);
		const response = await app("user").request(`/api/nug/providers/${provider.id}/quota`);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({ error: "quota_unavailable" });
	});
});
