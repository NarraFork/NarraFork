import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { WorkerCleanupError, type WorkerHandle } from "../worker-runtime/lifecycle";
import { TaskQueue } from "../worker-runtime/queue";
import { isRanking, type ModelTraceOutput, type Ranking, type WorkerReply } from "./protocol";

const ENTRY = "lib/modeltrace/worker.ts";
const TIMEOUT_MS = 5_000;

type Failure = "Disabled" | "StartFailed" | "WorkerFailed";

function failure(reason: Failure): Error {
	return Object.assign(new Error("Local model detector unavailable"), { name: reason });
}

// Deliberately one ephemeral worker and no queue: each worker loads its own detector.
export function makeModelTraceRunner({
	disabled = () => process.env.NARRAFORK_DISABLE_MODELTRACE_WORKER === "1",
	launch = async (signal: AbortSignal, deadlineAt: number): Promise<WorkerHandle<Worker>> => {
		const { handle } = await connectCompiledWorker(
			compiledWorkerSpecifiers(ENTRY, "./worker.ts", import.meta.url),
			{ signal, deadlineAt, sendPing: false },
		);
		return handle;
	},
	timeoutMs = TIMEOUT_MS,
} = {}) {
	const queue = new TaskQueue({ concurrency: 1, maxQueued: 0, timeoutMs });
	return async (outputs: ModelTraceOutput[], signal?: AbortSignal): Promise<Ranking> => {
		signal?.throwIfAborted();
		if (disabled()) throw failure("Disabled");
		const permit = await queue.acquire({ signal });
		let handle: WorkerHandle<Worker>;
		try {
			handle = await launch(permit.signal, permit.deadlineAt);
		} catch (error) {
			if (error instanceof WorkerCleanupError) {
				void error.handle.exited.then(permit.release, () => {});
			} else {
				permit.release();
			}
			permit.signal.throwIfAborted();
			throw failure("StartFailed");
		}
		try {
			return await run(handle.resource, outputs, permit.signal);
		} finally {
			// Release the permit only when the real worker exits, including after a timeout.
			void handle.exited.then(permit.release, () => {});
			void handle.close().catch(() => {});
		}
	};
}

function run(worker: Worker, outputs: ModelTraceOutput[], signal: AbortSignal): Promise<Ranking> {
	return new Promise((resolve, reject) => {
		function clean() {
			worker.off("message", onMessage);
			worker.off("error", onFailure);
			worker.off("messageerror", onFailure);
			worker.off("exit", onFailure);
			signal.removeEventListener("abort", onAbort);
		}
		function onAbort() {
			clean();
			reject(signal.reason);
		}
		function onFailure() {
			clean();
			reject(failure("WorkerFailed"));
		}
		function onMessage(reply: Partial<WorkerReply> | null) {
			if (reply?.type !== "ranked" || !isRanking(reply.ranking)) return onFailure();
			clean();
			const { decision, results } = reply.ranking;
			resolve({
				decision,
				results: results.map(({ model, displayName, probability }) => ({
					model,
					displayName,
					probability,
				})),
			});
		}
		worker.on("message", onMessage);
		worker.on("error", onFailure);
		worker.on("messageerror", onFailure);
		worker.on("exit", onFailure);
		signal.addEventListener("abort", onAbort, { once: true });
		if (signal.aborted) return onAbort();
		try {
			worker.postMessage(outputs.map(({ text, expected_count }) => ({ text, expected_count })));
		} catch {
			onFailure();
		}
	});
}
