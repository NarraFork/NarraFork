import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { eq } from "drizzle-orm";
import { narrators } from "../../../../db/schema";
import type { ToolContext } from "../../types";

let db: typeof import("../../../../db").db;
let acknowledgePipelineExitConfirmation: typeof import("../../pipeline-state").acknowledgePipelineExitConfirmation;
let capturePipelineOutput: typeof import("../../pipeline-state").capturePipelineOutput;
let clearPipelineState: typeof import("../../pipeline-state").clearPipelineState;
let getPipelineState: typeof import("../../pipeline-state").getPipelineState;
let getPipelineStateForToolCall: typeof import("../../pipeline-state").getPipelineStateForToolCall;
let isPipelineControlTool: typeof import("../../pipeline-state").isPipelineControlTool;
let MAX_PIPELINE_CAPTURES: typeof import("../../pipeline-state").MAX_PIPELINE_CAPTURES;
let readCaptureTextBounded: typeof import("../../pipeline-state").readCaptureTextBounded;
let extractPipelineTool: typeof import("../pipeline").extractPipelineTool;
let startPipelineTool: typeof import("../pipeline").startPipelineTool;

const TEST_NARRATOR_ID = `pipeline-test-${Date.now().toString(36)}`;
const capturedPaths = new Set<string>();
let nextToolUseId = 1;

