import { Worker } from "node:worker_threads";
import type { FileChangeBlobRef } from "../../shared/file-change-protocol";
import type { CurrentBaselineRequest, CurrentGitBaseline } from "./git-current-baseline-worker";

export type {
	CurrentFileBaseline,
	CurrentGitBaseline,
	GitObjectVersion,
} from "./git-current-baseline-worker";

let workers = 0;
/** No unbounded queue of expensive per-panel scans. Callers disclose busy as unknown. */
async function worker<T>(request: CurrentBaselineRequest, signal: AbortSignal): Promise<T> {
	signal.throwIfAborted();
	if (workers >= 2) throw new Error("reader_busy");
	workers++;
	let thread: Worker | undefined;
	let abort = () => {};
	let forcedTermination: ReturnType<typeof setTimeout> | undefined;
	try {
		const active = new Worker(new URL("./git-current-baseline-worker.ts", import.meta.url));
		thread = active;
		return await new Promise<T>((resolve, reject) => {
			abort = () => {
				// Let the worker abort its currently owned Git child and close file handles
				// before termination. Never signal the server or an unrelated process.
				active.postMessage({ action: "cancel" });
				forcedTermination = setTimeout(() => reject(new Error("cancelled")), 1000);
			};
			signal.addEventListener("abort", abort, { once: true });
			active.once("message", (message: { value: T; error?: string }) => {
				if (signal.aborted) reject(new Error("cancelled"));
				else if (message.error) reject(new Error(message.error));
				else resolve(message.value);
			});
			active.once("error", reject);
			active.once("exit", () => reject(new Error("reader_exited")));
			active.postMessage(request);
			if (signal.aborted) abort();
		});
	} finally {
		if (forcedTermination) clearTimeout(forcedTermination);
		signal.removeEventListener("abort", abort);
		try {
			await thread?.terminate();
		} finally {
			workers--;
		}
	}
}

/** Separately injectable for deterministic races; defaults always use the real worker. */
export const gitCurrentBaselineReader = {
	snapshot(
		workspacePath: string,
		filePaths: string[] | undefined,
		privateRoot: string,
		signal: AbortSignal,
	): Promise<CurrentGitBaseline> {
		return worker({ action: "snapshot", workspacePath, filePaths, privateRoot }, signal);
	},
	verifyBlobs(
		refs: FileChangeBlobRef[],
		privateRoot: string,
		signal: AbortSignal,
	): Promise<string[]> {
		return worker({ action: "verify_blobs", refs, privateRoot }, signal);
	},
};
