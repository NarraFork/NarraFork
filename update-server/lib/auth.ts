/**
 * Authentication middleware for the update server.
 * Bearer token auth for management endpoints.
 */
import type { Context, Next } from "hono";
import type { TokenRole } from "../types";
import { findTokenByPlain } from "./config";

/**
 * Middleware that requires a valid API token.
 * Optionally restricts to specific roles.
 */
export function requireAuth(requiredRole?: TokenRole) {
	return async (c: Context, next: Next) => {
		const authHeader = c.req.header("Authorization");
		if (!authHeader?.startsWith("Bearer ")) {
			return c.json({ error: "Missing or invalid Authorization header" }, 401);
		}

		const token = authHeader.slice(7);
		const record = await findTokenByPlain(token);

		if (!record) {
			return c.json({ error: "Invalid token" }, 401);
		}

		if (requiredRole && record.role !== requiredRole && record.role !== "admin") {
			return c.json({ error: "Insufficient permissions" }, 403);
		}

		// Attach token info to context
		c.set("tokenRecord", record);
		await next();
	};
}
