import { describe, expect, test } from "bun:test";
import type { CodexUsageData, CodexUsageWindow } from "./api/types";
import {
	CODEX_USAGE_WINDOW_ORDER,
	getCodexUsageWindowLabelKey,
	getCodexUsageWindows,
	sortCodexUsageWindows,
} from "./codex-usage-windows";

function window(windowType: CodexUsageWindow["window_type"]): CodexUsageWindow {
	return {
		used_percent: 45,
		remaining_percent: 55,
		reset_at: 1_800_000_000,
		reset_after_seconds: 60,
		window_type: windowType,
	};
}

describe("Codex usage window display metadata", () => {
	test("orders known windows before unknown and labels monthly independently", () => {
		expect(CODEX_USAGE_WINDOW_ORDER).toEqual(["5h", "weekly", "monthly", "unknown"]);
		expect(getCodexUsageWindowLabelKey("monthly")).toBe("codexUsageMonthly");
		expect(getCodexUsageWindowLabelKey("unknown")).toBe("codexUsageUnknown");
		expect(getCodexUsageWindowLabelKey("unexpected" as CodexUsageWindow["window_type"])).toBe(
			"codexUsageUnknown",
		);
	});

	test("collects primary and secondary windows with stable display sorting", () => {
		const usage: CodexUsageData = {
			plan_type: "team",
			primary_window: window("monthly"),
			secondary_window: window("5h"),
			queriedAt: "2026-04-01T00:00:00.000Z",
		};

		expect(getCodexUsageWindows(usage).map((item) => item.window_type)).toEqual(["monthly", "5h"]);
		expect(
			sortCodexUsageWindows(getCodexUsageWindows(usage)).map((item) => item.window_type),
		).toEqual(["5h", "monthly"]);
	});

	test("keeps equal and unknown window ordering stable", () => {
		const first = window("unknown");
		const second = window("unknown");
		expect(sortCodexUsageWindows([first, second])).toEqual([first, second]);
	});
});
