import type { Worker } from "node:worker_threads";
import type { LegacyImportWorkerRequest, LegacyWorkerImportResult } from "./legacy-import-worker";
import { startPrivateArchiveWorker } from "./worker-client";

let workers = 0;
export async function importLegacyProjectOnWorker(
	request: Omit<LegacyImportWorkerRequest, "cancellation">,
	signal: AbortSignal = new AbortController().signal,
): Promise<LegacyWorkerImportResult> {
	signal.throwIfAborted();
	if (workers >= 2) throw new Error("Project import worker queue full");
	workers++;
	const cancellation = new SharedArrayBuffer(4);
	let activeWorker: Worker | undefined;
	let force: ReturnType<typeof setTimeout> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	try {
		const worker = await startPrivateArchiveWorker("legacy-import", signal, request.deadline);
		activeWorker = worker;
		return await new Promise((resolve, reject) => {
			abort = () => {
				Atomics.store(new Int32Array(cancellation), 0, 1);
				force ??= setTimeout(
					() => reject(new Error("Project import cancelled or timed out")),
					1000,
				);
			};
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(abort, Math.max(1, request.deadline - Date.now()));
			worker.once("message", (message: { value?: LegacyWorkerImportResult; error?: string }) => {
				if (message.error || !message.value)
					reject(new Error("Project import validation or operation failed"));
				else resolve(message.value);
			});
			worker.once("error", () => reject(new Error("Project import worker failed")));
			worker.once("exit", () => reject(new Error("Project import worker exited")));
			worker.postMessage({ ...request, cancellation });
			if (signal.aborted) abort();
		});
	} finally {
		clearTimeout(force);
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		await activeWorker?.terminate();
		workers--;
	}
}
