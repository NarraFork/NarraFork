import type { Worker } from "node:worker_threads";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { logger } from "../logger";
import type { JsonPacketPart } from "./request-json-worker";

// These are scheduling/IPC budgets, never limits on the total request size.
const PACKET_CHARS = 64 * 1024;
const PACKET_PARTS = 512;
const SMALL_CHARS = 32 * 1024;
const SMALL_NODES = 256;
let workerPromise: Promise<Worker> | undefined;
let queue: Promise<void> = Promise.resolve();
let idle: ReturnType<typeof setTimeout> | undefined;

async function requestWorker(): Promise<Worker> {
	if (!workerPromise) {
		const pending = connectCompiledWorker(
			compiledWorkerSpecifiers(
				"lib/agent/request-json-worker.ts",
				"./request-json-worker.ts",
				import.meta.url,
			),
		).then(({ worker }) => {
			worker.on("error", () => {});
			worker.on("exit", () => {
				if (workerPromise === pending) workerPromise = undefined;
			});
			worker.unref();
			return worker;
		});
		workerPromise = pending;
		pending.catch(() => {
			if (workerPromise === pending) workerPromise = undefined;
		});
	}
	return workerPromise;
}

/** One bounded packet at a time, shared across callers; queue waiting does not consume a timeout. */
function escapePacket(parts: JsonPacketPart[], signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	clearTimeout(idle);
	return new Promise<string>((resolve, reject) => {
		let finished = false;
		const abort = () => {
			finished = true;
			reject(signal?.reason);
		};
		signal?.addEventListener("abort", abort, { once: true });
		const execute = async () => {
			if (finished) return;
			try {
				const worker = await requestWorker();
				if (finished) return;
				const text = await new Promise<string>((accept, fail) => {
					const cleanup = () => {
						clearTimeout(timer);
						worker.off("message", receive);
						worker.off("error", failWorker);
						worker.off("exit", failWorker);
					};
					const receive = (response: { text?: string; error?: string }) => {
						cleanup();
						if (typeof response.text === "string") accept(response.text);
						else fail(new Error(response.error ?? "Request JSON worker failed"));
					};
					const failWorker = () => {
						cleanup();
						fail(new Error("Request JSON worker exited"));
					};
					const timer = setTimeout(() => {
						cleanup();
						void worker.terminate();
						fail(new Error("Request JSON packet timed out"));
					}, 30_000);
					worker.once("message", receive);
					worker.once("error", failWorker);
					worker.once("exit", failWorker);
					try {
						worker.postMessage({ parts });
					} catch (error) {
						cleanup();
						fail(error);
					}
				});
				if (!finished) resolve(text);
			} catch (error) {
				if (!finished) reject(error);
			} finally {
				finished = true;
				signal?.removeEventListener("abort", abort);
			}
		};
		queue = queue.then(execute, execute);
		const admitted = queue;
		void admitted.then(() => {
			if (queue !== admitted) return;
			idle = setTimeout(() => {
				const previous = workerPromise;
				workerPromise = undefined;
				void previous?.then((worker) => worker.terminate()).catch(() => {});
			}, 30_000);
			idle.unref();
		});
	});
}

/** Bounded inspection, without first serializing or copying a large request. */
function isSmall(value: unknown): boolean {
	let nodes = 0;
	let chars = 0;
	const seen = new Set<object>();
	const visit = (item: unknown): boolean => {
		if (++nodes > SMALL_NODES) return false;
		if (typeof item === "string") {
			chars += item.length;
			return chars <= SMALL_CHARS;
		}
		if (!item || typeof item !== "object") return true;
		if (seen.has(item) || typeof (item as { toJSON?: unknown }).toJSON === "function") return false;
		seen.add(item);
		for (const key in item) {
			if (!Object.hasOwn(item, key)) continue;
			chars += key.length;
			if (chars > SMALL_CHARS || !visit((item as Record<string, unknown>)[key])) return false;
		}
		seen.delete(item);
		return true;
	};
	return visit(value);
}

