import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { OAuthAuthPrincipal } from "../../middleware/auth";
import {
	EXTERNAL_NARRATORS_WS_CHANNEL,
	isExternalWebSocketOriginAllowed,
	OAuthWsTicketService,
	type OAuthWsTicketStoreEntry,
} from "../oauth-ws-ticket-service";

function createPrincipal(
	expiresAt: string,
	scopes = ["narrator.read", "event.subscribe"],
): OAuthAuthPrincipal {
	return {
		type: "oauth",
		user: { sub: "user-1", role: "user", iat: 1, exp: 2 },
		oauth: {
			tokenId: "token-1",
			clientId: "public-client-1",
			oauthClientId: "client-db-1",
			grantId: "grant-1",
			refreshFamilyId: "family-1",
			expiresAt,
			scopes,
		},
	};
}

describe("OAuthWsTicketService", () => {
	test("stores only a SHA-256 digest and returns an isolated auth snapshot once", () => {
		const now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const store = new Map<string, OAuthWsTicketStoreEntry>();
		const service = new OAuthWsTicketService({ now: () => now, store, ttlSeconds: 45 });
		const principal = createPrincipal(new Date(now + 5 * 60_000).toISOString());

		const first = service.issue(principal);
		const second = service.issue(principal);
		expect(first.ticket).not.toBe(second.ticket);
		expect(first.expiresIn).toBe(45);
		expect(store.size).toBe(2);
		const digest = createHash("sha256").update(first.ticket).digest("hex");
		expect(store.has(digest)).toBe(true);
		expect(JSON.stringify([...store.entries()])).not.toContain(first.ticket);

		principal.oauth.scopes.push("mutated-after-issue");
		const consumed = service.consume(first.ticket);
		expect(consumed).toEqual({
			channel: EXTERNAL_NARRATORS_WS_CHANNEL,
			auth: {
				type: "oauth",
				user: { sub: "user-1", role: "user", iat: 1, exp: 2 },
				oauth: {
					tokenId: "token-1",
					clientId: "public-client-1",
					oauthClientId: "client-db-1",
					grantId: "grant-1",
					refreshFamilyId: "family-1",
					expiresAt: new Date(now + 5 * 60_000).toISOString(),
					scopes: ["narrator.read", "event.subscribe"],
				},
			},
		});
		expect(service.consume(first.ticket)).toBeNull();
		expect(store.has(digest)).toBe(false);
	});

	test("burns a recognized ticket on a channel mismatch", () => {
		const now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const service = new OAuthWsTicketService({ now: () => now });
		const issued = service.issue(createPrincipal(new Date(now + 60_000).toISOString()));

		expect(service.consume(issued.ticket, "other-channel" as never)).toBeNull();
		expect(service.consume(issued.ticket)).toBeNull();
	});

	test("fails closed at capacity and only prunes expired tickets", () => {
		let now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const service = new OAuthWsTicketService({ now: () => now, ttlSeconds: 30, maxTickets: 1 });
		const principal = createPrincipal(new Date(now + 5 * 60_000).toISOString());
		service.issue(principal);

		expect(() => service.issue(principal)).toThrow("OAuth WebSocket ticket capacity reached");
		try {
			service.issue(principal);
		} catch (error) {
			expect(error).toMatchObject({ statusCode: 503, code: "OAUTH_WS_TICKET_CAPACITY" });
		}

		now += 30_001;
		expect(service.issue(createPrincipal(new Date(now + 5 * 60_000).toISOString())).expiresIn).toBe(
			30,
		);
	});

	test("bounds TTL to 30-60 seconds and never outlives the access token", () => {
		const now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const short = new OAuthWsTicketService({ now: () => now, ttlSeconds: 1 });
		const long = new OAuthWsTicketService({ now: () => now, ttlSeconds: 600 });
		const principal = createPrincipal(new Date(now + 5 * 60_000).toISOString());

		expect(short.issue(principal).expiresIn).toBe(30);
		expect(long.issue(principal).expiresIn).toBe(60);
		const nearExpiry = new OAuthWsTicketService({ now: () => now, ttlSeconds: 60 });
		expect(nearExpiry.issue(createPrincipal(new Date(now + 35_000).toISOString())).expiresIn).toBe(
			35,
		);
		expect(() => nearExpiry.issue(createPrincipal(new Date(now + 29_999).toISOString()))).toThrow(
			"expires too soon",
		);
	});

	test("rejects malformed ticket inputs without affecting valid tickets", () => {
		const now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const service = new OAuthWsTicketService({ now: () => now });
		const issued = service.issue(createPrincipal(new Date(now + 60_000).toISOString()));

		expect(service.consume("not-a-ticket")).toBeNull();
		expect(service.consume(issued.ticket)?.auth.oauth.tokenId).toBe("token-1");
	});

	test("allows non-browser clients and requires exact browser Origin matches", () => {
		const allowed = ["https://robot.example.com"];
		expect(isExternalWebSocketOriginAllowed(null, allowed)).toBe(true);
		expect(isExternalWebSocketOriginAllowed("https://robot.example.com", allowed)).toBe(true);
		expect(isExternalWebSocketOriginAllowed("https://robot.example.com/", allowed)).toBe(false);
		expect(isExternalWebSocketOriginAllowed("https://evil.example.com", allowed)).toBe(false);
		expect(isExternalWebSocketOriginAllowed("https://robot.example.com", [])).toBe(false);
	});

	test("can invalidate all pending tickets after a rollout configuration change", () => {
		const now = Date.UTC(2026, 6, 18, 12, 0, 0);
		const service = new OAuthWsTicketService({ now: () => now });
		const issued = service.issue(createPrincipal(new Date(now + 60_000).toISOString()));
		service.clear();
		expect(service.consume(issued.ticket)).toBeNull();
	});
});
