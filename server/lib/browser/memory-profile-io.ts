import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { MemoryProfileError, PROFILE_LIMITS } from "./memory-profile-constants";

export function checkProfileAbort(signal: AbortSignal): void {
	if (signal.aborted) throw new MemoryProfileError("cancelled");
}

/** Every wait is bounded; caller owns cancellation and must check it before side effects. */
export async function profileDeadline<T>(
	work: () => Promise<T>,
	timeoutMs: number,
	stage: string,
	signal?: AbortSignal,
): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	let abort = () => {};
	const boundary = new Promise<never>((_, reject) => {
		abort = () => reject(new MemoryProfileError("cancelled"));
		timer = setTimeout(() => reject(new MemoryProfileError(stage)), timeoutMs);
		signal?.addEventListener("abort", abort, { once: true });
		if (signal?.aborted) abort();
	});
	try {
		if (signal?.aborted) throw new MemoryProfileError("cancelled");
		return await Promise.race([work(), boundary]);
	} finally {
		clearTimeout(timer);
		signal?.removeEventListener("abort", abort);
	}
}

export async function writeProfileJson(
	path: string,
	value: unknown,
	maxBytes: number,
	signal: AbortSignal,
): Promise<number> {
	checkProfileAbort(signal);
	const json = JSON.stringify(value);
	const size = Buffer.byteLength(json);
	if (size > maxBytes) throw new MemoryProfileError("artifact_limit");
	const temporary = `${path}.partial`;
	const file = await open(temporary, "wx", 0o600);
	let closed = false;
	let published = false;
	try {
		checkProfileAbort(signal);
		await file.writeFile(json);
		checkProfileAbort(signal);
		await file.close();
		closed = true;
		checkProfileAbort(signal);
		await rename(temporary, path);
		published = true;
		checkProfileAbort(signal);
		return size;
	} finally {
		if (!closed) await file.close().catch(() => {});
		if (!published) await rm(temporary, { force: true });
		if (published && signal.aborted) await rm(path, { force: true });
	}
}

export interface TraceReader {
	read(
		handle: string,
		size: number,
	): Promise<{ data: string; eof: boolean; base64Encoded?: boolean }>;
	close(handle: string): Promise<unknown>;
}

/** One 64KiB request / awaited disk write at a time; no accumulating trace buffer. */
export async function downloadProfileTrace(
	reader: TraceReader,
	handle: string,
	path: string,
	maxBytes: number,
	signal: AbortSignal,
): Promise<number> {
	let total = 0;
	let file: Awaited<ReturnType<typeof open>> | undefined;
	try {
		checkProfileAbort(signal);
		file = await open(path, "wx", 0o600);
		while (true) {
			checkProfileAbort(signal);
			const chunk = await reader.read(handle, PROFILE_LIMITS.traceReadBytes);
			checkProfileAbort(signal);
			// Bound the encoded source before decoding, as well as decoded disk bytes.
			if (Buffer.byteLength(chunk.data) > PROFILE_LIMITS.traceReadBytes * 2) {
				throw new MemoryProfileError("trace_limit");
			}
			const bytes = Buffer.from(chunk.data, chunk.base64Encoded ? "base64" : "utf8");
			if (bytes.length > PROFILE_LIMITS.traceReadBytes || total + bytes.length > maxBytes) {
				throw new MemoryProfileError("trace_limit");
			}
			if (!chunk.eof && bytes.length === 0) throw new MemoryProfileError("trace_read");
			await file.writeFile(bytes);
			total += bytes.length;
			if (chunk.eof) break;
		}
		checkProfileAbort(signal);
		return total;
	} finally {
		await Promise.allSettled([
			file?.close() ?? Promise.resolve(),
			profileDeadline(() => reader.close(handle), PROFILE_LIMITS.cleanupTimeoutMs, "cleanup"),
		]);
		// A late open/read can settle after the recorder's outer cleanup already ran.
		if (signal.aborted) await rm(path, { force: true });
	}
}

export async function createProfileDirectory(dir: string): Promise<void> {
	await mkdir(dir, { recursive: true, mode: 0o700 });
}

export async function profileFileSize(path: string): Promise<number> {
	const info = await stat(path);
	if (!info.isFile()) throw new MemoryProfileError("artifact");
	return info.size;
}

/** Fixed names only: never recursively remove an unchecked path supplied over the port. */
export async function removeProfileFiles(dir: string): Promise<void> {
	await Promise.all(
		[
			"raw.trace.json",
			"allocation.heapprofile",
			"allocation.heapprofile.partial",
			"gc.trace.json",
			"gc.trace.json.partial",
			"summary.json",
			"summary.json.partial",
		].map((name) => rm(join(dir, name), { force: true })),
	);
}
