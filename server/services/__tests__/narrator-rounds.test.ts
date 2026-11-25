/**
 * narrator-rounds.test.ts — 轮次索引的服务层行为（真实 SQLite，非 mock SQL）。
 *
 * 这些断言是导航轨正确性的地基，且失败方式都是**静默的**（多列一轮 / 少列一轮 /
 * 用时偏大），所以逐条钉住：
 *   1. `origin='system'` 的 role=user 不切轮 —— 否则自动续跑把一轮刷成几十轮；
 *   2. `is_compact=1` 的轮首不出现 —— 压缩点之前的轮点过去是空内容；
 *   3. 用时取「该轮最后一条 assistant」；
 *   4. 分页不重不漏，`hasMore` 由 limit+1 判定。
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

const { listNarratorRounds } = await import("../narrator-rounds");
const { narratorMessages, narratorMessageRefs, narrators } = await import("../../db/schema");
const { generateId } = await import("../../lib/id");

const NARRATOR = "narr_rounds_test";
const SUBAGENT = "narr_rounds_subagent";
const NOW = "2026-01-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	// 两个叙述者一起建：外键要求消息的 narratorId 有对应行。
	for (const id of [NARRATOR, "narr_other"]) {
		db.insert(narrators).values({ id, createdAt: NOW, updatedAt: NOW }).run();
	}
});

afterAll(() => {
	cleanDb(sqlite);
});

/** 插一条消息 + 它的 ref，返回 messageId。 */
function insertMessage(input: {
	id?: string;
	role: "user" | "assistant" | "system";
	origin?: "user" | "system" | "assistant" | null;
	text?: string;
	createdAt: string;
	seq: number;
	isCompact?: boolean;
	totalTokens?: number;
	/** 只写整型 token 列（正常路径）。 */
	tokensIn?: number;
	outputTokens?: number;
	/** 只写 turn_usage_json、不写整型列（用来证明实现没去解析它）。 */
	onlyTurnUsageJson?: Record<string, unknown>;
}): string {
	const id = input.id ?? generateId();
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: NARRATOR,
			role: input.role,
			origin: input.origin ?? null,
			contentJson: [],
			contentText: input.text ?? null,
			createdAt: input.createdAt,
			...(input.totalTokens !== undefined
				? { turnUsageJson: { totalTokens: input.totalTokens } }
				: {}),
			...(input.onlyTurnUsageJson !== undefined ? { turnUsageJson: input.onlyTurnUsageJson } : {}),
			...(input.tokensIn !== undefined ? { tokensIn: input.tokensIn } : {}),
			...(input.outputTokens !== undefined ? { outputTokens: input.outputTokens } : {}),
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: generateId(),
			narratorId: NARRATOR,
			messageId: id,
			seq: input.seq,
			isCompact: input.isCompact ? 1 : 0,
		})
		.run();
	return id;
}

