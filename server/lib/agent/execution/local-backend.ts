/**
 * LocalBackend — the default execution backend that operates on the server's
 * own filesystem and spawns processes locally.
 *
 * This is a faithful extraction of the raw IO the tools previously performed
 * inline (Bun.file / node:fs / Bun.spawn / node:child_process). Behaviour is
 * intentionally identical so the abstraction refactor changes nothing for the
 * local target.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { lstat, readdir, unlink } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import { getHome, IS_WINDOWS } from "../../platform";
import { toForwardSlash } from "../../platform-path";
import { resolveRgPath } from "../../ripgrep";
import { loadSettings } from "../../settings";
import { clearInheritableHandlesBeforeSpawn } from "../../win-handle-guard";
import { buildMinimalEnv, detectShell, killTree } from "../shell";
import type {
	DevicePlatform,
	DirEntry,
	ExecHandle,
	ExecParams,
	ExecutionBackend,
	FileStat,
	GitDiffParams,
	GlobOptions,
	GrepParams,
	GrepResult,
	ReadBytesOptions,
	ReadBytesResult,
} from "./backend";
import { LOCAL_DEVICE_ID } from "./backend";

/** Drain a byte stream up to `maxBytes`, killing the producer once exceeded. */
async function drainBytesWithLimit(
	stream: ReadableStream<Uint8Array>,
	maxBytes: number,
	onLimit: () => void,
): Promise<{ bytes: Uint8Array; truncated: boolean }> {
	const reader = stream.getReader();
	const chunks: Uint8Array[] = [];
	let total = 0;
	let truncated = false;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			if (truncated) continue;
			if (total + value.byteLength <= maxBytes) {
				chunks.push(value);
				total += value.byteLength;
			} else {
				const remaining = maxBytes - total;
				if (remaining > 0) {
					chunks.push(value.subarray(0, remaining));
					total += remaining;
				}
				truncated = true;
				onLimit();
			}
		}
	} catch {
		// Reader released (e.g. process killed) — return what we have.
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(total);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return { bytes, truncated };
}

/** Wrap a node ChildProcess into the ExecHandle contract. */
class LocalExecHandle implements ExecHandle {
	readonly pid?: number;
	private proc: ChildProcess;
	private exitedFlag = false;
	readonly exited: Promise<number | null>;

	constructor(proc: ChildProcess) {
		this.proc = proc;
		this.pid = proc.pid ?? undefined;
		this.exited = new Promise<number | null>((resolvePromise, reject) => {
			if (proc.exitCode !== null) {
				this.exitedFlag = true;
				resolvePromise(proc.exitCode);
				return;
			}
			proc.once("exit", (code) => {
				this.exitedFlag = true;
				resolvePromise(code ?? null);
			});
			proc.once("error", (err) => {
				this.exitedFlag = true;
				reject(err);
			});
		});
	}

	onData(cb: (chunk: Uint8Array) => void): void {
		this.proc.stdout?.on("data", (c: Buffer) => cb(c));
		this.proc.stderr?.on("data", (c: Buffer) => cb(c));
	}

	isExited(): boolean {
		return this.exitedFlag;
	}

	async kill(): Promise<void> {
		await killTree(this.proc, { exited: () => this.exitedFlag });
	}
}

export class LocalBackend implements ExecutionBackend {
	readonly deviceId = LOCAL_DEVICE_ID;
	readonly kind = "local" as const;

	get platform(): DevicePlatform {
		const shell = detectShell();
		return {
			os: process.platform,
			arch: process.arch,
			shellPath: shell.path,
			shellLoginWrap: shell.loginWrap,
			shellType: shell.type,
		};
	}

	async statFile(path: string): Promise<FileStat | null> {
		try {
			const st = await lstat(path);
			return {
				isDirectory: st.isDirectory(),
				isFile: st.isFile(),
				size: st.size,
			};
		} catch {
			return null;
		}
	}

	async fileExists(path: string): Promise<boolean> {
		return existsSync(path);
	}

