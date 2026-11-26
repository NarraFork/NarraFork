/**
 * folded-child-sig.test.ts — 折叠条的子元素状态必须能推动它自己重渲染。
 *
 * 这一条是「折叠里的工具卡点开了却不长高」的最后一块拼图：`rowInteractionSig`
 * 只看一个 key，而读者点的是里面某张卡片的 key —— 折叠条自己的签名不变，
 * ExactRow 的 memo 就跳过重渲染，展开后的几何永远不上屏。
 */

import { describe, expect, it } from "bun:test";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import { foldedChildInteractionSig } from "./vlist-exact-row-state";
import { createVListInteractionState, setVListExpanded } from "./vlist-interaction-state";

const child = (key: string): ElementSpec => ({ kind: "tool-call", key, data: {} });

const roundGroup = (children: ElementSpec[]): ElementSpec => ({
	kind: "round-group",
	key: "roundgroup-abc",
	data: { folded: children.map((spec) => ({ spec, measured: {} })), roundKey: "abc" },
});

describe("foldedChildInteractionSig", () => {
	it("非折叠条 → 空串（不影响其它行的签名）", () => {
		expect(foldedChildInteractionSig(child("tool-1"), createVListInteractionState(5))).toBe("");
	});

	it("没有子元素 → 空串", () => {
		expect(foldedChildInteractionSig(roundGroup([]), createVListInteractionState(5))).toBe("");
	});

	it("⚠️ 子元素展开后签名必须变化（否则折叠条不重渲染）", () => {
		const spec = roundGroup([child("tool-1"), child("tool-2")]);
		const before = foldedChildInteractionSig(spec, createVListInteractionState(5));
		const after = foldedChildInteractionSig(
			spec,
			setVListExpanded(createVListInteractionState(5), "tool-1", true),
		);
		expect(before).not.toBe(after);
		expect(after).toContain("tool-1");
	});

	it("未被触碰的子元素不产生噪音（签名保持空）", () => {
		const spec = roundGroup([child("tool-1")]);
		// 没有任何交互状态 → 折叠条签名不变，滚动时可以跳过重渲染。
		expect(foldedChildInteractionSig(spec, createVListInteractionState(5))).toBe("");
	});
});
