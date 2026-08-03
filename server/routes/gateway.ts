/**
 * Gateway management API routes.
 *
 * Provides endpoints for:
 *   - Checking gateway status
 *   - Listing active sessions
 *   - Receiving inbound webhook messages
 */

import { formatOriginLabel } from "@shared/message-origin";
import { and, eq } from "drizzle-orm";
import type { Context } from "hono";
import { Hono } from "hono";
import { db } from "../db";
import { gatewaySessionMappings, narrators } from "../db/schema";
import { loadGatewayConfig } from "../gateway/config";
import { gateway, resolveGatewayAppUserId } from "../gateway/gateway";
import { WebhookAdapter } from "../gateway/platforms/webhook";
import type { WebhookConfig } from "../gateway/types";
import { GATEWAY_PLATFORMS } from "../gateway/types";
import { generateId } from "../lib/id";
import { resolveInitialRelaxedPlan } from "../lib/permission-modes";
import { FOLLOW_DEFAULT_MODEL, settings } from "../lib/settings";
import { sendMessage } from "../services/narrator-session";

export const gatewayRoutes = new Hono();

// ---------------------------------------------------------------------------
// GET /status — Gateway status overview
// ---------------------------------------------------------------------------

gatewayRoutes.get("/status", (c) => {
	return c.json(gateway.getStatus());
});

// ---------------------------------------------------------------------------
// POST /reload — Reload gateway (optionally specific platforms)
// ---------------------------------------------------------------------------

gatewayRoutes.post("/reload", async (c) => {
	const body = await c.req.json().catch(() => ({}));
	const validSet = new Set<string>(GATEWAY_PLATFORMS);
	const platforms = Array.isArray(body.platforms)
		? body.platforms.filter((p: unknown) => typeof p === "string" && validSet.has(p))
		: undefined;
	const result = await gateway.reload(platforms);
	return c.json({ ok: true, ...result, status: gateway.getStatus() });
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
	const config = await loadGatewayConfig();
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

	// Bind the session to a NarraFork user so inbound messages have an owner for
	// attribution (and recentTabs / notifications), matching the IM gateway path.
	//
	// This id also becomes the agent turn's ACL principal for knowledge-base reads
	// (it flows into `sendMessage` below). This route is HMAC-gated, but see
	// resolveGatewayAppUserId for the full scope of that decision.
	const appUserId = mapping ? mapping.appUserId : await resolveGatewayAppUserId();

	if (mapping) {
		narratorId = mapping.narratorId;
	} else {
		narratorId = generateId();
		const mappingId = generateId();
		const gwPermMode = config.defaultPermissionMode ?? "default";

		await db.insert(narrators).values({
			id: narratorId,
			type: "primary",
			title: `Webhook: ${msg.username}`,
			status: "idle",
			model: FOLLOW_DEFAULT_MODEL,
			permissionMode: gwPermMode,
			messageCount: 0,
			totalCostUsd: 0,
			pruneEnabled: settings.agent.defaultPruneEnabled,
			// webhook 无人值守路径同样显式关闭 priority，不跟随用户默认值。
			fastModeOverride: "off",
			fastMode: false,
			// 全部允许时强制宽松，忽略用户默认设置，避免 webhook 无人值守路径被计划模式卡住。
			relaxedPlan: resolveInitialRelaxedPlan({
				permissionMode: gwPermMode,
				defaultRelaxedPlan: settings.agent.defaultRelaxedPlan,
			}),
			planMode: false,
			isBackground: false,
			isAskInPassing: false,
			variant: "primary",
			traits: ["standalone"],
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
			appUserId,
			lastMessageAt: now,
			createdAt: now,
			updatedAt: now,
		});
	}

	// Written by a real human on the remote platform, forwarded through a webhook.
	await sendMessage(
		narratorId,
		msg.text,
		undefined,
		undefined,
		false,
		undefined,
		appUserId ?? undefined,
		undefined,
		null,
		{
			origin: "user",
			originLabel: formatOriginLabel("gateway", `${msg.platform} @${msg.username}`),
		},
	);

	return c.json({ ok: true, chatId: msg.chatId });
}

// ---------------------------------------------------------------------------
// Weixin QR Login — stateful sessions held in memory, keyed by JWT userId
// ---------------------------------------------------------------------------

import type { QrLoginSession } from "../gateway/platforms/weixin-qr-login";

const activeQrSessions = new Map<string, QrLoginSession>();

/**
 * POST /weixin/qr-start — Begin a new QR login flow.
 * Returns the QR URL for the user to scan.
 */
gatewayRoutes.post("/weixin/qr-start", async (c) => {
	const userId = c.get("user").sub;
	try {
		const { startQrLogin } = await import("../gateway/platforms/weixin-qr-login");
		const session = await startQrLogin();
		activeQrSessions.set(userId, session);
		return c.json({
			qrcodeUrl: session.qrcodeUrl,
			qrcodeToken: session.qrcodeToken,
		});
	} catch (err) {
		return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
	}
});

/**
 * GET /weixin/qr-poll — Poll the QR login status.
 * Frontend should call this every 1-2 seconds after qr-start.
 */
gatewayRoutes.get("/weixin/qr-poll", async (c) => {
	const userId = c.get("user").sub;
	const session = activeQrSessions.get(userId);

	if (!session) {
		return c.json({ error: "No active QR session. Call POST /weixin/qr-start first." }, 400);
	}

	// Auto-expire after 8 minutes
	if (Date.now() - session.createdAt > 480_000) {
		activeQrSessions.delete(userId);
		return c.json({ status: "error", message: "QR login timed out" });
	}

	try {
		const { pollQrStatus } = await import("../gateway/platforms/weixin-qr-login");
		const result = await pollQrStatus(session);

		if (result.status === "confirmed") {
			// Return credentials and clear session
			activeQrSessions.delete(userId);
			return c.json(result);
		}

		if (result.status === "expired" && !result.canRefresh) {
			activeQrSessions.delete(userId);
			return c.json({ status: "expired", canRefresh: false });
		}

		// For expired-with-refresh, return the refreshed QR URL
		if (result.status === "expired") {
			const refreshed = activeQrSessions.get(userId);
			if (refreshed) {
				return c.json({
					...result,
					qrcodeUrl: refreshed.qrcodeUrl,
					qrcodeToken: refreshed.qrcodeToken,
				});
			}
		}

		return c.json(result);
	} catch (err) {
		return c.json(
			{ status: "error", message: err instanceof Error ? err.message : String(err) },
			500,
		);
	}
});
