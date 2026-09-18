import { Hono } from "hono";
import {
	getAllKimiCachedUsages,
	KIMI_USAGES_STALE_MS,
	type KimiUsageCache,
	refreshAllKimiUsages,
	refreshStaleKimiUsages,
} from "../lib/kimi-usage-cache";
import { requireAdmin } from "../middleware/auth";

/**
 * Kimi (kimi.com / kimi.ai) usage quota endpoints.
 *
 * GET returns the per-provider cache immediately and kicks off a background
 * refresh for entries older than STALE_MS (stale-while-revalidate), so the
 * status bar never blocks on the upstream API.
 *
 * GET is open to every logged-in session user, matching the NUG quota route
 * (`/api/nug/quotas`): the status bar shows this data to anyone using a Kimi
 * model. The outbound-amplification concern does not apply to reads — the
 * background refresh is throttled by STALE_MS per provider, so N users polling
 * cannot produce more than one upstream call per provider per minute.
 *
 * The `error` field is ADMIN-ONLY within that response; see
 * {@link redactUsagesForRole}. Quota numbers describe how much of the
 * deployment's allowance is left, which is what the status bar needs. The error
 * string is verbatim upstream text and belongs to whoever administers the
 * account.
 *
 * POST (force refresh) stays admin-only: it bypasses the staleness throttle
 * and reaches out to kimi.com on demand.
 */

const STALE_MS = KIMI_USAGES_STALE_MS;

export const kimiRoutes = new Hono();

/**
 * Strip the upstream error text for non-admins, keeping the quota numbers.
 *
 * `cache.error` is whatever the provider or the fetch layer produced, stored
 * verbatim (`kimi-usage-cache.ts` assigns the caught message). That text can carry
 * a fragment of the API key, the account identifier, or an internal endpoint URL —
 * details about the deployment's own provider account rather than about the
 * requesting user's quota.
 *
 * Replaced with a boolean rather than dropped: the status bar still has to show
 * "quota unavailable" instead of rendering a stale or empty allowance as if it were
 * current, and `hasError` says that much without saying what went wrong. An admin
 * gets the full string, because they are the one who can act on it.
 */
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

kimiRoutes.get("/usages", (c) => {
	void refreshStaleKimiUsages(STALE_MS).catch(() => {});
	const isAdmin = c.get("user")?.role === "admin";
	return c.json(redactUsagesForRole(getAllKimiCachedUsages(), isAdmin));
});

kimiRoutes.post("/usages/refresh", requireAdmin, (c) => {
	// Deliberately NOT awaited: the upstream call carries a 15s timeout, and
	// awaiting it here holds the HTTP request open for that long on a slow or
	// unreachable upstream. The caller re-reads the cache (the client invalidates
	// its query on success), so the refresh only has to be *started* here.
	void refreshAllKimiUsages().catch(() => {});
	// Admin-only route, so the full error text is intended here.
	return c.json(getAllKimiCachedUsages());
});
