/**
 * Health check route.
 */
import { Hono } from "hono";

export const healthRoutes = new Hono();

healthRoutes.get("/", (c) => {
	return c.json({ status: "ok", timestamp: new Date().toISOString() });
});
