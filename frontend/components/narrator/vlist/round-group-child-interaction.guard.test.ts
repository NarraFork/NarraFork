/**
 * round-group-child-interaction.guard.test.ts — 折叠里的元素必须拿到**自己**的展开回调。
 *
 * 这个缺陷修起来容易、退回去也容易，而且两种失败都是静默的：卡片照常画出来，
 * 只是点了没反应。所以用源码守卫钉住接线方式。
 *
 * 背景：整轮折叠把「轮首之后 → 最终回复之前」的元素搬进 `spec.data.folded`，
 * 它们从顶层序列消失，只经由折叠条渲染。折叠条这一行的 `toggles` 是**闭包**，
 * 绑的是折叠条自己的 key；把它交给子元素，点击只会去翻折叠条的状态，
 * 工具卡看起来完全没反应。
 */

import { describe, expect, it } from "bun:test";

const readSource = () => Bun.file(new URL("./ExactRow.tsx", import.meta.url)).text();

describe("整轮折叠：被折元素的交互接线", () => {
	it("按子元素 key 取 toggles，而不是复用折叠条自己的", async () => {
		const source = await readSource();
		// 折子元素时必须问「这个 key 的 toggles」，不能复用外层的 `toggles`。
		expect(source).toMatch(/getTogglesForKey\?\.\(child\.spec\.key\)/);
	});

	it("给可折叠卡片接 onToggle（工具卡 / 推理 / 子代理卡都要）", async () => {
		const source = await readSource();
		expect(source).toMatch(/TOGGLEABLE_CARD_KINDS\.has\(child\.spec\.kind\)/);
		expect(source).toMatch(/childExtra\.onToggle\s*=\s*childToggles\.onToggle/);
	});

	it("给 trace 家族接 header / earlier 展开", async () => {
		const source = await readSource();
		expect(source).toMatch(/TRACE_KINDS\.has\(child\.spec\.kind\)/);
		expect(source).toMatch(/childExtra\.onToggleItems\s*=\s*childToggles\.onToggleItems/);
		expect(source).toMatch(/childExtra\.onToggleEarlier\s*=\s*childToggles\.onToggleEarlier/);
	});

	it("memo 比较包含 getTogglesForKey（否则会停在旧回调上）", async () => {
		const source = await readSource();
		expect(source).toMatch(/prev\.getTogglesForKey === next\.getTogglesForKey/);
	});

	it("⚠️ 折子元素按当前展开态重测几何，而不是用折叠时的快照", async () => {
		// 只接回调不够：渲染层的形态取自 `measured.expanded`，而 `spec.data.folded`
		// 里存的是折叠那一刻的快照（收起态）。不重测的话点击只翻转 aria-expanded、
		// 高度不变 —— 看起来像「点了没反应」。
		const source = await readSource();
		expect(source).toMatch(/remeasureFoldedChild\?\.\(child\.spec, child\.measured\)/);
		expect(source).toMatch(/remeasured \?\? child\.measured/);
	});

	it("memo 比较包含 remeasureFoldedChild", async () => {
		const source = await readSource();
		expect(source).toMatch(/prev\.remeasureFoldedChild === next\.remeasureFoldedChild/);
	});
});
