/**
 * The prompt-optimize registry.
 *
 * This module exists so an optimization outlives the composer that started it.
 * The rules worth pinning are about OWNERSHIP and LIFETIME, not transport:
 *
 *  - a request is attributed to (narratorId, messageId) and never migrates;
 *  - starting one narrator's task never cancels another's;
 *  - a finished result waits until its own composer claims it;
 *  - a superseded request cannot resurrect itself.
 *
 * Transport is injected, so none of this needs the network.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import {
	acknowledgePromptOptimizeDelivery,
	cancelPromptOptimizeTask,
	claimPromptOptimizeDelivery,
	failTask,
	finishTask,
	getNarratorRunningOptimizeCount,
	getPromptOptimizeTask,
	isNarratorOptimizingPrompt,
	promptOptimizeTaskKey,
	releasePromptOptimizeSurface,
	resetPromptOptimizeTasksForTest,
	startPromptOptimizeTask,
	subscribePromptOptimizeTasks,
} from "./prompt-optimize-tasks";

/** A request the test resolves by hand. */
function deferred() {
	let resolve!: (value: { text: string; reasoningSummary?: string }) => void;
	let reject!: (error: Error) => void;
	const promise = new Promise<{ text: string; reasoningSummary?: string }>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

/** Let the task's internal promise chain settle. */
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
	resetPromptOptimizeTasksForTest();
});

describe("task identity", () => {
	test("the composer and a message editor are separate tasks", () => {
		expect(promptOptimizeTaskKey("n1")).not.toBe(promptOptimizeTaskKey("n1", "m1"));
	});

	test("two narrators never share a key", () => {
		expect(promptOptimizeTaskKey("n1")).not.toBe(promptOptimizeTaskKey("n2"));
	});
});

describe("starting a task", () => {
	test("records a running task attributed to its narrator", () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		const task = getPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		expect(task?.status).toBe("running");
		expect(task?.narratorId).toBe("n1");
		expect(task?.originalText).toBe("draft");
		expect(isNarratorOptimizingPrompt("n1")).toBe(true);
		expect(isNarratorOptimizingPrompt("n2")).toBe(false);
	});

	test("starting one narrator's task does not cancel another's", () => {
		const first = deferred();
		const second = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "a",
			style: "clarify",
			withContext: false,
			request: () => first.promise,
		});
		startPromptOptimizeTask({
			narratorId: "n2",
			text: "b",
			style: "clarify",
			withContext: false,
			request: () => second.promise,
		});
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))?.status).toBe("running");
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n2"))?.status).toBe("running");
		expect(getNarratorRunningOptimizeCount("n1")).toBe(1);
		expect(getNarratorRunningOptimizeCount("n2")).toBe(1);
	});

	test("re-optimizing the same target supersedes the previous request", async () => {
		const first = deferred();
		const second = deferred();
		let firstSignal: AbortSignal | undefined;
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "a",
			style: "clarify",
			withContext: false,
			request: (params) => {
				firstSignal = params.signal;
				return first.promise;
			},
		});
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "b",
			style: "concise",
			withContext: false,
			request: () => second.promise,
		});
		expect(firstSignal?.aborted).toBe(true);
		first.resolve({ text: "stale" });
		await flush();
		// The stale response must not overwrite the newer task.
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))?.status).toBe("running");
	});
});

describe("completion", () => {
	test("a finished result waits for its own composer", async () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.resolve({ text: "optimized", reasoningSummary: "why" });
		await flush();

		const task = getPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		expect(task?.status).toBe("succeeded");
		expect(task?.resultText).toBe("optimized");
		expect(task?.summary).toBe("why");
		// Not yet applied anywhere — only a mounted composer may write.
		expect(task?.pendingDelivery).toBe(true);
		// It is no longer *running*, so the status icon goes away immediately.
		expect(isNarratorOptimizingPrompt("n1")).toBe(false);
	});

	test("a blank summary is dropped rather than stored", async () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.resolve({ text: "optimized", reasoningSummary: "   " });
		await flush();
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))?.summary).toBeUndefined();
	});

	test("a failure is recorded and still needs acknowledging", async () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.reject(new Error("boom"));
		await flush();
		const task = getPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		expect(task?.status).toBe("failed");
		expect(task?.error).toBe("boom");
		// Failures are surfaced once, so they are not "running" either.
		expect(isNarratorOptimizingPrompt("n1")).toBe(false);
	});

	test("acknowledging a delivery releases the task", async () => {
		const request = deferred();
		const requestId = startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.resolve({ text: "optimized" });
		await flush();
		acknowledgePromptOptimizeDelivery(promptOptimizeTaskKey("n1"), requestId);
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))).toBeUndefined();
	});

	test("a stale acknowledgement cannot release a newer task", async () => {
		const first = deferred();
		const requestId = startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => first.promise,
		});
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft2",
			style: "clarify",
			withContext: false,
			request: () => deferred().promise,
		});
		acknowledgePromptOptimizeDelivery(promptOptimizeTaskKey("n1"), requestId);
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))?.status).toBe("running");
	});
});

