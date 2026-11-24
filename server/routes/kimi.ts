import { Hono } from "hono";
import {
	getAllKimiCachedUsages,
	type KimiUsageCache,
	refreshStaleKimiUsages,
} from "../lib/kimi-usage-cache";
import { requireAdmin } from "../middleware/auth";
import { scheduleManualQuotaRefresh } from "./provider-quotas";

/** Legacy shape backed solely by the generic Custom API quota service. */
export const kimiRoutes = new Hono();

kimiRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

/** Preserve the historic non-admin hasError projection, even for fixed error codes. */
export function redactUsagesForRole(
	usages: Record<string, KimiUsageCache>,
	isAdmin: boolean,
): Record<string, KimiUsageCache | (Omit<KimiUsageCache, "error"> & { hasError: boolean })> {
	if (isAdmin) return usages;
	const out: Record<string, Omit<KimiUsageCache, "error"> & { hasError: boolean }> = {};
	for (const [providerId, cache] of Object.entries(usages)) {
		const { error, ...rest } = cache;
		out[providerId] = { ...rest, hasError: error !== null };
	}
	return out;
}

// First-party session authentication is applied by app.ts before mounting.
kimiRoutes.get("/usages", (c) => {
	void refreshStaleKimiUsages().catch(() => {});
	return c.json(redactUsagesForRole(getAllKimiCachedUsages(), c.get("user")?.role === "admin"));
});

kimiRoutes.post("/usages/refresh", requireAdmin, async (c) => {
	await scheduleManualQuotaRefresh(c, Object.keys(getAllKimiCachedUsages()));
	return c.json(getAllKimiCachedUsages());
});
