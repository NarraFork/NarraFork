/**
 * round-group.test.ts — 切轮与折叠计划。
 *
 * 重点覆盖两类最容易做错、且做错不会报错的判据：
 *   1. `origin` 过滤。自动续跑 / review 启动是 `role="user"` 但 `origin="system"`，
 *      漏掉会让导航轨被它们刷满，且每一轮都短得没内容。
 *   2. `finalReplyIndex` 只认 markdown。把 turn-usage / system 卡当成最终回复，
 *      会让 pill 折到它前面，正文反而露在 pill 外面。
 */

import { describe, expect, it } from "bun:test";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import {
	isFinalReplySpec,
	isRoundStartSpec,
	planRoundFold,
	ROUND_FOLD_MIN,
	roundSpanMs,
	splitRoundSegments,
} from "./round-group";

// ── 构造器 ────────────────────────────────────────────────────────────────

function userBubble(origin: unknown = "user", extra: Record<string, unknown> = {}): ElementSpec {
	return {
		kind: "message-bubble",
		key: `bubble-${Math.random().toString(36).slice(2)}`,
		data: { role: "user", origin, text: "hi", ...extra },
	};
}

function assistantText(): ElementSpec {
	return {
		kind: "markdown",
		key: `md-${Math.random().toString(36).slice(2)}`,
		data: { text: "reply" },
	};
}

function toolCall(): ElementSpec {
	return {
		kind: "tool-call",
		key: `tool-${Math.random().toString(36).slice(2)}`,
		data: {},
	};
}

function turnUsage(): ElementSpec {
	return {
		kind: "turn-usage",
		key: `usage-${Math.random().toString(36).slice(2)}`,
		data: {},
	};
}

// ── isRoundStartSpec ──────────────────────────────────────────────────────

describe("isRoundStartSpec", () => {
	it("认真人用户气泡", () => {
		expect(isRoundStartSpec(userBubble("user"))).toBe(true);
	});

	it("origin 为 null / 缺失也算真人（本列引入前的老数据）", () => {
		expect(isRoundStartSpec(userBubble(null))).toBe(true);
		expect(isRoundStartSpec(userBubble(undefined))).toBe(true);
	});

	it("⚠️ 排除系统代发：origin=system 不是轮首", () => {
		// 自动续跑 / review 启动 / rebase prompt 都是 role=user 但 origin=system。
		expect(isRoundStartSpec(userBubble("system"))).toBe(false);
	});

	it("排除 assistant 发起（ForkNarrator、群聊注入）", () => {
		expect(isRoundStartSpec(userBubble("assistant"))).toBe(false);
	});

	it("非 message-bubble 一律不是轮首", () => {
		expect(isRoundStartSpec(assistantText())).toBe(false);
		expect(isRoundStartSpec(toolCall())).toBe(false);
	});

	it("role 不是 user 的气泡不是轮首", () => {
		const spec: ElementSpec = {
			kind: "message-bubble",
			key: "x",
			data: { role: "assistant", origin: "user" },
		};
		expect(isRoundStartSpec(spec)).toBe(false);
	});

	it("⚠️ 子代理：origin=assistant 是轮首（父代理派发的任务）", () => {
		// 实测：子代理会话的 user 消息 100% 是 origin="assistant"。
		// 沿用主会话判据会让子代理永远切不出轮 —— 整轮折叠在子代理里完全不工作。
		expect(isRoundStartSpec(userBubble("assistant"), { isSubagent: true })).toBe(true);
	});

	it("⚠️ 主会话：origin=assistant 仍不是轮首（ForkNarrator / 群聊注入）", () => {
		expect(isRoundStartSpec(userBubble("assistant"), { isSubagent: false })).toBe(false);
		expect(isRoundStartSpec(userBubble("assistant"))).toBe(false);
	});

	it("子代理里 origin=system 仍不是轮首（自动续跑）", () => {
		expect(isRoundStartSpec(userBubble("system"), { isSubagent: true })).toBe(false);
	});

	it("主会话的来源卡不是轮首（同一张卡，仅会话类型不同）", () => {
		const notice: ElementSpec = {
			kind: "system-text",
			key: "msg-1-origin",
			data: { kind: "origin_notice", origin: "assistant", text: "forked" },
		};
		expect(isRoundStartSpec(notice, { isSubagent: false })).toBe(false);
		expect(isRoundStartSpec(notice)).toBe(false);
	});

	it("未经 adapter 标记的来源卡不是轮首（形态本身不足以判定）", () => {
		// 只靠形态推断是曾经失败的路子：来源卡也用于显示 ForkNarrator / 群聊注入，
		// 而子代理派发任务也可能被渲染成注入气泡。真正的判据是 adapter 的标记。
		const notice: ElementSpec = {
			kind: "system-text",
			key: "msg-1-origin",
			data: { kind: "origin_notice", origin: "assistant", text: "只读代码调查" },
		};
		expect(isRoundStartSpec(notice, { isSubagent: true })).toBe(false);
	});

	it("⚠️ 子代理：adapter 打过 roundStart 标记的任意形态都是轮首", () => {
		// 这是最终生效的判据。父代理派发任务的那条 user 消息呈现形态不固定
		// （用户气泡 / 注入气泡 / 来源卡，取决于 origin、有没有结构化 injection
		// 块、投影策略），所以 adapter 在产生 spec 时就写好答案。
		// 前两轮尝试（只看 message-bubble；再补 system-text+origin_notice）
		// 都因为「形态会变」而漏掉真实数据。
		for (const kind of ["injection-bubble", "system-text", "message-bubble"] as const) {
			const marked: ElementSpec = {
				kind,
				key: `msg-1-${kind}`,
				data: { roundStart: true, role: "assistant", origin: "assistant" },
			};
			expect(isRoundStartSpec(marked, { isSubagent: true })).toBe(true);
		}
	});

	it("roundStart 标记只在子代理生效（主会话不因它误切轮）", () => {
		const marked: ElementSpec = {
			kind: "injection-bubble",
			key: "msg-1-m-legacy",
			data: { roundStart: true, source: "subagent_message" },
		};
		expect(isRoundStartSpec(marked, { isSubagent: false })).toBe(false);
		expect(isRoundStartSpec(marked)).toBe(false);
	});

	it("子代理里其它来源的注入气泡不是轮首（没有 roundStart 标记）", () => {
		const injection: ElementSpec = {
			kind: "injection-bubble",
			key: "msg-1-m-legacy",
			data: { source: "reminder", markdown: "task", speaker: "system" },
		};
		expect(isRoundStartSpec(injection, { isSubagent: true })).toBe(false);
	});

	it("其它 system-text 卡不是轮首（工具产出 / 注入提示）", () => {
		const other: ElementSpec = {
			kind: "system-text",
			key: "msg-2",
			data: { kind: "system_card", origin: "assistant", text: "..." },
		};
		expect(isRoundStartSpec(other, { isSubagent: true })).toBe(false);
	});
});

