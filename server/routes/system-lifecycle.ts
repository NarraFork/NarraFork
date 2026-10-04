import { Hono } from "hono";
import { requireAdmin, requireAuth } from "../middleware/auth";
import { systemLifecycle } from "../services/system-lifecycle-service";

export const systemLifecycleRoutes = new Hono();
systemLifecycleRoutes.use("*", requireAuth, requireAdmin);
systemLifecycleRoutes.get("/status", (c) => {
	c.header("Cache-Control", "no-store");
	return c.json(systemLifecycle.status());
});
systemLifecycleRoutes.post("/prepare", (c) => {
	const result = systemLifecycle.prepare();
	return c.json(result, result.success ? 202 : 409);
});
systemLifecycleRoutes.post("/shutdown", (c) => {
	const result = systemLifecycle.shutdown();
	return c.json(result, result.success ? 202 : 409);
});
systemLifecycleRoutes.post("/cancel", (c) => {
	const result = systemLifecycle.cancel();
	return c.json(result, result.success ? 202 : 409);
});
