import { Hono } from "hono";
import {
	getAllOpencodeCachedUsages,
	type OpencodeUsageCache,
	refreshStaleOpencodeUsages,
} from "../lib/opencode-usage-cache";
import { requireAdmin } from "../middleware/auth";
import { scheduleManualQuotaRefresh } from "./provider-quotas";

/** Legacy shape backed solely by the generic Custom API quota service. */
export const opencodeRoutes = new Hono();

opencodeRoutes.use("*", async (c, next) => {
	c.header("Cache-Control", "no-store");
	await next();
});

function redactUsagesForRole(
	usages: Record<string, OpencodeUsageCache>,
	isAdmin: boolean,
): Record<
	string,
	OpencodeUsageCache | (Omit<OpencodeUsageCache, "error"> & { hasError: boolean })
> {
	if (isAdmin) return usages;
	return Object.fromEntries(
		Object.entries(usages).map(([id, { error, ...cache }]) => [
			id,
			{ ...cache, hasError: error !== null },
		]),
	);
}

// First-party session authentication is applied by app.ts before mounting.
opencodeRoutes.get("/usages", (c) => {
	void refreshStaleOpencodeUsages().catch(() => {});
	return c.json(redactUsagesForRole(getAllOpencodeCachedUsages(), c.get("user")?.role === "admin"));
});

opencodeRoutes.post("/usages/refresh", requireAdmin, async (c) => {
	await scheduleManualQuotaRefresh(c, Object.keys(getAllOpencodeCachedUsages()));
	return c.json(getAllOpencodeCachedUsages());
});
