import { describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../lib/errors";
import type { AuthPrincipal } from "../middleware/auth";

let callbackError: AppError | undefined;
const validateCallback = mock(
	(value: string, _requestUrl?: string, _origin?: string, _fetchSite?: string) => {
		if (callbackError) throw callbackError;
		return new URL(value);
	},
);
const connection = {
	connected: false,
	disabled: false,
	generation: 0,
	models: [],
	name: "TokenDance",
	billingInstance: "a".repeat(32),
};
mock.module("../services/tokendance-service", () => ({
	getTokenDanceConnection: () => connection,
	getTokenDanceBalance: () => ({
		generation: 0,
		credits: null,
		creditsUsed: null,
		balance: null,
		updatedAt: null,
		loading: true,
		hasError: false,
	}),
	refreshTokenDanceBalance: () => ({
		generation: 0,
		credits: 0,
		creditsUsed: 0,
		balance: -1,
		updatedAt: 1,
		loading: false,
		hasError: false,
	}),
	createTokenDancePaymentSession: (owner: string, input: unknown) => ({ owner, input }),
	getTokenDancePaymentSession: (owner: string) => {
		if (owner !== "test-owner") throw new AppError("Not found", 404, "TOKENDANCE_ERROR");
		return { id: "payment-1", status: "pending" };
	},
	startTokenDanceOAuth: () => ({
		flowId: "x".repeat(43),
		authorizeUrl: "https://tokendance.space/auth",
		expiresAt: Date.now() + 600000,
	}),
	validateTokenDanceCallback: validateCallback,
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
	["POST", "/balance/refresh"],
	["POST", "/payment/sessions"],
	["GET", "/payment/sessions/payment-1"],
] as const;
describe("TokenDance first-party admin boundary", () => {
	test("ordinary session users can read balance but anonymous users cannot", async () => {
		expect(
			(
				await app({ type: "session", user: { ...user, role: "user" } }).request(
					"/api/tokendance/balance",
				)
			).status,
		).toBe(200);
		expect((await app().request("/api/tokendance/balance")).status).toBe(401);
	});
	test("payment creation validates input and status is owner scoped", async () => {
		const instance = app({ type: "session", user });
		for (const input of [
			{ amount: 0, generation: 0, requestId: "x".repeat(43) },
			{ amount: 10, generation: 0, requestId: "short" },
			{ amount: 10, generation: 0, requestId: "x".repeat(43), billingInstance: "invalid" },
			{ amount: 10, generation: 0, requestId: "x".repeat(43), billingInstance: undefined },
			{ amount: 10, generation: 0, requestId: "x".repeat(43), paymentUrl: "https://evil.example" },
		]) {
			expect(
				(
					await instance.request("/api/tokendance/payment/sessions", {
						method: "POST",
						body: JSON.stringify({ billingInstance: connection.billingInstance, ...input }),
					})
				).status,
			).toBe(400);
		}
		const created = await instance.request("/api/tokendance/payment/sessions", {
			method: "POST",
			body: JSON.stringify({
				amount: 10,
				generation: 0,
				requestId: "x".repeat(43),
				billingInstance: connection.billingInstance,
			}),
		});
		expect(created.status).toBe(200);
		expect(await created.json()).toHaveProperty("session.owner", "test-owner");
		expect(
			(
				await app({ type: "session", user: { ...user, sub: "other-admin" } }).request(
					"/api/tokendance/payment/sessions/payment-1",
				)
			).status,
		).toBe(404);
	});
	test("OAuth start forwards actual browser Fetch Metadata without trusting forwarded hosts", async () => {
		validateCallback.mockClear();
		const callbackUrl = "https://public.example/nf/settings/providers/tokendance/callback";
		const response = await app({ type: "session", user }).request(
			"http://internal.example/api/tokendance/oauth/start",
			{
				method: "POST",
				headers: {
					Origin: "https://public.example",
					"Sec-Fetch-Site": "same-origin",
					"X-Forwarded-Host": "evil.example",
				},
				body: JSON.stringify({ callbackUrl }),
			},
		);
		expect(response.status).toBe(200);
		expect(validateCallback).toHaveBeenCalledWith(
			callbackUrl,
			"http://internal.example/api/tokendance/oauth/start",
			"https://public.example",
			"same-origin",
		);
	});
	test("OAuth start rejection logs only stage, status, and error code", async () => {
		const warnings: unknown[][] = [];
		const warn = spyOn(console, "warn").mockImplementation((...args) => {
			warnings.push(args);
		});
		callbackError = new AppError("Callback rejected", 400, "TOKENDANCE_CALLBACK_INVALID");
		try {
			const response = await app({ type: "session", user }).request(
				"/api/tokendance/oauth/start?code=private-code",
				{
					method: "POST",
					headers: { Authorization: "Bearer private-token", "Content-Type": "application/json" },
					body: JSON.stringify({
						callbackUrl:
							"https://self.example/settings/providers/tokendance/callback?key=private-key",
						draftSnapshot: { draft: { apiKey: "private-draft" }, baseline: {} },
					}),
				},
			);
			expect(response.status).toBe(400);
			expect(await response.json()).toMatchObject({ code: "TOKENDANCE_CALLBACK_INVALID" });
			expect(warnings).toEqual([
				[
					"[TokenDance] OAuth request rejected",
					{ stage: "start", status: 400, code: "TOKENDANCE_CALLBACK_INVALID" },
				],
			]);
			expect(JSON.stringify(warnings)).not.toContain("private-");
			expect(JSON.stringify(warnings)).not.toContain("Callback rejected");
		} finally {
			callbackError = undefined;
			warn.mockRestore();
		}
	});
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
		for (const [method, path] of [...endpoints, ["GET", "/balance"]]) {
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
