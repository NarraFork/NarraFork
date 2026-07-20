import { Buffer } from "node:buffer";
import { AppError } from "../lib/errors";
import { eventBus } from "../lib/event-bus";
import { hotOnce } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { type ValidatedAccessToken, validateAccessTokenById } from "../lib/oauth-provider";
import {
	countOAuthSecurityEvent,
	recordOAuthRateLimitTransition,
} from "../lib/oauth-security-observability";
import { externalNarratorWsMessageSchema } from "../lib/validators/external-websocket";
import {
	interruptExternalNarrator,
	sendExternalNarratorMessage,
} from "../services/external-resource-service";
import { integrationAuthorizationService } from "../services/integration-authorization-service";
import { integrationEventDispatcher } from "../services/integration-event-dispatcher";
import "../services/plugin-event-gateway";
import {
	type ExternalOAuthContext,
	requireExternalOAuthContext,
	requireOwnedExternalNarrator,
} from "../services/oauth-resource-access";
import { getExternalWebSocketRolloutSettings } from "../services/oauth-ws-ticket-service";
import {
	type ExternalNarratorClientMessage,
	type ExternalNarratorServerMessage,
	principalFromExternalWsAuth,
} from "./external-narrator-ws-types";
import {
	closeExternalNarratorConnectionForAuthLoss,
	closeExternalNarratorConnectionsByClient,
	closeExternalNarratorConnectionsByFamily,
	closeExternalNarratorConnectionsByGrant,
	closeExternalNarratorConnectionsByToken,
	type ExternalNarratorWS,
	isExternalNarratorConnectionRegistered,
	registerExternalNarratorConnection,
	sendExternalNarratorFrame,
	unregisterExternalNarratorConnection,
} from "./oauth-connection-registry";

function isSameTokenIdentity(
	auth: ExternalNarratorWS["data"]["authSnapshot"],
	live: ValidatedAccessToken,
): boolean {
	return (
		auth.user.sub === live.userId &&
		auth.oauth.tokenId === live.tokenId &&
		auth.oauth.clientId === live.clientId &&
		auth.oauth.oauthClientId === live.oauthClientId &&
		auth.oauth.grantId === live.grantId &&
		auth.oauth.refreshFamilyId === live.refreshFamilyId
	);
}

async function requireLiveContext(ws: ExternalNarratorWS): Promise<ExternalOAuthContext | null> {
	const rollout = getExternalWebSocketRolloutSettings();
	if (!rollout.enabled || !rollout.readEnabled) {
		closeExternalNarratorConnectionForAuthLoss(
			ws,
			"OAUTH_EXTERNAL_WS_DISABLED",
			"External narrator WebSocket access is disabled",
		);
		return null;
	}
	const live = await validateAccessTokenById(ws.data.authSnapshot.oauth.tokenId).catch(() => null);
	if (!live || !isSameTokenIdentity(ws.data.authSnapshot, live)) {
		closeExternalNarratorConnectionForAuthLoss(ws);
		return null;
	}
	try {
		const ctx = await requireExternalOAuthContext(
			principalFromExternalWsAuth({
				...live,
				scopes: [...live.scopes],
			}),
		);
		if (!ctx.scopes.includes("narrator.read") || !ctx.scopes.includes("event.subscribe")) {
			closeExternalNarratorConnectionForAuthLoss(
				ws,
				"INSUFFICIENT_SCOPE",
				"OAuth narrator subscription scopes are no longer valid",
			);
			return null;
		}
		return ctx;
	} catch (error) {
		closeExternalNarratorConnectionForAuthLoss(
			ws,
			error instanceof AppError ? error.code : "AUTH_LOST",
			"OAuth authorization is no longer valid",
		);
		return null;
	}
}

function sendError(ws: ExternalNarratorWS, error: unknown, requestId?: string): void {
	const frame: ExternalNarratorServerMessage =
		error instanceof AppError
			? { type: "error", code: error.code, message: error.message, requestId }
			: { type: "error", code: "INTERNAL_ERROR", message: "Internal error", requestId };
	sendExternalNarratorFrame(ws, frame);
}

