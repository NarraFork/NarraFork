/**
 * round-fold-heights.ts — 整轮折叠条展开态的**实测回填**。纯算，零 DOM。
 *
 * 这是「ResizeObserver 重量」的收敛点，也是本功能唯一允许出现实测的地方
 * （实测在 `render/RenderRoundGroup.tsx`，不在 measure 纯路径里）。
 *
 * 范式与 `vlist-trace-unknown-heights.ts` 完全一致，理由也一致：
 *   - **缓存内的测量值保持不可变**：回填不改写缓存的 MeasuredElement，只构造
 *     一个新的；
 *   - **纯局部 reflow**：只把实测高写进被展开的那一条，并把它**之后**的行的
 *     `top` 与总高按位移修正 —— 之前的行逐字节不变（vlist 铁律 1：已提交的行
 *     不得移动）；
 *   - **读数带来源引用**：`bodyRef` 记录上报时看到的是哪个 body 对象。换 LOD /
 *     换了形态 / 换了宽度之后 body 会是另一个对象，旧读数就此失效，不会被
 *     误用到新形态上（这是 `retainTraceUnknownHeights` 的同一道防线）。
 *
 * 与 unknown-heights 的一个差别：那边修正的是 trace **内部的 row**，这里修正的
 * 是**顶层列表项之间**的位移，所以没有 rows/frame.blocks 两层，只有一次位移。
 */

import type { MeasuredElement } from "@shared/pretext-layout/prepared-block";

export type RoundFoldHeight = {
	/** 上报时这个 body 是哪个对象（换形态即失效的身份凭据）。 */
	bodyRef: MeasuredElement;
	/** 展开体的自然高度（不含折叠条头部）。 */
	height: number;
};

export type RoundFoldHeights = ReadonlyMap<string, RoundFoldHeight>;

/**
 * 只保留仍然成立的读数：`body` 对象没变、且高度是有限正数。
 *
 * 什么时候会失效：换 LOD（展开体换形态）、宽度变化（换行数变了）、轮被折叠
 * （展开体卸载 → 不再上报）。留着旧读数会让下一次展开先闪一下旧高度。
 */
export function retainRoundFoldHeights(
	current: ReadonlyMap<string, MeasuredElement>,
	heights: RoundFoldHeights,
): RoundFoldHeights {
	let next: Map<string, RoundFoldHeight> | undefined;
	for (const [key, entry] of heights) {
		if (current.get(key) === entry.bodyRef && Number.isFinite(entry.height) && entry.height > 0) {
			continue;
		}
		next ??= new Map(heights);
		next.delete(key);
	}
	return next ?? heights;
}

/**
 * 把实测高回填进元素，并把它之后的行按位移修正。
 *
 * 每个返回的元素额外带一个 `foldShift`（该元素相对原位置的纵向位移）。调用方
 * 用它收口总高：`总高 = Σ(最终 height)`，或等价地 `原总高 + Σ delta`。分开算
 * 是因为本函数只负责单元素；整份文档的几何由 shell 统一提交（与
 * `applyTraceUnknownHeights` 返回 `height + shift` 同一口径）。
 *
 * @param items  当前渲染元素序列（顺序即文档顺序）
 * @param heights 实测表
 * @returns 新数组；没有任何一条命中时**返回原数组**（引用相等，调用方可据此跳过重算）
 */
export function applyRoundFoldHeights<T extends MeasuredElement & { key: string }>(
	items: readonly T[],
	heights: RoundFoldHeights,
): ReadonlyArray<T & { foldShift: number }> {
	// 快速路径：没有任何读数时不做任何分配（这是日常状态 —— 折叠默认收起，
	// 一次实测都没有）。
	if (heights.size === 0) {
		return items as unknown as ReadonlyArray<T & { foldShift: number }>;
	}

	let shift = 0;
	return items.map((item) => {
		const entry = heights.get(item.key);
		// 只认同一个 body 对象的读数（见文件头）。
		const applies = entry !== undefined && entry.bodyRef === item;
		if (!applies) {
			// 位移只影响位置，不影响自身高度。
			return shift === 0 ? { ...item, foldShift: 0 } : { ...item, foldShift: shift };
		}
		const delta = entry.height - item.height;
		const corrected = { ...item, height: item.height + delta, foldShift: shift };
		shift += delta;
		return corrected;
	});
}
