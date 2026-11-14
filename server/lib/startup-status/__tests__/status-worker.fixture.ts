import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("test fixture must run in a worker");
const { mode = "listening", readyDelay = 0 } = workerData as {
	mode?: string;
	readyDelay?: number;
};
port.on("message", async (message) => {
	if (message.action === "ping") {
		if (mode === "never-ready") return;
		if (mode === "exit-before-ready") process.exit(0);
		await Bun.sleep(readyDelay);
		port.postMessage({ ready: true });
		return;
	}
	if (message.type === "listen") {
		// Both control messages used to be mistaken for the listen acknowledgement.
		port.postMessage({ ready: true });
		port.postMessage({ type: "problem-shown" });
		if (mode === "exit") process.exit(0);
		if (mode === "error") throw new Error("fixture listen failure");
		if (mode === "silent" || mode === "control-only") return;
		port.postMessage(
			mode === "unavailable"
				? { type: "unavailable", error: "fixture bind failure" }
				: { type: "listening" },
		);
	}
});
