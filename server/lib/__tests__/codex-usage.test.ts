import { describe, expect, test } from "bun:test";
import {
	CodexUsageFetchError,
	type CodexUsagePayload,
	type CodexUsageResult,
	consumeCodexResetCredit,
	fetchCodexUsage,
	getCodexUsageWindows,
	identifyCodexUsageWindowType,
	parseCodexUsagePayload,
} from "../codex-usage";

const DAY_SECONDS = 24 * 60 * 60;

function rateLimitWindow(
	usedPercent: number,
	limitWindowSeconds: number,
	resetAt = 1_800_000_000,
	resetAfterSeconds = 2_628_000,
) {
	return {
		used_percent: usedPercent,
		limit_window_seconds: limitWindowSeconds,
		reset_after_seconds: resetAfterSeconds,
		reset_at: resetAt,
	};
}

function payload(overrides: Partial<CodexUsagePayload> = {}): CodexUsagePayload {
	return {
		plan_type: "team",
		rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: rateLimitWindow(45, 30 * DAY_SECONDS),
			secondary_window: null,
		},
		code_review_rate_limit: {
			allowed: true,
			limit_reached: false,
			primary_window: null,
			secondary_window: null,
		},
		additional_rate_limits: [],
		...overrides,
	};
}

describe("Codex usage window parsing", () => {
	test("classifies exact short windows and bounded 28-31 day monthly windows", () => {
		expect(identifyCodexUsageWindowType(18_000)).toBe("5h");
		expect(identifyCodexUsageWindowType(604_800)).toBe("weekly");
		for (const days of [28, 29, 30, 31]) {
			expect(identifyCodexUsageWindowType(days * DAY_SECONDS)).toBe("monthly");
		}
		expect(identifyCodexUsageWindowType(28 * DAY_SECONDS - 1)).toBe("unknown");
		expect(identifyCodexUsageWindowType(31 * DAY_SECONDS + 1)).toBe("unknown");
		expect(identifyCodexUsageWindowType(0)).toBe("unknown");
	});

	test("derives reset_at from queriedAt when only reset_after_seconds is present", () => {
		const queriedAt = "2026-05-01T00:00:00.000Z";
		const queriedAtSeconds = Date.parse(queriedAt) / 1000;
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 45,
						limit_window_seconds: 30 * DAY_SECONDS,
						reset_after_seconds: 3_600,
					} as unknown as CodexUsagePayload["rate_limit"]["primary_window"],
					secondary_window: null,
				},
			}),
			queriedAt,
		);

		expect(parsed.primary_window?.reset_at).toBe(queriedAtSeconds + 3_600);
		expect(parsed.primary_window?.reset_after_seconds).toBe(3_600);
	});

	test("derives reset_after_seconds from queriedAt when only reset_at is present", () => {
		const queriedAt = "2026-05-01T00:00:00.000Z";
		const queriedAtSeconds = Date.parse(queriedAt) / 1000;
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 45,
						limit_window_seconds: 30 * DAY_SECONDS,
						reset_at: queriedAtSeconds + 7_200,
					} as unknown as CodexUsagePayload["rate_limit"]["primary_window"],
					secondary_window: null,
				},
			}),
			queriedAt,
		);

		expect(parsed.primary_window?.reset_at).toBe(queriedAtSeconds + 7_200);
		expect(parsed.primary_window?.reset_after_seconds).toBe(7_200);
	});

	test("discards a window only when both reset fields are invalid", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: {
						used_percent: 45,
						limit_window_seconds: 18_000,
					} as unknown as CodexUsagePayload["rate_limit"]["primary_window"],
					secondary_window: rateLimitWindow(20, 604_800),
				},
			}),
			"2026-05-01T00:00:00.000Z",
		);

		expect(parsed.primary_window).toBeUndefined();
		expect(parsed.secondary_window?.window_type).toBe("weekly");
	});

	test("uses limit_window_seconds rather than reset_after_seconds for classification", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: rateLimitWindow(45, 123_456, 1_800_000_000, 30 * DAY_SECONDS),
					secondary_window: null,
				},
			}),
			"2026-05-01T00:00:00.000Z",
		);

		expect(parsed.primary_window?.window_type).toBe("unknown");
		expect(parsed.primary_window?.limit_window_seconds).toBe(123_456);
	});

	test("parses real Team monthly fixtures at 55% and 83% remaining", () => {
		const first = parseCodexUsagePayload(payload(), "2026-05-01T00:00:00.000Z");
		const second = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: rateLimitWindow(17, 30 * DAY_SECONDS, 1_800_100_000, 2_627_400),
					secondary_window: null,
				},
			}),
			"2026-05-01T00:00:00.000Z",
		);

		expect(first.primary_window).toMatchObject({
			used_percent: 45,
			remaining_percent: 55,
			window_type: "monthly",
			limit_window_seconds: 30 * DAY_SECONDS,
		});
		expect(second.primary_window).toMatchObject({
			used_percent: 17,
			remaining_percent: 83,
			window_type: "monthly",
			limit_window_seconds: 30 * DAY_SECONDS,
		});
	});

	test("clamps finite percentages and discards malformed windows independently", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit: {
					allowed: true,
					limit_reached: false,
					primary_window: rateLimitWindow(Number.NaN, 18_000),
					secondary_window: rateLimitWindow(120, 604_800),
				},
			}),
			"2026-05-01T00:00:00.000Z",
		);

		expect(parsed.primary_window).toBeUndefined();
		expect(parsed.secondary_window).toMatchObject({
			used_percent: 100,
			remaining_percent: 0,
			window_type: "weekly",
		});
	});

	test("rejects invalid account rate_limit instead of returning an empty replacement", () => {
		expect(() =>
			parseCodexUsagePayload(
				payload({ rate_limit: null as unknown as CodexUsagePayload["rate_limit"] }),
				"2026-05-01T00:00:00.000Z",
			),
		).toThrow("account rate_limit");
	});

	test("ignores exhausted additional_rate_limits for account quota windows", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				additional_rate_limits: [
					{
						allowed: false,
						limit_reached: true,
						primary_window: rateLimitWindow(100, 18_000),
						secondary_window: null,
					},
				],
			}),
			"2026-05-01T00:00:00.000Z",
		);

		expect(getCodexUsageWindows(parsed)).toHaveLength(1);
		expect(parsed.primary_window?.remaining_percent).toBe(55);
	});

	test("reads primary and secondary from legacy cached results without duration", () => {
		const legacy = {
			plan_type: "plus",
			primary_window: {
				used_percent: 20,
				remaining_percent: 80,
				reset_at: 1_800_000_000,
				reset_after_seconds: 3_600,
				window_type: "5h",
			},
			secondary_window: {
				used_percent: 40,
				remaining_percent: 60,
				reset_at: 1_800_100_000,
				reset_after_seconds: 86_400,
				window_type: "unknown",
			},
			queriedAt: "2026-05-01T00:00:00.000Z",
		} satisfies CodexUsageResult;

		expect(getCodexUsageWindows(legacy).map((window) => window.window_type)).toEqual([
			"5h",
			"unknown",
		]);
	});

	test("retains a bounded 401 response body for Agent Identity recovery", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('{"code":"invalid_task_id"}', {
				status: 401,
				statusText: "Unauthorized",
			})) as unknown as typeof fetch;
		try {
			const error = await fetchCodexUsage("", "account", undefined, "AgentAssertion test").catch(
				(err) => err,
			);
			expect(error).toBeInstanceOf(CodexUsageFetchError);
			expect((error as CodexUsageFetchError).status).toBe(401);
			expect((error as CodexUsageFetchError).responseBody).toBe('{"code":"invalid_task_id"}');
			expect((error as Error).message).not.toContain("invalid_task_id");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("rejects usage responses larger than 256 KiB before JSON parsing", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("x".repeat(256 * 1024 + 1), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			await expect(fetchCodexUsage("token", "account")).rejects.toThrow("exceeded 262144 bytes");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});

describe("Codex spendable credits", () => {
	test("parses credits and keeps the decimal balance as a string", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				credits: { has_credits: true, unlimited: false, balance: "123.456789012345678" },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(parsed.credits).toEqual({
			has_credits: true,
			unlimited: false,
			balance: "123.456789012345678",
		});
		// A float round-trip would lose digits; the verbatim string must not.
		expect(parsed.credits?.balance).not.toBe(String(Number("123.456789012345678")));
	});

	test("parses unlimited and no-credits states with a null balance", () => {
		const unlimited = parseCodexUsagePayload(
			payload({
				credits: { has_credits: true, unlimited: true, balance: null },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(unlimited.credits).toEqual({ has_credits: true, unlimited: true, balance: null });

		const none = parseCodexUsagePayload(
			payload({
				credits: { has_credits: false, unlimited: false, balance: null },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(none.credits).toEqual({ has_credits: false, unlimited: false, balance: null });
	});

	test("stringifies a numeric balance and tolerates malformed flag values", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				credits: { has_credits: "yes", unlimited: 1, balance: 42 },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(parsed.credits).toEqual({ has_credits: false, unlimited: false, balance: "42" });
	});

	test("a missing or non-record credits field leaves the field absent", () => {
		expect(parseCodexUsagePayload(payload(), "2026-05-01T00:00:00.000Z").credits).toBeUndefined();
		for (const credits of [null, "nope", [1]]) {
			const parsed = parseCodexUsagePayload(
				payload({ credits } as unknown as Partial<CodexUsagePayload>),
				"2026-05-01T00:00:00.000Z",
			);
			expect(parsed.credits).toBeUndefined();
		}
	});
});

describe("Codex reset credits", () => {
	test("parses rate_limit_reset_credits into reset_credits_available", () => {
		const parsed = parseCodexUsagePayload(
			payload({
				rate_limit_reset_credits: { available_count: 3 },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(parsed.reset_credits_available).toBe(3);
	});

	test("floors the count and rejects negative or non-numeric values", () => {
		const floored = parseCodexUsagePayload(
			payload({
				rate_limit_reset_credits: { available_count: 2.7 },
			} as unknown as Partial<CodexUsagePayload>),
			"2026-05-01T00:00:00.000Z",
		);
		expect(floored.reset_credits_available).toBe(2);

		for (const availableCount of [-1, "many", null, Number.NaN]) {
			const parsed = parseCodexUsagePayload(
				payload({
					rate_limit_reset_credits: { available_count: availableCount },
				} as unknown as Partial<CodexUsagePayload>),
				"2026-05-01T00:00:00.000Z",
			);
			expect(parsed.reset_credits_available).toBeUndefined();
		}
	});

	test("a missing reset-credits object leaves the field absent", () => {
		const parsed = parseCodexUsagePayload(payload(), "2026-05-01T00:00:00.000Z");
		expect(parsed.reset_credits_available).toBeUndefined();
	});

	test("consume normalizes windows_reset and generates a redeem_request_id per call", async () => {
		const bodies: string[] = [];
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async (_input: unknown, init?: RequestInit) => {
			bodies.push(String(init?.body));
			return new Response('{"code":"ok","windows_reset":2}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		}) as unknown as typeof fetch;
		try {
			const result = await consumeCodexResetCredit("token", "account");
			expect(result).toEqual({ code: "ok", windowsReset: 2 });
			expect(bodies).toHaveLength(1);
			const first = JSON.parse(bodies[0]) as { redeem_request_id?: string };
			expect(first.redeem_request_id).toMatch(/^[0-9a-f-]{36}$/);

			await consumeCodexResetCredit("token", "account");
			const second = JSON.parse(bodies[1]) as { redeem_request_id?: string };
			// The idempotency key must differ per call: reusing one would let the
			// upstream dedupe a second deliberate consume into a no-op.
			expect(second.redeem_request_id).not.toBe(first.redeem_request_id);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("consume clamps a negative or missing windows_reset to 0", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('{"code":"ok","windows_reset":-3}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const negative = await consumeCodexResetCredit("token", "account");
			expect(negative.windowsReset).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}

		globalThis.fetch = (async () =>
			new Response('{"code":"ok"}', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			const missing = await consumeCodexResetCredit("token", "account");
			expect(missing.windowsReset).toBe(0);
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("consume rejects a non-JSON payload instead of reporting success", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response("<html>error</html>", {
				status: 200,
				headers: { "Content-Type": "text/html" },
			})) as unknown as typeof fetch;
		try {
			await expect(consumeCodexResetCredit("token", "account")).rejects.toThrow("non-JSON");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("consume rejects a non-record payload", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('["ok"]', {
				status: 200,
				headers: { "Content-Type": "application/json" },
			})) as unknown as typeof fetch;
		try {
			await expect(consumeCodexResetCredit("token", "account")).rejects.toThrow("invalid payload");
		} finally {
			globalThis.fetch = originalFetch;
		}
	});

	test("consume surfaces a 401 as CodexUsageFetchError for task recovery", async () => {
		const originalFetch = globalThis.fetch;
		globalThis.fetch = (async () =>
			new Response('{"code":"invalid_task_id"}', {
				status: 401,
				statusText: "Unauthorized",
			})) as unknown as typeof fetch;
		try {
			const error = await consumeCodexResetCredit(
				"",
				"account",
				undefined,
				"AgentAssertion t",
			).catch((err) => err);
			expect(error).toBeInstanceOf(CodexUsageFetchError);
			expect((error as CodexUsageFetchError).status).toBe(401);
			expect((error as CodexUsageFetchError).responseBody).toBe('{"code":"invalid_task_id"}');
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
