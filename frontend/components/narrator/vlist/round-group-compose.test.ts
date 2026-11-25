/**
 * round-group-compose.test.ts — 运行期合成。
 *
 * 失败方式全是静默的（不报错，只是列表少了一段 / 多了一个空档 / 折叠条指向错的轮），
 * 所以逐条钉住：
 *   1. 折叠区间 [轮首+1, 最终回复)，轮首与回复**留在外面**；
 *   2. 被折叠元素原样搬进子列表（键不变），不是重建；
 *   3. 没有一轮可折时返回原数组引用（下游据此跳过重算）；
 *   4. 折叠条的 key 以轮首派生，重排后稳定。
 */

import { describe, expect, it } from "bun:test";
import type { MeasuredElement } from "@shared/pretext-layout/prepared-block";
import type { ElementSpec } from "@shared/pretext-layout/segment-adapter";
import { roundGroupHeaderHeight } from "./measure/measure-round-group";
import {
	type ComposableItem,
	composeRoundGroups,
	formatRoundFoldTitle,
	formatTokenCount,
	roundGroupKey,
} from "./round-group-compose";

function measured(height: number): MeasuredElement {
	return {
		height,
		blocks: [],
		frame: { blocks: [], contentHeight: height, usedWidth: 400 },
		contentWidth: 400,
		usedWidth: 400,
	};
}

function item(spec: ElementSpec, height = 20): ComposableItem {
	return { spec, measured: measured(height) };
}

function userBubble(key: string, origin: unknown = "user"): ElementSpec {
	return { kind: "message-bubble", key, data: { role: "user", origin, text: "q" } } as ElementSpec;
}

function assistantText(key: string): ElementSpec {
	return { kind: "markdown", key, data: { text: "a" } } as ElementSpec;
}

function toolCall(key: string): ElementSpec {
	return { kind: "tool-call", key, data: {} } as ElementSpec;
}

const baseOptions = {
	enabled: true,
	buildTitle: ({ durationMs }: { durationMs: number | undefined }) =>
		durationMs ? `已处理 ${Math.round(durationMs / 1000)}s` : "已处理",
};

describe("composeRoundGroups", () => {
	it("折叠 [轮首+1, 最终回复)，两端留在外面", () => {
		const items = [
			item(userBubble("u1")), // 0 轮首
			item(toolCall("t1")), // 1 ┐ 折叠
			item(toolCall("t2")), // 2 ┘
			item(assistantText("a1")), // 3 最终回复
		];
		const out = composeRoundGroups(items, baseOptions);
		expect(out.map((i) => i.spec.kind)).toEqual(["message-bubble", "round-group", "markdown"]);
		expect(out[0]!.spec.key).toBe("u1");
		expect(out[2]!.spec.key).toBe("a1");
	});

	it("被折叠子元素原样搬进 data（键不变，不是重建）", () => {
		const items = [
			item(userBubble("u1")),
			item(toolCall("t1")),
			item(toolCall("t2")),
			item(assistantText("a1")),
		];
		const out = composeRoundGroups(items, baseOptions);
		const data = out[1]!.spec.data as { childCount: number; roundKey: string };
		expect(data.childCount).toBe(2);
		// roundKey 指向轮首，供展开态按轮托管。
		expect(data.roundKey).toBe("u1");
	});

	it("折叠条高度 = 头部常量（收起态，不预测展开体）", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, baseOptions);
		expect(out[1]!.measured.height).toBe(roundGroupHeaderHeight());
	});

	it("没有可折的轮 → 返回原数组引用", () => {
		const items = [item(userBubble("u")), item(assistantText("a"))];
		expect(composeRoundGroups(items, baseOptions)).toBe(items as unknown as typeof items);
	});

	it("运行中的轮不折（无最终回复）", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(toolCall("t2"))];
		expect(composeRoundGroups(items, baseOptions)).toBe(items as unknown as typeof items);
	});

	it("存在活跃元素时不折", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, {
			...baseOptions,
			isLiveSpec: (spec) => spec.kind === "tool-call",
		});
		expect(out).toBe(items as unknown as typeof out);
	});

	it("没有 lod 入参：档位不再参与折叠决定", () => {
		// 结构保证：`ComposeRoundGroupsOptions` 里没有 lod，所以「任意档位都能折」
		// 不是靠某处判断实现的，而是这个函数压根看不到档位。
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, { ...baseOptions });
		expect("lod" in baseOptions).toBe(false);
		expect(out).not.toBe(items as unknown as typeof out);
	});

	it("设置关掉折叠 → 不折", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, { ...baseOptions, enabled: false });
		expect(out).toBe(items as unknown as typeof out);
	});

	it("读者手动展开过的轮不折（避免重复合成）", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, {
			...baseOptions,
			expandedRoundKeys: new Set(["u"]),
		});
		expect(out).toBe(items as unknown as typeof out);
	});

	it("多轮各自折叠，互不影响", () => {
		const items = [
			item(userBubble("u1")),
			item(toolCall("a")),
			item(assistantText("r1")),
			item(userBubble("u2")),
			item(toolCall("b")),
			item(assistantText("r2")),
		];
		const out = composeRoundGroups(items, baseOptions);
		expect(out.map((i) => i.spec.kind)).toEqual([
			"message-bubble",
			"round-group",
			"markdown",
			"message-bubble",
			"round-group",
			"markdown",
		]);
	});

	it("⚠️ 系统代发的 role=user 不切轮（与后端判据一致）", () => {
		const items = [
			item(userBubble("u1", "user")),
			item(toolCall("t1")),
			item(userBubble("sys", "system")), // 自动续跑
			item(toolCall("t2")),
			item(assistantText("r1")),
		];
		const out = composeRoundGroups(items, baseOptions);
		// 仍然只有一轮，且系统代发那条被折进组里。
		expect(out.map((i) => i.spec.kind)).toEqual(["message-bubble", "round-group", "markdown"]);
	});

	it("时长从轮首到最终回复", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const times = new Map([
			["u", 1000],
			["a", 135_000], // 134s → 134
		]);
		const out = composeRoundGroups(items, {
			...baseOptions,
			readTime: (spec) => times.get(spec.key),
			buildTitle: ({ durationMs }) => `已处理 ${Math.round((durationMs ?? 0) / 1000)}s`,
		});
		expect((out[1]!.spec.data as { title: string }).title).toBe("已处理 134s");
	});

	it("时间缺失 → 标题仍成立（不含时长段）", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, {
			...baseOptions,
			readTime: () => undefined,
			buildTitle: ({ durationMs }) => (durationMs ? "有时长" : "无时长"),
		});
		expect((out[1]!.spec.data as { title: string }).title).toBe("无时长");
	});

	it("⭐ 最终回复无时间戳（markdown 只有文本）时，用折叠区间最后一个有时间的元素收尾", () => {
		// 真实形状：最终回复是 markdown，data 就是纯字符串 block.text，不带 createdAt。
		// 照「轮首 + 最终回复两项相减」写，时长会恒为 undefined（实测就是这样）。
		const items = [
			item(userBubble("u")),
			item(toolCall("t1")),
			item(toolCall("t2")), // 最后一个带时间的元素
			item(assistantText("a")), // 没有时间戳
		];
		const times = new Map<string, number>([
			["u", 0],
			["t1", 30_000],
			["t2", 90_000],
			// "a" 故意不在表里
		]);
		const out = composeRoundGroups(items, {
			...baseOptions,
			readTime: (spec) => times.get(spec.key),
			buildTitle: ({ durationMs }) =>
				durationMs ? `已处理 ${Math.round(durationMs / 1000)}s` : "无时长",
		});
		// 90s - 0s = 90s（用 t2 收尾，而不是失败的 undefined）
		expect((out[1]!.spec.data as { title: string }).title).toBe("已处理 90s");
	});

	it("轮首无时间 → 无时长（不猜）", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, {
			...baseOptions,
			readTime: (spec) => (spec.key === "u" ? undefined : 5000),
			buildTitle: ({ durationMs }) => (durationMs ? "有时长" : "无时长"),
		});
		expect((out[1]!.spec.data as { title: string }).title).toBe("无时长");
	});

	it("被折叠首元素带 unitStart → 折叠条继承（不留空档）", () => {
		const items = [
			item(userBubble("u")),
			item({ ...toolCall("t"), unitStart: true }),
			item(assistantText("a")),
		];
		const out = composeRoundGroups(items, baseOptions);
		expect(out[1]!.spec.unitStart).toBe(true);
	});

	it("首元素不带 unitStart → 折叠条也不带", () => {
		const items = [item(userBubble("u")), item(toolCall("t")), item(assistantText("a"))];
		const out = composeRoundGroups(items, baseOptions);
		expect(out[1]!.spec.unitStart).toBeUndefined();
	});
});

