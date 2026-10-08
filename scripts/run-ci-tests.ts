import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";

export const CI_TEST_TIMEOUT_MS = 30 * 60 * 1_000;
export const CI_TEST_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const CI_TEST_CHUNK_BYTES = 64 * 1024;
export const CI_TEST_KILL_GRACE_MS = 1_000;
const POLL_MS = 25;
const KILL_GRACE_MS = 5_000;

export type FileStdioOptions = {
	command: readonly string[];
	cwd: string;
	timeoutMs?: number;
	maxOutputBytes?: number;
	killGraceMs?: number;
	signal?: AbortSignal;
	onStdout?: (chunk: Uint8Array) => void | Promise<void>;
	onStderr?: (chunk: Uint8Array) => void | Promise<void>;
};

export type FileStdioResult = {
	exitCode: number;
	timedOut: boolean;
	cancelled: boolean;
	outputLimitExceeded: boolean;
	stdoutLog: string;
	stderrLog: string;
	stdoutBytes: number;
	stderrBytes: number;
	pid?: number;
	error?: string;
};

function integerBudget(name: string, value: number, maximum: number, minimum = 1): number {
	if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
		throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
	}
	return value;
}

/** Validate the CI contract without translating, adding or dropping any native Bun argument. */
export function buildNativeTestCommand(args: readonly string[]): string[] {
	const fixed = [
		"--isolate",
		"--only-failures",
		"--reporter=junit",
		"--reporter-outfile=artifacts/ci-tests.xml",
	];
	if (
		args.length !== 5 ||
		fixed.some((flag) => args.filter((argument) => argument === flag).length !== 1) ||
		args.filter((argument) => /^--shard=[1-4]\/4$/.test(argument)).length !== 1
	) {
		throw new Error(
			"Expected --isolate --only-failures --shard=N/4 --reporter=junit --reporter-outfile=artifacts/ci-tests.xml (N=1..4)",
		);
	}
	return [process.execPath, "test", ...args];
}

const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

/**
 * Only the spawned process owns a detached process group. Its fd 1/2 are regular files,
 * not pipes: this avoids the pinned Bun native spawnSync poll bug without changing tests.
 * The parent asynchronously forwards bounded chunks; it never buffers an entire log.
 */
