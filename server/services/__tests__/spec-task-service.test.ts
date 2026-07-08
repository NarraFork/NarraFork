/**
 * Unit tests for Dynamic Spec task parsing/compilation.
 *
 * These are pure tests and do not touch the database.
 */
import { describe, expect, test } from "bun:test";
import {
	compileSpecTasks,
	parseSpecTasksDocument,
	serializeSpecTasksDocument,
	taskTextHash,
} from "../spec-task-service";

describe("spec task document parsing", () => {
	test("accepts the minimal tasks.json format", () => {
		const doc = parseSpecTasksDocument(
			JSON.stringify({
				tasks: [
					{ text: "Build the feature", status: "doing" },
					{ text: "Do not skip validation", status: "todo", protected: true },
				],
			}),
		);

		expect(doc.tasks).toEqual([
			{ text: "Build the feature", status: "doing" },
			{ text: "Do not skip validation", status: "todo", protected: true },
		]);
	});

	test("normalizes legacy task statuses for compatibility", () => {
		const doc = parseSpecTasksDocument(
			JSON.stringify({
				tasks: [
					{ text: "A", status: "pending" },
					{ text: "B", status: "in_progress" },
					{ text: "C", status: "completed" },
				],
			}),
		);

		expect(doc.tasks.map((task) => task.status)).toEqual(["todo", "doing", "done"]);
	});

	test("rejects unsupported top-level and task fields", () => {
		expect(() => parseSpecTasksDocument(JSON.stringify({ tasks: [], summary: "nope" }))).toThrow(
			/unsupported top-level field/,
		);
		expect(() =>
			parseSpecTasksDocument(
				JSON.stringify({ tasks: [{ text: "A", status: "todo", evidence: "nope" }] }),
			),
		).toThrow(/unsupported field/);
	});

	test("rejects invalid protected values and invalid statuses", () => {
		expect(() =>
			parseSpecTasksDocument(JSON.stringify({ tasks: [{ text: "A", status: "maybe" }] })),
		).toThrow(/Invalid task status/);
		expect(() =>
			parseSpecTasksDocument(
				JSON.stringify({ tasks: [{ text: "A", status: "todo", protected: "yes" }] }),
			),
		).toThrow(/protected must be true or omitted/);
	});
});

describe("spec task compilation", () => {
	test("computes current, next, completion, and protected-open count", () => {
		const doc = parseSpecTasksDocument(
			JSON.stringify({
				tasks: [
					{ text: "Done", status: "done", protected: true },
					{ text: "Current", status: "doing", protected: true },
					{ text: "Next", status: "todo" },
				],
			}),
		);
		const compiled = compileSpecTasks(doc);

		expect(compiled.currentTask?.text).toBe("Current");
		expect(compiled.nextTask?.text).toBe("Next");
		expect(compiled.complete).toBe(false);
		expect(compiled.protectedOpenCount).toBe(1);
	});

	test("keeps blocked tasks active while exposing no doing/todo task", () => {
		const compiled = compileSpecTasks({
			tasks: [
				{ text: "Done", status: "done" },
				{ text: "Blocked", status: "blocked", protected: true },
			],
		});

		expect(compiled.currentTask).toBeNull();
		expect(compiled.nextTask).toBeNull();
		expect(compiled.blocked).toBe(true);
		expect(compiled.complete).toBe(false);
		expect(compiled.protectedOpenCount).toBe(1);
	});

	test("marks a document complete when all tasks are done", () => {
		const compiled = compileSpecTasks({ tasks: [{ text: "Done", status: "done" }] });

		expect(compiled.complete).toBe(true);
	});

	test("serializes with stable tab-indented JSON and hashes trimmed task text", () => {
		const serialized = serializeSpecTasksDocument({ tasks: [{ text: "A", status: "todo" }] });
		expect(serialized).toBe(
			'{\n\t"tasks": [\n\t\t{\n\t\t\t"text": "A",\n\t\t\t"status": "todo"\n\t\t}\n\t]\n}\n',
		);
		expect(taskTextHash("  same text  ")).toBe(taskTextHash("same text"));
	});
});