	async readFileBytes(path: string, opts?: ReadBytesOptions): Promise<ReadBytesResult> {
		const file = Bun.file(path);
		const totalSize = file.size;
		const maxBytes = opts?.maxBytes;
		const buf = new Uint8Array(await file.arrayBuffer());
		if (maxBytes != null && buf.byteLength > maxBytes) {
			return { bytes: buf.subarray(0, maxBytes), truncated: true, totalSize };
		}
		return { bytes: buf, truncated: false, totalSize };
	}

	async writeFileBytes(path: string, bytes: Uint8Array): Promise<void> {
		await Bun.write(path, bytes);
	}

	async removeFile(path: string): Promise<void> {
		try {
			const stat = await lstat(path);
			if (stat.isDirectory()) throw new Error(`Refusing to remove directory: ${path}`);
			await unlink(path);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
			throw error;
		}
	}

	async mkdirp(path: string): Promise<void> {
		mkdirSync(path, { recursive: true });
	}

	async listDir(path: string): Promise<DirEntry[]> {
		const entries = await readdir(path, { withFileTypes: true });
		return entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
	}

	async glob(pattern: string, opts: GlobOptions): Promise<string[]> {
		const glob = new Bun.Glob(pattern);
		const results: string[] = [];
		const max = opts.maxResults ?? 500;
		for await (const entry of glob.scan({ cwd: opts.cwd, dot: opts.dot ?? false })) {
			results.push(toForwardSlash(entry));
			if (results.length >= max) break;
		}
		return results;
	}

	async grep(params: GrepParams): Promise<GrepResult> {
		const rgPath = await resolveRgPath();
		if (rgPath) {
			const rgArgs = buildRipgrepArgv(rgPath, params);
			return this.runSearchProcess(rgArgs, params, { usedFallback: false });
		}

		// ripgrep unavailable — fall back to the system `grep` when present so the
		// search still returns a best-effort result instead of hard-failing.
		const grepPath = Bun.which("grep");
		if (!grepPath) {
			return {
				stdoutBytes: new Uint8Array(0),
				stderr: "",
				exitCode: 2,
				truncatedByBytes: false,
				timedOut: false,
				unavailable: true,
			};
		}

		const isDir = (await this.statFile(params.searchPath))?.isDirectory ?? true;
		const grepArgs = buildGrepFallbackArgv(grepPath, params, isDir);
		const result = await this.runSearchProcess(grepArgs, params, { usedFallback: true });
		// GNU grep -c prints a `path:0` line for every scanned file, whereas rg -c
		// only lists files with matches. Strip zero-count lines to align output.
		if (params.outputMode === "count") {
			result.stdoutBytes = stripZeroCountLines(result.stdoutBytes);
		}
		return result;
	}

	/**
	 * Spawn a ripgrep/grep-compatible search process, draining stdout up to the
	 * byte cap and enforcing a hard timeout. Shared by the rg and grep-fallback
	 * paths since both share the same exit-code + output conventions.
	 */
	private async runSearchProcess(
		argv: string[],
		params: GrepParams,
		opts: { usedFallback: boolean },
	): Promise<GrepResult> {
		const proc = Bun.spawn(argv, {
			cwd: params.cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal: params.signal,
		});

		let timedOut = false;
		const killProc = () => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		};
		const timeoutTimer = setTimeout(() => {
			timedOut = true;
			killProc();
		}, params.timeoutMs);

