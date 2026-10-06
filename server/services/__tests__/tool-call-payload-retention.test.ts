/**
 * Retention for aged tool-call payloads.
 *
 * `narrator_tool_calls` was measured at 561k rows inside a 6.6 GB database and had no
 * age-based pruning at all: without one it grows for as long as the user keeps their
 * narrators. The dangerous way to solve that is deleting rows, because these rows are
 * load-bearing far beyond the execution log — `snapshot-revert` reads `tree_hash_before`
 * off them and `file-state-rebuild` replays recorded Write/Edit inputs. These tests pin
 * the safe shape: clear the payload COLUMNS, keep every row, and never touch a
 * file-history checkpoint.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// mock.module is process-wide and mock.restore() does not undo it, so the real module is
// snapshotted first and re-pointed in afterAll to keep this migration-only in-memory db
// from leaking into later real-db suites.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const { databaseCleanupService, DEFAULT_TOOL_CALL_PAYLOAD_DAYS } = await import(
	"../database-cleanup-service"
);

function daysAgo(days: number): string {
	return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

interface SeedOptions {
	id: string;
	createdAt: string;
	checkpoint?: boolean;
	inputJson?: string | null;
	outputJson?: string | null;
	treeHashBefore?: string | null;
}

function seedNarrator() {
	sqlite
		.prepare(
			`INSERT INTO narrators (id, title, created_at, updated_at)
			 VALUES ('n1', 'Narrator', ?, ?)`,
		)
		.run(daysAgo(400), daysAgo(400));
	// `narrator_tool_calls.message_id` is NOT NULL, so a host message must exist.
	sqlite
		.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('m1', 'n1', 'assistant', '[]', ?)`,
		)
		.run(daysAgo(400));
}

function seedToolCall(options: SeedOptions) {
	sqlite
		.prepare(
			`INSERT INTO narrator_tool_calls
			 (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at,
				input_json, output_json, is_file_history_checkpoint, tree_hash_before)
			 VALUES (?, 'n1', 'm1', ?, 'Bash', 'success', ?, ?, ?, ?, ?)`,
		)
		.run(
			options.id,
			`use-${options.id}`,
			options.createdAt,
			options.inputJson === undefined ? '{"command":"echo hi"}' : options.inputJson,
			options.outputJson === undefined ? '{"stdout":"hi"}' : options.outputJson,
			options.checkpoint ? 1 : 0,
			options.treeHashBefore ?? null,
		);
}

function readRow(id: string) {
	return sqlite
		.prepare(
			`SELECT id, input_json AS inputJson, output_json AS outputJson,
				tree_hash_before AS treeHashBefore, is_file_history_checkpoint AS checkpoint
			 FROM narrator_tool_calls WHERE id = ?`,
		)
		.get(id) as
		| {
				id: string;
				inputJson: string | null;
				outputJson: string | null;
				treeHashBefore: string | null;
				checkpoint: number;
		  }
		| undefined;
}

function rowCount(): number {
	const row = sqlite.prepare(`SELECT COUNT(*) AS c FROM narrator_tool_calls`).get() as {
		c: number;
	};
	return row.c;
}

beforeEach(() => {
	seedNarrator();
});

afterEach(() => {
	cleanDb(sqlite);
});

describe("toolCallPayloads preview", () => {
	test("counts only rows older than the retention window", async () => {
		seedToolCall({ id: "old", createdAt: daysAgo(400) });
		seedToolCall({ id: "recent", createdAt: daysAgo(5) });

		const preview = await databaseCleanupService.previewCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});

		expect(preview.counts.toolCalls).toBe(1);
		expect(preview.samples.map((sample) => sample.id)).toEqual(["old"]);
	});

	test("excludes file-history checkpoints, whose input IS the replay source", async () => {
		// Clearing a checkpoint's input_json destroys the file-state reconstruction path,
		// which is a different and much worse loss than an unreadable log entry.
		seedToolCall({ id: "checkpoint", createdAt: daysAgo(400), checkpoint: true });

		const preview = await databaseCleanupService.previewCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});

		expect(preview.counts.toolCalls).toBe(0);
	});

	test("ignores rows that have no payload left to clear", async () => {
		// Otherwise a second run would keep reporting work that no longer exists.
		seedToolCall({ id: "empty", createdAt: daysAgo(400), inputJson: null, outputJson: null });

		const preview = await databaseCleanupService.previewCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});

		expect(preview.counts.toolCalls).toBe(0);
	});

	test("defaults to the documented retention window", async () => {
		const preview = await databaseCleanupService.previewCleanup("toolCallPayloads");
		expect(preview.olderThanDays).toBe(DEFAULT_TOOL_CALL_PAYLOAD_DAYS);
	});
});

describe("toolCallPayloads execute", () => {
	test("clears payload columns but KEEPS the row and its tree hash", async () => {
		// The row is what file-history revert addresses; losing it would silently disable
		// rollback for older work.
		seedToolCall({ id: "old", createdAt: daysAgo(400), treeHashBefore: "deadbeef" });

		await databaseCleanupService.executeCleanup("toolCallPayloads", { olderThanDays: 180 });

		const row = readRow("old");
		expect(row).toBeDefined();
		expect(row?.inputJson).toBeNull();
		expect(row?.outputJson).toBeNull();
		expect(row?.treeHashBefore).toBe("deadbeef");
		expect(rowCount()).toBe(1);
	});

	test("leaves rows inside the retention window untouched", async () => {
		seedToolCall({ id: "recent", createdAt: daysAgo(5) });

		await databaseCleanupService.executeCleanup("toolCallPayloads", { olderThanDays: 180 });

		expect(readRow("recent")?.inputJson).not.toBeNull();
	});

	test("never clears a checkpoint row", async () => {
		seedToolCall({ id: "checkpoint", createdAt: daysAgo(400), checkpoint: true });

		await databaseCleanupService.executeCleanup("toolCallPayloads", { olderThanDays: 180 });

		const row = readRow("checkpoint");
		expect(row?.inputJson).not.toBeNull();
	});

	test("execute matches what preview promised", async () => {
		// A divergence between the two WHERE clauses would clear rows the administrator was
		// told would be kept.
		seedToolCall({ id: "old-1", createdAt: daysAgo(400) });
		seedToolCall({ id: "old-2", createdAt: daysAgo(300) });
		seedToolCall({ id: "checkpoint", createdAt: daysAgo(400), checkpoint: true });
		seedToolCall({ id: "recent", createdAt: daysAgo(5) });

		const preview = await databaseCleanupService.previewCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});
		const result = await databaseCleanupService.executeCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});

		expect(preview.counts.toolCalls).toBe(2);
		expect(result.counts.toolCalls).toBe(2);
		expect(readRow("old-1")?.inputJson).toBeNull();
		expect(readRow("old-2")?.inputJson).toBeNull();
		expect(readRow("checkpoint")?.inputJson).not.toBeNull();
		expect(readRow("recent")?.inputJson).not.toBeNull();
		expect(rowCount()).toBe(4);
	});

	test("is idempotent: a second run finds nothing to do", async () => {
		seedToolCall({ id: "old", createdAt: daysAgo(400) });

		await databaseCleanupService.executeCleanup("toolCallPayloads", { olderThanDays: 180 });
		const second = await databaseCleanupService.executeCleanup("toolCallPayloads", {
			olderThanDays: 180,
		});

		expect(second.counts.toolCalls).toBe(0);
		expect(rowCount()).toBe(1);
	});
});
