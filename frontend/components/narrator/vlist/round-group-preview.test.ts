/**
 * round-group-preview.test.ts — 盒内预览态的两条承重不变量。
 *
 * 1. **预览态必须被认成动态行**。折叠条的 blocks 恒为空，走通用的
 *    `hasUnpredictableBlock(measured.blocks)` 会恒为 false —— 于是预览体被裁在
 *    占位高度里、下方内容不下移。这是本设计最容易静默失效的一条。
 * 2. **收起态绝不能被认成动态行**。否则一行常量高度也进实测通道，白白给每个
 *    完成的轮引入一次 ResizeObserver 与一次几何重算。
 */

import { describe, expect, it } from "bun:test";
import type { MeasuredElement } from "@shared/pretext-layout/prepared-block";
import { measureRoundGroup, ROUND_PREVIEW_PLACEHOLDER_HEIGHT } from "./measure/measure-round-group";
import {
	hostsUnpredictableBlock,
	UNKNOWN_HEIGHT_FORWARDING_KINDS,
} from "./vlist-unpredictable-blocks";

function base(height: number): MeasuredElement {
	return {
		height,
		blocks: [],
		frame: { blocks: [], contentHeight: height, usedWidth: 400 },
		contentWidth: 400,
		usedWidth: 400,
	};
}

const data = { title: "已处理 2m 14s", childCount: 12 };

describe("round-group 的盒内预览态", () => {
	it("round-group 在动态行白名单里", () => {
		expect(UNKNOWN_HEIGHT_FORWARDING_KINDS.has("round-group")).toBe(true);
	});

	it("⚠️ 预览态 → 认成动态行（预览高度靠实测覆盖）", () => {
		const measured = measureRoundGroup(data, 400, 4, { open: true });
		expect(hostsUnpredictableBlock("round-group", measured)).toBe(true);
	});

	it("⚠️ 收起态 → 不是动态行（常量高度，不进实测通道）", () => {
		const measured = measureRoundGroup(data, 400, 4, {});
		expect(hostsUnpredictableBlock("round-group", measured)).toBe(false);
	});

	it("预览态高度 = 头部 + 占位（只是一个下界，实测会覆盖）", () => {
		const closed = measureRoundGroup(data, 400, 4, {});
		const open = measureRoundGroup(data, 400, 4, { open: true });
		expect(open.height).toBe(closed.height + ROUND_PREVIEW_PLACEHOLDER_HEIGHT);
		expect(open.height).toBeGreaterThan(closed.height);
	});

	it("占位值偏小（偏大先把下方内容推下去再收回来）", () => {
		// 头大约 20px；占位 80px 意味着首帧只声明约 100px，即使实测是 400px
		// 也只是一次向上撑开，不会出现「先撑大再收回」的抖动。
		expect(ROUND_PREVIEW_PLACEHOLDER_HEIGHT).toBeLessThanOrEqual(120);
		expect(ROUND_PREVIEW_PLACEHOLDER_HEIGHT).toBeGreaterThan(0);
	});

	it("blocks 恒为空（这正是不能走通用判据的原因）", () => {
		expect(measureRoundGroup(data, 400, 4, { open: true }).blocks).toEqual([]);
		expect(measureRoundGroup(data, 400, 4, {}).blocks).toEqual([]);
	});

	it("高度与 data 无关（标题长短不改变一行的高度）", () => {
		const short = measureRoundGroup({ title: "已处理", childCount: 1 }, 400, 4, {});
		const long = measureRoundGroup(
			{ title: "已处理 11h 45m 12s · 999k token，还有很长很长的一段文字", childCount: 99 },
			400,
			4,
			{},
		);
		expect(long.height).toBe(short.height);
	});
});

describe("通用判据的行为（对照，确保专门分支确实必要）", () => {
	it("空 blocks 的元素在通用判据下恒不是动态行", () => {
		// `base` 模拟「如果走通用分支」会得到的结论。
		expect(hostsUnpredictableBlock("markdown", base(100))).toBe(false);
	});
});
