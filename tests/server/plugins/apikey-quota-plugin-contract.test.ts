import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { isCanonicalPermissionName, parseManifest } from "@server/lib/plugins/manifest";
import { NARRAFORK_RPC_PROTOCOL, PLUGIN_TO_HOST_FEATURES } from "@server/lib/plugins/protocol";
import {
	buildBalanceRoots,
	parseNewApiBalance,
	parseNewApiUserQuota,
	parseSub2ApiBalance,
} from "@server/lib/provider-balance-adapters";

const pluginRoot = join(process.cwd(), "server/builtin-plugins/apikey-quota");

/**
 * The plugin is a standalone package with no host imports, so its parsing rules are a
 * mirror of the bundled adapters rather than a shared module. These tests are what keeps
 * the mirror honest: same inputs must produce byte-identical projections, otherwise the
 * host and the plugin would disagree about a provider's allowance after the switch.
 */
const plugin = (await import(`${pluginRoot}/server/index.js`)) as {
	parseSub2ApiBalance: (body: unknown) => unknown;
	parseNewApiBalance: (body: unknown, status?: unknown) => unknown;
	buildBalanceRoots: (baseUrl: string) => string[];
	probeProviderBalance: (
		input: Record<string, unknown>,
		signal: AbortSignal,
		fetcher?: typeof fetch,
	) => Promise<{ adapter: string; root: string; balance: unknown } | null>;
	refreshProviderBalance: (
		input: Record<string, unknown>,
		signal: AbortSignal,
		fetcher?: typeof fetch,
	) => Promise<unknown>;
	hasSiteQuotaConfig: (input: Record<string, unknown>) => boolean;
	resolveSiteQuotaConfig: (input: Record<string, unknown>) => {
		root: string;
		accessToken: string;
		userId: string;
	};
	parseNewApiUserQuota: (body: unknown) => unknown;
	probeSiteQuota: (
		input: Record<string, unknown>,
		signal: AbortSignal,
		fetcher?: typeof fetch,
	) => Promise<{ adapter: string; root: string; balance: Record<string, unknown> }>;
	refreshSiteQuota: (
		input: Record<string, unknown>,
		signal: AbortSignal,
		fetcher?: typeof fetch,
	) => Promise<Record<string, unknown>>;
};

const sub2apiWallet = { mode: "unrestricted", isValid: true, balance: 12.5, unit: "USD" };
const sub2apiQuotaLimited = {
	mode: "quota_limited",
	isValid: true,
	quota: { remaining: 5, used: 5, limit: 10, unit: "USD" },
	rate_limits: [{ window: "5h", remaining: 1, used: 1, limit: 2 }],
};
const sub2apiSubscription = {
	mode: "unrestricted",
	isValid: true,
	unit: "USD",
	remaining: 10,
	planName: "Pro",
	subscription: {
		expires_at: "2030-01-01T00:00:00Z",
		daily_limit_usd: 10,
		daily_usage_usd: 2,
		weekly_limit_usd: 40,
		weekly_usage_usd: 4,
		weekly_window_start: "2029-12-25T00:00:00Z",
	},
};
const newApiUsage = {
	code: true,
	data: {
		object: "token_usage",
		unlimited_quota: false,
		total_available: 500000,
		total_used: 100000,
		total_granted: 600000,
	},
};
const newApiStatus = {
	success: true,
	data: { quota_per_unit: 500000, quota_display_type: "USD" },
};

