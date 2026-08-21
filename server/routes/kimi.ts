import { Hono } from "hono";
import {
	getAllKimiCachedUsages,
	refreshAllKimiUsages,
	refreshStaleKimiUsages,
} from "../lib/kimi-usage-cache";
import { requireAdmin, requireAuth } from "../middleware/auth";

/**
 * Kimi (kimi.com / kimi.ai) usage quota endpoints.
 *
 * GET returns the per-provider cache immediately and kicks off a background
 * refresh for entries older than STALE_MS (stale-while-revalidate), so the
 * status bar never blocks on the upstream API. POST forces a refresh.
 *
 * `codexRoutes`). Two reasons this is not merely a convention here: the payload
 * is billing/quota data about the deployment's own provider account, and both
 * handlers reach OUT to kimi.com — leaving them open to every logged-in user
 * turns an authenticated endpoint into an unmetered outbound request amplifier
 * against a third party.
 */

const STALE_MS = 60_000;

export const kimiRoutes = new Hono();

kimiRoutes.use("*", requireAuth, requireAdmin);

kimiRoutes.get("/usages", (c) => {
	void refreshStaleKimiUsages(STALE_MS).catch(() => {});
	return c.json(getAllKimiCachedUsages());
});

kimiRoutes.post("/usages/refresh", (c) => {
	// Deliberately NOT awaited: the upstream call carries a 15s timeout, and
	// awaiting it here holds the HTTP request open for that long on a slow or
	// unreachable upstream. The caller re-reads the cache (the client invalidates
	// its query on success), so the refresh only has to be *started* here.
	void refreshAllKimiUsages().catch(() => {});
	return c.json(getAllKimiCachedUsages());
});
