import { expect, test } from "bun:test";
import { EditorWorkerRuntime } from "./editor-text.worker";
import { type EditorTextSnapshot, encodeEditorSnapshot } from "./editor-worker-client";
import {
	EDITOR_WORKER_LIMITS as L,
	metadataSize,
	type WorkerRequest,
} from "./editor-worker-protocol";

function snapshot(text: string): EditorTextSnapshot {
	let offset = 0;
	return {
		revision: 1,
		alternativeVersionId: 1,
		length: text.length,
		read: () => {
			if (offset === text.length) return null;
			const chunk = text.slice(offset, offset + L.chunkBytes / 2);
			offset += chunk.length;
			return chunk;
		},
	};
}

test("pool never exceeds two workers/two queued jobs and cancels queued readers without consuming them", async () => {
	const Original = globalThis.Worker;
	let alive = 0;
	let peak = 0;
	class StalledWorker extends EventTarget {
		private stopped = false;
		constructor() {
			super();
			alive++;
			peak = Math.max(peak, alive);
		}
		postMessage() {}
		terminate() {
			if (!this.stopped) {
				this.stopped = true;
				alive--;
			}
		}
	}
	globalThis.Worker = StalledWorker as unknown as typeof Worker;
	const controllers = Array.from({ length: 5 }, () => new AbortController());
	let queuedRead = false;
	try {
		const tasks = controllers.map((controller, index) =>
			encodeEditorSnapshot(
				index === 2
					? {
							...snapshot("a"),
							read: () => {
								queuedRead = true;
								return null;
							},
						}
					: snapshot("a"),
				controller.signal,
			).then(
				() => "resolved",
				(error: Error) => error.message,
			),
		);
		expect(await tasks[4]).toBe("EDITOR_WORKER_BUSY");
		expect(peak).toBe(2);
		expect(alive).toBe(2);
		expect(queuedRead).toBe(false);
		for (const controller of controllers) controller.abort();
		await Promise.all(tasks);
		expect(alive).toBe(0);
		expect(queuedRead).toBe(false);
	} finally {
		for (const controller of controllers) controller.abort();
		globalThis.Worker = Original;
	}
});

test("snapshot transport respects 64KiB body, 16KiB metadata and four ACK windows in both directions", async () => {
	const Original = globalThis.Worker;
	let inFlight = 0;
	let peak = 0;
	let bodyMessages = 0;
	let inputSent = 0;
	let inputAcked = 0;
	let refilledBeforeFourthAck = false;
	class Transport extends EventTarget {
		private runtime = new EditorWorkerRuntime();
		private serial = Promise.resolve();
		constructor() {
			super();
			queueMicrotask(() =>
				this.dispatchEvent(
					new MessageEvent("message", {
						data: { type: "ready", docId: "$worker", revision: 0, jobId: "$startup", seq: 0 },
					}),
				),
			);
		}
		postMessage(message: WorkerRequest) {
			expect(
				metadataSize(message.type === "chunk" ? { ...message, data: undefined } : message),
			).toBeLessThanOrEqual(L.metadataBytes);
			const body = message.type === "chunk" || message.type === "output";
			if (message.type === "chunk") {
				expect(message.data.byteLength).toBeLessThanOrEqual(L.chunkBytes);
				inputSent++;
				if (inputSent === 5 && inputAcked < 4) refilledBeforeFourthAck = true;
			}
			if (body) {
				bodyMessages++;
				inFlight++;
				peak = Math.max(peak, inFlight);
			}
			this.serial = this.serial.then(async () => {
				const response = await this.runtime.handle(message);
				await new Promise<void>((resolve) => setTimeout(resolve, 1));
				if (body) inFlight--;
				if (message.type === "chunk") inputAcked++;
				this.dispatchEvent(new MessageEvent("message", { data: response }));
			});
		}
		terminate() {}
	}
	globalThis.Worker = Transport as unknown as typeof Worker;
	try {
		const value = `${"x".repeat(300000)}😀中`;
		const result = await encodeEditorSnapshot(snapshot(value));
		expect(await result.text()).toBe(value);
		expect(bodyMessages).toBeGreaterThan(8);
		expect(peak).toBe(4);
		expect(refilledBeforeFourthAck).toBe(true);
		expect(inFlight).toBe(0);
	} finally {
		globalThis.Worker = Original;
	}
});
