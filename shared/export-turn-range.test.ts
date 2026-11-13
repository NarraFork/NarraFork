import { describe, expect, test } from "bun:test";
import {
	expandTurnRange,
	formatTurnRange,
	parseTurnRange,
	rangesFromTurns,
	TURN_RANGE_MAX_TURNS,
} from "./export-turn-range";

describe("导出消息范围的轮次区间", () => {
	test("用户写的原始串按升序规范化，并合并重叠与相邻", () => {
		expect(parseTurnRange("1,2,3-10,15,21")).toEqual([
			{ from: 1, to: 10 },
			{ from: 15, to: 15 },
			{ from: 21, to: 21 },
		]);
		expect(parseTurnRange("5-8,1-6")).toEqual([{ from: 1, to: 8 }]);
		expect(parseTurnRange(" 3 - 4 , 5 ")).toEqual([{ from: 3, to: 5 }]);
	});

	test("空串或只有分隔符等于不限范围", () => {
		expect(parseTurnRange("")).toEqual([]);
		expect(parseTurnRange("  ,  ")).toEqual([]);
	});

	test("非法输入返回 null", () => {
		for (const input of ["0", "-1", "3-1", "a", "1,,x", "1-", "1.5", "1 2"]) {
			expect(parseTurnRange(input)).toBeNull();
		}
	});

	test("格式化回原始串，单个轮号不写区间", () => {
		expect(
			formatTurnRange([
				{ from: 21, to: 21 },
				{ from: 3, to: 10 },
				{ from: 1, to: 2 },
			]),
		).toBe("1-10,21");
	});

	test("选中的轮号压成连续区间，乱序与重复都能收拾", () => {
		expect(rangesFromTurns([5, 3, 4, 3, 9])).toEqual([
			{ from: 3, to: 5 },
			{ from: 9, to: 9 },
		]);
		expect(rangesFromTurns([])).toEqual([]);
	});

	test("展开成轮号集合，超过上限时拒绝", () => {
		expect([...(expandTurnRange([{ from: 2, to: 4 }]) ?? [])]).toEqual([2, 3, 4]);
		expect(expandTurnRange([{ from: 1, to: TURN_RANGE_MAX_TURNS + 1 }])).toBeNull();
		expect(expandTurnRange([{ from: 1, to: 3 }], 2)).toBeNull();
	});
});
