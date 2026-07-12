import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

const { db, sqlite } = getTestDb();

mock.module("../../../server/db", () => ({ db, sqlite }));

const { narratorService } = await import("../../../server/services/narrator-service");

const BASE_TIME = new Date("2025-01-01T00:00:00.000Z").getTime();
let tsOffset = 0;

function ts() {
	return new Date(BASE_TIME + tsOffset++ * 1000).toISOString();
}

function seedBase(narratorId = "n1") {
	db.insert(projects)
		.values({
			id: "p1",
			name: "Proj",
			gitPath: "/tmp/repo",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
	db.insert(chapters)
		.values({
			id: "ch1",
			projectId: "p1",
			title: "Chapter 1",
			branch: "chapter/ch1",
			baseBranch: "main",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "fresh",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

function insertMessage(params: {
	id: string;
	seq: number;
	narratorId?: string;
	role?: "user" | "assistant" | "system";
	contentJson: unknown[];
	contentText?: string | null;
	parentToolUseId?: string | null;
}) {
	const narratorId = params.narratorId ?? "n1";
	db.insert(narratorMessages)
		.values({
			id: params.id,
			narratorId,
			role: params.role ?? "assistant",
			contentJson: params.contentJson,
			contentText: params.contentText ?? null,
			parentToolUseId: params.parentToolUseId ?? null,
			createdAt: ts(),
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${narratorId}-${params.id}`,
			narratorId,
			messageId: params.id,
			seq: params.seq,
		})
		.run();
}

function insertToolCall(params: {
	messageId: string;
	toolUseId: string;
	toolName: string;
	status?: "initializing" | "pending" | "running" | "success" | "fail";
	inputJson?: unknown;
	outputJson?: unknown;
	narratorId?: string;
}) {
	const narratorId = params.narratorId ?? "n1";
	db.insert(narratorToolCalls)
		.values({
			id: `tc-${params.toolUseId}`,
			narratorId,
			messageId: params.messageId,
			toolUseId: params.toolUseId,
			toolName: params.toolName,
			status: params.status ?? "success",
			inputJson: params.inputJson,
			outputJson: params.outputJson,
			createdAt: ts(),
		})
		.run();
}

function insertSubagentNarrator(params: {
	id: string;
	subagentType?: string;
	model?: string;
	status?: "idle" | "working" | "waiting" | "archived";
	isBackground?: boolean;
	backgroundStatus?: "running" | "completed" | "failed" | "cancelled" | null;
	parentNarratorId?: string;
}) {
	db.insert(narrators)
		.values({
			id: params.id,
			chapterId: "ch1",
			type: "subagent",
			subagentType: params.subagentType ?? "explore",
			variant: `subagent:${params.subagentType ?? "explore"}`,
			model: params.model ?? "claude-sonnet-4.5",
			parentNarratorId: params.parentNarratorId ?? "n1",
			inheritMode: "fresh",
			status: params.status ?? "idle",
			isBackground: params.isBackground ?? false,
			backgroundStatus: params.backgroundStatus ?? null,
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

beforeEach(() => {
	tsOffset = 0;
});

afterEach(() => cleanDb(sqlite));

afterAll(() => {
	mock.restore();
});

describe("narratorService message query regressions", () => {
	it("subagent narrator 的 prune/compact 边界计算应包含 child 消息", async () => {
		seedBase("n-sub");
		db.update(narrators)
			.set({ type: "subagent", subagentType: "general", variant: "subagent:general" })
			.where(eq(narrators.id, "n-sub"))
			.run();

		insertMessage({
			id: "s-m0",
			seq: 0,
			narratorId: "n-sub",
			role: "user",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub user 0" }],
			contentText: "sub user 0",
		});
		insertMessage({
			id: "s-m1",
			seq: 1,
			narratorId: "n-sub",
			role: "assistant",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub asst 0" }],
			contentText: "sub asst 0",
		});
		insertMessage({
			id: "s-m2",
			seq: 2,
			narratorId: "n-sub",
			role: "user",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub user 1" }],
			contentText: "sub user 1",
		});
		insertMessage({
			id: "s-m3",
			seq: 3,
			narratorId: "n-sub",
			role: "assistant",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub asst 1" }],
			contentText: "sub asst 1",
		});
		insertMessage({
			id: "s-m4",
			seq: 4,
			narratorId: "n-sub",
			role: "user",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub user 2" }],
			contentText: "sub user 2",
		});
		insertMessage({
			id: "s-m5",
			seq: 5,
			narratorId: "n-sub",
			role: "assistant",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "sub asst 2" }],
			contentText: "sub asst 2",
		});

		const prune = await narratorService.computeAndUpdatePruneBoundary("n-sub", 99, {
			pruneStart: 95,
			compactStart: 99,
		});
		expect(prune).not.toBeNull();
		expect(prune?.boundaryMessageId).toBe("s-m0");
		expect(prune?.prunedPercent).toBe(17);

		const reloaded = await db.query.narrators.findFirst({ where: eq(narrators.id, "n-sub") });
		expect(reloaded?.pruneBoundaryMessageId).toBe("s-m0");
		expect(reloaded?.prunedPercent).toBe(17);

		const compactBoundary = await narratorService.getCompactBoundaryMessage("n-sub", 2);
		expect(compactBoundary).toBe("s-m2");

		const allRefs = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "n-sub"))
			.orderBy(narratorMessageRefs.seq)
			.all();
		expect(allRefs.map((r) => r.messageId)).toEqual([
			"s-m0",
			"s-m1",
			"s-m2",
			"s-m3",
			"s-m4",
			"s-m5",
		]);
	});

	it("getEmergencyCompactBoundaryMessage 在消息过少时忽略 keepPairs 仍返回边界", async () => {
		seedBase("n-few");

		// Only 3 top-level messages — below the normal keepPairs=2 threshold
		// (needs keepCount+2 = 6), so getCompactBoundaryMessage returns null.
		insertMessage({
			id: "f-m0",
			seq: 0,
			narratorId: "n-few",
			role: "user",
			contentJson: [{ type: "text", text: "huge pasted input" }],
			contentText: "huge pasted input",
		});
		insertMessage({
			id: "f-m1",
			seq: 1,
			narratorId: "n-few",
			role: "assistant",
			contentJson: [{ type: "text", text: "reply" }],
			contentText: "reply",
		});
		insertMessage({
			id: "f-m2",
			seq: 2,
			narratorId: "n-few",
			role: "user",
			contentJson: [{ type: "text", text: "another huge input" }],
			contentText: "another huge input",
		});

		// Normal boundary bails out because there are too few messages.
		const normal = await narratorService.getCompactBoundaryMessage("n-few", 2);
		expect(normal).toBeNull();

		// Emergency boundary keeps only the most recent message (f-m2) and
		// compacts everything before it.
		const emergency = await narratorService.getEmergencyCompactBoundaryMessage("n-few");
		expect(emergency).toBe("f-m2");
	});

	it("getEmergencyCompactBoundaryMessage 在只有 1 条消息时返回 null", async () => {
		seedBase("n-one");

		insertMessage({
			id: "o-m0",
			seq: 0,
			narratorId: "n-one",
			role: "user",
			contentJson: [{ type: "text", text: "only message" }],
			contentText: "only message",
		});

		const emergency = await narratorService.getEmergencyCompactBoundaryMessage("n-one");
		expect(emergency).toBeNull();
	});

	it("getChunksByRange 构建树、截断大输出并过滤 ExitPlan→plan compact 包装消息", async () => {
		seedBase();

		insertMessage({
			id: "m-exit",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-exit", name: "ExitPlanMode", input: {} }],
		});
		insertToolCall({
			messageId: "m-exit",
			toolUseId: "tu-exit",
			toolName: "ExitPlanMode",
			status: "success",
			outputJson: { plan: "P".repeat(2600) },
		});

		insertMessage({
			id: "m-plan",
			seq: 1,
			role: "system",
			contentJson: [{ type: "compact", subtype: "plan", status: "compacted", summary: "ok" }],
		});

		insertMessage({
			id: "m-read",
			seq: 2,
			contentJson: [
				{ type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "a.ts" } },
			],
		});
		insertToolCall({
			messageId: "m-read",
			toolUseId: "tu-read",
			toolName: "Read",
			status: "success",
			outputJson: { blob: "X".repeat(2600) },
		});

		insertMessage({
			id: "c-read",
			seq: 3,
			parentToolUseId: "tu-read",
			contentJson: [{ type: "text", text: "child response" }],
		});

		const result = await narratorService.getChunksByRange("n1", { count: 1 });
		expect(result.hasOlder).toBe(false);
		expect(result.hasNewer).toBe(false);
		expect(result.messages.map((m: { id: string }) => m.id)).toEqual(["m-plan", "m-read"]);
		expect(result.messages.map((m: { seq?: number }) => m.seq)).toEqual([1, 2]);

		const readMsg = result.messages.find((m: { id: string }) => m.id === "m-read");
		expect(readMsg?.children?.map((c: { id: string }) => c.id)).toEqual(["c-read"]);

		const readTc = readMsg?.toolCalls?.find(
			(tc: { toolUseId: string }) => tc.toolUseId === "tu-read",
		);
		expect(readTc?.outputJson?._truncated).toBe(true);

		const readBlock = readMsg?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-read",
		);
		expect(readBlock?.status).toBe("success");
		expect(readBlock?.outputJson?._truncated).toBe(true);
	});

	it("getChunksByRange 省略终态子代理子消息并附加懒加载摘要标记", async () => {
		seedBase();
		insertSubagentNarrator({ id: "sa-done", status: "idle", model: "gpt-5.5" });

		insertMessage({
			id: "m-task",
			seq: 0,
			contentJson: [
				{ type: "tool_use", id: "tu-task", name: "Task", input: { subagent_type: "explore" } },
			],
		});
		insertToolCall({
			messageId: "m-task",
			toolUseId: "tu-task",
			toolName: "Task",
			status: "success",
		});
		// Subagent child messages (owned by the finished subagent narrator).
		insertMessage({
			id: "c-1",
			seq: 1,
			narratorId: "sa-done",
			parentToolUseId: "tu-task",
			contentJson: [{ type: "tool_use", id: "tu-c1", name: "Read", input: { file_path: "x" } }],
		});
		insertToolCall({
			messageId: "c-1",
			toolUseId: "tu-c1",
			toolName: "Read",
			status: "success",
			narratorId: "sa-done",
		});
		insertMessage({
			id: "c-2",
			seq: 2,
			narratorId: "sa-done",
			parentToolUseId: "tu-task",
			contentJson: [{ type: "tool_use", id: "tu-c2", name: "Grep", input: { pattern: "y" } }],
		});
		insertToolCall({
			messageId: "c-2",
			toolUseId: "tu-c2",
			toolName: "Grep",
			status: "success",
			narratorId: "sa-done",
		});

		const range = await narratorService.getChunksByRange("n1", { count: 1 });
		const taskMsg = range.messages.find((m: { id: string }) => m.id === "m-task");
		// Children omitted from the payload.
		expect(taskMsg?.children ?? []).toEqual([]);
		// Omission markers present on the tool_use block.
		const taskBlock = taskMsg?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-task",
		);
		expect(taskBlock?._subagentChildrenOmitted).toBe(true);
		expect(taskBlock?._subagentNarratorId).toBe("sa-done");
		expect(taskBlock?._subagentChildToolCallCount).toBe(2);
		expect(taskBlock?._subagentModel).toBe("gpt-5.5");

		// Lazy-load endpoint returns the child window (ascending by seq).
		const lazy = await narratorService.getSubagentChildren("n1", "tu-task");
		expect(lazy.messages.map((m: { id: string }) => m.id)).toEqual(["c-1", "c-2"]);
		expect(lazy.hasOlder).toBe(false);
	});

	it("getSubagentChildren 按子代理 seq 游标分页（默认窗口 + beforeSeq 向上翻）", async () => {
		seedBase();
		insertSubagentNarrator({ id: "sa-page", status: "idle" });

		insertMessage({
			id: "m-task",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-task", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "m-task",
			toolUseId: "tu-task",
			toolName: "Task",
			status: "success",
		});
		// 3 child messages owned by the subagent narrator (seq 1..3).
		for (let i = 1; i <= 3; i++) {
			insertMessage({
				id: `c-${i}`,
				seq: i,
				narratorId: "sa-page",
				parentToolUseId: "tu-task",
				contentJson: [{ type: "text", text: `child ${i}` }],
			});
		}

		// Newest-first window of 2 → returns the 2 newest ascending, hasOlder true.
		const page1 = await narratorService.getSubagentChildren("n1", "tu-task", { count: 2 });
		expect(page1.messages.map((m: { id: string }) => m.id)).toEqual(["c-2", "c-3"]);
		expect(page1.hasOlder).toBe(true);
		expect(page1.oldestSeq).toBe(2);

		// Page older via beforeSeq = oldestSeq of the previous window.
		const page2 = await narratorService.getSubagentChildren("n1", "tu-task", {
			count: 2,
			beforeSeq: page1.oldestSeq ?? undefined,
		});
		expect(page2.messages.map((m: { id: string }) => m.id)).toEqual(["c-1"]);
		expect(page2.hasOlder).toBe(false);
	});

	it("getChunksByRange 对运行中/后台活跃子代理保持内联子消息", async () => {
		seedBase();
		insertSubagentNarrator({ id: "sa-working", status: "working" });
		insertSubagentNarrator({
			id: "sa-bg",
			status: "idle",
			isBackground: true,
			backgroundStatus: "running",
		});

		// Foreground still-working subagent.
		insertMessage({
			id: "m-task-a",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-a", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "m-task-a",
			toolUseId: "tu-a",
			toolName: "Task",
			status: "running",
		});
		insertMessage({
			id: "c-a",
			seq: 1,
			narratorId: "sa-working",
			parentToolUseId: "tu-a",
			contentJson: [{ type: "text", text: "live child a" }],
		});

		// Background-running subagent whose parent Task already reads success.
		insertMessage({
			id: "m-task-b",
			seq: 2,
			contentJson: [
				{ type: "tool_use", id: "tu-b", name: "Task", input: { run_in_background: true } },
			],
		});
		insertToolCall({
			messageId: "m-task-b",
			toolUseId: "tu-b",
			toolName: "Task",
			status: "success",
		});
		insertMessage({
			id: "c-b",
			seq: 3,
			narratorId: "sa-bg",
			parentToolUseId: "tu-b",
			contentJson: [{ type: "text", text: "live child b" }],
		});

		const range = await narratorService.getChunksByRange("n1", { count: 1 });
		const taskA = range.messages.find((m: { id: string }) => m.id === "m-task-a");
		const taskB = range.messages.find((m: { id: string }) => m.id === "m-task-b");
		// Both keep children inline; no omission markers.
		expect(taskA?.children?.map((c: { id: string }) => c.id)).toEqual(["c-a"]);
		expect(taskB?.children?.map((c: { id: string }) => c.id)).toEqual(["c-b"]);
		const blockA = taskA?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-a",
		);
		const blockB = taskB?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-b",
		);
		expect(blockA?._subagentChildrenOmitted).toBeUndefined();
		expect(blockB?._subagentChildrenOmitted).toBeUndefined();
	});

	it("getSubagentChildren 拒绝不属于该 narrator 可见消息的 toolUseId", async () => {
		seedBase();
		// A second primary narrator that owns the tool call, without a ref for n1.
		db.insert(narrators)
			.values({
				id: "other",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();
		insertMessage({
			id: "m-task",
			seq: 0,
			narratorId: "other",
			contentJson: [{ type: "tool_use", id: "tu-task", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "m-task",
			toolUseId: "tu-task",
			toolName: "Task",
			status: "success",
			narratorId: "other",
		});

		// n1 cannot read a tool call that belongs to "other"'s message.
		await expect(narratorService.getSubagentChildren("n1", "tu-task")).rejects.toThrow();
	});

	it("compact 标记写入和完成时应更新 chunk manifest 版本并保持顺序", async () => {
		seedBase();

		insertMessage({
			id: "m0",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
		});
		insertMessage({
			id: "m1",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});

		const compacting = await narratorService.persistCompactingMessage("n1", "m1");
		expect(compacting.seq).toBe(1);

		const afterInsert = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(afterInsert?.messageVersion).toBe(1);

		const refsAfterInsert = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "n1"))
			.orderBy(narratorMessageRefs.seq)
			.all();
		expect(refsAfterInsert).toEqual([
			{ messageId: "m0", seq: 0 },
			{ messageId: compacting.id, seq: 1 },
			{ messageId: "m1", seq: 2 },
		]);

		const manifestAfterInsert = await narratorService.getChunkManifest("n1", 0);
		expect(manifestAfterInsert.unchanged).toBe(false);
		if (!manifestAfterInsert.unchanged) {
			expect(manifestAfterInsert.messageVersion).toBe(1);
			expect(manifestAfterInsert.total).toBe(3);
		}

		let range = await narratorService.getChunksByRange("n1", { count: 1 });
		expect(range.messages.map((m: { id: string }) => m.id)).toEqual(["m0", compacting.id, "m1"]);
		let compactBlock = range.messages
			.find((m: { id: string }) => m.id === compacting.id)
			?.contentJson?.find((b: { type?: string }) => b.type === "compact");
		expect(compactBlock?.status).toBe("compacting");

		await narratorService.finalizeCompactingMessage(compacting.id, "n1", "summary");
		const afterFinalize = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(afterFinalize?.messageVersion).toBe(2);

		const manifestAfterFinalize = await narratorService.getChunkManifest("n1", 1);
		expect(manifestAfterFinalize.unchanged).toBe(false);
		expect(manifestAfterFinalize.messageVersion).toBe(2);

		range = await narratorService.getChunksByRange("n1", { count: 1 });
		compactBlock = range.messages
			.find((m: { id: string }) => m.id === compacting.id)
			?.contentJson?.find((b: { type?: string }) => b.type === "compact");
		expect(compactBlock?.status).toBe("compacted");
	});

	it("getMessagesAfter 可通过 legacy parent anchor 补拉遗漏的 child 消息", async () => {
		seedBase();

		insertMessage({
			id: "m-old",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-old", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "m-old",
			toolUseId: "tu-old",
			toolName: "Task",
			status: "running",
		});

		insertMessage({
			id: "c-orphan",
			seq: 1,
			parentToolUseId: "tu-old",
			contentJson: [{ type: "text", text: "old child" }],
		});

		insertMessage({
			id: "m-new",
			seq: 2,
			contentJson: [{ type: "tool_use", id: "tu-new", name: "Bash", input: { command: "ls" } }],
		});
		insertToolCall({
			messageId: "m-new",
			toolUseId: "tu-new",
			toolName: "Bash",
			status: "success",
		});

		insertMessage({
			id: "c-new",
			seq: 3,
			parentToolUseId: "tu-new",
			contentJson: [{ type: "text", text: "new child" }],
		});

		const first = await narratorService.getMessagesAfter("n1", "m-old", 40);
		expect(first.hitLimit).toBe(false);
		expect(first.topLevel.map((m: { id: string }) => m.id)).toEqual(["m-new"]);
		expect(first.topLevel.map((m: { seq?: number }) => m.seq)).toEqual([2]);
		expect(first.topLevel[0]?.children?.map((c: { id: string }) => c.id)).toEqual(["c-new"]);
		expect(first.orphanChildren.map((m: { id: string }) => m.id)).toEqual(["c-orphan"]);

		db.update(narratorToolCalls)
			.set({ status: "success" })
			.where(eq(narratorToolCalls.toolUseId, "tu-old"))
			.run();

		const second = await narratorService.getMessagesAfter("n1", "m-old", 40);
		expect(second.orphanChildren.map((m: { id: string }) => m.id)).toEqual(["c-orphan"]);
	});

	it("getMessagesAfter 父流新增消息超过 limit 时短路返回 hitLimit", async () => {
		seedBase();

		insertMessage({
			id: "m-anchor",
			seq: 0,
			contentJson: [{ type: "text", text: "anchor" }],
		});

		// Insert more top-level messages than the small limit we'll pass in.
		for (let i = 1; i <= 5; i++) {
			insertMessage({
				id: `m-${i}`,
				seq: i,
				contentJson: [{ type: "text", text: `msg ${i}` }],
			});
		}

		// limit = 3, but 5 new messages exist after the anchor → hitLimit.
		const result = await narratorService.getMessagesAfter("n1", "m-anchor", 3);
		expect(result.hitLimit).toBe(true);
		expect(result.topLevel).toEqual([]);
		expect(result.orphanChildren).toEqual([]);

		// limit = 5 exactly covers the 5 new messages → no hitLimit.
		const within = await narratorService.getMessagesAfter("n1", "m-anchor", 5);
		expect(within.hitLimit).toBe(false);
		expect(within.topLevel.map((m: { id: string }) => m.id)).toEqual([
			"m-1",
			"m-2",
			"m-3",
			"m-4",
			"m-5",
		]);
	});

	it("getMessagesAfter 复合 cursor 同时补拉 child stream 和父流新增消息", async () => {
		seedBase();
		db.insert(narrators)
			.values({
				id: "sub1",
				chapterId: "ch1",
				type: "subagent",
				subagentType: "general",
				variant: "subagent:general",
				inheritMode: "fresh",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();

		insertMessage({
			id: "m-old",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-old", name: "Agent", input: {} }],
		});
		insertToolCall({
			messageId: "m-old",
			toolUseId: "tu-old",
			toolName: "Agent",
			status: "running",
		});
		insertMessage({
			id: "c-seen",
			seq: 0,
			narratorId: "sub1",
			parentToolUseId: "tu-old",
			contentJson: [{ type: "text", text: "seen child" }],
		});
		insertMessage({
			id: "c-missed",
			seq: 1,
			narratorId: "sub1",
			parentToolUseId: "tu-old",
			contentJson: [{ type: "text", text: "missed child" }],
		});
		insertMessage({
			id: "m-new",
			seq: 1,
			contentJson: [{ type: "text", text: "new parent" }],
		});

		const first = await narratorService.getMessagesAfter("n1", {
			parentLastMessageId: "m-old",
			childAnchors: [{ parentToolUseId: "tu-old", narratorId: "sub1", lastMessageId: "c-seen" }],
		});
		expect(first.hitLimit).toBe(false);
		expect(first.topLevel.map((m: { id: string }) => m.id)).toEqual(["m-new"]);
		expect(first.orphanChildren.map((m: { id: string }) => m.id)).toEqual(["c-missed"]);
		expect(first.cursor?.parentLastMessageId).toBe("m-new");
		expect(
			first.cursor?.childAnchors?.find((a) => a.parentToolUseId === "tu-old")?.lastMessageId,
		).toBe("c-missed");

		insertMessage({
			id: "c-next",
			seq: 2,
			narratorId: "sub1",
			parentToolUseId: "tu-old",
			contentJson: [{ type: "text", text: "next child" }],
		});

		const cursor = first.cursor;
		expect(cursor).toBeDefined();
		if (!cursor) throw new Error("Expected catch-up cursor");
		const second = await narratorService.getMessagesAfter("n1", cursor, 40);
		expect(second.topLevel).toHaveLength(0);
		expect(second.orphanChildren.map((m: { id: string }) => m.id)).toEqual(["c-next"]);
	});

	it("getMessagesAfter open child anchor 可补拉第一条 missed child", async () => {
		seedBase();
		db.insert(narrators)
			.values({
				id: "sub1",
				chapterId: "ch1",
				type: "subagent",
				subagentType: "general",
				variant: "subagent:general",
				inheritMode: "fresh",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();

		insertMessage({
			id: "m-old",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "tu-old", name: "Agent", input: {} }],
		});
		insertToolCall({
			messageId: "m-old",
			toolUseId: "tu-old",
			toolName: "Agent",
			status: "running",
		});
		insertMessage({
			id: "c-first",
			seq: 0,
			narratorId: "sub1",
			parentToolUseId: "tu-old",
			contentJson: [{ type: "text", text: "first child" }],
		});

		const result = await narratorService.getMessagesAfter("n1", {
			parentLastMessageId: "m-old",
			childAnchors: [{ parentToolUseId: "tu-old" }],
		});
		expect(result.hitLimit).toBe(false);
		expect(result.topLevel).toHaveLength(0);
		expect(result.orphanChildren.map((m: { id: string }) => m.id)).toEqual(["c-first"]);
	});

	it("getMessageLocation 以 primary 子消息所属顶层消息为 chunk 坐标", async () => {
		seedBase();

		insertMessage({
			id: "m-parent",
			seq: 2,
			contentJson: [{ type: "tool_use", id: "tu-parent", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "m-parent",
			toolUseId: "tu-parent",
			toolName: "Task",
			status: "running",
		});
		insertMessage({
			id: "c-target",
			seq: 3,
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "child target" }],
		});

		const childLocation = await narratorService.getMessageLocation("n1", "c-target");
		expect(childLocation).toEqual({
			messageId: "c-target",
			topLevelMessageId: "m-parent",
			seq: 2,
		});

		const parentLocation = await narratorService.getMessageLocation("n1", "m-parent");
		expect(parentLocation).toEqual({
			messageId: "m-parent",
			topLevelMessageId: "m-parent",
			seq: 2,
		});
	});

	it("getMessageLocation 支持通过 refs 定位 fork 继承的共享子消息", async () => {
		seedBase("n1");
		db.insert(narrators)
			.values({
				id: "n2",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "full",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();

		insertMessage({
			id: "shared-parent",
			seq: 0,
			narratorId: "n1",
			contentJson: [{ type: "tool_use", id: "tu-shared", name: "Task", input: {} }],
		});
		insertToolCall({
			messageId: "shared-parent",
			toolUseId: "tu-shared",
			toolName: "Task",
			status: "running",
			narratorId: "n1",
		});
		insertMessage({
			id: "shared-child",
			seq: 1,
			narratorId: "n1",
			parentToolUseId: "tu-shared",
			contentJson: [{ type: "text", text: "shared child" }],
		});
		db.insert(narratorMessageRefs)
			.values([
				{ id: "ref-n2-shared-parent", narratorId: "n2", messageId: "shared-parent", seq: 0 },
				{ id: "ref-n2-shared-child", narratorId: "n2", messageId: "shared-child", seq: 1 },
			])
			.run();

		const location = await narratorService.getMessageLocation("n2", "shared-child");
		expect(location).toEqual({
			messageId: "shared-child",
			topLevelMessageId: "shared-parent",
			seq: 0,
		});
	});

	it("getMessageLocation 在重复 toolUseId 时只使用当前 narrator 可见父消息", async () => {
		seedBase("n1");
		db.insert(narrators)
			.values({
				id: "n2",
				chapterId: "ch1",
				type: "primary",
				inheritMode: "fresh",
				createdAt: ts(),
				updatedAt: ts(),
			})
			.run();

		insertMessage({
			id: "wrong-parent",
			seq: 0,
			narratorId: "n1",
			contentJson: [{ type: "tool_use", id: "tu-dup", name: "Task", input: {} }],
		});
		insertMessage({
			id: "right-parent",
			seq: 4,
			narratorId: "n2",
			contentJson: [{ type: "tool_use", id: "tu-dup", name: "Task", input: {} }],
		});
		insertMessage({
			id: "right-child",
			seq: 5,
			narratorId: "n2",
			parentToolUseId: "tu-dup",
			contentJson: [{ type: "text", text: "child in n2" }],
		});
		db.insert(narratorToolCalls)
			.values([
				{
					id: "tc-wrong-dup",
					narratorId: "n1",
					messageId: "wrong-parent",
					toolUseId: "tu-dup",
					toolName: "Task",
					status: "running",
					createdAt: ts(),
				},
				{
					id: "tc-right-dup",
					narratorId: "n2",
					messageId: "right-parent",
					toolUseId: "tu-dup",
					toolName: "Task",
					status: "running",
					createdAt: ts(),
				},
			])
			.run();

		const location = await narratorService.getMessageLocation("n2", "right-child");
		expect(location).toEqual({
			messageId: "right-child",
			topLevelMessageId: "right-parent",
			seq: 4,
		});
	});

	it("getMessageLocation 在 subagent 自身页面按自身 refs 定位", async () => {
		seedBase("n-sub");
		db.update(narrators)
			.set({ type: "subagent", subagentType: "general", variant: "subagent:general" })
			.where(eq(narrators.id, "n-sub"))
			.run();

		insertMessage({
			id: "s-child",
			seq: 7,
			narratorId: "n-sub",
			parentToolUseId: "tu-parent",
			contentJson: [{ type: "text", text: "subagent child as top-level" }],
		});

		const location = await narratorService.getMessageLocation("n-sub", "s-child");
		expect(location).toEqual({
			messageId: "s-child",
			topLevelMessageId: "s-child",
			seq: 7,
		});
	});

	describe("getChunksByRange 边界标志", () => {
		// CHUNK_SIZE = 20; seed 50 top-level messages (seq 0..49) so a count=1
		// window (rowLimit 20) leaves content on both sides for paging.
		function seedManyMessages(n: number) {
			seedBase("n1");
			for (let i = 0; i < n; i++) {
				insertMessage({
					id: `m${i}`,
					seq: i,
					contentJson: [{ type: "text", text: `msg ${i}` }],
				});
			}
		}

		it("尾部窗口 hasOlder 为真、hasNewer 为假", async () => {
			seedManyMessages(50);
			const res = await narratorService.getChunksByRange("n1", { direction: "older", count: 1 });
			// Tail window: newest 20 messages, seq 30..49.
			expect(res.minSeq).toBe(30);
			expect(res.maxSeq).toBe(49);
			expect(res.hasOlder).toBe(true);
			expect(res.hasNewer).toBe(false);
		});

		it("向更早分页时两侧标志都精确（中间窗口）", async () => {
			seedManyMessages(50);
			const tail = await narratorService.getChunksByRange("n1", { direction: "older", count: 1 });
			// Page older from the tail's min seq (30): expect seq 10..29.
			const older = await narratorService.getChunksByRange("n1", {
				direction: "older",
				count: 1,
				fromSeq: tail.minSeq ?? undefined,
			});
			expect(older.minSeq).toBe(10);
			expect(older.maxSeq).toBe(29);
			// Still older content below seq 10, and newer content above seq 29.
			expect(older.hasOlder).toBe(true);
			expect(older.hasNewer).toBe(true);
		});

		it("到达最早一页时 hasOlder 为假、hasNewer 为真", async () => {
			seedManyMessages(50);
			// Page older starting just past the head so the window lands on seq 0..9.
			const head = await narratorService.getChunksByRange("n1", {
				direction: "older",
				count: 1,
				fromSeq: 10,
			});
			expect(head.minSeq).toBe(0);
			expect(head.maxSeq).toBe(9);
			expect(head.hasOlder).toBe(false);
			expect(head.hasNewer).toBe(true);
		});

		it("向更新分页时两侧标志都精确", async () => {
			seedManyMessages(50);
			// Newer than seq 9 → seq 10..29 (rowLimit 20).
			const newer = await narratorService.getChunksByRange("n1", {
				direction: "newer",
				count: 1,
				fromSeq: 9,
			});
			expect(newer.minSeq).toBe(10);
			expect(newer.maxSeq).toBe(29);
			expect(newer.hasOlder).toBe(true);
			expect(newer.hasNewer).toBe(true);
		});

		it("消息数不足一个窗口时两侧标志均为假", async () => {
			seedManyMessages(5);
			const res = await narratorService.getChunksByRange("n1", { direction: "older", count: 1 });
			expect(res.minSeq).toBe(0);
			expect(res.maxSeq).toBe(4);
			expect(res.hasOlder).toBe(false);
			expect(res.hasNewer).toBe(false);
		});
	});

	describe("getChunkManifest 窗口化", () => {
		// CHUNK_SIZE = 20; seed 50 top-level messages (seq 0..49) → 3 chunks:
		// [0..19], [20..39], [40..49].
		function seedManyMessages(n: number) {
			seedBase("n1");
			for (let i = 0; i < n; i++) {
				insertMessage({
					id: `m${i}`,
					seq: i,
					contentJson: [{ type: "text", text: `msg ${i}` }],
				});
			}
		}

		it("limitChunks 只返回最新 N 个 chunk，total 仍为全量", async () => {
			seedManyMessages(50);
			const manifest = await narratorService.getChunkManifest("n1", undefined, { limitChunks: 2 });
			expect(manifest.unchanged).toBe(false);
			if (manifest.unchanged) return;
			// Newest 2 chunks: [20..39] and [40..49].
			expect(manifest.chunks.map((c) => [c[1], c[2]])).toEqual([
				[20, 39],
				[40, 49],
			]);
			expect(manifest.total).toBe(50);
			expect(manifest.windowFirstIndex).toBe(1);
			expect(manifest.hasOlderChunks).toBe(true);
		});

		it("beforeSeq 向更早翻页，取紧邻的更旧 chunk", async () => {
			seedManyMessages(50);
			// Older than the tail window (firstSeq 20) → expect chunk [0..19].
			const older = await narratorService.getChunkManifest("n1", undefined, {
				limitChunks: 10,
				beforeSeq: 20,
			});
			expect(older.unchanged).toBe(false);
			if (older.unchanged) return;
			expect(older.chunks.map((c) => [c[1], c[2]])).toEqual([[0, 19]]);
			expect(older.windowFirstIndex).toBe(0);
			expect(older.hasOlderChunks).toBe(false);
			expect(older.total).toBe(50);
		});

		it("limitChunks 覆盖全部时返回完整 manifest 且 hasOlderChunks 为假", async () => {
			seedManyMessages(50);
			const manifest = await narratorService.getChunkManifest("n1", undefined, {
				limitChunks: 100,
			});
			expect(manifest.unchanged).toBe(false);
			if (manifest.unchanged) return;
			expect(manifest.chunks.length).toBe(3);
			expect(manifest.windowFirstIndex).toBe(0);
			expect(manifest.hasOlderChunks).toBe(false);
		});

		it("不传 window 时返回完整 manifest（向后兼容）", async () => {
			seedManyMessages(50);
			const manifest = await narratorService.getChunkManifest("n1");
			expect(manifest.unchanged).toBe(false);
			if (manifest.unchanged) return;
			expect(manifest.chunks.length).toBe(3);
			expect(manifest.windowFirstIndex).toBe(0);
			expect(manifest.hasOlderChunks).toBe(false);
			expect(manifest.total).toBe(50);
		});
	});
});
