import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { systemLifecycle } from "../services/system-lifecycle-service";

export const systemLifecycleRoutes = new Hono();
systemLifecycleRoutes.use("*", requireAuth);
// All signed-in users need to distinguish maintenance pauses from stuck narrators.
// Do not expose coordinator blockers, narrator identities, or diagnostics here.
systemLifecycleRoutes.get("/notice", (c) => {
	const { phase, shutdownRequested } = systemLifecycle.status();
	c.header("Cache-Control", "no-store");
	return c.json({ phase, shutdownRequested });
});
systemLifecycleRoutes.get("/status", requireAdmin, (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(systemLifecycle.status());
});
systemLifecycleRoutes.post("/prepare", requireAdmin, (c) => {
	const result = systemLifecycle.prepare();
	return c.json(result, result.success ? 202 : 409);
});
systemLifecycleRoutes.post("/shutdown", requireAdmin, (c) => {
	const result = systemLifecycle.shutdown();
	return c.json(result, result.success ? 202 : 409);
});
systemLifecycleRoutes.post("/cancel", requireAdmin, (c) => {
	const result = systemLifecycle.cancel();
	return c.json(result, result.success ? 202 : 409);
});
