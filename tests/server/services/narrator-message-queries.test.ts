import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { and, eq, inArray } from "drizzle-orm";
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

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { narratorService } = await import("../../../server/services/narrator-service");
const { narratorContext } = await import("../../../server/services/narrator-context");
const { recoverStaleCompactingMessages } = await import(
	"../../../server/services/narrator-persistence"
);
const { cancelCompact, compactLocks, retryFailedCompact, runCustomCompact } = await import(
	"../../../server/services/narrator-compact"
);
const { getNarratorConnections } = await import("../../../server/websocket/narrator-ws");
const originalGenerateCompactSummary = narratorContext.generateCompactSummary.bind(narratorContext);

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

function insertForkNarrator(id = "n2") {
	db.insert(narrators)
		.values({
			id,
			chapterId: "ch1",
			type: "primary",
			inheritMode: "full",
			parentNarratorId: "n1",
			status: "idle",
			createdAt: ts(),
			updatedAt: ts(),
		})
		.run();
}

function shareMessageWithNarrator(messageId: string, narratorId = "n2", seq = 0) {
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${narratorId}-${messageId}`,
			narratorId,
			messageId,
			seq,
			isCompact: 0,
		})
		.run();
}

function captureNarratorEvents(narratorId = "n1") {
	const sent: Array<Record<string, unknown>> = [];
	const fakeWs = {
		data: {
			subscribedNarrators: new Set([narratorId]),
			catchingUpNarrators: new Map(),
			catchUpBuffers: new Map(),
		},
		send(payload: string) {
			sent.push(JSON.parse(payload) as Record<string, unknown>);
		},
	} as never;
	const connections = getNarratorConnections();
	connections.add(fakeWs);
	return { sent, close: () => connections.delete(fakeWs) };
}

async function seedFailedCompact(shared = false) {
	seedBase();
	if (shared) insertForkNarrator("n2");
	insertMessage({
		id: "before",
		seq: 0,
		narratorId: "n1",
		role: "user",
		contentJson: [{ type: "text", text: "before" }],
		contentText: "before",
	});
	insertMessage({
		id: "target",
		seq: 1,
		narratorId: "n1",
		role: "user",
		contentJson: [{ type: "text", text: "target" }],
		contentText: "target",
	});
	const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
		model: "provider:first",
	});
	await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
		status: "failed",
		error: "first failure",
	});
	if (shared) shareMessageWithNarrator(marker.id, "n2", marker.seq);
	return marker;
}

async function seedActiveForkHistory() {
	seedBase();
	insertMessage({
		id: "fork-before",
		seq: 0,
		narratorId: "n1",
		role: "user",
		contentJson: [{ type: "text", text: "before active compact" }],
		contentText: "before active compact",
	});
	const marker = await narratorService.persistCompactingMessage("n1", "fork-before", "blocking", {
		model: "provider:active",
	});
	insertMessage({
		id: "fork-after",
		seq: (marker.seq ?? 0) + 1,
		narratorId: "n1",
		role: "assistant",
		contentJson: [{ type: "text", text: "after active compact" }],
		contentText: "after active compact",
	});
	return marker;
}

beforeEach(() => {
	tsOffset = 0;
});

afterEach(() => {
	narratorContext.generateCompactSummary = originalGenerateCompactSummary;
	compactLocks.clear();
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
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

	it("getChunksByRange 对子代理只返回有界 latest-3 activity，不返回 child 正文", async () => {
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
			inputJson: { secret: "must-not-leak" },
			outputJson: { secret: "must-not-leak" },
		});
		insertToolCall({
			messageId: "c-2",
			toolUseId: "tu-c3",
			toolName: "Bash",
			status: "running",
			narratorId: "sa-done",
		});
		insertToolCall({
			messageId: "c-2",
			toolUseId: "tu-c4",
			toolName: "Read",
			status: "pending",
			narratorId: "sa-done",
		});
		db.insert(narratorToolCalls)
			.values({
				id: "tc-checkpoint",
				narratorId: "sa-done",
				messageId: "c-2",
				toolUseId: "tu-checkpoint",
				toolName: "Write",
				status: "success",
				isFileHistoryCheckpoint: true,
				createdAt: ts(),
			})
			.run();

		const range = await narratorService.getChunksByRange("n1", { count: 1 });
		const taskMsg = range.messages.find((m: { id: string }) => m.id === "m-task");
		expect(taskMsg?.children ?? []).toEqual([]);
		const taskBlock = taskMsg?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-task",
		);
		expect(taskBlock?._subagentActivity?.subagentNarratorId).toBe("sa-done");
		expect(taskBlock?._subagentActivity?.model).toBe("gpt-5.5");
		expect(
			taskBlock?._subagentActivity?.latestToolCalls.map(
				(toolCall: { toolUseId: string }) => toolCall.toolUseId,
			),
		).toEqual(["tu-c2", "tu-c3", "tu-c4"]);
		for (const toolCall of taskBlock?._subagentActivity?.latestToolCalls ?? []) {
			expect(toolCall).not.toHaveProperty("inputJson");
			expect(toolCall).not.toHaveProperty("outputJson");
			expect(toolCall).not.toHaveProperty("sideCars");
		}
		const taskToolCall = taskMsg?.toolCalls?.find(
			(toolCall: { toolUseId: string }) => toolCall.toolUseId === "tu-task",
		);
		expect(taskToolCall?._subagentActivity).toEqual(taskBlock?._subagentActivity);
	});

	it("getChunksByRange 对运行中和后台子代理同样不内联 child 消息", async () => {
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
		expect(taskA?.children ?? []).toEqual([]);
		expect(taskB?.children ?? []).toEqual([]);
		const blockA = taskA?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-a",
		);
		const blockB = taskB?.contentJson?.find(
			(b: { type?: string; id?: string }) => b.type === "tool_use" && b.id === "tu-b",
		);
		expect(blockA?._subagentActivity?.subagentNarratorId).toBe("sa-working");
		expect(blockB?._subagentActivity?.subagentNarratorId).toBe("sa-bg");
	});

	it("getToolCallDetail 必须按 refs 归属授权，而非原始 owner", async () => {
		seedBase();
		insertForkNarrator("n2");
		insertMessage({
			id: "shared-tool-message",
			seq: 0,
			contentJson: [{ type: "tool_use", id: "shared-tool", name: "Bash", input: {} }],
		});
		insertToolCall({
			messageId: "shared-tool-message",
			toolUseId: "shared-tool",
			toolName: "Bash",
		});

		await expect(narratorService.getToolCallDetail("n2", "shared-tool")).rejects.toThrow();
		shareMessageWithNarrator("shared-tool-message", "n2", 0);
		const detail = await narratorService.getToolCallDetail("n2", "shared-tool");
		expect(detail.toolUseId).toBe("shared-tool");
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

	it("failed compact stays non-effective and retry succeeds in place with attempt history", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});
		await db
			.update(narrators)
			.set({
				contextSummary: "old summary",
				apiConversationId: "old-conversation",
				pruneBoundaryMessageId: "before",
				prunedPercent: 42,
			})
			.where(eq(narrators.id, "n1"));

		const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "provider:model-with-history",
			trigger: "manual",
			contextPercentBefore: 97,
		});
		const longError = "x".repeat(2_500);
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "ignored", undefined, {
			status: "failed",
			error: longError,
			mode: "blocking",
		});

		let ref = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, marker.id),
		});
		expect(ref?.isCompact).toBe(0);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator).toMatchObject({
			contextSummary: "old summary",
			apiConversationId: "old-conversation",
			pruneBoundaryMessageId: "before",
			prunedPercent: 42,
		});
		let detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail.status).toBe("failed");
		expect(detail.canRetry).toBe(true);
		expect(detail.error).toHaveLength(2_000);
		expect(detail.error?.endsWith("…")).toBe(true);
		const modelHistory = await narratorService.getModelHistorySinceLastCompact("n1");
		expect(modelHistory.map((message: { id: string }) => message.id)).toEqual(["before", "target"]);
		expect(detail.attempts).toEqual([
			expect.objectContaining({
				attempt: 1,
				model: "provider:model-with-history",
				status: "failed",
			}),
		]);

		const prepared = await narratorService.prepareFailedCompactRetry(
			"n1",
			marker.id,
			"provider:second-model",
		);
		expect(prepared.id).toBe(marker.id);
		expect(prepared.seq).toBe(marker.seq);
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "new summary", 12, {
			mode: "blocking",
		});

		ref = await db.query.narratorMessageRefs.findFirst({
			where: eq(narratorMessageRefs.messageId, marker.id),
		});
		expect(ref?.isCompact).toBe(1);
		detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail).toMatchObject({
			status: "compacted",
			summary: "new summary",
			canRetry: false,
			contextPercentBefore: 97,
			contextPercentAfter: 12,
		});
		expect(
			detail.attempts.map((attempt: { status: string; model: string }) => [
				attempt.status,
				attempt.model,
			]),
		).toEqual([
			["failed", "provider:model-with-history"],
			["completed", "provider:second-model"],
		]);

		await narratorService.updateCompactSummary("n1", marker.id, "edited summary");
		detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail.summary).toBe("edited summary");
		expect(detail.attempts).toHaveLength(2);
		expect(detail.contextPercentBefore).toBe(97);
	});

	it("rejects an old failed marker after a newer compact has succeeded", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});

		const failedMarker = await narratorService.persistCompactingMessage(
			"n1",
			"target",
			"blocking",
			{ model: "provider:first" },
		);
		await narratorService.finalizeCompactingMessage(failedMarker.id, "n1", "", undefined, {
			status: "failed",
			error: "first compact failed",
		});

		const newerCompact = await narratorService.persistCompactingMessage(
			"n1",
			undefined,
			"blocking",
			{
				model: "provider:newer",
			},
		);
		await narratorService.finalizeCompactingMessage(newerCompact.id, "n1", "newer summary", 10);

		const detail = await narratorService.getCompactSummary("n1", failedMarker.id);
		expect(detail).toMatchObject({ status: "failed", canRetry: false });
		await expect(
			narratorService.prepareFailedCompactRetry("n1", failedMarker.id, "provider:retry-too-late"),
		).rejects.toMatchObject({ statusCode: 400 });

		const unchanged = await narratorService.getCompactSummary("n1", failedMarker.id);
		expect(unchanged.status).toBe("failed");
		expect(unchanged.attempts).toHaveLength(1);
	});

	it("does not overwrite a newer context summary when the retry baseline changes", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});

		const failedMarker = await narratorService.persistCompactingMessage(
			"n1",
			"target",
			"blocking",
			{ model: "provider:first" },
		);
		await narratorService.finalizeCompactingMessage(failedMarker.id, "n1", "", undefined, {
			status: "failed",
			error: "first compact failed",
		});
		const prepared = await narratorService.prepareFailedCompactRetry(
			"n1",
			failedMarker.id,
			"provider:retry",
		);
		expect(prepared.compactBoundaryMessageId).toBeNull();

		const concurrentCompact = await narratorService.persistCompactingMessage(
			"n1",
			undefined,
			"blocking",
			{ model: "provider:concurrent" },
		);
		await narratorService.finalizeCompactingMessage(
			concurrentCompact.id,
			"n1",
			"concurrent summary",
			8,
		);

		await expect(
			narratorService.finalizeCompactingMessage(failedMarker.id, "n1", "stale retry summary", 9, {
				mode: "blocking",
				expectedCompactBoundaryMessageId: prepared.compactBoundaryMessageId,
			}),
		).rejects.toMatchObject({ statusCode: 409, code: "COMPACT_BOUNDARY_CHANGED" });

		await narratorService.finalizeCompactingMessage(failedMarker.id, "n1", "", undefined, {
			status: "failed",
			error: "Compact boundary changed while retry was running",
		});
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator?.contextSummary).toBe("concurrent summary");
		const detail = await narratorService.getCompactSummary("n1", failedMarker.id);
		expect(detail).toMatchObject({ status: "failed", canRetry: false });
		expect(detail.attempts.at(-1)).toMatchObject({
			model: "provider:retry",
			status: "failed",
		});
	});

	it("preserves retry attempts and fails the running attempt during startup recovery", async () => {
		seedBase();
		insertMessage({
			id: "target",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});
		const retryMarker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "provider:first",
		});
		await narratorService.finalizeCompactingMessage(retryMarker.id, "n1", "", undefined, {
			status: "failed",
			error: "initial failure",
		});
		await narratorService.prepareFailedCompactRetry("n1", retryMarker.id, "provider:retry");

		insertMessage({
			id: "legacy-placeholder",
			seq: 2,
			role: "system",
			contentText: "[Compacting]",
			contentJson: [{ type: "compact", status: "compacting", mode: "blocking" }],
		});

		const result = await recoverStaleCompactingMessages();
		expect(result).toEqual({ preserved: 1, deleted: 1 });

		const detail = await narratorService.getCompactSummary("n1", retryMarker.id);
		expect(detail).toMatchObject({
			status: "failed",
			canRetry: true,
			error: "Interrupted by server restart",
		});
		expect(
			detail.attempts.map((attempt: { model: string; status: string; error?: string }) => ({
				model: attempt.model,
				status: attempt.status,
				error: attempt.error,
			})),
		).toEqual([
			{ model: "provider:first", status: "failed", error: "initial failure" },
			{
				model: "provider:retry",
				status: "failed",
				error: "Interrupted by server restart",
			},
		]);
		expect(
			await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, "legacy-placeholder"),
			}),
		).toBeUndefined();
	});

	it("cancelling a retry keeps the marker and closes only the running attempt", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});
		await db
			.update(narrators)
			.set({ contextSummary: "keep summary" })
			.where(eq(narrators.id, "n1"));
		const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "provider:first",
		});
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
			status: "failed",
			error: "initial failure",
		});

		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		narratorContext.generateCompactSummary = async (
			_narratorId,
			_locale,
			_providedMessages,
			_pruneBoundaryMessageId,
			signal,
		) => {
			markStarted();
			return new Promise((_resolve, reject) => {
				const abort = () => reject(new DOMException("Aborted", "AbortError"));
				if (signal?.aborted) abort();
				else signal?.addEventListener("abort", abort, { once: true });
			});
		};

		const { promise } = await retryFailedCompact("n1", "en", marker.id, "provider:retry");
		await started;
		expect(cancelCompact("n1")).toBe(true);
		await expect(promise).rejects.toMatchObject({ name: "AbortError" });

		const detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail).toMatchObject({
			status: "failed",
			canRetry: true,
			error: "Compact retry cancelled",
		});
		expect(detail.attempts).toEqual([
			expect.objectContaining({ model: "provider:first", status: "failed" }),
			expect.objectContaining({
				model: "provider:retry",
				status: "failed",
				error: "Compact retry cancelled",
			}),
		]);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator?.contextSummary).toBe("keep summary");
	});

	it("failed compact keeps only the latest ten attempts and deleting it preserves narrator state", async () => {
		seedBase();
		insertMessage({
			id: "target",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
		});
		await db
			.update(narrators)
			.set({
				contextSummary: "keep-summary",
				apiConversationId: "keep-conversation",
				pruneBoundaryMessageId: "target",
				prunedPercent: 55,
			})
			.where(eq(narrators.id, "n1"));
		const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "model-1",
		});
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
			status: "failed",
			error: "failure-1",
		});
		for (let attempt = 2; attempt <= 12; attempt++) {
			await narratorService.prepareFailedCompactRetry("n1", marker.id, `model-${attempt}`);
			await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
				status: "failed",
				error: `failure-${attempt}`,
			});
		}
		const detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail.attempts).toHaveLength(10);
		expect(detail.attempts[0]?.attempt).toBe(3);
		expect(detail.attempts.at(-1)).toMatchObject({ attempt: 12, model: "model-12" });

		await narratorService.deleteCompactMessage("n1", marker.id);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator).toMatchObject({
			contextSummary: "keep-summary",
			apiConversationId: "keep-conversation",
			pruneBoundaryMessageId: "target",
			prunedPercent: 55,
		});
		expect(
			await db.query.narratorMessageRefs.findFirst({
				where: eq(narratorMessageRefs.messageId, marker.id),
			}),
		).toBeUndefined();
	});

	it("retry with no messages before the marker returns it to failed instead of leaving it compacting", async () => {
		seedBase();
		const marker = await narratorService.persistCompactingMessage("n1", undefined, "blocking", {
			model: "provider:first",
		});
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
			status: "failed",
			error: "initial failure",
		});

		const { promise } = await retryFailedCompact("n1", "en", marker.id, "provider:second");
		expect(await promise).toBe(false);
		const detail = await narratorService.getCompactSummary("n1", marker.id);
		expect(detail.status).toBe("failed");
		expect(detail.error).toBe("No messages are available before this compact marker");
		expect(detail.attempts.at(-1)).toMatchObject({
			attempt: 2,
			model: "provider:second",
			status: "failed",
		});
	});

	it("retry preparation failure releases its compact lock reservation", async () => {
		seedBase();
		await expect(retryFailedCompact("n1", "en", "missing-marker")).rejects.toMatchObject({
			statusCode: 404,
		});
		expect(compactLocks.has("n1")).toBe(false);
	});

	it("retryFailedCompact reports concurrent compact as HTTP 409 error", async () => {
		compactLocks.set("n1", {
			kind: "history",
			mode: "blocking",
			promise: Promise.resolve({ kind: "history", compacted: false, mode: "blocking" }),
		});
		try {
			await expect(retryFailedCompact("n1", "en", "failed-marker")).rejects.toMatchObject({
				statusCode: 409,
				code: "COMPACT_IN_PROGRESS",
			});
		} finally {
			compactLocks.delete("n1");
		}
	});

	it("fork 共享失败 compact marker 的 retry 必须 COW 且不影响另一 fork", async () => {
		seedBase();
		insertForkNarrator("n2");
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});
		const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "provider:first",
		});
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
			status: "failed",
			error: "first failure",
		});
		shareMessageWithNarrator(marker.id, "n2", marker.seq);

		const otherBeforeRetry = await narratorService.getCompactSummary("n2", marker.id);
		expect(otherBeforeRetry).toMatchObject({ status: "failed", canRetry: true });

		const prepared = await narratorService.prepareFailedCompactRetry(
			"n1",
			marker.id,
			"provider:retry",
		);
		expect(prepared.id).not.toBe(marker.id);
		expect(prepared.seq).toBe(marker.seq);
		expect(prepared.oldMessageId).toBe(marker.id);
		expect(prepared.replacedMessageId).toBe(marker.id);

		const original = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, marker.id),
		});
		expect(original?.contentText).toContain("Compact Failed");
		const refs = await db
			.select({
				narratorId: narratorMessageRefs.narratorId,
				messageId: narratorMessageRefs.messageId,
			})
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, "n1"));
		expect(refs.some((ref) => ref.messageId === prepared.id)).toBe(true);
		expect(
			await db.query.narratorMessageRefs.findFirst({
				where: and(
					eq(narratorMessageRefs.narratorId, "n2"),
					eq(narratorMessageRefs.messageId, marker.id),
				),
			}),
		).toBeDefined();

		await narratorService.finalizeCompactingMessage(prepared.id, "n1", "private summary", 11, {
			mode: "blocking",
			expectedCompactBoundaryMessageId: prepared.compactBoundaryMessageId,
		});
		expect(await narratorService.getCompactSummary("n1", prepared.id)).toMatchObject({
			status: "compacted",
			summary: "private summary",
		});
		expect(await narratorService.getCompactSummary("n2", marker.id)).toMatchObject({
			status: "failed",
			error: "first failure",
			canRetry: true,
		});
	});

	it("共享 failed compact retry 先删除旧 ID，再更新新 ID并保持 catch-up 只返回新 ref", async () => {
		const marker = await seedFailedCompact(true);
		narratorContext.generateCompactSummary = async () => ({
			summary: "retry summary",
			contextPercent: 11,
		});
		const capture = captureNarratorEvents();
		try {
			const beforeVersion = await narratorService.getMessageVersion("n1");
			const result = await retryFailedCompact("n1", "en", marker.id, "provider:retry");
			expect(result).toMatchObject({ oldMessageId: marker.id, replacedMessageId: marker.id });
			expect(result.message.id).not.toBe(marker.id);
			await expect(result.promise).resolves.toBe(true);

			const historyEvents = capture.sent.filter((event) =>
				["messages_deleted", "message_updated", "compact_done", "compact_failed"].includes(
					String(event.type),
				),
			);
			const deleteIndex = historyEvents.findIndex((event) => event.type === "messages_deleted");
			const firstUpdateIndex = historyEvents.findIndex((event) => event.type === "message_updated");
			expect(deleteIndex).toBeGreaterThanOrEqual(0);
			expect(firstUpdateIndex).toBeGreaterThan(deleteIndex);
			expect(historyEvents[deleteIndex]).toMatchObject({
				deletedMessageIds: [marker.id],
				oldMessageId: marker.id,
				replacedMessageId: marker.id,
				messageId: result.message.id,
				newMessageId: result.message.id,
				replacementMessageId: result.message.id,
			});

			const updatedIds = historyEvents
				.filter((event) => event.type === "message_updated")
				.map((event) => (event.message as { id?: string } | undefined)?.id);
			expect(updatedIds.length).toBeGreaterThan(0);
			expect(updatedIds.every((id) => id === result.message.id)).toBe(true);
			const done = historyEvents.find((event) => event.type === "compact_done");
			expect(done).toMatchObject({
				messageId: result.message.id,
				newMessageId: result.message.id,
				replacementMessageId: result.message.id,
				oldMessageId: marker.id,
				replacedMessageId: marker.id,
			});

			const afterVersion = await narratorService.getMessageVersion("n1");
			expect(afterVersion).toBe(beforeVersion + 2);
			expect(done?.messageVersion).toBe(afterVersion);
			const catchUp = await narratorService.getMessagesAfter(
				"n1",
				{ parentLastMessageId: "before" },
				40,
			);
			const catchUpIds = [...catchUp.topLevel, ...catchUp.orphanChildren].map(
				(message: { id: string }) => message.id,
			);
			expect(catchUpIds).toContain(result.message.id);
			expect(catchUpIds).not.toContain(marker.id);
			expect(catchUpIds.filter((id) => id === result.message.id)).toHaveLength(1);
			expect(catchUp.cursor?.parentLastMessageId).toBe("target");
		} finally {
			capture.close();
		}
	});

	it("普通 failed compact retry 不产生多余的替换删除事件", async () => {
		const marker = await seedFailedCompact();
		narratorContext.generateCompactSummary = async () => ({
			summary: "ordinary retry summary",
			contextPercent: 9,
		});
		const capture = captureNarratorEvents();
		try {
			const result = await retryFailedCompact("n1", "en", marker.id, "provider:retry");
			expect(result.message.id).toBe(marker.id);
			expect(result.replacedMessageId).toBeUndefined();
			await expect(result.promise).resolves.toBe(true);

			expect(capture.sent.some((event) => event.type === "messages_deleted")).toBe(false);
			const updatedIds = capture.sent
				.filter((event) => event.type === "message_updated")
				.map((event) => (event.message as { id?: string } | undefined)?.id);
			expect(updatedIds.length).toBeGreaterThan(0);
			expect(updatedIds.every((id) => id === marker.id)).toBe(true);
			const done = capture.sent.find((event) => event.type === "compact_done");
			expect(done).toMatchObject({ messageId: marker.id });
			expect(done?.oldMessageId).toBeUndefined();
			expect(done?.replacedMessageId).toBeUndefined();
		} finally {
			capture.close();
		}
	});

	it("共享 failed compact retry 失败终态也使用新 ID并保留旧操作关联", async () => {
		const marker = await seedFailedCompact(true);
		narratorContext.generateCompactSummary = async () => {
			throw new Error("retry summary failed");
		};
		const capture = captureNarratorEvents();
		try {
			const result = await retryFailedCompact("n1", "en", marker.id, "provider:retry");
			expect(result.message.id).not.toBe(marker.id);
			await expect(result.promise).rejects.toThrow("retry summary failed");
			const failed = capture.sent.find((event) => event.type === "compact_failed");
			expect(failed).toMatchObject({
				messageId: result.message.id,
				oldMessageId: marker.id,
				replacedMessageId: marker.id,
			});
		} finally {
			capture.close();
		}
	});

	it("另一 fork 可按 refs 归属读取共享失败 marker 详情", async () => {
		seedBase();
		insertForkNarrator("n2");
		const marker = await narratorService.persistCompactingMessage("n1", undefined, "blocking", {
			model: "provider:first",
		});
		await narratorService.finalizeCompactingMessage(marker.id, "n1", "", undefined, {
			status: "failed",
			error: "shared failure",
		});
		shareMessageWithNarrator(marker.id, "n2", marker.seq);

		const detail = await narratorService.getCompactSummary("n2", marker.id);
		expect(detail).toMatchObject({ status: "failed", error: "shared failure", canRetry: true });
	});

	it("restart recovery 处理共享 compact marker 时必须覆盖所有 refs", async () => {
		seedBase();
		insertForkNarrator("n2");
		insertMessage({
			id: "target",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});
		const marker = await narratorService.persistCompactingMessage("n1", "target", "blocking", {
			model: "provider:restart",
		});
		shareMessageWithNarrator(marker.id, "n2", marker.seq);
		const beforeN2 = await db.query.narrators.findFirst({ where: eq(narrators.id, "n2") });

		const recovered = await recoverStaleCompactingMessages();
		expect(recovered.preserved).toBe(1);
		const recoveredRefs = await db
			.select({
				narratorId: narratorMessageRefs.narratorId,
				messageId: narratorMessageRefs.messageId,
			})
			.from(narratorMessageRefs)
			.where(
				and(
					inArray(narratorMessageRefs.narratorId, ["n1", "n2"]),
					eq(narratorMessageRefs.seq, marker.seq),
				),
			);
		expect(recoveredRefs).toHaveLength(2);
		for (const narratorId of ["n1", "n2"]) {
			const ref = recoveredRefs.find((row) => row.narratorId === narratorId);
			expect(ref).toBeDefined();
			if (!ref) continue;
			const detail = await narratorService.getCompactSummary(narratorId, ref.messageId);
			expect(detail).toMatchObject({ status: "failed", error: "Interrupted by server restart" });
		}
		const afterN2 = await db.query.narrators.findFirst({ where: eq(narrators.id, "n2") });
		expect(afterN2?.messageVersion).toBeGreaterThan(beforeN2?.messageVersion ?? 0);
	});

	it("生成期间不能直接删除 compact marker，取消后才清理", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});
		let markStarted!: () => void;
		let resolveSummary!: (value: { summary: string; contextPercent: number }) => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		narratorContext.generateCompactSummary = async (
			_narratorId,
			_locale,
			_messages,
			_pruneBoundaryMessageId,
			_signal,
		) => {
			markStarted();
			return new Promise((resolve) => {
				resolveSummary = resolve;
			});
		};

		const beforeVersion = await narratorService.getMessageVersion("n1");
		const capture = captureNarratorEvents();
		try {
			const compactPromise = runCustomCompact("n1", "en", "target", { mode: "blocking" });
			await started;
			const marker = await db.query.narratorMessages.findFirst({
				where: and(
					eq(narratorMessages.narratorId, "n1"),
					eq(narratorMessages.contentText, "[Compacting]"),
				),
			});
			expect(marker).toBeDefined();
			if (!marker) throw new Error("Expected compact marker");
			await expect(narratorService.deleteCompactMessage("n1", marker.id)).rejects.toMatchObject({
				statusCode: 409,
			});
			expect(
				await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, marker.id) }),
			).toBeDefined();

			expect(cancelCompact("n1")).toBe(true);
			resolveSummary({ summary: "late summary", contextPercent: 4 });
			await expect(compactPromise).rejects.toMatchObject({ name: "AbortError" });
			expect(
				await db.query.narratorMessages.findFirst({ where: eq(narratorMessages.id, marker.id) }),
			).toBeUndefined();
			const afterVersion = await narratorService.getMessageVersion("n1");
			expect(afterVersion).toBe(beforeVersion + 3);
			const done = capture.sent.find((event) => event.type === "compact_done");
			expect(done?.messageVersion).toBe(afterVersion);
		} finally {
			capture.close();
		}
	});

	it("finalize CAS 失败时不得清 summary/prune 或成功返回", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});
		await db
			.update(narrators)
			.set({
				contextSummary: "keep summary",
				pruneBoundaryMessageId: "before",
				prunedPercent: 37,
			})
			.where(eq(narrators.id, "n1"));

		let resolveSummary!: (value: { summary: string; contextPercent: number }) => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const summaryReady = new Promise<{ summary: string; contextPercent: number }>((resolve) => {
			resolveSummary = resolve;
		});
		narratorContext.generateCompactSummary = async () => {
			markStarted();
			return summaryReady;
		};
		const sent: Array<{ type?: string }> = [];
		const fakeWs = {
			data: {
				subscribedNarrators: new Set(["n1"]),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
			},
			send(payload: string) {
				sent.push(JSON.parse(payload) as { type?: string });
			},
		} as never;
		const connections = getNarratorConnections();
		connections.add(fakeWs);

		const compactPromise = runCustomCompact("n1", "en", "target", { mode: "blocking" });
		await started;
		const marker = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, "n1"),
				eq(narratorMessages.contentText, "[Compacting]"),
			),
		});
		expect(marker).toBeDefined();
		if (!marker) throw new Error("Expected compact marker");
		// Simulate a concurrent deletion after summary generation began. The public
		// delete path rejects this state; this models the DB race that finalize CAS must
		// treat as a failed compact rather than a successful completion.
		db.transaction((tx) => {
			tx.delete(narratorMessageRefs)
				.where(
					and(
						eq(narratorMessageRefs.narratorId, "n1"),
						eq(narratorMessageRefs.messageId, marker.id),
					),
				)
				.run();
			tx.delete(narratorMessages).where(eq(narratorMessages.id, marker.id)).run();
		});
		resolveSummary({ summary: "must not apply", contextPercent: 9 });

		try {
			await expect(compactPromise).rejects.toBeTruthy();
		} finally {
			connections.delete(fakeWs);
		}
		expect(sent.some((message) => message.type === "compact_done")).toBe(false);
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator).toMatchObject({
			contextSummary: "keep summary",
			pruneBoundaryMessageId: "before",
			prunedPercent: 37,
		});
	});

	it("finalize CAS 检查 attempt/status 冲突并拒绝晚到摘要", async () => {
		seedBase();
		insertMessage({
			id: "before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "before" }],
			contentText: "before",
		});
		insertMessage({
			id: "target",
			seq: 1,
			role: "user",
			contentJson: [{ type: "text", text: "target" }],
			contentText: "target",
		});
		await db
			.update(narrators)
			.set({ contextSummary: "keep summary", pruneBoundaryMessageId: "before" })
			.where(eq(narrators.id, "n1"));

		let resolveSummary!: (value: { summary: string; contextPercent: number }) => void;
		let markStarted!: () => void;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		const summaryReady = new Promise<{ summary: string; contextPercent: number }>((resolve) => {
			resolveSummary = resolve;
		});
		narratorContext.generateCompactSummary = async () => {
			markStarted();
			return summaryReady;
		};
		const sent: Array<{ type?: string }> = [];
		const fakeWs = {
			data: {
				subscribedNarrators: new Set(["n1"]),
				catchingUpNarrators: new Map(),
				catchUpBuffers: new Map(),
			},
			send(payload: string) {
				sent.push(JSON.parse(payload) as { type?: string });
			},
		} as never;
		const connections = getNarratorConnections();
		connections.add(fakeWs);

		const compactPromise = runCustomCompact("n1", "en", "target", { mode: "blocking" });
		await started;
		const marker = await db.query.narratorMessages.findFirst({
			where: and(
				eq(narratorMessages.narratorId, "n1"),
				eq(narratorMessages.contentText, "[Compacting]"),
			),
		});
		expect(marker).toBeDefined();
		if (!marker) throw new Error("Expected compact marker");
		const rawContent = marker.contentJson;
		const block = (Array.isArray(rawContent) ? rawContent[0] : null) as {
			status: string;
			attempts?: Array<Record<string, unknown>>;
		} | null;
		expect(block).toBeDefined();
		if (!block) throw new Error("Expected compact block");
		const attempts = block.attempts ?? [];
		const lastAttempt = attempts.at(-1);
		expect(lastAttempt?.status).toBe("running");
		if (!lastAttempt) throw new Error("Expected running compact attempt");
		const newerAttemptBlock = {
			...block,
			status: "compacting",
			attempts: [
				...attempts.slice(0, -1),
				{
					...lastAttempt,
					attempt: Number(lastAttempt.attempt) + 1,
					status: "running",
					startedAt: ts(),
				},
			],
		};
		db.update(narratorMessages)
			.set({ contentJson: [newerAttemptBlock], contentText: "[Compacting]" })
			.where(eq(narratorMessages.id, marker.id))
			.run();
		resolveSummary({ summary: "must not apply", contextPercent: 9 });

		try {
			await expect(compactPromise).rejects.toBeTruthy();
		} finally {
			connections.delete(fakeWs);
		}
		expect(sent.some((message) => message.type === "compact_done")).toBe(false);
		const unchangedMarker = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, marker.id),
		});
		expect(unchangedMarker?.contentText).toBe("[Compacting]");
		const unchangedBlock = Array.isArray(unchangedMarker?.contentJson)
			? unchangedMarker.contentJson[0]
			: null;
		expect(unchangedBlock).toMatchObject({ status: "compacting" });
		const narrator = await db.query.narrators.findFirst({ where: eq(narrators.id, "n1") });
		expect(narrator).toMatchObject({
			contextSummary: "keep summary",
			pruneBoundaryMessageId: "before",
		});
	});

	it("getMessagesAfter 通过 parent cursor 补拉父流时不内联子代理 child 正文", async () => {
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

		const first = await narratorService.getMessagesAfter(
			"n1",
			{ parentLastMessageId: "m-old" },
			40,
		);
		expect(first.hitLimit).toBe(false);
		expect(first.topLevel.map((m: { id: string }) => m.id)).toEqual(["m-new"]);
		expect(first.topLevel.map((m: { seq?: number }) => m.seq)).toEqual([2]);
		expect(first.topLevel[0]?.children?.map((c: { id: string }) => c.id)).toEqual(["c-new"]);
		expect(first.orphanChildren).toEqual([]);

		db.update(narratorToolCalls)
			.set({ status: "success" })
			.where(eq(narratorToolCalls.toolUseId, "tu-old"))
			.run();

		const second = await narratorService.getMessagesAfter(
			"n1",
			{ parentLastMessageId: "m-old" },
			40,
		);
		expect(second.orphanChildren).toEqual([]);
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
		const result = await narratorService.getMessagesAfter(
			"n1",
			{ parentLastMessageId: "m-anchor" },
			3,
		);
		expect(result.hitLimit).toBe(true);
		expect(result.topLevel).toEqual([]);
		expect(result.orphanChildren).toEqual([]);

		// limit = 5 exactly covers the 5 new messages → no hitLimit.
		const within = await narratorService.getMessagesAfter(
			"n1",
			{ parentLastMessageId: "m-anchor" },
			5,
		);
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
				parentNarratorId: "n1",
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
		expect(first.orphanChildren).toEqual([]);
		expect(
			first.subagentActivities.find((item) => item.parentToolUseId === "tu-old")?.activity
				.subagentNarratorId,
		).toBe("sub1");
		expect(first.cursor?.parentLastMessageId).toBe("m-new");
		expect(first.cursor?.childAnchors?.some((a) => a.parentToolUseId === "tu-old")).toBe(true);

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
		expect(second.orphanChildren).toEqual([]);
		expect(
			second.subagentActivities.find((item) => item.parentToolUseId === "tu-old")?.activity
				.subagentNarratorId,
		).toBe("sub1");
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
				parentNarratorId: "n1",
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
		expect(result.orphanChildren).toEqual([]);
		expect(
			result.subagentActivities.find((item) => item.parentToolUseId === "tu-old")?.activity
				.subagentNarratorId,
		).toBe("sub1");
	});

	it("getMessagesAfter 不接受其他 narrator 的 subagent activity anchor", async () => {
		seedBase();
		db.insert(narrators)
			.values([
				{
					id: "n2",
					chapterId: "ch1",
					type: "primary",
					inheritMode: "fresh",
					createdAt: ts(),
					updatedAt: ts(),
				},
				{
					id: "sub-foreign",
					chapterId: "ch1",
					type: "subagent",
					subagentType: "general",
					variant: "subagent:general",
					parentNarratorId: "n2",
					inheritMode: "fresh",
					createdAt: ts(),
					updatedAt: ts(),
				},
			])
			.run();
		insertMessage({ id: "m-own", seq: 0, contentJson: [{ type: "text", text: "own" }] });
		insertMessage({
			id: "m-foreign",
			seq: 0,
			narratorId: "n2",
			contentJson: [{ type: "tool_use", id: "tu-foreign", name: "Agent", input: {} }],
		});
		insertToolCall({
			messageId: "m-foreign",
			toolUseId: "tu-foreign",
			toolName: "Agent",
			status: "running",
			narratorId: "n2",
		});
		insertMessage({
			id: "c-foreign",
			seq: 0,
			narratorId: "sub-foreign",
			parentToolUseId: "tu-foreign",
			contentJson: [{ type: "text", text: "private child" }],
		});

		const result = await narratorService.getMessagesAfter("n1", {
			parentLastMessageId: "m-own",
			childAnchors: [{ parentToolUseId: "tu-foreign" }],
		});
		expect(result.hitLimit).toBe(false);
		expect(result.subagentActivities).toEqual([]);
		expect(
			result.cursor?.childAnchors?.some((anchor) => anchor.parentToolUseId === "tu-foreign"),
		).toBe(false);
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

	it("full fork 在 active compact 期间跳过 marker，稳定消息 seq/cursor 与继续写入保持正确", async () => {
		const marker = await seedActiveForkHistory();
		const child = await narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
		});

		const childRefs = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, child.id))
			.orderBy(narratorMessageRefs.seq)
			.all();
		expect(childRefs.map((row) => row.messageId)).toEqual(["fork-before", "fork-after"]);
		expect(childRefs.map((row) => row.seq)).toEqual([0, 1]);
		expect(childRefs.some((row) => row.messageId === marker.id)).toBe(false);

		const childMessages = await narratorService.getMessages(child.id);
		expect(childMessages.map((message: { id: string }) => message.id)).toEqual([
			"fork-before",
			"fork-after",
		]);
		const childRow = await db.query.narrators.findFirst({ where: eq(narrators.id, child.id) });
		expect(childRow?.forkMessageId).toBe("fork-after");
		const childManifest = await narratorService.getChunkManifest(child.id);
		expect(childManifest.unchanged).toBe(false);
		if (!childManifest.unchanged) {
			expect(childManifest.total).toBe(2);
			expect(childManifest.messageVersion).toBe(childRow?.messageVersion ?? 0);
		}

		const beforeVersion = await narratorService.getMessageVersion(child.id);
		const continued = await narratorService.persistUserMessage(child.id, "continue after fork");
		expect(continued.seq).toBe(2);
		expect(await narratorService.getMessageVersion(child.id)).toBe(beforeVersion + 1);
		const afterCursor = await narratorService.getMessagesAfter(
			child.id,
			{ parentLastMessageId: "fork-before" },
			10,
		);
		expect(afterCursor.topLevel.map((message: { id: string }) => message.id)).toEqual([
			"fork-after",
			continued.id,
		]);
	});

	it("selected-message fork 同样跳过 legacy running marker，并保持稳定 ref 顺序", async () => {
		const marker = await seedActiveForkHistory();
		db.update(narratorMessages)
			.set({ contentJson: [{ type: "compact", status: "running" }] })
			.where(eq(narratorMessages.id, marker.id))
			.run();

		const child = await narratorService.forkFromMessages("n1", [marker.id, "fork-after"]);
		const refs = await db
			.select({ messageId: narratorMessageRefs.messageId, seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, child.id))
			.orderBy(narratorMessageRefs.seq)
			.all();
		expect(refs).toEqual([{ messageId: "fork-after", seq: 1 }]);
	});

	it("父 compact 成功 finalize 后只更新父 marker，子 narrator 不会出现瞬态 marker", async () => {
		const marker = await seedActiveForkHistory();
		const child = await narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
		});

		await narratorService.finalizeCompactingMessage(marker.id, "n1", "success summary", 12);
		const parentDetail = await narratorService.getCompactSummary("n1", marker.id);
		expect(parentDetail).toMatchObject({ status: "compacted", summary: "success summary" });
		const childDetail = await db.query.narratorMessages.findFirst({
			where: and(eq(narratorMessages.id, marker.id), eq(narratorMessages.narratorId, child.id)),
		});
		expect(childDetail).toBeUndefined();
		const childIds = (await narratorService.getMessages(child.id)).map(
			(message: { id: string }) => message.id,
		);
		expect(childIds).toEqual(["fork-before", "fork-after"]);
	});

	it("父 compact 失败 finalize 后保留父 failed 历史，但子仍只含稳定消息", async () => {
		const marker = await seedActiveForkHistory();
		const child = await narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
		});

		await narratorService.finalizeCompactingMessage(marker.id, "n1", "ignored", undefined, {
			status: "failed",
			error: "parent compact failed",
		});
		expect(await narratorService.getCompactSummary("n1", marker.id)).toMatchObject({
			status: "failed",
			error: "parent compact failed",
		});
		const childRefs = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, child.id))
			.orderBy(narratorMessageRefs.seq)
			.all();
		expect(childRefs.map((row) => row.messageId)).toEqual(["fork-before", "fork-after"]);
	});

	it("fork 与 finalize 并发边界最终只允许稳定 marker 状态进入子 narrator", async () => {
		const marker = await seedActiveForkHistory();
		const forkPromise = narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
		});
		const finalizePromise = narratorService.finalizeCompactingMessage(
			marker.id,
			"n1",
			"concurrent summary",
		);
		const [child] = await Promise.all([forkPromise, finalizePromise]);

		const childRefs = await db
			.select({ messageId: narratorMessageRefs.messageId })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, child.id))
			.orderBy(narratorMessageRefs.seq)
			.all();
		const childMarkerId = childRefs.map((row) => row.messageId).find((id) => id === marker.id);
		if (childMarkerId) {
			const childMarker = await db.query.narratorMessages.findFirst({
				where: eq(narratorMessages.id, childMarkerId),
			});
			const block = Array.isArray(childMarker?.contentJson) ? childMarker.contentJson[0] : null;
			expect(block).toMatchObject({ type: "compact", status: "compacted" });
		} else {
			expect(childRefs.map((row) => row.messageId)).toEqual(["fork-before", "fork-after"]);
		}
		expect(await narratorService.getCompactSummary("n1", marker.id)).toMatchObject({
			status: "compacted",
			summary: "concurrent summary",
		});
	});

	it("full fork 不过滤 failed/compacted 历史 marker，也不误复制 segment compact hidden refs", async () => {
		seedBase();
		insertMessage({
			id: "stable-before",
			seq: 0,
			role: "user",
			contentJson: [{ type: "text", text: "stable before" }],
		});
		const failedMarker = await narratorService.persistCompactingMessage(
			"n1",
			"stable-before",
			"blocking",
			{
				model: "provider:failed-history",
			},
		);
		await narratorService.finalizeCompactingMessage(failedMarker.id, "n1", "", undefined, {
			status: "failed",
			error: "historical failure",
		});
		const compactedMarker = await narratorService.persistCompactingMessage(
			"n1",
			undefined,
			"blocking",
			{
				model: "provider:compacted-history",
			},
		);
		await narratorService.finalizeCompactingMessage(compactedMarker.id, "n1", "historical summary");
		const segmentTarget = await narratorService.persistUserMessage("n1", "segment target");
		const segment = await narratorService.persistSegmentCompactMarker("n1", [segmentTarget.id]);
		await narratorService.finalizeSegmentCompact(segment.message.id, "n1", "segment summary");
		const after = await narratorService.persistUserMessage("n1", "after historical compacts");

		const child = await narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
		});
		const childIds = (await narratorService.getMessages(child.id)).map(
			(message: { id: string }) => message.id,
		);
		// The latest successful compact is the full-fork boundary. Segment compact's
		// visible marker remains copyable, while its hidden source ref stays hidden.
		expect(childIds).toEqual([segment.message.id, after.id]);
		expect(childIds).not.toContain(segmentTarget.id);

		const explicitChild = await narratorService.forkNarrator("n1", null, {
			inheritMode: "full",
			standalone: true,
			forkMessageId: failedMarker.id,
		});
		const explicitIds = (await narratorService.getMessages(explicitChild.id)).map(
			(message: { id: string }) => message.id,
		);
		expect(explicitIds).toContain(failedMarker.id);
		expect(explicitIds).not.toContain(compactedMarker.id);
	});
});