describe("cancellation", () => {
	test("cancelling aborts and drops the task entirely", async () => {
		const request = deferred();
		let signal: AbortSignal | undefined;
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: (params) => {
				signal = params.signal;
				return request.promise;
			},
		});
		cancelPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		expect(signal?.aborted).toBe(true);
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))).toBeUndefined();

		// A late response for a cancelled task is ignored.
		request.resolve({ text: "late" });
		await flush();
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))).toBeUndefined();
	});
});

describe("subscriptions", () => {
	test("listeners are told about every state change", async () => {
		let notifications = 0;
		const unsubscribe = subscribePromptOptimizeTasks(() => notifications++);
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		const afterStart = notifications;
		request.resolve({ text: "optimized" });
		await flush();
		expect(afterStart).toBeGreaterThan(0);
		expect(notifications).toBeGreaterThan(afterStart);
		unsubscribe();
	});

	test("unsubscribing stops the notifications", async () => {
		let notifications = 0;
		const unsubscribe = subscribePromptOptimizeTasks(() => notifications++);
		unsubscribe();
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		expect(notifications).toBe(0);
	});
});

describe("delivery claims", () => {
	test("only one surface can claim a result", async () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.resolve({ text: "optimized" });
		await flush();
		const task = getPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		// The inline composer and the fullscreen view share this task; the first
		// claim wins so the text is applied once, not twice.
		expect(claimPromptOptimizeDelivery(task?.key ?? "", task?.requestId ?? "")).toBe(true);
		expect(claimPromptOptimizeDelivery(task?.key ?? "", task?.requestId ?? "")).toBe(false);
	});

	test("releasing a surface hands the claim back so another view can deliver", async () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		request.resolve({ text: "optimized" });
		await flush();
		const key = promptOptimizeTaskKey("n1");
		const task = getPromptOptimizeTask(key);
		expect(claimPromptOptimizeDelivery(key, task?.requestId ?? "")).toBe(true);

		// The fullscreen view closes while the request is done but undelivered.
		releasePromptOptimizeSurface(key);
		// The result is still there for the inline composer…
		expect(getPromptOptimizeTask(key)?.status).toBe("succeeded");
		// …and it is claimable again.
		expect(claimPromptOptimizeDelivery(key, task?.requestId ?? "")).toBe(true);
	});

	test("releasing a surface does not touch a running request", () => {
		const request = deferred();
		startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		const key = promptOptimizeTaskKey("n1");
		releasePromptOptimizeSurface(key);
		// Closing a view is not cancelling the work.
		expect(getPromptOptimizeTask(key)?.status).toBe("running");
	});
});

describe("direct state transitions", () => {
	test("finishTask ignores a superseded request id", () => {
		const request = deferred();
		const requestId = startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		finishTask(promptOptimizeTaskKey("n1"), `${requestId}-stale`, { resultText: "x" });
		expect(getPromptOptimizeTask(promptOptimizeTaskKey("n1"))?.status).toBe("running");
	});

	test("failTask records the message against the right narrator", () => {
		const request = deferred();
		const requestId = startPromptOptimizeTask({
			narratorId: "n1",
			text: "draft",
			style: "clarify",
			withContext: false,
			request: () => request.promise,
		});
		failTask(promptOptimizeTaskKey("n1"), requestId, "nope");
		const task = getPromptOptimizeTask(promptOptimizeTaskKey("n1"));
		expect(task?.status).toBe("failed");
		expect(task?.error).toBe("nope");
	});
});
