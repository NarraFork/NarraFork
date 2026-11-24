import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import {
	buildBalanceRoots,
	parseNewApiBalance,
	parseSub2ApiBalance,
} from "../../../plugins/provider-quota/src/relay";
import { parseNewApiUserQuota } from "../../../plugins/provider-quota/src/site";
import {
	archivedQuotaFixture,
	closeQuotaTestPackage,
	quotaConfig,
	quotaTestPackage,
} from "../../../server/lib/__tests__/provider-quota-legacy-fixture";
import { isCanonicalPermissionName, parseManifest } from "../../../server/lib/plugins/manifest";
import {
	NARRAFORK_RPC_PROTOCOL,
	PLUGIN_TO_HOST_FEATURES,
} from "../../../server/lib/plugins/protocol";
import {
	hasSiteQuotaConfig,
	resolveSiteQuotaConfig,
} from "../../../server/services/provider-quota-sites";
import { providerQuotaSourceSchema, quotaQueryParamsSchema } from "../../../shared/provider-quota";

let f: Awaited<ReturnType<typeof archivedQuotaFixture>>;
let responder: (url: string, init?: RequestInit) => Response = () =>
	Response.json({ isValid: true, mode: "unrestricted", unit: "USD", balance: 7 });
beforeAll(async () => {
	f = await archivedQuotaFixture({ fetch: async (url, init) => responder(String(url), init) });
}, 60000);
afterAll(async () => {
	await f?.close();
	await closeQuotaTestPackage();
});
const cfg = () => quotaConfig({ id: `contract-${crypto.randomUUID()}` });
const quota = {
	code: true,
	data: {
		object: "token_usage",
		unlimited_quota: false,
		total_available: 500000,
		total_used: 100000,
		total_granted: 600000,
	},
};
const siteBody = { success: true, data: { quota: 2500000, used_quota: 500000, group: "pro" } };

