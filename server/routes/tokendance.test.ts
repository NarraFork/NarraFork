import { describe, expect, mock, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import type { AuthPrincipal } from "../middleware/auth";

const connection = {
	connected: false,
	disabled: false,
	generation: 0,
	models: [],
	name: "TokenDance",
};
mock.module("../services/tokendance-service", () => ({
	getTokenDanceConnection: () => connection,
	startTokenDanceOAuth: () => ({
		flowId: "x".repeat(43),
		authorizeUrl: "https://tokendance.space/auth",
		expiresAt: Date.now() + 600000,
	}),
	validateTokenDanceCallback: (value: string) => new URL(value),
	completeTokenDanceOAuth: () => ({ connected: true, modelsRefreshed: true }),
	cancelTokenDanceOAuth: () => {},
	restoreTokenDanceDraft: () => ({ status: "pending" }),
	setTokenDanceDisabled: () => connection,
	deleteTokenDanceConnection: () => {},
	refreshTokenDanceModels: () => {
		throw Object.assign(new AppError("TokenDance model refresh failed", 502, "TOKENDANCE_ERROR"), {
			extra: { recoveryAction: "top_up_balance", upstreamBody: "secret" },
		});
	},
}));
// Keep real authorization middleware, but isolate credential/database dependencies.
mock.module("../lib/auth", () => ({
	verifyToken: async () => {
		throw new Error("invalid token");
	},
	renewToken: async () => {
		throw new Error("not used");
	},
	isAuthenticSessionTokenIgnoringExpiry: async () => false,
}));
mock.module("../lib/oauth-provider", () => ({ validateAccessToken: () => null }));
mock.module("../services/auth/store", () => ({ authSessionStore: {} }));
const { tokendanceRoutes } = await import("./tokendance");
const user = { sub: "test-owner", role: "admin" as const, iat: 0, exp: 0 };
function app(principal?: AuthPrincipal) {
	const instance = new Hono();
	if (principal)
		instance.use("*", async (c, next) => {
			c.set("auth", principal);
			c.set("user", principal.user);
			if (principal.type === "oauth") c.set("oauth", principal.oauth);
			await next();
		});
	instance.route("/api/tokendance", tokendanceRoutes);
	return instance;
}
const endpoints = [
	["GET", "/connection"],
	["PATCH", "/connection"],
	["DELETE", "/connection"],
	["POST", "/oauth/start"],
	["POST", "/oauth/complete"],
	["POST", "/oauth/cancel"],
	["POST", "/oauth/restore"],
	["POST", "/models/refresh"],
] as const;
describe("TokenDance first-party admin boundary", () => {
	test("every management endpoint rejects external OAuth even for an admin", async () => {
		const instance = app({
			type: "oauth",
			user,
			oauth: {
				tokenId: "token",
				clientId: "client",
				oauthClientId: "client",
				grantId: "grant",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: ["settings.write"],
			},
		});
		for (const [method, path] of endpoints) {
			const response = await instance.request(`/api/tokendance${path}`, { method });
			expect(response.status).toBe(401);
			expect(await response.json()).toMatchObject({ code: "SESSION_REQUIRED" });
		}
	});
	test("every management endpoint rejects an ordinary session user", async () => {
		const instance = app({ type: "session", user: { ...user, role: "user" } });
		for (const [method, path] of endpoints) {
			const response = await instance.request(`/api/tokendance${path}`, { method });
			expect(response.status).toBe(403);
		}
	});
	test("session admin can read safe connection, unauthenticated access fails", async () => {
		const response = await app({ type: "session", user }).request("/api/tokendance/connection");
		expect(response.status).toBe(200);
		expect(await response.json()).toEqual(connection);
		expect((await app().request("/api/tokendance/connection")).status).toBe(401);
	});
	test("strict bodies reject credential injection and oversize before invoking service", async () => {
		const instance = app({ type: "session", user });
		const response = await instance.request("/api/tokendance/connection", {
			method: "PATCH",
			body: JSON.stringify({ disabled: false, apiKey: "must-not-save" }),
		});
		expect(response.status).toBe(400);
		const tooLarge = await instance.request("/api/tokendance/oauth/start", {
			method: "POST",
			body: "x".repeat(1024 * 1024 + 8193),
		});
		expect(tooLarge.status).toBe(413);
	});
	test("safe error serialization only includes whitelisted recovery metadata", async () => {
		const response = await app({ type: "session", user }).request(
			"/api/tokendance/models/refresh",
			{ method: "POST" },
		);
		expect(response.status).toBe(502);
		expect(await response.json()).toEqual({
			error: "TokenDance model refresh failed",
			code: "TOKENDANCE_ERROR",
			recoveryAction: "top_up_balance",
		});
	});
});
