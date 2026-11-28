import { describe, expect, spyOn, test } from "bun:test";
import {
	providerQuotaDataSchema,
	providerQuotaSourceSchema,
	quotaQueryParamsSchema,
	quotaQueryResultSchema,
} from "../../../shared/provider-quota";
import manifest from "../manifest.json";
import { deepSeekQuotaData, parseDeepSeekBalanceResponse } from "../src/deepseek";
import {
	type ConnectionRequest,
	type ConnectionResponse,
	type HostRequest,
	type QuotaQueryParams,
	queryParamsSchema,
	queryResultSchema,
	quotaDataSchema,
} from "../src/protocol";
import { parseRelayCursor, queryQuota } from "../src/query";
import { RELAY_METADATA_RETURN_BUDGET_MS } from "../src/request";

const json = (body: unknown, status = 200): ConnectionResponse => {
	const text = JSON.stringify(body);
	return {
		status,
		contentType: "application/json",
		body: text,
		bytes: new TextEncoder().encode(text).byteLength,
	};
};
const params = (source = "relay", baseUrl = "https://relay.example/site/v1"): QuotaQueryParams => ({
	protocolVersion: "1.0",
	contributionId: source,
	target: {
		kind: "custom-api",
		id: "custom-api/test-provider",
		providerId: "test-provider",
		generation: "opaque-generation",
		baseUrl,
	},
	mode: "probe",
	reference: "opaque-connection-reference",
	deadlineAt: Date.now() + 10_000,
});
const token = {
	code: true,
	data: {
		object: "token_usage",
		total_available: 500_000,
		total_used: 250_000,
		total_granted: 750_000,
		unlimited_quota: false,
	},
};
const deepseek = {
	is_available: true,
	balance_infos: [
		{
			currency: "USD",
			total_balance: "0.0000000100",
			granted_balance: "0.0000000001",
			topped_up_balance: "12.5000",
		},
	],
};

