import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import type { ApiRequestDiagnostics } from "@shared/agent-protocol/types";
import * as outbound from "../net/outbound-fetch";
import { type CustomApiProviderConfig, settings } from "../settings";

const {
	classifyOpencodeRefusal,
	nextOpencodeWeekStart,
	OPENCODE_QUOTA_MAX_WAIT_MS,
	OPENCODE_QUOTA_RESET_SKEW_MS,
	opencodeBucketNamedByText,
	parseOpencodeResetFromText,
	planOpencodeQuotaTarget,
	planOpencodeRateLimitWait,
	resolveOpencodeQuotaTarget,
	selectOpencodeUsageResetTarget,
} = await import("../opencode-quota-wait");
const { resolveProviderQuotaWait } = await import("../provider-quota-wait");
const { syncOpencodeUsageCache, refreshOpencodeUsage } = await import("../opencode-usage-cache");

// Monday 2026-10-19 12:00 UTC.
const NOW = Date.parse("2026-10-19T12:00:00.000Z");

/** The weekly-wall body observed from the gateway (OpenAI-family envelope). */
const CAPACITY_MESSAGE =
	"Upstream request failed: [prefill_cap_refused] the cell is at capacity; retry shortly (after 30 s)";

const WEEKLY_MESSAGE =
	"Weekly usage limit reached. Resets in 4 days. To continue using this model now, enable usage from your available balance: https://opencode.ai/workspace/wrk_01M/go";

/** Diagnostics with ONLY the given fields, so no default wording leaks into a case. */
function bare(overrides: Partial<ApiRequestDiagnostics>): ApiRequestDiagnostics {
	return { schema: "narrafork.error-diagnostics.v1", source: "provider", ...overrides };
}

function diag(overrides: Partial<ApiRequestDiagnostics> = {}): ApiRequestDiagnostics {
	return {
		schema: "narrafork.error-diagnostics.v1",
		source: "provider",
		phase: "http_error",
		statusCode: 429,
		reason: "GoUsageLimitError",
		errorType: "GoUsageLimitError",
		message: WEEKLY_MESSAGE,
		responseSnippet: WEEKLY_MESSAGE,
		...overrides,
	};
}

describe("classifyOpencodeRefusal", () => {
	test("a GoUsageLimitError is a quota wall on every wire family", () => {
		expect(classifyOpencodeRefusal(`OpenAI API error 429: ${WEEKLY_MESSAGE}`, diag())).toBe(
			"quota",
		);
		expect(
			classifyOpencodeRefusal("Anthropic API error 429: Go usage limit exceeded", {
				...diag(),
				reason: "GoUsageLimitError",
				message: "Go usage limit exceeded",
			}),
		).toBe("quota");
		// Gemini envelope: `{ error: { code: 429, status, message } }`, no typed reason.
		expect(
			classifyOpencodeRefusal("Gemini API error 429: 5-hour usage limit reached", {
				...diag({ reason: undefined, errorType: undefined }),
				message: "5-hour usage limit reached",
			}),
		).toBe("quota");
	});

	test("FreeUsageLimitError and plain throttles are rate limits", () => {
		expect(
			classifyOpencodeRefusal(
				"Rate limit exceeded. Please try again later.",
				bare({
					statusCode: 429,
					reason: "FreeUsageLimitError",
					errorType: "FreeUsageLimitError",
					message: "Rate limit exceeded. Please try again later.",
				}),
			),
		).toBe("rate_limit");
		expect(classifyOpencodeRefusal("Too many requests", bare({ statusCode: 429 }))).toBe(
			"rate_limit",
		);
	});

	test("capacity refusals are neither plan quota nor ordinary throttling", () => {
		expect(
			classifyOpencodeRefusal(CAPACITY_MESSAGE, bare({ statusCode: 429, reason: "server_error" })),
		).toBe("capacity");
		expect(
			classifyOpencodeRefusal(
				"request failed",
				bare({ statusCode: 429, responseSnippet: CAPACITY_MESSAGE }),
			),
		).toBe("capacity");
		// A typed allowance refusal remains authoritative even when prose mentions capacity.
		expect(classifyOpencodeRefusal(CAPACITY_MESSAGE, diag())).toBe("quota");
	});

	test("billing walls are not waited on", () => {
		expect(
			classifyOpencodeRefusal("Credit limit exceeded.", {
				...diag({ statusCode: 402 }),
				reason: "CreditLimitExceeded",
			}),
		).toBeNull();
		expect(
			classifyOpencodeRefusal("Upstream request failed: Insufficient account funds", {
				...diag({ statusCode: 429, reason: "server_error" }),
				message: "Insufficient account funds",
			}),
		).toBeNull();
	});

	test("unrelated errors are not refusals", () => {
		expect(
			classifyOpencodeRefusal(
				"Upstream request failed: Invalid credential",
				bare({ statusCode: 401, reason: "server_error", message: "Invalid credential" }),
			),
		).toBeNull();
		expect(
			classifyOpencodeRefusal(
				"Request is missing x-opencode-session",
				bare({ statusCode: 400, reason: "MissingSessionID" }),
			),
		).toBeNull();
	});
});