describe("apikey-quota plugin manifest", () => {
	test("parses and declares the quota tool with the host-directory contract", async () => {
		const raw = JSON.parse(await readFile(join(pluginRoot, "manifest.json"), "utf8"));
		const manifest = parseManifest(raw);

		expect(manifest.pluginId).toBe("com.narrafork.apikey-quota");
		expect(manifest.server?.entry).toBe("server/index.js");
		expect(manifest.contributes.tools.map((tool) => tool.id)).toEqual(["query-balance"]);
		// The host calls this tool from a background context, so the flag is required.
		expect(manifest.contributes.tools[0]?.allowBackground).toBe(true);
		// `provider.use` is the registry's default authorization capability for tools.
		expect(manifest.permissions.host).toContain("provider.use");
	});

	/**
	 * The former home of this package was `examples/plugins/`, where
	 * `tests/server/lib/plugins/manifest-permission-parity.test.ts` scanned it automatically.
	 * Now that it ships inside the host tree, that scan no longer reaches it — these are the
	 * same rules, asserted directly, so moving the package did not quietly drop the coverage.
	 */
	test("keeps the reference-manifest rules the example-plugin scan used to enforce", async () => {
		const raw = (await readFile(join(pluginRoot, "manifest.json"), "utf8")) as string;
		const parsed = JSON.parse(raw) as {
			engine: { rpc: string; features?: string[] };
			server?: { protocol: string };
			permissions: { host: string[] };
		};
		const manifest = parseManifest(parsed);

		expect(parsed.engine.rpc).toBe(NARRAFORK_RPC_PROTOCOL);
		expect(parsed.server?.protocol ?? NARRAFORK_RPC_PROTOCOL).toBe(NARRAFORK_RPC_PROTOCOL);
		expect(parsed.permissions.host.every(isCanonicalPermissionName)).toBe(true);
		expect(
			(parsed.engine.features ?? []).every((feature) =>
				(PLUGIN_TO_HOST_FEATURES as readonly string[]).includes(feature),
			),
		).toBe(true);
		expect([...manifest.permissions.host]).toEqual(parsed.permissions.host);
	});

	/** A bundled plugin still must not call a host method it did not declare. */
	test("calls no host method it has not declared a capability for", async () => {
		const source = await readFile(join(pluginRoot, "server/index.js"), "utf8");
		const declared = new Set(
			(
				JSON.parse(await readFile(join(pluginRoot, "manifest.json"), "utf8")) as {
					permissions: { host: string[] };
				}
			).permissions.host,
		);
		const METHOD_CAPABILITIES: Record<string, string> = {
			"secrets.get": "secret.use_self",
			"secrets.set": "secret.use_self",
			"storage.get": "storage.read_self",
			"storage.set": "storage.write_self",
			"config.get": "config.read_self",
			"diagnostics.getOwn": "diagnostics.readOwnLogs",
		};
		for (const [method, capability] of Object.entries(METHOD_CAPABILITIES)) {
			if (!new RegExp(`["'\`]${method.replace(".", "\\.")}["'\`]`).test(source)) continue;
			expect(declared.has(capability)).toBe(true);
		}
	});
});

describe("apikey-quota plugin parsing parity with the bundled adapters", () => {
	for (const [name, body] of Object.entries({
		sub2apiWallet,
		sub2apiQuotaLimited,
		sub2apiSubscription,
	})) {
		test(`sub2api: ${name}`, () => {
			expect(plugin.parseSub2ApiBalance(body)).toEqual(parseSub2ApiBalance(body));
		});
	}

	test("sub2api: rejects malformed payloads the same way", () => {
		for (const body of [
			null,
			{},
			{ isValid: "yes" },
			{ isValid: true, mode: "quota_limited" },
			{ isValid: true, mode: "unrestricted", unit: "EUR", balance: 1 },
			{ isValid: true, success: false },
		]) {
			expect(plugin.parseSub2ApiBalance(body)).toEqual(parseSub2ApiBalance(body));
		}
	});

	test("new-api: converts quota into the displayed currency the same way", () => {
		expect(plugin.parseNewApiBalance(newApiUsage, newApiStatus)).toEqual(
			parseNewApiBalance(newApiUsage, newApiStatus),
		);
	});

	test("new-api: falls back to raw quota units without status metadata", () => {
		expect(plugin.parseNewApiBalance(newApiUsage)).toEqual(parseNewApiBalance(newApiUsage));
	});

	test("balance roots are derived identically", () => {
		for (const baseUrl of [
			"https://relay.example.com/v1",
			"https://relay.example.com/v1beta",
			"https://relay.example.com/anthropic",
			"https://relay.example.com",
			"https://relay.example.com/api/",
		]) {
			expect(plugin.buildBalanceRoots(baseUrl)).toEqual(buildBalanceRoots(baseUrl));
		}
	});
});

describe("apikey-quota plugin probe over real HTTP", () => {
	let server: ReturnType<typeof Bun.serve>;
	const requests: Array<{ path: string; authorization: string | null }> = [];

	beforeAll(() => {
		server = Bun.serve({
			port: 0,
			fetch: async (request) => {
				const url = new URL(request.url);
				requests.push({
					path: url.pathname,
					authorization: request.headers.get("authorization"),
				});
				if (url.pathname === "/v1/usage") {
					return Response.json({ mode: "unrestricted", isValid: true, balance: 7, unit: "USD" });
				}
				return new Response("not found", { status: 404 });
			},
		});
	});

	afterAll(() => {
		server.stop(true);
	});

	test("discovers the sub2api wallet endpoint and sends the key", async () => {
		requests.length = 0;
		const found = await plugin.probeProviderBalance(
			{ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "sk-live" },
			AbortSignal.timeout(5_000),
		);

		expect(found?.adapter).toBe("sub2api");
		expect(found?.balance).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 7 }],
		});
		expect(requests.some((entry) => entry.path === "/v1/usage")).toBe(true);
		expect(requests.every((entry) => entry.authorization === "Bearer sk-live")).toBe(true);
	});

	test("reports 'no endpoint' for an origin that serves nothing usable", async () => {
		const notFound = (async () => new Response("nope", { status: 404 })) as unknown as typeof fetch;
		const found = await plugin.probeProviderBalance(
			{ baseUrl: `http://127.0.0.1:${server.port}/v1`, apiKey: "sk-live" },
			AbortSignal.timeout(5_000),
			notFound,
		);
		expect(found).toBeNull();
	});

	test("refuses to refresh a root outside the configured origin", async () => {
		let reached = false;
		// The transport pins every request to the provider's own origin; a persisted root
		// from a different host must be rejected before any I/O happens.
		const error = await plugin
			.refreshProviderBalance(
				{
					baseUrl: `http://127.0.0.1:${server.port}/v1`,
					apiKey: "sk-live",
					adapter: "sub2api",
					root: "http://127.0.0.1:1",
				},
				AbortSignal.timeout(5_000),
				(async () => {
					reached = true;
					return Response.json({});
				}) as unknown as typeof fetch,
			)
			.catch((e) => e);

		expect(error).toBeInstanceOf(Error);
		expect((error as Error).name).toBe("ProbeRequestError");
		expect(reached).toBe(false);
	});
});

