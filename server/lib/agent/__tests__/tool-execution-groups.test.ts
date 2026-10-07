import { describe, expect, test } from "bun:test";
import {
	groupToolExecutions,
	isAgentDependentToolExecutionGroup,
	isBashParallelOptIn,
	isParallelSafeToolExecution,
	isStrictSerialToolExecution,
	selectStreamingToolExecutions,
	settleToolExecutionResult,
} from "../tool-execution-groups";
import type { ToolExecResult } from "../tool-executor";

function tool(name: string, input: Record<string, unknown> = {}) {
	return { name, input };
}

describe("tool execution grouping", () => {
	test("explicit and legacy worktree tools remain strict serial barriers", () => {
		for (const name of [
			"Worktree",
			"ListWorktrees",
			"CreateWorktree",
			"AttachWorktree",
			"GetWorktreeOperation",
		]) {
			const item = tool(name, { parallel: true });
			expect(isStrictSerialToolExecution(item)).toBe(true);
			expect(
				groupToolExecutions([tool("Read"), item, tool("Grep")]).map((group) =>
					group.map((member) => member.name),
				),
			).toEqual([["Read"], [name], ["Grep"]]);
		}
	});
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

	describe("Bash defaults to serial", () => {
		test("consecutive default Bash calls do not join a parallel group", () => {
			expect(
				groupToolExecutions([
					tool("Bash", { command: "make build" }),
					tool("Bash", { command: "curl health" }),
				]).map((group) => group.map(({ input }) => input.command)),
			).toEqual([["make build"], ["curl health"]]);
		});

		test("default Bash does not join neighboring parallel-safe reads", () => {
			expect(
				groupToolExecutions([
					tool("Bash", { command: "make build" }),
					tool("Read"),
					tool("Glob"),
				]).map((group) => group.map(({ name }) => name)),
			).toEqual([["Bash"], ["Read", "Glob"]]);
		});

		test("explicit parallel:true Bash joins a parallel batch with siblings", () => {
			expect(
				groupToolExecutions([
					tool("Bash", { command: "git status", parallel: true }),
					tool("Bash", { command: "git log", parallel: true }),
					tool("Read"),
				]).map((group) => group.map(({ name }) => name)),
			).toEqual([["Bash", "Bash", "Read"]]);
		});

		test("parallel:true Bash does not drag a later default Bash into the batch", () => {
			expect(
				groupToolExecutions([
					tool("Bash", { command: "git status", parallel: true }),
					tool("Bash", { command: "make build" }),
					tool("Bash", { command: "curl health", parallel: true }),
				]).map((group) => group.map(({ input }) => input.command)),
			).toEqual([["git status"], ["make build"], ["curl health"]]);
		});

		test("strict_serial wins over parallel:true", () => {
			const item = tool("Bash", { parallel: true, strict_serial: true });
			expect(isStrictSerialToolExecution(item)).toBe(true);
			expect(isParallelSafeToolExecution(item)).toBe(false);
			expect(isBashParallelOptIn(item)).toBe(false);
			expect(
				groupToolExecutions([tool("Read"), item, tool("Grep")]).map((group) =>
					group.map(({ name }) => name),
				),
			).toEqual([["Read"], ["Bash"], ["Grep"]]);
		});

		test("default Bash is strict-serial and not parallel-safe", () => {
			const item = tool("Bash", { command: "true" });
			expect(isStrictSerialToolExecution(item)).toBe(true);
			expect(isParallelSafeToolExecution(item)).toBe(false);
			expect(isBashParallelOptIn(item)).toBe(false);
		});

		test("parallel:true Bash is parallel-safe", () => {
			const item = tool("Bash", { command: "true", parallel: true });
			expect(isStrictSerialToolExecution(item)).toBe(false);
			expect(isParallelSafeToolExecution(item)).toBe(true);
			expect(isBashParallelOptIn(item)).toBe(true);
		});
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

describe("selectStreamingToolExecutions", () => {
	function entry(
		item: ReturnType<typeof tool> | undefined,
		state: Partial<{
			ready: boolean;
			started: boolean;
			settled: boolean;
			fatal: boolean;
			allowed: boolean;
		}> = {},
	) {
		return { tool: item, ready: true, started: false, settled: false, allowed: true, ...state };
	}

	test("empty and fully settled queues select nothing", () => {
		expect(selectStreamingToolExecutions([])).toEqual([]);
		expect(
			selectStreamingToolExecutions([
				entry(tool("Write"), { started: true, settled: true }),
				entry(tool("Read"), { started: true, settled: true }),
			]),
		).toEqual([]);
	});

	test("incomplete earlier identities block later calls even when they became ready first", () => {
		const earlier = tool("Write");
		const later = tool("Read");
		// The upstream supplies provider order, not parameter-completion order.
		const items = [entry(undefined, { ready: false }), entry(later)];
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		items[0] = entry(earlier, { ready: false });
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		items[0].ready = true;
		expect(selectStreamingToolExecutions(items)).toEqual([earlier]);
	});

	test("missing descriptors remain barriers even when marked ready", () => {
		expect(selectStreamingToolExecutions([entry(undefined), entry(tool("Read"))])).toEqual([]);
	});

	test("complete parallel prefix can start before an incomplete call", () => {
		const read = tool("Read");
		const grep = tool("Grep");
		const later = tool("Read");
		const items = [entry(read), entry(grep), entry(undefined), entry(later)];
		expect(selectStreamingToolExecutions(items)).toEqual([read, grep]);
		items[0].started = items[0].settled = true;
		items[1].started = items[1].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
	});

	test("Write, Edit, and default Bash remain serial until their predecessors settle", () => {
		const tools = [tool("Write"), tool("Edit"), tool("Bash"), tool("Bash"), tool("Read")];
		const items = tools.map((item) => entry(item));
		for (let index = 0; index < items.length; index++) {
			expect(selectStreamingToolExecutions(items)).toEqual([tools[index]]);
			items[index].started = true;
			expect(selectStreamingToolExecutions(items)).toEqual([]);
			items[index].settled = true;
		}
		expect(selectStreamingToolExecutions(items)).toEqual([]);
	});

	test("explicitly parallel Bash joins Read but strict_serial still wins", () => {
		const read = tool("Read");
		const bash = tool("Bash", { parallel: true });
		const strict = tool("Bash", { parallel: true, strict_serial: true });
		const later = tool("Read");
		const items = [entry(read), entry(bash), entry(strict), entry(later)];
		expect(selectStreamingToolExecutions(items)).toEqual([read, bash]);
		items[0].started = items[0].settled = true;
		items[1].started = items[1].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([strict]);
	});

	test("running parallel groups accept new siblings without releasing the next Write", () => {
		const read = tool("Read");
		const bash = tool("Bash", { parallel: true });
		const write = tool("Write");
		const items = [entry(read)];
		expect(selectStreamingToolExecutions(items)).toEqual([read]);
		items[0].started = true;
		items.push(entry(bash), entry(write));
		expect(selectStreamingToolExecutions(items)).toEqual([bash]);
		items[1].started = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		// Completion order does not alter provider-order barriers.
		items[1].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		items[0].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([write]);
	});

	test("a settled parallel prefix can receive a late sibling without restarting old members", () => {
		const read = tool("Read");
		const grep = tool("Grep");
		const items = [entry(read, { started: true, settled: true }), entry(grep)];
		expect(selectStreamingToolExecutions(items)).toEqual([grep]);
		items[1].started = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
	});

	test("disabled members block even later members of the same parallel group", () => {
		const read = tool("Read");
		const disabled = tool("Agent");
		const items = [
			entry(read),
			entry(disabled, { allowed: false }),
			entry(tool("Read")),
			entry(tool("Write")),
		];
		expect(selectStreamingToolExecutions(items)).toEqual([read]);
		items[0].started = items[0].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
	});

	test("deferred Agent blocks Await and Send until it is allowed and settled", () => {
		const agent = tool("Agent");
		const awaitTool = tool("Await");
		const send = tool("Send");
		const items = [entry(agent, { allowed: false }), entry(awaitTool), entry(send)];
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		items[0].allowed = true;
		expect(selectStreamingToolExecutions(items)).toEqual([agent]);
		items[0].started = true;
		expect(selectStreamingToolExecutions(items)).toEqual([]);
		items[0].settled = true;
		expect(selectStreamingToolExecutions(items)).toEqual([awaitTool, send]);
	});

	test("settled nonfatal deferred calls no longer block later groups", () => {
		const read = tool("Read");
		expect(
			selectStreamingToolExecutions([
				entry(tool("ExitPlanMode"), { started: true, settled: true, allowed: false }),
				entry(read),
			]),
		).toEqual([read]);
	});

	test("settled fatal calls cannot be skipped like successful groups", () => {
		expect(
			selectStreamingToolExecutions([
				entry(tool("Write"), { started: true, settled: true }),
				entry(tool("Bash"), { started: true, settled: true, fatal: true }),
				entry(tool("Read")),
			]),
		).toEqual([]);
	});

	test("fatal parallel members also prevent later siblings from starting", () => {
		expect(
			selectStreamingToolExecutions([
				entry(tool("Read"), { started: true }),
				entry(tool("Grep"), { started: true, settled: true, fatal: true }),
				entry(tool("Read")),
				entry(tool("Write")),
			]),
		).toEqual([]);
	});

	test("preserves generic tool descriptors and does not mutate the input", () => {
		const first = Object.freeze({ toolName: "Read", input: {}, id: "first" });
		const second = Object.freeze({ toolName: "Read", input: {}, id: "second" });
		const items = Object.freeze([
			Object.freeze({ tool: first, ready: true, started: true, settled: false, allowed: true }),
			Object.freeze({ tool: second, ready: true, started: false, settled: false, allowed: true }),
		]);
		const selected = selectStreamingToolExecutions<typeof first | typeof second>(items);
		expect(selected).toEqual([second]);
		expect(selected[0]).toBe(second);
		expect(selected[0].id).toBe("second");
		expect(items[1].started).toBe(false);
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
			durationMs: 0,
		});
	});
});
