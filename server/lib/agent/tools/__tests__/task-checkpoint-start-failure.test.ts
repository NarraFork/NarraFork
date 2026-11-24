import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { CheckpointStop } from "../../../../services/agent-runtime/checkpoint-stop";
import type { ToolContext } from "../../types";

let runFailure: unknown;
let created = false;
let settlementFailure = false;
const attachWorker = mock(() => {});
const settleFailedStart = mock(async () => {
	if (settlementFailure) throw new Error("settlement unavailable");
	return "kept";
});
const runSubagent = mock(async (input: { onCreated?: (id: string) => void }) => {
	if (created) input.onCreated?.("checkpoint-worker");
	if (runFailure) throw runFailure;
	return "completed";
});

mock.module("@server/services/narrator-subagent", () => ({ runSubagent }));
mock.module("@server/services/teams/team-membership", () => ({
	coordinatedTeamId: () => "checkpoint-team",
}));
mock.module("@server/services/teams/work-items", () => ({
	workItemAtWorktree: () => ({
		id: "checkpoint-item",
		branchName: "checkpoint-branch",
		workerNarratorId: null,
	}),
	attachWorker,
	settleFailedStart,
}));

const { agentTool } = await import("../task");

afterAll(() => mock.restore());
beforeEach(() => {
	runFailure = undefined;
	created = false;
	settlementFailure = false;
	runSubagent.mockClear();
	attachWorker.mockClear();
	settleFailedStart.mockClear();
});

function context(): ToolContext {
	return {
		narratorId: "checkpoint-parent",
		cwd: "/workspace",
		signal: new AbortController().signal,
		locale: "en",
		currentToolUseId: "checkpoint-use",
		toolCallBinding: { toolCallId: "checkpoint-call", attempt: 1 },
		updateExecutionLease: {
			kind: "resumable",
			setNarratorId: () => {},
			transfer: () => true,
			release: () => {},
		},
		requestPermission: async () => ({ behavior: "allow" }),
	};
}

const launch = () =>
	agentTool.execute({ workdir: "/workspace/item", prompt: "Continue the item" }, context());

describe("Agent start settlement and restart checkpoints", () => {
	for (const afterCreated of [false, true]) {
		test(`checkpoint stop is rethrown unchanged, created=${afterCreated}`, async () => {
			created = afterCreated;
			const stop = new CheckpointStop("checkpoint-update", {
				narratorId: "checkpoint-parent",
				logicalRunId: "checkpoint-run",
				executionEpoch: "checkpoint-owner",
			});
			runFailure = stop;
			await expect(launch()).rejects.toBe(stop);
			expect(settleFailedStart).not.toHaveBeenCalled();
			expect(attachWorker).toHaveBeenCalledTimes(afterCreated ? 1 : 0);
		});

		test(`ordinary launch failure settles the item, created=${afterCreated}`, async () => {
			created = afterCreated;
			runFailure = new Error("model refused start");
			const result = await launch();
			expect(result).toMatchObject({
				output: "Subagent error: model refused start",
				isError: true,
			});
			expect(settleFailedStart).toHaveBeenCalledWith(
				"checkpoint-team",
				"checkpoint-item",
				afterCreated ? "checkpoint-worker" : null,
				{ kind: "agent", id: "checkpoint-parent" },
			);
		});
	}

	test("a checkpoint-shaped ordinary error still settles the failed start", async () => {
		runFailure = Object.assign(new Error("untrusted checkpoint name"), { name: "CheckpointStop" });
		expect((await launch()).isError).toBe(true);
		expect(settleFailedStart).toHaveBeenCalledTimes(1);
	});

	test("settlement failure preserves the original launch error result", async () => {
		runFailure = new Error("alias registration failed");
		settlementFailure = true;
		expect(await launch()).toMatchObject({
			output: "Subagent error: alias registration failed",
			isError: true,
		});
		expect(settleFailedStart).toHaveBeenCalledTimes(1);
	});

	test("successful delegation keeps its work item attached", async () => {
		created = true;
		const result = await launch();
		expect(result.isError).toBeFalsy();
		expect(result.output).toContain("Team work item checkpoint-item");
		expect(attachWorker).toHaveBeenCalledWith(
			"checkpoint-team",
			"checkpoint-item",
			"checkpoint-worker",
			{
				kind: "agent",
				id: "checkpoint-parent",
			},
		);
		expect(settleFailedStart).not.toHaveBeenCalled();
	});
});