// ── isFinalReplySpec ──────────────────────────────────────────────────────

describe("isFinalReplySpec", () => {
	it("只认 markdown 正文", () => {
		expect(isFinalReplySpec(assistantText())).toBe(true);
	});

	it("⚠️ turn-usage 不是最终回复（它常排在一轮末尾）", () => {
		expect(isFinalReplySpec(turnUsage())).toBe(false);
	});

	it("工具卡 / activity trace 是过程内容，不是回复", () => {
		expect(isFinalReplySpec(toolCall())).toBe(false);
	});
});

// ── splitRoundSegments ────────────────────────────────────────────────────

describe("splitRoundSegments", () => {
	it("按轮首切分，轮边界正确", () => {
		const specs = [userBubble(), toolCall(), assistantText(), userBubble(), assistantText()];
		const rounds = splitRoundSegments(specs);
		expect(rounds).toHaveLength(2);
		expect(rounds[0]).toMatchObject({ startIndex: 0, endIndex: 3, finalReplyIndex: 2 });
		expect(rounds[1]).toMatchObject({ startIndex: 3, endIndex: 5, finalReplyIndex: 4 });
	});

	it("最后一轮延伸到序列末尾", () => {
		const specs = [userBubble(), assistantText(), toolCall()];
		const rounds = splitRoundSegments(specs);
		expect(rounds[0]?.endIndex).toBe(3);
		// 末尾 toolCall 之后没有 markdown，但 1 号是 markdown。
		expect(rounds[0]?.finalReplyIndex).toBe(1);
	});

	it("第一个轮首之前的内容不属于任何轮", () => {
		const specs = [turnUsage(), userBubble(), assistantText()];
		const rounds = splitRoundSegments(specs);
		expect(rounds).toHaveLength(1);
		expect(rounds[0]?.startIndex).toBe(1);
	});

	it("⚠️ 系统代发的 role=user 不切轮（否则自动续跑把一轮切成很多轮）", () => {
		const specs = [
			userBubble("user"),
			toolCall(),
			userBubble("system"), // 自动续跑
			assistantText(),
			toolCall(),
			assistantText(),
		];
		const rounds = splitRoundSegments(specs);
		// 三条 user 气泡只有一条算轮首。
		expect(rounds).toHaveLength(1);
		expect(rounds[0]?.endIndex).toBe(6);
	});

	it("还没回复的轮 finalReplyIndex = -1", () => {
		const specs = [userBubble(), toolCall()];
		const rounds = splitRoundSegments(specs);
		expect(rounds[0]?.finalReplyIndex).toBe(-1);
	});

	it("空序列返回空", () => {
		expect(splitRoundSegments([])).toEqual([]);
	});

	it("没有用户消息时返回空", () => {
		expect(splitRoundSegments([toolCall(), assistantText()])).toEqual([]);
	});

	it("轮序号从 0 连续递增", () => {
		const specs = [
			userBubble(),
			assistantText(),
			userBubble(),
			assistantText(),
			userBubble(),
			assistantText(),
		];
		expect(splitRoundSegments(specs).map((r) => r.roundIndex)).toEqual([0, 1, 2]);
	});
});