describe("reset sources", () => {
	test("names the window the refusal is about", () => {
		expect(opencodeBucketNamedByText(WEEKLY_MESSAGE)).toBe("weekly");
		expect(opencodeBucketNamedByText("Rolling 5-hour usage limit reached")).toBe("fiveHour");
		expect(opencodeBucketNamedByText("Monthly usage limit reached")).toBe("monthly");
	});

	test("parses relative and absolute resets out of the text", () => {
		expect(parseOpencodeResetFromText("Resets in 4 days.", NOW)).toBe(NOW + 4 * 86_400_000);
		expect(parseOpencodeResetFromText("resets in 2h 15m", NOW)).toBe(NOW + 8_100_000);
		expect(parseOpencodeResetFromText("Resets at 2026-10-20T00:00:00Z", NOW)).toBe(
			Date.parse("2026-10-20T00:00:00Z"),
		);
		expect(parseOpencodeResetFromText("usage limit reached", NOW)).toBeNull();
	});

	test("the Go week starts Monday 00:00 UTC", () => {
		expect(nextOpencodeWeekStart(NOW)).toBe(Date.parse("2026-10-26T00:00:00Z"));
		expect(nextOpencodeWeekStart(Date.parse("2026-10-25T23:59:00Z"))).toBe(
			Date.parse("2026-10-26T00:00:00Z"),
		);
	});

	test("usage windows: the latest reset among named and exhausted windows wins", () => {
		const payload = {
			rolling: { status: "rate-limited" as const, percent: 100, resetsAt: "2026-10-19T14:00:00Z" },
			weekly: { status: "rate-limited" as const, percent: 100, resetsAt: "2026-10-26T00:00:00Z" },
			monthly: { status: "ok" as const, percent: 40, resetsAt: "2026-11-15T00:00:00Z" },
		};
		expect(selectOpencodeUsageResetTarget(payload, "usage limit reached", NOW)).toEqual({
			bucket: "weekly",
			resetAt: Date.parse("2026-10-26T00:00:00Z"),
			source: "usage",
		});
		// A healthy window that was not named is ignored.
		expect(
			selectOpencodeUsageResetTarget(
				{ ...payload, rolling: { ...payload.rolling, status: "ok", percent: 10 } },
				"Rolling usage limit reached",
				NOW,
			),
		).toMatchObject({ bucket: "weekly" });
	});

	test("precedence: retry-after, then usage, then the text", () => {
		const cached = {
			rolling: null,
			weekly: { status: "rate-limited" as const, percent: 100, resetsAt: "2026-10-26T00:00:00Z" },
			monthly: null,
		};
		expect(
			planOpencodeQuotaTarget({
				messageText: WEEKLY_MESSAGE,
				headers: { "retry-after": "374160" },
				cached,
				now: NOW,
			}),
		).toEqual({ bucket: "weekly", resetAt: NOW + 374_160_000, source: "retry-after" });
		expect(
			planOpencodeQuotaTarget({ messageText: WEEKLY_MESSAGE, cached, now: NOW }),
		).toMatchObject({ source: "usage" });
		expect(planOpencodeQuotaTarget({ messageText: WEEKLY_MESSAGE, now: NOW })).toEqual({
			bucket: "weekly",
			resetAt: NOW + 4 * 86_400_000,
			source: "message",
		});
	});
});