		try {
			const [stdoutResult, stderrResult] = await Promise.all([
				drainBytesWithLimit(proc.stdout as ReadableStream<Uint8Array>, params.maxBytes, killProc),
				new Response(proc.stderr).text(),
			]);
			const exitCode = await proc.exited;
			return {
				stdoutBytes: stdoutResult.bytes,
				stderr: stderrResult,
				exitCode,
				truncatedByBytes: stdoutResult.truncated,
				timedOut,
				usedFallback: opts.usedFallback,
			};
		} finally {
			clearTimeout(timeoutTimer);
		}
	}

	async execCommand(params: ExecParams): Promise<ExecHandle> {
		const shellInfo = detectShell();
		const isWin = IS_WINDOWS;
		const freshEnv = params.freshEnv ?? loadSettings().agent.freshShellEnv;

		let env: Record<string, string | undefined>;
		if (freshEnv) {
			env = buildMinimalEnv(shellInfo.extraEnv);
		} else {
			env = {
				...process.env,
				HOME: getHome(),
				...shellInfo.extraEnv,
			};
			if (isWin && !env.PATH && process.env.PATH) {
				env.PATH = process.env.PATH;
			}
		}
		if (params.env) env = { ...env, ...params.env };

		let spawnArgs: [string, string[], object];
		if (shellInfo.loginWrap) {
			spawnArgs = [
				shellInfo.path,
				["--login", "-c", params.command],
				{ cwd: params.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false },
			];
		} else if (shellInfo.type === "powershell") {
			const psArgs = freshEnv
				? ["-NonInteractive", "-Command", params.command]
				: ["-NoProfile", "-NonInteractive", "-Command", params.command];
			spawnArgs = [
				shellInfo.path,
				psArgs,
				{ cwd: params.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: false },
			];
		} else if (freshEnv) {
			spawnArgs = [
				shellInfo.path,
				["-l", "-c", params.command],
				{ cwd: params.cwd, env, stdio: ["ignore", "pipe", "pipe"], detached: true },
			];
		} else {
			spawnArgs = [
				params.command,
				[],
				{
					shell: shellInfo.path,
					cwd: params.cwd,
					env,
					stdio: ["ignore", "pipe", "pipe"],
					detached: !isWin,
				},
			];
		}

		clearInheritableHandlesBeforeSpawn();
		const proc = spawn(...spawnArgs);
		const handle = new LocalExecHandle(proc);

		// Honour an abort signal by killing the process tree. The Bash tool also
		// adds its own abort listener for the foreground path; both are idempotent.
		if (params.signal) {
			if (params.signal.aborted) {
				void handle.kill();
			} else {
				const onAbort = () => void handle.kill();
				params.signal.addEventListener("abort", onAbort, { once: true });
				void handle.exited.finally(() => params.signal?.removeEventListener("abort", onAbort));
			}
		}

		return handle;
	}

	async gitStatus(cwd: string, signal?: AbortSignal): Promise<string> {
		const proc = Bun.spawn(["git", "status", "--porcelain"], {
			cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal,
		});
		const [stdout] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
		return stdout;
	}

	async gitDiff(params: GitDiffParams): Promise<string> {
		const maxBytes = params.maxBytes ?? 2 * 1024 * 1024;
		const proc = Bun.spawn(["git", "diff", ...(params.args ?? [])], {
			cwd: params.cwd,
			stdout: "pipe",
			stderr: "pipe",
			signal: params.signal,
		});
		const killProc = () => {
			try {
				proc.kill();
			} catch {
				// already exited
			}
		};
		const [stdoutResult] = await Promise.all([
			drainBytesWithLimit(proc.stdout as ReadableStream<Uint8Array>, maxBytes, killProc),
			proc.exited,
		]);
		return new TextDecoder().decode(stdoutResult.bytes);
	}
}

/** Build the ripgrep argv for a grep request. Exported for testing. */
export function buildRipgrepArgv(rgPath: string, params: GrepParams): string[] {
	const rgArgs: string[] = [rgPath, "--hidden", "--no-messages"];
	if (params.rawBytes) rgArgs.push("--encoding", "none");

	if (params.outputMode === "files_with_matches") {
		rgArgs.push("-l");
	} else if (params.outputMode === "count") {
		rgArgs.push("-c");
	} else {
		if (params.showLineNumbers) rgArgs.push("-n");
		const effectiveC = params.contextLines;
		if (effectiveC != null) {
			rgArgs.push("-C", String(effectiveC));
		} else {
			if (params.beforeContext != null) rgArgs.push("-B", String(params.beforeContext));
			if (params.afterContext != null) rgArgs.push("-A", String(params.afterContext));
		}
	}
	if (params.caseInsensitive) rgArgs.push("-i");
	if (params.multiline) rgArgs.push("-U", "--multiline-dotall");
	if (params.fileType) rgArgs.push("--type", params.fileType);
	if (params.glob) rgArgs.push("--glob", params.glob);
	rgArgs.push("--regexp", params.pattern, params.searchPath);
	return rgArgs;
}

