import { parentPort, workerData } from "node:worker_threads";
import type { RecorderMessage } from "../request-recorder-protocol";

const options = workerData as {
	mode?: "not-ready" | "crash" | "stall";
	readyDelay?: number;
	endDelay?: number;
	archiveDelay?: number;
	flushDelay?: number;
	archive?: { path: string; bytes: number };
};
if (options.mode !== "not-ready")
	setTimeout(() => parentPort?.postMessage({ ready: true }), options.readyDelay ?? 0);
parentPort?.on("message", (message: RecorderMessage | { cancel: number }) => {
	if ("cancel" in message) return;
	if (message.op.type === "chunk") {
		if (options.mode === "crash") throw new Error("fixture transport failed: private body/path");
		if (options.mode === "stall") return;
	}
	const delay =
		message.op.type === "end"
			? (options.endDelay ?? 0)
			: message.op.type === "archive"
				? (options.archiveDelay ?? 0)
				: message.op.type === "flush"
					? (options.flushDelay ?? 0)
					: 0;
	setTimeout(
		() =>
			parentPort?.postMessage({
				id: message.id,
				value: message.op.type === "archive" && options.archive ? options.archive : { ok: true },
			}),
		delay,
	);
});
