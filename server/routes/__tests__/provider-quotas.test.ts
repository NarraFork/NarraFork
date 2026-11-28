import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import type { ProviderQuotaData } from "@shared/provider-quota";
import type { QuotaSnapshotsResponse } from "@shared/quota-snapshot";
import { Hono } from "hono";
import { ZodError } from "zod";
import {
	deferred,
	legacyQuotaFixture,
	quotaConfig,
	required,
	walletQuota,
} from "../../lib/__tests__/provider-quota-legacy-fixture";
import { AppError } from "../../lib/errors";
import { saveSettings, settings } from "../../lib/settings";
import { requireSessionAuth } from "../../middleware/auth";
import type { AuthSessionStore } from "../../services/auth/session-store";
import { authMfaStore, authSessionStore, setAuthStores } from "../../services/auth/store";
import { initializePluginServices } from "../../services/plugin-manager";
import { providerBalanceRoutes } from "../provider-balances";
import { providerQuotaRoutes } from "../provider-quotas";
import { quotaSnapshotRoutes } from "../quota-snapshots";

let fixture: ReturnType<typeof legacyQuotaFixture>;
function appForRole(role: "admin" | "user", principalType: "session" | "oauth" = "session") {
	const app = new Hono();
	app.use("*", async (c, next) => {
		const user = {
			sub: role === "admin" ? "quota-admin" : "quota-user",
			role,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		};
		c.set("user", user);
		if (principalType === "oauth") {
			const oauth = {
				tokenId: "quota-token",
				clientId: "quota-client",
				oauthClientId: "quota-client-id",
				grantId: "quota-grant",
				refreshFamilyId: null,
				expiresAt: "2099-01-01T00:00:00.000Z",
				scopes: [],
			};
			c.set("auth", { type: "oauth", user, oauth });
			c.set("oauth", oauth);
		} else {
			c.set("auth", { type: "session", user });
		}
		await next();
	});
	app.use("/api/*", requireSessionAuth);
	app.onError((error, c) => {
		if (error instanceof AppError)
			return new Response(JSON.stringify({ error: error.code }), {
				status: error.statusCode,
				headers: c.res.headers,
			});
		if (error instanceof ZodError)
			return new Response(JSON.stringify({ error: "VALIDATION_ERROR" }), { status: 400 });
		throw error;
	});
	app.route("/api/provider-quotas", providerQuotaRoutes);
	app.route("/api/provider-balances", providerBalanceRoutes);
	app.route("/api/quota-snapshots", quotaSnapshotRoutes);
	return app;
}

