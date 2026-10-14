import type { Worker } from "node:worker_threads";
import { AppError } from "../../lib/errors";
import { legacySyncDisabledError, trackedLegacyProjectSync } from "../project-db-sync-coordinator";
import type { LegacySyncWorkerRequest } from "./legacy-sync-worker";
import { PROJECT_ARCHIVE_LIMITS as LIMITS } from "./limits";
import { startPrivateArchiveWorker } from "./worker-client";

export async function exportLegacyProjectOnWorker(
	request: Omit<LegacySyncWorkerRequest, "cancellation">,
	signal: AbortSignal = new AbortController().signal,
): Promise<{ tables: Record<string, number> }> {
	const result = await trackedLegacyProjectSync(request.projectId, (stop) =>
		exportLegacyProjectOnWorkerImpl(request, AbortSignal.any([signal, stop])),
	);
	if (!result) throw legacySyncDisabledError();
	return result;
}

async function terminateWriter(worker: Worker): Promise<void> {
	if (worker.threadId === -1) return;
	let finishExit = () => {};
	const exited = new Promise<void>((resolveExit) => {
		finishExit = resolveExit;
	});
	worker.once("exit", finishExit);
	try {
		await worker.terminate();
	} catch (error) {
		// A failed terminate request is not proof that the writer stopped. Remain tracked
		// until actual exit; disable may truthfully time out in the meantime.
		await exited;
		throw error;
	} finally {
		worker.removeListener("exit", finishExit);
	}
}

let workers = 0;
/** Fixed queue cap; only narrow metadata crosses the thread boundary. */
async function exportLegacyProjectOnWorkerImpl(
	request: Omit<LegacySyncWorkerRequest, "cancellation">,
	signal: AbortSignal = new AbortController().signal,
): Promise<{ tables: Record<string, number> }> {
	signal.throwIfAborted();
	if (workers >= 2) throw new Error("Project backup worker queue full");
	workers++;
	const cancellation = new SharedArrayBuffer(4);
	let activeWorker: Worker | undefined;
	let timeout: ReturnType<typeof setTimeout> | undefined;
	let force: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	try {
		const worker = await startPrivateArchiveWorker("legacy-sync", signal, request.deadline);
		activeWorker = worker;
		return await new Promise((resolve, reject) => {
			abort = () => {
				Atomics.store(new Int32Array(cancellation), 0, 1);
				force ??= setTimeout(
					() => reject(new Error("Project backup cancelled or timed out")),
					1000,
				);
			};
			signal.addEventListener("abort", abort, { once: true });
			timeout = setTimeout(
				abort,
				Math.max(1, Math.min(LIMITS.jobMs, request.deadline - Date.now())),
			);
			worker.once(
				"message",
				(message: {
					value?: { tables: Record<string, number> };
					error?: string;
					code?: string;
				}) => {
					if (message.code === "PROJECT_ARCHIVE_FORBIDDEN") {
						reject(
							new AppError(
								"Project archive closure requires narrator owner/admin authority",
								403,
								"PROJECT_ARCHIVE_FORBIDDEN",
							),
						);
						return;
					}
					if (message.error || !message.value)
						reject(new Error("Project backup validation or operation failed"));
					else resolve(message.value);
				},
			);
			worker.once("error", () => reject(new Error("Project backup worker failed")));
			worker.once("exit", () => reject(new Error("Project backup worker exited")));
			worker.postMessage({ ...request, cancellation });
			if (signal.aborted) abort();
		});
	} finally {
		clearTimeout(timeout);
		clearTimeout(force);
		signal.removeEventListener("abort", abort);
		try {
			if (activeWorker) await terminateWriter(activeWorker);
		} finally {
			workers--;
		}
	}
}
