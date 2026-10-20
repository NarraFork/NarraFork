import { realpath } from "node:fs/promises";
import { normalize } from "node:path";
import { coalesceEvents } from "./event-coalescer";
import { getParcelWatcher } from "./parcel-binding";
import { isIgnoredEventPath } from "./parcel-ignore";
import { FileChangeType, type IFileChange } from "./types";
import type {
	WatchCommand,
	WatcherBackend,
	WatcherParentMessage,
	WatcherWorkerMessage,
	WorkerStageMessage,
} from "./worker-protocol";

const EVENT_AGGREGATE_DELAY = 75;
const THROTTLE_CHUNK_SIZE = 500;
const THROTTLE_DELAY = 200;
const THROTTLE_MAX_BUFFER = 30_000;

const PARCEL_TYPE_MAP: Record<"create" | "update" | "delete", FileChangeType> = {
	create: FileChangeType.ADDED,
	update: FileChangeType.UPDATED,
	delete: FileChangeType.DELETED,
};

function getBackend(): WatcherBackend {
	if (process.platform === "win32") return "windows";
	if (process.platform === "linux") return "inotify";
	return "fs-events";
}

function send(message: WatcherWorkerMessage): void {
	process.stdout.write(`${JSON.stringify(message)}\n`);
}

function log(
	level: "trace" | "warn" | "error" | "info" | "debug",
	message: string,
	data?: Record<string, unknown>,
): void {
	const suffix = data ? ` ${JSON.stringify(data)}` : "";
	process.stderr.write(`[ParcelWatcherWorker] ${level}: ${message}${suffix}\n`);
}

class ThrottledEmitter {
	private buffer: IFileChange[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;
	private _pending = 0;

	get pending(): number {
		return this._pending;
	}

	constructor(
		private readonly maxChunkSize: number,
		private readonly delayMs: number,
		private readonly maxBuffer: number,
		private readonly handler: (events: IFileChange[]) => void,
	) {}

	work(events: IFileChange[]): boolean {
		this.buffer.push(...events);
		this._pending = this.buffer.length;

		if (this.buffer.length > this.maxBuffer) {
			this.buffer = this.buffer.slice(-this.maxBuffer);
			this._pending = this.buffer.length;
			this.scheduleFlush();
			return false;
		}

		this.scheduleFlush();
		return true;
	}

	private scheduleFlush(): void {
		if (this.timer !== undefined) return;
		this.timer = setTimeout(() => this.flush(), this.delayMs);
	}

	flush(): void {
		this.timer = undefined;
		if (this.buffer.length === 0) return;

		const chunk = this.buffer.splice(0, this.maxChunkSize);
		this._pending = this.buffer.length;
		this.handler(chunk);

		if (this.buffer.length > 0) {
			this.scheduleFlush();
		}
	}

	dispose(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buffer.length > 0) {
			this.handler(this.buffer.splice(0));
		}
		this._pending = 0;
	}
}

class RunOnceWorker<T> {
	private buffer: T[] = [];
	private timer: ReturnType<typeof setTimeout> | undefined;

	constructor(
		private readonly handler: (items: T[]) => void,
		private readonly delayMs: number,
	) {}

	work(item: T): void {
		this.buffer.push(item);
		if (this.timer === undefined) {
			this.timer = setTimeout(() => this.flush(), this.delayMs);
		}
	}

	flush(): void {
		if (this.timer !== undefined) {
			clearTimeout(this.timer);
			this.timer = undefined;
		}
		if (this.buffer.length > 0) {
			this.handler(this.buffer.splice(0));
		}
	}

	dispose(): void {
		this.flush();
	}
}

interface WorkerWatchInstance {
	id: string;
	path: string;
	realPath: string;
	realPathDiffers: boolean;
	realPathLength: number;
	ignore: string[];
	subscription: { unsubscribe(): Promise<void> };
	worker: RunOnceWorker<IFileChange>;
	throttledEmitter: ThrottledEmitter;
	stopped: boolean;
}

const instances = new Map<string, WorkerWatchInstance>();
const backend = getBackend();
let starting = 0;
let stopping = 0;

type ObserveStage = (stage: WorkerStageMessage["stage"], error?: unknown) => void;

function observeRequest(command: { requestId: string; id: string }): ObserveStage {
	const started = performance.now();
	let previous = started;
	return (stage, error) => {
		const now = performance.now();
		try {
			send({
				type: "stage",
				requestId: command.requestId,
				watchId: command.id.slice(0, 256),
				stage,
				workerElapsedMs: Math.round(now - started),
				workerStageDurationMs: Math.round(now - previous),
				activeWatches: instances.size,
				starting,
				stopping,
				errorName: error instanceof Error ? error.name.slice(0, 80) : undefined,
				errorMessage: error === undefined ? undefined : String(error).slice(0, 256),
			});
		} catch {
			// Diagnostics must never replace the subscription's result.
		}
		previous = now;
	};
}

async function normalizeWatchPath(path: string): Promise<{
	realPath: string;
	realPathDiffers: boolean;
	realPathLength: number;
}> {
	let realPath = path;
	let realPathDiffers = false;
	let realPathLength = path.length;

	try {
		realPath = await realpath(path);
		if (path !== realPath) {
			realPathDiffers = true;
			realPathLength = realPath.length;
			log("debug", "corrected watch path to realpath", { original: path, realPath });
		}
	} catch (error) {
		log("debug", "realpath failed; watching original path", { path, error: String(error) });
	}

	return { realPath, realPathDiffers, realPathLength };
}

