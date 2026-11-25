/**
 * round-group.ts — 「一轮」的切分与折叠计划。纯函数，零 DOM，可进 PURE_PATH_FILES。
 *
 * 两个职责，都只依赖元素 spec 序列：
 *   1. {@link splitRoundSegments} 把列表切成轮（与后端 `/rounds` 判据逐条对应）；
 *   2. {@link planRoundFold} 决定某一轮折不折、折哪一段。
 *
 * 为什么放在这里而不是 adapter 内部：导航轨与折叠必须用**同一份**切点，
 * 否则轨道上的「第 3 轮」和折叠出的那个 pill 会指向不同内容。Vantaloom 那边
 * 就因为两处各写一份切点漂移过。
 *
 * ⚠️ 与后端 `GET /api/narrators/:id/rounds` 的对应关系（改一处必须改另一处）：
 *   - `role === "user"`
 *   - `origin` 是 null / "user"（排除自动续跑、review 启动等系统代发）
 *   - 不是压缩点
 * 详见 `@shared/narrator-rounds`。
 */

import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";

/** 一轮在 spec 序列里的位置。 */
export type RoundSegment = {
	/** 轮首用户气泡在序列里的下标。 */
	startIndex: number;
	/** 序列里最后一个元素的**后一位**（不含）。 */
	endIndex: number;
	/** 该轮最后一条 assistant 回复的下标；-1 = 还没回复 / 没有文本回复。 */
	finalReplyIndex: number;
	/** 该轮的序号（0 起，只对本序列内计数）。 */
	roundIndex: number;
};

/** 切轮时用到的用户气泡 data 子集。 */
type UserBubbleData = {
	role?: unknown;
	origin?: unknown;
	bodyFormat?: unknown;
};

/**
 * 该元素是不是「一轮的开始」（用户消息）。
 *
 * ⚠️ `origin` 判据要**区分会话类型**，这是曾经漏掉的一处：
 *   - 主会话：只认 `null`（本列引入前的老数据）/ `"user"`。自动续跑与 review 启动
 *     是 `origin="system"`，它们是同一轮里的动作，不是新的一轮 —— 不排除就会把一轮
 *     切成几十轮。
 *   - **子代理会话**：它的「用户」消息就是父代理派发的任务，`origin="assistant"`
 *     （实测：子代理的 user 消息 100% 是这个来源）。若沿用主会话的判据，子代理
 *     永远切不出轮，整轮折叠在子代理里完全不工作。
 *
 * 所以接受 `assistant` 只对子代理成立：由调用方通过 `isSubagent` 声明会话类型，
 * 而不是靠猜 —— 主会话里 `origin="assistant"`（ForkNarrator / 群聊注入）确实不该
 * 单独成轮。
 */
export function isRoundStartSpec(spec: ElementSpec, options?: { isSubagent?: boolean }): boolean {
	// 子代理的轮首**不是**用户气泡：`segment-adapter` 把父代理派发任务那条 user
	// 消息刻意画成注入卡或低对比度来源卡（画成用户气泡会让作者归属含糊），而它的
	// 最终形态取决于 origin、有没有结构化 injection 块与投影策略 —— 靠 `kind` 反推
	// 必然漏。所以 adapter 在产生 spec 时就写好答案（`roundStart`），这里优先读它。
	//
	// 实测走过两轮弯路：只看 `message-bubble` → 子代理永远切不出轮；再补
	// `system-text`+`origin_notice` → 只覆盖了老式 Send 行，新式结构化注入仍漏。
	if (options?.isSubagent === true) {
		const marked = spec.data as { roundStart?: unknown } | null | undefined;
		if (marked && typeof marked === "object" && marked.roundStart === true) return true;
	}
	if (spec.kind !== "message-bubble") return false;
	const data = spec.data as UserBubbleData | null | undefined;
	if (!data || typeof data !== "object") return false;
	if (data.role !== "user") return false;
	const origin = data.origin;
	if (origin === null || origin === undefined || origin === "user") return true;
	if (options?.isSubagent === true && origin === "assistant") return true;
	return false;
}

/**
 * 该元素算不算「这一轮的最终回复」。
 *
 * 只认 markdown（assistant 正文）。tool-call / activity-trace / reasoning 等
 * 都是过程内容，要被折进 pill 里。**不收 `turn-usage` / `system-simple`**：
 * 它们常常排在一轮末尾，被当成最终回复会让 pill 折到它们前面，正文反而露在外面。
 */
export function isFinalReplySpec(spec: ElementSpec): boolean {
	return spec.kind === "markdown";
}

/**
 * 把元素序列切成轮。
 *
 * 第一个轮首之前的元素（会话开头的 system 卡、fork 说明等）不属于任何轮，
 * 直接跳过——它们不该出现在导航轨上，也不该被任何 pill 吞掉。
 */
