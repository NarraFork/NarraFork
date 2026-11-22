import { spawn } from "node:child_process";
import { GIT_STAGING_LIMITS } from "../../shared/git-staging-lists";
import { terminateGitStatusPageChild } from "./git-status-page-process";

export class GitStagingKernelError extends Error {
	constructor(
		public readonly code: string,
		message: string,
	) {
		super(message);
		this.name = "GitStagingKernelError";
	}
}

let childObserver: ((pid: number, running: boolean) => void) | undefined;
export function observeStagingChildren(observer: (pid: number, running: boolean) => void) {
	childObserver = observer;
}

export interface GitOptions {
	env?: Record<string, string | undefined>;
	input?: string | Uint8Array;
	maxBytes?: number;
	timeoutMs?: number;
	allowFailure?: boolean;
	signal?: AbortSignal;
	truncate?: boolean;
	strictUtf8?: boolean;
}

export function gitStagingEnvironment(overrides?: GitOptions["env"]) {
	const env = { ...process.env };
	for (const name of [
		"GIT_INDEX_FILE",
		"GIT_DIR",
		"GIT_WORK_TREE",
		"GIT_COMMON_DIR",
		"GIT_OBJECT_DIRECTORY",
		"GIT_ALTERNATE_OBJECT_DIRECTORIES",
		"GIT_CONFIG_COUNT",
		"GIT_CONFIG_PARAMETERS",
		"GIT_LITERAL_PATHSPECS",
		"GIT_GLOB_PATHSPECS",
		"GIT_NOGLOB_PATHSPECS",
		"GIT_ICASE_PATHSPECS",
	])
		delete env[name];
	return Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_NO_REPLACE_OBJECTS: "1" }, overrides);
}

/** Worker-only execution. Configuration overrides are process-local, including full indexes. */
export async function stagingGit(cwd: string, args: string[], options: GitOptions = {}) {
	options.signal?.throwIfAborted();
	const env = gitStagingEnvironment(options.env);
	const child = spawn(
		"git",
		[
			"--no-optional-locks",
			"-c",
			"core.splitIndex=false",
			"-c",
			"core.fsmonitor=false",
			"-c",
			"diff.autoRefreshIndex=false",
			...args,
		],
		{
			cwd,
			env,
			stdio: ["pipe", "pipe", "pipe"],
			detached: process.platform !== "win32",
			windowsHide: true,
		},
	);
	if (child.pid) childObserver?.(child.pid, true);
	const budget = options.maxBytes ?? GIT_STAGING_LIMITS.maxPageBytes;
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	let outputBytes = 0;
	let errorBytes = 0;
	let failure: Error | undefined;
	let truncated = false;
	let killing: Promise<void> | undefined;
	const kill = () => {
		killing ??= terminateGitStatusPageChild({
			pid: child.pid ?? 0,
			kill: () => child.kill("SIGKILL"),
		});
	};
	const fail = (code: string, message: string) => {
		failure ??= new GitStagingKernelError(code, message);
		kill();
	};
	child.stdout.on("data", (chunk: Buffer) => {
		const left = Math.max(0, budget - outputBytes);
		if (left) stdout.push(chunk.subarray(0, left));
		outputBytes += chunk.length;
		if (outputBytes > budget) {
			if (options.truncate) {
				truncated = true;
				kill();
			} else fail("GIT_STAGING_LIMIT", "Git staging subprocess exceeded its output budget");
		}
	});
	child.stderr.on("data", (chunk: Buffer) => {
		const left = Math.max(0, 16_384 - errorBytes);
		if (left) stderr.push(chunk.subarray(0, left));
		errorBytes += chunk.length;
		if (errorBytes > 65_536) fail("GIT_STAGING_LIMIT", "Git staging stderr exceeded its budget");
	});
	const abort = () => fail("GIT_STAGING_ABORTED", "Git staging operation was cancelled");
	options.signal?.addEventListener("abort", abort, { once: true });
	const timer = setTimeout(
		() => fail("GIT_STAGING_TIMEOUT", "Git staging subprocess timed out"),
		options.timeoutMs ?? GIT_STAGING_LIMITS.readTimeoutMs,
	);
	child.stdin.on("error", () => {});
	child.stdin.end(options.input);
	try {
		const exitCode = await new Promise<number>((resolve, reject) => {
			child.once("error", reject);
			child.once("close", (code) => resolve(code ?? -1));
			if (options.signal?.aborted) abort();
		});
		await killing;
		if (failure) throw failure;
		const captured = Buffer.concat(stdout);
		let output: string;
		try {
			output = options.strictUtf8
				? new TextDecoder("utf-8", { fatal: true }).decode(captured)
				: captured.toString("utf8");
		} catch {
			throw new GitStagingKernelError(
				"GIT_STAGING_UNSUPPORTED",
				"Git staging paths must use valid UTF-8",
			);
		}
		if (options.truncate && Buffer.byteLength(output) > budget) {
			output = new TextDecoder().decode(Buffer.from(output).subarray(0, budget), { stream: true });
			truncated = true;
		}
		const result = {
			stdout: output,
			bytes: captured,
			stderr: Buffer.concat(stderr).toString("utf8"),
			exitCode,
			truncated,
		};
		if (exitCode !== 0 && !options.allowFailure && !truncated)
			throw new GitStagingKernelError(
				"GIT_STAGING_GIT_FAILED",
				result.stderr.trim() || `Git staging command failed (${args[0]})`,
			);
		return result;
	} finally {
		if (child.pid) childObserver?.(child.pid, false);
		clearTimeout(timer);
		options.signal?.removeEventListener("abort", abort);
	}
}
