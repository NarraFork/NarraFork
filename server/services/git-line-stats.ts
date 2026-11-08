import type { Worker } from "node:worker_threads";
import type { GitLineStats, GitLineStatsFile } from "../../shared/git-line-stats";
import { compiledWorkerSpecifiers, connectCompiledWorker } from "../lib/compiled-worker";
import { GitError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isCompiledRuntime } from "../lib/runtime-target";
import { safeSpawn } from "../lib/spawn";
import type { UntrackedLineBatch } from "./git-untracked-line-worker";

export const GIT_LINE_STATS_OUTPUT_BYTES = 1024 * 1024;
const COMMAND_TIMEOUT_MS = 30_000;
const MAX_UNTRACKED_FILES = 200;
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
		logger.warn("Slow Git line statistics command", { command: args[0], durationMs });
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

let thread: Worker | undefined;
let resolvedWorkerSpecifier: string | undefined;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let workerBusy = false;
interface PendingRead {
	cwd: string;
	paths: string[];
	signal: AbortSignal;
	resolve: (value: UntrackedLineBatch) => void;
	reject: (error: unknown) => void;
	abort: () => void;
}
const pendingReads: PendingRead[] = [];

/** One worker, at most eight waiting batches. No per-file workers or unbounded messages. */
function readUntracked(
	cwd: string,
	paths: string[],
	signal: AbortSignal,
): Promise<UntrackedLineBatch> {
	signal.throwIfAborted();
	if (pendingReads.length >= 8) throw new GitError("Git line statistics reader queue is full");
	return new Promise((resolve, reject) => {
		const request: PendingRead = {
			cwd,
			paths,
			signal,
			resolve,
			reject,
			abort() {
				const index = pendingReads.indexOf(request);
				if (index >= 0) {
					pendingReads.splice(index, 1);
					signal.removeEventListener("abort", request.abort);
					reject(signal.reason);
				}
			},
		};
		pendingReads.push(request);
		signal.addEventListener("abort", request.abort, { once: true });
		if (signal.aborted) request.abort();
		void nextWorkerRead();
	});
}

async function nextWorkerRead(): Promise<void> {
	if (workerBusy) return;
	const request = pendingReads.shift();
	if (!request) return;
	workerBusy = true;
	request.signal.removeEventListener("abort", request.abort);
	try {
		request.resolve(await workerRead(request));
	} catch (error) {
		request.reject(error);
	} finally {
		workerBusy = false;
		void nextWorkerRead();
	}
}

async function workerRead(request: PendingRead): Promise<UntrackedLineBatch> {
	const { signal } = request;
	const startedAt = performance.now();
	signal.throwIfAborted();
	if (idleTimer) clearTimeout(idleTimer);
	if (!thread) {
		let created: Worker;
		try {
			const started = await connectCompiledWorker(
				resolvedWorkerSpecifier ? [resolvedWorkerSpecifier] : gitLineStatsWorkerSpecifiers(),
				{ signal },
			);
			created = started.worker;
			resolvedWorkerSpecifier = started.specifier;
		} catch (error) {
			if (signal.aborted) throw error;
			throw new GitError(
				error instanceof Error ? error.message : "Git line statistics worker failed to start",
			);
		}
		thread = created;
		const forget = () => {
			if (thread === created) thread = undefined;
		};
		// Idle-worker failures must not become unhandled EventEmitter errors.
		created.on("error", forget);
		created.on("exit", forget);
	}
	const active = thread;
	active.ref();
	let abort = () => {};
	let timer: ReturnType<typeof setTimeout> | undefined;
	let forcedTimer: ReturnType<typeof setTimeout> | undefined;
	let onMessage: (message: { value?: UntrackedLineBatch; error?: string }) => void = () => {};
	let onError: (error: Error) => void = () => {};
	let onExit: () => void = () => {};
	let failed = false;
	try {
		return await new Promise<UntrackedLineBatch>((resolve, reject) => {
			let cancellation: unknown;
			abort = () => {
				cancellation ??= signal.aborted
					? signal.reason
					: new GitError("Git line statistics worker timed out");
				try {
					active.postMessage({ action: "cancel" });
					forcedTimer ??= setTimeout(() => reject(cancellation), 1000);
				} catch {
					reject(cancellation);
				}
			};
			onMessage = (message) => {
				if (cancellation || signal.aborted) reject(cancellation ?? signal.reason);
				else if (message.error) reject(new GitError(message.error));
				else if (message.value) resolve(message.value);
				else reject(new GitError("Invalid Git line statistics worker reply"));
			};
			onError = reject;
			onExit = () => reject(new GitError("Git line statistics worker exited"));
			active.once("message", onMessage);
			active.once("error", onError);
			active.once("exit", onExit);
			signal.addEventListener("abort", abort, { once: true });
			timer = setTimeout(abort, COMMAND_TIMEOUT_MS);
			active.postMessage({ action: "read", cwd: request.cwd, paths: request.paths });
			if (signal.aborted) abort();
		});
	} catch (error) {
		failed = true;
		// Cancellation/failure is not reported until handles owned by this worker close.
		thread = undefined;
		await active.terminate();
		throw error;
	} finally {
		if (timer) clearTimeout(timer);
		if (forcedTimer) clearTimeout(forcedTimer);
		signal.removeEventListener("abort", abort);
		active.off("message", onMessage);
		active.off("error", onError);
		active.off("exit", onExit);
		const durationMs = performance.now() - startedAt;
		if (durationMs > 2000) {
			logger.warn("Slow untracked Git line statistics batch", {
				durationMs,
				files: request.paths.length,
				failed,
			});
		}
		if (!failed) {
			active.unref();
			idleTimer = setTimeout(() => {
				if (thread === active) {
					thread = undefined;
					void active.terminate();
				}
			}, WORKER_IDLE_MS);
			idleTimer.unref();
		}
	}
}

/** Raw local measurement: no server TTL, status request, remote call, or shared in-flight cache. */
export async function getGitLineStats(cwd: string, signal?: AbortSignal): Promise<GitLineStats> {
	signal?.throwIfAborted();
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
	let offset = 0;
	while (untrackedPaths.length < MAX_UNTRACKED_FILES) {
		const end = untrackedOutput.output.indexOf("\0", offset);
		if (end < 0) break;
		const path = untrackedOutput.output.slice(offset, end);
		offset = end + 1;
		if (path) untrackedPaths.push(path);
	}
	const listedAll = untrackedOutput.complete && offset === untrackedOutput.output.length;
	const untracked = untrackedPaths.length
		? await readUntracked(cwd, untrackedPaths, combined)
		: { files: [], complete: true };
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
	let filesComplete = true;
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
		const bytes = Buffer.byteLength(JSON.stringify(file), "utf8") + 1;
		if (measured.length >= 10_000 || bytes > remainingOutputBytes) {
			filesComplete = false;
			break;
		}
		remainingOutputBytes -= bytes;
		measured.push(file);
	}
	return {
		files: measured,
		linesAdded: measured.reduce(
			(sum, file) => sum + (file.stagedLinesAdded ?? 0) + (file.unstagedLinesAdded ?? 0),
			0,
		),
		linesRemoved: measured.reduce(
			(sum, file) => sum + (file.stagedLinesRemoved ?? 0) + (file.unstagedLinesRemoved ?? 0),
			0,
		),
		complete:
			staged.complete &&
			unstaged.complete &&
			listedAll &&
			filesComplete &&
			untracked.complete &&
			measured.every((file) => file.complete),
	};
}
