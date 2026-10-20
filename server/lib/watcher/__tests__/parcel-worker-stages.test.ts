import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { WatcherWorkerMessage, WorkerStageMessage } from "../worker-protocol";

// Controlled binding promises exercise the real worker's concurrent command handling.
// This is fault injection, not a reproduction of a native Parcel/OS failure.
test("worker stages expose overlapping unsubscribe/subscribe and stay independent of event volume", async () => {
	const root = await mkdtemp(join(tmpdir(), "nf-watcher-stages-"));
	const binding = new URL("../parcel-binding.ts", import.meta.url).pathname;
	const worker = new URL("../parcel-watcher-worker.ts", import.meta.url).pathname;
	const script = `
		import { mock } from "bun:test";
		let releaseStop;
		let callback;
		let input = "";
		process.stdin.on("data", chunk => {
			input += chunk.toString();
			let end;
			while ((end = input.indexOf("\\n")) >= 0) {
				const command = JSON.parse(input.slice(0, end));
				input = input.slice(end + 1);
				if (command.type === "release_stop") releaseStop?.();
				if (command.type === "emit_events") callback?.(null,
					Array.from({ length: 1000 }, (_, i) => ({ type: "update", path: command.path + "/file-" + i })));
			}
		});
		mock.module(${JSON.stringify(binding)}, () => ({ getParcelWatcher: async () => ({
			subscribe: async (_path, cb, opts) => {
				if (opts.ignore.includes("controlled-hang")) return new Promise(() => {});
				if (opts.ignore.includes("controlled-error")) throw new TypeError("controlled binding failure");
				callback = cb;
				return { unsubscribe: () => new Promise(resolve => { releaseStop = resolve; }) };
			}
		}) }));
		await import(${JSON.stringify(worker)});
	`;
	const proc = Bun.spawn([process.execPath, "--eval", script], {
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const messages: WatcherWorkerMessage[] = [];
	let outputBytes = 0;
	let failure: Error | undefined;
	let notify = () => {};
	const deadline = setTimeout(() => {
		failure = new Error("isolated worker deadline exceeded");
		proc.kill();
		notify();
	}, 10_000);
	async function read(stream: ReadableStream<Uint8Array>, parse: boolean) {
		const decoder = new TextDecoder();
		let buffer = "";
		for await (const chunk of stream) {
			outputBytes += chunk.byteLength;
			if (outputBytes > 512 * 1024) {
				failure = new Error("isolated worker output exceeded 512KiB");
				proc.kill();
				notify();
				return;
			}
			if (!parse) continue;
			buffer += decoder.decode(chunk, { stream: true });
			let end = buffer.indexOf("\n");
			while (end >= 0) {
				messages.push(JSON.parse(buffer.slice(0, end)) as WatcherWorkerMessage);
				buffer = buffer.slice(end + 1);
				end = buffer.indexOf("\n");
			}
			notify();
		}
	}
	const readers = [read(proc.stdout, true), read(proc.stderr, false)];
	async function waitFor(predicate: () => boolean) {
		while (!predicate()) {
			if (failure) throw failure;
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
		}
	}
	async function send(message: Record<string, unknown>) {
		proc.stdin.write(`${JSON.stringify(message)}\n`);
		await proc.stdin.flush();
	}
	function stages(requestId: string): WorkerStageMessage[] {
		return messages.filter(
			(message): message is WorkerStageMessage =>
				message.type === "stage" && message.requestId === requestId,
		);
	}
	try {
		await waitFor(() => messages.some((message) => message.type === "ready"));
		await send({ type: "watch", requestId: "first", id: root, path: root, ignore: [] });
		await waitFor(() =>
			messages.some((message) => message.type === "watch_ack" && message.requestId === "first"),
		);
		expect(stages("first").map((stage) => stage.stage)).toEqual([
			"received",
			"canonicalize_end",
			"binding_start",
			"binding_end",
			"subscribe_start",
			"subscribe_end",
			"ack_send",
		]);
		await send({ type: "unwatch", requestId: "stop", id: root });
		await waitFor(() => stages("stop").some((stage) => stage.stage === "unsubscribe_start"));
		await send({ type: "watch", requestId: "second", id: root, path: root, ignore: [] });
		await waitFor(() =>
			messages.some((message) => message.type === "watch_ack" && message.requestId === "second"),
		);
		expect(stages("second").find((stage) => stage.stage === "subscribe_start")).toMatchObject({
			starting: 1,
			stopping: 1,
			activeWatches: 0,
		});
		expect(stages("stop").map((stage) => stage.stage)).toEqual(["received", "unsubscribe_start"]);
		await send({ type: "release_stop" });
		await waitFor(() =>
			messages.some((message) => message.type === "unwatch_ack" && message.requestId === "stop"),
		);
		expect(stages("stop").map((stage) => stage.stage)).toEqual([
			"received",
			"unsubscribe_start",
			"unsubscribe_end",
			"ack_send",
		]);
		const stageCount = messages.filter((message) => message.type === "stage").length;
		await send({ type: "emit_events", path: root });
		await waitFor(() => messages.filter((message) => message.type === "events").length >= 2);
		expect(messages.filter((message) => message.type === "stage")).toHaveLength(stageCount);
		for (const message of messages) {
			if (message.type !== "stage") continue;
			expect(message.workerElapsedMs).toBeGreaterThanOrEqual(0);
			expect(message.workerStageDurationMs).toBeGreaterThanOrEqual(0);
			expect(message.watchId).toBe(root);
			expect(JSON.stringify(message).length).toBeLessThan(1024);
		}
		await send({
			type: "watch",
			requestId: "hang",
			id: "hang",
			path: root,
			ignore: ["controlled-hang"],
		});
		await waitFor(() => stages("hang").some((stage) => stage.stage === "subscribe_start"));
		await send({ type: "ping", requestId: "barrier" });
		await waitFor(() =>
			messages.some((message) => message.type === "pong" && message.requestId === "barrier"),
		);
		expect(stages("hang").at(-1)?.stage).toBe("subscribe_start");
		expect(
			messages.some((message) => message.type === "watch_ack" && message.requestId === "hang"),
		).toBe(false);
		await send({
			type: "watch",
			requestId: "error",
			id: "error",
			path: root,
			ignore: ["controlled-error"],
		});
		await waitFor(() =>
			messages.some((message) => message.type === "error" && message.requestId === "error"),
		);
		expect(
			messages.find((message) => message.type === "error" && message.requestId === "error"),
		).toMatchObject({
			errorName: "TypeError",
			error: "TypeError: controlled binding failure",
		});
		expect(stages("error").at(-1)?.stage).toBe("subscribe_start");
	} finally {
		clearTimeout(deadline);
		// Only the test-owned child is stopped; no application instance is touched.
		proc.kill("SIGKILL");
		await proc.exited;
		await Promise.all(readers);
		await rm(root, { recursive: true, force: true });
	}
}, 15_000);
