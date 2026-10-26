import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { AppError } from "../../lib/errors";
import * as outbound from "../../lib/net/outbound-fetch";
import { providerBalanceCache } from "../../lib/provider-balance-cache";
import { type CustomApiProviderConfig, saveSettings, settings } from "../../lib/settings";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { providerBalanceRoutes } from "../provider-balances";
import { settingsRoutes } from "../settings";

const original = structuredClone(settings);
const config = (apiKey = "key-current"): CustomApiProviderConfig => ({
	id: "relay-balance-test",
	name: "Relay balance test",
	prefix: "relay-balance-test",
	baseUrl: "https://relay.invalid/v1",
	protocol: "completions-compatible",
	apiKey,
	defaultModel: "test-model",
});

function appForRole(role: "admin" | "user") {
	const app = new Hono();
	// Distinct subs per role: assertAdmin reads the live store role, and the seam
	// in beforeEach maps each sub to its role.
	const sub = role === "admin" ? "balance-admin" : "balance-user";
	app.use("*", async (c, next) => {
		c.set("user", { sub, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError)
			return new Response(JSON.stringify({ error: error.code }), { status: error.statusCode });
		throw error;
	});
	app.route("/api/provider-balances", providerBalanceRoutes);
	app.route("/api/settings", settingsRoutes);
	return app;
}

beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "balance-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	settings.customApiProviders = [];
	providerBalanceCache.sync();
	settings.customApiProviders = [config()];
	spyOn(outbound, "outboundFetch").mockImplementation(async () =>
		Response.json({ mode: "unrestricted", isValid: true, balance: 12, unit: "USD" }),
	);
});
afterEach(() => {
	setAuthStores(undefined);
	settings.customApiProviders = [];
	providerBalanceCache.sync();
	mock.restore();
});
afterAll(() => {
	saveSettings(original);
});

describe("provider balance API and settings integration", () => {
	test("authenticated reader gets only safe snapshots and no-store", async () => {
		await providerBalanceCache.request(config().id);
		const response = await appForRole("user").request("/api/provider-balances");
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const text = await response.text();
		expect(text).not.toMatch(/key-current|relay\.invalid|Authorization|identity/);
		expect(JSON.parse(text)[config().id]).toMatchObject({
			status: "supported",
			adapter: "sub2api",
		});
	});

	test("provider query selects only that provider, not arbitrary outbound URL", async () => {
		settings.customApiProviders = [config(), { ...config(), id: "second", prefix: "second" }];
		const response = await appForRole("user").request(
			`/api/provider-balances?providerId=${config().id}`,
		);
		expect(Object.keys(await response.json())).toEqual([config().id]);
		const unknown = await appForRole("user").request(
			"/api/provider-balances?providerId=https://evil.invalid",
		);
		expect(await unknown.json()).toEqual({});
	});

	for (const action of ["probe", "refresh"]) {
		test(`only admin may ${action} a saved configuration`, async () => {
			const response = await appForRole("user").request(
				`/api/provider-balances/${config().id}/${action}`,
				{ method: "POST" },
			);
			expect(response.status).toBe(403);
			expect(outbound.outboundFetch).not.toHaveBeenCalled();
			const missing = await appForRole("admin").request(
				`/api/provider-balances/not-saved/${action}`,
				{
					method: "POST",
					body: JSON.stringify({ baseUrl: "https://evil.invalid", apiKey: "private" }),
				},
			);
			expect(missing.status).toBe(404);
			expect(outbound.outboundFetch).not.toHaveBeenCalled();
		});
	}

	test("admin receives explicit cooldown rather than a silently ignored probe", async () => {
		await providerBalanceCache.request(config().id);
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
		const response = await appForRole("admin").request(
			`/api/provider-balances/${config().id}/probe`,
			{ method: "POST" },
		);
		expect(response.status).toBe(429);
		expect(await response.json()).toEqual({ error: "PROVIDER_BALANCE_THROTTLED" });
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
	});

	test("GET and admin probe return without waiting for a hanging upstream", async () => {
		spyOn(outbound, "outboundFetch").mockImplementation(
			async () => new Promise<Response>(() => {}),
		);
		const app = appForRole("admin");
		const response = await app.request(`/api/provider-balances/${config().id}/probe`, {
			method: "POST",
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ status: "probing" });
		const read = await app.request("/api/provider-balances");
		expect(read.status).toBe(200);
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
	});

	test("saving new and changed credentials probes once, never waits and projects new generation", async () => {
		settings.customApiProviders = [];
		providerBalanceCache.sync();
		const fetchSpy = spyOn(outbound, "outboundFetch").mockImplementation(
			async () => new Promise<Response>(() => {}),
		);
		const app = appForRole("admin");
		const patch = async (value: CustomApiProviderConfig) => {
			const response = await app.request("/api/settings", {
				method: "PATCH",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ customApiProviders: [value] }),
			});
			expect(response.status).toBe(200);
			return (await response.json()).providerBalanceGenerations[config().id] as string;
		};
		const generation = await patch(config());
		expect(generation).toMatch(/^[\da-f-]{36}$/);
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
		expect(await patch({ ...config(), name: "Renamed" })).toBe(generation);
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(1);
		const next = await patch(config("key-replaced"));
		expect(next).not.toBe(generation);
		expect(outbound.outboundFetch).toHaveBeenCalledTimes(2);
		const calls = fetchSpy.mock.calls;
		const init = calls[1]?.[1];
		expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer key-replaced");
	});

	test("failed save cannot start discovery", async () => {
		const response = await appForRole("admin").request("/api/settings", {
			method: "PATCH",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ customApiProviders: [{ ...config(), protocol: "invalid-protocol" }] }),
		});
		expect(response.status).toBe(400);
		expect(outbound.outboundFetch).not.toHaveBeenCalled();
	});
});
