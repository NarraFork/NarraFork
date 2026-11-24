import { Hono } from "hono";
import {
	type DeepSeekBalanceCache,
	getAllDeepSeekCachedBalances,
	refreshStaleDeepSeekBalances,
} from "../lib/deepseek-balance-cache";
import { requireAdmin } from "../middleware/auth";
import { scheduleManualQuotaRefresh } from "./provider-quotas";

export const deepseekRoutes = new Hono();

deepseekRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

export function redactBalancesForRole(
	balances: Record<string, DeepSeekBalanceCache>,
	isAdmin: boolean,
): Record<
	string,
	DeepSeekBalanceCache | (Omit<DeepSeekBalanceCache, "error"> & { hasError: boolean })
> {
	if (isAdmin) return balances;
	return Object.fromEntries(
		Object.entries(balances).map(([id, { error, ...cache }]) => [
			id,
			{ ...cache, hasError: error !== null },
		]),
	);
}

// First-party session authentication is applied by app.ts before mounting.
deepseekRoutes.get("/balances", (c) => {
	void refreshStaleDeepSeekBalances().catch(() => {});
	return c.json(
		redactBalancesForRole(getAllDeepSeekCachedBalances(), c.get("user")?.role === "admin"),
	);
});

deepseekRoutes.post("/balances/refresh", requireAdmin, async (c) => {
	await scheduleManualQuotaRefresh(c, Object.keys(getAllDeepSeekCachedBalances()));
	return c.json(getAllDeepSeekCachedBalances());
});
