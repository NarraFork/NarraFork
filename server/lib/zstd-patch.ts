/**
 * Zstd patch generation/application for efficient delta updates.
 *
 * Two application paths exist on purpose:
 * - `applyZstdPatchToFile` is the server path: file-in/file-out, asynchronous, bounded, and
 *   cancellable, so a ~100MB binary never becomes synchronous work on the HTTP event loop.
 * - `applyZstdPatch` is the buffer path kept for release tooling and patch round-trip tests.
 *   It is synchronous and must never be called from the server request path.
 */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, readFile, writeFile } from "node:fs/promises";
import { zstdDecompress, zstdDecompressSync } from "node:zlib";

/** Default block size: 64KB (same as electron-builder) */
export const DEFAULT_BLOCK_SIZE = 64 * 1024;

/**
 * Metadata for a zstd dictionary patch.
 * Stored alongside the patch as `.zstd-patch.meta.json`.
 */
export interface ZstdPatchMeta {
	/** Version of the old (source) binary */
	fromVersion: string;
	/** Version of the new (target) binary */
	toVersion: string;
	/** Size of the old source binary. Present on newly generated patches. */
	oldFileSize?: number;
	/** SHA512 of the complete old source binary (base64). Present on newly generated patches. */
	oldFileSha512?: string;
	/** Byte offset where the stable (identical) head region ends */
	stableEnd: number;
	/** Size of the new binary's tail (after stableEnd) */
	newTailSize: number;
	/** Size of the compressed patch in bytes */
	patchSize: number;
	/** Total size of the new binary in bytes */
	newFileSize: number;
	/** SHA512 of the complete new binary (base64) */
	newFileSha512: string;
	/** Patch mode: new patches use zstd CLI `--patch-from`; dictionary is legacy-only. */
	mode?: "patch-from" | "dictionary";
}

/**
 * Find the byte boundary where two buffers stop being identical.
 * Compares in 64KB-aligned blocks; returns the end offset of the last
 * matching block (i.e. everything before this offset is identical).
 */
export function findStableEnd(
	oldBuf: Buffer,
	newBuf: Buffer,
	blockSize = DEFAULT_BLOCK_SIZE,
): number {
	let stableEnd = 0;
	const limit = Math.min(oldBuf.length, newBuf.length);
	for (let i = 0; i < limit; i += blockSize) {
		const end = Math.min(i + blockSize, limit);
		if (Buffer.compare(oldBuf.subarray(i, end), newBuf.subarray(i, end)) === 0) {
			stableEnd = end;
		} else {
			break;
		}
	}
	return stableEnd;
}

/**
 * Generate a zstd patch from old → new binary.
 *
 * Only zstd CLI `--patch-from` is accepted for newly generated patches. The
 * older Bun dictionary fallback produced very large patches and hid real zstd
 * failures, so failures now surface to the release log instead.
 */
export function generateZstdPatch(
	oldBuf: Buffer,
	newBuf: Buffer,
	opts: { fromVersion: string; toVersion: string; level?: number },
): { patch: Buffer; meta: ZstdPatchMeta } {
	const level = opts.level ?? 19;
	const oldFileSha512 = createHash("sha512").update(oldBuf).digest("base64");
	const newFileSha512 = createHash("sha512").update(newBuf).digest("base64");
	const patch = tryZstdCliPatchFrom(oldBuf, newBuf, level);
	const meta: ZstdPatchMeta = {
		fromVersion: opts.fromVersion,
		toVersion: opts.toVersion,
		oldFileSize: oldBuf.length,
		oldFileSha512,
		stableEnd: 0,
		newTailSize: newBuf.length,
		patchSize: patch.length,
		newFileSize: newBuf.length,
		newFileSha512,
		mode: "patch-from",
	};
	return { patch, meta };
}

export interface GenerateZstdPatchToFileOptions {
	/** Published source binary the patch applies to. */
	oldFilePath: string;
	/** Target binary the patch reconstructs. */
	newFilePath: string;
	/** Destination for the generated patch payload. */
	patchOutputPath: string;
	fromVersion: string;
	toVersion: string;
	/** zstd compression level; defaults to the release level (19). */
	level?: number;
	/** Custom zstd binary. */
	zstdPath?: string;
	signal?: AbortSignal;
	/** Wall-clock budget for the zstd CLI invocation. */
	timeoutMs?: number;
}

/**
 * Metadata from a freshly generated patch.
 *
 * The source identity fields are optional on `ZstdPatchMeta` because patches published before
 * they existed are still readable, but anything generated now always has them. Stating that in
 * the return type lets callers verify the source binary without a runtime narrowing check that
 * could never fail.
 */
