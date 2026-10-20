import { afterAll, expect, mock, test } from "bun:test";
import type { ToolContext } from "../../types";

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((done, fail) => {
		resolve = done;
		reject = fail;
	});
	return { promise, resolve, reject };
}

let exit = deferred<number>();
let close = deferred<number>();
let persisted = deferred<void>();
let publicationStarted = deferred<void>();
const work = new Set<Promise<unknown>>();
let exited = false;
let activityEnded = false;
let leaseReleased = false;
const failures: unknown[] = [];
const service = {
	assertExecutionAdmission() {},
	trackBashLifecycle(promise: Promise<unknown>) {
		work.add(promise);
		void promise.then(
			() => work.delete(promise),
			(error) => {
				work.delete(promise);
				failures.push(error);
			},
		);
	},
	reportShutdownFailure(error: unknown) {
		failures.push(error);
	},
	createBashTask: mock(async () => {}),
	registerAbortController() {},
	registerKillHandler() {},
	getOutputBuffer: () => "mock output",
	isCancellationRequested: () => false,
	markCompleted: mock(async () => {
		publicationStarted.resolve();
		await persisted.promise;
	}),
	markFailed: mock(async () => {}),
};
mock.module("@server/services/background-task-service", () => ({ backgroundTaskService: service }));
mock.module("@server/services/file-change-runtime", () => ({
	registerLocalBashActivity: async () => ({
		cwd: "/mock",
		scope: { id: "mock" },
		end() {
			activityEnded = true;
		},
	}),
}));
mock.module("@server/services/narrator-tree-snapshot-hooks", () => ({
	beginBashCaptureWindow: () => ({ end() {} }),
}));
mock.module("@server/lib/git-identity", () => ({
	resolveNarratorGitIdentityEnv: async () => null,
}));
mock.module("@server/services/narrator-subagent", () => ({
	registerTaskAlias: () => ({ alias: "mock-task", conflicted: false }),
}));
mock.module("../../execution/tool-backend", () => ({
	getToolBackend: () => ({
		kind: "local",
		statFile: async () => ({ isDirectory: true }),
		execCommand: async () => ({
			exited: exit.promise,
			whenSettled: close.promise,
			onData() {},
			kill() {
				throw new Error("Mock process must not be killed");
			},
			isExited: () => exited,
		}),
	}),
}));
const { bashTool } = await import("../bash");
afterAll(() => mock.restore());

test("background Bash owns terminal persistence, lease finally and activity close observer", async () => {
	const context = {
		narratorId: "mock-narrator",
		cwd: "/mock",
		signal: new AbortController().signal,
		updateExecutionLease: {
			transfer: () => true,
			release: () => {
				leaseReleased = true;
			},
		},
	} as unknown as ToolContext;
	const result = await bashTool.execute({ command: "mock", run_in_background: true }, context);
	expect(result.output).toContain("mock-task");
	expect(work.size).toBe(2);
	exited = true;
	exit.resolve(0);
	await publicationStarted.promise;
	expect(service.markCompleted).toHaveBeenCalledTimes(1);
	expect(leaseReleased).toBe(false);
	expect(activityEnded).toBe(false);
	let drained = false;
	const drain = Promise.all([...work]).then(() => {
		drained = true;
	});
	persisted.resolve();
	await Promise.resolve();
	expect(drained).toBe(false);
	close.resolve(0);
	await drain;
	expect(leaseReleased).toBe(true);
	expect(activityEnded).toBe(true);
	expect(failures).toEqual([]);
	expect(work.size).toBe(0);
});

test("a failed terminal write stays visible even when error publication succeeds", async () => {
	exit = deferred<number>();
	close = deferred<number>();
	persisted = deferred<void>();
	publicationStarted = deferred<void>();
	exited = false;
	activityEnded = false;
	leaseReleased = false;
	const context = {
		narratorId: "mock-narrator",
		cwd: "/mock",
		signal: new AbortController().signal,
		updateExecutionLease: {
			transfer: () => true,
			release: () => {
				leaseReleased = true;
			},
		},
	} as unknown as ToolContext;
	await bashTool.execute({ command: "mock", run_in_background: true }, context);
	exited = true;
	exit.resolve(0);
	close.resolve(0);
	await publicationStarted.promise;
	const error = new Error("terminal persistence failed");
	persisted.reject(error);
	await Promise.all([...work]);
	expect(service.markFailed).toHaveBeenCalledTimes(1);
	expect(failures).toEqual([error]);
	expect(leaseReleased).toBe(true);
	expect(activityEnded).toBe(true);
});