/**
 * Site-account credit (`/api/user/self`).
 *
 * The plugin is a separate process that cannot share host code, so these cases prove the
 * plugin's own copy of the rules answers identically to the bundled adapters — the same
 * negotiation the rest of this file performs for the key-usage endpoints.
 */
describe("apikey-quota plugin site-account credit", () => {
	const siteBody = { success: true, data: { quota: 2_500_000, used_quota: 500_000, group: "pro" } };
	const siteInput = {
		baseUrl: "https://site.test/v1",
		apiKey: "sk-live",
		siteUrl: "https://site.test",
		accessToken: "site-token",
		userId: "42",
	};

	test("parses the account credit to USD exactly like the host adapter", () => {
		expect(plugin.parseNewApiUserQuota(siteBody)).toEqual(parseNewApiUserQuota(siteBody));
		expect(plugin.parseNewApiUserQuota(siteBody)).toEqual({
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: 5, used: 1, total: 6 }],
			planName: "pro",
		});
	});

	test("accepts numeric strings like the host adapter", () => {
		const body = { success: true, data: { quota: "2500000", used_quota: "500000" } };
		expect(plugin.parseNewApiUserQuota(body)).toEqual(parseNewApiUserQuota(body));
	});

	test("rejects the same non-answers as the host adapter", () => {
		for (const body of [
			{ success: false, data: { quota: 1, used_quota: 0 } },
			{ success: true },
			{ success: true, data: { quota: 1 } },
			{ success: true, data: { quota: -2, used_quota: 0 } },
		]) {
			expect(plugin.parseNewApiUserQuota(body)).toBeNull();
			expect(parseNewApiUserQuota(body)).toBeNull();
		}
	});

	test("resolves the site root away from the /v1 inference base URL", () => {
		expect(plugin.hasSiteQuotaConfig({})).toBe(false);
		expect(plugin.hasSiteQuotaConfig(siteInput)).toBe(true);
		expect(plugin.resolveSiteQuotaConfig(siteInput)).toEqual({
			root: "https://site.test",
			accessToken: "site-token",
			userId: "42",
		});
		// No site root configured: derived from the base URL, with /v1 stripped.
		expect(plugin.resolveSiteQuotaConfig({ ...siteInput, siteUrl: undefined })).toMatchObject({
			root: "https://site.test",
		});
		expect(() => plugin.resolveSiteQuotaConfig({ ...siteInput, userId: "" })).toThrow(
			expect.objectContaining({ kind: "invalid_configuration" }),
		);
	});

	test("sends the site token, the New-Api-User header and the site path", async () => {
		let url = "";
		let headers = new Headers();
		const found = await plugin.probeSiteQuota(siteInput, AbortSignal.timeout(5_000), (async (
			input: RequestInfo | URL,
			init?: RequestInit,
		) => {
			url = String(input);
			headers = new Headers(init?.headers);
			return Response.json(siteBody);
		}) as unknown as typeof fetch);

		expect(url).toBe("https://site.test/api/user/self");
		expect(headers.get("authorization")).toBe("Bearer site-token");
		expect(headers.get("new-api-user")).toBe("42");
		expect([...headers.values()]).not.toContain("Bearer sk-live");
		expect(found.adapter).toBe("new-api-user");
		expect(found.root).toBe("https://site.test");
	});

	test("classifies a rejected token as a deterministic auth failure", async () => {
		const error = await plugin
			.probeSiteQuota(
				siteInput,
				AbortSignal.timeout(5_000),
				(async () => new Response(null, { status: 401 })) as unknown as typeof fetch,
			)
			.catch((e) => e);
		expect(error).toMatchObject({ name: "ProbeRequestError", kind: "auth" });
	});

	test("keeps 5xx transient and other 4xx deterministic, like the host transport", async () => {
		for (const [status, kind] of [
			[503, "transient"],
			[429, "transient"],
			[404, "invalid_response"],
		] as const) {
			const error = await plugin
				.probeSiteQuota(
					siteInput,
					AbortSignal.timeout(5_000),
					(async () => new Response(null, { status })) as unknown as typeof fetch,
				)
				.catch((e) => e);
			expect(error).toMatchObject({ kind });
		}
	});
});
