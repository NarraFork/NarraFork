import { Hono } from "hono";
import { NotFoundError, RateLimitError } from "../lib/errors";
import { providerBalanceCache } from "../lib/provider-balance-cache";
import { requireAdmin } from "../middleware/auth";
import { scheduleManualQuotaRefresh } from "./provider-quotas";

export const providerBalanceRoutes = new Hono();

// The /api authentication middleware in app.ts authenticates all of these routes.
// Every projection is credential-free; upstream exceptions/bodies never reach a role.
providerBalanceRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

providerBalanceRoutes.get("/", (c) => c.json(providerBalanceCache.read(c.req.query("providerId"))));

for (const action of ["probe", "refresh"] as const) {
	providerBalanceRoutes.post(`/:id/${action}`, requireAdmin, async (c) => {
		const id = c.req.param("id");
		if (!id || !providerBalanceCache.peek(id)) throw new NotFoundError("Provider", id ?? "");
		const retryAfterMs = providerBalanceCache.manualRetryAfterMs(id);
		if (retryAfterMs) {
			c.header("Retry-After", String(Math.ceil(retryAfterMs / 1_000)));
			throw new RateLimitError(
				"PROVIDER_BALANCE_THROTTLED",
				retryAfterMs,
				"Balance probe requested too frequently",
			);
		}
		// Start a coalesced, bounded job but do not hold the HTTP request open.
		await scheduleManualQuotaRefresh(c, [id], action);
		return c.json(providerBalanceCache.peek(id));
	});
}