describe("independent quota contributions", () => {
	test("manifest binds four bounded sources to explicitly granted provider settings", () => {
		expect(manifest.pluginId).toBe("io.narrafork.provider-quota");
		expect(manifest.engine.hostApi).toBe(">=1.0 <2");
		expect(manifest.permissions.host).toEqual([
			"quota.provide",
			"provider.connection.request",
			"provider.settings.read_self",
			"provider.settings.connection.use",
		]);
		expect(manifest.engine.features).toContain("host_api.provider_settings");
		expect(manifest.contributes.providerSettings[0]?.id).toBe("site-account");
		expect(manifest.contributes.quotaSources.map((source) => source.id)).toEqual([
			"relay",
			"deepseek",
			"kimi",
			"opencode",
		]);
		for (const source of manifest.contributes.quotaSources) {
			expect(providerQuotaSourceSchema.safeParse(source).success).toBe(true);
			for (const request of source.requests) expect(request.headers).toContain("accept");
		}
		expect(manifest.contributes.quotaSources[0]?.match.fallback).toBe(true);
		expect(
			manifest.contributes.quotaSources[3]?.requests.every(
				(request) => request.auth === "bearer-and-api-key",
			),
		).toBe(true);
	});
	test("relay probes bounded candidate paths then preserves raw QUOTA when public metadata fails", async () => {
		const calls: ConnectionRequest[] = [];
		const host: HostRequest = async (request) => {
			calls.push(request);
			return request.path === "/site/api/usage/token/"
				? json(token)
				: json({ error: "not-found" }, 404);
		};
		const result = await queryQuota(params(), host);
		expect(result).toMatchObject({
			status: "supported",
			error: null,
			data: {
				format: "new-api",
				scope: "key",
				unlimited: false,
				amounts: [
					{ id: "amount:0", unit: "QUOTA", remaining: 500_000, used: 250_000, total: 750_000 },
				],
				windows: [],
			},
		});
		expect(calls.map((request) => request.path)).toEqual([
			"/site/v1/usage",
			"/site/api/usage/token/",
			"/site/api/status",
		]);
		expect(parseRelayCursor(result.cursor ?? "", params().target.baseUrl)).toEqual({
			adapter: "new-api",
			root: "https://relay.example/site",
		});
		for (const request of calls) {
			expect(request.reference).toBe("opaque-connection-reference");
			expect(request.method).toBe("GET");
			expect(request.path.startsWith("/")).toBe(true);
			expect(request.headers).toEqual({ accept: "application/json" });
			expect(JSON.stringify(request)).not.toMatch(/apiKey|Authorization|https:/);
		}
		expect(quotaQueryResultSchema.safeParse(result).success).toBe(true);
	});
	test.each([
		"probe",
		"refresh",
	] as const)("new-api %s skips optional metadata when only the return budget remains", async (mode) => {
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const query = {
			...params(),
			mode,
			deadlineAt: now + 10_000,
			...(mode === "refresh"
				? { cursor: JSON.stringify({ adapter: "new-api", root: "https://relay.example/site" }) }
				: {}),
		};
		const calls: string[] = [];
		try {
			const result = await queryQuota(query, async (request) => {
				calls.push(request.path);
				if (request.path.endsWith("/v1/usage")) return json({}, 404);
				if (request.path.endsWith("/api/usage/token/")) {
					now = query.deadlineAt - RELAY_METADATA_RETURN_BUDGET_MS;
					return json(token);
				}
				throw new Error("Optional metadata must be skipped");
			});
			expect(calls).toEqual(
				mode === "probe"
					? ["/site/v1/usage", "/site/api/usage/token/"]
					: ["/site/api/usage/token/"],
			);
			expect(result).toMatchObject({
				status: "supported",
				error: null,
				data: {
					format: "new-api",
					amounts: [
						{ id: "amount:0", unit: "QUOTA", remaining: 500_000, used: 250_000, total: 750_000 },
					],
				},
			});
			expect(query.deadlineAt - Date.now()).toBe(RELAY_METADATA_RETURN_BUDGET_MS);
		} finally {
			clock.mockRestore();
		}
	});
	test.each([
		"probe",
		"refresh",
	] as const)("new-api %s stops hung metadata before the query deadline and keeps raw QUOTA", async (mode) => {
		let now = Date.now();
		const clock = spyOn(Date, "now").mockImplementation(() => now);
		const query = {
			...params(),
			mode,
			deadlineAt: now + 10_000,
			...(mode === "refresh"
				? { cursor: JSON.stringify({ adapter: "new-api", root: "https://relay.example/site" }) }
				: {}),
		};
		const calls: string[] = [];
		let metadataSignal: AbortSignal | undefined;
		let release: ((response: ConnectionResponse) => void) | undefined;
		try {
			const result = await queryQuota(query, async (request, signal) => {
				calls.push(request.path);
				if (request.path.endsWith("/v1/usage")) return json({}, 404);
				if (request.path.endsWith("/api/usage/token/")) {
					// A controlled clock leaves 20ms for metadata, not the production 8s timeout.
					now = query.deadlineAt - RELAY_METADATA_RETURN_BUDGET_MS - 20;
					return json(token);
				}
				metadataSignal = signal;
				signal.addEventListener(
					"abort",
					() => {
						now = query.deadlineAt - RELAY_METADATA_RETURN_BUDGET_MS;
					},
					{ once: true },
				);
				return new Promise((resolve) => {
					release = resolve;
				});
			});
			expect(calls).toEqual(
				mode === "probe"
					? ["/site/v1/usage", "/site/api/usage/token/", "/site/api/status"]
					: ["/site/api/usage/token/", "/site/api/status"],
			);
			expect(metadataSignal?.aborted).toBe(true);
			expect(result).toMatchObject({
				status: "supported",
				error: null,
				data: {
					format: "new-api",
					amounts: [
						{ id: "amount:0", unit: "QUOTA", remaining: 500_000, used: 250_000, total: 750_000 },
					],
				},
			});
			expect(query.deadlineAt - Date.now()).toBe(RELAY_METADATA_RETURN_BUDGET_MS);
			release?.(
				json({ success: true, data: { quota_per_unit: 500_000, quota_display_type: "USD" } }),
			);
			await Promise.resolve();
			expect(result.data?.amounts[0]?.unit).toBe("QUOTA");
		} finally {
			clock.mockRestore();
		}
	});
	test("confirmed relay refresh does not probe unrelated candidates", async () => {
		const calls: string[] = [];
		const result = await queryQuota(
			{
				...params(),
				mode: "refresh",
				cursor: JSON.stringify({ adapter: "sub2api", root: "https://relay.example/site" }),
			},
			async (request) => {
				calls.push(request.path);
				return json({ mode: "unrestricted", isValid: true, unit: "USD", balance: -1 });
			},
		);
		expect(calls).toEqual(["/site/v1/usage"]);
		expect(result.data?.amounts).toEqual([{ id: "amount:0", unit: "USD", remaining: -1 }]);
		expect(result.data?.unlimited).toBe(false);
	});
	test.each([
		"probe",
		"refresh",
	] as const)("Sub2API %s emits subscription windows and a real expiry without inventing resets", async (mode) => {
		const calls: ConnectionRequest[] = [];
		const result = await queryQuota(
			{
				...params(),
				mode,
				...(mode === "refresh"
					? { cursor: JSON.stringify({ adapter: "sub2api", root: "https://relay.example/site" }) }
					: {}),
			},
			async (request) => {
				calls.push(request);
				return json({
					mode: "unrestricted",
					isValid: true,
					unit: "USD",
					planName: "  Team plan  ",
					subscription: {
						daily_limit_usd: 10,
						daily_usage_usd: 2.5,
						weekly_limit_usd: 50,
						weekly_usage_usd: 10,
						monthly_limit_usd: 100,
						monthly_usage_usd: 30,
						weekly_window_start: "2026-11-09T12:30:00+08:00",
						expires_at: "2027-01-01T12:30:00.123456789+08:00",
					},
				});
			},
		);
		expect(calls.map((request) => request.path)).toEqual(["/site/v1/usage"]);
		expect(result.status).toBe("supported");
		expect(result.data).toMatchObject({
			format: "sub2api",
			scope: "subscription",
			unlimited: false,
			planName: "Team plan",
			expiresAt: "2027-01-01T04:30:00.123Z",
			windows: [
				{ id: "daily", unit: "USD", used: 2.5, limit: 10, remaining: 7.5, resetAt: null },
				{ id: "weekly", unit: "USD", used: 10, limit: 50, remaining: 40, resetAt: null },
				{ id: "monthly", unit: "USD", used: 30, limit: 100, remaining: 70, resetAt: null },
			],
		});
		expect(result.data?.amounts[1]).toMatchObject({
			id: "amount:1",
			display: "detail",
			quota: "none",
			window: "weekly",
			windowStart: "2026-11-09T04:30:00.000Z",
			remaining: 40,
			used: 10,
			total: 50,
		});
		expect(result.data?.windows.every((window) => window.resetAt === null)).toBe(true);
		expect(result.data?.windows[2]).not.toHaveProperty("durationMs");
		expect(quotaQueryResultSchema.safeParse(result).success).toBe(true);
		expect(queryResultSchema.safeParse(result).success).toBe(true);
	});

	test("Sub2API rate windows do not replace the key's required amount", async () => {
		const result = await queryQuota(params(), async () =>
			json({
				mode: "quota_limited",
				isValid: true,
				quota: { unit: "USD", limit: 0, used: 0, remaining: 0 },
				rate_limits: [{ window: "5h", limit: 5, used: 1, remaining: 4 }],
			}),
		);
		expect(result.data?.amounts[0]).toEqual({
			id: "amount:0",
			unit: "USD",
			total: 0,
			used: 0,
			remaining: 0,
		});
		expect(result.data?.amounts[1]).toMatchObject({
			display: "detail",
			quota: "none",
			window: "5h",
		});
		expect(result.data?.windows).toMatchObject([
			{ id: "5h", used: 1, limit: 5, remaining: 4, resetAt: null, durationMs: 18_000_000 },
		]);
	});

	test.each([
		undefined,
		null,
		"2027-01-01",
		"next month",
		1_800_000_000_000,
	])("Sub2API does not fabricate an expiry from %s or a weekly start", async (expiresAt) => {
		const result = await queryQuota(params(), async () =>
			json({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Plan",
				subscription: {
					weekly_limit_usd: 50,
					weekly_usage_usd: 5,
					weekly_window_start: "2026-11-09T00:00:00Z",
					...(expiresAt === undefined ? {} : { expires_at: expiresAt }),
				},
			}),
		);
		expect(result.status).toBe("supported");
		expect(result.data).not.toHaveProperty("expiresAt");
		expect(result.data?.windows[0]?.resetAt).toBeNull();
	});

	test.each([
		false,
		true,
	])("Sub2API zero subscription limits are not fake spent windows (unlimited=%s)", async (unlimited) => {
		const result = await queryQuota(params(), async () =>
			json({
				mode: "unrestricted",
				isValid: true,
				unit: "USD",
				planName: "Plan",
				...(unlimited ? { remaining: -1 } : {}),
				subscription: { daily_limit_usd: 0, daily_usage_usd: 0 },
			}),
		);
		expect(result.status).toBe("supported");
		expect(result.data?.unlimited).toBe(unlimited);
		expect(result.data?.windows).toEqual([]);
		// A zero subscription limit means no configured cap, not an exhausted allowance.
		expect(result.data?.amounts).toEqual([]);
	});

	test("cursor cannot replace the configured origin or candidate root", async () => {
		let calls = 0;
		const result = await queryQuota(
			{
				...params(),
				mode: "refresh",
				cursor: JSON.stringify({ adapter: "sub2api", root: "https://evil.example" }),
			},
			async () => {
				calls++;
				return json({});
			},
		);
		expect(result).toEqual({ status: "error", data: null, error: "invalid_configuration" });
		expect(calls).toBe(0);
	});
	test("new-api conversion uses optional metadata without changing scope", async () => {
		const result = await queryQuota(params(), async (request) =>
			request.path.endsWith("/v1/usage")
				? json({}, 404)
				: request.path.endsWith("/api/status")
					? json({
							success: true,
							data: { quota_per_unit: 500_000, quota_display_type: "CNY", usd_exchange_rate: 7.2 },
						})
					: json(token),
		);
		expect(result.data?.amounts[0]).toMatchObject({
			unit: "CNY",
			remaining: 7.2,
			used: 3.6,
			total: 10.8,
		});
	});
	test("DeepSeek preserves decimal spelling for all currency amount details", async () => {
		const calls: string[] = [];
		const result = await queryQuota(
			params("deepseek", "https://api.deepseek.com/anthropic"),
			async (request) => {
				calls.push(request.path);
				return json(deepseek);
			},
		);
		expect(calls).toEqual(["/user/balance"]);
		expect(result.data).toEqual({
			scope: "wallet",
			amounts: [
				{
					id: "balance:USD",
					label: "Total balance",
					display: "summary",
					quota: "alternative",
					unit: "USD",
					remaining: 0.00000001,
					remainingText: "0.0000000100",
				},
				{
					id: "granted:USD",
					label: "Granted balance",
					display: "detail",
					quota: "none",
					unit: "USD",
					remaining: 0.0000000001,
					remainingText: "0.0000000001",
				},
				{
					id: "topped-up:USD",
					label: "Topped-up balance",
					display: "detail",
					quota: "none",
					unit: "USD",
					remaining: 12.5,
					remainingText: "12.5000",
				},
			],
			windows: [],
			available: true,
		});
		expect(result.data).not.toHaveProperty("details");
		expect(parseDeepSeekBalanceResponse(deepseek).balanceInfos[0]?.totalBalance).toBe(
			"0.0000000100",
		);
		expect(quotaQueryResultSchema.safeParse(result).success).toBe(true);
	});
	test("DeepSeek does not invent amounts for empty but explicitly available payload", async () => {
		const result = await queryQuota(params("deepseek", "https://api.deepseek.com"), async () =>
			json({ is_available: false, balance_infos: [] }),
		);
		expect(result.data).toEqual({ scope: "wallet", amounts: [], windows: [], available: false });
	});
	test("unsafe or oversized DeepSeek decimal amounts cannot become a snapshot", () => {
		expect(
			deepSeekQuotaData({
				isAvailable: true,
				balanceInfos: [
					{
						currency: "USD",
						totalBalance: "9".repeat(65),
						grantedBalance: "0",
						toppedUpBalance: "0",
					},
				],
			}),
		).toBeNull();
		expect(
			deepSeekQuotaData({
				isAvailable: true,
				balanceInfos: [
					{
						currency: "USD",
						totalBalance: "9007199254740992",
						grantedBalance: "0",
						toppedUpBalance: "0",
					},
				],
			}),
		).toBeNull();
	});
	test("duplicate currencies and non-decimal DeepSeek text never become quota snapshots", () => {
		const info = {
			currency: "USD",
			totalBalance: "1.00",
			grantedBalance: "0",
			toppedUpBalance: "1.00",
		};
		expect(deepSeekQuotaData({ isAvailable: true, balanceInfos: [info, info] })).toBeNull();
		for (const totalBalance of ["1e0", "", " ", "Infinity", "1.0<script>"]) {
			expect(
				deepSeekQuotaData({ isAvailable: true, balanceInfos: [{ ...info, totalBalance }] }),
			).toBeNull();
		}
	});

	test("Kimi keeps unknown amounts null, real windows and its required CLI User-Agent", async () => {
		let request: ConnectionRequest | undefined;
		const result = await queryQuota(
			params("kimi", "https://api.kimi.com/coding"),
			async (value) => {
				request = value;
				return json({
					usage: { used: 12, resetTime: "2026-10-20T12:00:00+08:00" },
					limits: [
						{ window: { duration: 5, timeUnit: "TIME_UNIT_HOUR" }, detail: { remaining: 0 } },
						{ window: { duration: 1, timeUnit: "TIME_UNIT_DAY" }, detail: { used: 1, limit: 10 } },
					],
				});
			},
		);
		expect(request?.path).toBe("/coding/v1/usages");
		expect(request?.headers).toEqual({ accept: "application/json", "user-agent": "KimiCLI/1.6" });
		expect(result.data?.windows).toEqual([
			{
				id: "fiveHour",
				used: null,
				limit: null,
				remaining: 0,
				resetAt: null,
				durationMs: 18_000_000,
			},
			{
				id: "weekly",
				used: 12,
				limit: null,
				remaining: null,
				resetAt: "2026-10-20T04:00:00.000Z",
				durationMs: 604_800_000,
			},
			{ id: "extra:0", label: "1d", used: 1, limit: 10, remaining: null, resetAt: null },
		]);
		expect(result.data).not.toHaveProperty("unlimited");
	});
	test("OpenCode per-family roots map to account usage without fabricating amounts from percent", async () => {
		const calls: string[] = [];
		const result = await queryQuota(
			params("opencode", "https://opencode.ai/inference/go/anthropic/v1"),
			async (request) => {
				calls.push(request.path);
				return json({
					usage: {
						rolling: { percent: 33, status: "ok", resetsAt: "2026-10-20T04:00:00Z" },
						weekly: { used: 12, limit: 10 },
					},
					balance: "1.50",
				});
			},
		);
		expect(calls).toEqual(["/inference/go/v1/usage"]);
		expect(result.data?.windows[0]).toMatchObject({
			id: "rolling",
			used: null,
			limit: null,
			remaining: null,
			usedPercent: 33,
		});
		expect(result.data?.windows[1]).toMatchObject({
			id: "weekly",
			used: 12,
			limit: 10,
			remaining: -2,
			usedPercent: 100,
		});
		expect(result.data?.scope).toBe("subscription");
		expect(result.data?.amounts).toEqual([
			{ id: "balance:USD", unit: "USD", remaining: 1.5, quota: "none" },
		]);
	});
	test.each([
		"deepseek",
		"kimi",
		"opencode",
	])("explicit %s source does not send credentials to an unrelated host", async (source) => {
		let calls = 0;
		expect(
			await queryQuota(params(source, "https://evil.example"), async () => {
				calls++;
				return json({});
			}),
		).toEqual({ status: "unsupported", data: null, error: null });
		expect(calls).toBe(0);
	});
	test.each([
		{},
		{ usage: {} },
		{ data: [] },
		{ unknown: 0 },
	])("unknown Kimi payload is not a successful zero/unlimited quota", async (body) => {
		expect(
			await queryQuota(params("kimi", "https://api.kimi.com"), async () => json(body)),
		).toEqual({ status: "unsupported", data: null, error: null });
	});
	test("unknown OpenCode windows are unsupported, not a fabricated supported snapshot", async () => {
		expect(
			await queryQuota(params("opencode", "https://opencode.ai/zen/go/v1"), async () =>
				json({ usage: { renamed: { percent: 20 } } }),
			),
		).toEqual({ status: "unsupported", data: null, error: null });
	});
	test("snapshot schema rejects stale data on error and mismatching decimal spelling", () => {
		const data = {
			amounts: [{ id: "balance:USD", unit: "USD", remaining: 1, remainingText: "2.00" }],
			windows: [],
		};
		expect(queryResultSchema.safeParse({ status: "supported", data, error: null }).success).toBe(
			false,
		);
		expect(
			queryResultSchema.safeParse({
				status: "error",
				data: { amounts: [], windows: [] },
				error: "request_failed",
			}).success,
		).toBe(false);
	});
	test("host and independent plugin schemas accept legacy data and preserve every optional amount semantic", () => {
		for (const display of [undefined, "summary", "detail"] as const) {
			for (const quota of [undefined, "required", "alternative", "none"] as const) {
				const data = {
					amounts: [
						{
							id: "credit",
							unit: "EUR",
							remaining: 0.000000001,
							remainingText: "0.0000000010",
							used: null,
							total: 0,
							...(display === undefined ? {} : { display }),
							...(quota === undefined ? {} : { quota }),
						},
					],
					windows: [{ id: "zero", used: 0, limit: 0, remaining: 0, resetAt: null }],
				};
				expect(providerQuotaDataSchema.parse(data)).toEqual(data);
				expect(quotaDataSchema.parse(data)).toEqual(data);
				const wire = { status: "supported", data, error: null };
				expect(quotaQueryResultSchema.parse(wire)).toEqual(queryResultSchema.parse(wire));
			}
		}
	});

	test("both wire schemas reject invalid optional semantics and never strip unknown or credential fields", () => {
		const amount = { id: "credit", unit: "USD", remaining: 1, remainingText: "1.00" };
		for (const invalid of [
			{ ...amount, display: "hidden" },
			{ ...amount, display: null },
			{ ...amount, quota: "optional" },
			{ ...amount, quota: false },
			{ ...amount, quota: null },
			{ ...amount, summary: true },
			{ ...amount, quota: "alternative", quotaPool: "unrecognized-group" },
			{ ...amount, apiKey: "private-key" },
			{ ...amount, remaining: null },
			{ ...amount, remaining: Number.POSITIVE_INFINITY },
			{ ...amount, remainingText: "2.00" },
			{ ...amount, remainingText: "1e0" },
			{ ...amount, remainingText: "0".repeat(65) },
		]) {
			const data = { amounts: [invalid], windows: [] };
			expect(providerQuotaDataSchema.safeParse(data).success).toBe(false);
			expect(quotaDataSchema.safeParse(data).success).toBe(false);
			const wire = { status: "supported", data, error: null };
			expect(quotaQueryResultSchema.safeParse(wire).success).toBe(false);
			expect(queryResultSchema.safeParse(wire).success).toBe(false);
		}
	});

	test("host and plugin query target schemas keep the same owner/key validation", () => {
		const input = params();
		for (const [target, expected] of [
			[input.target, true],
			[{ ...input.target, keyId: "inference-key" }, true],
			[{ ...input.target, siteQuota: { root: null } }, true],
			[{ ...input.target, providerId: "owner:alias" }, false],
			[{ ...input.target, keyId: "key:alias" }, false],
			[{ ...input.target, keyId: "" }, false],
		] as const) {
			const wire = { ...input, target };
			expect(quotaQueryParamsSchema.safeParse(wire).success).toBe(expected);
			expect(queryParamsSchema.safeParse(wire).success).toBe(expected);
		}
	});

	test("expired deadline and invalid wire params do no IO and expose fixed errors only", async () => {
		let calls = 0;
		const host: HostRequest = async () => {
			calls++;
			throw new Error("secret-provider-body");
		};
		expect(await queryQuota({ ...params(), deadlineAt: Date.now() - 1 }, host)).toEqual({
			status: "error",
			data: null,
			error: "timeout",
		});
		expect(await queryQuota({ ...params(), apiKey: "not-allowed" }, host)).toEqual({
			status: "error",
			data: null,
			error: "invalid_configuration",
		});
		expect(calls).toBe(0);
	});
	test("parent cancellation settles abort-ignoring IO and discards its late data", async () => {
		const controller = new AbortController();
		let release: ((response: ConnectionResponse) => void) | undefined;
		let entered: (() => void) | undefined;
		const ready = new Promise<void>((resolve) => {
			entered = resolve;
		});
		const running = queryQuota(
			params("deepseek", "https://api.deepseek.com"),
			async () => {
				entered?.();
				return new Promise((resolve) => {
					release = resolve;
				});
			},
			controller.signal,
		);
		await ready;
		controller.abort();
		expect(await running).toEqual({ status: "error", data: null, error: "unavailable" });
		release?.(json(deepseek));
		await Promise.resolve();
	});
});
