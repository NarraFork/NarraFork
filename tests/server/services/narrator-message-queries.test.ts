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

	it("getMessagesCursor 构建树、截断大输出并过滤 ExitPlan→plan compact 包装消息", async () => {
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

		const result = await narratorService.getMessagesCursor("n1", 10);
		expect(result.hasMore).toBe(false);
		expect(result.nextCursor).toBeNull();
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

	it("getMessagesAround 以子消息所属顶层消息为锚点并返回有界上下文窗口", async () => {
		seedBase();

		insertMessage({
			id: "m-older-0",
			seq: 0,
			contentJson: [{ type: "text", text: "older0" }],
		});
		insertMessage({
			id: "m-older-1",
			seq: 1,
			contentJson: [{ type: "text", text: "older1" }],
		});
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
		insertMessage({
			id: "m-newer-0",
			seq: 4,
			contentJson: [{ type: "text", text: "newer0" }],
		});
		insertMessage({
			id: "m-newer-1",
			seq: 5,
			contentJson: [{ type: "text", text: "newer1" }],
		});

		const around = await narratorService.getMessagesAround("n1", "c-target", {
			before: 1,
			after: 1,
		});
		expect(around.hasMore).toBe(true);
		expect(around.nextCursor).toBe("1");
		expect(around.hasMoreAfter).toBe(true);
		expect(around.messages.map((m: { id: string }) => m.id)).toEqual([
			"m-older-1",
			"m-parent",
			"m-newer-0",
		]);
		expect(around.messages.map((m: { seq?: number }) => m.seq)).toEqual([1, 2, 4]);
		expect(around.messages[1]?.children?.map((c: { id: string }) => c.id)).toEqual(["c-target"]);
	});

	it("getMessagesAround 支持通过 refs 定位 fork 继承的共享消息", async () => {
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

		const around = await narratorService.getMessagesAround("n2", "shared-child", {
			before: 0,
			after: 0,
		});
		expect(around.messages.map((m: { id: string }) => m.id)).toEqual(["shared-parent"]);
		expect(around.messages[0]?.children?.map((c: { id: string }) => c.id)).toEqual([
			"shared-child",
		]);
	});
});