describe("formatRoundFoldTitle", () => {
	it("时长 + token 两段", () => {
		expect(formatRoundFoldTitle("已处理", 134_000, 12_345)).toBe("已处理 2m 14s · 12.3k token");
	});

	it("只有时长（token 查不到 → 不写 token 段）", () => {
		expect(formatRoundFoldTitle("已处理", 45_000, undefined)).toBe("已处理 45s");
	});

	it("只有 token（时长查不到 → 不写时长段）", () => {
		// provider 回报了 usage 但老数据没有时间戳，这是真实会出现的组合。
		expect(formatRoundFoldTitle("已处理", undefined, 3400)).toBe("已处理 3.4k token");
	});

	it("两段都缺 → 光秃秃的「已处理」，绝不编数字", () => {
		expect(formatRoundFoldTitle("已处理", undefined, undefined)).toBe("已处理");
		expect(formatRoundFoldTitle("已处理", 0, 0)).toBe("已处理");
	});

	it("不到 1 秒 → <1s", () => {
		expect(formatRoundFoldTitle("已处理", 400, undefined)).toBe("已处理 <1s");
	});
});

describe("formatTokenCount", () => {
	it("千 / 百万", () => {
		expect(formatTokenCount(980)).toBe("980");
		expect(formatTokenCount(1200)).toBe("1.2k");
		expect(formatTokenCount(12_345)).toBe("12.3k");
		expect(formatTokenCount(340_000)).toBe("340k");
		expect(formatTokenCount(1_500_000)).toBe("1.5M");
	});

	it("非正数 / NaN → 空串（不显示 0）", () => {
		expect(formatTokenCount(0)).toBe("");
		expect(formatTokenCount(-5)).toBe("");
		expect(formatTokenCount(Number.NaN)).toBe("");
		expect(formatTokenCount(undefined)).toBe("");
	});
});

describe("roundGroupKey", () => {
	it("以轮首元素的 key 派生（重排后稳定）", () => {
		const specs = [userBubble("u1"), toolCall("t"), assistantText("a")];
		expect(
			roundGroupKey({ startIndex: 0, endIndex: 3, finalReplyIndex: 2, roundIndex: 0 }, specs),
		).toBe("roundgroup-u1");
	});
});