export type GeneratedZstdPatchMeta = ZstdPatchMeta &
	Required<Pick<ZstdPatchMeta, "oldFileSize" | "oldFileSha512">>;

/**
 * Generate a patch file-to-file, without holding either binary on the JS heap.
 *
 * Release tooling needs this when it produces extra upgrade paths (for example a direct
 * previous-stable → target patch) outside the build's per-platform workers: several ~140MB
 * binaries would otherwise be buffered at once. Identity fields are computed by streaming
 * both inputs, so the metadata matches `generateZstdPatch` byte for byte.
 */
export async function generateZstdPatchToFile(
	options: GenerateZstdPatchToFileOptions,
): Promise<GeneratedZstdPatchMeta> {
	const level = options.level ?? 19;
	await runZstdCli(
		[
			options.zstdPath ?? "zstd",
			`--patch-from=${options.oldFilePath}`,
			options.newFilePath,
			"-o",
			options.patchOutputPath,
			`-${level}`,
			"--force",
			"--long=31",
		],
		"patch generation",
		options,
	);

	const [oldStat, newStat, patchStat] = await Promise.all([
		Bun.file(options.oldFilePath).stat(),
		Bun.file(options.newFilePath).stat(),
		Bun.file(options.patchOutputPath).stat(),
	]);
	const [oldFileSha512, newFileSha512] = await Promise.all([
		streamFileSha512(options.oldFilePath, options.signal),
		streamFileSha512(options.newFilePath, options.signal),
	]);

	return {
		fromVersion: options.fromVersion,
		toVersion: options.toVersion,
		oldFileSize: oldStat.size,
		oldFileSha512,
		stableEnd: 0,
		newTailSize: newStat.size,
		patchSize: patchStat.size,
		newFileSize: newStat.size,
		newFileSha512,
		mode: "patch-from",
	};
}