describe("listNarratorRounds", () => {
	test("按轮首列出一轮，取该轮最后一条 assistant 的时间", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "  修一下   登录  ",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		// token 只在 assistant 上，且从整型列取（不解析 turn_usage_json）。
		insertMessage({
			role: "assistant",
			createdAt: "2026-01-01T00:00:30.000Z",
			seq: 2,
			tokensIn: 1000,
			outputTokens: 200,
		});
		insertMessage({ role: "assistant", createdAt: "2026-01-01T00:02:00.000Z", seq: 3 });
		insertMessage({
			role: "user",
			origin: "user",
			text: "再加测试",
			createdAt: "2026-01-01T00:05:00.000Z",
			seq: 4,
		});
		insertMessage({ role: "assistant", createdAt: "2026-01-01T00:06:00.000Z", seq: 5 });

		const { rounds, hasMore } = await listNarratorRounds(NARRATOR, { limit: 50 });

		expect(hasMore).toBe(false);
		expect(rounds).toHaveLength(2);
		expect(rounds[0]).toMatchObject({
			seq: 1,
			// 空白折叠。
			userText: "修一下 登录",
			startedAt: Date.parse("2026-01-01T00:00:00.000Z"),
			// 该轮**最后**一条 assistant，不是第一条。
			repliedAt: Date.parse("2026-01-01T00:02:00.000Z"),
			tokens: 1200,
		});
		expect(rounds[1]).toMatchObject({ seq: 4, userText: "再加测试" });
	});

	test("⚠️ origin=system 的 role=user 不切轮", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "真人的问题",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({ role: "assistant", createdAt: "2026-01-01T00:00:10.000Z", seq: 2 });
		// 自动续跑：role=user 但 origin=system。
		insertMessage({
			role: "user",
			origin: "system",
			text: "继续",
			createdAt: "2026-01-01T00:00:20.000Z",
			seq: 3,
		});
		insertMessage({ role: "assistant", createdAt: "2026-01-01T00:00:30.000Z", seq: 4 });

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]!.seq).toBe(1);
		// 用时跨过了那条系统代发消息。
		expect(rounds[0]!.repliedAt).toBe(Date.parse("2026-01-01T00:00:30.000Z"));
	});

	test("origin 为 null 的老数据仍算真人（不误杀历史会话）", async () => {
		insertMessage({
			role: "user",
			origin: null,
			text: "老会话",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(1);
	});

	test("⚠️ is_compact=1 的轮首不出现", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "压缩前",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
			isCompact: true,
		});
		insertMessage({
			role: "user",
			origin: "user",
			text: "压缩后",
			createdAt: "2026-01-01T00:10:00.000Z",
			seq: 5,
		});

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]!.seq).toBe(5);
	});

	test("还没回复的轮 repliedAt 为 null", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "刚发的",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds[0]!.repliedAt).toBeNull();
	});

	test("token 按轮汇总：一轮内多条 assistant 累加", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "一个问题",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		// 一轮里模型汇报两次（中间有工具调用），token 要全都算进去。
		insertMessage({
			role: "assistant",
			createdAt: "2026-01-01T00:00:10.000Z",
			seq: 2,
			tokensIn: 1000,
			outputTokens: 200,
		});
		insertMessage({
			role: "assistant",
			createdAt: "2026-01-01T00:00:20.000Z",
			seq: 3,
			tokensIn: 500,
			outputTokens: 300,
		});

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		// 1000+200 + 500+300 = 2000
		expect(rounds[0]!.tokens).toBe(2000);
	});

	test("provider 没回报 usage → 不带 tokens 字段（不显示 0）", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "无用量",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({ role: "assistant", createdAt: "2026-01-01T00:00:10.000Z", seq: 2 });

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds[0]!).not.toHaveProperty("tokens");
	});

	test("⚠️ token 只从整型列取，不解析 turn_usage_json（列表接口性能规则）", async () => {
		// 写入 turnUsageJson 但不写整型列：如果实现去解析 JSON，这里会拿到 token。
		// 断言它拿不到 —— 这正是「不碰大字段」的可执行证明。
		const userId = insertMessage({
			role: "user",
			origin: "user",
			text: "只有 JSON",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		expect(userId).toBeTruthy();
		insertMessage({
			role: "assistant",
			createdAt: "2026-01-01T00:00:10.000Z",
			seq: 2,
			onlyTurnUsageJson: { input_tokens: 5000, output_tokens: 500 },
		});

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds[0]!).not.toHaveProperty("tokens");
	});

	test("用户原话在 SQL/JS 侧截断到 80 字并加省略号", async () => {
		const long = "字".repeat(200);
		insertMessage({
			role: "user",
			origin: "user",
			text: long,
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		// 80 字 + 省略号
		expect(Array.from(rounds[0]!.userText)).toHaveLength(81);
		expect(rounds[0]!.userText.endsWith("…")).toBe(true);
	});

	test("回复缩略：取该轮最后一条 assistant 的正文开头", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "问题",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		// 一轮内多条 assistant：中间汇报不算结论，缩略应取最后一条。
		insertMessage({
			role: "assistant",
			text: "中间汇报",
			createdAt: "2026-01-01T00:00:10.000Z",
			seq: 2,
		});
		insertMessage({
			role: "assistant",
			text: "最终结论",
			createdAt: "2026-01-01T00:00:20.000Z",
			seq: 3,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds[0]!.replyPreview).toBe("最终结论");
	});

	test("回复缩略在 SQL 侧截断，且没回复时字段不存在", async () => {
		const long = "答".repeat(400);
		insertMessage({
			role: "user",
			origin: "user",
			text: "问题",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({
			role: "assistant",
			text: long,
			createdAt: "2026-01-01T00:00:10.000Z",
			seq: 2,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		// 截断到 ROUND_REPLY_PREVIEW_MAX_CHARS 字，不回传整段正文。回复缩略有它自己的
		// 上限（120），不能再被套用户原话的 80 字上限 —— 否则截到 80 又加一个省略号。
		const preview = rounds[0]!.replyPreview ?? "";
		expect(Array.from(preview).length).toBe(121);
		expect(preview.endsWith("…")).toBe(true);
		expect(preview.startsWith("答")).toBe(true);
	});

	test("回复缩略：折白后不足 120 字不加省略号", async () => {
		// 100 个非空白字符 + 末尾换行 —— 折叠后 100 字，没到 120 上限，不能出省略号。
		const text = `${"答".repeat(100)}\n\n\n`;
		insertMessage({
			role: "user",
			origin: "user",
			text: "问题",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({
			role: "assistant",
			text,
			createdAt: "2026-01-01T00:00:10.000Z",
			seq: 2,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		const preview = rounds[0]!.replyPreview ?? "";
		expect(preview.endsWith("…")).toBe(false);
		expect(Array.from(preview).length).toBe(100);
	});

	test("分页：beforeSeq 只回更早的轮，hasMore 由 limit+1 判定", async () => {
		for (let i = 0; i < 5; i++) {
			insertMessage({
				role: "user",
				origin: "user",
				text: `第 ${i} 轮`,
				createdAt: `2026-01-01T0${i}:00:00.000Z`,
				seq: i * 10 + 1,
			});
		}

		const first = await listNarratorRounds(NARRATOR, { limit: 2 });
		expect(first.hasMore).toBe(true);
		expect(first.rounds.map((r) => r.seq)).toEqual([31, 41]);

		const second = await listNarratorRounds(NARRATOR, {
			beforeSeq: first.rounds[0]!.seq,
			limit: 2,
		});
		expect(second.rounds.map((r) => r.seq)).toEqual([11, 21]);

		const third = await listNarratorRounds(NARRATOR, {
			beforeSeq: second.rounds[0]!.seq,
			limit: 2,
		});
		expect(third.rounds.map((r) => r.seq)).toEqual([1]);
		expect(third.hasMore).toBe(false);
	});

	test("结果按 seq 升序（导航轨从旧到新）", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "a",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({
			role: "user",
			origin: "user",
			text: "b",
			createdAt: "2026-01-01T00:01:00.000Z",
			seq: 5,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds.map((r) => r.seq)).toEqual([1, 5]);
	});

	test("空会话返回空页", async () => {
		const page = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(page).toEqual({ rounds: [], hasMore: false });
	});

	test("⚠️ 子代理：origin=assistant 的 user 消息是轮首", async () => {
		// 实测：子代理会话的「用户」消息 100% 是父代理派发的任务（origin=assistant）。
		// 沿用主会话判据会让子代理永远切不出轮。
		db.insert(narrators)
			.values({ id: SUBAGENT, type: "subagent", createdAt: NOW, updatedAt: NOW })
			.run();
		db.insert(narratorMessages)
			.values({
				id: "sub_task",
				narratorId: SUBAGENT,
				role: "user",
				origin: "assistant",
				contentJson: [],
				contentText: "去读一下这个模块",
				createdAt: "2026-01-01T00:00:00.000Z",
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: SUBAGENT,
				messageId: "sub_task",
				seq: 1,
				isCompact: 0,
			})
			.run();
		db.insert(narratorMessages)
			.values({
				id: "sub_reply",
				narratorId: SUBAGENT,
				role: "assistant",
				contentJson: [],
				createdAt: "2026-01-01T00:01:00.000Z",
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: SUBAGENT,
				messageId: "sub_reply",
				seq: 2,
				isCompact: 0,
			})
			.run();

		const { rounds } = await listNarratorRounds(SUBAGENT, { limit: 50 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]!.userText).toBe("去读一下这个模块");
	});

	test("主会话里 origin=assistant 仍不算轮首（避免误收）", async () => {
		insertMessage({
			role: "user",
			origin: "assistant",
			text: "群聊注入",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(0);
	});

	test("只返回本叙述者的轮", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "我的",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		db.insert(narratorMessages)
			.values({
				id: "other_msg",
				narratorId: "narr_other",
				role: "user",
				origin: "user",
				contentJson: [],
				contentText: "别人的",
				createdAt: "2026-01-01T00:00:00.000Z",
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({
				id: generateId(),
				narratorId: "narr_other",
				messageId: "other_msg",
				seq: 1,
				isCompact: 0,
			})
			.run();

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]!.messageId).not.toBe("other_msg");
	});

	test("超长会话触达 maxReplyRowsScanned 上限时：最新轮完整，截断的旧轮省略不完整 token", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "第一轮",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({
			role: "assistant",
			text: "旧轮中间步",
			createdAt: "2026-01-01T00:01:00.000Z",
			seq: 2,
			tokensIn: 500,
			outputTokens: 100,
		});
		insertMessage({
			role: "assistant",
			text: "旧轮结论",
			createdAt: "2026-01-01T00:02:00.000Z",
			seq: 3,
			tokensIn: 600,
			outputTokens: 150,
		});
		insertMessage({
			role: "user",
			origin: "user",
			text: "第二轮",
			createdAt: "2026-01-01T00:10:00.000Z",
			seq: 4,
		});
		insertMessage({
			role: "assistant",
			text: "最新轮结论",
			createdAt: "2026-01-01T00:11:00.000Z",
			seq: 5,
			tokensIn: 200,
			outputTokens: 50,
		});

		// 只允许扫 2 条 assistant（倒序扫到 seq 5 和 seq 3，seq 2 被截断）
		const { rounds } = await listNarratorRounds(NARRATOR, {
			limit: 50,
			maxReplyRowsScanned: 2,
		});
		expect(rounds).toHaveLength(2);
		// 第二轮完整
		expect(rounds[1]!.replyPreview).toBe("最新轮结论");
		expect(rounds[1]!.tokens).toBe(250);
		// 第一轮拿到了最新回复时间与缩略，但因 seq 2 未扫到而省略不完整的 token
		expect(rounds[0]!.replyPreview).toBe("旧轮结论");
		expect(rounds[0]!.repliedAt).toBe(Date.parse("2026-01-01T00:02:00.000Z"));
		expect(rounds[0]!.tokens).toBeUndefined();
	});

	test("纯空白超长回复不会被误判为省略号缩略", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "提问",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		insertMessage({
			role: "assistant",
			text: "真正的回复内容",
			createdAt: "2026-01-01T00:01:00.000Z",
			seq: 2,
		});
		insertMessage({
			role: "assistant",
			text: "   \n\t ".repeat(40),
			createdAt: "2026-01-01T00:02:00.000Z",
			seq: 3,
		});

		const { rounds } = await listNarratorRounds(NARRATOR, { limit: 50 });
		expect(rounds).toHaveLength(1);
		expect(rounds[0]!.replyPreview).toBe("真正的回复内容");
	});

	test("请求被 AbortSignal 取消时立即拒绝", async () => {
		insertMessage({
			role: "user",
			origin: "user",
			text: "提问",
			createdAt: "2026-01-01T00:00:00.000Z",
			seq: 1,
		});
		const controller = new AbortController();
		controller.abort(new Error("cancelled"));
		await expect(
			listNarratorRounds(NARRATOR, { limit: 50, signal: controller.signal }),
		).rejects.toThrow();
	});

	test("narrator-rounds 路由在 PostgreSQL 准入门前拒绝（与 narrators 路由一致）", async () => {
		const { readFileSync } = await import("node:fs");
		const { join } = await import("node:path");
		const routeSource = readFileSync(
			join(import.meta.dir, "..", "..", "routes", "narrator-rounds.ts"),
			"utf8",
		);
		const pgGateIndex = routeSource.indexOf("requireSqliteNarratorSurface()");
		const aclIndex = routeSource.indexOf("requireNarratorAccess(");
		expect(pgGateIndex).toBeGreaterThan(-1);
		expect(aclIndex).toBeGreaterThan(pgGateIndex);

		const { requireSqliteNarratorSurface } = await import("../../routes/narrators");
		expect(() => requireSqliteNarratorSurface("postgres")).toThrow(
			/not yet supported on the PostgreSQL backend/i,
		);
	});
});
