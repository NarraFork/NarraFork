import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { narrators } from "../../../../db/schema";
import type { ToolContext } from "../../types";

let db: typeof import("../../../../db").db;
let capturePipelineOutput: typeof import("../../pipeline-state").capturePipelineOutput;
let clearPipelineState: typeof import("../../pipeline-state").clearPipelineState;
let getPipelineState: typeof import("../../pipeline-state").getPipelineState;
let isPipelineControlTool: typeof import("../../pipeline-state").isPipelineControlTool;
let MAX_PIPELINE_CAPTURES: typeof import("../../pipeline-state").MAX_PIPELINE_CAPTURES;
let readCaptureTextBounded: typeof import("../../pipeline-state").readCaptureTextBounded;
let endPipelineTool: typeof import("../pipeline").endPipelineTool;
let extractPipelineTool: typeof import("../pipeline").extractPipelineTool;
let startPipelineTool: typeof import("../pipeline").startPipelineTool;

const TEST_NARRATOR_ID = `pipeline-test-${Date.now().toString(36)}`;
const capturedPaths = new Set<string>();
let nextToolUseId = 1;

function makeContext(): ToolContext {
	return {
		narratorId: TEST_NARRATOR_ID,
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" as const }),
	};
}

async function capture(toolName: string, output: string): Promise<string> {
	const result = await capturePipelineOutput({
		narratorId: TEST_NARRATOR_ID,
		toolUseId: `pipeline-tool-${nextToolUseId++}`,
		toolName,
		input: {},
		output,
	});
	expect(result).not.toBeNull();
	if (!result) throw new Error("Expected pipeline capture");
	capturedPaths.add(result.capture.outputPath);
	return result.capture.alias;
}

beforeAll(async () => {
	({ db } = await import("../../../../db"));
	({
		capturePipelineOutput,
		clearPipelineState,
		getPipelineState,
		isPipelineControlTool,
		MAX_PIPELINE_CAPTURES,
		readCaptureTextBounded,
	} = await import("../../pipeline-state"));
	({ endPipelineTool, extractPipelineTool, startPipelineTool } = await import("../pipeline"));
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id: TEST_NARRATOR_ID,
		title: "Pipeline tool test narrator",
		createdAt: now,
		updatedAt: now,
	});
});

beforeEach(async () => {
	await clearPipelineState(TEST_NARRATOR_ID);
});

afterAll(async () => {
	await clearPipelineState(TEST_NARRATOR_ID);
	await db.delete(narrators).where(eq(narrators.id, TEST_NARRATOR_ID));
	for (const outputPath of capturedPaths) rmSync(outputPath, { force: true });
});

describe("Pipeline extraction lifecycle", () => {
	test("extracts the same captures repeatedly before EndPipeline clears them", async () => {
		const ctx = makeContext();
		const started = await startPipelineTool.execute({ label: "repeatable" }, ctx);
		expect(started.output).toContain("Use ExtractPipeline one or more times");

		expect(await capture("Grep", "error: first\nok: first")).toBe("p1");
		expect(await capture("Bash", "warn: second\nerror: second")).toBe("p2");

		const first = await extractPipelineTool.execute(
			{ rule: "from p1 | grep error", format: "plain" },
			ctx,
		);
		expect(first).toEqual({ output: "error: first" });
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(2);

		const second = await extractPipelineTool.execute(
			{ rule: "from p2 | grep warn", format: "plain" },
			ctx,
		);
		expect(second).toEqual({ output: "warn: second" });
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(2);

		const ended = await endPipelineTool.execute(
			{ rule: "from p1 p2 | grep error", format: "plain" },
			ctx,
		);
		expect(ended).toEqual({ output: "error: first\nerror: second" });
		expect(await getPipelineState(TEST_NARRATOR_ID)).toBeNull();
	});

	test("reads only aliases selected by from", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "selected content");
		await capture("Read", "must not be read");
		const state = await getPipelineState(TEST_NARRATOR_ID);
		const unselectedPath = state?.captures[1]?.outputPath;
		if (!unselectedPath) throw new Error("Expected second capture path");
		rmSync(unselectedPath, { force: true });

		const result = await extractPipelineTool.execute(
			{ rule: "from p1 | cat", format: "plain" },
			ctx,
		);
		expect(result).toEqual({ output: "selected content" });
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(2);
	});

	test("validates rules before reading and preserves state on EndPipeline errors", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "content");
		const state = await getPipelineState(TEST_NARRATOR_ID);
		const selectedPath = state?.captures[0]?.outputPath;
		if (!selectedPath) throw new Error("Expected capture path");
		rmSync(selectedPath, { force: true });

		const result = await endPipelineTool.execute(
			{ rule: "from p1 | awk value", format: "plain" },
			ctx,
		);
		expect(result).toMatchObject({ isError: true });
		expect(result.output).toContain("Unsupported pipeline command: awk");
		expect(await getPipelineState(TEST_NARRATOR_ID)).not.toBeNull();
	});

	test("rejects capture paths outside the truncate output directory", async () => {
		await expect(
			readCaptureTextBounded({
				alias: "p1",
				toolUseId: "tool-1",
				toolName: "Read",
				outputPath: "/tmp/not-a-pipeline-capture",
				bytes: 0,
				preview: "",
				isError: false,
				createdAt: new Date().toISOString(),
			}),
		).rejects.toThrow("outside the controlled output directory");
	});

	test("enforces per-capture input and final output limits without clearing on error", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "x".repeat(256 * 1024 + 1));
		const tooLarge = await endPipelineTool.execute({ rule: "from p1 | cat", format: "plain" }, ctx);
		expect(tooLarge).toMatchObject({ isError: true });
		expect(tooLarge.output).toContain("input bytes");
		expect(await getPipelineState(TEST_NARRATOR_ID)).not.toBeNull();

		await clearPipelineState(TEST_NARRATOR_ID);
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "0123456789".repeat(20));
		const clipped = await endPipelineTool.execute(
			{ rule: "from p1 | cat", format: "plain", maxChars: 40 },
			ctx,
		);
		expect(clipped.isError).toBeUndefined();
		expect(clipped.output.length).toBe(40);
		expect(await getPipelineState(TEST_NARRATOR_ID)).toBeNull();
	});

	test("caps the number of stored captures", async () => {
		await startPipelineTool.execute({}, makeContext());
		for (let index = 0; index < MAX_PIPELINE_CAPTURES; index++) {
			await capture("Read", `capture ${index}`);
		}
		await expect(capture("Read", "one too many")).rejects.toThrow("capture limit");
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(
			MAX_PIPELINE_CAPTURES,
		);
	});

	test("treats ExtractPipeline as a control tool so its output is not captured", () => {
		expect(isPipelineControlTool("StartPipeline")).toBe(true);
		expect(isPipelineControlTool("ExtractPipeline")).toBe(true);
		expect(isPipelineControlTool("EndPipeline")).toBe(true);
		expect(isPipelineControlTool("Grep")).toBe(false);
	});
});
