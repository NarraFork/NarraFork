import type { GitLineStats, GitLineStatsFile } from "../../shared/git-line-stats";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { GitError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import { safeSpawn } from "../lib/spawn";
import { WorkerCleanupError } from "../lib/worker-runtime/lifecycle";
import { WorkerPool } from "../lib/worker-runtime/pool";
import { TaskQueueError } from "../lib/worker-runtime/queue";
import { GitReaderSession } from "./git-current-baseline-session";
import type { UntrackedLineBatch } from "./git-untracked-line-worker";

export const GIT_LINE_STATS_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_FILES = 10_000;
const UNTRACKED_BATCH_FILES = 200;
const UNTRACKED_CONTENT_BYTES = 20_000_000;
const WORKER_IDLE_MS = 60_000;

interface NumstatEntry {
	path: string;
	added: number;
	removed: number;
}

/** Keep complete NUL records only, including both names of a rename. */
export function parseGitLineNumstat(
	output: string,
	prefix = "",
): { files: NumstatEntry[]; complete: boolean } {
	const files: NumstatEntry[] = [];
	let offset = 0;
	let complete = true;
	while (offset < output.length) {
		const end = output.indexOf("\0", offset);
		if (end < 0) return { files, complete: false };
		const record = output.slice(offset, end);
		offset = end + 1;
		const firstTab = record.indexOf("\t");
		const secondTab = record.indexOf("\t", firstTab + 1);
		if (firstTab < 0 || secondTab < 0) {
			complete = false;
			continue;
		}
		const addedText = record.slice(0, firstTab);
		const removedText = record.slice(firstTab + 1, secondTab);
		let path = record.slice(secondTab + 1);
		let oldPath = "";
		if (!path) {
			const oldEnd = output.indexOf("\0", offset);
			if (oldEnd < 0) return { files, complete: false };
			oldPath = output.slice(offset, oldEnd);
			const newEnd = output.indexOf("\0", oldEnd + 1);
			if (newEnd < 0) return { files, complete: false };
			path = output.slice(oldEnd + 1, newEnd);
			offset = newEnd + 1;
		}
		if (!path || !/^(?:\d+|-)$/.test(addedText) || !/^(?:\d+|-)$/.test(removedText)) {
			complete = false;
			continue;
		}
		// Numstat is root-relative even when `-- .` scopes it to a narrator cwd.
		// A rename out of the scope belongs to its old (in-scope) path instead.
		if (prefix) {
			if (path.startsWith(prefix)) path = path.slice(prefix.length);
			else if (oldPath.startsWith(prefix)) path = oldPath.slice(prefix.length);
			else continue;
		}
		const added = addedText === "-" ? 0 : Number(addedText);
		const removed = removedText === "-" ? 0 : Number(removedText);
		if (!Number.isSafeInteger(added) || !Number.isSafeInteger(removed)) {
			complete = false;
			continue;
		}
		files.push({ path, added, removed });
	}
	return { files, complete };
}

interface GitOutput {
	output: string;
	complete: boolean;
}

async function gitOutput(cwd: string, args: string[], signal: AbortSignal): Promise<GitOutput> {
	signal.throwIfAborted();
	const startedAt = performance.now();
	const chunks: Uint8Array[] = [];
	const result = await safeSpawn({
		cmd: [
			"git",
			"--no-optional-locks",
			"--literal-pathspecs",
			"-c",
			"core.fsmonitor=false",
			...args,
		],
		cwd,
		env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		timeout: COMMAND_TIMEOUT_MS,
		signal,
		maxOutputBytes: GIT_LINE_STATS_OUTPUT_BYTES,
		maxStderrBytes: 8192,
		stdoutStream: {
			maxBytes: GIT_LINE_STATS_OUTPUT_BYTES,
			onChunk(chunk) {
				chunks.push(chunk.slice());
				// Keep reading; `false` is the only value that stops the stream early.
				return undefined;
			},
		},
	});
	// safeSpawn drains pipes and awaits the actual child exit before returning.
	const durationMs = performance.now() - startedAt;
	if (durationMs > 2000) {
		try {
			logger.warn("Slow Git line statistics command", { command: args[0], durationMs });
		} catch {
			/* Diagnostics do not change completed child results. */
		}
	}
	signal.throwIfAborted();
	if (result.terminationReason && result.terminationReason !== "output-limit") {
		throw new GitError(`Git line statistics failed: ${result.terminationReason}`);
	}
	if (result.exitCode !== 0 && result.terminationReason !== "output-limit") {
		throw new GitError(result.stderr || "Git line statistics failed");
	}
	const complete = !result.stdoutTruncated && result.terminationReason !== "output-limit";
	const decoder = new TextDecoder();
	return {
		output: decoder.decode(Buffer.concat(chunks), { stream: !complete }),
		complete,
	};
}

/** Embedded layouts for the untracked-line worker. Dev has one source URL. */
export function gitLineStatsWorkerSpecifiers(
	compiled = isCompiledRuntime(),
	moduleUrl = import.meta.url,
): string[] {
	return compiledWorkerSpecifiers(
		"services/git-untracked-line-worker.ts",
		"./git-untracked-line-worker.ts",
		moduleUrl,
		compiled,
	);
}

interface UntrackedRead {
	action: "read";
	cwd: string;
	paths: string[];
	remainingBytes: number;
	deadlineAt: number;
}

function createLinePool() {
	return new WorkerPool<UntrackedRead, UntrackedLineBatch>({
		concurrency: 1,
		maxQueued: 8,
		// The existing Git metadata cap bounds each request, not the files' content size.
		maxQueuedBytes: 8 * GIT_LINE_STATS_OUTPUT_BYTES * 2,
		idleTimeoutMs: WORKER_IDLE_MS,
		create: async ({ signal }) => {
			try {
				const { worker, handle } = await connectCompiledWorker(gitLineStatsWorkerSpecifiers(), {
					signal,
				});
				return new GitReaderSession<UntrackedRead, UntrackedLineBatch>(
					worker,
					handle,
					(message) => new GitError(message),
					COMMAND_TIMEOUT_MS,
				);
			} catch (error) {
				// Startup cleanup failures carry a live Handle; never erase its pool accounting.
				if (signal.aborted || error instanceof WorkerCleanupError) throw error;
				throw new GitError(
					error instanceof Error ? error.message : "Git line statistics worker failed to start",
				);
			}
		},
	});
}

const lineOwner = hotSafe("narrafork.gitLineStats.workers.v1", () => ({
	version: 2,
	pool: createLinePool(),
	reads: new Map<AbortController, Promise<void>>(),
	closed: false,
	closing: undefined as Promise<void> | undefined,
}));
// Keep the owner key stable: hot reload must not strand the old pool or reuse its old wire budget.
if (lineOwner.version !== 2)
	throw new Error(
		"Git line statistics ownership predates this runtime; manually restart NarraFork",
	);

export function closeGitLineStatsWorkers(): Promise<void> {
	if (lineOwner.closing) return lineOwner.closing;
	lineOwner.closed = true;
	const reason = new GitError("Git line statistics workers are closed");
	const workers = lineOwner.pool.close(reason);
	for (const controller of lineOwner.reads.keys()) controller.abort(reason);
	lineOwner.closing = Promise.allSettled([workers, ...lineOwner.reads.values()]).then(
		(outcomes) => {
			for (const outcome of outcomes) if (outcome.status === "rejected") throw outcome.reason;
		},
	);
	return lineOwner.closing;
}

export async function resetGitLineStatsWorkersForTests(): Promise<void> {
	await closeGitLineStatsWorkers();
	lineOwner.pool = createLinePool();
	lineOwner.closed = false;
	lineOwner.closing = undefined;
}

/** One reusable worker, at most eight waiting batches. No per-file workers or Promise tail. */
async function readUntracked(
	cwd: string,
	paths: string[],
	signal: AbortSignal,
	remainingBytes: number,
	deadlineAt: number,
): Promise<UntrackedLineBatch> {
	const startedAt = performance.now();
	let failed = false;
	try {
		const result = await lineOwner.pool.run(
			{ action: "read", cwd, paths, remainingBytes, deadlineAt },
			{
				signal,
				bytes: (cwd.length + paths.reduce((size, path) => size + path.length, 0)) * 2,
				deadlineAt,
			},
		);
		if (
			!Array.isArray(result.files) ||
			result.files.length !== paths.length ||
			!Number.isSafeInteger(result.readBytes) ||
			result.readBytes < 0 ||
			result.readBytes > remainingBytes
		) {
			throw new GitError("Invalid Git line statistics worker reply");
		}
		for (let index = 0; index < result.files.length; index++) {
			if (result.files[index].path !== paths[index])
				throw new GitError("Invalid Git line statistics worker path");
		}
		return result;
	} catch (error) {
		failed = true;
		if (error instanceof TaskQueueError && error.code === "TASK_QUEUE_FULL")
			throw new GitError("Git line statistics reader queue is full");
		throw error;
	} finally {
		const durationMs = performance.now() - startedAt;
		if (durationMs > 2000) {
			try {
				logger.warn("Slow untracked Git line statistics batch", {
					durationMs,
					files: paths.length,
					failed,
				});
			} catch {
				// Diagnostics cannot replace the result or skip resource cleanup.
			}
		}
	}
}

/** Raw local measurement: no server TTL, status request, remote call, or shared in-flight cache. */
export async function getGitLineStats(cwd: string, signal?: AbortSignal): Promise<GitLineStats> {
	signal?.throwIfAborted();
	if (lineOwner.closed) throw new GitError("Git line statistics workers are closed");
	const controller = new AbortController();
	let finish!: () => void;
	lineOwner.reads.set(
		controller,
		new Promise<void>((resolve) => {
			finish = resolve;
		}),
	);
	try {
		return await measureGitLineStats(
			cwd,
			signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
		);
	} finally {
		lineOwner.reads.delete(controller);
		finish();
	}
}

async function measureGitLineStats(cwd: string, signal: AbortSignal): Promise<GitLineStats> {
	signal.throwIfAborted();
	const controller = new AbortController();
	const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
	const safeDiff = [
		"--numstat",
		"-z",
		"--no-ext-diff",
		"--no-textconv",
		"--no-relative",
		"--no-color",
	];
	let failure: unknown;
	const commands = [
		["rev-parse", "--show-prefix"],
		["diff", "--cached", ...safeDiff, "--", "."],
		["diff", ...safeDiff, "--", "."],
		["ls-files", "--others", "--exclude-standard", "-z", "--", "."],
	];
	const outputs = await Promise.allSettled(
		commands.map((args) =>
			gitOutput(cwd, args, combined).catch((error) => {
				failure ??= error;
				controller.abort();
				throw error;
			}),
		),
	);
	// Always await all siblings' cleanup, even when one command fails first.
	if (failure) throw failure;
	const [prefixOutput, stagedOutput, unstagedOutput, untrackedOutput] = outputs.map((result) => {
		if (result.status === "rejected") throw result.reason;
		return result.value;
	});
	combined.throwIfAborted();
	if (!prefixOutput.complete) throw new GitError("Git working-directory prefix exceeded budget");
	const prefix = prefixOutput.output.replace(/\n$/, "");
	const staged = parseGitLineNumstat(stagedOutput.output, prefix);
	const unstaged = parseGitLineNumstat(unstagedOutput.output, prefix);
	staged.complete &&= stagedOutput.complete;
	unstaged.complete &&= unstagedOutput.complete;
	const untrackedPaths: string[] = [];
	// Charge serialized paths before retaining them; raw Git bytes alone do not bound JSON escapes.
	let requestBytes = Buffer.byteLength(
		JSON.stringify({
			action: "read",
			cwd,
			paths: [],
			remainingBytes: UNTRACKED_CONTENT_BYTES,
			deadlineAt: Number.MAX_SAFE_INTEGER,
		}),
	);
	let offset = 0;
	while (untrackedPaths.length < MAX_UNTRACKED_FILES) {
		const end = untrackedOutput.output.indexOf("\0", offset);
		if (end < 0) break;
		const path = untrackedOutput.output.slice(offset, end);
		if (path) {
			if (path.length > GIT_LINE_STATS_OUTPUT_BYTES - requestBytes) break;
			const bytes = Buffer.byteLength(JSON.stringify(path)) + (untrackedPaths.length ? 1 : 0);
			if (requestBytes + bytes > GIT_LINE_STATS_OUTPUT_BYTES) break;
			requestBytes += bytes;
			untrackedPaths.push(path);
		}
		offset = end + 1;
	}
	const listedAll = untrackedOutput.complete && offset === untrackedOutput.output.length;
	const untracked: UntrackedLineBatch = {
		files: [],
		complete: true,
		readFiles: 0,
		readBytes: 0,
	};
	// One absolute deadline and content allowance for the entire round, including queue waits.
	const deadlineAt = Date.now() + COMMAND_TIMEOUT_MS;
	for (let start = 0; start < untrackedPaths.length; start += UNTRACKED_BATCH_FILES) {
		combined.throwIfAborted();
		const batch = await readUntracked(
			cwd,
			untrackedPaths.slice(start, start + UNTRACKED_BATCH_FILES),
			combined,
			UNTRACKED_CONTENT_BYTES - untracked.readBytes,
			deadlineAt,
		);
		untracked.files.push(...batch.files);
		untracked.complete &&= batch.complete;
		untracked.readFiles += batch.readFiles;
		untracked.readBytes += batch.readBytes;
	}
	combined.throwIfAborted();
	const files = new Map<string, GitLineStatsFile>();
	const stagedPaths = new Set<string>();
	const unstagedPaths = new Set<string>();
	const fileAt = (path: string) => {
		let file = files.get(path);
		if (!file) {
			file = { path, complete: true };
			files.set(path, file);
		}
		return file;
	};
	for (const entry of staged.files) {
		const file = fileAt(entry.path);
		stagedPaths.add(entry.path);
		file.stagedLinesAdded = (file.stagedLinesAdded ?? 0) + entry.added;
		file.stagedLinesRemoved = (file.stagedLinesRemoved ?? 0) + entry.removed;
	}
	for (const entry of unstaged.files) {
		const file = fileAt(entry.path);
		unstagedPaths.add(entry.path);
		file.unstagedLinesAdded = (file.unstagedLinesAdded ?? 0) + entry.added;
		file.unstagedLinesRemoved = (file.unstagedLinesRemoved ?? 0) + entry.removed;
	}
	for (const entry of untracked.files) {
		Object.assign(fileAt(entry.path), entry);
		unstagedPaths.add(entry.path);
	}
	const measured: GitLineStatsFile[] = [];
	let linesAdded = 0;
	let linesRemoved = 0;
	let filesComplete = true;
	let measurementsComplete = true;
	// Reserve the small totals/envelope before adding individually bounded DTOs.
	let remainingOutputBytes = GIT_LINE_STATS_OUTPUT_BYTES - 128;
	for (const file of files.values()) {
		if (!stagedPaths.has(file.path) && staged.complete) {
			file.stagedLinesAdded = 0;
			file.stagedLinesRemoved = 0;
		}
		if (!unstagedPaths.has(file.path) && unstaged.complete && listedAll) {
			file.unstagedLinesAdded = 0;
			file.unstagedLinesRemoved = 0;
		}
		file.complete &&= file.stagedLinesAdded !== undefined && file.unstagedLinesAdded !== undefined;
		linesAdded += (file.stagedLinesAdded ?? 0) + (file.unstagedLinesAdded ?? 0);
		linesRemoved += (file.stagedLinesRemoved ?? 0) + (file.unstagedLinesRemoved ?? 0);
		measurementsComplete &&= file.complete;
		// Public rows remain a bounded prefix; totals describe every measured row this round.
		if (filesComplete) {
			const bytes = Buffer.byteLength(JSON.stringify(file), "utf8") + 1;
			if (measured.length >= 10_000 || bytes > remainingOutputBytes) {
				filesComplete = false;
			} else {
				remainingOutputBytes -= bytes;
				measured.push(file);
			}
		}
	}
	return {
		files: measured,
		linesAdded,
		linesRemoved,
		complete:
			staged.complete &&
			unstaged.complete &&
			listedAll &&
			filesComplete &&
			untracked.complete &&
			measurementsComplete,
	};
}
