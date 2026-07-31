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

/**
 * Map a kernel event onto the external wire frame.
 *
 * Domain events collapse into `narrator_changed` (the client re-reads over REST), but the kernel's
 * own control events carry loss-of-continuity semantics that must survive: an overflowed
 * subscription is dropped from every subsequent dispatch, so a client that only ever sees
 * `narrator_changed` has no way to learn that it has to resync and resubscribe.
 */
export function externalFrameForEvent(
	event: { topic: string; data?: Record<string, unknown> },
	narratorId: string,
): ExternalNarratorServerMessage {
	if (
		event.topic === "narrafork.events.resync_required" ||
		event.topic === "narrafork.events.overflow"
	) {
		const reason = event.data?.reason;
		return {
			type: "resync_required",
			narratorId,
			reason: typeof reason === "string" && reason.length > 0 ? reason : event.topic,
		};
	}
	return { type: "narrator_changed", narratorId };
}

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
				onEvent: (event) => {
					// Kernel control events must not be flattened into `narrator_changed`. An
					// overflowed subscription is silently dropped from then on, so collapsing the
					// resync signal into a normal change notification left clients believing they
					// were still live while receiving nothing ever again.
					const frame = externalFrameForEvent(event, narratorId);
					if (!sendExternalNarratorFrame(ws, frame)) {
						throw new Error("OAUTH_WS_DELIVERY_FAILED");
					}
				},
				onRemoved: (reason, status) => {
					if (ws.data.integrationSubscriptions.get(narratorId) === subscriptionId) {
						ws.data.integrationSubscriptions.delete(narratorId);
					}
					// Tell the client its subscription is gone. Without this, a delivery-failure
					// revoke leaves a connected socket that never updates again.
					sendExternalNarratorFrame(ws, {
						type: "subscription_lost",
						narratorId,
						reason: status === "revoked" ? `revoked:${reason}` : reason,
					});
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
	// Tool progress rides on a SEPARATE, best-effort subscription. It must not join the primary
	// topic list: `register` denies the whole subscription if any single topic is unauthorized, and
	// grants issued before this topic existed have no constraint entry for it — folding it in would
	// have knocked every pre-existing client offline. A grant that cannot subscribe here simply
	// keeps working without tool frames.
	for (const item of created) {
		await registerOptionalToolSubscription(ws, ctx, item.narratorId, limits);
	}
	sendExternalNarratorFrame(ws, {
		type: "subscribed",
		narratorIds: msg.narratorIds,
		requestId: msg.requestId,
	});
}

/**
 * Register the optional tool-progress subscription.
 *
 * Failures are swallowed on purpose: this is additive capability, and the alternative (letting a
 * missing `narrafork.narrator.tool.changed` constraint fail the whole subscribe) would revoke
 * every grant that predates the topic.
 */
