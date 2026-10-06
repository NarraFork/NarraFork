import type { Worker } from "node:worker_threads";
import { AppError } from "../../lib/errors";
import type { LegacySyncWorkerRequest } from "./legacy-sync-worker";
import { PROJECT_ARCHIVE_LIMITS as LIMITS } from "./limits";
import { startPrivateArchiveWorker } from "./worker-client";

let workers = 0;
/** Fixed queue cap; only narrow metadata crosses the thread boundary. */
export async function exportLegacyProjectOnWorker(
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
		await activeWorker?.terminate();
		workers--;
	}
}