/** Generate a patch using zstd CLI --patch-from, or throw with diagnostic output. */
function tryZstdCliPatchFrom(oldBuf: Buffer, newBuf: Buffer, level: number): Buffer {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	const { writeFileSync, readFileSync, unlinkSync } = require("node:fs");
	const tmp = tmpdir();
	const id = `${process.pid}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
	const oldPath = join(tmp, `nf-zstd-old-${id}`);
	const newPath = join(tmp, `nf-zstd-new-${id}`);
	const patchPath = join(tmp, `nf-zstd-patch-${id}.zst`);

	try {
		writeFileSync(oldPath, oldBuf);
		writeFileSync(newPath, newBuf);

		const result = Bun.spawnSync(
			[
				"zstd",
				`--patch-from=${oldPath}`,
				newPath,
				"-o",
				patchPath,
				`-${level}`,
				"--force",
				"--long=31",
			],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (result.exitCode !== 0) {
			throw new Error(
				`zstd --patch-from failed with exit code ${result.exitCode}: ${formatProcessOutput(
					result.stdout,
					result.stderr,
				)}`,
			);
		}

		return readFileSync(patchPath);
	} catch (error) {
		if (error instanceof Error && error.message.startsWith("zstd --patch-from failed")) {
			throw error;
		}
		throw new Error(`zstd --patch-from failed before completion: ${String(error)}`);
	} finally {
		for (const path of [oldPath, newPath, patchPath]) {
			try {
				unlinkSync(path);
			} catch {
				// Best effort temp-file cleanup.
			}
		}
	}
}

function formatProcessOutput(stdout: Uint8Array, stderr: Uint8Array): string {
	const decoder = new TextDecoder();
	const parts = [
		["stderr", decoder.decode(stderr).trim()],
		["stdout", decoder.decode(stdout).trim()],
	]
		.filter(([, value]) => value)
		.map(([label, value]) => `${label}: ${truncateForLog(value)}`);
	return parts.length > 0 ? parts.join("; ") : "no output";
}

function truncateForLog(value: string, maxLength = 4000): string {
	return value.length > maxLength ? `${value.slice(0, maxLength)}…` : value;
}

/**
 * Apply a zstd patch to reconstruct the new binary, in memory and synchronously.
 *
 * Release tooling and patch round-trip tests only. The server must use
 * `applyZstdPatchToFile`: this function blocks the event loop for the whole decompression and
 * holds several copies of the binary on the heap.
 *
 * Supports two modes:
 * - "patch-from": uses zstd CLI `--patch-from` (or `zstdPath` override)
 * - "dictionary" (default/legacy): uses Bun zstd API with dictionary
 *
 * Throws on decompression failure or SHA512 mismatch.
 */
export function applyZstdPatch(
	oldBuf: Buffer,
	patch: Buffer,
	meta: ZstdPatchMeta,
	zstdPath?: string,
): Buffer {
	let result: Buffer;

	if (meta.mode === "patch-from") {
		result = applyZstdCliPatch(oldBuf, patch, meta.newFileSize, zstdPath);
	} else {
		// Legacy dictionary mode
		if (meta.stableEnd > oldBuf.length) {
			throw new Error(
				`Old binary too small: expected at least ${meta.stableEnd} bytes, got ${oldBuf.length}`,
			);
		}

		const oldTail = oldBuf.subarray(meta.stableEnd);
		const restoredTail =
			oldTail.length > 0
				? zstdDecompressSync(patch, { dictionary: oldTail })
				: zstdDecompressSync(patch);

		if (restoredTail.length !== meta.newTailSize) {
			throw new Error(
				`Zstd patch tail size mismatch: expected ${meta.newTailSize}, got ${restoredTail.length}`,
			);
		}

		result = Buffer.concat([oldBuf.subarray(0, meta.stableEnd), restoredTail]);
	}

	if (result.length !== meta.newFileSize) {
		throw new Error(
			`Zstd patch file size mismatch: expected ${meta.newFileSize}, got ${result.length}`,
		);
	}

	const actualSha512 = createHash("sha512").update(result).digest("base64");
	if (actualSha512 !== meta.newFileSha512) {
		throw new Error(
			`Zstd patch SHA512 mismatch: expected ${meta.newFileSha512.slice(0, 16)}..., got ${actualSha512.slice(0, 16)}...`,
		);
	}

	return result;
}

/** Bytes of zstd CLI diagnostics kept; the process must never buffer unbounded output. */
const MAX_CLI_OUTPUT_BYTES = 8 * 1024;
/** Default wall-clock budget for one zstd CLI invocation. */
const DEFAULT_CLI_TIMEOUT_MS = 10 * 60_000;

export interface ApplyZstdPatchToFileOptions {
	/** Current binary that the patch applies to. */
	oldFilePath: string;
	/** Downloaded patch payload. */
	patchFilePath: string;
	/** Destination for the reconstructed binary. */
	outputFilePath: string;
	meta: ZstdPatchMeta;
	/** Custom zstd binary (e.g. a downloaded zstd.exe on Windows). */
	zstdPath?: string;
	/** Cancels the CLI/decompression work. */
	signal?: AbortSignal;
	/** Wall-clock budget for the zstd CLI invocation. */
	timeoutMs?: number;
	/** Refuse to reconstruct anything larger than this many bytes. */
	maxOutputBytes?: number;
}

/**
 * Apply a patch file-to-file without ever holding the whole binary on the JS heap for the
 * synchronous portion of the work.
 *
 * `patch-from` mode delegates to the zstd CLI as an asynchronous child process with a timeout,
 * a bounded diagnostic buffer, and abort support. Legacy dictionary mode still needs the bytes
 * in memory, but uses the asynchronous zlib binding so the decompression runs off-thread.
 * Both paths verify size and SHA-512 by streaming the produced file.
 */
export async function applyZstdPatchToFile(
	options: ApplyZstdPatchToFileOptions,
): Promise<{ sizeBytes: number; sha512: string }> {
	const { meta, maxOutputBytes } = options;
	options.signal?.throwIfAborted();
	if (maxOutputBytes !== undefined && meta.newFileSize > maxOutputBytes) {
		throw new Error(
			`Zstd patch target size ${meta.newFileSize} exceeds the ${maxOutputBytes}-byte limit`,
		);
	}

	if (meta.mode === "patch-from") {
		await runZstdCliDecompress(options);
	} else {
		await applyLegacyDictionaryPatchToFile(options);
	}

	options.signal?.throwIfAborted();
	const stat = await Bun.file(options.outputFilePath).stat();
	options.signal?.throwIfAborted();
	if (stat.size !== meta.newFileSize) {
		throw new Error(
			`Zstd patch file size mismatch: expected ${meta.newFileSize}, got ${stat.size}`,
		);
	}
	const sha512 = await streamFileSha512(options.outputFilePath, options.signal);
	options.signal?.throwIfAborted();
	if (sha512 !== meta.newFileSha512) {
		throw new Error(
			`Zstd patch SHA512 mismatch: expected ${meta.newFileSha512.slice(0, 16)}..., got ${sha512.slice(0, 16)}...`,
		);
	}
	return { sizeBytes: stat.size, sha512 };
}

async function runZstdCliDecompress(options: ApplyZstdPatchToFileOptions): Promise<void> {
	const maximum = Math.min(
		options.meta.newFileSize,
		options.maxOutputBytes ?? options.meta.newFileSize,
	);
	if (!Number.isSafeInteger(maximum) || maximum < 0) throw new Error("Invalid zstd output ceiling");
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS);
	options.signal?.throwIfAborted();
	const deadline = AbortSignal.any([
		AbortSignal.timeout(timeoutMs),
		...(options.signal ? [options.signal] : []),
	]);
	const handle = await open(options.outputFilePath, "w");
	let proc: ReturnType<typeof Bun.spawn<"ignore", "pipe", "pipe">> | undefined;
	const onAbort = () => {
		proc?.kill("SIGKILL");
	};
	let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
	try {
		deadline.throwIfAborted();
		proc = Bun.spawn(
			[
				options.zstdPath ?? "zstd",
				"-d",
				`--patch-from=${options.oldFilePath}`,
				options.patchFilePath,
				"--stdout",
				"--long=31",
				"--memory=2048MB",
			],
			{ stdin: "ignore", stdout: "pipe", stderr: "pipe" },
		);
		deadline.addEventListener("abort", onAbort, { once: true });
		const stderr = readCappedStream(proc.stderr).catch(() => new Uint8Array());
		const outputReader = proc.stdout.getReader();
		reader = outputReader;
		let size = 0;
		while (true) {
			deadline.throwIfAborted();
			const chunk = await new Promise<{ done: boolean; value?: Uint8Array }>(
				(resolveChunk, reject) => {
					const onReadAbort = () => reject(deadline.reason);
					deadline.addEventListener("abort", onReadAbort, { once: true });
					outputReader
						.read()
						.then(resolveChunk, reject)
						.finally(() => deadline.removeEventListener("abort", onReadAbort));
				},
			);
			if (chunk.done) break;
			if (!chunk.value) throw new Error("zstd output stream produced no bytes");
			size += chunk.value.byteLength;
			if (size > maximum)
				throw new Error(`zstd CLI decompression output exceeds the ${maximum}-byte limit`);
			let offset = 0;
			while (offset < chunk.value.byteLength) {
				deadline.throwIfAborted();
				const { bytesWritten } = await handle.write(
					chunk.value,
					offset,
					chunk.value.byteLength - offset,
				);
				if (!bytesWritten) throw new Error("zstd output write made no progress");
				offset += bytesWritten;
			}
		}
		const [diagnostic, exitCode] = await Promise.all([stderr, proc.exited]);
		deadline.throwIfAborted();
		if (exitCode !== 0)
			throw new Error(
				`zstd CLI decompression failed (exit ${exitCode}): ${formatProcessOutput(new Uint8Array(), diagnostic)}`,
			);
	} catch (error) {
		proc?.kill("SIGKILL");
		if (deadline.aborted && !options.signal?.aborted)
			throw new Error(`zstd CLI decompression timed out after ${timeoutMs}ms`);
		throw error;
	} finally {
		deadline.removeEventListener("abort", onAbort);
		void reader?.cancel().catch(() => {});
		if (proc) await proc.exited;
		await handle.close();
	}
}

/**
 * Run one zstd CLI invocation as an asynchronous child process with a timeout, a bounded
 * diagnostic buffer, and abort support. Diagnostics are never collected unbounded because
 * zstd can be verbose on large inputs.
 */
async function runZstdCli(
	command: string[],
	label: string,
	options: { signal?: AbortSignal; timeoutMs?: number },
): Promise<void> {
	const timeoutMs = Math.max(1, options.timeoutMs ?? DEFAULT_CLI_TIMEOUT_MS);
	options.signal?.throwIfAborted();

	const proc = Bun.spawn(command, { stdin: "ignore", stdout: "pipe", stderr: "pipe" });

	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		proc.kill();
	}, timeoutMs);
	const onAbort = () => proc.kill();
	options.signal?.addEventListener("abort", onAbort, { once: true });

	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			readCappedStream(proc.stdout),
			readCappedStream(proc.stderr),
			proc.exited,
		]);
		if (timedOut) {
			throw new Error(`zstd CLI ${label} timed out after ${timeoutMs}ms`);
		}
		options.signal?.throwIfAborted();
		if (exitCode !== 0) {
			throw new Error(
				`zstd CLI ${label} failed (exit ${exitCode}): ${formatProcessOutput(stdout, stderr)}`,
			);
		}
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
	}
}

async function applyLegacyDictionaryPatchToFile(
	options: ApplyZstdPatchToFileOptions,
): Promise<void> {
	const { meta } = options;
	options.signal?.throwIfAborted();
	const oldBuf = await readFile(options.oldFilePath);
	if (meta.stableEnd > oldBuf.length) {
		throw new Error(
			`Old binary too small: expected at least ${meta.stableEnd} bytes, got ${oldBuf.length}`,
		);
	}
	const patch = await readFile(options.patchFilePath);
	options.signal?.throwIfAborted();

	const oldTail = oldBuf.subarray(meta.stableEnd);
	const restoredTail = await decompressZstd(
		patch,
		oldTail.length > 0 ? oldTail : undefined,
		meta.newTailSize,
	);
	if (restoredTail.length !== meta.newTailSize) {
		throw new Error(
			`Zstd patch tail size mismatch: expected ${meta.newTailSize}, got ${restoredTail.length}`,
		);
	}
	options.signal?.throwIfAborted();
	await writeFile(
		options.outputFilePath,
		Buffer.concat([oldBuf.subarray(0, meta.stableEnd), restoredTail]),
	);
}

function decompressZstd(
	patch: Buffer,
	dictionary?: Buffer,
	maxOutputLength?: number,
): Promise<Buffer> {
	return new Promise((resolveBuffer, reject) => {
		const done = (error: Error | null, result?: Buffer) => {
			if (error) reject(error);
			else resolveBuffer(result as Buffer);
		};
		// Bound the native allocation before decoding, not only after producing the buffer.
		const options = {
			...(dictionary ? { dictionary } : {}),
			...(maxOutputLength !== undefined ? { maxOutputLength: Math.max(1, maxOutputLength) } : {}),
		};
		zstdDecompress(patch, options, done);
	});
}

async function readCappedStream(
	stream: ReadableStream<Uint8Array> | number | undefined | null,
): Promise<Uint8Array> {
	if (!stream || typeof stream === "number") return new Uint8Array();
	const chunks: Uint8Array[] = [];
	let total = 0;
	const reader = stream.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (total >= MAX_CLI_OUTPUT_BYTES) continue;
			const slice = value.subarray(0, MAX_CLI_OUTPUT_BYTES - total);
			chunks.push(slice);
			total += slice.length;
		}
	} finally {
		reader.releaseLock();
	}
	const merged = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		merged.set(chunk, offset);
		offset += chunk.length;
	}
	return merged;
}

async function streamFileSha512(filePath: string, signal?: AbortSignal): Promise<string> {
	signal?.throwIfAborted();
	const hash = createHash("sha512");
	// The decoder's caller owns the overall deadline; include this IO in that same signal.
	for await (const chunk of createReadStream(filePath, { signal })) {
		signal?.throwIfAborted();
		hash.update(chunk);
	}
	signal?.throwIfAborted();
	return hash.digest("base64");
}

/**
 * Apply a zstd --patch-from patch using CLI.
 * `zstdPath` can be a custom path to the zstd binary (e.g. downloaded zstd.exe on Windows).
 */
function applyZstdCliPatch(
	oldBuf: Buffer,
	patch: Buffer,
	_expectedSize: number,
	zstdPath?: string,
): Buffer {
	const { tmpdir } = require("node:os");
	const { join } = require("node:path");
	const { writeFileSync, readFileSync, unlinkSync } = require("node:fs");

	const zstdBin = zstdPath ?? "zstd";
	const tmp = tmpdir();
	const id = Date.now().toString(36);
	const oldPath = join(tmp, `nf-zstd-old-${id}`);
	const patchPath = join(tmp, `nf-zstd-patch-${id}.zst`);
	const outPath = join(tmp, `nf-zstd-out-${id}`);

	writeFileSync(oldPath, oldBuf);
	writeFileSync(patchPath, patch);

	try {
		const result = Bun.spawnSync(
			[zstdBin, "-d", `--patch-from=${oldPath}`, patchPath, "-o", outPath, "--force", "--long=31"],
			{ stdout: "pipe", stderr: "pipe" },
		);

		if (result.exitCode !== 0) {
			const stderr = new TextDecoder().decode(result.stderr);
			throw new Error(`zstd CLI decompression failed (exit ${result.exitCode}): ${stderr}`);
		}

		return readFileSync(outPath);
	} finally {
		try {
			unlinkSync(oldPath);
		} catch {}
		try {
			unlinkSync(patchPath);
		} catch {}
		try {
			unlinkSync(outPath);
		} catch {}
	}
}
