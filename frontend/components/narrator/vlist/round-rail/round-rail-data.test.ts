/**
 * round-rail-data.test.ts — 轮次合并与收藏持久化的纯逻辑。
 *
 * 合并的失败方式是静默的：漏掉新轮（导航轨一直少最后一根）或重复一根
 * （同一轮在轨道上出现两次），两种都不会报错。
 */

import { describe, expect, it } from "bun:test";
import type { NarratorRound } from "@shared/narrator-rounds";
import {
	formatRoundClock,
	formatRoundMeta,
	formatRoundSpan,
	formatRoundSummary,
	formatTokenCount,
	shouldShowRoundRail,
} from "./RoundRail";
import {
	normalizeRoundFavorites,
	roundFavoritesKey,
	toggleRoundFavorite,
} from "./round-rail-favorites";
import { mergeRounds, patchRound } from "./useNarratorRounds";

function round(seq: number, extra: Partial<NarratorRound> = {}): NarratorRound {
	return {
		seq,
		messageId: `msg-${seq}`,
		userText: `第 ${seq} 轮`,
		startedAt: 1000 * seq,
		repliedAt: null,
		...extra,
	};
}

describe("mergeRounds", () => {
	it("索引之后新发的轮补在末尾", () => {
		const merged = mergeRounds([round(1), round(2)], [round(3)]);
		expect(merged.map((r) => r.seq)).toEqual([1, 2, 3]);
	});

	it("同 seq 时索引优先（它有回复时间）", () => {
		const indexed = [round(1, { repliedAt: 5000 })];
		const local = [round(1, { repliedAt: null, userText: "本地版" })];
		const merged = mergeRounds(indexed, local);
		expect(merged).toHaveLength(1);
		expect(merged[0]!.repliedAt).toBe(5000);
		expect(merged[0]!.userText).toBe("第 1 轮");
	});

	it("完全重复的本地轮不会让轨道多一根", () => {
		const merged = mergeRounds([round(1), round(2)], [round(1), round(2)]);
		expect(merged).toHaveLength(2);
	});

	it("本地为空 → 原样返回索引", () => {
		const indexed = [round(1)];
		expect(mergeRounds(indexed, [])).toEqual(indexed);
	});

	it("结果是 seq 升序（即使本地轮 seq 更小）", () => {
		const merged = mergeRounds([round(5)], [round(3)]);
		expect(merged.map((r) => r.seq)).toEqual([3, 5]);
	});
});

describe("patchRound", () => {
	it("只改目标轮", () => {
		const rounds = [round(1), round(2)];
		const next = patchRound(rounds, 2, { repliedAt: 9000, tokens: 100 });
		expect(next[1]).toMatchObject({ seq: 2, repliedAt: 9000, tokens: 100 });
		expect(next[0]).toEqual(rounds[0]!);
	});

	it("没有这一轮 → 返回等值新数组（不改原数组）", () => {
		const rounds = [round(1)];
		const next = patchRound(rounds, 99, { repliedAt: 1 });
		expect(next).toEqual(rounds);
		expect(next).not.toBe(rounds);
	});
});

describe("收藏持久化", () => {
	it("存储键按叙述者隔离", () => {
		expect(roundFavoritesKey("n1")).not.toBe(roundFavoritesKey("n2"));
		expect(roundFavoritesKey(undefined)).toBe("");
	});

	it("收敛非法值（只认非负整数）", () => {
		const set = normalizeRoundFavorites([1, 2, 2, -3, 1.5, "x", null]);
		expect([...set].sort((a, b) => a - b)).toEqual([1, 2]);
	});

	it("非数组 → 空集合", () => {
		expect(normalizeRoundFavorites(null).size).toBe(0);
		expect(normalizeRoundFavorites({}).size).toBe(0);
	});

	it("切换是幂等可逆的", () => {
		const once = toggleRoundFavorite(new Set(), 5);
		expect(once.has(5)).toBe(true);
		expect(toggleRoundFavorite(once, 5).has(5)).toBe(false);
	});

	it("切换不改入参（避免共享状态被意外修改）", () => {
		const original = new Set([1]);
		toggleRoundFavorite(original, 2);
		expect([...original]).toEqual([1]);
	});
});

