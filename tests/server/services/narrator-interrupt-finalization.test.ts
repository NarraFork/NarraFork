import { Database } from "bun:sqlite";
import { afterAll, afterEach, describe, expect, it, mock } from "bun:test";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as relations from "../../../server/db/relations";
import * as schema from "../../../server/db/schema";
import {
	narratorMessageRefs,
	narratorMessages,
	narratorToolCalls,
} from "../../../server/db/schema";

const sqlite = new Database(":memory:");
sqlite.exec(`
	CREATE TABLE narrators (
		id TEXT PRIMARY KEY,
		chapter_id TEXT,
		api_conversation_id TEXT,
		fork_message_id TEXT,
		type TEXT NOT NULL DEFAULT 'primary',
		subagent_type TEXT,
		title TEXT,
		inherit_mode TEXT NOT NULL DEFAULT 'fresh',
		parent_narrator_id TEXT,
		context_summary TEXT,
		model TEXT DEFAULT 'claude-sonnet-4.5',
		pending_model_restore TEXT,
		system_prompt TEXT,
		permission_mode TEXT DEFAULT 'default',
		previous_permission_mode TEXT,
		plan_file_id TEXT,
		reasoning_effort TEXT,
		fast_mode INTEGER NOT NULL DEFAULT 0,
		relaxed_plan INTEGER NOT NULL DEFAULT 0,
		message_count INTEGER DEFAULT 0,
		total_cost_usd REAL DEFAULT 0,
		last_message_at TEXT,
		status TEXT NOT NULL DEFAULT 'idle',
		substatus TEXT NOT NULL DEFAULT '[]',
		plan_mode INTEGER NOT NULL DEFAULT 0,
		cwd TEXT,
		error_message TEXT,
		todos_json TEXT,
		todos_tool_use_id TEXT,
		prune_boundary_message_id TEXT,
		pruned_percent INTEGER,
		prune_enabled INTEGER NOT NULL DEFAULT 1,
		enabled_tools TEXT,
		variant TEXT NOT NULL DEFAULT 'primary',
		traits TEXT NOT NULL DEFAULT '[]',
		is_background INTEGER NOT NULL DEFAULT 0,
		background_status TEXT,
		background_result TEXT,
		background_completed_at TEXT,
		is_ask_in_passing INTEGER NOT NULL DEFAULT 0,
		turn_started_at TEXT,
		message_version INTEGER NOT NULL DEFAULT 0,
		message_structure_version INTEGER NOT NULL DEFAULT 0,
		created_at TEXT NOT NULL,
		updated_at TEXT NOT NULL
	);
	CREATE TABLE narrator_messages (
		id TEXT PRIMARY KEY,
		narrator_id TEXT NOT NULL,
		sdk_message_uuid TEXT,
		parent_tool_use_id TEXT,
		role TEXT NOT NULL,
		content_json TEXT NOT NULL,
		content_text TEXT,
		tokens_in INTEGER,
		cost_usd REAL,
		turn_usage_json TEXT,
		provider TEXT,
		credential_id TEXT,
		model TEXT,
		output_tokens INTEGER,
		cached_input_tokens INTEGER,
		cache_creation_input_tokens INTEGER,
		cache_creation_5m_tokens INTEGER,
		cache_creation_1h_tokens INTEGER,
		reasoning_tokens INTEGER,
		ttft_ms INTEGER,
		duration_ms INTEGER,
		context_percent REAL,
		meter_usage REAL,
		meter_unit TEXT,
		commit_sha TEXT,
		command_text TEXT,
		created_by TEXT,
		origin TEXT,
		origin_label TEXT,
		edited_at TEXT,
		edited_by TEXT,
		original_content_json TEXT,
		tree_hash_after TEXT,
		created_at TEXT NOT NULL
	);
	CREATE TABLE narrator_message_refs (
		id TEXT PRIMARY KEY,
		narrator_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		seq INTEGER NOT NULL,
		is_compact INTEGER NOT NULL DEFAULT 0,
		pruned_percent INTEGER,
		segment_compact_id TEXT
	);
	CREATE TABLE narrator_tool_calls (
		id TEXT PRIMARY KEY,
		narrator_id TEXT NOT NULL,
		message_id TEXT NOT NULL,
		tool_use_id TEXT NOT NULL,
		tool_name TEXT NOT NULL,
		input_json TEXT,
		output_json TEXT,
		execution_device_id TEXT,
		execution_cwd TEXT,
		execution_path_flavor TEXT,
		resolved_file_path TEXT,
		canonical_file_path TEXT,
		runtime_generation INTEGER,
		execution_targets_json TEXT,
		device_selection_source TEXT,
		status TEXT NOT NULL DEFAULT 'initializing',
		duration_ms INTEGER,
		stream_started_at TEXT,
		permission_started_at TEXT,
		execution_started_at TEXT,
		completed_at TEXT,
		error_message TEXT,
		permission_decided_by TEXT,
		permission_decided_at TEXT,
		permission_deny_message TEXT,
		permission_decision_reason TEXT,
		permission_suggestions TEXT,
		is_background INTEGER NOT NULL DEFAULT 0,
		is_file_history_checkpoint INTEGER NOT NULL DEFAULT 0,
		tree_hash_before TEXT,
		tree_hash_after TEXT,
		input_tokens INTEGER NOT NULL DEFAULT 0,
		output_tokens INTEGER NOT NULL DEFAULT 0,
		cache_creation_tokens INTEGER NOT NULL DEFAULT 0,
		cache_read_tokens INTEGER NOT NULL DEFAULT 0,
		cache_creation_5m_tokens INTEGER NOT NULL DEFAULT 0,
		cache_creation_1h_tokens INTEGER NOT NULL DEFAULT 0,
		input_cost REAL NOT NULL DEFAULT 0,
		output_cost REAL NOT NULL DEFAULT 0,
		cache_creation_cost REAL NOT NULL DEFAULT 0,
		cache_read_cost REAL NOT NULL DEFAULT 0,
		total_cost REAL NOT NULL DEFAULT 0,
		provider TEXT,
		model TEXT,
		result_message_id TEXT,
		created_at TEXT NOT NULL
	);
`);

const db = drizzle({ client: sqlite, schema: { ...schema, ...relations } });

// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../../server/db")) };
mock.module("../../../server/db", () => ({ db, sqlite }));

const { finalizeOrCleanupPartialMessage, markInterruptedToolCallsForMessage } = await import(
	"../../../server/services/narrator-session"
);

const now = new Date("2026-01-01T00:00:00.000Z").toISOString();

function seedAssistantMessage(params: { id: string; narratorId?: string; contentJson: unknown[] }) {
	const narratorId = params.narratorId ?? "n1";
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

function clearTables() {
	for (const table of ["narrator_tool_calls", "narrator_message_refs", "narrator_messages"]) {
		sqlite.run(`DELETE FROM ${table}`);
	}
}

afterEach(() => {
	clearTables();
});

afterAll(() => {
	mock.module("../../../server/db", () => realDbModule);
	mock.restore();
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
