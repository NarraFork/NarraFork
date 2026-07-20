import { afterEach, describe, expect, test } from "bun:test";
import { eventBus } from "../lib/event-bus";
import { settings } from "../lib/settings";
import {
	EXTERNAL_NARRATOR_WS_MAX_BUFFERED_BYTES,
	externalNarratorWsMessageSchema,
} from "../lib/validators/external-websocket";
import type { OAuthAuthPrincipal } from "../middleware/auth";
import "./external-narrator-ws";
import type { ExternalNarratorServerMessage } from "./external-narrator-ws-types";
import {
	closeAllExternalNarratorConnections,
	closeExternalNarratorConnectionsByClient,
	closeExternalNarratorConnectionsByFamily,
	closeExternalNarratorConnectionsByGrant,
	closeExternalNarratorConnectionsByToken,
	type ExternalNarratorWS,
	getExternalNarratorConnections,
	registerExternalNarratorConnection,
	sendExternalNarratorFrame,
	unregisterExternalNarratorConnection,
} from "./oauth-connection-registry";

function principal(suffix: string): OAuthAuthPrincipal {
	return {
		type: "oauth",
		user: { sub: `user-${suffix}`, role: "user", iat: 0, exp: 0 },
		oauth: {
			tokenId: `token-${suffix}`,
			clientId: `public-client-${suffix}`,
			oauthClientId: `client-${suffix}`,
			grantId: `grant-${suffix}`,
			refreshFamilyId: `family-${suffix}`,
			expiresAt: new Date(Date.now() + 60_000).toISOString(),
			scopes: ["narrator.read", "event.subscribe"],
		},
	};
}

interface FakeSocketState {
	sent: ExternalNarratorServerMessage[];
	closed: Array<{ code?: number; reason?: string }>;
	terminated: boolean;
	bufferedAmount: number;
}

function fakeSocket(suffix: string, subscribed = ["narrator-1"]) {
	const state: FakeSocketState = {
		sent: [],
		closed: [],
		terminated: false,
		bufferedAmount: 0,
	};
	const ws = {
		data: {
			channel: "external-narrator" as const,
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			connectionId: `connection-${suffix}`,
			integrationSubscriptions: new Map(
				subscribed.map((narratorId) => [narratorId, `subscription-${narratorId}`]),
			),
			authSnapshot: principal(suffix),
			controlTokens: 40,
			writeTokens: 10,
			rateUpdatedAt: Date.now(),
			controlLimited: false,
			writeLimited: false,
		},
		send(payload: string) {
			state.sent.push(JSON.parse(payload) as ExternalNarratorServerMessage);
			return payload.length;
		},
		close(code?: number, reason?: string) {
			state.closed.push({ code, reason });
		},
		terminate() {
			state.terminated = true;
		},
		getBufferedAmount() {
			return state.bufferedAmount;
		},
	} as unknown as ExternalNarratorWS;
	return { ws, state };
}

afterEach(() => closeAllExternalNarratorConnections());

describe("external narrator WebSocket frame validation", () => {
	test("accepts only the six strict client frame families", () => {
		const validFrames = [
			{ type: "pong" },
			{ type: "subscribe", narratorIds: ["n1"], requestId: "r1" },
			{ type: "unsubscribe", narratorIds: ["n1"] },
			{ type: "sync_check", narratorId: "n1" },
			{ type: "send_message", narratorId: "n1", message: "hello" },
			{ type: "interrupt", narratorId: "n1" },
		];
		for (const frame of validFrames) {
			expect(externalNarratorWsMessageSchema.safeParse(frame).success).toBe(true);
		}
		expect(externalNarratorWsMessageSchema.safeParse({ type: "unknown" }).success).toBe(false);
	});

	test("rejects unknown fields, duplicate subscriptions, and unbounded messages", () => {
		expect(
			externalNarratorWsMessageSchema.safeParse({ type: "pong", token: "must-not-be-here" })
				.success,
		).toBe(false);
		expect(
			externalNarratorWsMessageSchema.safeParse({
				type: "subscribe",
				narratorIds: ["n1", "n1"],
			}).success,
		).toBe(false);
		expect(
			externalNarratorWsMessageSchema.safeParse({
				type: "send_message",
				narratorId: "n1",
				message: "x".repeat(10_001),
			}).success,
		).toBe(false);
	});
});

describe("external narrator OAuth connection registry", () => {
	test("indexes connections independently and closes by every revocation key", () => {
		const token = fakeSocket("token");
		const family = fakeSocket("family");
		const grant = fakeSocket("grant");
		const client = fakeSocket("client");
		for (const item of [token, family, grant, client]) {
			expect(registerExternalNarratorConnection(item.ws)).toBe(true);
		}

		expect(closeExternalNarratorConnectionsByToken("token-token")).toBe(1);
		expect(closeExternalNarratorConnectionsByFamily("family-family")).toBe(1);
		expect(closeExternalNarratorConnectionsByGrant("grant-grant")).toBe(1);
		expect(closeExternalNarratorConnectionsByClient("client-client")).toBe(1);
		expect(getExternalNarratorConnections().size).toBe(0);

		for (const item of [token, family, grant, client]) {
			expect(item.state.sent.at(-1)?.type).toBe("auth_lost");
			expect(item.state.closed.at(-1)?.code).toBe(4003);
			expect(item.ws.data.integrationSubscriptions.size).toBe(0);
		}
	});

	test("uses one idempotent unregister path", () => {
		const { ws } = fakeSocket("unregister", ["n1", "n2"]);
		registerExternalNarratorConnection(ws);
		unregisterExternalNarratorConnection(ws);
		unregisterExternalNarratorConnection(ws);
		expect(getExternalNarratorConnections().has(ws)).toBe(false);
		expect(ws.data.integrationSubscriptions.size).toBe(0);
	});

	test("enforces the configured per-token connection cap", () => {
		const config = settings.oauth?.externalWebSocket;
		if (!config) throw new Error("OAuth external WebSocket settings are unavailable");
		const previous = config.maxConnectionsPerToken;
		config.maxConnectionsPerToken = 1;
		try {
			const first = fakeSocket("same-token");
			const second = fakeSocket("same-token");
			expect(registerExternalNarratorConnection(first.ws)).toBe(true);
			expect(registerExternalNarratorConnection(second.ws)).toBe(false);
			expect(getExternalNarratorConnections().size).toBe(1);
		} finally {
			config.maxConnectionsPerToken = previous;
		}
	});

	test("closes indexed connections immediately through OAuth invalidation events", () => {
		const { ws, state } = fakeSocket("event-token");
		expect(registerExternalNarratorConnection(ws)).toBe(true);
		eventBus.emit({
			type: "oauth:token_invalidated",
			tokenId: "token-event-token",
			refreshFamilyId: null,
			reasonCode: "test_revocation",
		});
		expect(state.sent.at(-1)?.type).toBe("auth_lost");
		expect(state.closed.at(-1)?.code).toBe(4003);
		expect(getExternalNarratorConnections().has(ws)).toBe(false);
	});

	test("hard-closes instead of buffering beyond the fixed budget", () => {
		const { ws, state } = fakeSocket("backpressure");
		registerExternalNarratorConnection(ws);
		state.bufferedAmount = EXTERNAL_NARRATOR_WS_MAX_BUFFERED_BYTES + 1;

		expect(sendExternalNarratorFrame(ws, { type: "ping" })).toBe(false);
		expect(state.terminated).toBe(true);
		expect(state.sent).toEqual([]);
		expect(getExternalNarratorConnections().has(ws)).toBe(false);
	});
});
