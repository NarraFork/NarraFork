/**
 * Token management routes.
 * Requires admin authentication.
 *
 * POST   /api/v2/tokens      — create a new token
 * GET    /api/v2/tokens       — list tokens (without hashes)
 * DELETE /api/v2/tokens/:id   — revoke a token
 */
import { Hono } from "hono";
import { requireAuth } from "../lib/auth";
import { addToken, getConfig, removeToken } from "../lib/config";
import { logger } from "../lib/logger";

export const tokenRoutes = new Hono();

// POST /api/v2/tokens
tokenRoutes.post("/", requireAuth("admin"), async (c) => {
	const body = await c.req.json<{ name?: string; role?: string }>();
	const name = body.name ?? "unnamed";
	const role = body.role === "admin" ? "admin" : "upload";

	const { id, token } = await addToken(name, role);
	logger.info("Token created", { id, name, role });

	return c.json({
		id,
		name,
		role,
		token, // Plain token — shown only once
	});
});

// GET /api/v2/tokens
tokenRoutes.get("/", requireAuth("admin"), (c) => {
	const config = getConfig();
	const tokens = config.tokens.map((t) => ({
		id: t.id,
		name: t.name,
		role: t.role,
		createdAt: t.createdAt,
	}));
	return c.json({ tokens });
});

// DELETE /api/v2/tokens/:id
tokenRoutes.delete("/:id", requireAuth("admin"), (c) => {
	const id = c.req.param("id") ?? "";
	if (!id) {
		return c.json({ error: "Missing token ID" }, 400);
	}
	const removed = removeToken(id);

	if (!removed) {
		return c.json({ error: "Token not found" }, 404);
	}

	logger.info("Token revoked", { id });
	return c.json({ success: true, id });
});
