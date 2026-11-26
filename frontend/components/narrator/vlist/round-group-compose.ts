/**
 * round-group-compose.ts — 把「轮折叠计划」变成真实的元素序列。纯函数，零 DOM。
 *
 * 装配点只有一个：`buildPretextDocumentLayout` 在 manifest 建好之后、返回之前。
 * 那时 `items` 已经是 `{ spec, measured }` 形态，每个元素的高度都已经算好了 ——
 * 所以合成既不需要重测，也不会影响任何其他元素的高度。
 *
 * 三个必须守住的约束：
 *   1. **只有在折叠条自身高度已知时才合成**。收起态高度是常量（measure 层给的），
 *      所以这一条总是成立；但展开态要等渲染层实测，因此合成时一律按**收起态**
 *      高度建 spec，展开后由实测覆盖。
 *   2. **不碰被折叠元素本身**。它们原样搬进 `folded` 数组，键、测量、身份全不变；
 *      只是不再出现在顶层序列里。这也意味着它们不再参与虚拟化 —— 折叠态的收益。
 *   3. **一段区间被折叠后，前后元素的 `unitStart` 要重算**。否则折叠条前会出现
 *      原本给「一段的起始」留的更大间隙，视觉上像多了一个空档。
 */

import type { MeasuredElement } from "@shared/pretext-layout/prepared-block";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import { type RoundGroupData, roundGroupHeaderHeight } from "./measure/measure-round-group";
import { planRoundFold, type RoundSegment, splitRoundSegments } from "./round-group";

/** 一个已就绪的列表项（spec + 已测高度），与 manifest 的产物同形。 */
export type ComposableItem = {
	spec: ElementSpec;
	measured: MeasuredElement;
};

export type ComposeRoundGroupsOptions = {
	/**
	 * 这个会话是不是子代理。
	 *
	 * 子代理的「用户」消息是父代理派发的任务（`origin="assistant"`），切轮判据
	 * 与主会话不同 —— 见 `isRoundStartSpec`。传 false / 不传按主会话处理。
	 */
	isSubagent?: boolean;
	/** 读者的「折叠已完成轮次」偏好（设置里可关）。 */
	enabled: boolean;
	/** 已由读者「提升为完整行」的轮（按轮首 spec 的 key 记）—— 这些轮整轮内联。 */
	expandedRoundKeys?: ReadonlySet<string>;
	/** 已由读者点开做盒内预览的轮（按轮首 spec 的 key 记）。 */
	previewRoundKeys?: ReadonlySet<string>;
	/** 判定「这个元素还在跑」的谓词；不给则按「没有活跃元素」处理。 */
	isLiveSpec?: (spec: ElementSpec) => boolean;
	/** 读元素时间（用于算这一轮跑了多久）。 */
	readTime?: (spec: ElementSpec) => number | undefined;
	/**
	 * 轮首 spec → 该轮时长（ms）。**首选来源**。
	 *
	 * 为什么需要它：折叠区间里只有用户气泡带 `createdAt`；工具卡的 data 不带时间戳，
	 * 最终回复是 markdown（data 就是一个纯字符串）。于是「轮首 → 收尾」两端永远取不
	 * 齐，折叠条只剩光秃秃的「已处理」—— 实测就是这样。后端的轮次索引已算好每轮用
	 * 时，这里按轮首查表；查不到才退回 {@link readTime} 的猜测式算法。
	 */
	readDuration?: (headSpec: ElementSpec) => number | undefined;
	/**
	 * 轮首 spec → 该轮 token 用量。查不到返回 undefined（那一轮不出 token 段）。
	 *
	 * 与 {@link readDuration} 同一来源（后端轮次索引），所以两者永远同源、不会一个
	 * 有一无。provider 不回报 usage 时后端就不写这个字段，这里自然为 undefined。
	 */
	readTokens?: (headSpec: ElementSpec) => number | undefined;
	/** 拼标题（宿主注入，负责本地化与 token 格式）。 */
	buildTitle: (input: {
		durationMs: number | undefined;
		tokens: number | undefined;
		segment: RoundSegment;
	}) => string;
};

