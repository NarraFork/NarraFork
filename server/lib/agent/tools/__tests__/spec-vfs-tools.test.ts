/**
 * Tool-layer integration tests for spec:// Dynamic Spec files.
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

	test("model-facing file tool descriptions advertise Dynamic Spec usage", () => {
		const readSchema = readTool.rawJsonSchema as {
			properties: { file_path: { description: string } };
		};
		const writeSchema = writeTool.rawJsonSchema as {
			properties: { file_path: { description: string } };
		};
		const editSchema = editTool.rawJsonSchema as {
			properties: { file_path: { description: string } };
		};
		const grepSchema = grepTool.rawJsonSchema as {
			properties: { path: { description: string } };
		};

		expect(readTool.description).toContain("spec://tasks.json");
		expect(readTool.description).not.toContain("spec://HOW_TO_USE_SPEC.md");
		expect(readSchema.properties.file_path.description).toContain("spec://");

		expect(writeTool.description).toContain("spec://tasks.json");
		expect(writeTool.description).toContain("spec://behavior_fence");
		expect(writeSchema.properties.file_path.description).toContain("spec://");

		expect(editTool.description).toContain("spec://tasks.json");
		expect(editTool.description).not.toContain("spec://HOW_TO_USE_SPEC.md");
		expect(editSchema.properties.file_path.description).toContain("spec://");

		expect(grepTool.description).toContain('path to "spec://"');
		expect(grepSchema.properties.path.description).toContain("Dynamic Spec");
	});
});
