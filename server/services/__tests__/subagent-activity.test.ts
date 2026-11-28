import { describe, expect, spyOn, test } from "bun:test";
import { db, sqlite } from "../../db";
import { narratorMessages, narrators, narratorToolCalls } from "../../db/schema";
import * as pool from "../../lib/db-worker/pool";
import { generateId } from "../../lib/id";
import { getRecentSubagentToolActivity, summarizeSubagentToolCall } from "../subagent-activity";

describe("summarizeSubagentToolCall", () => {
	test("shows the ContextAsk target without exposing questions or answers", () => {
		expect(
			summarizeSubagentToolCall("ContextAsk", {
				targetId: "worker-123",
			}),
		).toBe("from worker-123");
	});
});

test("Await's recent activity reads a bounded, narrow projection in an ordinary SQLite Worker", async () => {
	const narratorId = generateId();
	const messageId = generateId();
	const now = "2026-08-01T00:00:00.000Z";
	db.transaction((tx) => {
		tx.insert(narrators).values({ id: narratorId, createdAt: now, updatedAt: now }).run();
		tx.insert(narratorMessages)
			.values({
				id: messageId,
				narratorId,
				role: "assistant",
				contentJson: [],
				createdAt: now,
			})
			.run();
		for (let i = 0; i < 8; i++) {
			tx.insert(narratorToolCalls)
				.values({
					id: generateId(),
					narratorId,
					messageId,
					toolUseId: generateId(),
					toolName: "Read",
					status: "success",
					createdAt: `2026-08-01T00:00:0${i}.000Z`,
					inputJson: { file_path: `/repo/${i}.txt`, message: "not selected" },
					outputJson: { text: "not selected" },
				})
				.run();
		}
	});
	const worker = spyOn(pool, "runReadTask");
	try {
		const result = await getRecentSubagentToolActivity(narratorId, 10);
		expect(result.map((item) => item.summary)).toEqual([
			"7.txt",
			"6.txt",
			"5.txt",
			"4.txt",
			"3.txt",
		]);
		expect(worker).toHaveBeenCalledWith(
			sqlite.filename,
			expect.objectContaining({ kind: "selectRows", maxRows: 5 }),
			expect.objectContaining({ timeoutMs: 5_000 }),
		);
		expect(await getRecentSubagentToolActivity(narratorId, Number.NaN)).toHaveLength(3);
	} finally {
		worker.mockRestore();
	}
});

test.each([
	new pool.WorkersUnavailableError("spawn_failed"),
	new pool.DbReadTaskExecutionError("activity query failed"),
	new pool.DbReadTaskTimeoutError("activity query timed out"),
	new pool.WorkersUnavailableError("disabled"),
])("Await's recent activity reports Worker error %s without running the query locally", async (error) => {
	const worker = spyOn(pool, "runReadTask").mockRejectedValue(error);
	const prepare = spyOn(sqlite, "prepare");
	try {
		await expect(getRecentSubagentToolActivity(generateId())).rejects.toBe(error);
		expect(prepare).not.toHaveBeenCalled();
	} finally {
		prepare.mockRestore();
		worker.mockRestore();
	}
});
