import { describe, expect, test } from "bun:test";
import type { KimiUsageCache } from "../../lib/api/types";
import {
	formatKimiBarText,
	formatKimiDetailsText,
	isKimiProviderBaseUrl,
	type KimiTFunction,
} from "./kimi-usage-format";

// Identity-style t: returns the key with interpolated params for assertions.
const t: KimiTFunction = (key, options) => {
	if (!options) return key;
	const params = Object.entries(options)
		.map(([k, v]) => `${k}=${String(v)}`)
		.join(",");
	return `${key}[${params}]`;
};

const BASE: KimiUsageCache = {
	fiveHour: { used: 71, limit: 100, remaining: 29, resetTime: "2026-08-21T13:35:46.841Z" },
	weekly: { used: 34, limit: 100, remaining: 66, resetTime: "2026-08-27T17:35:46.841Z" },
	monthly: null,
	extraWindows: [],
	fetchedAt: 1787308913388,
	error: null,
};

describe("formatKimiBarText", () => {
	test("shows the 5h window remaining percentage", () => {
		expect(formatKimiBarText(BASE, t)).toBe("kimi.fiveHourShort[percent=29]");
	});

	test("derives the percentage from used/limit when remaining is absent", () => {
		const usage: KimiUsageCache = {
			...BASE,
			fiveHour: { used: 71, limit: 100, remaining: null, resetTime: null },
		};
		expect(formatKimiBarText(usage, t)).toBe("kimi.fiveHourShort[percent=29]");
	});

	test("clamps the percentage into 0-100", () => {
		const usage: KimiUsageCache = {
			...BASE,
			fiveHour: { used: 150, limit: 100, remaining: null, resetTime: null },
		};
		expect(formatKimiBarText(usage, t)).toBe("kimi.fiveHourShort[percent=0]");
	});

	test("falls back to used/limit when the percentage cannot be computed", () => {
		const usage: KimiUsageCache = {
			...BASE,
			fiveHour: { used: null, limit: 100, remaining: null, resetTime: null },
		};
		expect(formatKimiBarText(usage, t)).toBe("kimi.fiveHourRatio[used=?,limit=100]");
	});

	test("falls back to unavailable when only an error exists", () => {
		const usage: KimiUsageCache = { ...BASE, fiveHour: null, weekly: null, error: "HTTP 401" };
		expect(formatKimiBarText(usage, t)).toBe("kimi.unavailable");
	});

	test("returns null when there is nothing to show", () => {
		const usage: KimiUsageCache = { ...BASE, fiveHour: null, weekly: null, error: null };
		expect(formatKimiBarText(usage, t)).toBeNull();
	});
});

describe("formatKimiDetailsText", () => {
	test("lists 5h, weekly and monthly windows one per line", () => {
		const usage: KimiUsageCache = {
			...BASE,
			monthly: { used: 500, limit: 1000, remaining: 500, resetTime: null },
		};
		const lines = formatKimiDetailsText(usage, t).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[0]).toContain("kimi.window5h");
		expect(lines[0]).toContain("used=71");
		expect(lines[0]).toContain("kimi.resetSuffix");
		expect(lines[1]).toContain("kimi.windowWeekly");
		expect(lines[2]).toContain("kimi.windowMonthly");
		expect(lines[2]).not.toContain("kimi.resetSuffix");
	});

	test("appends extra windows and the fetch error", () => {
		const usage: KimiUsageCache = {
			...BASE,
			weekly: null,
			extraWindows: [{ label: "30min", used: 3, limit: 50, remaining: 47, resetTime: null }],
			error: "timeout",
		};
		const lines = formatKimiDetailsText(usage, t).split("\n");
		expect(lines).toHaveLength(3);
		expect(lines[1]).toContain("label=30min");
		expect(lines[2]).toBe("kimi.fetchError[error=timeout]");
	});

	test("ignores unparseable reset times", () => {
		const usage: KimiUsageCache = {
			...BASE,
			weekly: null,
			fiveHour: { used: 1, limit: 10, remaining: 9, resetTime: "not-a-date" },
		};
		expect(formatKimiDetailsText(usage, t)).not.toContain("resetSuffix");
	});
});

describe("isKimiProviderBaseUrl", () => {
	test("matches kimi.com and kimi.ai hosts", () => {
		expect(isKimiProviderBaseUrl("https://api.kimi.com/coding/")).toBe(true);
		expect(isKimiProviderBaseUrl("https://api.kimi.ai/coding/v1")).toBe(true);
		expect(isKimiProviderBaseUrl("https://kimi.com")).toBe(true);
	});

	test("rejects non-kimi hosts and invalid URLs", () => {
		expect(isKimiProviderBaseUrl("https://api.moonshot.cn/v1")).toBe(false);
		expect(isKimiProviderBaseUrl("https://kimi.com.evil.example")).toBe(false);
		expect(isKimiProviderBaseUrl("not a url")).toBe(false);
		expect(isKimiProviderBaseUrl(undefined)).toBe(false);
	});
});
