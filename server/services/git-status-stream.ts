import { GitError } from "../lib/errors";
import { safeSpawn } from "../lib/spawn";
import type { GitStatusFile } from "./git-service";

export const GIT_STATUS_MAX_FILES = 200;
export const GIT_STATUS_MAX_RECORDS = 10_000;
export const GIT_STATUS_MAX_BYTES = 1024 * 1024;
export const GIT_STATUS_TIMEOUT_MS = 30_000;

/** Incremental porcelain-v1 -z parser. Rename/copy counts only after BOTH paths arrive. */
export class GitStatusStreamParser {
	readonly files: GitStatusFile[] = [];
	staged = 0;
	unstaged = 0;
	untracked = 0;
	totalFiles = 0;
	budgetReached = false;
	private readonly decoder = new TextDecoder();
	private pending = "";
	private rename: GitStatusFile | undefined;

	constructor(
		private readonly maxRecords = GIT_STATUS_MAX_RECORDS,
		private readonly maxFiles = GIT_STATUS_MAX_FILES,
	) {}

	push(chunk: Uint8Array): boolean {
		if (this.budgetReached) return false;
		this.pending += this.decoder.decode(chunk, { stream: true });
		let start = 0;
		while (true) {
			const end = this.pending.indexOf("\0", start);
			if (end < 0) break;
			const token = this.pending.slice(start, end);
			start = end + 1;
			let entry: GitStatusFile;
			if (this.rename) {
				entry = { ...this.rename, oldPath: token };
				this.rename = undefined;
			} else {
				if (token.length < 4 || token[2] !== " ") throw new GitError("Invalid Git status record");
				entry = { status: token.slice(0, 2), path: token.slice(3) };
				if (/[RC]/.test(entry.status)) {
					this.rename = entry;
					continue;
				}
			}
			if (this.files.length < this.maxFiles) this.files.push(entry);
			this.totalFiles++;
			if (entry.status === "??") this.untracked++;
			else {
				if (entry.status[0] !== " " && entry.status[0] !== "?") this.staged++;
				if (entry.status[1] !== " " && entry.status[1] !== "?") this.unstaged++;
			}
			if (this.totalFiles >= this.maxRecords) {
				this.budgetReached = true;
				this.pending = "";
				return false;
			}
		}
		this.pending = this.pending.slice(start);
		return true;
	}

	/** Incomplete trailing records are valid only when the runner stopped at a budget. */
	finish(complete: boolean): void {
		const final = this.decoder.decode();
		if (complete && (this.pending || this.rename || final))
			throw new GitError("Incomplete Git status record");
		this.pending = "";
		this.rename = undefined;
	}
}

export async function readGitStatusStream(cwd: string, signal: AbortSignal) {
	signal.throwIfAborted();
	const parser = new GitStatusStreamParser();
	let parsedBytes = 0;
	let parseMs = 0;
	const startedAt = performance.now();
	const result = await safeSpawn({
		cmd: [
			"git",
			"--no-optional-locks",
			"--literal-pathspecs",
			"-c",
			"core.fsmonitor=false",
			"status",
			"--porcelain=v1",
			"-z",
			"-uall",
			"--",
			".",
		],
		cwd,
		signal,
		timeout: GIT_STATUS_TIMEOUT_MS,
		maxStderrBytes: 4096,
		stdoutStream: {
			maxBytes: GIT_STATUS_MAX_BYTES,
			onChunk: (chunk) => {
				parsedBytes += chunk.byteLength;
				const parseStartedAt = performance.now();
				try {
					return parser.push(chunk);
				} finally {
					parseMs += performance.now() - parseStartedAt;
				}
			},
		},
	});
	signal.throwIfAborted();
	if (result.terminationReason === "timeout") throw new GitError("Git status timed out");
	const budgetReason =
		result.terminationReason === "consumer" && parser.budgetReached
			? "records"
			: result.terminationReason === "output-limit"
				? "bytes"
				: undefined;
	if (!budgetReason && (result.exitCode !== 0 || result.terminationReason))
		throw new GitError("Git status failed");
	parser.finish(!budgetReason);
	return {
		parser,
		budgetReason,
		diagnostics: {
			wallMs: Math.round(performance.now() - startedAt),
			parseMs: Math.round(parseMs * 100) / 100,
			parsedBytes,
			maxBytes: GIT_STATUS_MAX_BYTES,
		},
	};
}