describe("rate limit waits", () => {
	test("short or absent hints stay with the in-loop retry", () => {
		expect(planOpencodeRateLimitWait(undefined, NOW)).toBeNull();
		expect(planOpencodeRateLimitWait({ "retry-after": "5" }, NOW)).toBeNull();
	});

	test("a long hint parks the turn", () => {
		expect(planOpencodeRateLimitWait({ "retry-after": "120" }, NOW)).toEqual({
			bucket: "rateLimit",
			resetAt: NOW + 120_000,
			source: "retry-after",
			resumeAt: NOW + 120_000 + OPENCODE_QUOTA_RESET_SKEW_MS,
			delayMs: 120_000 + OPENCODE_QUOTA_RESET_SKEW_MS,
		});
	});
});

// --- Resolver against configured providers and a mocked usage endpoint ---

const originalProviders = settings.customApiProviders;
const originalProxy = settings.proxy;
let usageCalls = 0;
let usageBody: unknown = { usage: { rolling: null, weekly: null, monthly: null } };

function provider(overrides: Partial<CustomApiProviderConfig> = {}): CustomApiProviderConfig {
	return {
		id: "ocg",
		name: "OpenCode Go",
		prefix: "ocg",
		protocol: "completions-compatible",
		defaultModel: "glm-5.2",
		baseUrl: "https://opencode.ai/inference/go/openai/v1",
		apiKey: "secret-test-key",
		...overrides,
	};
}

