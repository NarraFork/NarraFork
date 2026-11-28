import type { GitStatusPageFile, GitStatusPageLimitReason } from "../../shared/git-status-page";
import { terminateGitStatusPageChild } from "./git-status-page-process";
import { GitStatusPageError, type GitStatusPageRawResult } from "./git-status-page-protocol";

export const GIT_STATUS_PAGE_MAX_RECORDS = 10_000;
export const GIT_STATUS_PAGE_SCAN_BYTES = 1024 * 1024;
export const GIT_STATUS_PAGE_SCAN_TIMEOUT_MS = 30_000;

/** Incremental porcelain-v1 -z parser; a rename is one record only after both paths arrive. */
export class GitStatusPageParser {
	readonly files: GitStatusPageFile[] = [];
	limitReason: GitStatusPageLimitReason | undefined;
	private readonly decoder = new TextDecoder("utf-8", { fatal: true });
	private pending = "";
	private rename: GitStatusPageFile | undefined;
	private bytes = 0;

	push(chunk: Uint8Array): boolean {
		if (this.limitReason) return false;
		const remaining = GIT_STATUS_PAGE_SCAN_BYTES - this.bytes;
		const accepted = chunk.subarray(0, remaining);
		this.bytes += accepted.byteLength;
		this.pending += this.decoder.decode(accepted, { stream: true });
		let start = 0;
		while (true) {
			const end = this.pending.indexOf("\0", start);
			if (end < 0) break;
			const token = this.pending.slice(start, end);
			start = end + 1;
			let file: GitStatusPageFile;
			if (this.rename) {
				if (!token)
					throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED", "Invalid rename path");
				file = { ...this.rename, oldPath: token };
				this.rename = undefined;
			} else {
				if (token.length < 4 || token[2] !== " ")
					throw new GitStatusPageError(
						"GIT_STATUS_PAGE_SOURCE_FAILED",
						"Invalid Git status record",
					);
				file = { status: token.slice(0, 2), path: token.slice(3) };
				if (/[RC]/.test(file.status)) {
					this.rename = file;
					continue;
				}
			}
			this.files.push(file);
			if (this.files.length >= GIT_STATUS_PAGE_MAX_RECORDS) {
				this.limitReason = "records";
				this.pending = "";
				return false;
			}
		}
		this.pending = this.pending.slice(start);
		if (accepted.byteLength < chunk.byteLength) this.limitReason = "bytes";
		return !this.limitReason;
	}

	finish(complete: boolean): void {
		if (complete && (this.decoder.decode() || this.pending || this.rename))
			throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED", "Incomplete Git status record");
		this.pending = "";
		this.rename = undefined;
	}
}

export interface GitStatusPageScan {
	files: GitStatusPageFile[];
	complete: boolean;
	limitReason?: GitStatusPageLimitReason;
}

export function parseGitStatusPageRaw(result: GitStatusPageRawResult): GitStatusPageScan {
	const parser = new GitStatusPageParser();
	// Encode in bounded pieces so a malformed remote response cannot allocate another huge buffer.
	for (let offset = 0; offset < result.stdout.length; ) {
		let end = Math.min(offset + 16_384, result.stdout.length);
		const code = result.stdout.charCodeAt(end - 1);
		if (end < result.stdout.length && code >= 0xd800 && code <= 0xdbff) end--;
		if (!parser.push(new TextEncoder().encode(result.stdout.slice(offset, end)))) break;
		offset = end;
	}
	const complete = result.complete === true && !result.limitReason && !parser.limitReason;
	parser.finish(complete);
	return {
		files: parser.files,
		complete,
		limitReason:
			parser.limitReason ?? result.limitReason ?? (complete ? undefined : "remote-incomplete"),
	};
}

/** Owns exactly one read-only Git child; all exit paths drain pipes and await child cleanup. */
export async function scanGitStatusPage(
	cwd: string,
	signal: AbortSignal,
): Promise<GitStatusPageScan> {
	signal.throwIfAborted();
	const parser = new GitStatusPageParser();
	const child = Bun.spawn(
		[
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
		{
			cwd,
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			windowsHide: true,
			// POSIX Git helpers share a private process group owned by this scan.
			detached: process.platform !== "win32",
			env: {
				PATH: process.env.PATH,
				SystemRoot: process.env.SystemRoot,
				WINDIR: process.env.WINDIR,
				HOME: process.env.HOME,
				USERPROFILE: process.env.USERPROFILE,
				TMPDIR: process.env.TMPDIR,
				TMP: process.env.TMP,
				TEMP: process.env.TEMP,
				GIT_OPTIONAL_LOCKS: "0",
				GIT_TERMINAL_PROMPT: "0",
				GIT_NO_REPLACE_OBJECTS: "1",
				LC_ALL: "C",
			},
		},
	);
	let reason: GitStatusPageLimitReason | undefined;
	let parseError: unknown;
	let cleanup: Promise<void> | undefined;
	let finished = false;
	const kill = () => {
		cleanup ??= terminateGitStatusPageChild(child);
	};
	const abort = () => kill();
	signal.addEventListener("abort", abort, { once: true });
	if (signal.aborted) abort();
	const timer = setTimeout(() => {
		reason = "timeout";
		kill();
	}, GIT_STATUS_PAGE_SCAN_TIMEOUT_MS);
	const stdout = async () => {
		try {
			for await (const chunk of child.stdout) {
				if (reason || signal.aborted || parseError) continue;
				try {
					if (!parser.push(chunk)) {
						reason = parser.limitReason;
						kill();
					}
				} catch (error) {
					parseError = error;
					kill();
				}
			}
		} catch (error) {
			parseError ??= error;
			kill();
		}
	};
	const stderr = async () => {
		// Error text is never retained or returned to clients; pipes must still be drained.
		try {
			for await (const _chunk of child.stderr) {
				/* drain */
			}
		} catch {
			kill();
		}
	};
	try {
		const [, , code] = await Promise.all([stdout(), stderr(), child.exited]);
		finished = true;
		signal.throwIfAborted();
		if (parseError) throw parseError;
		if (!reason && code !== 0)
			throw new GitStatusPageError("GIT_STATUS_PAGE_SOURCE_FAILED", "Git status failed");
		parser.finish(!reason);
		return { files: parser.files, complete: !reason, limitReason: reason };
	} finally {
		clearTimeout(timer);
		signal.removeEventListener("abort", abort);
		if (!finished) kill();
		await cleanup;
		await child.exited;
	}
}
