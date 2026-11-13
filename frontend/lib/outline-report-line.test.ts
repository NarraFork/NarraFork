import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import en from "../locales/en/outline.json";
import zh from "../locales/zh-CN/outline.json";
import { formatReportLineTime, reportLineDisplay } from "./outline-report-line";

/** A `t` over the real locale files: the keys the formatter asks for must exist in both. */
function tOf(table: Record<string, unknown>) {
	return (key: string, options?: Record<string, unknown>): string => {
		let node: unknown = table;
		for (const part of key.split(".")) node = (node as Record<string, unknown> | undefined)?.[part];
		if (typeof node !== "string") throw new Error(`missing locale key ${key}`);
		return node.replace(/\{\{(\w+)\}\}/g, (_, name) => String(options?.[name] ?? ""));
	};
}

const savedTz = process.env.TZ;
// A viewer nine hours east of UTC: 17:38 UTC on the 9th is 02:38 on the 10th for them.
beforeAll(() => {
	process.env.TZ = "Asia/Tokyo";
});
afterAll(() => {
	if (savedTz === undefined) delete process.env.TZ;
	else process.env.TZ = savedTz;
});

const STORED_ZH = "报告（第 2 代 · 2026-11-09 17:38 UTC）";
const STORED_EN = "Report (generation 2 · 2026-11-09 17:38 UTC)";
const at = (iso: string) => new Date(iso);

describe("formatReportLineTime", () => {
	test("is the viewer's local time, short: today, yesterday, this year, earlier", () => {
		const iso = "2026-11-09T17:38:00.000Z"; // 2026-11-10 02:38 in Tokyo
		expect(formatReportLineTime(iso, "zh-CN", at("2026-11-10T03:00:00+09:00"))).toBe("02:38");
		expect(formatReportLineTime(iso, "zh-CN", at("2026-11-11T09:00:00+09:00"))).toBe("昨天 02:38");
		expect(formatReportLineTime(iso, "en", at("2026-11-11T09:00:00+09:00"))).toBe(
			"yesterday 02:38",
		);
		expect(formatReportLineTime(iso, "zh-CN", at("2026-11-20T09:00:00+09:00"))).toBe(
			"11月10日 02:38",
		);
		expect(formatReportLineTime(iso, "en", at("2026-11-20T09:00:00+09:00"))).toBe("Nov 10, 02:38");
		expect(formatReportLineTime(iso, "zh-CN", at("2027-01-02T09:00:00+09:00"))).toBe(
			"2026年11月10日 02:38",
		);
		expect(formatReportLineTime(iso, "en", at("2027-01-02T09:00:00+09:00"))).toBe(
			"Nov 10, 2026, 02:38",
		);
		expect(formatReportLineTime("not a date", "en")).toBe("");
	});

	test("follows the viewer's zone, not the stored UTC text", () => {
		const iso = "2026-11-09T17:38:00.000Z";
		const now = at("2026-11-20T00:00:00Z");
		process.env.TZ = "America/Los_Angeles";
		expect(formatReportLineTime(iso, "en", now)).toBe("Nov 9, 09:38");
		process.env.TZ = "Asia/Tokyo";
		expect(formatReportLineTime(iso, "en", now)).toBe("Nov 10, 02:38");
	});
});

describe("reportLineDisplay", () => {
	const now = at("2026-11-11T09:00:00+09:00");

	test("the owner's example reads as a report, in either interface language", () => {
		// The stored language is the delegating session's; the reader's own language is shown.
		for (const stored of [STORED_ZH, STORED_EN]) {
			expect(reportLineDisplay(stored, { t: tOf(zh), locale: "zh-CN", now })).toBe(
				"子代理报告 · 昨天 02:38",
			);
			expect(reportLineDisplay(stored, { t: tOf(en), locale: "en", now })).toBe(
				"Subagent report · yesterday 02:38",
			);
		}
	});

	test("never shows the generation or UTC, whatever the form", () => {
		const forms = [
			STORED_ZH,
			"迟到的报告（第 7 代 · 2026-11-09 17:38 UTC，派出后任务已转手） · 未完成：超时（没有输出）",
			"Late report (generation 7 · 2026-11-09 17:38 UTC; the task was ended after it was sent) · unfinished: failed (no output)",
		];
		for (const stored of forms) {
			for (const [t, locale] of [
				[tOf(zh), "zh-CN"],
				[tOf(en), "en"],
			] as const) {
				const shown = reportLineDisplay(stored, { t, locale, now });
				expect(shown).not.toBeNull();
				expect(shown).not.toMatch(/UTC|第\s*\d+\s*代|generation|7/);
			}
		}
	});

	test("late, unfinished and empty reports say so; the writer's name is added when known", () => {
		expect(
			reportLineDisplay(
				"迟到的报告（第 3 代 · 2026-11-09 17:38 UTC，派出后任务已转手） · 未完成：超时（没有输出）",
				{ t: tOf(zh), locale: "zh-CN", now, from: "探查-1" },
			),
		).toBe(
			"迟到的子代理报告（派出后任务已转手） · 昨天 02:38 · 来自 探查-1 · 未完成：超时 · 没有输出",
		);
		expect(
			reportLineDisplay(
				"Late report (generation 3 · 2026-11-09 17:38 UTC; the task went back to do after it was sent) · unfinished: interrupted",
				{ t: tOf(en), locale: "en", now, from: "scout-1" },
			),
		).toBe(
			"Late subagent report (the task went back to do after it was sent) · yesterday 02:38 · from scout-1 · unfinished: interrupted",
		);
	});

	test("anything else is not a report line: the caller shows the text as it is", () => {
		const options = { t: tOf(zh), locale: "zh-CN", now };
		for (const text of [
			"",
			"普通的一行",
			"报告（第 2 代）",
			"报告（第 2 代 · 2026-11-09 17:38 UTC）后面还有字",
			"Report (generation two · 2026-11-09 17:38 UTC)",
			`${"长".repeat(600)}（`,
		]) {
			expect(reportLineDisplay(text, options)).toBeNull();
		}
	});
});
