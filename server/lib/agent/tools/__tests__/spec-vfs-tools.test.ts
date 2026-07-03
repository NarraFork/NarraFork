/**
 * Tool-layer integration tests for spec:// Living Work Spec files.
 *
 * Run with an isolated data dir, for example:
 * NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$HOME/.narrafork/perf-isolation/spec-tools-test \
 *   bun test server/lib/agent/tools/__tests__/spec-vfs-tools.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../../../db";
import { narrators } from "../../../../db/schema";
import { generateId } from "../../../id";
import type { ToolContext } from "../../types";
import { editTool } from "../edit";
import { grepTool } from "../grep";
import { readTool } from "../read";
import { taskCreateTool } from "../todo";
import { writeTool } from "../write";

const TAG = Date.now();
let narratorId: string;

function ctx(toolUseId = `tu-${generateId(6)}`): ToolContext {
	return {
		narratorId,
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		currentToolUseId: toolUseId,
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

function tasksContent(document: unknown): string {
	return `${JSON.stringify(document, null, "\t")}\n`;
}

beforeAll(async () => {
	narratorId = `spec-tools-${TAG}`;
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: narratorId,
		type: "primary",
		variant: "primary",
		traits: ["standalone"],
		model: "default",
		permissionMode: "default",
		status: "idle",
		createdAt: now,
		updatedAt: now,
	});
});

describe("spec:// Read/Write/Edit/Grep", () => {
	test("Write and Read operate on spec://tasks.json", async () => {
		const writeResult = await writeTool.execute(
			{
				file_path: "spec://tasks.json",
				content: tasksContent({ tasks: [{ text: "Tool task", status: "doing" }] }),
			},
			ctx(),
		);
		expect(writeResult.isError).toBeFalsy();
		expect(writeResult.output).toContain("spec://tasks.json");

		const readResult = await readTool.execute({ file_path: "spec://tasks.json" }, ctx());
		expect(readResult.isError).toBeFalsy();
		expect(readResult.output).toContain("Tool task");
		expect(readResult.metadata?.specPath).toBe("tasks.json");
	});

	test("Edit can copy-on-write a mutable built-in spec file", async () => {
		const editResult = await editTool.execute(
			{
				file_path: "spec://index.md",
				old_string: "# Work Spec",
				new_string: "# Custom Work Spec",
			},
			ctx(),
		);
		expect(editResult.isError).toBeFalsy();

		const readResult = await readTool.execute({ file_path: "spec://index.md" }, ctx());
		expect(readResult.output).toContain("Custom Work Spec");
	});

	test("Grep searches across spec:// files", async () => {
		await writeTool.execute(
			{
				file_path: "spec://notes.md",
				content: "# Notes\n\nNeedle phrase lives here.\n",
			},
			ctx(),
		);
		const grepResult = await grepTool.execute(
			{ pattern: "Needle phrase", path: "spec://", output_mode: "content" },
			ctx(),
		);
		expect(grepResult.isError).toBeFalsy();
		expect(grepResult.output).toContain("spec://notes.md");
		expect(grepResult.output).toContain("Needle phrase");
	});
});

describe("TaskCreate compatibility", () => {
	test("TaskCreate writes the Living Work Spec task queue", async () => {
		const result = await taskCreateTool.execute(
			{
				todos: [
					{ id: "a", content: "Legacy pending", status: "pending" },
					{ id: "b", content: "Legacy active", status: "in_progress" },
				],
			},
			ctx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Updated spec://tasks.json");

		const readResult = await readTool.execute({ file_path: "spec://tasks.json" }, ctx());
		expect(readResult.output).toContain("Legacy pending");
		expect(readResult.output).toContain('"status": "doing"');
	});

	test("TaskCreate preserves omitted protected tasks while replacing normal tasks", async () => {
		await writeTool.execute(
			{
				file_path: "spec://tasks.json",
				content: tasksContent({
					tasks: [
						{ text: "Protected via tools", status: "doing", protected: true },
						{ text: "Old normal", status: "todo" },
					],
				}),
			},
			ctx(),
		);

		const result = await taskCreateTool.execute(
			{
				todos: [{ id: "n", content: "New normal", status: "pending" }],
			},
			ctx(),
		);
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Protected via tools");
		expect(result.metadata?.todos).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ content: "Protected via tools", status: "in_progress" }),
			]),
		);

		const readResult = await readTool.execute({ file_path: "spec://tasks.json" }, ctx());
		expect(readResult.output).toContain("Protected via tools");
		expect(readResult.output).toContain('"protected": true');
		expect(readResult.output).toContain("New normal");
		expect(readResult.output).not.toContain("Old normal");
	});

	test("TaskCreate cannot silently complete a protected task", async () => {
		await writeTool.execute(
			{
				file_path: "spec://tasks.json",
				content: tasksContent({
					tasks: [{ text: "Protected via tools", status: "doing", protected: true }],
				}),
			},
			ctx(),
		);

		const result = await taskCreateTool.execute(
			{
				todos: [{ id: "p", content: "Protected via tools", status: "completed" }],
			},
			ctx(),
		);
		expect(result.isError).toBe(true);
		expect(result.output).toContain("requires taskReflection");
	});
});
