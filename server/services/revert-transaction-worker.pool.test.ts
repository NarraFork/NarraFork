import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { Worker } from "node:worker_threads";
import { logger } from "../lib/logger";
import { WorkerHandle } from "../lib/worker-runtime/lifecycle";
import type { WorkerTaskTiming } from "../lib/worker-runtime/pool";
import type { RevertSelectionResult } from "./revert-selection-service";
import type { TransactionManifestRequest } from "./revert-transaction-manifest-worker";
import {
	closeRevertManifestWorkers,
	getRevertManifestWorkerStats,
	resetRevertManifestWorkersForTests,
	runRevertManifestWorker,
	warmRevertManifestWorker,
} from "./revert-transaction-worker";

const selection = { metadataDigest: "fixed" } as RevertSelectionResult;
const input: TransactionManifestRequest = {
	action: "compare",
	fixed: selection,
	current: selection,
};
const thread = WorkerHandle.thread;
const originalPost = Worker.prototype.postMessage;
let handles: WorkerHandle<Worker>[];
let create: ReturnType<typeof spyOn<typeof WorkerHandle, "thread">>;
let post: ReturnType<typeof spyOn<typeof Worker.prototype, "postMessage">> | undefined;

beforeEach(async () => {
	await resetRevertManifestWorkersForTests();
	handles = [];
	create = spyOn(WorkerHandle, "thread").mockImplementation((...args) => {
		const handle = thread(...args);
		handles.push(handle);
		return handle;
	});
});
afterEach(async () => {
	await closeRevertManifestWorkers();
	post?.mockRestore();
	post = undefined;
	create.mockRestore();
});

async function failure(pending: Promise<unknown>) {
	try {
		await pending;
	} catch (error) {
		return error;
	}
	throw new Error("Expected manifest refusal");
}
async function until(check: () => boolean) {
	const deadline = Date.now() + 2_000;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Manifest test condition timed out");
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}
function holdDispatches() {
	const packets: { worker: Worker; packet: unknown }[] = [];
	post = spyOn(Worker.prototype, "postMessage").mockImplementation(function (
		this: Worker,
		...args: Parameters<Worker["postMessage"]>
	) {
		packets.push({ worker: this, packet: args[0] });
	});
	return packets;
}
const run = (signal = AbortSignal.timeout(5_000)) =>
	runRevertManifestWorker<boolean>(input, signal);

