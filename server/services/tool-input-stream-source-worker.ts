import {
	TEXT_DOCUMENT_PACKET_BYTES,
	TEXT_DOCUMENT_PAGE_CHARS,
} from "@shared/pretext-layout/text-document";
import { connectCompiledWorker } from "../lib/compiled-worker";
import { AppError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../lib/worker-runtime/pool";
import { TaskQueueError } from "../lib/worker-runtime/queue";
import type { HistoricalWriteDocumentIdentity } from "./tool-input-stream-source";

/** Total SQLite input size, never a per-packet or main-thread allocation budget. */
export const HISTORICAL_WRITE_INPUT_MAX_BYTES = 1024 * 1024 * 1024;
type ChunkSink = (text: string, offset: number) => Promise<void>;
interface HistoricalRead {
	databasePath: string;
	identity: HistoricalWriteDocumentIdentity;
	sink: ChunkSink;
}
function unavailable(code = "TEXT_DOCUMENT_WORKER_FAILED", status = 503) {
	return new AppError("Text document source unavailable", status, code);
}

// Trusted constant eval source retains the compiled-Bun path without adding another bundle entry.
const PROGRAM = `
const { parentPort } = require("node:worker_threads");
const { Database } = require("bun:sqlite");
const fail = (code) => { const error = new Error(code); error.documentCode = code; throw error; };
let started = false;
parentPort.on("message", async (message) => {
 if (message && message.action === "ping") { parentPort.postMessage({ ready: true }); return; }
 if (!message || message.action !== "read" || started) return;
 started = true;
 const data = message.data;
 let database;
 try {
  const identity = data.identity;
  database = new Database(data.databasePath, { readonly: true });
  database.run("PRAGMA busy_timeout = 0");
  const bindings = [identity.toolCallId, identity.messageId, identity.toolUseId, identity.narratorId, identity.executionAttempt];
  const where = "id = ? AND message_id = ? AND tool_use_id = ? AND narrator_id = ? AND execution_attempt = ? AND tool_name = 'Write'";
  const metadata = database.query("SELECT octet_length(input_json) AS bytes FROM narrator_tool_calls WHERE " + where + " LIMIT 1").get(...bindings);
  if (!metadata) fail("TEXT_DOCUMENT_NOT_FOUND");
  if (metadata.bytes > data.maxInputBytes) fail("TEXT_DOCUMENT_WORKER_INPUT_LIMIT");
  let row = database.query("SELECT input_json FROM narrator_tool_calls WHERE " + where + " LIMIT 1").get(...bindings);
  if (!row) fail("TEXT_DOCUMENT_NOT_FOUND");
  database.close(); database = undefined;
  let input = JSON.parse(row.input_json); row = undefined;
  const text = input && input.content; input = undefined;
  if (typeof text !== "string") fail("TEXT_DOCUMENT_NOT_WRITE_CONTENT");
  for (let offset = 0; offset < text.length; offset += data.pageChars) {
   const delta = text.slice(offset, offset + data.pageChars);
   const ack = new Promise((resolve, reject) => parentPort.once("message", (message) => {
    if (message && message.type === "ack" && message.offset === offset) resolve();
    else reject(new Error("invalid acknowledgement"));
   }));
   parentPort.postMessage({ type: "chunk", offset, text: delta });
   await ack;
  }
  parentPort.postMessage({ type: "done", length: text.length });
 } catch (error) {
  const code = error && typeof error.documentCode === "string" ? error.documentCode : "TEXT_DOCUMENT_WORKER_FAILED";
  parentPort.postMessage({ type: "error", code });
 } finally { if (database) database.close(); parentPort.close(); }
});
`;

async function createSession(
	context: WorkerTaskContext,
): Promise<PoolWorker<HistoricalRead, void>> {
	const { worker, handle } = await connectCompiledWorker([PROGRAM], {
		signal: context.signal,
		deadlineAt: Math.min(Date.now() + 5000, context.deadlineAt),
		workerOptions: { eval: true },
	});
	return {
		get closed() {
			return handle.closed;
		},
		close: () => handle.close(),
		run: async (request) => {
			let offset = 0;
			let inFlight = false;
			let settled = false;
			let receive!: (message: unknown) => void;
			let fail!: () => void;
			try {
				await new Promise<void>((resolve, reject) => {
					const refuse = (error: unknown) => {
						if (settled) return;
						settled = true;
						reject(error);
					};
					fail = () => refuse(unavailable());
					receive = (message) => {
						if (settled) return;
						if (!message || typeof message !== "object")
							return refuse(unavailable("TEXT_DOCUMENT_WORKER_PROTOCOL"));
						if ("ready" in message) return;
						const packet = message as {
							type?: string;
							offset?: number;
							text?: string;
							length?: number;
							code?: string;
						};
						if (packet.type === "chunk") {
							if (
								inFlight ||
								typeof packet.text !== "string" ||
								packet.text.length > TEXT_DOCUMENT_PAGE_CHARS ||
								packet.offset !== offset ||
								Buffer.byteLength(JSON.stringify(packet)) > TEXT_DOCUMENT_PACKET_BYTES
							)
								return refuse(unavailable("TEXT_DOCUMENT_WORKER_PROTOCOL"));
							const start = offset;
							const text = packet.text;
							inFlight = true;
							// A completion RPC is not the end of a stream: exactly one page is owned until sink ACK.
							void Promise.resolve()
								.then(() => request.sink(text, start))
								.then(() => {
									if (settled || handle.closed) return;
									offset += text.length;
									inFlight = false;
									worker.postMessage({ type: "ack", offset: start });
								})
								.catch(refuse);
						} else if (packet.type === "done" && !inFlight && packet.length === offset) {
							settled = true;
							resolve();
						} else if (packet.type === "error") {
							const code =
								typeof packet.code === "string" && packet.code.startsWith("TEXT_DOCUMENT_")
									? packet.code
									: "TEXT_DOCUMENT_WORKER_FAILED";
							refuse(unavailable(code, code === "TEXT_DOCUMENT_NOT_FOUND" ? 404 : 503));
						} else refuse(unavailable("TEXT_DOCUMENT_WORKER_PROTOCOL"));
					};
					worker.on("message", receive);
					worker.once("error", fail);
					worker.once("messageerror", fail);
					worker.once("exit", fail);
					try {
						worker.postMessage({
							action: "read",
							data: {
								databasePath: request.databasePath,
								identity: request.identity,
								maxInputBytes: HISTORICAL_WRITE_INPUT_MAX_BYTES,
								pageChars: TEXT_DOCUMENT_PAGE_CHARS,
							},
						});
					} catch {
						fail();
					}
				});
			} finally {
				settled = true;
				worker.off("message", receive);
				worker.off("error", fail);
				worker.off("messageerror", fail);
				worker.off("exit", fail);
			}
		},
	};
}

/** A stream owns its one-shot worker until done/error/cancel AND observed actual exit. */
export class HistoricalWriteWorkerRuntime {
	private pool?: WorkerPool<HistoricalRead, void>;
	private closed = false;

	async stream(
		databasePath: string,
		identity: HistoricalWriteDocumentIdentity,
		sink: ChunkSink,
		signal: AbortSignal,
		timeoutMs: number,
	): Promise<void> {
		signal.throwIfAborted();
		if (this.closed) throw unavailable("TEXT_DOCUMENT_HISTORY_CLOSED");
		this.pool ??= new WorkerPool({
			concurrency: 1,
			maxQueued: 15,
			maxQueuedBytes: 256 * 1024,
			reuse: false,
			create: createSession,
		});
		try {
			await this.pool.run(
				{ databasePath, identity, sink },
				{
					signal,
					// Preserve the original read watchdog (including stalled ACK), never a 1GiB IPC budget.
					deadlineAt: Date.now() + timeoutMs,
					bytes:
						(databasePath.length +
							Object.values(identity).reduce<number>(
								(size, value) => size + (typeof value === "string" ? value.length : 8),
								0,
							)) *
						2,
				},
			);
		} catch (error) {
			if (error instanceof TaskQueueError) {
				if (error.code === "TASK_QUEUE_TIMEOUT")
					throw unavailable("TEXT_DOCUMENT_READ_TIMEOUT", 408);
				if (error.code === "TASK_QUEUE_FULL")
					throw unavailable("TEXT_DOCUMENT_HISTORY_QUEUE_LIMIT", 429);
			}
			throw error;
		}
	}

	close(): Promise<void> {
		this.closed = true;
		return this.pool?.close(unavailable("TEXT_DOCUMENT_HISTORY_CLOSED")) ?? Promise.resolve();
	}
}

const owner = hotSafe("narrafork.historicalWrite.workers.v1", () => ({
	version: 1,
	runtime: undefined as HistoricalWriteWorkerRuntime | undefined,
	closed: false,
}));
if (owner.version !== 1)
	throw new Error(
		"Historical Write worker ownership predates this runtime; manually restart NarraFork",
	);

export function streamHistoricalWriteContent(
	databasePath: string,
	identity: HistoricalWriteDocumentIdentity,
	sink: ChunkSink,
	signal: AbortSignal,
	timeoutMs = 10_000,
): Promise<void> {
	if (owner.closed) return Promise.reject(unavailable("TEXT_DOCUMENT_HISTORY_CLOSED"));
	owner.runtime ??= new HistoricalWriteWorkerRuntime();
	return owner.runtime.stream(databasePath, identity, sink, signal, timeoutMs);
}

export function closeHistoricalWriteWorkers(): Promise<void> {
	owner.closed = true;
	return owner.runtime?.close() ?? Promise.resolve();
}
