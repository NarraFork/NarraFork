/**
 * Gateway management API routes.
 *
 * Provides endpoints for:
 *   - Checking gateway status
 *   - Listing active sessions
 *   - Receiving inbound webhook messages
 */

import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { db } from "../db";
import { gatewaySessionMappings, narrators } from "../db/schema";
import { loadGatewayConfig } from "../gateway/config";
import { gateway } from "../gateway/gateway";
import { WebhookAdapter } from "../gateway/platforms/webhook";
import type { WebhookConfig } from "../gateway/types";
import { generateId } from "../lib/id";
import { FOLLOW_DEFAULT_MODEL } from "../lib/settings";
import { sendMessage } from "../services/narrator-session";

export const gatewayRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /status — Gateway status overview
// ---------------------------------------------------------------------------

gatewayRoutes.get("/status", (c) => {
	return c.json(gateway.getStatus());
});

// ---------------------------------------------------------------------------
// GET /sessions — List active IM session mappings
// ---------------------------------------------------------------------------

gatewayRoutes.get("/sessions", async (c) => {
	const sessions = await db.select().from(gatewaySessionMappings).all();
	return c.json(sessions);
});

// ---------------------------------------------------------------------------
// DELETE /sessions/:id — Remove a session mapping
// ---------------------------------------------------------------------------

gatewayRoutes.delete("/sessions/:id", async (c) => {
	const id = c.req.param("id");
	await db.delete(gatewaySessionMappings).where(eq(gatewaySessionMappings.id, id));
	return c.json({ ok: true });
});

// ---------------------------------------------------------------------------
// POST /webhook — Inbound webhook (public, HMAC-verified)
// Exported separately so app.ts can register it before the auth middleware.
// ---------------------------------------------------------------------------

export async function handleWebhookRequest(c: Context): Promise<Response> {
	const config = loadGatewayConfig();
	const whConfig = config.platforms.find((p) => p.platform === "webhook") as
		| WebhookConfig
		| undefined;

	if (!whConfig?.enabled) {
		return c.json({ error: "Webhook adapter not configured" }, 404);
	}

	const rawBody = await c.req.text();

	// Verify HMAC signature
	const signature =
		c.req.header("x-hub-signature-256") ?? c.req.header("x-webhook-signature") ?? null;

	const adapter = new WebhookAdapter(whConfig);
	if (!adapter.verifySignature(rawBody, signature)) {
		return c.json({ error: "Invalid signature" }, 401);
	}

	let body: Record<string, unknown>;
	try {
		body = JSON.parse(rawBody);
	} catch {
		return c.json({ error: "Invalid JSON" }, 400);
	}

	const msg = adapter.parsePayload(body);
	if (!msg) {
		return c.json({ error: "Missing required field: text" }, 400);
	}

	// Find or create session mapping, then forward to narrator
	const now = new Date().toISOString();

	const mapping = await db.query.gatewaySessionMappings.findFirst({
		where: and(
			eq(gatewaySessionMappings.platform, msg.platform),
			eq(gatewaySessionMappings.chatId, msg.chatId),
			eq(gatewaySessionMappings.userId, msg.userId),
		),
	});

	let narratorId: string;

	if (mapping) {
		narratorId = mapping.narratorId;
	} else {
		narratorId = generateId();
		const mappingId = generateId();

		await db.insert(narrators).values({
			id: narratorId,
			type: "primary",
			title: `Webhook: ${msg.username}`,
			status: "idle",
			model: FOLLOW_DEFAULT_MODEL,
			permissionMode: (config.defaultPermissionMode as any) ?? "bypassPermissions",
			messageCount: 0,
			totalCostUsd: 0,
			pruneEnabled: true,
			fastMode: false,
			relaxedPlan: false,
			planMode: false,
			isBackground: false,
			isAskInPassing: false,
			messageVersion: 0,
			createdAt: now,
			updatedAt: now,
		});

		await db.insert(gatewaySessionMappings).values({
			id: mappingId,
			platform: msg.platform,
			chatId: msg.chatId,
			userId: msg.userId,
			username: msg.username,
			narratorId,
			lastMessageAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}

	await sendMessage(narratorId, msg.text);

	return c.json({ ok: true, chatId: msg.chatId });
}