// ── planRoundFold ────────────────────────────────────────────────────────

describe("planRoundFold", () => {
	const folded = (specs: ElementSpec[], index = 0, options = {}) => {
		const rounds = splitRoundSegments(specs);
		return planRoundFold(specs, rounds[index]!, options);
	};

	it("已完成的轮折叠 [轮首+1, 最终回复)", () => {
		const specs = [
			userBubble(), // 0 轮首
			toolCall(), // 1 ┐ 折叠
			toolCall(), // 2 ┘
			assistantText(), // 3 最终回复
		];
		expect(folded(specs)).toEqual({ foldFrom: 1, foldTo: 3 });
	});

	it("⚠️ 运行的轮不折：没有最终回复", () => {
		const specs = [userBubble(), toolCall(), toolCall()];
		expect(folded(specs)).toBeNull();
	});

	it("⚠️ 运行的轮不折：存在活跃元素", () => {
		const specs = [userBubble(), toolCall(), assistantText()];
		const liveSpec = (spec: ElementSpec) => spec.kind === "tool-call";
		expect(folded(specs, 0, { isLiveSpec: liveSpec })).toBeNull();
	});

	it("折叠段太短（最终回复紧贴轮首）不折", () => {
		const specs = [userBubble(), assistantText()];
		// foldTo - foldFrom === 0 < ROUND_FOLD_MIN
		expect(folded(specs)).toBeNull();
		expect(ROUND_FOLD_MIN).toBe(1);
	});

	it("恰好一个可藏元素才折（边界）", () => {
		const specs = [userBubble(), toolCall(), assistantText()];
		expect(folded(specs)).toEqual({ foldFrom: 1, foldTo: 2 });
	});

	it("折叠只由开关决定，与渲染档位无关", () => {
		// 曾经把「不折」绑在最高档上：L5 想折没得折，L1 想展开又得切档位。
		// 现在 planRoundFold 的入参里根本没有 lod —— 档位变化不改变折叠结果，
		// 这就是「任意 LOD 都能开/关折叠」的结构保证。
		const specs = [userBubble(), toolCall(), assistantText()];
		expect(folded(specs, 0, { enabled: true })).toEqual({ foldFrom: 1, foldTo: 2 });
		expect(folded(specs, 0, { enabled: false })).toBeNull();
	});

	it("读者手动展开后不再产折叠（避免重复合成）", () => {
		const specs = [userBubble(), toolCall(), assistantText()];
		expect(folded(specs, 0, { expanded: true })).toBeNull();
	});

	it("设置里关掉折叠则完全不折", () => {
		const specs = [userBubble(), toolCall(), assistantText()];
		expect(folded(specs, 0, { enabled: false })).toBeNull();
	});
});

// ── roundSpanMs ──────────────────────────────────────────────────────────

describe("roundSpanMs", () => {
	it("两端都有时间 → 差值", () => {
		const specs = [userBubble(), toolCall(), assistantText()];
		const rounds = splitRoundSegments(specs);
		const times = [1000, 2000, 5000];
		expect(roundSpanMs(specs, rounds[0]!, (s) => times[specs.indexOf(s)])).toBe(4000);
	});

	it("缺时间 → undefined（而不是 0）", () => {
		const specs = [userBubble(), assistantText()];
		const rounds = splitRoundSegments(specs);
		expect(roundSpanMs(specs, rounds[0]!, () => undefined)).toBeUndefined();
	});

	it("时间非递增 → undefined（不显示负数）", () => {
		const specs = [userBubble(), assistantText()];
		const rounds = splitRoundSegments(specs);
		const times = [5000, 1000];
		expect(roundSpanMs(specs, rounds[0]!, (s) => times[specs.indexOf(s)])).toBeUndefined();
	});
});
