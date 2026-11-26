/**
 * round-rail-geometry.test.ts — 导航轨的纯几何。
 *
 * 每条断言对应的失败都是静默的（不报错、只是观感错）：
 * 窗口不跟手 → 更早的轮在轨道上根本不存在；指针判定错 → 点到的不是看着的那轮；
 * 卡片不夹边 → 摘要卡飞出视口。
 */

import { describe, expect, it } from "bun:test";
import {
	nearestTickIndex,
	pickerCardTop,
	RAIL_BOTTOM_GAP_PX,
	RAIL_DEFAULT_TICKS,
	RAIL_EDGE_MARGIN,
	RAIL_MIN_TICKS,
	railCapacity,
	railWindowStart,
	resolveActiveRoundIndex,
	TICK_HEIGHT_PX,
	TICK_PITCH_PX,
} from "./round-rail-geometry";

describe("railWindowStart", () => {
	it("当前轮在窗口内且离边缘还远 → 不动", () => {
		expect(railWindowStart(10, 20, 100, 24, RAIL_EDGE_MARGIN)).toBe(10);
	});

	it("当前轮越过下边缘 → 窗口挪到刚好留 margin 根", () => {
		// start=0, size=24, edge=3 → 上限是 activeIndex 22；23 越界。
		expect(railWindowStart(0, 23, 100, 24, RAIL_EDGE_MARGIN)).toBe(23 - (24 - 1 - 3));
	});

	it("当前轮越过上边缘 → 窗口往回挪", () => {
		// start=50, edge=3 → 下界是 53；activeIndex=51 越界。
		expect(railWindowStart(50, 51, 100, 24, RAIL_EDGE_MARGIN)).toBe(51 - 3);
	});

	it("没有当前轮（-1）→ 原地不动", () => {
		expect(railWindowStart(42, -1, 100, 24, RAIL_EDGE_MARGIN)).toBe(42);
	});

	it("轮数不足以填满窗口 → 停在 0", () => {
		expect(railWindowStart(10, 5, 8, 24, RAIL_EDGE_MARGIN)).toBe(0);
	});

	it("结果窗口不会超出尾部", () => {
		expect(railWindowStart(0, 99, 100, 24, RAIL_EDGE_MARGIN)).toBe(100 - 24);
	});

	it("幂等：对自己的输出再算一遍不变（渲染期可安全据此更新 state）", () => {
		const once = railWindowStart(0, 23, 100, 24, RAIL_EDGE_MARGIN);
		expect(railWindowStart(once, 23, 100, 24, RAIL_EDGE_MARGIN)).toBe(once);
	});

	it("非法输入被收敛，不会返回 NaN", () => {
		expect(Number.isFinite(railWindowStart(Number.NaN, 5, 100, 24, 3))).toBe(true);
		expect(railWindowStart(-5, 5, 100, 24, 3)).toBeGreaterThanOrEqual(0);
	});

	it("margin 大于半个窗口时不会把窗口顶翻", () => {
		const start = railWindowStart(0, 20, 100, 4, 99);
		expect(start).toBeGreaterThanOrEqual(0);
		expect(start).toBeLessThanOrEqual(100 - 4);
	});
});

describe("railCapacity", () => {
	it("按可用高度算根数", () => {
		// 400px 可用：room = 400-24 = 376；(376 + 7) / 10 = 38
		expect(railCapacity(400)).toBe(38);
	});

	it("再矮也至少 RAIL_MIN_TICKS 根", () => {
		expect(railCapacity(40)).toBe(RAIL_MIN_TICKS);
	});

	it("量不到（0 / NaN / 负数）→ 默认根数", () => {
		expect(railCapacity(0)).toBe(RAIL_DEFAULT_TICKS);
		expect(railCapacity(Number.NaN)).toBe(RAIL_DEFAULT_TICKS);
		expect(railCapacity(-10)).toBe(RAIL_DEFAULT_TICKS);
	});

	it("常量自洽：节距大于横条高", () => {
		expect(TICK_PITCH_PX).toBeGreaterThan(TICK_HEIGHT_PX);
		expect(RAIL_BOTTOM_GAP_PX).toBeGreaterThan(0);
	});
});

describe("nearestTickIndex", () => {
	it("取最近的横条中心", () => {
		expect(nearestTickIndex([0, 10, 20], 12)).toBe(1);
		expect(nearestTickIndex([0, 10, 20], 19)).toBe(2);
		expect(nearestTickIndex([0, 10, 20], 4)).toBe(0);
	});

	it("跳过窗口外（NaN）的横条", () => {
		expect(nearestTickIndex([Number.NaN, 100, Number.NaN], 102)).toBe(1);
	});

	it("全部不可用 → -1", () => {
		expect(nearestTickIndex([Number.NaN, Number.NaN], 50)).toBe(-1);
		expect(nearestTickIndex([], 50)).toBe(-1);
	});
});

describe("pickerCardTop", () => {
	const H = 60;

	it("中线对准横条", () => {
		expect(pickerCardTop(300, H, 0, 900)).toBe(270);
	});

	it("到顶部边缘时夹住", () => {
		expect(pickerCardTop(10, H, 40, 900)).toBe(40);
	});

	it("到底部边缘时夹住", () => {
		expect(pickerCardTop(880, H, 0, 900)).toBe(900 - H);
	});

	it("空间比卡片还矮 → 顶到 minTop（不产生负高度）", () => {
		expect(pickerCardTop(50, H, 100, 120)).toBe(100);
	});
});

describe("resolveActiveRoundIndex", () => {
	const rounds = [{ seq: 10 }, { seq: 20 }, { seq: 30 }];

	it("取 seq <= 当前位置的最后一轮", () => {
		expect(resolveActiveRoundIndex(rounds, 15)).toBe(0);
		expect(resolveActiveRoundIndex(rounds, 20)).toBe(1);
		expect(resolveActiveRoundIndex(rounds, 99)).toBe(2);
	});

	it("正好落在轮首上 → 就是那一轮", () => {
		expect(resolveActiveRoundIndex(rounds, 30)).toBe(2);
	});

	it("比所有轮首都早 → 亮第一轮（而不是一根都不亮）", () => {
		expect(resolveActiveRoundIndex(rounds, 1)).toBe(0);
	});

	it("空轮次表 / 没有位置 → -1", () => {
		expect(resolveActiveRoundIndex([], 10)).toBe(-1);
		expect(resolveActiveRoundIndex(rounds, undefined)).toBe(-1);
	});
});
