import { eq } from "drizzle-orm";
import type { Context, Next } from "hono";
import { errors } from "jose";
import { db } from "../db";
import { users } from "../db/schema";
import { type JwtPayload, verifyToken } from "../lib/auth";
import { AppError } from "../lib/errors";

// Extend Hono's context variables for type-safe user access
declare module "hono" {
	interface ContextVariableMap {
		user: JwtPayload;
	}
}

/**
 * Lightweight cache: verified user IDs are remembered for a short window
 * so we don't hit SQLite on every single request.
 */
const verifiedUsers = new Map<string, number>();
const VERIFY_TTL_MS = 60_000; // 1 minute

function isUserVerifiedRecently(userId: string): boolean {
	const ts = verifiedUsers.get(userId);
	if (!ts) return false;
	if (Date.now() - ts > VERIFY_TTL_MS) {
		verifiedUsers.delete(userId);
		return false;
	}
	return true;
}

export function invalidateUserCache(userId?: string) {
	if (userId) {
		verifiedUsers.delete(userId);
	} else {
		verifiedUsers.clear();
	}
}

export async function requireAuth(c: Context, next: Next) {
	const header = c.req.header("Authorization");
	if (!header?.startsWith("Bearer ")) {
		throw new AppError("Authentication required", 401, "UNAUTHORIZED");
	}

	const token = header.slice(7);
	let payload: JwtPayload;
	try {
		payload = await verifyToken(token);
	} catch (err) {
		if (err instanceof errors.JWTExpired) {
			throw new AppError("Token expired", 401, "TOKEN_EXPIRED");
		}
		throw new AppError("Invalid or expired token", 401, "UNAUTHORIZED");
	}

	// Ensure the user still exists in the database (handles DB wipe, user deletion, etc.)
	if (!isUserVerifiedRecently(payload.sub)) {
		const row = await db.query.users.findFirst({
			where: eq(users.id, payload.sub),
			columns: { id: true },
		});
		if (!row) {
			throw new AppError("User no longer exists", 401, "UNAUTHORIZED");
		}
		verifiedUsers.set(payload.sub, Date.now());
	}

	c.set("user", payload);
	await next();
}

export function assertAdmin(c: Context): void {
	const user = c.get("user");
	if (user.role !== "admin") {
		throw new AppError("Admin access required", 403, "FORBIDDEN");
	}
}

export async function requireAdmin(c: Context, next: Next) {
	assertAdmin(c);
	await next();
}