/** Execute the production initialization chain without importing main's server side effects. */
function runPluginStartup(
	initialized: Promise<unknown[]>,
	logError = mock(() => {}),
	options: {
		startSource?: () => void;
		prepareSettings?: () => Promise<void>;
		isShuttingDown?: () => boolean;
	} = {},
): Promise<void> {
	const main = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
	const chain = main.match(
		/^[\t ]*initializePluginServices\(pluginManager,[\s\S]*?\r?\n[\t ]*\.catch\([^\r\n]+\);/m,
	)?.[0];
	if (!chain) throw new Error("Production plugin initialization chain was not found");
	return runInNewContext(chain, {
		// The real sequencing helper, so this keeps testing what main.ts actually runs.
		initializePluginServices,
		getBundledPluginDescriptors: () => [],
		pluginManager: {
			initialize: () => initialized,
			bootstrapBundledPlugin: async () => undefined,
			isShuttingDown: options.isShuttingDown ?? (() => false),
			isEnabled: () => true,
			list: async () => [],
		},
		providerQuotaService: fixture.service,
		pluginPlatformServices: {
			providerSettingsService: {
				prepareQuotaMigrations: options.prepareSettings ?? (async () => {}),
			},
		},
		pluginSourceService: { start: options.startSource ?? (() => {}) },
		logger: { info: () => {}, warn: () => {}, error: logError },
	}) as Promise<void>;
}

beforeEach(() => {
	const store: AuthSessionStore = {
		...authSessionStore,
		findSessionState: async (id) => ({
			id,
			role: id === "quota-admin" ? "admin" : "user",
			tokenVersion: 0,
		}),
	};
	setAuthStores({ session: store, mfa: authMfaStore });
	fixture = legacyQuotaFixture();
});
afterEach(() => {
	fixture.dispose();
	setAuthStores(undefined);
	mock.restore();
});

describe("generic Custom API quota routes", () => {
	test("returns normalized credential-free data with no-store to ordinary sessions", async () => {
		await fixture.service.refresh("relay-test");
		const response = await appForRole("user").request("/api/provider-quotas");
		expect(response.status).toBe(200);
		expect(response.headers.get("Cache-Control")).toBe("no-store");
		const text = await response.text();
		expect(text).not.toMatch(/test-secret-key|relay\.invalid|Authorization|cursor|identity/);
		const page = JSON.parse(text);
		expect(page.nextCursor).toBeNull();
		expect(page.snapshots[0]).toMatchObject({
			providerId: "relay-test",
			targetId: "custom-api/relay-test",
			status: "supported",
			data: walletQuota,
		});
	});

	test("filters unknown, removed and disabled IDs without accepting arbitrary URLs", async () => {
		settings.customApiProviders = [quotaConfig(), quotaConfig({ id: "disabled", disabled: true })];
		const app = appForRole("user");
		for (const id of ["disabled", "removed", "https://evil.invalid", "nug-provider"]) {
			const response = await app.request(
				`/api/provider-quotas?providerId=${encodeURIComponent(id)}`,
			);
			expect(await response.json()).toEqual({ snapshots: [], nextCursor: null });
		}
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("pages through the Custom API directory with a 100-entry maximum", async () => {
		settings.customApiProviders = Array.from({ length: 125 }, (_, i) =>
			quotaConfig({ id: `provider-${String(i).padStart(3, "0")}`, prefix: `provider-${i}` }),
		);
		const app = appForRole("user");
		const first = await (await app.request("/api/provider-quotas?limit=100")).json();
		expect(first.snapshots).toHaveLength(100);
		expect(first.nextCursor).toBe("provider-099");
		const second = await (
			await app.request(`/api/provider-quotas?cursor=${first.nextCursor}&limit=100`)
		).json();
		expect(second.snapshots).toHaveLength(25);
		expect(second.nextCursor).toBeNull();
		expect(
			new Set(
				[...first.snapshots, ...second.snapshots].map(
					(row: { providerId: string }) => row.providerId,
				),
			).size,
		).toBe(125);
	});

	test("response-size pagination stays below 256 KiB without losing entries", async () => {
		const data: ProviderQuotaData = {
			amounts: Array.from({ length: 24 }, (_, i) => ({
				id: `amount:${i}`,
				label: "Currency detail ".repeat(12),
				unit: "QUOTA",
				remaining: 5,
			})),
			windows: Array.from({ length: 12 }, (_, i) => ({
				id: `window:${i}`,
				label: "Window detail ".repeat(12),
				used: 2,
				limit: 3,
				remaining: 1,
				resetAt: null,
			})),
			details: "Details ".repeat(256),
		};
		settings.customApiProviders = Array.from({ length: 50 }, (_, i) =>
			quotaConfig({ id: `large-${String(i).padStart(3, "0")}`, prefix: `large-${i}` }),
		);
		fixture.query.mockResolvedValue({ status: "supported", data, error: null });
		await Promise.all(settings.customApiProviders.map(({ id }) => fixture.service.refresh(id)));
		const app = appForRole("user");
		let cursor: string | null = null;
		const ids: string[] = [];
		do {
			const response = await app.request(
				`/api/provider-quotas?limit=100${cursor ? `&cursor=${cursor}` : ""}`,
			);
			const text = await response.text();
			expect(Buffer.byteLength(text)).toBeLessThanOrEqual(256 * 1024);
			const page = JSON.parse(text);
			expect(page.snapshots.length).toBeGreaterThan(0);
			ids.push(...page.snapshots.map((row: { providerId: string }) => row.providerId));
			cursor = page.nextCursor;
		} while (cursor);
		expect(new Set(ids).size).toBe(50);
		expect(ids).toHaveLength(50);
	});

	test("validates pagination arguments before any source is queried", async () => {
		for (const query of [
			"limit=101",
			"limit=0",
			"limit=x",
			"limit=1.5",
			"baseUrl=https://evil.invalid",
		]) {
			expect((await appForRole("user").request(`/api/provider-quotas?${query}`)).status).toBe(400);
		}
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("third-party windows require no host-specific provider or adapter enum", async () => {
		fixture.query.mockResolvedValue({
			status: "supported",
			error: null,
			data: {
				amounts: [],
				windows: [
					{ id: "team-hour", label: "Team hour", used: 4, limit: 12, remaining: 8, resetAt: null },
				],
				scope: "team",
			},
		});
		await fixture.service.refresh("relay-test");
		const page = await (await appForRole("user").request("/api/provider-quotas")).json();
		expect(page.snapshots[0].data.windows[0]).toMatchObject({ id: "team-hour", remaining: 8 });
	});

	for (const action of ["refresh", "probe"]) {
		test(`${action} is admin-only and refuses unsaved targets`, async () => {
			expect(
				(
					await appForRole("user").request(`/api/provider-quotas/relay-test/${action}`, {
						method: "POST",
					})
				).status,
			).toBe(403);
			expect(
				(
					await appForRole("admin").request(`/api/provider-quotas/not-saved/${action}`, {
						method: "POST",
					})
				).status,
			).toBe(404);
			expect(fixture.query).not.toHaveBeenCalled();
		});
	}

	test("refresh accepts explicit probe mode and returns immediately while the source is pending", async () => {
		fixture.query.mockImplementation(() => new Promise(() => {}));
		const response = await appForRole("admin").request("/api/provider-quotas/relay-test/refresh", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ mode: "probe" }),
		});
		expect(response.status).toBe(200);
		expect(await response.json()).toMatchObject({ providerId: "relay-test", status: "probing" });
		expect(fixture.query.mock.calls[0]?.[2].mode).toBe("probe");
		expect((await appForRole("user").request("/api/provider-quotas")).status).toBe(200);
	});

	test("manual cooldown is shared by new and legacy entry points with Retry-After", async () => {
		const app = appForRole("admin");
		expect(
			(await app.request("/api/provider-quotas/relay-test/refresh", { method: "POST" })).status,
		).toBe(200);
		await fixture.service.refresh("relay-test");
		const response = await app.request("/api/provider-quotas/relay-test/probe", { method: "POST" });
		expect(response.status).toBe(429);
		expect(response.headers.get("Retry-After")).toBe("10");
		expect(
			(await app.request("/api/provider-balances/relay-test/probe", { method: "POST" })).status,
		).toBe(429);
		expect(fixture.query).toHaveBeenCalledTimes(1);
	});

	test("rejects malformed or oversized manual bodies and credential overrides", async () => {
		const app = appForRole("admin");
		for (const body of [
			"{",
			JSON.stringify({ mode: "invalid" }),
			JSON.stringify({ baseUrl: "https://evil.invalid", apiKey: "secret" }),
		]) {
			expect(
				(await app.request("/api/provider-quotas/relay-test/refresh", { method: "POST", body }))
					.status,
			).toBe(400);
		}
		expect(
			(
				await app.request("/api/provider-quotas/relay-test/refresh", {
					method: "POST",
					body: "x".repeat(1025),
				})
			).status,
		).toBe(413);
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("no active plugin is explicitly unavailable and cannot fall back to core fetching", async () => {
		fixture.revoke();
		const page = await (await appForRole("user").request("/api/provider-quotas")).json();
		expect(page.snapshots[0]).toMatchObject({
			status: "unavailable",
			data: null,
			error: "unavailable",
		});
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("named providers retain role redaction and share the manual throttle through unified snapshots", async () => {
		const providers = [
			quotaConfig({ id: "kimi", prefix: "kimi", baseUrl: "https://api.kimi.com" }),
			quotaConfig({ id: "deepseek", prefix: "deepseek", baseUrl: "https://api.deepseek.com" }),
			quotaConfig({ id: "opencode", prefix: "opencode", baseUrl: "https://opencode.ai/zen/go/v1" }),
		];
		saveSettings({ ...settings, customApiProviders: providers });
		fixture.query.mockRejectedValue(new Error("private credentials in upstream text"));
		await Promise.all(providers.map(({ id }) => fixture.service.refresh(id)));
		fixture.advance(10_000);
		for (const { id } of providers) {
			for (const role of ["user", "admin"] as const) {
				const response = await appForRole(role).request(
					`/api/quota-snapshots?groupId=${id}&cachedOnly=true`,
				);
				expect(response.status).toBe(200);
				expect(response.headers.get("Cache-Control")).toBe("no-store");
				const page: QuotaSnapshotsResponse = await response.json();
				expect(page.entries).toHaveLength(1);
				const entry = required(page.entries[0]);
				expect(entry.snapshot).toMatchObject({ hasError: true, error: "quota_unavailable" });
				if (role === "user") expect(entry.credentialId).toBeNull();
				else expect(entry.credentialId).toBeString();
				expect(JSON.stringify(page)).not.toMatch(/private credentials|test-secret-key|detail/);
			}
			const request = {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ groupId: id }),
			};
			expect(
				(await appForRole("user").request("/api/quota-snapshots/refresh", request)).status,
			).toBe(403);
			expect(
				(await appForRole("admin").request("/api/quota-snapshots/refresh", request)).status,
			).toBe(200);
			await fixture.service.refresh(id);
			const throttled = await appForRole("admin").request(`/api/provider-quotas/${id}/probe`, {
				method: "POST",
			});
			expect(throttled.status).toBe(429);
			expect(throttled.headers.get("Retry-After")).toBe("10");
		}
		expect(fixture.query).toHaveBeenCalledTimes(6);
	});

	test("mounting stays behind the session-only boundary and has no retired warmup paths", () => {
		const app = readFileSync(new URL("../../app.ts", import.meta.url), "utf8");
		const boundary = app.indexOf('app.use("/api/*", requireSessionAuth)');
		const mount = app.indexOf('app.route("/api/provider-quotas", providerQuotaRoutes)');
		expect(boundary).toBeGreaterThanOrEqual(0);
		expect(mount).toBeGreaterThan(boundary);
		const main = readFileSync(new URL("../../main.ts", import.meta.url), "utf8");
		expect(/refreshAll(?:KimiUsages|OpencodeUsages|DeepSeekBalances)/.test(main)).toBe(false);
	});

	test("the production initialization chain starts quota then sources only after plugins and settings are ready", async () => {
		fixture.service.stop();
		const initialized = deferred<unknown[]>();
		const preparing = deferred<void>();
		const prepared = deferred<void>();
		const logError = mock(() => {});
		const prepareSettings = mock(() => {
			preparing.resolve();
			return prepared.promise;
		});
		const startSource = mock(() => {
			expect(fixture.service.getDiagnostics().running).toBe(true);
		});
		const startup = runPluginStartup(initialized.promise, logError, {
			startSource,
			prepareSettings,
		});
		expect(fixture.service.getDiagnostics().running).toBe(false);
		expect(fixture.query).not.toHaveBeenCalled();
		expect(startSource).not.toHaveBeenCalled();
		expect(prepareSettings).not.toHaveBeenCalled();
		initialized.resolve([]);
		await preparing.promise;
		expect(prepareSettings).toHaveBeenCalledTimes(1);
		expect(fixture.service.getDiagnostics().running).toBe(false);
		expect(startSource).not.toHaveBeenCalled();
		prepared.resolve();
		await startup;
		expect(fixture.service.getDiagnostics().running).toBe(true);
		expect(startSource).toHaveBeenCalledTimes(1);
		expect(logError).not.toHaveBeenCalled();
		await fixture.service.refresh("relay-test");
		expect(fixture.query).toHaveBeenCalledTimes(1);
		expect(fixture.service.peek("relay-test")?.status).toBe("supported");
	});

	test("a failed plugin initialization starts neither quota nor source service", async () => {
		fixture.service.stop();
		const initialized = deferred<unknown[]>();
		const logError = mock(() => {});
		const startSource = mock(() => {});
		const startup = runPluginStartup(initialized.promise, logError, { startSource });
		initialized.reject(new Error("isolated initialization failure"));
		await startup;
		expect(logError).toHaveBeenCalledTimes(1);
		expect(startSource).not.toHaveBeenCalled();
		expect(fixture.service.getDiagnostics().running).toBe(false);
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("shutdown during initialization cannot restart either scheduler", async () => {
		fixture.service.stop();
		const initialized = deferred<unknown[]>();
		const logError = mock(() => {});
		const startSource = mock(() => {});
		let closing = false;
		const startup = runPluginStartup(initialized.promise, logError, {
			startSource,
			isShuttingDown: () => closing,
		});
		closing = true;
		initialized.resolve([]);
		await startup;
		expect(startSource).not.toHaveBeenCalled();
		expect(logError).not.toHaveBeenCalled();
		expect(fixture.service.getDiagnostics().running).toBe(false);
		expect(fixture.query).not.toHaveBeenCalled();
	});

	test("an OAuth admin principal cannot read or mutate generic or legacy quota endpoints", async () => {
		const app = appForRole("admin", "oauth");
		for (const [path, method] of [
			["/api/provider-quotas", "GET"],
			["/api/provider-quotas/relay-test/refresh", "POST"],
			["/api/provider-balances", "GET"],
			["/api/provider-balances/relay-test/probe", "POST"],
			["/api/quota-snapshots", "GET"],
			["/api/quota-snapshots/refresh", "POST"],
		]) {
			const response = await app.request(path, { method });
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({ error: "SESSION_REQUIRED" });
		}
		expect(fixture.query).not.toHaveBeenCalled();
	});

	for (const [path, baseUrl] of [
		["/api/provider-quotas/target/refresh", "https://relay.invalid/v1"],
		["/api/provider-balances/target/probe", "https://relay.invalid/v1"],
		["/api/quota-snapshots/refresh", "https://api.kimi.com"],
		["/api/quota-snapshots/refresh", "https://api.deepseek.com"],
		["/api/quota-snapshots/refresh", "https://opencode.ai/zen/go/v1"],
	]) {
		test(`${path} reports a full shared queue for ${baseUrl} instead of pretending a refresh was accepted`, async () => {
			fixture.dispose();
			mock.restore();
			fixture = legacyQuotaFixture(
				[
					quotaConfig({ id: "target", prefix: "target", baseUrl }),
					quotaConfig({ id: "busy-a", prefix: "busy-a" }),
					quotaConfig({ id: "busy-b", prefix: "busy-b" }),
				],
				walletQuota,
				{ maxConcurrent: 1, maxQueued: 1 },
			);
			saveSettings({ ...settings });
			fixture.query.mockImplementation(() => new Promise(() => {}));
			void fixture.service.refresh("busy-a");
			void fixture.service.refresh("busy-b");
			expect(fixture.service.getDiagnostics()).toMatchObject({ active: 1, queued: 1 });
			const response = await appForRole("admin").request(path, {
				method: "POST",
				...(path === "/api/quota-snapshots/refresh"
					? {
							headers: { "Content-Type": "application/json" },
							body: JSON.stringify({ groupId: "target" }),
						}
					: {}),
			});
			expect(response.status).toBe(429);
			expect(response.headers.get("Retry-After")).toBe("1");
			expect(await response.json()).toEqual({ error: "PROVIDER_QUOTA_BUSY" });
			expect(fixture.query).toHaveBeenCalledTimes(1);
			expect(fixture.service.peek("target")?.status).toBe("pending");
		});
	}
});
