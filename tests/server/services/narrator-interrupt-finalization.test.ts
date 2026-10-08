import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../../server/db/schema";
import { cleanDb, getTestDb } from "../../setup";

// Replay the complete production migration chain, including import-time runtime outbox tables.
const { db, sqlite } = getTestDb();

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ ...realDbModule, db, sqlite }));

const { finalizeOrCleanupPartialMessage, markInterruptedToolCallsForMessage } = await import(
	"../../../server/services/narrator-session"
);

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

function seedAssistantMessage(params: { id: string; narratorId?: string; contentJson: unknown[] }) {
	const narratorId = params.narratorId ?? "n1";
	db.insert(narrators)
		.values({ id: narratorId, createdAt: now, updatedAt: now })
		.onConflictDoNothing()
		.run();
	db.insert(narratorMessages)
		.values({
			id: params.id,
			narratorId,
			role: "assistant",
			contentJson: params.contentJson,
			contentText: null,
			createdAt: now,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({
			id: `ref-${params.id}`,
			narratorId,
			messageId: params.id,
			seq: 0,
		})
		.run();
}

function seedToolCall(params: {
	id: string;
	messageId: string;
	toolUseId: string;
	toolName?: string;
	status: "initializing" | "pending" | "running" | "success" | "fail";
	inputJson?: unknown;
	outputJson?: unknown;
}) {
	db.insert(narratorToolCalls)
		.values({
			id: params.id,
			narratorId: "n1",
			messageId: params.messageId,
			toolUseId: params.toolUseId,
			toolName: params.toolName ?? "Read",
			status: params.status,
			inputJson: params.inputJson ?? { file_path: "a.ts" },
			outputJson: params.outputJson ?? null,
			createdAt: now,
		})
		.run();
}

afterEach(() => {
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
	sqlite.close();
});

describe("interrupted narrator partial message finalization", () => {
	it("中断时保留本轮已完成工具调用的 success 状态和输出", async () => {
		seedAssistantMessage({
			id: "m-tools-then-text",
			contentJson: [
				{ type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "a.ts" } },
				{ type: "tool_use", id: "tu-glob", name: "Glob", input: { pattern: "*.ts" } },
				{ type: "text", text: "partial trailing answer" },
			],
		});
		seedToolCall({
			id: "tc-read",
			messageId: "m-tools-then-text",
			toolUseId: "tu-read",
			toolName: "Read",
			status: "success",
			outputJson: "read ok",
		});
		seedToolCall({
			id: "tc-glob",
			messageId: "m-tools-then-text",
			toolUseId: "tu-glob",
			toolName: "Glob",
			status: "success",
			inputJson: { pattern: "*.ts" },
			outputJson: "glob ok",
		});

		await markInterruptedToolCallsForMessage("n1", "m-tools-then-text", "en");
		await finalizeOrCleanupPartialMessage("m-tools-then-text", "n1");

		const rows = await db.query.narratorToolCalls.findMany({
			where: eq(narratorToolCalls.messageId, "m-tools-then-text"),
			orderBy: (tc, { asc }) => [asc(tc.id)],
		});
		expect(rows.map((row) => [row.toolUseId, row.status, row.outputJson])).toEqual([
			["tu-glob", "success", "glob ok"],
			["tu-read", "success", "read ok"],
		]);

		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-tools-then-text"),
		});
		expect(message).toBeDefined();
		expect(message?.contentJson).toEqual([
			{ type: "tool_use", id: "tu-read", name: "Read", input: { file_path: "a.ts" } },
			{ type: "tool_use", id: "tu-glob", name: "Glob", input: { pattern: "*.ts" } },
			{ type: "text", text: "partial trailing answer" },
		]);
	});

	it("中断时只把当前 partial 中未完成工具标记为 interrupted，不覆盖已完成状态", async () => {
		seedAssistantMessage({
			id: "m-mixed-tools",
			contentJson: [
				{ type: "tool_use", id: "tu-done", name: "Read", input: { file_path: "a.ts" } },
				{ type: "tool_use", id: "tu-running", name: "Glob", input: { pattern: "*.ts" } },
			],
		});
		seedToolCall({
			id: "tc-done",
			messageId: "m-mixed-tools",
			toolUseId: "tu-done",
			status: "success",
			outputJson: "done output",
		});
		seedToolCall({
			id: "tc-running",
			messageId: "m-mixed-tools",
			toolUseId: "tu-running",
			toolName: "Glob",
			status: "initializing",
			inputJson: { pattern: "*.ts" },
		});

		await markInterruptedToolCallsForMessage("n1", "m-mixed-tools", "en");
		await finalizeOrCleanupPartialMessage("m-mixed-tools", "n1");

		const done = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.messageId, "m-mixed-tools"),
				eq(narratorToolCalls.toolUseId, "tu-done"),
			),
		});
		const interrupted = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.messageId, "m-mixed-tools"),
				eq(narratorToolCalls.toolUseId, "tu-running"),
			),
		});

		expect(done?.status).toBe("success");
		expect(done?.outputJson).toBe("done output");
		expect(interrupted?.status).toBe("fail");
		expect(interrupted?.outputJson).toContain("interrupted");
		expect(interrupted?.completedAt).toBeTruthy();

		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-mixed-tools"),
		});
		expect(message).toBeDefined();
	});

	it("非中断 cleanup 仍会删除无内容且只有 initializing 工具的 partial", async () => {
		seedAssistantMessage({
			id: "m-unfinished",
			contentJson: [
				{ type: "tool_use", id: "tu-unfinished", name: "Read", input: { file_path: "a.ts" } },
			],
		});
		seedToolCall({
			id: "tc-unfinished",
			messageId: "m-unfinished",
			toolUseId: "tu-unfinished",
			status: "initializing",
		});

		const kept = await finalizeOrCleanupPartialMessage("m-unfinished", "n1");
		const message = await db.query.narratorMessages.findFirst({
			where: eq(narratorMessages.id, "m-unfinished"),
		});

		expect(kept).toBe(false);
		expect(message).toBeUndefined();
	});
});
