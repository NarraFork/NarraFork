import { describe, expect, test } from "bun:test";
import {
	groupToolExecutions,
	isAgentDependentToolExecutionGroup,
	isStrictSerialToolExecution,
	settleToolExecutionResult,
} from "../tool-execution-groups";
import type { ToolExecResult } from "../tool-executor";

function tool(name: string, input: Record<string, unknown> = {}) {
	return { name, input };
}

describe("tool execution grouping", () => {
	test("matches loop ordering, parallel runs, and serial barriers", () => {
		const tools = [
			tool("Write"),
			tool("Agent"),
			tool("Read"),
			tool("Await"),
			tool("Bash", { strict_serial: true }),
			tool("Agent"),
			tool("StartPipeline"),
			tool("Glob"),
			tool("Grep"),
		];

		expect(groupToolExecutions(tools).map((group) => group.map(({ name }) => name))).toEqual([
			["Write"],
			// Await opens a fresh group because the preceding parallel batch spawned an Agent.
			["Agent", "Read"],
			["Await"],
			["Bash"],
			["Agent"],
			["StartPipeline"],
			["Glob", "Grep"],
		]);
	});

	test("accepts recovery queue toolName descriptors with identical semantics", () => {
		const recoveryItems = [
			{ toolName: "Read", input: {} },
			{ toolName: "Agent", input: {} },
			{ toolName: "Await", input: {} },
			{ toolName: "Bash", input: { strict_serial: true } },
			{ toolName: "Agent", input: {} },
		];

		expect(
			groupToolExecutions(recoveryItems).map((group) => group.map((item) => item.toolName)),
		).toEqual([["Read", "Agent"], ["Await"], ["Bash"], ["Agent"]]);
		expect(isStrictSerialToolExecution(recoveryItems[3])).toBe(true);
	});

	describe("Agent barrier for Await/Send", () => {
		test("Await after an Agent in the same batch opens a new group", () => {
			expect(
				groupToolExecutions([tool("Agent"), tool("Await")]).map((group) =>
					group.map(({ name }) => name),
				),
			).toEqual([["Agent"], ["Await"]]);
		});

		test("Send after an Agent in the same batch opens a new group", () => {
			expect(
				groupToolExecutions([tool("Agent"), tool("Send")]).map((group) =>
					group.map(({ name }) => name),
				),
			).toEqual([["Agent"], ["Send"]]);
		});

		test("barrier is driven by the Agent member, not the adjacent tool", () => {
			// Read joins the Agent batch first, so Send (barrier-dependent) splits off. Await
			// then joins Send because that fresh group has no Agent — the barrier only triggers
			// while the current group actually contains an Agent.
			expect(
				groupToolExecutions([tool("Read"), tool("Agent"), tool("Send"), tool("Await")]).map(
					(group) => group.map(({ name }) => name),
				),
			).toEqual([
				["Read", "Agent"],
				["Send", "Await"],
			]);
		});

		test("Agent + Agent stays parallel", () => {
			expect(
				groupToolExecutions([tool("Agent"), tool("Agent")]).map((group) =>
					group.map(({ name }) => name),
				),
			).toEqual([["Agent", "Agent"]]);
		});

		test("Agent + Read stays parallel", () => {
			expect(
				groupToolExecutions([tool("Agent"), tool("Read")]).map((group) =>
					group.map(({ name }) => name),
				),
			).toEqual([["Agent", "Read"]]);
		});

		test("Await/Send without a preceding Agent stay in the parallel batch", () => {
			expect(
				groupToolExecutions([tool("Read"), tool("Await"), tool("Send"), tool("Glob")]).map(
					(group) => group.map(({ name }) => name),
				),
			).toEqual([["Read", "Await", "Send", "Glob"]]);
		});

		test("an Await group can re-accumulate later parallel tools", () => {
			// After the barrier splits Await into its own group, subsequent parallel-safe tools
			// (no Agent in that new group) keep batching normally.
			expect(
				groupToolExecutions([tool("Agent"), tool("Await"), tool("Read"), tool("Grep")]).map(
					(group) => group.map(({ name }) => name),
				),
			).toEqual([["Agent"], ["Await", "Read", "Grep"]]);
		});

		test("exposes the same Agent mount barrier to recovery scheduling", () => {
			const groups = groupToolExecutions([
				{ toolName: "Agent", input: {} },
				{ toolName: "Read", input: {} },
				{ toolName: "Await", input: {} },
			]);

			expect(isAgentDependentToolExecutionGroup(groups[0], groups[1] ?? [])).toBe(true);
			expect(isAgentDependentToolExecutionGroup(groups[1], groups[0] ?? [])).toBe(false);
		});
	});
});

describe("settleToolExecutionResult", () => {
	test("passes a resolved result through unchanged", async () => {
		const result: ToolExecResult = {
			output: "ok",
			isError: false,
			durationMs: 42,
			metadata: { foo: "bar" },
		};
		expect(await settleToolExecutionResult(Promise.resolve(result))).toBe(result);
	});

	test("converts a rejection into a formal isError ToolExecResult", async () => {
		const settled = await settleToolExecutionResult(Promise.reject(new Error("boom")));
		expect(settled.isError).toBe(true);
		expect(settled.output).toBe("Tool error: boom");
		expect(settled.durationMs).toBe(0);
		expect(settled.fatal).toBeUndefined();
	});

	test("stringifies non-Error rejection values", async () => {
		const settled = await settleToolExecutionResult(Promise.reject("plain string failure"));
		expect(settled.isError).toBe(true);
		expect(settled.output).toBe("Tool error: plain string failure");
	});

	test("never rejects even when the underlying promise throws asynchronously", async () => {
		const run = (async (): Promise<ToolExecResult> => {
			await Promise.resolve();
			throw new Error("late failure");
		})();
		await expect(settleToolExecutionResult(run)).resolves.toMatchObject({
			isError: true,
			output: "Tool error: late failure",
		});
	});
});