function normalizeEventPath(eventPath: string, instance: WorkerWatchInstance): string {
	let path = eventPath;

	if (process.platform === "darwin") {
		path = path.normalize("NFC");
	}

	if (process.platform === "win32" && instance.path.length <= 3) {
		path = normalize(path);
	}

	if (instance.realPathDiffers) {
		path = instance.path + path.slice(instance.realPathLength);
	}

	return path;
}

function handleAggregatedEvents(instance: WorkerWatchInstance, rawEvents: IFileChange[]): void {
	if (instance.stopped || rawEvents.length === 0) return;

	const coalesced = coalesceEvents(rawEvents);
	if (coalesced.length === 0) return;

	const worked = instance.throttledEmitter.work(coalesced);
	if (!worked) {
		log("warn", "event buffer overflow; some events dropped", {
			path: instance.path,
			pending: instance.throttledEmitter.pending,
		});
	}
}

async function startWatch(command: WatchCommand, observe: ObserveStage): Promise<void> {
	if (instances.has(command.id)) {
		observe("ack_send");
		send({ type: "watch_ack", requestId: command.requestId, id: command.id });
		return;
	}

	const { realPath, realPathDiffers, realPathLength } = await normalizeWatchPath(command.path);
	observe("canonicalize_end");
	observe("binding_start");
	const parcelWatcher = await getParcelWatcher();
	observe("binding_end");

	let instance: WorkerWatchInstance | undefined;
	const worker = new RunOnceWorker<IFileChange>((events) => {
		if (instance) handleAggregatedEvents(instance, events);
	}, EVENT_AGGREGATE_DELAY);
	const throttledEmitter = new ThrottledEmitter(
		THROTTLE_CHUNK_SIZE,
		THROTTLE_DELAY,
		THROTTLE_MAX_BUFFER,
		(events) => {
			if (!instance || instance.stopped || events.length === 0) return;
			send({ type: "events", id: instance.id, path: instance.path, events });
		},
	);

	observe("subscribe_start");
	const subscription = await parcelWatcher.subscribe(
		realPath,
		(error, parcelEvents) => {
			if (!instance || instance.stopped) return;
			if (error) {
				send({ type: "error", id: command.id, error: String(error) });
				return;
			}

			for (const event of parcelEvents) {
				const type = PARCEL_TYPE_MAP[event.type];
				if (type === undefined) continue;
				const path = normalizeEventPath(event.path, instance);
				if (isIgnoredEventPath(instance.path, path)) continue;
				worker.work({ type, path });
			}
		},
		{ backend, ignore: command.ignore },
	);

	observe("subscribe_end");
	instance = {
		id: command.id,
		path: command.path,
		realPath,
		realPathDiffers,
		realPathLength,
		ignore: command.ignore,
		subscription,
		worker,
		throttledEmitter,
		stopped: false,
	};
	instances.set(command.id, instance);

	log("debug", "started native watch", { path: command.path, realPath, backend });
	observe("ack_send");
	send({ type: "watch_ack", requestId: command.requestId, id: command.id });
}

async function stopWatch(id: string, observe?: ObserveStage): Promise<void> {
	const instance = instances.get(id);
	if (!instance) return;
	instances.delete(id);
	instance.stopped = true;
	instance.worker.dispose();
	instance.throttledEmitter.dispose();
	try {
		observe?.("unsubscribe_start");
		await instance.subscription.unsubscribe();
		observe?.("unsubscribe_end");
	} catch (error) {
		observe?.("unsubscribe_error", error);
		log("debug", "unsubscribe failed", { id, error: String(error) });
	}
}

async function handleMessage(message: WatcherParentMessage): Promise<void> {
	switch (message.type) {
		case "watch": {
			starting++;
			const observe = observeRequest(message);
			observe("received");
			try {
				await startWatch(message, observe);
			} catch (error) {
				send({
					type: "error",
					requestId: message.requestId,
					id: message.id,
					error: String(error),
					errorName: error instanceof Error ? error.name.slice(0, 80) : undefined,
				});
			} finally {
				starting--;
			}
			break;
		}
		case "unwatch": {
			stopping++;
			const observe = observeRequest(message);
			observe("received");
			try {
				await stopWatch(message.id, observe);
				observe("ack_send");
				send({ type: "unwatch_ack", requestId: message.requestId, id: message.id });
			} finally {
				stopping--;
			}
			break;
		}
		case "ping":
			send({ type: "pong", requestId: message.requestId });
			break;
		case "shutdown":
			await shutdown();
			process.exit(0);
	}
}

async function shutdown(): Promise<void> {
	const stops: Promise<void>[] = [];
	for (const id of instances.keys()) {
		stops.push(stopWatch(id));
	}
	await Promise.allSettled(stops);
}

let inputBuffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	inputBuffer += chunk;
	let newlineIndex = inputBuffer.indexOf("\n");
	while (newlineIndex >= 0) {
		const line = inputBuffer.slice(0, newlineIndex).trim();
		inputBuffer = inputBuffer.slice(newlineIndex + 1);
		if (line) {
			try {
				const message = JSON.parse(line) as WatcherParentMessage;
				void handleMessage(message);
			} catch (error) {
				send({ type: "error", error: `invalid worker command: ${String(error)}` });
			}
		}
		newlineIndex = inputBuffer.indexOf("\n");
	}
});
process.stdin.on("end", () => {
	void shutdown().finally(() => process.exit(0));
});

process.on("uncaughtException", (error) => {
	send({ type: "error", error: String(error), fatal: true });
	process.exit(1);
});
process.on("unhandledRejection", (error) => {
	send({ type: "error", error: String(error), fatal: true });
	process.exit(1);
});
process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});
process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});

send({ type: "ready", pid: process.pid, backend });
log("debug", "worker ready", { pid: process.pid, backend });
