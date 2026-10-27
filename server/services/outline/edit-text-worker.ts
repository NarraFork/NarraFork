/**
 * Worker entry for `edit-text.ts`: parses and rewrites the text of OutlineEdit calls off the
 * main thread. One job at a time; the client (`edit-text-runner.ts`) bounds the input, times a
 * job out and replaces the worker when one hangs.
 */
import { parentPort } from "node:worker_threads";
import { type EditTextJob, runEditTextJob } from "./edit-text";

export type EditTextWorkerRequest =
	| { action: "ping" }
	| { action: "run"; id: number; job: EditTextJob };

parentPort?.on("message", (message: EditTextWorkerRequest) => {
	if (message.action === "ping") {
		parentPort?.postMessage({ ready: true });
		return;
	}
	try {
		parentPort?.postMessage({ id: message.id, result: runEditTextJob(message.job) });
	} catch (error) {
		parentPort?.postMessage({
			id: message.id,
			error: error instanceof Error ? error.message : String(error),
		});
	}
});
