/**
 * measure-round-group.ts — 整轮折叠条（「已处理 2m 14s · 12.3k token」）的高度。
 *
 * ⚠️ 这是本功能与 Vantaloom 最关键的设计分歧，也是有意的分歧：
 *
 * 折叠条的**收起态高度是常量**（一行：chevron + 单行文本），完全不需要测量。
 * **展开态高度不在这里预测** —— 展开体是几十个已有的列表元素，逐个预测等于把
 * 整个高度模型重算一遍，且任何一个元件的测量与实际不符都会在这里放大成整轮错位。
 * 它由渲染层实测回填（`round-fold-heights.ts`，与 `vlist-trace-unknown-heights`
 * 同范式）。
 *
 * 因此本模块是纯算、零 DOM，可进 PURE_PATH_FILES。
 */

import type {
	MeasuredElement,
	PreparedBlock,
	RenderLod,
} from "@shared/pretext-layout/prepared-block";
import { traceMetrics } from "./measure-tool-run";

/** 折叠条的数据（由 adapter 在合成事件时填好）。 */
export type RoundGroupData = {
	/** 已拼好的标题（"已处理 2m 14s · 12.3k token"）。 */
	title: string;
	/** 折叠里的元素个数（零个时不该合成这个元素，见 round-group.ts）。 */
	childCount: number;
};

/** 折叠条的展开态（读者点开过）。 */
export type RoundGroupExpandState = {
	open?: boolean;
};

const EMPTY_FRAME = { blocks: [], contentHeight: 0, usedWidth: 0 } as const;

/**
 * 折叠条收起态高度：一行 xs 文本 + 上下各 2px（与 TraceRow / count line 同一套
 * 排版常量，跟随读者的行距设置 —— 所以必须读 `traceMetrics()`，不能硬编码 17）。
 */
export function roundGroupHeaderHeight(): number {
	return traceMetrics().countLineHeight;
}

/**
 * 测量一轮折叠条。
 *
 * 三态：
 *   - **收起**：一行头部，常量。
 *   - **盒内预览**（`open`）：头部 + 一个占位的预览高度。真实高度**不预测** ——
 *     预览体是几十个既有元素，逐个预测等于重算整个高度模型，任何一处不符都会
 *     放大成整轮错位。它由渲染层实测后经 shell 的 `heightOverrides` 覆盖
 *     （`round-fold-heights` 提供「只认同一个 body 对象的读数」那层防线）。
 *   - **提升为完整行**：这一态不产生 `round-group` 元素（整轮回到内联），
 *     所以测量函数永远看不到它。
 *
 * @param data        折叠条数据（标题/子元素数）
 * @param contentWidth 可用外宽
 * @param lod         渲染细节档位（L6 = 全展开档，此时不该有这个元素）
 * @param expandState `open` = 盒内预览中
 */
export function measureRoundGroup(
	_data: RoundGroupData,
	contentWidth: number,
	_lod: RenderLod = 4,
	expandState: RoundGroupExpandState = {},
): MeasuredElement {
	const headerHeight = roundGroupHeaderHeight();
	if (!expandState.open) {
		return {
			height: headerHeight,
			blocks: [] as PreparedBlock[],
			frame: { ...EMPTY_FRAME, blocks: [] },
			contentWidth,
			usedWidth: contentWidth,
			roundPreviewOpen: false,
		} as MeasuredElement;
	}
	// 预览态：头部 + 首帧占位高度。这个值只是一个下界 —— 实测到位后被覆盖，
	// 所以它不需要精确，只要「不为 0」以保证读者看到有东西展开了。
	const previewHeight = headerHeight + ROUND_PREVIEW_PLACEHOLDER_HEIGHT;
	return {
		height: previewHeight,
		blocks: [] as PreparedBlock[],
		frame: { ...EMPTY_FRAME, blocks: [], contentHeight: previewHeight },
		contentWidth,
		usedWidth: contentWidth,
		// 让 shell 把这一行认成动态行（预览高度靠实测覆盖）。
		roundPreviewOpen: true,
	} as MeasuredElement;
}

/**
 * 盒内预览的首帧占位高度（px）。
 *
 * 故意给一个**偏小**的值而不是估算出来的内容高：占位只是让首帧有高度，
 * 实测在下一帧到达并覆盖。给偏大的值会让预览下方的内容先被推下去再收回来。
 */
export const ROUND_PREVIEW_PLACEHOLDER_HEIGHT = 80;

/** 折叠条自身高度与档位无关；保留此函数仅为兼容既有调用方。 */
export function roundFoldDisabledAtLod(_lod: RenderLod): boolean {
	// 折叠不再绑档位：它是独立开关（`narrafork_round_folding`），任意 LOD 都能开/关。
	return false;
}

export type { RoundGroupData as default };