function consumeConnectionBudget(ws: ExternalNarratorWS, write: boolean): number {
	const now = Date.now();
	const elapsedSeconds = Math.max(0, now - ws.data.rateUpdatedAt) / 1_000;
	ws.data.controlTokens = Math.min(40, ws.data.controlTokens + elapsedSeconds * 20);
	ws.data.writeTokens = Math.min(10, ws.data.writeTokens + elapsedSeconds * 2);
	ws.data.rateUpdatedAt = now;
	const key = write ? "writeTokens" : "controlTokens";
	const limitedKey = write ? "writeLimited" : "controlLimited";
	if (ws.data[key] >= 1) {
		ws.data[key] -= 1;
		ws.data[limitedKey] = false;
		return 0;
	}
	const enteredLimitedState = !ws.data[limitedKey];
	ws.data[limitedKey] = true;
	countOAuthSecurityEvent("rate_limited");
	if (enteredLimitedState) {
		void recordOAuthRateLimitTransition({
			endpoint: write ? "external-ws-write" : "external-ws-control",
			bucketType: "principal",
			clientId: ws.data.authSnapshot.oauth.clientId,
			grantId: ws.data.authSnapshot.oauth.grantId,
			userId: ws.data.authSnapshot.user.sub,
			retryAfterSeconds: write ? 0.5 : 0.05,
		});
	}
	return write ? 500 : 50;
}

async function authorizeOwnedNarrators(
	ctx: ExternalOAuthContext,
	narratorIds: readonly string[],
): Promise<void> {
	for (const narratorId of narratorIds) await requireOwnedExternalNarrator(ctx, narratorId);
}

async function handleSubscribe(
	ws: ExternalNarratorWS,
	msg: Extract<ExternalNarratorClientMessage, { type: "subscribe" }>,
	ctx: ExternalOAuthContext,
): Promise<void> {
	const limits = getExternalWebSocketRolloutSettings();
	if (msg.narratorIds.length > limits.maxSubscriptionsPerFrame) {
		throw new AppError(
			`A subscribe frame may contain at most ${limits.maxSubscriptionsPerFrame} narrators`,
			400,
			"SUBSCRIPTION_FRAME_LIMIT_EXCEEDED",
		);
	}
	const additions = msg.narratorIds.filter(
		(narratorId) => !ws.data.integrationSubscriptions.has(narratorId),
	);
	if (
		ws.data.integrationSubscriptions.size + additions.length >
		limits.maxSubscriptionsPerConnection
	) {
		throw new AppError(
			`A connection may subscribe to at most ${limits.maxSubscriptionsPerConnection} narrators`,
			400,
			"SUBSCRIPTION_LIMIT_EXCEEDED",
		);
	}

	await authorizeOwnedNarrators(ctx, msg.narratorIds);
	if (!isExternalNarratorConnectionRegistered(ws)) return;

	const created: Array<{ narratorId: string; subscriptionId: string }> = [];
	try {
		for (const narratorId of additions) {
			let subscriptionId = "";
			subscriptionId = await integrationEventDispatcher.register({
				identity: {
					authorityId: ctx.grantId,
					authorityRevision: ctx.authorityRevision,
					runtime: {
						type: "server",
						id: `oauth-ws:${ws.data.authSnapshot.oauth.tokenId}`,
						generation: 0,
					},
					subject: { type: "oauth_client", id: ctx.oauthClientId },
					connectionId: ws.data.connectionId,
					credentialId: ws.data.authSnapshot.oauth.tokenId,
					sessionId: ws.data.authSnapshot.oauth.refreshFamilyId ?? undefined,
				},
				topics: ["narrafork.narrator.lifecycle", "narrafork.narrator.message.changed"],
				scope: { type: "integration", id: ctx.grantId },
				boundScopes: [{ type: "integration", id: ctx.grantId }],
				permittedCapabilities: ctx.scopes,
				matchesEvent: (event) =>
					event.resource?.id === narratorId || event.data.narratorId === narratorId,
				onEvent: () => {
					if (!sendExternalNarratorFrame(ws, { type: "narrator_changed", narratorId })) {
						throw new Error("OAUTH_WS_DELIVERY_FAILED");
					}
				},
				onRemoved: () => {
					if (ws.data.integrationSubscriptions.get(narratorId) === subscriptionId) {
						ws.data.integrationSubscriptions.delete(narratorId);
					}
				},
				queue: {
					maxEvents: Math.min(100, limits.maxSubscriptionsPerConnection * 4),
					maxBytes: Math.min(256 * 1024, limits.maxBufferedAmount),
					maxRatePerSecond: 100,
				},
			});
			created.push({ narratorId, subscriptionId });
		}
	} catch (error) {
		for (const item of created) {
			integrationEventDispatcher.remove(item.subscriptionId, "oauth-subscribe-rollback");
		}
		throw error;
	}
	if (!isExternalNarratorConnectionRegistered(ws)) {
		for (const item of created) {
			integrationEventDispatcher.remove(item.subscriptionId, "oauth-connection-closed");
		}
		return;
	}
	for (const item of created) {
		ws.data.integrationSubscriptions.set(item.narratorId, item.subscriptionId);
	}
	sendExternalNarratorFrame(ws, {
		type: "subscribed",
		narratorIds: msg.narratorIds,
		requestId: msg.requestId,
	});
}

