import { chmod, mkdtemp, open, realpath, rm } from "node:fs/promises";
import { devNull, tmpdir } from "node:os";
import { join } from "node:path";
import { FILE_CHANGE_LIMITS } from "@shared/file-change-protocol";

const MAX_TIMEOUT_MS = 30_000;

export type FileChangeMergeFailure =
	| "invalid_input"
	| "budget_exceeded"
	| "cancelled"
	| "timeout"
	| "merge_conflict"
	| "merge_failed";

export class FileChangeMergeError extends Error {
	constructor(readonly reason: FileChangeMergeFailure) {
		super(`Raw file-change merge refused: ${reason}`);
		this.name = "FileChangeMergeError";
	}
}

export interface FileChangeMergeOptions {
	signal?: AbortSignal;
	/** May only lower the hard deadline / shared byte limits. */
	timeoutMs?: number;
	maxInputBytes?: number;
	maxOutputBytes?: number;
	/** Trusted infrastructure options, never file identities or HTTP parameters. */
	temporaryRoot?: string;
	gitExecutable?: string;
}

/**
 * Byte-oriented three-way merge: current + (base -> incoming). No codec, index,
 * repository object or user path is involved. Only a newly-created private temp
 * directory is written/removed. stderr is bounded and never exposed as evidence.
 * The caller must reject binary/object/mode changes before invoking this helper.
 */
