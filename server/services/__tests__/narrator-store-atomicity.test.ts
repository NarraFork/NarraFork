/**
 * Each narrator-store operation is one transaction.
 *
 * The write pairs that used to commit separately — a tool_use block and its ledger row,
 * a result and the input it ran with, an assistant step and its calls, a tool-change
 * notice and its ref — are forced to fail on their second half here (a SQLite trigger
 * aborts it), and nothing of the first half may survive.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb, readTestMessageContent } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

// narrator-service must be imported before narrator-persistence (pre-existing cycle).
await import("../narrator-service");
const { narratorStore } = await import("../narrator-store");

const NOW = "2026-10-01T00:00:00.000Z";

beforeEach(() => {
	cleanDb(sqlite);
	sqlite.run("INSERT INTO narrators (id, created_at, updated_at) VALUES ('n1', ?, ?)", [NOW, NOW]);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

function failInserts(table: string, when: string) {
	sqlite.run(
		`CREATE TRIGGER fail_${table} BEFORE INSERT ON ${table} WHEN ${when} BEGIN SELECT RAISE(ABORT, 'forced'); END`,
	);
	return () => sqlite.run(`DROP TRIGGER fail_${table}`);
}

function contentOf(messageId: string): unknown[] {
	return readTestMessageContent(sqlite, messageId);
}

function count(sql: string, ...params: string[]): number {
	return (sqlite.prepare(sql).get(...params) as { n: number }).n;
}

describe("narrator store atomicity", () => {
	test("a streamed tool_use commits only with its ledger row", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		const restore = failInserts("narrator_tool_calls", "NEW.tool_use_id = 'boom'");
		try {
			await expect(
				narratorStore.writeStepItem(step.id, "n1", {
					type: "tool_use",
					id: "boom",
					name: "Bash",
					input: { command: "ls" },
				}),
			).rejects.toThrow("forced");
		} finally {
			restore();
		}
		expect(contentOf(step.id)).toEqual([]);
		expect(count("SELECT count(*) AS n FROM file_change_execution_segments")).toBe(0);

		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "ok",
			name: "Bash",
			input: { command: "ls" },
		});
		expect(contentOf(step.id)).toHaveLength(1);
		expect(
			sqlite
				.prepare(
					"SELECT t.id, s.source_tool_call_id AS source FROM narrator_tool_calls t JOIN file_change_execution_segments s ON s.id = t.execution_segment_id",
				)
				.all(),
		).toEqual([{ id: toolCallId, source: toolCallId }]);
	});

	test("a whole step commits only with the rows of its calls", async () => {
		const restore = failInserts("narrator_tool_calls", "NEW.tool_use_id = 'second'");
		try {
			await expect(
				narratorStore.appendStep("n1", {
					uuid: "u",
					session_id: "s",
					message: {
						content: [
							{ type: "text", text: "two calls" },
							{ type: "tool_use", id: "first", name: "Read", input: {} },
							{ type: "tool_use", id: "second", name: "Read", input: {} },
						],
					},
				}),
			).rejects.toThrow("forced");
		} finally {
			restore();
		}
		expect(count("SELECT count(*) AS n FROM narrator_messages")).toBe(0);
		expect(count("SELECT count(*) AS n FROM narrator_message_refs")).toBe(0);
		expect(count("SELECT count(*) AS n FROM narrator_tool_calls")).toBe(0);
	});

	test("a result commits only with the input it ran with", async () => {
		const step = await narratorStore.openStep("n1", { uuid: "u", session_id: "s" });
		const toolCallId = await narratorStore.writeStepItem(step.id, "n1", {
			type: "tool_use",
			id: "call",
			name: "Write",
			input: { file_path: "a.txt", content: "x" },
		});
		sqlite.run(
			"CREATE TRIGGER fail_block BEFORE UPDATE OF content_json ON narrator_messages BEGIN SELECT RAISE(ABORT, 'forced'); END",
		);
		try {
			await expect(
				narratorStore.settleTool(
					"call",
					{ output: "wrote", status: "success", input: { file_path: "b.txt", content: "x" } },
					step.id,
					toolCallId,
				),
			).rejects.toThrow("forced");
		} finally {
			sqlite.run("DROP TRIGGER fail_block");
		}
		expect(
			sqlite
				.prepare("SELECT status, input_json FROM narrator_tool_calls WHERE id = ?")
				.get(toolCallId as string),
		).toEqual({ status: "initializing", input_json: '{"file_path":"a.txt","content":"x"}' });

		await narratorStore.settleTool(
			"call",
			{ output: "wrote", status: "success", input: { file_path: "b.txt", content: "x" } },
			step.id,
			toolCallId,
		);
		expect(contentOf(step.id)).toEqual([
			expect.objectContaining({ id: "call", input: { file_path: "b.txt", content: "x" } }),
		]);
	});

	test("a tool-change notice commits only with its ref", async () => {
		const restore = failInserts("narrator_message_refs", "1");
		try {
			await expect(
				narratorStore.appendToolChange("n1", {
					type: "tool_loaded",
					toolName: "Eval",
					toolNames: ["Eval"],
					text: "[tool loaded]",
				}),
			).rejects.toThrow();
		} finally {
			restore();
		}
		expect(count("SELECT count(*) AS n FROM narrator_messages")).toBe(0);
	});
});