async function registerOptionalToolSubscription(
	ws: ExternalNarratorWS,
	ctx: ExternalOAuthContext,
	narratorId: string,
	limits: ReturnType<typeof getExternalWebSocketRolloutSettings>,
): Promise<void> {
	if (ws.data.toolSubscriptions.has(narratorId)) return;
	try {
		let subscriptionId = "";
		subscriptionId = await integrationEventDispatcher.register({
			identity: {
				authorityId: ctx.grantId,
				authorityRevision: ctx.authorityRevision,
				runtime: {
					type: "server",
					id: `oauth-ws-tool:${ws.data.authSnapshot.oauth.tokenId}`,
					generation: 0,
				},
				subject: { type: "oauth_client", id: ctx.oauthClientId },
				connectionId: ws.data.connectionId,
				credentialId: ws.data.authSnapshot.oauth.tokenId,
				sessionId: ws.data.authSnapshot.oauth.refreshFamilyId ?? undefined,
			},
			topics: ["narrafork.narrator.tool.changed"],
			scope: { type: "integration", id: ctx.grantId },
			boundScopes: [{ type: "integration", id: ctx.grantId }],
			permittedCapabilities: ctx.scopes,
			matchesEvent: (event) =>
				event.resource?.id === narratorId || event.data.narratorId === narratorId,
			onEvent: (event) => {
				const frame = externalToolFrameForEvent(event, narratorId);
				// Losing a tool frame must never revoke the subscription that carries it; a dropped
				// progress update is cosmetic, whereas a revoke is silent and permanent.
				if (frame) sendExternalNarratorFrame(ws, frame);
			},
			onRemoved: () => {
				if (ws.data.toolSubscriptions.get(narratorId) === subscriptionId) {
					ws.data.toolSubscriptions.delete(narratorId);
				}
			},
			queue: {
				maxEvents: Math.min(100, limits.maxSubscriptionsPerConnection * 4),
				maxBytes: Math.min(256 * 1024, limits.maxBufferedAmount),
				maxRatePerSecond: 100,
			},
		});
		if (!isExternalNarratorConnectionRegistered(ws)) {
			integrationEventDispatcher.remove(subscriptionId, "oauth-connection-closed");
			return;
		}
		ws.data.toolSubscriptions.set(narratorId, subscriptionId);
	} catch (error) {
		logger.debug("External narrator tool subscription unavailable", {
			narratorId,
			grantId: ctx.grantId,
			error: String(error),
		});
	}
}

/**
 * Map a tool event onto the wire frame; returns undefined for anything that is not a tool update
 * (kernel control events on this subscription are handled by the primary one).
 */
export function externalToolFrameForEvent(
	event: { topic: string; data?: Record<string, unknown> },
	narratorId: string,
): ExternalNarratorServerMessage | undefined {
	if (event.topic !== "narrafork.narrator.tool.changed") return undefined;
	const data = event.data ?? {};
	const toolName = typeof data.toolName === "string" ? data.toolName : "";
	if (!toolName) return undefined;
	return {
		type: "tool_changed",
		narratorId,
		toolName,
		status: typeof data.status === "string" ? data.status : "",
		...(typeof data.toolUseId === "string" ? { toolUseId: data.toolUseId } : {}),
		...(typeof data.durationMs === "number" ? { durationMs: data.durationMs } : {}),
		...(typeof data.executionDeviceId === "string"
			? { executionDeviceId: data.executionDeviceId }
			: {}),
		...(typeof data.errorMessage === "string" ? { errorMessage: data.errorMessage } : {}),
	};
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
				// `retryAfterSeconds` keeps its coarse, backwards-compatible value; the real budget
				// is 50-500ms, so rounding up to a whole second made clients wait ~20x too long.
				// New clients should prefer `retryAfterMs`.
				retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1_000)),
				retryAfterMs,
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
					// The optional tool subscription shares the narrator's lifecycle.
					const toolSubscriptionId = ws.data.toolSubscriptions.get(narratorId);
					if (toolSubscriptionId) {
						integrationEventDispatcher.remove(toolSubscriptionId, "oauth-unsubscribe");
						ws.data.toolSubscriptions.delete(narratorId);
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
				await sendExternalNarratorMessage(ctx, msg.narratorId, {
					message: msg.message,
					...(msg.locale ? { locale: msg.locale } : {}),
				});
				if (!isExternalNarratorConnectionRegistered(ws)) return;
				sendExternalNarratorFrame(ws, {
					type: "message_accepted",
					narratorId: msg.narratorId,
					requestId: msg.requestId,
				});
				return;
			}
			case "interrupt": {
				const { interrupted } = await interruptExternalNarrator(ctx, msg.narratorId);
				if (!isExternalNarratorConnectionRegistered(ws)) return;
				// Report whether a running turn was actually aborted, so a client cannot show
				// "stopped" for a stop that had no effect.
				sendExternalNarratorFrame(ws, {
					type: "interrupted",
					narratorId: msg.narratorId,
					interrupted,
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
