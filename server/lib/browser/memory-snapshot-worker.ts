import { parentPort } from "node:worker_threads";
import { connect } from "puppeteer-core";
import {
	boundedCleanup,
	SnapshotError,
	type SnapshotIO,
	type SnapshotStage,
	SnapshotStream,
} from "./memory-snapshot-stream";

export interface SnapshotRequest {
	wsEndpoint: string;
	targetId: string;
	savePath: string;
	maxBytes: number;
	timeoutMs: number;
	collectGarbage: boolean;
}
export interface SnapshotConnection {
	session: {
		send(
			method:
				| "HeapProfiler.enable"
				| "HeapProfiler.collectGarbage"
				| "HeapProfiler.takeHeapSnapshot",
		): Promise<unknown>;
		on(
			event: "HeapProfiler.addHeapSnapshotChunk",
			listener: (value: { chunk: string }) => void,
		): unknown;
		off(
			event: "HeapProfiler.addHeapSnapshotChunk",
			listener: (value: { chunk: string }) => void,
		): unknown;
		detach(): Promise<void>;
	};
	disconnect(): Promise<void>;
}

/** Attach using the exact CDP identity; URL/title are never target selectors. */
export async function connectSnapshotTarget(
	opts: SnapshotRequest,
	connector: typeof connect = connect,
): Promise<SnapshotConnection> {
	const browser = await connector({
		browserWSEndpoint: opts.wsEndpoint,
		protocolTimeout: opts.timeoutMs,
		defaultViewport: null,
	});
	try {
		const root = await browser.target().createCDPSession();
		try {
			const connection = root.connection();
			if (!connection) throw new SnapshotError("target");
			const { sessionId } = await connection.send("Target.attachToTarget", {
				targetId: opts.targetId,
				flatten: true,
			});
			const session = connection.session(sessionId);
			if (!session) throw new SnapshotError("target");
			const { targetInfo } = await session.send("Target.getTargetInfo");
			if (targetInfo.targetId !== opts.targetId) throw new SnapshotError("target");
			return { session, disconnect: () => browser.disconnect() };
		} finally {
			await boundedCleanup(() => root.detach());
		}
	} catch {
		await boundedCleanup(() => browser.disconnect());
		throw new SnapshotError("target");
	}
}

export async function runSnapshot(
	opts: SnapshotRequest,
	signal: AbortSignal,
	dependencies: { connect?: typeof connectSnapshotTarget; io?: SnapshotIO } = {},
): Promise<{ fileSize: number }> {
	let stage: SnapshotStage = "connect";
	let connection: SnapshotConnection | undefined;
	let stopped = false;
	let rejectFailure: (error: SnapshotError) => void = () => {};
	const failure = new Promise<never>((_, reject) => {
		rejectFailure = reject;
	});
	const abort = () => rejectFailure(new SnapshotError("cancelled"));
	const timer = setTimeout(() => rejectFailure(new SnapshotError("timeout")), opts.timeoutMs);
	const stream = new SnapshotStream(opts.savePath, opts.maxBytes, rejectFailure, dependencies.io);
	const chunk = (value: { chunk: string }) => stream.push(value.chunk);
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const work = async () => {
		connection = await (dependencies.connect ?? connectSnapshotTarget)(opts);
		// A connection that completes after cancellation must also be disconnected.
		if (stopped) {
			await boundedCleanup(() => connection?.disconnect() ?? Promise.resolve());
			throw new SnapshotError("cancelled");
		}
		stage = "write";
		await stream.start();
		if (stopped) throw new SnapshotError("cancelled");
		stage = "capture";
		connection.session.on("HeapProfiler.addHeapSnapshotChunk", chunk);
		await connection.session.send("HeapProfiler.enable");
		if (stopped || signal.aborted) throw new SnapshotError("cancelled");
		if (opts.collectGarbage) await connection.session.send("HeapProfiler.collectGarbage");
		if (stopped || signal.aborted) throw new SnapshotError("cancelled");
		await connection.session.send("HeapProfiler.takeHeapSnapshot");
		if (stopped || signal.aborted) throw new SnapshotError("cancelled");
		stage = "finalize";
		return stream.finish();
	};
	let success = false;
	try {
		const result = await Promise.race([work(), failure]);
		success = true;
		return result;
	} catch (error) {
		throw error instanceof SnapshotError ? error : new SnapshotError(stage);
	} finally {
		stopped = true;
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		connection?.session.off("HeapProfiler.addHeapSnapshotChunk", chunk);
		if (!success) await boundedCleanup(() => stream.cleanup());
		if (connection) {
			await boundedCleanup(() => connection?.session.detach() ?? Promise.resolve());
			await boundedCleanup(() => connection?.disconnect() ?? Promise.resolve());
		}
	}
}

if (parentPort) {
	const port = parentPort;
	const controller = new AbortController();
	let started = false;
	port.on("message", (message: { kind: "start"; opts: SnapshotRequest } | { kind: "cancel" }) => {
		if (message.kind === "cancel") {
			controller.abort();
			return;
		}
		if (started) return;
		started = true;
		void runSnapshot(message.opts, controller.signal).then(
			(result) => {
				port.postMessage({ kind: "done", ...result });
				port.close();
			},
			(error) => {
				port.postMessage({
					kind: "failed",
					stage: error instanceof SnapshotError ? error.stage : "worker",
				});
				port.close();
			},
		);
	});
	port.postMessage({ kind: "ready" });
}