export function splitRoundSegments(
	specs: readonly ElementSpec[],
	options?: { isSubagent?: boolean },
): RoundSegment[] {
	const starts: number[] = [];
	for (let i = 0; i < specs.length; i++) {
		if (isRoundStartSpec(specs[i]!, options)) starts.push(i);
	}
	const out: RoundSegment[] = [];
	for (let n = 0; n < starts.length; n++) {
		const startIndex = starts[n]!;
		const endIndex = n + 1 < starts.length ? starts[n + 1]! : specs.length;
		// 该轮最后一条 assistant 正文，但要严格在轮首之后（轮首自己是 user 气泡）。
		let finalReplyIndex = -1;
		for (let i = endIndex - 1; i > startIndex; i--) {
			if (isFinalReplySpec(specs[i]!)) {
				finalReplyIndex = i;
				break;
			}
		}
		out.push({ startIndex, endIndex, finalReplyIndex, roundIndex: n });
	}
	return out;
}

/**
 * 本轮还没跑完（读起来是在进行中）。
 *
 * 判据只用 spec 上已有的、只看呈现的信号：末尾存在流式中的正文，或仍处于
 * 活跃态的卡片。**不看「有没有最终回复」**——那是 {@link planRoundFold} 的事，
 * 这里回答的是「读者此刻是不是正看着它工作」。
 */
export function isRoundLive(
	specs: readonly ElementSpec[],
	segment: RoundSegment,
	isLiveSpec: (spec: ElementSpec) => boolean,
): boolean {
	for (let i = segment.startIndex; i < segment.endIndex; i++) {
		if (isLiveSpec(specs[i]!)) return true;
	}
	return false;
}

/** 折叠段至少要藏住几个元素才值得折（1 = 有东西藏就折）。 */
export const ROUND_FOLD_MIN = 1;

/**
 * 决定这一轮折不折、折哪一段。返回 null = 整轮内联。
 *
 * 三条不折：
 *   1. **没有最终回复** —— 还在跑 / 出错中断。折叠一个没有结论的轮，读者点开
 *      只能看到半截过程。
 *   2. **有活跃元素** —— 正看着它工作的时候折起来是反读者的。
 *   3. **折叠段太短** —— `finalReplyIndex` 紧贴轮首（`<= startIndex + 1`），
 *      折了也只是把一行换成一行。
 *
 * 折叠区间是 `[startIndex + 1, finalReplyIndex)`：轮首用户气泡与最终回复
 * 都留在外面，于是一轮读起来是「我提的问题 → 已处理 pill → 它的结论」。
 */
export function planRoundFold(
	specs: readonly ElementSpec[],
	segment: RoundSegment,
	options?: {
		/** 读者手动展开了这一轮。 */
		expanded?: boolean;
		/** 单功能开关（设置里可关）。 */
		enabled?: boolean;
		isLiveSpec?: (spec: ElementSpec) => boolean;
	},
): { foldFrom: number; foldTo: number } | null {
	if (options?.enabled === false) return null;
	// 折叠与渲染档位无关：它现在是独立开关（`narrafork_round_folding`），任意
	// 档位都能开/关。曾经把「不折」绑在最高档上，结果是 L5 想折没得折、L1 想展开
	// 又得切档位 —— 「想不想看已完成轮的过程」和「每行要多少细节」是两个问题。
	if (options?.expanded) return null;

	const finalReplyIndex = segment.finalReplyIndex;
	// 规则 1：没有最终回复。
	if (finalReplyIndex < 0) return null;
	// 规则 3：折叠段太短。
	const foldFrom = segment.startIndex + 1;
	const foldTo = finalReplyIndex;
	if (foldTo - foldFrom < ROUND_FOLD_MIN) return null;
	// 规则 2：有活跃元素（调用方没给谓词就按「没有活跃元素」处理）。
	if (options?.isLiveSpec && isRoundLive(specs, segment, options.isLiveSpec)) return null;

	return { foldFrom, foldTo };
}

/** 一轮的时长（毫秒），由两端元素的时间求差。缺任一端 / 非递增 → undefined。 */
export function roundSpanMs(
	specs: readonly ElementSpec[],
	segment: RoundSegment,
	readTime: (spec: ElementSpec) => number | undefined,
): number | undefined {
	const start = readTime(specs[segment.startIndex]!);
	const end = segment.finalReplyIndex >= 0 ? readTime(specs[segment.finalReplyIndex]!) : undefined;
	if (typeof start !== "number" || typeof end !== "number") return undefined;
	const span = end - start;
	return span > 0 ? span : undefined;
}
