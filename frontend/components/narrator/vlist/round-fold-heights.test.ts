/**
 * round-fold-heights.test.ts — 实测回填的核心不变量。
 *
 * 最关键的一条（对应 vlist 铁律 1）：**回填只允许移动被展开那条之后的行**。
 * 之前的行逐字节不变，否则读者正在看的内容会无故上跳。
 */

import { describe, expect, it } from "bun:test";
import type { MeasuredElement } from "@shared/pretext-layout/prepared-block";
import {
	applyRoundFoldHeights,
	type RoundFoldHeights,
	retainRoundFoldHeights,
} from "./round-fold-heights";

/** 造一个最小可用的 MeasuredElement。 */
function item(key: string, height: number): MeasuredElement & { key: string } {
	return {
		key,
		height,
		blocks: [],
		frame: { blocks: [], contentHeight: height, usedWidth: 400 },
		contentWidth: 400,
		usedWidth: 400,
	};
}

function heightsOf(entries: Array<[string, MeasuredElement, number]>): RoundFoldHeights {
	return new Map(entries.map(([key, bodyRef, height]) => [key, { bodyRef, height }]));
}

describe("applyRoundFoldHeights", () => {
	it("把实测高写进目标元素", () => {
		const target = item("round-1", 20);
		const out = applyRoundFoldHeights(
			[item("a", 50), target, item("b", 30)],
			new Map([["round-1", { bodyRef: target, height: 300 }]]),
		);
		expect(out[1]!.height).toBe(300);
	});

	it("⚠️ 目标之前的行为零位移（已提交的行不得移动）", () => {
		const target = item("round-1", 20);
		const before = item("a", 50);
		const out = applyRoundFoldHeights(
			[before, target, item("b", 30)],
			new Map([["round-1", { bodyRef: target, height: 300 }]]),
		);
		expect(out[0]!.foldShift).toBe(0);
		expect(out[0]!.height).toBe(50);
	});

	it("目标之后的行按位移下移（展开把下面的内容推下去）", () => {
		const target = item("round-1", 20);
		const out = applyRoundFoldHeights(
			[target, item("b", 30), item("c", 40)],
			new Map([["round-1", { bodyRef: target, height: 300 }]]),
		);
		// 300 - 20 = 280
		expect(out[1]!.foldShift).toBe(280);
		expect(out[2]!.foldShift).toBe(280);
		// 自身高度不变，只有位置变。
		expect(out[1]!.height).toBe(30);
	});

	it("收缩时位移为负（收起后下面的内容上移）", () => {
		const target = item("round-1", 300);
		const out = applyRoundFoldHeights(
			[target, item("b", 30)],
			new Map([["round-1", { bodyRef: target, height: 20 }]]),
		);
		expect(out[1]!.foldShift).toBe(-280);
	});

	it("⭐ bodyRef 不是同一个对象 → 读数失效，不改任何高度", () => {
		// 换 LOD / 换宽度之后展开体会是另一个对象，旧读数不能被用上。
		const target = item("round-1", 20);
		const staleBody = item("round-1", 20);
		const out = applyRoundFoldHeights(
			[target],
			new Map([["round-1", { bodyRef: staleBody, height: 999 }]]),
		);
		expect(out[0]!.height).toBe(20);
	});

	it("没有读数 → 原数组引用返回（日常路径不分配）", () => {
		const items = [item("a", 10), item("b", 20)];
		const out = applyRoundFoldHeights(items, new Map());
		expect(out).toBe(items as unknown as typeof out);
	});

	it("多条同时展开时位移累加", () => {
		const first = item("round-1", 20);
		const second = item("round-2", 20);
		const out = applyRoundFoldHeights(
			[first, item("mid", 10), second, item("tail", 5)],
			new Map([
				["round-1", { bodyRef: first, height: 120 }], // +100
				["round-2", { bodyRef: second, height: 220 }], // +200
			]),
		);
		expect(out[2]!.height).toBe(220);
		// tail 在第一轮 +100 与第二轮 +200 之后。
		expect(out[3]!.foldShift).toBe(300);
	});
});

describe("retainRoundFoldHeights", () => {
	it("body 未变、高度合法 → 保留", () => {
		const body = item("round-1", 20);
		const kept = retainRoundFoldHeights(
			new Map([["round-1", body]]),
			heightsOf([["round-1", body, 300]]),
		);
		expect(kept.size).toBe(1);
	});

	it("body 换了对象 → 丢弃", () => {
		const body = item("round-1", 20);
		const other = item("round-1", 20);
		const kept = retainRoundFoldHeights(
			new Map([["round-1", other]]),
			heightsOf([["round-1", body, 300]]),
		);
		expect(kept.size).toBe(0);
	});

	it("元素不在当前 map 里（已卸载 / 被折叠）→ 丢弃", () => {
		const body = item("round-1", 20);
		const kept = retainRoundFoldHeights(new Map(), heightsOf([["round-1", body, 300]]));
		expect(kept.size).toBe(0);
	});

	it("非法高度（NaN / 0 / 负）→ 丢弃", () => {
		const body = item("round-1", 20);
		const current = new Map([["round-1", body]]);
		expect(retainRoundFoldHeights(current, heightsOf([["round-1", body, Number.NaN]])).size).toBe(
			0,
		);
		expect(retainRoundFoldHeights(current, heightsOf([["round-1", body, 0]])).size).toBe(0);
		expect(retainRoundFoldHeights(current, heightsOf([["round-1", body, -5]])).size).toBe(0);
	});

	it("全都成立时返回原引用（避免无谓重算）", () => {
		const body = item("round-1", 20);
		const original = heightsOf([["round-1", body, 300]]);
		expect(retainRoundFoldHeights(new Map([["round-1", body]]), original)).toBe(original);
	});
});
