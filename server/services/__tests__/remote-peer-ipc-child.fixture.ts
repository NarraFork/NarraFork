// Real child process for bounded IPC fault injection. It never imports the NF application.
import { open, unlink } from "node:fs/promises";
import { createInterface } from "node:readline";

let epoch = "";
let lock = "";
let mode = "";
function output(requestId: string, type: string, payload: Record<string, unknown>) {
	process.stdout.write(`${JSON.stringify({ ipcVersion: 2, epoch, requestId, type, payload })}\n`);
}
for await (const line of createInterface({ input: process.stdin })) {
	const message = JSON.parse(line);
	if (message.type === "init") {
		epoch = message.epoch;
		mode = message.payload.config.signalUrl.replace("wss://ipc.fixture/", "test:");
		lock = message.payload.config.statePath;
		if (mode === "test:eof") process.exit(0);
		if (mode === "test:oversize") {
			process.stdout.write("x".repeat(70_000));
			continue;
		}
		if (mode === "test:bad-epoch") epoch = "wrong_epoch";
		const file = await open(lock, "wx", 0o600);
		await file.close();
		output(message.requestId, "ready", { instanceId: "ipc_test", publicKey: "ipc_public" });
	} else if (message.type === "shutdown") {
		await new Promise((resolve) => setTimeout(resolve, 80));
		if (lock) await unlink(lock);
		output(message.requestId, "command.result", { operation: message.type, result: { ok: true } });
		process.exit(0);
	} else if (message.type === "grants.list" && mode === "test:invalid-result") {
		output(message.requestId, "command.result", { operation: message.type, result: null });
	} else {
		output(message.requestId, "command.result", { operation: message.type, result: { ok: true } });
	}
}