describe("production manifest pool uses real native threads", () => {
	test("warmup sends no payload; successes and validation refusals reuse one thread without caching", async () => {
		const timings: WorkerTaskTiming[] = [];
		const timingLog = spyOn(logger, "info").mockImplementation((message, fields) => {
			if (message === "Revert manifest worker timing") {
				timings.push(fields as unknown as WorkerTaskTiming);
			}
		});
		try {
			post = spyOn(Worker.prototype, "postMessage");
			await warmRevertManifestWorker();
			expect(create).toHaveBeenCalledTimes(1);
			expect(post).not.toHaveBeenCalled();
			expect(await run()).toBe(true);
			const changed = { ...input, current: { ...selection, metadataDigest: "changed" } };
			expect(
				await failure(runRevertManifestWorker(changed, AbortSignal.timeout(5_000))),
			).toMatchObject({ code: "REVERT_TRANSACTION_SELECTION_STALE" });
			expect(await run()).toBe(true);
			expect(create).toHaveBeenCalledTimes(1);
			expect(post).toHaveBeenCalledTimes(3);
			const ids = post.mock.calls.map(([packet]) => (packet as { requestId: string }).requestId);
			expect(new Set(ids).size).toBe(3);
			expect(getRevertManifestWorkerStats()).toMatchObject({
				workers: 1,
				idle: 1,
				created: 1,
				reused: 3,
			});
			for (const value of Object.values(getRevertManifestWorkerStats()))
				expect(["number", "boolean"]).toContain(typeof value);
			expect(input.fixed.metadataDigest).toBe("fixed");
			const cold = timings.filter((timing) => timing.kind === "warmup");
			const warm = timings.filter((timing) => timing.kind === "task");
			expect(cold).toHaveLength(1);
			expect(cold[0].reused).toBe(false);
			expect(warm).toHaveLength(3);
			expect(warm.every((timing) => timing.reused)).toBe(true);
			for (const timing of timings) {
				for (const elapsed of [timing.queueMs, timing.readyMs, timing.execMs, timing.closeMs]) {
					expect(Number.isFinite(elapsed)).toBe(true);
					expect(elapsed).toBeGreaterThanOrEqual(0);
				}
			}
			// Observe latency, but decide reuse by native creation/dispatch counts above, not time.
			console.info("MANIFEST_REUSE_SAMPLE", {
				created: create.mock.calls.length,
				dispatched: post.mock.calls.length,
				coldReadyMs: cold[0].readyMs,
				warmReadyMeanMs: warm.reduce((sum, timing) => sum + timing.readyMs, 0) / warm.length,
				warmExecMeanMs: warm.reduce((sum, timing) => sum + timing.execMs, 0) / warm.length,
			});
		} finally {
			timingLog.mockRestore();
		}
	});

	test("stale success and error frames cannot settle the next task on the same thread", async () => {
		await warmRevertManifestWorker();
		expect(await run()).toBe(true);
		const packets = holdDispatches();
		let finished = false;
		const pending = run().then((value) => {
			finished = true;
			return value;
		});
		await until(() => packets.length === 1);
		const held = packets[0];
		held.worker.emit("message", { requestId: "previous-task", value: false });
		held.worker.emit("message", { requestId: "previous-task", error: "SELECTION_STALE" });
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(finished).toBe(false);
		originalPost.call(held.worker, held.packet);
		expect(await pending).toBe(true);
		expect(create).toHaveBeenCalledTimes(1);
		expect(packets).toHaveLength(1);
	});

	test("two threads and eight waiters are bounded; cancelling a queued task never dispatches it", async () => {
		const packets = holdDispatches();
		const controllers = Array.from({ length: 10 }, () => new AbortController());
		const pending = controllers.map((controller) =>
			run(controller.signal).then(
				(value) => ({ value }),
				(error: unknown) => ({ error }),
			),
		);
		await until(() => packets.length === 2);
		expect(getRevertManifestWorkerStats()).toMatchObject({ active: 2, queued: 8, workers: 2 });
		expect(create).toHaveBeenCalledTimes(2);
		expect(await failure(run())).toMatchObject({ code: "REVERT_TRANSACTION_BUSY" });
		controllers[2].abort();
		expect(await pending[2]).toMatchObject({
			error: { code: "REVERT_TRANSACTION_MANIFEST_CANCELLED" },
		});
		expect(getRevertManifestWorkerStats().queued).toBe(7);
		for (let index = 0; index < 9; index++) {
			await until(() => packets.length > index);
			originalPost.call(packets[index].worker, packets[index].packet);
		}
		const results = await Promise.all(pending);
		expect(results.filter((result) => "value" in result)).toHaveLength(9);
		expect(packets).toHaveLength(9);
		expect(create).toHaveBeenCalledTimes(2);
		expect(getRevertManifestWorkerStats()).toMatchObject({ active: 0, queued: 0, idle: 2 });
	});

	test("cancelled slots cannot be replaced until their native exits release capacity", async () => {
		const releases: (() => void)[] = [];
		create.mockImplementation((...args) => {
			const actual = thread(...args);
			const gate = new Promise<void>((resolve) => releases.push(resolve));
			const handle = new WorkerHandle(actual.resource, actual.exited, async () => {
				await gate;
				await actual.close();
			});
			handles.push(handle);
			return handle;
		});
		const packets = holdDispatches();
		const controllers = [new AbortController(), new AbortController()];
		const pending = controllers.map((controller) => failure(run(controller.signal)));
		try {
			await until(() => packets.length === 2);
			for (const controller of controllers) controller.abort();
			await until(() => getRevertManifestWorkerStats().retiring === 2);
			const next = run();
			void next.catch(() => {});
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(create).toHaveBeenCalledTimes(2);
			expect(packets).toHaveLength(2);
			expect(handles.every((handle) => handle.resource.threadId !== -1)).toBe(true);
			releases[0]();
			await handles[0].exited;
			// Only the exited slot is reusable; the other old native resource is still counted.
			await until(() => packets.length === 3);
			expect(create).toHaveBeenCalledTimes(3);
			expect(handles[0].resource.threadId).toBe(-1);
			expect(handles[1].resource.threadId).not.toBe(-1);
			expect(handles.filter((handle) => handle.resource.threadId !== -1)).toHaveLength(2);
			let settled = false;
			void next
				.finally(() => {
					settled = true;
				})
				.catch(() => {});
			const current = packets[2].packet as { requestId: string };
			handles[1].resource.emit("message", { requestId: current.requestId, value: true });
			await new Promise((resolve) => setTimeout(resolve, 0));
			expect(settled).toBe(false);
			releases[1]();
			await handles[1].exited;
			originalPost.call(packets[2].worker, packets[2].packet);
			expect(await next).toBe(true);
			releases[1]();
			expect(await Promise.all(pending)).toMatchObject([
				{ code: "REVERT_TRANSACTION_MANIFEST_CANCELLED" },
				{ code: "REVERT_TRANSACTION_MANIFEST_CANCELLED" },
			]);
		} finally {
			for (const release of releases) release();
		}
	});

	test("ten-minute idle expiry retires native workers and close/reset await actual exits", async () => {
		const timer = globalThis.setTimeout;
		const expiries: (() => void)[] = [];
		const controlled = Object.assign(
			(handler: (...args: unknown[]) => void, delay?: number, ...args: unknown[]) => {
				if (delay === 10 * 60_000) expiries.push(() => handler(...args));
				return timer(handler, delay, ...args);
			},
			{ __promisify__: timer.__promisify__ },
		);
		const clock = spyOn(globalThis, "setTimeout").mockImplementation(controlled as typeof timer);
		try {
			await warmRevertManifestWorker();
			expect(expiries).toHaveLength(1);
			expiries[0]();
			await handles[0].exited;
			await until(() => getRevertManifestWorkerStats().workers === 0);
			expect(await run()).toBe(true);
			const latest = handles[1];
			await closeRevertManifestWorkers();
			expect(latest.resource.threadId).toBe(-1);
			expect(await latest.exited).toBeNumber();
			expect(await failure(run())).toMatchObject({
				code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED",
			});
			expect(create).toHaveBeenCalledTimes(2);
			await resetRevertManifestWorkersForTests();
			expect(await run()).toBe(true);
			expect(create).toHaveBeenCalledTimes(3);
		} finally {
			clock.mockRestore();
		}
	});

	test("reset closes its existing native worker before rebuilding; closed warmup dispatches nothing", async () => {
		await warmRevertManifestWorker();
		const previous = handles[0];
		await resetRevertManifestWorkersForTests();
		expect(previous.resource.threadId).toBe(-1);
		expect(getRevertManifestWorkerStats()).toMatchObject({ closed: false, workers: 0, created: 0 });
		expect(await run()).toBe(true);
		await closeRevertManifestWorkers();
		post = spyOn(Worker.prototype, "postMessage");
		await failure(warmRevertManifestWorker());
		expect(await failure(run())).toMatchObject({
			code: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED",
		});
		expect(create).toHaveBeenCalledTimes(2);
		expect(post).not.toHaveBeenCalled();
		expect(handles.every((handle) => handle.resource.threadId === -1)).toBe(true);
	});

	for (const mode of ["crash", "cancel", "deadline", "close"] as const) {
		test(`${mode} retires a real worker without replay or inline success`, async () => {
			await warmRevertManifestWorker();
			const packets = holdDispatches();
			const controller = new AbortController();
			const pending = failure(
				runRevertManifestWorker(
					input,
					controller.signal,
					mode === "deadline" ? { deadlineAt: Date.now() + 100 } : undefined,
				),
			);
			await until(() => packets.length === 1);
			if (mode === "crash") handles[0].resource.emit("error", new Error("injected native failure"));
			if (mode === "cancel") controller.abort();
			if (mode === "close") await closeRevertManifestWorkers();
			const error = await pending;
			expect(error).toMatchObject({
				code:
					mode === "cancel"
						? "REVERT_TRANSACTION_MANIFEST_CANCELLED"
						: mode === "deadline"
							? "REVERT_TRANSACTION_MANIFEST_WORKER_TIMEOUT"
							: "REVERT_TRANSACTION_MANIFEST_WORKER_FAILED",
			});
			await handles[0].exited;
			expect(packets).toHaveLength(1);
			expect(create).toHaveBeenCalledTimes(1);
			expect(handles[0].resource.threadId).toBe(-1);
		});
	}
});