function makeContext(pipelineUnusedToolCallThreshold?: number): ToolContext {
	return {
		narratorId: TEST_NARRATOR_ID,
		cwd: "/tmp",
		signal: new AbortController().signal,
		pipelineUnusedToolCallThreshold,
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
		acknowledgePipelineExitConfirmation,
		capturePipelineOutput,
		clearPipelineState,
		getPipelineState,
		getPipelineStateForToolCall,
		isPipelineControlTool,
		MAX_PIPELINE_CAPTURES,
		readCaptureTextBounded,
	} = await import("../../pipeline-state"));
	({ extractPipelineTool, startPipelineTool } = await import("../pipeline"));
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
	test("extracts the same captures repeatedly without clearing them", async () => {
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

		const repeated = await extractPipelineTool.execute(
			{ rule: "from p1 p2 | grep error", format: "plain" },
			ctx,
		);
		expect(repeated).toEqual({ output: "error: first\nerror: second" });
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(2);
	});

	test("uses the context threshold when StartPipeline has no override", async () => {
		await startPipelineTool.execute({}, makeContext(3));
		expect((await getPipelineState(TEST_NARRATOR_ID))?.unusedToolCallThreshold).toBe(3);
	});

	test("resets the inactivity counter when ExtractPipeline uses captures", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({ maxUnusedToolCalls: 2 }, ctx);
		await capture("Read", "first");
		await capture("Read", "second");
		expect((await getPipelineState(TEST_NARRATOR_ID))?.unusedToolCalls).toBe(2);

		const extracted = await extractPipelineTool.execute(
			{ rule: "from p1 p2 | cat", format: "plain" },
			ctx,
		);
		expect(extracted).toEqual({ output: "first\nsecond" });
		expect((await getPipelineState(TEST_NARRATOR_ID))?.unusedToolCalls).toBe(0);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.hasExtracted).toBe(true);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.exitConfirmationPending).toBe(true);
	});

	test("keeps exit confirmation pending until SideCar delivery is acknowledged", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "captured");
		await extractPipelineTool.execute({ rule: "from p1 | cat", format: "plain" }, ctx);

		const firstNonControlCall = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(firstNonControlCall.needsExitConfirmation).toBe(true);
		expect(firstNonControlCall.state?.exitConfirmationPending).toBe(true);
		const stateId = firstNonControlCall.state?.id;
		if (!stateId) throw new Error("Expected active pipeline state");

		const earlyDrainRetry = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(earlyDrainRetry.needsExitConfirmation).toBe(true);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.exitConfirmationPending).toBe(true);

		await expect(
			acknowledgePipelineExitConfirmation(TEST_NARRATOR_ID, "stale-state"),
		).resolves.toBe(false);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.exitConfirmationPending).toBe(true);

		await expect(acknowledgePipelineExitConfirmation(TEST_NARRATOR_ID, stateId)).resolves.toBe(
			true,
		);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.exitConfirmationPending).toBe(false);

		const nextNonControlCall = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(nextNonControlCall.needsExitConfirmation).toBe(false);
	});

	test("does not auto-clear a pending exit confirmation before delivery", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({ maxUnusedToolCalls: 1 }, ctx);
		await capture("Read", "captured");
		await extractPipelineTool.execute({ rule: "from p1 | cat", format: "plain" }, ctx);
		const stateId = (await getPipelineState(TEST_NARRATOR_ID))?.id;
		if (!stateId) throw new Error("Expected active pipeline state");

		expect((await getPipelineStateForToolCall(TEST_NARRATOR_ID)).needsExitConfirmation).toBe(true);
		await capture("Read", "completed before SideCar persistence");

		const retry = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(retry.autoCleared).toBe(false);
		expect(retry.needsExitConfirmation).toBe(true);
		expect(retry.state?.id).toBe(stateId);

		await acknowledgePipelineExitConfirmation(TEST_NARRATOR_ID, stateId);
		expect(await getPipelineStateForToolCall(TEST_NARRATOR_ID)).toEqual({
			state: null,
			autoCleared: true,
			needsExitConfirmation: false,
		});
	});

	test("auto-clears captures before the next non-control tool call", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({ maxUnusedToolCalls: 2 }, ctx);
		await capture("Read", "first");
		await capture("Read", "second");

		const lookup = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(lookup).toEqual({ state: null, autoCleared: true, needsExitConfirmation: false });
		expect(await getPipelineState(TEST_NARRATOR_ID)).toBeNull();
	});

	test("allows ExtractPipeline to rescue captures at the threshold", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({ maxUnusedToolCalls: 1 }, ctx);
		await capture("Read", "rescuable");

		const extracted = await extractPipelineTool.execute(
			{ rule: "from p1 | cat", format: "plain" },
			ctx,
		);
		expect(extracted).toEqual({ output: "rescuable" });
		expect(await getPipelineState(TEST_NARRATOR_ID)).not.toBeNull();
	});

	test("keeps captures when automatic cleanup is disabled", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({ maxUnusedToolCalls: -1 }, ctx);
		await capture("Read", "persistent");

		const lookup = await getPipelineStateForToolCall(TEST_NARRATOR_ID);
		expect(lookup.state?.captures).toHaveLength(1);
		expect(lookup.autoCleared).toBe(false);
		expect(lookup.needsExitConfirmation).toBe(false);
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

	test("validates rules before reading and preserves state on ExtractPipeline errors", async () => {
		const ctx = makeContext();
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "content");
		const state = await getPipelineState(TEST_NARRATOR_ID);
		const selectedPath = state?.captures[0]?.outputPath;
		if (!selectedPath) throw new Error("Expected capture path");
		rmSync(selectedPath, { force: true });

		const result = await extractPipelineTool.execute(
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
		const tooLarge = await extractPipelineTool.execute(
			{ rule: "from p1 | cat", format: "plain" },
			ctx,
		);
		expect(tooLarge).toMatchObject({ isError: true });
		expect(tooLarge.output).toContain("input bytes");
		expect(await getPipelineState(TEST_NARRATOR_ID)).not.toBeNull();

		await clearPipelineState(TEST_NARRATOR_ID);
		await startPipelineTool.execute({}, ctx);
		await capture("Read", "0123456789".repeat(20));
		const clipped = await extractPipelineTool.execute(
			{ rule: "from p1 | cat", format: "plain", maxChars: 40 },
			ctx,
		);
		expect(clipped.isError).toBeUndefined();
		expect(clipped.output.length).toBe(40);
		expect((await getPipelineState(TEST_NARRATOR_ID))?.captures).toHaveLength(1);
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

	test("treats the active Pipeline tools as control tools", () => {
		expect(isPipelineControlTool("StartPipeline")).toBe(true);
		expect(isPipelineControlTool("ExtractPipeline")).toBe(true);
		expect(isPipelineControlTool("EndPipeline")).toBe(false);
		expect(isPipelineControlTool("Grep")).toBe(false);
	});
});