/** 折叠条的稳定 key：以轮首元素的 key 派生，跨重排稳定。 */
export function roundGroupKey(segment: RoundSegment, specs: readonly ElementSpec[]): string {
	const head = specs[segment.startIndex];
	return `roundgroup-${head?.key ?? segment.roundIndex}`;
}

/**
 * 折叠条标题：`已处理 2m 14s · 12.3k token`。
 *
 * 两段都是**可选且独立**的：
 *   - 时长查不到（老数据没有时间戳）→ 只出 token，或退化成光秃秃的「已处理」；
 *   - token 查不到（provider 没回报 usage）→ 只出时长。
 * 绝不编数字：缺哪段就不写哪段。
 */
export function formatRoundFoldTitle(
	doneLabel: string,
	durationMs: number | undefined,
	tokens?: number | undefined,
): string {
	const parts: string[] = [];
	if (typeof durationMs === "number" && durationMs > 0) {
		parts.push(formatSpan(durationMs));
	}
	const tokenText = formatTokenCount(tokens);
	if (tokenText) parts.push(`${tokenText} token`);
	if (parts.length === 0) return doneLabel;
	return `${doneLabel} ${parts.join(" · ")}`;
}

/** 紧凑时长：45s / 2m 14s / 1h 5m。只接受正数（调用方已保证）。 */
function formatSpan(ms: number): string {
	const totalSec = Math.round(ms / 1000);
	if (totalSec < 1) return "<1s";
	if (totalSec < 60) return `${totalSec}s`;
	const minutes = Math.floor(totalSec / 60);
	const restSec = totalSec % 60;
	if (minutes < 60) return restSec > 0 ? `${minutes}m ${restSec}s` : `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	const restMin = minutes % 60;
	return restMin > 0 ? `${hours}h ${restMin}m` : `${hours}h`;
}

/**
 * token 紧凑文案：980 / 1.2k / 12.3k / 340k / 1.5M。非正数 → ""（不显示）。
 *
 * 千位以内保留一位小数直到整数部分到三位（`< 100`），再大就取整 —— 时间线那一行
 * 很短，一位小数是「这个数字大概多大」的唯一线索，但 340.0k 就只是噪音了。
 */
export function formatTokenCount(tokens: number | undefined): string {
	if (typeof tokens !== "number" || !Number.isFinite(tokens) || tokens <= 0) return "";
	if (tokens < 1000) return String(Math.round(tokens));
	if (tokens < 1_000_000) {
		const value = tokens / 1000;
		return `${value < 100 ? value.toFixed(1) : Math.round(value)}k`;
	}
	const value = tokens / 1_000_000;
	return `${value < 100 ? value.toFixed(1) : Math.round(value)}M`;
}

/**
 * 把元素序列按轮折叠计划重写。
 *
 * 返回新数组；没有任何一轮被折时**返回原引用**（调用方可据此跳过下游重算）。
 */
export function composeRoundGroups(
	items: readonly ComposableItem[],
	options: ComposeRoundGroupsOptions,
): readonly ComposableItem[] {
	const specs = items.map((item) => item.spec);
	const segments = splitRoundSegments(specs, { isSubagent: options.isSubagent });
	// 先算出每一轮要折的区间（与 splitRoundSegments 一一对应）。
	const plans: Array<{ segment: RoundSegment; foldFrom: number; foldTo: number }> = [];
	for (const segment of segments) {
		const headKey = specs[segment.startIndex]?.key;
		const fold = planRoundFold(specs, segment, {
			enabled: options.enabled,
			expanded: headKey ? options.expandedRoundKeys?.has(headKey) : false,
			isLiveSpec: options.isLiveSpec,
		});
		if (fold) plans.push({ segment, ...fold });
	}
	if (plans.length === 0) return items;

	// 按区间起点排序后一遍扫描重写。
	plans.sort((a, b) => a.foldFrom - b.foldFrom);
	const out: ComposableItem[] = [];
	let cursor = 0;
	let planIndex = 0;

	while (cursor < items.length) {
		const plan = plans[planIndex];
		if (!plan || cursor !== plan.foldFrom) {
			out.push(items[cursor]!);
			cursor += 1;
			continue;
		}
		// 折叠 [foldFrom, foldTo)：轮首（foldFrom-1）与最终回复（foldTo）留在外面。
		const folded = items.slice(plan.foldFrom, plan.foldTo);
		const head = specs[plan.segment.startIndex];
		// 时长与 token：都先问后端索引（唯一可靠来源），查不到才退回按元素时间猜。
		const durationMs =
			(head ? options.readDuration?.(head) : undefined) ??
			(options.readTime ? spanOf(folded, specs, plan.segment, options.readTime) : undefined);
		const tokens = head ? options.readTokens?.(head) : undefined;
		const headerHeight = roundGroupHeaderHeight();
		const data: RoundGroupData = {
			title: options.buildTitle({ durationMs, tokens, segment: plan.segment }),
			childCount: folded.length,
		};
		out.push({
			spec: {
				kind: "round-group",
				key: roundGroupKey(plan.segment, specs),
				// `unitId` 让 LOD morph 把「折叠条」和「展开后的内容」认作同一处 ——
				// 但两者元素数不同，是 1:N，因此不设（见 CONTRACT §4.7 的 1:N 说明）。
				// 轮首的 key 作为身份凭据挂在 data 上，供展开态按键托管。
				data: {
					...data,
					roundKey: head?.key ?? "",
					// 折叠进去的元素本身也挂在 data 上：渲染层要按「原样」把它们画出来
					// （每个仍是自己的 RenderXxx），而 shell 只能拿到 spec，拿不到
					// 已从顶层序列里移除的那一段。键与测量都在这里，渲染时直接用。
					folded,
				},
				// `unitStart` 让折叠条充当一段的起点（它原本折掉的首元素可能带这个标记）。
				...(items[plan.foldFrom]?.spec.unitStart ? { unitStart: true } : {}),
				// 折叠块本身不再进任何折叠组（它已经是折叠结果）。
				//
				// `open` 决定收起 / 盒内预览两态。第三种态（提升为完整行）不产生
				// 这个元素 —— 那一轮的 `planRoundFold` 已经被 expandedRoundKeys 拒掉，
				// 内容回到顶层正常行。
				opts: {
					open: options.previewRoundKeys?.has(head?.key ?? "") === true,
				},
			},
			measured: {
				height: headerHeight,
				blocks: [],
				frame: { blocks: [], contentHeight: headerHeight, usedWidth: 0 },
				contentWidth: 0,
				usedWidth: 0,
			},
		});
		cursor = plan.foldTo;
		planIndex += 1;
	}

	return out;
}

/**
 * 一轮的时长：轮首 → 最终回复。
 *
 * ⚠️ 不能用「轮首 + 最终回复两项」直接相减：最终回复是 `markdown`，它的 data
 * 就是一个纯字符串（`block.text`），**不带时间戳**，于是两端永远取不齐、时长
 * 恒为 undefined（实测就是这样：折叠条只剩光秃秃的「已处理」）。
 *
 * 正确做法是：起点取轮首气泡的时间，终点取**折叠区间里最后一个带时间戳的元素**
 * （工具卡 / 系统卡都带 createdAt，通常紧邻最终回复）。取不到就退化成无时长。
 */
function spanOf(
	folded: readonly ComposableItem[],
	specs: readonly ElementSpec[],
	segment: RoundSegment,
	readTime: (spec: ElementSpec) => number | undefined,
): number | undefined {
	const head = specs[segment.startIndex];
	const start = head ? readTime(head) : undefined;
	if (typeof start !== "number") return undefined;

	// 从最终回复往前找，第一个有时间戳的元素就是这一轮的收尾时刻。
	// 先看最终回复自己（某些形态确实带时间），再退进折叠区间。
	const tailCandidates: ElementSpec[] = [];
	const finalSpec = segment.finalReplyIndex >= 0 ? specs[segment.finalReplyIndex] : undefined;
	if (finalSpec) tailCandidates.push(finalSpec);
	for (let i = folded.length - 1; i >= 0; i--) tailCandidates.push(folded[i]!.spec);

	let end: number | undefined;
	for (const spec of tailCandidates) {
		const at = readTime(spec);
		if (typeof at === "number") {
			end = at;
			break;
		}
	}
	if (typeof end !== "number") return undefined;
	const span = end - start;
	return span > 0 ? span : undefined;
}
