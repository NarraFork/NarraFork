import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";

if (isMainThread || !parentPort) throw new Error("Fixture must run on a native worker thread");
const port = parentPort;
const behavior = workerData.behavior as string;
const keepAlive = setInterval(() => {}, 1_000);
port.on("message", async (command) => {
	if (command.kind === "start" && command.opts) {
		if (behavior === "run-failure" || behavior === "snapshot-success") {
			await writeFile(command.opts.savePath, "private fixture bytes");
			port.postMessage(
				behavior === "run-failure"
					? { kind: "failed", stage: "capture" }
					: { kind: "done", fileSize: 21 },
			);
		}
	}
	if (command.kind === "start" && command.request) {
		await writeFile(join(command.request.dir, "private.raw"), "private fixture bytes");
		port.postMessage({
			kind: "recording",
			profileId: command.request.profileId,
			startedAt: new Date().toISOString(),
			browserVersion: "Chrome/123.0",
			warnings: [],
		});
		if (behavior === "crash")
			setTimeout(() => {
				throw new Error("private-worker-error-canary");
			}, 20);
	}
	if (
		(command.kind === "cancel" || command.kind === "stop") &&
		command.profileId &&
		behavior !== "no-ack"
	) {
		// Deliberately omit traceStopped: thread exit cannot prove Chrome tracing stopped.
		port.postMessage({ kind: "cancelled", profileId: command.profileId, stage: "cancelled" });
	}
	if (command.kind === "fixture-close") {
		clearInterval(keepAlive);
		port.close();
	}
});
if (behavior !== "no-ready") port.postMessage({ kind: "ready" });