describe("archived quota manifest and credential-free contract", () => {
	test("actual package declares four valid quota sources, never Agent tools or internal commands", async () => {
		const root = (await quotaTestPackage()).packageRoot;
		const manifest = parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
		expect(manifest.pluginId).toBe("io.narrafork.provider-quota");
		expect(manifest.version).toBe("1.0.3");
		expect(manifest.server?.entry).toBe("server/index.js");
		expect(manifest.engine.hostApi).toBe(">=1.0 <2");
		expect(manifest.contributes.tools).toEqual([]);
		expect(manifest.contributes.commands).toEqual([]);
		expect(manifest.contributes.providers).toEqual([]);
		expect(manifest.contributes.quotaSources).toHaveLength(4);
		expect(manifest.contributes.quotaSources.map(({ id }) => id).sort()).toEqual([
			"deepseek",
			"kimi",
			"opencode",
			"relay",
		]);
		for (const source of manifest.contributes.quotaSources)
			expect(providerQuotaSourceSchema.safeParse(source).success).toBe(true);
		expect(manifest.activationEvents).toEqual(["onStartup"]);
		expect(manifest.permissions.host.sort()).toEqual([
			"provider.connection.request",
			"quota.provide",
		]);
	});
	test("retains canonical manifest permissions and supported RPC features", async () => {
		const manifest = parseManifest(
			JSON.parse(
				await readFile(join((await quotaTestPackage()).packageRoot, "manifest.json"), "utf8"),
			),
		);
		expect(manifest.engine.rpc).toBe(NARRAFORK_RPC_PROTOCOL);
		expect(manifest.server?.protocol).toBe(NARRAFORK_RPC_PROTOCOL);
		expect(manifest.permissions.host.every(isCanonicalPermissionName)).toBe(true);
		if (!manifest.engine.features?.length) throw new Error("Quota features must be declared");
		expect(
			manifest.engine.features.every((feature) =>
				(PLUGIN_TO_HOST_FEATURES as readonly string[]).includes(feature),
			),
		).toBe(true);
	});
	test("distributed runtime calls only host methods with declared capabilities", async () => {
		const root = (await quotaTestPackage()).packageRoot;
		const runtime = await readFile(join(root, "sources/src/runtime.ts"), "utf8");
		const manifest = parseManifest(JSON.parse(await readFile(join(root, "manifest.json"), "utf8")));
		const mapping = {
			"provider.connection.request": "provider.connection.request",
			"secrets.get": "secret.use_self",
			"storage.get": "storage.read_self",
			"config.get": "config.read_self",
			"diagnostics.getOwn": "diagnostics.readOwnLogs",
		};
		for (const [method, permission] of Object.entries(mapping))
			if (runtime.includes(`"${method}"`)) expect(manifest.permissions.host).toContain(permission);
		expect(runtime).not.toMatch(/fetch\(|@server\/|narrafork\.db|settings\.json/);
	});
	test("credential-bearing former tool inputs are rejected rather than forwarded", () => {
		const target = {
			kind: "custom-api",
			providerId: "p",
			id: "custom-api/p",
			generation: "g",
			baseUrl: "https://relay.invalid/v1",
		};
		const request = {
			protocolVersion: "1.0",
			contributionId: "relay",
			mode: "probe",
			target,
			reference: "r",
			deadlineAt: Date.now() + 1000,
		};
		expect(quotaQueryParamsSchema.safeParse(request).success).toBe(true);
		for (const field of ["apiKey", "headers", "proxy", "siteToken", "tlsRejectUnauthorized"])
			expect(quotaQueryParamsSchema.safeParse({ ...request, [field]: "private" }).success).toBe(
				false,
			);
	});
});

describe("retained allowance shapes now belong only to the independent plugin", () => {
	test("sub2api wallet/limited/subscription retain exact allowance projections", () => {
		expect(
			parseSub2ApiBalance({ isValid: true, mode: "unrestricted", unit: "USD", balance: 12.5 }),
		).toEqual({ scope: "wallet", unlimited: false, amounts: [{ unit: "USD", remaining: 12.5 }] });
		expect(
			parseSub2ApiBalance({
				isValid: true,
				mode: "quota_limited",
				quota: { unit: "USD", remaining: 5, used: 5, limit: 10 },
				rate_limits: [{ window: "5h", remaining: 1, used: 1, limit: 2 }],
			}),
		).toMatchObject({ scope: "key", amounts: [{ remaining: 5 }, { remaining: 1, window: "5h" }] });
		expect(
			parseSub2ApiBalance({
				isValid: true,
				mode: "unrestricted",
				unit: "USD",
				remaining: -1,
				planName: "Pro",
				subscription: { daily_limit_usd: 10, daily_usage_usd: 2 },
			}),
		).toMatchObject({
			scope: "subscription",
			unlimited: true,
			planName: "Pro",
			amounts: [{ remaining: 8, used: 2, total: 10 }],
		});
	});
	for (const body of [
		null,
		{},
		{ isValid: "yes" },
		{ isValid: true, mode: "quota_limited" },
		{ isValid: true, mode: "unrestricted", unit: "EUR", balance: 1 },
		{ isValid: true, success: false },
	])
		test(`sub2api rejects retained non-answer ${JSON.stringify(body)}`, () => {
			expect(parseSub2ApiBalance(body)).toBeNull();
		});
	test("New API converts with valid status and otherwise keeps raw quota units", () => {
		expect(
			parseNewApiBalance(quota, {
				success: true,
				data: { quota_per_unit: 500000, quota_display_type: "USD" },
			}),
		).toMatchObject({ amounts: [{ unit: "USD", remaining: 1, used: 0.2, total: 1.2 }] });
		expect(parseNewApiBalance(quota)).toMatchObject({
			amounts: [{ unit: "QUOTA", remaining: 500000 }],
		});
	});
	for (const base of [
		"https://relay.example.com/v1",
		"https://relay.example.com/v1beta",
		"https://relay.example.com/anthropic",
		"https://relay.example.com",
		"https://relay.example.com/api/",
	])
		test(`retains same-origin roots for ${base}`, () => {
			const roots = buildBalanceRoots(base);
			expect(roots.length).toBeLessThanOrEqual(2);
			expect(roots.every((root) => new URL(root).origin === new URL(base).origin)).toBe(true);
			expect(roots[0]).toBe(base.replace(/\/$/, "").replace(/\/(?:v1|v1beta|anthropic)$/, ""));
		});
});

describe("actual archived RPC probe and site-account credit", () => {
	test("discovers the wallet endpoint and injects the key only inside Host HTTP", async () => {
		const requests: Array<{ url: string; headers: Headers }> = [];
		responder = (url, init) => {
			requests.push({ url, headers: new Headers(init?.headers) });
			return Response.json({ isValid: true, mode: "unrestricted", unit: "USD", balance: 7 });
		};
		const result = await f.rpc(cfg());
		expect(result).toMatchObject({
			status: "supported",
			data: { format: "sub2api", amounts: [{ remaining: 7 }] },
		});
		expect(requests[0]?.url.endsWith("/v1/usage")).toBe(true);
		expect(
			requests.every(({ headers }) => headers.get("authorization") === "Bearer test-secret-key"),
		).toBe(true);
	});
	test("a non-serving origin is unsupported without false zero", async () => {
		responder = () => new Response(null, { status: 404 });
		expect(await f.rpc(cfg())).toMatchObject({ status: "unsupported", data: null });
	});
	test("a stored cursor/root outside the saved origin never reaches Host HTTP", async () => {
		let reached = false;
		responder = () => {
			reached = true;
			return Response.json({});
		};
		expect(
			await f.rpc(
				cfg(),
				"refresh",
				JSON.stringify({ adapter: "sub2api", root: "https://other.invalid" }),
			),
		).toMatchObject({ status: "error", error: "invalid_configuration" });
		expect(reached).toBe(false);
	});
	test("site credit, strings, zero and unlimited remain explicit rather than inferred", () => {
		expect(parseNewApiUserQuota(siteBody)).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 5, used: 1, total: 6 }],
			planName: "pro",
		});
		expect(
			parseNewApiUserQuota({ success: true, data: { quota: "2500000", used_quota: "500000" } })
				?.amounts[0]?.remaining,
		).toBe(5);
		expect(
			parseNewApiUserQuota({ success: true, data: { quota: 0, used_quota: 0 } })?.amounts[0]
				?.remaining,
		).toBe(0);
		expect(parseNewApiUserQuota({ success: true, data: { quota: -1, used_quota: 0 } })).toEqual({
			scope: "wallet",
			unlimited: true,
			amounts: [],
		});
	});
	for (const body of [
		{ success: false, data: { quota: 1, used_quota: 0 } },
		{ success: true },
		{ success: true, data: { quota: 1 } },
		{ success: true, data: { quota: -2, used_quota: 0 } },
	])
		test(`site rejects retained shape ${JSON.stringify(body)}`, () => {
			expect(parseNewApiUserQuota(body)).toBeNull();
		});
	test("Host resolves the separate site root and never exposes the private site token", () => {
		const config = {
			...cfg(),
			quotaSiteUrl: "https://site.invalid",
			quotaAccessToken: "site-token",
			quotaUserId: "42",
		};
		expect(hasSiteQuotaConfig({})).toBe(false);
		expect(hasSiteQuotaConfig(config)).toBe(true);
		expect(resolveSiteQuotaConfig(config)).toEqual({
			root: "https://site.invalid",
			accessToken: "site-token",
			userId: "42",
		});
		expect(resolveSiteQuotaConfig({ ...config, quotaSiteUrl: undefined }).root).toBe(
			"https://relay.invalid",
		);
		expect(() => resolveSiteQuotaConfig({ ...config, quotaUserId: "" })).toThrow(
			expect.objectContaining({ code: "invalid_configuration" }),
		);
	});
	test("RPC selects the saved site token/header/path and excludes the inference key", async () => {
		let url = "";
		let headers = new Headers();
		responder = (input, init) => {
			url = input;
			headers = new Headers(init?.headers);
			return Response.json(siteBody);
		};
		const result = await f.rpc({
			...cfg(),
			quotaSiteUrl: "https://site.invalid",
			quotaAccessToken: "site-token",
			quotaUserId: "42",
		});
		expect(result).toMatchObject({
			status: "supported",
			data: { format: "new-api-user", scope: "wallet" },
		});
		expect(url).toBe("https://site.invalid/api/user/self");
		expect(headers.get("authorization")).toBe("Bearer site-token");
		expect(headers.get("new-api-user")).toBe("42");
		expect([...headers.values()]).not.toContain("Bearer test-secret-key");
	});
	for (const [status, error] of [
		[401, "auth_failed"],
		[403, "auth_failed"],
		[503, "request_failed"],
		[429, "request_failed"],
		[404, "invalid_response"],
	] as const)
		test(`site HTTP ${status} is ${error} through actual archived RPC`, async () => {
			responder = () => new Response(null, { status });
			expect(
				await f.rpc({ ...cfg(), quotaAccessToken: "site-token", quotaUserId: "42" }),
			).toMatchObject({ status: "error", data: null, error });
		});
});