describe("resolveOpencodeQuotaTarget / resolveProviderQuotaWait", () => {
	beforeEach(() => {
		settings.customApiProviders = [];
		syncOpencodeUsageCache();
		settings.customApiProviders = [provider()];
		settings.proxy = { mode: "direct" };
		usageCalls = 0;
		spyOn(outbound, "outboundFetch").mockImplementation(async (input) => {
			usageCalls++;
			// The per-family root has no /usage; it must be read from the Go root.
			expect(String(input)).toBe("https://opencode.ai/inference/go/v1/usage");
			return Response.json(usageBody);
		});
	});
	afterEach(() => mock.restore());
	afterAll(() => {
		settings.customApiProviders = originalProviders;
		settings.proxy = originalProxy;
		syncOpencodeUsageCache();
	});

	test("retry-after resolves the wait without a usage request", async () => {
		const target = await resolveOpencodeQuotaTarget(
			"ocg",
			WEEKLY_MESSAGE,
			diag({ responseHeaders: { "retry-after": "3600" } }),
			NOW,
		);
		expect(target).toMatchObject({ bucket: "weekly", resetAt: NOW + 3_600_000 });
		expect(usageCalls).toBe(0);
	});

	test.each([
		["capacity", CAPACITY_MESSAGE, "capacity"],
		["rate_limit", "Too many requests", "rateLimit"],
	] as const)("%s honors the 30-second Retry-After without fetching usage", async (waitKind, message, bucket) => {
		usageBody = {
			usage: {
				rolling: { status: "ok", percent: 2 },
				weekly: { status: "ok", percent: 3 },
				monthly: { status: "ok", percent: 4 },
			},
		};
		const healthy = await refreshOpencodeUsage("ocg");
		expect([healthy?.rolling?.status, healthy?.weekly?.status, healthy?.monthly?.status]).toEqual([
			"ok",
			"ok",
			"ok",
		]);
		usageCalls = 0;
		const decision = await resolveProviderQuotaWait(
			"ocg",
			message,
			bare({
				statusCode: 429,
				reason: "server_error",
				responseHeaders: { "retry-after": "30", "retry-after-ms": "30000" },
			}),
			NOW,
		);
		expect(decision).toMatchObject({
			kind: "wait",
			wait: {
				waitKind,
				bucket,
				resetAt: NOW + 30_000,
				resumeAt: NOW + 35_000,
			},
		});
		expect(usageCalls).toBe(0);
		const far = await resolveProviderQuotaWait(
			"ocg",
			message,
			bare({
				statusCode: 429,
				responseHeaders: { "retry-after": String(OPENCODE_QUOTA_MAX_WAIT_MS / 1000 + 1) },
			}),
			NOW,
		);
		expect(far).toMatchObject({ kind: "refuse", refusal: { waitKind, bucket } });
		expect(far).not.toHaveProperty("wait");
		expect(usageCalls).toBe(0);
	});

	test("capacity with short or absent hints stays in transient retry without fetching usage", async () => {
		for (const responseHeaders of [undefined, { "retry-after": "5" }]) {
			expect(
				await resolveProviderQuotaWait(
					"ocg",
					CAPACITY_MESSAGE,
					bare({ statusCode: 429, responseHeaders }),
					NOW,
				),
			).toEqual({ kind: "none" });
		}
		expect(usageCalls).toBe(0);
	});

	test("falls back to one usage refresh when the free sources are silent", async () => {
		usageBody = {
			usage: {
				rolling: { status: "rate-limited", percent: 100, resetsAt: "2026-10-19T15:00:00.000Z" },
				weekly: { status: "ok", percent: 30, resetsAt: "2026-10-26T00:00:00.000Z" },
				monthly: null,
			},
		};
		const target = await resolveOpencodeQuotaTarget(
			"ocg",
			"Go usage limit exceeded",
			diag({ message: "Go usage limit exceeded", responseSnippet: "Go usage limit exceeded" }),
			NOW,
		);
		expect(target).toMatchObject({
			bucket: "fiveHour",
			resetAt: Date.parse("2026-10-19T15:00:00.000Z"),
			source: "usage",
		});
		expect(usageCalls).toBe(1);
	});

	test("a monthly reset beyond the budget is refused with its instant", async () => {
		const far = NOW + OPENCODE_QUOTA_MAX_WAIT_MS + 86_400_000;
		const target = await resolveOpencodeQuotaTarget(
			"ocg",
			"Monthly usage limit reached",
			diag({
				message: "Monthly usage limit reached",
				responseSnippet: "Monthly usage limit reached",
				responseHeaders: { "retry-after": String(Math.ceil((far - NOW) / 1000)) },
			}),
			NOW,
		);
		expect(target).not.toHaveProperty("resumeAt");
		expect(target).toMatchObject({ bucket: "monthly" });
	});

	test("the provider-level decision tags OpenCode and its window", async () => {
		const decision = await resolveProviderQuotaWait(
			"ocg",
			`OpenAI API error 429: ${WEEKLY_MESSAGE}`,
			diag({ responseHeaders: { "retry-after": "374160" } }),
			NOW,
		);
		expect(decision).toEqual({
			kind: "wait",
			wait: {
				quotaProvider: "opencode",
				providerId: "ocg",
				providerPrefix: "ocg",
				waitKind: "quota",
				bucket: "weekly",
				resetAt: NOW + 374_160_000,
				resumeAt: NOW + 374_160_000 + OPENCODE_QUOTA_RESET_SKEW_MS,
			},
		});
	});

	test("non-Go providers and non-quota errors fall through", async () => {
		settings.customApiProviders = [
			provider({ baseUrl: "https://example.com/zen/go/v1", id: "relay", prefix: "relay" }),
		];
		expect(await resolveProviderQuotaWait("relay", WEEKLY_MESSAGE, diag(), NOW)).toEqual({
			kind: "none",
		});
		settings.customApiProviders = [provider()];
		expect(
			await resolveProviderQuotaWait(
				"ocg",
				"Invalid credential",
				bare({ statusCode: 401, reason: "AuthError", message: "Invalid credential" }),
				NOW,
			),
		).toEqual({ kind: "none" });
	});
});