/**
 * Build a best-effort system-`grep` argv that mirrors the ripgrep request as
 * closely as POSIX grep allows. Exported for testing.
 *
 * Fidelity notes (documented in RG_FALLBACK_NOTE for the model):
 * - `-E` treats the pattern as POSIX extended regex — the closest match to rg's
 *   default syntax; rg-only escapes (\d, \b) may not behave identically.
 * - `-s` suppresses error messages (≈ rg --no-messages); `-I` skips binary files
 *   (≈ rg's default binary skipping).
 * - Directory searches add `-r` (recursive). Single-file searches omit both `-r`
 *   and the filename prefix, matching rg's single-file behavior.
 * - `multiline`, `fileType`, and `rawBytes` have no grep equivalent and are dropped.
 * - `-e <pattern>` and `--` guard against patterns/paths beginning with `-`,
 *   preserving the injection-safety of the rg path.
 */
export function buildGrepFallbackArgv(
	grepPath: string,
	params: GrepParams,
	isDir: boolean,
): string[] {
	const args: string[] = [grepPath, "-E", "-s", "-I"];
	if (isDir) args.push("-r");

	if (params.outputMode === "files_with_matches") {
		args.push("-l");
	} else if (params.outputMode === "count") {
		args.push("-c");
	} else {
		if (params.showLineNumbers) args.push("-n");
		const effectiveC = params.contextLines;
		if (effectiveC != null) {
			args.push("-C", String(effectiveC));
		} else {
			if (params.beforeContext != null) args.push("-B", String(params.beforeContext));
			if (params.afterContext != null) args.push("-A", String(params.afterContext));
		}
	}
	if (params.caseInsensitive) args.push("-i");
	// grep's --include only applies to recursive directory searches.
	if (params.glob && isDir) args.push(`--include=${params.glob}`);

	args.push("-e", params.pattern, "--", params.searchPath);
	return args;
}

/**
 * Remove zero-count lines from `grep -c` output so it matches `rg -c`, which
 * only lists files that actually contain matches. Operates on raw bytes to avoid
 * corrupting non-UTF-8 path bytes. Exported for testing.
 *
 * Handles both `path:0` (recursive/multi-file) and a bare `0` (single file).
 */
export function stripZeroCountLines(bytes: Uint8Array): Uint8Array {
	const NEWLINE = 0x0a;
	const COLON = 0x3a;
	const ZERO = 0x30;
	const kept: Uint8Array[] = [];
	let start = 0;
	for (let i = 0; i <= bytes.length; i++) {
		if (i === bytes.length || bytes[i] === NEWLINE) {
			if (i > start) {
				const line = bytes.subarray(start, i);
				// A zero-count line ends in either `:0` or is exactly `0`.
				const isBareZero = line.length === 1 && line[0] === ZERO;
				const isPathZero =
					line.length >= 2 && line[line.length - 1] === ZERO && line[line.length - 2] === COLON;
				if (!isBareZero && !isPathZero) {
					// Re-include the trailing newline when the source had one.
					kept.push(i < bytes.length ? bytes.subarray(start, i + 1) : bytes.subarray(start, i));
				}
			}
			start = i + 1;
		}
	}
	const total = kept.reduce((n, c) => n + c.byteLength, 0);
	const out = new Uint8Array(total);
	let offset = 0;
	for (const chunk of kept) {
		out.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return out;
}

// Re-export for callers that resolve paths against a base.
export { isAbsolute, resolve };

/** Singleton local backend — stateless, safe to share. */
export const localBackend = new LocalBackend();
