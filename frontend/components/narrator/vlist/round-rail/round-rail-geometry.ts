/**
 * round-rail-geometry.ts — 导航轨的纯几何与高亮判据。纯算，零 DOM，可进 PURE_PATH_FILES。
 *
 * 三个决定，全部抽出来单测，因为它们错起来都是**静默的**：
 *   1. 轨道窗口（只露 N 根，跟着当前轮滚）—— 错了就是「往上翻到更早的轮却没有横条」；
 *   2. 悬停指针 → 第几轮（横条之间有间隙，按最近的算）—— 错了就是「点到的不是看着的那轮」；
 *   3. 摘要卡顶边（中线对准横条，到屏幕边缘夹住）—— 错了就是卡片飞出视口。
 *
 * 与 Vantaloom 的同名模块对应，但少一级高亮判据（见 {@link resolveActiveRoundIndex}
 * 的注释）。
 */

import type { NarratorRound } from "@shared/narrator-rounds";

/** 一根横条的纵向节距（px）：本体高 + 间隙。改样式时这里一起改。 */
export const TICK_HEIGHT_PX = 3;
export const TICK_PITCH_PX = 10;
/** 默认根数；量不到可用高度前先按它画。 */
export const RAIL_DEFAULT_TICKS = 24;
/** 再矮也至少画这么多根。 */
export const RAIL_MIN_TICKS = 8;
/** 当前轮离窗口上下边缘不到这么多根时，窗口才跟着挪。 */
export const RAIL_EDGE_MARGIN = 3;
/** 横条底下留的空（px）。 */
export const RAIL_BOTTOM_GAP_PX = 24;
/** 触控/无悬停形态下，就地展开列表的最大高（px）。 */
export const RAIL_LIST_MAX_HEIGHT_PX = 320;

/**
 * 轨道窗口的起点。
 *
 * 只在当前轮越过边缘 margin 时挪窗口，而不是每过一轮就居中——后者会让整列
 * 在滚动时不停地一格格滑动。没有当前轮（`activeIndex < 0`）时原地不动。
 *
 * 结果幂等：对自己的输出再算一遍得到同一个值，因此可以在渲染期安全地据此
 * 更新 state（不会来回翻）。
 */
export function railWindowStart(
	prevStart: number,
	activeIndex: number,
	total: number,
	size: number,
	margin: number,
): number {
	const maxStart = Math.max(0, total - size);
	let start = clamp(Math.trunc(prevStart), 0, maxStart);
	if (activeIndex >= 0 && total > size) {
		// margin 不能超过半个窗口，否则上下两条规则会互相顶。
		const edge = Math.max(0, Math.min(margin, Math.floor((size - 1) / 2)));
		if (activeIndex < start + edge) {
			start = activeIndex - edge;
		} else if (activeIndex > start + size - 1 - edge) {
			start = activeIndex - (size - 1 - edge);
		}
	}
	return clamp(start, 0, maxStart);
}

/** 按可用高度算能画几根（量不到时给默认值）。 */
export function railCapacity(availablePx: number): number {
	if (!Number.isFinite(availablePx) || availablePx <= 0) return RAIL_DEFAULT_TICKS;
	const room = availablePx - RAIL_BOTTOM_GAP_PX;
	// 最后一根不需要完整节距。
	const fit = Math.floor((room + (TICK_PITCH_PX - TICK_HEIGHT_PX)) / TICK_PITCH_PX);
	return Math.max(RAIL_MIN_TICKS, fit);
}

/** 指针的 y 落在第几个横条中心附近；都够不着 → -1。 */
export function nearestTickIndex(tickCenters: readonly number[], y: number): number {
	let best = -1;
	let bestDistance = Number.POSITIVE_INFINITY;
	for (let i = 0; i < tickCenters.length; i++) {
		const center = tickCenters[i]!;
		// 未挂载 / 窗口外的横条由调用方标成 NaN，跳过。
		if (!Number.isFinite(center)) continue;
		const distance = Math.abs(center - y);
		if (distance < bestDistance) {
			best = i;
			bestDistance = distance;
		}
	}
	return best;
}

/**
 * 摘要卡的顶边（视口坐标）：让卡片中线对准 `anchorY`，再夹进 `[minTop, maxBottom]`。
 * 夹住之后中间那一轮仍是指着的那一轮（只是卡片不再严格居中）。
 */
export function pickerCardTop(
	anchorY: number,
	cardHeight: number,
	minTop: number,
	maxBottom: number,
): number {
	const top = anchorY - cardHeight / 2;
	const maxTop = maxBottom - cardHeight;
	if (maxTop < minTop) return minTop;
	return clamp(top, minTop, maxTop);
}

/**
 * 视口顶部那条消息属于哪一轮 —— 返回 `rounds` 里的下标，-1 = 判不出。
 *
 * 判据只有两级，比 Vantaloom 少一级：
 *  1. **seq 位置**：`round.seq <= atSeq` 的最后一轮。这是正常路径。
 *  2. **位置兜底**：窗口从半轮开始、一个轮首都没加载时，取第一个「轮首 seq > atSeq」
 *     的**上一轮**；连这个都没有就亮第一轮。
 *
 * 为什么不需要 Vantaloom 的第三级（按事件 id 前缀匹配）：它那一级是为了救
 * 「前端合成的折叠组行不带 runId 前缀」的 bug；nfk 这边合成行自带 `roundSeq`，
 * 视口上报直接给出 seq，结构上不存在那个失效路径。
 */
export function resolveActiveRoundIndex(
	rounds: readonly Pick<NarratorRound, "seq">[],
	atSeq: number | undefined,
): number {
	if (rounds.length === 0 || typeof atSeq !== "number") return -1;
	let bySeq = -1;
	for (let i = 0; i < rounds.length; i++) {
		if (rounds[i]!.seq <= atSeq) bySeq = i;
	}
	if (bySeq >= 0) return bySeq;
	// 所有轮首都比当前内容更晚：说明看到的是最早那一轮之前的内容。
	return 0;
}

function clamp(value: number, min: number, max: number): number {
	if (!Number.isFinite(value)) return min;
	if (max < min) return min;
	return value < min ? min : value > max ? max : value;
}
