import { parentPort, workerData } from "node:worker_threads";

const port = parentPort;
if (!port) throw new Error("Worker fixture only");
const state = new Int32Array(workerData.state);
const mode = workerData.mode as string;
let child: ReturnType<typeof Bun.spawn> | undefined;
port.on("message", async (message) => {
	if (message.action === "ping") {
		Atomics.store(state, 0, 1);
		if (mode !== "not-ready") port.postMessage({ ready: true });
		return;
	}
	if (message.action === "cancel") {
		Atomics.add(state, 2, 1);
		if (child) {
			child.kill("SIGKILL");
			await child.exited;
		}
		if (mode === "cleanup") {
			await Bun.sleep(30);
			Atomics.store(state, 3, 1);
			port.postMessage({ error: "cancelled" });
		}
		return;
	}
	Atomics.add(state, 1, 1);
	if (mode === "crash") throw new Error("injected worker crash");
	if (mode === "invalid") port.postMessage("invalid primitive packet");
	if (mode === "cleanup") {
		child = Bun.spawn([process.execPath, "-e", "setInterval(() => {}, 1000)"], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
		});
		Atomics.store(state, 4, child.pid);
	}
	if (mode === "ok")
		port.postMessage({
			value:
				message.action === "verify_blobs"
					? []
					: {
							files: [
								{ path: "one", unstagedLinesAdded: 2, unstagedLinesRemoved: 0, complete: true },
							],
							complete: true,
							readFiles: 1,
						},
		});
});