async function handleSyncCheck(
	ws: ExternalNarratorWS,
	msg: Extract<ExternalNarratorClientMessage, { type: "sync_check" }>,
	ctx: ExternalOAuthContext,
): Promise<void> {
	if (!ws.data.integrationSubscriptions.has(msg.narratorId)) {
		throw new AppError("Narrator is not subscribed", 400, "NOT_SUBSCRIBED");
	}
	await requireOwnedExternalNarrator(ctx, msg.narratorId);
	if (!isExternalNarratorConnectionRegistered(ws)) return;
	sendExternalNarratorFrame(ws, {
		type: "narrator_changed",
		narratorId: msg.narratorId,
		requestId: msg.requestId,
	});
}

async function handleMessage(ws: ExternalNarratorWS, parsed: unknown): Promise<void> {
	const result = externalNarratorWsMessageSchema.safeParse(parsed);
	if (!result.success) {
		sendExternalNarratorFrame(ws, {
			type: "error",
			code: "INVALID_FRAME",
			message: "Invalid external narrator WebSocket frame",
		});
		return;
	}
	const msg = result.data;
	ws.data.lastPongAt = Date.now();
	const retryAfterMs = consumeConnectionBudget(
		ws,
		msg.type === "send_message" || msg.type === "interrupt",
	);
	if (retryAfterMs > 0) {
		if (msg.type !== "pong") {
			sendExternalNarratorFrame(ws, {
				type: "rate_limited",
				retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
				requestId: "requestId" in msg ? msg.requestId : undefined,
			});
		}
		return;
	}

	try {
		const ctx = await requireLiveContext(ws);
		if (!ctx) return;
		switch (msg.type) {
			case "pong":
				return;
			case "subscribe":
				await handleSubscribe(ws, msg, ctx);
				return;
			case "unsubscribe": {
				const limits = getExternalWebSocketRolloutSettings();
				if (msg.narratorIds.length > limits.maxSubscriptionsPerFrame) {
					throw new AppError(
						`An unsubscribe frame may contain at most ${limits.maxSubscriptionsPerFrame} narrators`,
						400,
						"SUBSCRIPTION_FRAME_LIMIT_EXCEEDED",
					);
				}
				await authorizeOwnedNarrators(ctx, msg.narratorIds);
				if (!isExternalNarratorConnectionRegistered(ws)) return;
				for (const narratorId of msg.narratorIds) {
					const subscriptionId = ws.data.integrationSubscriptions.get(narratorId);
					if (subscriptionId) {
						integrationEventDispatcher.remove(subscriptionId, "oauth-unsubscribe");
						ws.data.integrationSubscriptions.delete(narratorId);
					}
				}
				sendExternalNarratorFrame(ws, {
					type: "unsubscribed",
					narratorIds: msg.narratorIds,
					requestId: msg.requestId,
				});
				return;
			}
			case "sync_check":
				await handleSyncCheck(ws, msg, ctx);
				return;
			case "send_message": {
				if (!getExternalWebSocketRolloutSettings().messageEnabled) {
					throw new AppError(
						"External narrator WebSocket message sending is disabled",
						403,
						"OAUTH_EXTERNAL_WS_MESSAGE_DISABLED",
					);
				}
				await sendExternalNarratorMessage(ctx, msg.narratorId, { message: msg.message });
				if (!isExternalNarratorConnectionRegistered(ws)) return;
				sendExternalNarratorFrame(ws, {
					type: "message_accepted",
					narratorId: msg.narratorId,
					requestId: msg.requestId,
				});
				return;
			}
			case "interrupt": {
				if (!getExternalWebSocketRolloutSettings().interruptEnabled) {
					throw new AppError(
						"External narrator WebSocket interrupt is disabled",
						403,
						"OAUTH_EXTERNAL_WS_INTERRUPT_DISABLED",
					);
				}
				await interruptExternalNarrator(ctx, msg.narratorId);
				if (!isExternalNarratorConnectionRegistered(ws)) return;
				sendExternalNarratorFrame(ws, {
					type: "interrupted",
					narratorId: msg.narratorId,
					requestId: msg.requestId,
				});
				return;
			}
		}
	} catch (error) {
		logger.warn("External narrator WS frame failed", {
			type: msg.type,
			error: String(error),
		});
		sendError(ws, error, "requestId" in msg ? msg.requestId : undefined);
	}
}