describe("formatRoundSpan", () => {
	it("秒 / 分 / 小时", () => {
		expect(formatRoundSpan(0, 45_000)).toBe("45s");
		expect(formatRoundSpan(0, 705_000)).toBe("11m 45s");
		expect(formatRoundSpan(0, 3_900_000)).toBe("1h 5m");
	});

	it("不到 1 秒 → <1s", () => {
		expect(formatRoundSpan(0, 400)).toBe("<1s");
	});

	it("缺时间 / 非递增 → 空串（不显示 0 或负数）", () => {
		expect(formatRoundSpan(null, 1000)).toBe("");
		expect(formatRoundSpan(1000, null)).toBe("");
		expect(formatRoundSpan(5000, 1000)).toBe("");
	});
});

describe("formatTokenCount", () => {
	it("千 / 百万", () => {
		expect(formatTokenCount(980)).toBe("980");
		expect(formatTokenCount(1200)).toBe("1.2k");
		expect(formatTokenCount(12_300)).toBe("12.3k");
		expect(formatTokenCount(34_000)).toBe("34.0k");
		expect(formatTokenCount(340_000)).toBe("340k");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
	});

	it("非正数 → 空串（不显示 0）", () => {
		expect(formatTokenCount(0)).toBe("");
		expect(formatTokenCount(undefined)).toBe("");
		expect(formatTokenCount(-5)).toBe("");
	});
});

describe("formatRoundSummary", () => {
	it("时长 + token", () => {
		const summary = formatRoundSummary(
			round(1, { startedAt: 0, repliedAt: 134_000, tokens: 12_300 }),
			"等待回复…",
		);
		expect(summary).toBe("2m 14s · 12.3k token");
	});

	it("只有时长（没有 token 数据 → 绝不编）", () => {
		expect(formatRoundSummary(round(1, { startedAt: 0, repliedAt: 45_000 }), "等待回复…")).toBe(
			"45s",
		);
	});

	it("还没回复 → 给进行中说明", () => {
		expect(formatRoundSummary(round(1), "等待回复…")).toBe("等待回复…");
	});
});

describe("shouldShowRoundRail", () => {
	it("少于两轮不画（一根横条没有导航意义）", () => {
		expect(shouldShowRoundRail(0)).toBe(false);
		expect(shouldShowRoundRail(1)).toBe(false);
		expect(shouldShowRoundRail(2)).toBe(true);
	});
});

describe("formatRoundMeta — 悬停卡片的元信息行", () => {
	const base = { seq: 1, messageId: "m", userText: "hi" };

	it("时间 · 耗时 · token 三段齐全", () => {
		const started = Date.now() - 134_000;
		const text = formatRoundMeta(
			{ ...base, startedAt: started, repliedAt: started + 134_000, tokens: 12_300 },
			"等待回复…",
		);
		expect(text).toContain("2m 14s");
		expect(text).toContain("12.3k token");
		// 当天只显示时:分，不含日期。
		expect(text).not.toContain("/");
	});

	it("没有 token 就只写时间和耗时（不显示 0）", () => {
		const started = Date.now() - 45_000;
		const text = formatRoundMeta({ ...base, startedAt: started, repliedAt: started + 45_000 }, "…");
		expect(text).toContain("45s");
		expect(text).not.toContain("token");
	});

	it("还没回复 → 有轮首时间时给时间 + 进行中说明", () => {
		const text = formatRoundMeta({ ...base, startedAt: Date.now(), repliedAt: null }, "等待回复…");
		// 已经问了（有时间）就先把时间写出来，再补一句「还在等」。
		expect(text).toContain("等待回复…");
		expect(text).toMatch(/^\d{2}:\d{2} · 等待回复…$/);
	});

	it("完全没有时间 → 不编时间", () => {
		expect(formatRoundMeta({ ...base, startedAt: null, repliedAt: null }, "…")).toBe("…");
	});
});

describe("formatRoundClock", () => {
	it("缺时间 → 空串（不显示 0:00）", () => {
		expect(formatRoundClock(null)).toBe("");
		expect(formatRoundClock(undefined)).toBe("");
	});

	it("当天只给时:分", () => {
		const now = new Date();
		now.setHours(14, 5, 0, 0);
		expect(formatRoundClock(now.getTime())).toBe("14:05");
	});

	it("跨天带日期", () => {
		const old = new Date();
		old.setDate(old.getDate() - 10);
		old.setHours(9, 7, 0, 0);
		expect(formatRoundClock(old.getTime())).toContain("9:07");
		expect(formatRoundClock(old.getTime())).toContain("/");
	});
});
