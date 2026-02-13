import type { Context, Next } from "hono";
import { type JwtPayload, verifyToken } from "../lib/auth";
import { AppError } from "../lib/errors";

// Extend Hono's context variables for type-safe user access
declare module "hono" {
	interface ContextVariableMap {
		user: JwtPayload;
	}
}

export async function requireAuth(c: Context, next: Next) {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		throw new AppError("Authentication required", 401, "UNAUTHORIZED");
	}

	const token = header.slice(7);
	try {
		const payload = await verifyToken(token);
		c.set("user", payload);
	} catch {
		throw new AppError("Invalid or expired token", 401, "UNAUTHORIZED");
	}

	await next();
}

export async function requireAdmin(c: Context, next: Next) {
	const user = c.get("user");
	if (user.role !== "admin") {
		throw new AppError("Admin access required", 403, "FORBIDDEN");
	}
	await next();
}
