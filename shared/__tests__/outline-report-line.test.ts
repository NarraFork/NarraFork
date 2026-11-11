import { describe, expect, test } from "bun:test";
import { DELEGATION_BLOCK_TEXT } from "@server/services/outline/delegation-text";
import {
	isOutlineReportBlockId,
	isOutlineReportContainer,
	parseOutlineReportLine,
} from "../outline-report-line";

const AT = "2026-11-09 17:38 UTC";
const ISO = "2026-11-09T17:38:00.000Z";

describe("parseOutlineReportLine", () => {
	test("reads the owner's example without the generation or the zone", () => {
		expect(parseOutlineReportLine("报告（第 2 代 · 2026-11-09 17:38 UTC）")).toEqual({
			at: ISO,
			generation: 2,
			late: null,
			unfinished: null,
			empty: false,
		});
		expect(parseOutlineReportLine("Report (generation 12 · 2026-11-09 17:38 UTC)")).toEqual({
			at: ISO,
			generation: 12,
			late: null,
			unfinished: null,
			empty: false,
		});
	});

	// Every form the writer can produce, built with the writer's own text: a change of wording
	// there fails here instead of silently showing raw lines.
	for (const locale of ["en", "zh-CN"] as const) {
		const text = DELEGATION_BLOCK_TEXT[locale];
		// The writer's run endings, and what each reads back as (a cancelled run is "interrupted").
		const endings = [
			[null, null],
			["timed_out", "timed_out"],
			["failed", "failed"],
			["cancelled", "interrupted"],
		] as const;
		const lates = [null, "ended", "reopened", "taken_over"] as const;
		test(`${locale}: every written form reads back`, () => {
			for (const late of lates) {
				for (const [ending, unfinished] of endings) {
					for (const empty of [false, true]) {
						let line = late ? text.late(3, AT, late) : text.report(3, AT);
						if (ending) line += text.unfinished(ending);
						if (empty) line += text.empty;
						expect(parseOutlineReportLine(line), line).toEqual({
							at: ISO,
							generation: 3,
							late,
							unfinished,
							empty,
						});
					}
				}
			}
		});
	}

	test("whitespace around the line is ignored", () => {
		expect(parseOutlineReportLine(`  报告（第 1 代 · ${AT}）\n`)?.at).toBe(ISO);
	});

	test("anything that is not exactly a written form stays raw", () => {
		const raw = [
			"",
			"报告",
			"报告（第 2 代）",
			`报告（第 2 代 · ${AT}`,
			`报告（第 2 代 · 2026-11-09 17:38）`,
			`报告（第 x 代 · ${AT}）`,
			`我的报告（第 2 代 · ${AT}）`,
			`报告（第 2 代 · ${AT}）后面还有字`,
			`报告（第 2 代 · ${AT}）\n第二行`,
			// A plain report never gives a reason; a late one always gives a known one.
			`报告（第 2 代 · ${AT}，派出后任务已转手）`,
			`迟到的报告（第 2 代 · ${AT}）`,
			`迟到的报告（第 2 代 · ${AT}，别的原因）`,
			`Late report (generation 2 · ${AT})`,
			`Late report (generation 2 · ${AT}; some other reason)`,
			`Report (generation 2 · ${AT}; the task changed hands after it was sent)`,
			`Report (generation 2 · ${AT}) · unfinished: asleep`,
			// The two languages do not mix.
			`Report (generation 2 · ${AT}) · 未完成：超时`,
			// Dates that do not exist.
			"报告（第 2 代 · 2026-13-09 17:38 UTC）",
			"报告（第 2 代 · 2026-02-30 17:38 UTC）",
			"报告（第 2 代 · 2026-11-09 25:38 UTC）",
			"报告（第 2 代 · 2026-11-09 17:61 UTC）",
			`# 报告（第 2 代 · ${AT}）`,
			`${"x".repeat(5000)}报告（第 2 代 · ${AT}）`,
		];
		for (const text of raw) expect(parseOutlineReportLine(text), text).toBeNull();
	});
});

describe("report containers", () => {
	test("the writer's ids are recognised, nothing else is", () => {
		const id = `dlrp${"aB3_-".repeat(6).slice(0, 28)}`;
		expect(isOutlineReportBlockId(id)).toBe(true);
		expect(isOutlineReportBlockId(`${id}x`)).toBe(false);
		expect(isOutlineReportBlockId(id.slice(1))).toBe(false);
		expect(isOutlineReportBlockId("dlrp")).toBe(false);
		expect(isOutlineReportBlockId(`x${id.slice(1)}`)).toBe(false);
	});

	test("a container is known by its id, or by a line that is exactly a report line", () => {
		const id = `dlrp${"aB3_-".repeat(6).slice(0, 28)}`;
		expect(isOutlineReportContainer(id, "edited by someone")).toBe(true);
		expect(isOutlineReportContainer("b1234567", "报告（第 2 代 · 2026-11-09 17:38 UTC）")).toBe(
			true,
		);
		expect(isOutlineReportContainer("b1234567", "报告（见下）")).toBe(false);
		expect(isOutlineReportContainer("b1234567", "a note")).toBe(false);
	});
});
