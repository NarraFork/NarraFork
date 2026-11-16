import { compiledWorkerSpecifiers, connectCompiledWorker } from "../compiled-worker";
import { hotSafe } from "../hot-safe";
import { logger } from "../logger";
import { type PoolWorker, WorkerPool, type WorkerTaskContext } from "../worker-runtime/pool";
import type { JsonPacketPart } from "./request-json-worker";

// These are scheduling/IPC budgets, never limits on the total request size.
const PACKET_CHARS = 64 * 1024;
const PACKET_PARTS = 512;
const SMALL_CHARS = 32 * 1024;
const SMALL_NODES = 256;
function createPacketPool() {
	return new WorkerPool<JsonPacketPart[], string>({
		concurrency: 1,
		maxQueued: 32,
		maxQueuedBytes: 64 * 1024 * 1024,
		idleTimeoutMs: 30_000,
		create: requestWorker,
	});
}

const packetOwner = hotSafe("narrafork.requestJson.workers.v1", () => ({
	pool: createPacketPool(),
	closed: false,
}));

function assertOpen(): void {
	if (packetOwner.closed) throw new Error("Request JSON workers are closed");
}

/** Permanent production latch, including the small-value and cached encoder paths. */
export function closeRequestJsonWorkers(): Promise<void> {
	packetOwner.closed = true;
	return packetOwner.pool.close(new Error("Request JSON workers are closed"));
}

export async function resetRequestJsonWorkersForTests(): Promise<void> {
	await closeRequestJsonWorkers();
	packetOwner.pool = createPacketPool();
	packetOwner.closed = false;
}

async function requestWorker(
	context: WorkerTaskContext,
): Promise<PoolWorker<JsonPacketPart[], string>> {
	const { worker, handle } = await connectCompiledWorker(
		compiledWorkerSpecifiers(
			"lib/agent/request-json-worker.ts",
			"./request-json-worker.ts",
			import.meta.url,
		),
		{
			signal: context.signal,
			deadlineAt: Math.min(Date.now() + 5_000, context.deadlineAt),
		},
	);
	worker.unref();
	return {
		get closed() {
			return handle.closed;
		},
		close: () => handle.close(),
		run: (parts, { requestId, signal }) =>
			new Promise<string>((accept, fail) => {
				let finished = false;
				const finish = (text?: string, error?: unknown, stop = false) => {
					if (finished) return;
					finished = true;
					clearTimeout(timer);
					worker.off("message", receive);
					worker.off("error", failWorker);
					worker.off("messageerror", failWorker);
					worker.off("exit", failWorker);
					signal.removeEventListener("abort", abort);
					if (text !== undefined) accept(text);
					else if (stop) void handle.close().then(() => fail(error), fail);
					else fail(error);
				};
				const invalid = () =>
					finish(undefined, new Error("Invalid request JSON worker response"), true);
				const receive = (response: unknown) => {
					if (
						response &&
						typeof response === "object" &&
						!Array.isArray(response) &&
						"ready" in response &&
						response.ready === true &&
						!("requestId" in response)
					)
						return;
					if (
						!response ||
						typeof response !== "object" ||
						Array.isArray(response) ||
						!("requestId" in response) ||
						typeof response.requestId !== "string" ||
						!response.requestId
					) {
						invalid();
						return;
					}
					// A stale frame cannot consume this packet's listener or computation budget.
					if (response.requestId !== requestId) return;
					if ("text" in response && typeof response.text === "string" && !("error" in response))
						finish(response.text);
					else if (
						"error" in response &&
						typeof response.error === "string" &&
						!("text" in response)
					)
						finish(undefined, new Error(response.error));
					else invalid();
				};
				const failWorker = () => finish(undefined, new Error("Request JSON worker exited"), true);
				const abort = () => finish(undefined, signal.reason, true);
				// Queue waiting and readiness never consume this existing per-packet budget.
				const timer = setTimeout(
					() => finish(undefined, new Error("Request JSON packet timed out"), true),
					30_000,
				);
				worker.on("message", receive);
				worker.once("error", failWorker);
				worker.once("messageerror", failWorker);
				worker.once("exit", failWorker);
				signal.addEventListener("abort", abort, { once: true });
				if (signal.aborted) abort();
				else {
					try {
						worker.postMessage({ requestId, parts });
					} catch (error) {
						finish(undefined, error, true);
					}
				}
			}),
	};
}

/** Bounded packet admission; no request-wide deadline and no unbounded Promise tail. */
function escapePacket(
	parts: JsonPacketPart[],
	bytes: number,
	signal?: AbortSignal,
): Promise<string> {
	assertOpen();
	return packetOwner.pool.run(parts, { signal, bytes, deadlineAt: Infinity });
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
async function stringifyLarge(
	value: unknown,
	signal?: AbortSignal,
	transform?: (value: unknown) => unknown,
): Promise<string> {
	const output: string[] = [];
	let packet: JsonPacketPart[] = [];
	let chars = 0;
	let work = 0;
	const ancestors = new Set<object>();
	const flush = async () => {
		if (!packet.length) return;
		const next = packet;
		// UTF-16 storage plus bounded node overhead, accumulated during the existing walker.
		const bytes = chars * 2 + packet.length * 64;
		packet = [];
		chars = 0;
		output.push(await escapePacket(next, bytes, signal));
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
		if (transform) item = transform(item);
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
	assertOpen();
	return output.join("");
}

/**
 * One encoder per built request, reused only for strip-and-retry. Nested fields must
 * not mutate during those retries; replacing/deleting a root field is supported.
 * Large tools/history fragments are reused without another traversal/serialization.
 */
export function createRequestBodyEncoder(transform?: (value: unknown) => unknown) {
	assertOpen();
	// The optional transform is shallow and pure: apply it during bounded traversal,
	// without first cloning the whole body. Native stringify is only used on small values.
	const replacer = transform ? (_key: string, value: unknown) => transform(value) : undefined;
	const fragments = new Map<string, { value: unknown; text: string }>();
	let large = false;
	return async (body: Record<string, unknown>, signal?: AbortSignal): Promise<string> => {
		assertOpen();
		signal?.throwIfAborted();
		if (!large && isSmall(body)) return JSON.stringify(body, replacer);
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
					text: isSmall(value)
						? JSON.stringify(value, replacer)
						: await stringifyLarge(value, signal, transform),
				};
				fragments.set(key, fragment);
			}
			parts.push(`${JSON.stringify(key)}:${fragment.text}`);
		}
		signal?.throwIfAborted();
		assertOpen();
		const text = `{${parts.join(",")}}`;
		const elapsedMs = performance.now() - started;
		if (elapsedMs > 100) {
			try {
				logger.debug("Large provider request encoded", {
					elapsedMs: Math.round(elapsedMs),
					characters: text.length,
				});
			} catch {
				// Encoding has completed; an observational sink cannot replace its result.
			}
		}
		return text;
	};
}

export async function stringifyRequestBody(
	body: Record<string, unknown>,
	signal?: AbortSignal,
): Promise<string> {
	return createRequestBodyEncoder()(body, signal);
}
