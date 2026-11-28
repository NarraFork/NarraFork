import { Hono } from "hono";
import { NotFoundError, RateLimitError } from "../lib/errors";
import { providerBalanceCache } from "../lib/provider-balance-cache";
import { requireAdmin, requireSessionAuth } from "../middleware/auth";
import { scheduleManualQuotaRefresh } from "./provider-quotas";

/** Admin-only capability diagnosis. Ordinary allowance reads use quota-snapshots. */
export const providerBalanceRoutes = new Hono();
providerBalanceRoutes.use("*", requireSessionAuth);
providerBalanceRoutes.post("/:id/probe", requireAdmin, async (c) => {
	c.header("Cache-Control", "no-store");
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
	await scheduleManualQuotaRefresh(c, [id], "probe");
	return c.json(providerBalanceCache.peek(id));
});