/** Only the walker runs on the event loop; large strings are escaped in bounded worker packets. */
async function stringifyLarge(value: unknown, signal?: AbortSignal): Promise<string> {
	const output: string[] = [];
	let packet: JsonPacketPart[] = [];
	let chars = 0;
	let work = 0;
	const ancestors = new Set<object>();
	const flush = async () => {
		if (!packet.length) return;
		const next = packet;
		packet = [];
		chars = 0;
		output.push(await escapePacket(next, signal));
		// Explicitly yield between packets, including when the worker/cache is warm.
		await Bun.sleep(0);
		signal?.throwIfAborted();
	};
	const emit = async (part: JsonPacketPart) => {
		signal?.throwIfAborted();
		const size = typeof part === "string" ? part.length : part.text.length;
		if (packet.length && chars + size > PACKET_CHARS) await flush();
		packet.push(part);
		chars += size;
		if (chars >= PACKET_CHARS || packet.length >= PACKET_PARTS) await flush();
	};
	const quoted = async (text: string) => {
		await emit('"');
		for (let start = 0; start < text.length; ) {
			let end = Math.min(text.length, start + PACKET_CHARS);
			// Do not split a surrogate pair: JSON.stringify would escape the detached halves.
			const last = text.charCodeAt(end - 1);
			if (end < text.length && last >= 0xd800 && last <= 0xdbff) end--;
			await emit({ text: text.slice(start, end) });
			start = end;
		}
		await emit('"');
	};
	const jsonValue = (item: unknown, key: string): unknown => {
		if (
			item &&
			typeof item === "object" &&
			typeof (item as { toJSON?: unknown }).toJSON === "function"
		)
			return (item as { toJSON: (key: string) => unknown }).toJSON(key);
		return item;
	};
	const omitted = (item: unknown) =>
		item === undefined || typeof item === "function" || typeof item === "symbol";
	const walk = async (item: unknown): Promise<void> => {
		signal?.throwIfAborted();
		if (++work % PACKET_PARTS === 0) await Bun.sleep(0);
		if (typeof item === "string") return quoted(item);
		if (typeof item !== "object" || item === null) {
			await emit(JSON.stringify(item) ?? "null");
			return;
		}
		if (ancestors.has(item)) throw new TypeError("Converting circular structure to JSON");
		ancestors.add(item);
		await emit(Array.isArray(item) ? "[" : "{");
		let count = 0;
		if (Array.isArray(item)) {
			for (let i = 0; i < item.length; i++) {
				if (count++) await emit(",");
				const child = jsonValue(item[i], String(i));
				await walk(omitted(child) ? null : child);
			}
		} else {
			for (const key in item) {
				if (!Object.hasOwn(item, key)) continue;
				const child = jsonValue((item as Record<string, unknown>)[key], key);
				if (omitted(child)) continue;
				if (count++) await emit(",");
				await quoted(key);
				await emit(":");
				await walk(child);
			}
		}
		await emit(Array.isArray(item) ? "]" : "}");
		ancestors.delete(item);
	};
	await walk(jsonValue(value, ""));
	await flush();
	signal?.throwIfAborted();
	return output.join("");
}

/**
 * One encoder per built request, reused only for strip-and-retry. Nested fields must
 * not mutate during those retries; replacing/deleting a root field is supported.
 * Large tools/history fragments are reused without another traversal/serialization.
 */
export function createRequestBodyEncoder() {
	const fragments = new Map<string, { value: unknown; text: string }>();
	let large = false;
	return async (body: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
		signal?.throwIfAborted();
		if (!large && isSmall(body)) return JSON.stringify(body);
		large = true;
		const started = performance.now();
		const parts: string[] = [];
		for (const key of Object.keys(body)) {
			const value = body[key];
			if (value === undefined || typeof value === "function" || typeof value === "symbol") continue;
			let fragment = fragments.get(key);
			if (!fragment || fragment.value !== value) {
				fragment = {
					value,
					text: isSmall(value) ? JSON.stringify(value) : await stringifyLarge(value, signal),
				};
				fragments.set(key, fragment);
			}
			parts.push(`${JSON.stringify(key)}:${fragment.text}`);
		}
		signal?.throwIfAborted();
		const text = `{${parts.join(",")}}`;
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 100)
			logger.debug("Large provider request encoded", {
				elapsedMs: Math.round(elapsedMs),
				characters: text.length,
			});
		return text;
	};
}

export async function stringifyRequestBody(
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	return createRequestBodyEncoder()(body, signal);
}
