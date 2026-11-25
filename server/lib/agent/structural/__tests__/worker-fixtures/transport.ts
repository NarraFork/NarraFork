import { isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread || !parentPort) throw new Error("Fixture requires a worker thread");
const port = parentPort;
port.on("message", (request) => {
	if (request.action === "ping") {
		if (workerData.mode !== "never-ready") port.postMessage({ ready: true });
		return;
	}
	if (workerData.mode === "crash") process.exit(7);
	if (workerData.mode === "hang") {
		Atomics.store(new Int32Array(workerData.started), 0, 1);
		// A blocked native worker must be terminated, not merely sent a cancellation message.
		Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
		return;
	}
	port.postMessage({
		requestId: request.requestId,
		generation: request.generation,
		result: request.task.operation === "verifyGrammar" ? null : "full",
	});
});
