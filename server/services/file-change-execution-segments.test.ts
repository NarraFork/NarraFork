import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/bun-sqlite";
import { getTableConfig } from "drizzle-orm/sqlite-core";
import { fileChangeExecutionSegments } from "../db/schema";
import { createFileChangeExecutionSegmentsService } from "./file-change-execution-segments";

const databases: Database[] = [];
afterEach(() => {
	for (const db of databases.splice(0)) db.close();
});
function setup() {
	const sqlite = new Database(":memory:");
	databases.push(sqlite);
	sqlite.run(`CREATE TABLE file_change_execution_segments (
		id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, parent_segment_id TEXT,
		source_tool_call_id TEXT, source_execution_attempt INTEGER, source_input_id TEXT,
		created_at TEXT NOT NULL
	)`);
	return createFileChangeExecutionSegmentsService(drizzle(sqlite));
}

describe("file change execution segments", () => {
	test("logical-run receipt lookup uses the schema's compound input index with long history", () => {
		const sqlite = new Database(":memory:");
		databases.push(sqlite);
		const config = getTableConfig(fileChangeExecutionSegments);
		const inputIndex = config.indexes.find((index) => index.config.name === "idx_fc_segment_input");
		expect(inputIndex).toBeDefined();
		if (!inputIndex) throw new Error("Run receipt index is missing from schema");
		const columnNames = inputIndex.config.columns.map((column) => {
			if (!("name" in column)) throw new Error("Expected ordinary index columns");
			return column.name;
		});
		expect(columnNames).toEqual(["narrator_id", "source_input_id"]);
		sqlite.run(`CREATE TABLE file_change_execution_segments (
			id TEXT PRIMARY KEY, narrator_id TEXT NOT NULL, source_input_id TEXT
		)`);
		sqlite.run(`CREATE INDEX "${inputIndex.config.name}" ON file_change_execution_segments
			(${columnNames.map((name) => `"${name}"`).join(", ")})`);
		const insert = sqlite.prepare("INSERT INTO file_change_execution_segments VALUES (?, ?, ?)");
		sqlite.transaction(() => {
			for (let i = 0; i < 20000; i++) insert.run(`history-${i}`, "child", `tool-${i}`);
			insert.run("current", "child", "subagent-run:current");
		})();
		const plans = sqlite
			.query<{ detail: string }, [string, string]>(
				"EXPLAIN QUERY PLAN SELECT * FROM file_change_execution_segments WHERE narrator_id = ? AND source_input_id = ? LIMIT 1",
			)
			.all("child", "subagent-run:current");
		expect(plans.some((plan) => plan.detail.includes("USING INDEX idx_fc_segment_input"))).toBe(
			true,
		);
		expect(plans.some((plan) => plan.detail.includes("SCAN"))).toBe(false);
		expect(
			sqlite
				.query<{ id: string }, [string, string]>(
					"SELECT * FROM file_change_execution_segments WHERE narrator_id = ? AND source_input_id = ? LIMIT 1",
				)
				.get("child", "subagent-run:current")?.id,
		).toBe("current");
	});
	test("real row identity and attempt isolate repeated provider IDs and COW successors", async () => {
		const service = setup();
		const first = await service.create({
			narratorId: "n",
			sourceToolCallId: "call",
			sourceExecutionAttempt: 1,
		});
		expect(
			await service.create({
				narratorId: "n",
				sourceToolCallId: "call",
				sourceExecutionAttempt: 1,
			}),
		).toEqual(first);
		const second = await service.create({
			narratorId: "n",
			sourceToolCallId: "other-call",
			sourceExecutionAttempt: 1,
		});
		const retry = await service.create({
			narratorId: "n",
			sourceToolCallId: "call",
			sourceExecutionAttempt: 2,
		});
		const cow = await service.create({
			narratorId: "fork",
			sourceToolCallId: "cow-successor",
			sourceExecutionAttempt: 2,
		});
		expect(new Set([first.id, second.id, retry.id, cow.id]).size).toBe(4);
		expect(first.sourceInputId).toBeNull();
	});

	test("cannot reparent an already bound execution source", async () => {
		const service = setup();
		const root = await service.create({ narratorId: "p", sourceInputId: "run-1" });
		const other = await service.create({ narratorId: "p", sourceInputId: "run-2" });
		const child = await service.create({
			narratorId: "c",
			sourceToolCallId: "tool",
			sourceExecutionAttempt: 1,
			parentSegmentId: root.id,
		});
		expect((await service.descendants(root.id)).segmentIds).toEqual([child.id]);
		expect((await service.descendants(other.id)).segmentIds).toEqual([]);
		await expect(
			service.create({
				narratorId: "c",
				sourceToolCallId: "tool",
				sourceExecutionAttempt: 1,
				parentSegmentId: other.id,
			}),
		).rejects.toThrow("parent conflicts");
		await expect(
			service.create({
				narratorId: "c",
				sourceToolCallId: "tool",
				sourceExecutionAttempt: 1,
			}),
		).rejects.toThrow("parent conflicts");
	});

	test("rejects missing parents and incomplete or ambiguous sources", async () => {
		const service = setup();
		await expect(
			service.create({
				narratorId: "n",
				sourceInputId: "input",
				parentSegmentId: "missing",
			}),
		).rejects.toThrow("parent segment not found");
		await expect(service.create({ narratorId: "n", sourceToolCallId: "call" })).rejects.toThrow(
			"exactly one source",
		);
		await expect(
			service.create({
				narratorId: "n",
				sourceToolCallId: "call",
				sourceExecutionAttempt: 1,
				sourceInputId: "input",
			}),
		).rejects.toThrow("exactly one source");
	});
});