export async function mergeFileChangeBytes(
	current: Uint8Array,
	base: Uint8Array,
	incoming: Uint8Array,
	options: FileChangeMergeOptions = {},
): Promise<Uint8Array> {
	const timeoutMs = bounded(options.timeoutMs ?? MAX_TIMEOUT_MS, MAX_TIMEOUT_MS, 1);
	const maxInputBytes = bounded(
		options.maxInputBytes ?? FILE_CHANGE_LIMITS.blobBytes,
		FILE_CHANGE_LIMITS.blobBytes,
	);
	const maxOutputBytes = bounded(
		options.maxOutputBytes ?? FILE_CHANGE_LIMITS.blobBytes,
		FILE_CHANGE_LIMITS.blobBytes,
	);
	for (const bytes of [current, base, incoming]) {
		if (!(bytes instanceof Uint8Array)) throw new FileChangeMergeError("invalid_input");
		if (bytes.byteLength > maxInputBytes) throw new FileChangeMergeError("budget_exceeded");
	}
	let directory: string | undefined;
	let processHandle: Bun.Subprocess<"ignore", "pipe", "pipe"> | undefined;
	let failure: FileChangeMergeError | undefined;
	let killed = false;
	const stop = (reason: FileChangeMergeFailure) => {
		failure ??= new FileChangeMergeError(reason);
		if (!processHandle || killed) return;
		killed = true;
		try {
			// Only this direct child. No shell, process-tree scan, or unrelated PID.
			processHandle.kill("SIGKILL");
		} catch {
			// The child may already have exited; its streams are still awaited below.
		}
	};
	const check = () => {
		if (failure) throw failure;
	};
	const onAbort = () => stop("cancelled");
	options.signal?.addEventListener("abort", onAbort, { once: true });
	if (options.signal?.aborted) onAbort();
	const timer = setTimeout(() => stop("timeout"), timeoutMs);
	try {
		check();
		const parent = await realpath(options.temporaryRoot ?? tmpdir());
		check();
		directory = await mkdtemp(join(parent, "narrafork-file-reversal-"));
		await chmod(directory, 0o700);
		check();
		for (const [index, bytes] of [current, base, incoming].entries()) {
			const handle = await open(join(directory, String(index)), "wx", 0o600);
			try {
				let offset = 0;
				while (offset < bytes.byteLength) {
					check();
					const end = Math.min(bytes.byteLength, offset + FILE_CHANGE_LIMITS.streamChunkBytes);
					const chunk = Buffer.from(bytes.subarray(offset, end));
					let written = 0;
					while (written < chunk.byteLength) {
						check();
						const result = await handle.write(
							chunk,
							written,
							chunk.byteLength - written,
							offset + written,
						);
						if (result.bytesWritten <= 0) throw new FileChangeMergeError("merge_failed");
						written += result.bytesWritten;
					}
					offset = end;
				}
			} finally {
				await handle.close();
			}
		}
		check();
		processHandle = Bun.spawn(
			[
				options.gitExecutable ?? "git",
				"-c",
				"core.autocrlf=false",
				"-c",
				"merge.conflictStyle=merge",
				"merge-file",
				"--stdout",
				"-L",
				"current",
				"-L",
				"observed-after",
				"-L",
				"before",
				"--",
				"0",
				"1",
				"2",
			],
			{
				cwd: directory,
				stdin: "ignore",
				stdout: "pipe",
				stderr: "pipe",
				// Do not inherit GIT_DIR, GIT_CONFIG_PARAMETERS, filters or user configuration.
				env: {
					PATH: process.env.PATH,
					SystemRoot: process.env.SystemRoot,
					WINDIR: process.env.WINDIR,
					TMP: directory,
					TEMP: directory,
					HOME: directory,
					USERPROFILE: directory,
					XDG_CONFIG_HOME: directory,
					GIT_CONFIG_NOSYSTEM: "1",
					GIT_CONFIG_GLOBAL: devNull,
					GIT_CEILING_DIRECTORIES: directory,
					LC_ALL: "C",
				},
			},
		);
		// Drain both pipes concurrently, even after a timeout or an output-limit failure.
		const results = await Promise.allSettled([
			collectRaw(processHandle.stdout, maxOutputBytes, true, stop),
			collectRaw(processHandle.stderr, FILE_CHANGE_LIMITS.metadataBytes, false, stop),
			processHandle.exited.catch(() => {
				stop("merge_failed");
				return -1;
			}),
		]);
		check();
		const [stdout, stderr, exit] = results;
		if (
			stdout.status !== "fulfilled" ||
			stderr.status !== "fulfilled" ||
			exit.status !== "fulfilled"
		) {
			throw new FileChangeMergeError("merge_failed");
		}
		// git-merge-file(1): 1..127 conflicts, negative errors (255 on POSIX).
		if (exit.value > 0 && exit.value <= 127) throw new FileChangeMergeError("merge_conflict");
		if (exit.value !== 0) throw new FileChangeMergeError("merge_failed");
		return stdout.value;
	} catch (error) {
		throw (
			failure ??
			(error instanceof FileChangeMergeError ? error : new FileChangeMergeError("merge_failed"))
		);
	} finally {
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", onAbort);
		if (directory) await rm(directory, { recursive: true, force: true });
	}
}

function bounded(value: number, maximum: number, minimum = 0): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new FileChangeMergeError("invalid_input");
	}
	return value;
}

async function collectRaw(
	stream: ReadableStream<Uint8Array>,
	maximum: number,
	retain: boolean,
	stop: (reason: FileChangeMergeFailure) => void,
): Promise<Uint8Array> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	try {
		while (true) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (chunk.value.byteLength > maximum - total) {
				stop("budget_exceeded");
				throw new FileChangeMergeError("budget_exceeded");
			}
			total += chunk.value.byteLength;
			if (!retain) continue;
			for (
				let offset = 0;
				offset < chunk.value.byteLength;
				offset += FILE_CHANGE_LIMITS.streamChunkBytes
			) {
				chunks.push(chunk.value.slice(offset, offset + FILE_CHANGE_LIMITS.streamChunkBytes));
			}
		}
		return retain ? Buffer.concat(chunks, total) : new Uint8Array();
	} catch (error) {
		stop(error instanceof FileChangeMergeError ? error.reason : "merge_failed");
		throw error;
	} finally {
		await reader.cancel().catch(() => {});
		reader.releaseLock();
	}
}
