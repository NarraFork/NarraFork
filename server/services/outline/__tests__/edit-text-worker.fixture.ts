import { parentPort, workerData } from "node:worker_threads";
import { runEditTextJob } from "../edit-text";
import type { EditTextWorkerRequest } from "../edit-text-worker";

const mode = (workerData as { mode?: string } | undefined)?.mode ?? "not-ready";
parentPort?.on("message", (message: EditTextWorkerRequest) => {
	if (mode === "not-ready") return;
	if (message.action === "ping") {
		parentPort?.postMessage({ ready: true });
		return;
	}
	if (mode === "hang") return;
	if (mode === "crash") throw new Error("PRIVATE_OUTLINE_TEXT_FAILURE");
	if (mode === "invalid") {
		parentPort?.postMessage({ id: message.id });
		return;
	}
	if (mode === "stale") {
		parentPort?.postMessage({ ready: true });
		parentPort?.postMessage({ id: message.id + 1, result: [] });
	}
	parentPort?.postMessage({ id: message.id, result: runEditTextJob(message.job) });
});