export async function runWithFileStdio(options: FileStdioOptions): Promise<FileStdioResult> {
	const timeoutMs = integerBudget(
		"timeoutMs",
		options.timeoutMs ?? CI_TEST_TIMEOUT_MS,
		CI_TEST_TIMEOUT_MS,
	);
	const maxOutputBytes = integerBudget(
		"maxOutputBytes",
		options.maxOutputBytes ?? CI_TEST_OUTPUT_LIMIT_BYTES,
		CI_TEST_OUTPUT_LIMIT_BYTES,
	);
	const killGraceMs = integerBudget(
		"killGraceMs",
		options.killGraceMs ?? KILL_GRACE_MS,
		KILL_GRACE_MS,
		0,
	);
	if (
		options.command.length === 0 ||
		options.command.some((part) => typeof part !== "string" || part.includes("\0")) ||
		!options.command[0] ||
		!options.cwd ||
		options.cwd.includes("\0")
	) {
		throw new Error("A nonempty command and cwd without NUL bytes are required");
	}
	if (process.platform === "win32") {
		throw new Error("CI file-stdio runner requires POSIX detached process groups");
	}
	const artifacts = resolve(options.cwd, "artifacts");
	await mkdir(artifacts, { recursive: true });
	const name = `native-tests-${Date.now()}-${randomUUID()}`;
	const result: FileStdioResult = {
		exitCode: 1,
		timedOut: false,
		cancelled: false,
		outputLimitExceeded: false,
		stdoutLog: resolve(artifacts, `${name}-stdout.log`),
		stderrLog: resolve(artifacts, `${name}-stderr.log`),
		stdoutBytes: 0,
		stderrBytes: 0,
	};
	const handles: FileHandle[] = [];
	try {
		// Exclusive creation and private permissions retain evidence from every invocation.
		const stdout = await open(result.stdoutLog, "wx+", 0o600);
		handles.push(stdout);
		const stderr = await open(result.stderrLog, "wx+", 0o600);
		handles.push(stderr);
		if (options.signal?.aborted) {
			result.cancelled = true;
			return result;
		}
		const child = spawn(options.command[0], options.command.slice(1), {
			cwd: options.cwd,
			stdio: ["ignore", stdout.fd, stderr.fd],
			detached: true,
		});
		result.pid = child.pid;
		let finished = false;
		let checking = false;
		let termination: Promise<void> | undefined;
		let forwarded = 0;
		let stopForwarding: (() => void) | undefined;
		let forwardingStopped = false;
		const stopped = new Promise<void>((done) => {
			stopForwarding = done;
		});
		const haltForwarding = () => {
			forwardingStopped = true;
			stopForwarding?.();
		};
		const offsets = [0, 0];
		const callbacks = [options.onStdout, options.onStderr];
		const recordError = (error: unknown) => {
			result.error ??= error instanceof Error ? error.message : String(error);
			haltForwarding();
		};
		const groupExists = () => {
			if (!child.pid) return false;
			try {
				process.kill(-child.pid, 0);
				return true;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") recordError(error);
				return false;
			}
		};
		const sendSignal = (signal: NodeJS.Signals) => {
			if (!child.pid) return;
			try {
				process.kill(-child.pid, signal);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ESRCH") recordError(error);
			}
		};
		const terminate = () => {
			termination ??= (async () => {
				sendSignal("SIGTERM");
				const deadline = performance.now() + killGraceMs;
				while (groupExists() && performance.now() < deadline) {
					await delay(Math.min(POLL_MS, Math.max(1, deadline - performance.now())));
				}
				// Also kill descendants if the group leader exited on SIGTERM.
				if (groupExists()) {
					sendSignal("SIGKILL");
					// Give killed descendants a scheduling turn to release their inherited fds.
					await delay(POLL_MS);
				}
			})();
		};
		const sampleSize = async () => {
			const [out, err] = await Promise.all([stdout.stat(), stderr.stat()]);
			result.stdoutBytes = out.size;
			result.stderrBytes = err.size;
			if (out.size + err.size >= maxOutputBytes) {
				result.outputLimitExceeded = true;
				haltForwarding();
				terminate();
			}
		};
		const checkSize = async () => {
			if (checking) return;
			checking = true;
			try {
				await sampleSize();
			} catch (error) {
				recordError(error);
				terminate();
			} finally {
				checking = false;
			}
		};
		const abort = () => {
			result.cancelled = true;
			haltForwarding();
			terminate();
		};
		const exited = new Promise<number>((done) => {
			child.once("error", (error) => {
				recordError(error);
				terminate();
				done(1);
			});
			child.once("exit", (code) => done(code ?? 1));
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		// Recheck after listener installation; pre-abort never reaches spawn above.
		if (options.signal?.aborted) abort();
		const watchdog = setTimeout(() => {
			result.timedOut = true;
			haltForwarding();
			terminate();
		}, timeoutMs);
		// Independent of forwarding/backpressure: a slow terminal cannot disable budgets.
		const sizeTimer = setInterval(() => void checkSize(), POLL_MS);
		const forwarding = (async () => {
			const buffer = Buffer.alloc(CI_TEST_CHUNK_BYTES);
			try {
				while (true) {
					let received = false;
					for (const [index, handle] of handles.entries()) {
						if (forwardingStopped) break;
						const remaining = maxOutputBytes - forwarded;
						if (remaining <= 0) break;
						const { bytesRead } = await handle.read(
							buffer,
							0,
							Math.min(buffer.length, remaining),
							offsets[index],
						);
						if (!bytesRead) continue;
						received = true;
						offsets[index] = (offsets[index] ?? 0) + bytesRead;
						forwarded += bytesRead;
						// Offsets enforce the cap too, even if a child truncates its log between stats.
						if (forwarded >= maxOutputBytes) {
							result.outputLimitExceeded = true;
							haltForwarding();
							terminate();
							break;
						}
						await Promise.race([
							Promise.resolve(callbacks[index]?.(buffer.subarray(0, bytesRead))),
							stopped,
						]);
					}
					if (forwardingStopped || forwarded >= maxOutputBytes || (finished && !received)) break;
					if (!received) await delay(POLL_MS);
				}
			} catch (error) {
				recordError(error);
				terminate();
			}
		})();
		let code = 1;
		try {
			code = await exited;
			// Never leave this invocation's background descendants running after its leader.
			if (groupExists()) terminate();
			await termination;
			await sampleSize();
			await termination;
			finished = true;
			await forwarding;
			await termination;
		} finally {
			finished = true;
			haltForwarding();
			clearTimeout(watchdog);
			clearInterval(sizeTimer);
			options.signal?.removeEventListener("abort", abort);
			// Join any in-flight stat/forwarder before closing fds or deciding success.
			while (checking) await delay(1);
			await forwarding;
			await termination;
		}
		result.exitCode =
			result.error || result.timedOut || result.cancelled || result.outputLimitExceeded
				? code || 1
				: code;
		return result;
	} finally {
		await Promise.all(handles.map((handle) => handle.close()));
	}
}

function forwardTo(stream: Writable): (chunk: Uint8Array) => Promise<void> {
	return (chunk) =>
		new Promise<void>((done, reject) => {
			stream.write(chunk, (error) => (error ? reject(error) : done()));
		});
}

if (import.meta.main) {
	const controller = new AbortController();
	const cancel = () => controller.abort();
	process.on("SIGINT", cancel);
	process.on("SIGTERM", cancel);
	// A closed CI console must not crash the parent before its owned group is cleaned up.
	process.stdout.on("error", cancel);
	process.stderr.on("error", cancel);
	try {
		const result = await runWithFileStdio({
			command: buildNativeTestCommand(process.argv.slice(2)),
			cwd: process.cwd(),
			// Finish owned-group escalation before the outer 30-minute watchdog's 5s kill.
			killGraceMs: CI_TEST_KILL_GRACE_MS,
			signal: controller.signal,
			onStdout: forwardTo(process.stdout),
			onStderr: forwardTo(process.stderr),
		});
		console.error(
			`CI native tests: exit=${result.exitCode} timeout=${result.timedOut} cancelled=${result.cancelled} outputLimit=${result.outputLimitExceeded}\nLogs: ${result.stdoutLog}, ${result.stderrLog}${result.error ? `\n${result.error}` : ""}`,
		);
		process.exitCode = result.exitCode;
	} catch (error) {
		console.error(error instanceof Error ? error.message : String(error));
		process.exitCode = 1;
	} finally {
		process.off("SIGINT", cancel);
		process.off("SIGTERM", cancel);
		process.stdout.off("error", cancel);
		process.stderr.off("error", cancel);
	}
	// Successful forwards have already drained. On failure, a blocked console write must
	// not keep this CLI alive after watchdog/cancellation and owned-group cleanup.
	process.exit(process.exitCode ?? 1);
}
