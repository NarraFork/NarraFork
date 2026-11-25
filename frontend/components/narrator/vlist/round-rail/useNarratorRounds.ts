"use client";

/**
 * useNarratorRounds.ts — 导航轨的数据钩子。
 *
 * 两条要求决定了形状：
 *   1. **列出整个会话的轮**，与前端加载了多少消息无关 —— 数据来自后端索引，
 *      不是从已加载消息里现拼。
 *   2. **新发的消息要立刻出现**，不能每条都重取索引 —— 会话进行中用户刚发一句，
 *      导航轨必须马上多一根横条。
 *
 * 做法与 Vantaloom 的 `buildTimelineRounds` 同源：索引给「历史上有哪些轮」，
 * 本地消息给「索引之后又多了哪些轮」，两者按 seq 归并去重。
 */

import { narratorRoundsApi } from "@frontend/lib/api/narrator-rounds";
import type { NarratorRound } from "@shared/narrator-rounds";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";

/** 一次取多少轮。导航轨不翻很远，百来根足够，按需再取。 */
const ROUNDS_PAGE_SIZE = 200;

export const narratorRoundsQueryKey = (narratorId: string) =>
	["narrator-rounds", narratorId] as const;

/**
 * 稳定的空数组。
 *
 * ⚠️ 不能用 `?? []` 写字面量：那会在每次渲染产出一个**新引用**，而这个 hook 的
 * `rounds` 是下游 `useMemo` 的依赖（折叠配置 → 文档重建）。新引用 = 每帧都判定
 * 「变了」→ 重建 → 再渲染 → 又是新引用，直接撞 React #185（实测踩到过）。
 */
const EMPTY_ROUNDS: NarratorRound[] = [];

/**
 * 拉取轮次索引。
 *
 * `staleTime: Infinity` + 显式 invalidate：轮次集合只在「有新的一轮」或「有轮
 * 收尾（拿到回复时间）」时变，那两件事由调用方在合适时机 invalidate，比每次
 * 挂载都重取更省。
 */
export function useNarratorRounds(narratorId: string | undefined) {
	const query = useQuery({
		queryKey: narratorRoundsQueryKey(narratorId ?? ""),
		queryFn: () => narratorRoundsApi.rounds(narratorId!, { limit: ROUNDS_PAGE_SIZE }),
		enabled: Boolean(narratorId),
		staleTime: Number.POSITIVE_INFINITY,
		// 索引取不到不该把轨道变成错误态：空轮次表让轨道自己隐藏。
		retry: false,
	});

	return {
		// 引用稳定的空值：见 EMPTY_ROUNDS 的说明。
		rounds: query.data?.rounds ?? EMPTY_ROUNDS,
		// `hasMore` 故意不外露：轨道没有向上翻页入口，返回它只会让调用方误以为
		// 有分页能力。超过 ROUNDS_PAGE_SIZE 的旧轮是已知边界（>200 轮的会话，
		// 轨道只覆盖最近 200 轮）。
		refetch: query.refetch,
		isLoading: query.isLoading,
	};
}

/**
 * 把「索引里的历史轮」与「本地已加载消息里新增的轮」合并。
 *
 * 为什么需要这一层：索引是快照，用户在这之后发的新一轮还不在里面。不合并的话
 * 导航轨会一直少最后一根，直到有人手动刷新 —— 而这正是读者最常看的那一轮。
 *
 * `local` 由调用方从已加载的消息序列切出来（用 `splitRoundSegments`），只带
 * `seq` / `startedAt` 等已加载信息；同 seq 时**索引优先**（它有回复时间）。
 */
export function mergeRounds(
	indexed: readonly NarratorRound[],
	local: readonly NarratorRound[],
): NarratorRound[] {
	if (local.length === 0) return [...indexed];
	const known = new Set(indexed.map((round) => round.seq));
	const extra = local.filter((round) => !known.has(round.seq));
	if (extra.length === 0) return [...indexed];
	// 按 seq 升序合并（索引本身已是升序）。
	return [...indexed, ...extra].sort((a, b) => a.seq - b.seq);
}

/**
 * 局部更新某一轮（拿到回复时间 / token 后）。返回新数组；没这一轮则原样返回。
 *
 * 用它而不是整表 refetch：一轮收尾时只要改它自己那一行，重取整个索引会让
 * 导航轨在滚动中闪一下。
 */
export function patchRound(
	rounds: readonly NarratorRound[],
	seq: number,
	patch: Partial<Omit<NarratorRound, "seq" | "messageId">>,
): NarratorRound[] {
	let changed = false;
	const next = rounds.map((round) => {
		if (round.seq !== seq) return round;
		changed = true;
		return { ...round, ...patch };
	});
	return changed ? next : [...rounds];
}

/** 记忆化版合并：索引与本地列表引用不变时不重算（轨道是每帧都要用的）。 */
export function useMergedRounds(
	indexed: readonly NarratorRound[],
	local: readonly NarratorRound[],
): NarratorRound[] {
	return React.useMemo(() => mergeRounds(indexed, local), [indexed, local]);
}
