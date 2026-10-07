import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import { backgroundTaskService } from "../../../../services/background-task-service";
import * as remoteHooks from "../../../../services/remote-tree-snapshot-hooks";
import type { ExecHandle, ExecutionBackend } from "../../execution/backend";
import { posixPathSemantics } from "../../execution/path-semantics";
import type { ToolContext, ToolExecutionTarget } from "../../types";
import { bashTool } from "../bash";

const registered = spyOn(remoteHooks, "registerRemoteActivity").mockResolvedValue(undefined);
const finished = spyOn(remoteHooks, "finishRemoteActivity").mockResolvedValue(undefined);
const createTask = spyOn(backgroundTaskService, "createBashTask").mockImplementation(
	async (opts) => {
		const now = new Date().toISOString();
		return {
			id: opts.id,
			parentNarratorId: opts.parentNarratorId,
			type: "bash",
			logicalRunId: `fixture-run:${opts.id}`,
			status: "running",
			command: opts.command,
			exitCode: null,
			subagentNarratorId: null,
			subagentType: null,
			transferTaskId: null,
			toolUseId: opts.toolUseId ?? null,
			toolCallId: opts.toolCallBinding?.toolCallId ?? null,
			executionAttempt: opts.toolCallBinding?.attempt ?? null,
			alias: opts.alias ?? null,
			title: opts.title ?? null,
			output: null,
			outputBytes: 0,
			outputTruncated: false,
			notified: false,
			startedAt: now,
			completedAt: null,
			createdAt: now,
			updatedAt: now,
		};
	},
);
const completed = spyOn(backgroundTaskService, "markCompleted").mockResolvedValue(true);
const failed = spyOn(backgroundTaskService, "markFailed").mockResolvedValue(true);
const timedOut = spyOn(backgroundTaskService, "markTimedOut").mockResolvedValue(true);
afterEach(() => {
	for (const spy of [registered, finished, createTask, completed, failed, timedOut])
		spy.mockClear();
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<T>((yes, no) => {
		resolve = yes;
		reject = no;
	});
	return { promise, resolve, reject };
}
function fixture() {
	const exited = deferred<number | null>();
	const settled = deferred<void>();
	const handle: ExecHandle = {
		exited: exited.promise,
		whenSettled: settled.promise,
		onData() {},
		isExited: () => false,
		kill: async () => {},
	};
	const exec = mock(async (_args: Parameters<ExecutionBackend["execCommand"]>[0]) => handle);
	const backend = {
		kind: "remote",
		deviceId: "remote",
		supportsRemoteHistory: true,
		paths: posixPathSemantics,
		pathFlavor: "posix",
		runtimeGeneration: 3,
		defaultCwd: "/decoy",
		execCommand: exec,
	} as unknown as ExecutionBackend;
	const target: ToolExecutionTarget = {
		deviceId: "remote",
		backendKind: "remote",
		cwd: "/selected/repo/src",
		baseCwd: "/selected/repo",
		pathFlavor: "posix",
		runtimeGeneration: 3,
		selectionSource: "session_default",
	};
	const ctx: ToolContext = {
		narratorId: "remote-bash-activity",
		cwd: "/host/decoy",
		userId: "actual-user",
		projectId: "project",
		signal: new AbortController().signal,
		locale: "en",
		requestPermission: async () => ({ behavior: "allow" }),
		resolveBackend: () => backend,
		executionTarget: target,
		toolCallBinding: { toolCallId: "persisted-attempt", attempt: 7 },
		currentToolUseId: "bash-call",
	};
	return { ctx, backend, exec, target, exited, settled };
}
async function tick() {
	await Promise.resolve();
	await Promise.resolve();
	await Promise.resolve();
}

describe("remote Bash real activity lifetime", () => {
	test("registers the trusted actor and attempt before spawn; background ID is not completion", async () => {
		const f = fixture();
		let registeredBeforeSpawn = false;
		f.exec.mockImplementation(async () => {
			registeredBeforeSpawn = registered.mock.calls.length === 1;
			return {
				exited: f.exited.promise,
				whenSettled: f.settled.promise,
				onData() {},
				isExited: () => false,
				kill: async () => {},
			};
		});
		const result = await bashTool.execute(
			{ command: "worker", run_in_background: true, timeout: 0 },
			f.ctx,
		);
		expect(result.isError, result.output).not.toBe(true);
		await tick();
		expect(registeredBeforeSpawn).toBe(true);
		expect(registered.mock.calls[0][0]).toMatchObject({
			narratorId: f.ctx.narratorId,
			userId: "actual-user",
			target: f.target,
			binding: { toolCallId: "persisted-attempt", attempt: 7 },
			kind: "bash",
		});
		expect(finished).not.toHaveBeenCalled();
		f.ctx.cwd = "/later/host";
		f.ctx.executionTarget = { ...f.target, cwd: "/later/repo" };
		f.exited.resolve(0);
		await tick();
		expect(finished).not.toHaveBeenCalled();
		f.settled.resolve(undefined);
		await tick();
		expect(finished.mock.calls[0][0]).toMatchObject({
			target: f.target,
			binding: { toolCallId: "persisted-attempt", attempt: 7 },
			outcome: "finished",
		});
	});
	test("a rejected lifetime is unknown even when the background task already says completed", async () => {
		const f = fixture();
		await bashTool.execute({ command: "worker", run_in_background: true, timeout: 0 }, f.ctx);
		f.exited.resolve(0);
		await tick();
		f.settled.reject(new Error("transport lifetime unknown"));
		await tick();
		expect(finished.mock.calls[0][0].outcome).toBe("unknown");
	});
	test("remote dispatch acknowledgement loss never proves no process spawned", async () => {
		const f = fixture();
		f.exec.mockRejectedValue(new Error("connection lost after send"));
		await bashTool.execute({ command: "worker", run_in_background: true, timeout: 0 }, f.ctx);
		await tick();
		expect(finished.mock.calls[0][0].outcome).toBe("unknown");
	});
	test("registration failure prevents dispatch, and missing modern binding never falls back", async () => {
		const f = fixture();
		registered.mockRejectedValueOnce(new Error("source recovery barrier"));
		const rejected = await bashTool.execute({ command: "worker" }, f.ctx);
		expect(rejected.isError).toBe(true);
		expect(f.exec).not.toHaveBeenCalled();
		const noBinding = fixture();
		noBinding.ctx.toolCallBinding = undefined;
		const unbound = await bashTool.execute({ command: "worker" }, noBinding.ctx);
		expect(unbound.isError).toBe(true);
		expect(noBinding.exec).not.toHaveBeenCalled();
	});
	test("nullable remote exit without an authoritative settled barrier remains unknown", async () => {
		const f = fixture();
		f.exec.mockImplementation(async () => ({
			exited: f.exited.promise,
			onData() {},
			isExited: () => true,
			kill: async () => {},
		}));
		await bashTool.execute({ command: "worker", run_in_background: true, timeout: 0 }, f.ctx);
		f.exited.resolve(null);
		await tick();
		expect(finished.mock.calls[0][0].outcome).toBe("unknown");
	});
});