export function externalNarratorFrameByteLength(message: string | Buffer): number {
	return typeof message === "string" ? Buffer.byteLength(message) : message.byteLength;
}

export function rejectOversizedExternalNarratorFrame(
	ws: ExternalNarratorWS,
	message: string | Buffer,
): boolean {
	if (
		externalNarratorFrameByteLength(message) <= getExternalWebSocketRolloutSettings().maxFrameBytes
	) {
		return false;
	}
	try {
		ws.send(
			JSON.stringify({
				type: "error",
				code: "FRAME_TOO_LARGE",
				message: "WebSocket frame is too large",
			} satisfies ExternalNarratorServerMessage),
		);
	} catch {
		// close below
	}
	unregisterExternalNarratorConnection(ws);
	try {
		ws.close(1009, "frame too large");
	} catch {
		try {
			ws.terminate();
		} catch {
			// already dead
		}
	}
	return true;
}

if (hotOnce("narrafork.externalNarratorWs.listenersRegistered")) {
	eventBus.on("oauth:token_invalidated", (event) => {
		integrationAuthorizationService.invalidateRuntime({
			type: "server",
			id: `oauth-ws:${event.tokenId}`,
		});
		integrationEventDispatcher.invalidateCredential(event.tokenId, event.reasonCode);
		closeExternalNarratorConnectionsByToken(event.tokenId);
		if (event.refreshFamilyId) {
			integrationEventDispatcher.invalidateSession(event.refreshFamilyId, event.reasonCode);
			closeExternalNarratorConnectionsByFamily(event.refreshFamilyId);
		}
	});
	eventBus.on("oauth:grant_changed", (event) => {
		integrationAuthorizationService.invalidateAuthority(event.grantId);
		integrationEventDispatcher.revokeAuthority(event.grantId, event.reasonCode);
		closeExternalNarratorConnectionsByGrant(event.grantId);
	});
	eventBus.on("oauth:client_changed", (event) => {
		integrationEventDispatcher.invalidateSubject(
			{ type: "oauth_client", id: event.oauthClientId },
			event.reasonCode,
		);
		closeExternalNarratorConnectionsByClient(event.oauthClientId);
	});
}

export const handleExternalNarratorWS = {
	open(ws: ExternalNarratorWS): void {
		ws.data.lastPongAt = Date.now();
		if (!registerExternalNarratorConnection(ws)) {
			try {
				ws.send(
					JSON.stringify({
						type: "error",
						code: "CONNECTION_LIMIT_EXCEEDED",
						message: "External narrator WebSocket connection limit reached",
					} satisfies ExternalNarratorServerMessage),
				);
				ws.close(1013, "connection limit reached");
			} catch {
				try {
					ws.terminate();
				} catch {
					// already dead
				}
			}
			return;
		}
		sendExternalNarratorFrame(ws, {
			type: "ready",
			version: 1,
			maxSubscriptions: getExternalWebSocketRolloutSettings().maxSubscriptionsPerConnection,
		});
	},
	message: handleMessage,
	close(ws: ExternalNarratorWS): void {
		unregisterExternalNarratorConnection(ws);
	},
};
