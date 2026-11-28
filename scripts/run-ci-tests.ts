import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { type FileHandle, mkdir, open } from "node:fs/promises";
import { resolve } from "node:path";
import type { Writable } from "node:stream";
import {
	type NativeDiagnosticFailure,
	type NativeDiagnosticsOptions,
	openNativeDiagnostics,
} from "./ci-native-diagnostics";

export const CI_TEST_TIMEOUT_MS = 30 * 60 * 1_000;
export const CI_TEST_OUTPUT_LIMIT_BYTES = 64 * 1024 * 1024;
export const CI_TEST_CHUNK_BYTES = 64 * 1024;
export const CI_TEST_KILL_GRACE_MS = 1_000;
export const CI_TEST_TIMINGS_SOURCE = ".github/test-timings.json";
export const CI_TEST_TIMINGS_PATH = "artifacts/ci-test-timings.json";
export const CI_TEST_TIMINGS_MAX_BYTES = 512 * 1024;
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
	diagnostics?: NativeDiagnosticsOptions;
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

/** Preserve native discovery/isolation; accept only the legacy or fixed balanced CI invocation. */
export function buildNativeTestCommand(args: readonly string[]): string[] {
	const fixed = [
		"--isolate",
		"--only-failures",
		"--reporter=junit",
		"--reporter-outfile=artifacts/ci-tests.xml",
	];
	const balanced = ["--parallel=2", `--timings=${CI_TEST_TIMINGS_PATH}`, "--update-timings"];
	const usesBalanced = balanced.some((flag) => args.includes(flag));
	const required = usesBalanced ? [...fixed, ...balanced] : fixed;
	if (
		args.length !== required.length + 1 ||
		required.some((flag) => args.filter((argument) => argument === flag).length !== 1) ||
		args.filter((argument) => /^--shard=[1-4]\/4$/.test(argument)).length !== 1
	) {
		throw new Error(
			"Expected --isolate --only-failures --shard=N/4 --reporter=junit --reporter-outfile=artifacts/ci-tests.xml (N=1..4), optionally with --parallel=2 --timings=artifacts/ci-test-timings.json --update-timings",
		);
	}
	return [process.execPath, "test", ...args];
}

export type NativeTestTimings = { version: 1; files: Record<string, number> };

/** Timings are scheduling hints only: native Bun still discovers every test file. */
export function validateNativeTestTimings(value: unknown): NativeTestTimings {
	if (typeof value !== "object" || value === null || Array.isArray(value))
		throw new Error("Invalid native test timings");
	const record = value as Record<string, unknown>;
	if (
		Object.keys(record).sort().join(",") !== "files,version" ||
		record.version !== 1 ||
		typeof record.files !== "object" ||
		record.files === null ||
		Array.isArray(record.files)
	)
		throw new Error("Invalid native test timings");
	const entries = Object.entries(record.files);
	if (entries.length > 8192) throw new Error("Native test timings entry limit exceeded");
	const files: Record<string, number> = Object.create(null);
	for (const [path, duration] of entries) {
		if (
			Buffer.byteLength(path) > 512 ||
			path.includes("\\") ||
			path.includes("\0") ||
			path.includes(":") ||
			path.split("/").some((part) => !part || part === "." || part === "..") ||
			!/(?:\.|_)(?:test|spec)\.(?:[cm]?[jt]s|[jt]sx)$/.test(path) ||
			typeof duration !== "number" ||
			!Number.isFinite(duration) ||
			duration < 0 ||
			duration > CI_TEST_TIMEOUT_MS
		)
			throw new Error("Invalid native test timings entry");
		files[path] = duration;
	}
	return { version: 1, files };
}

/** Copy validated hints into owned artifacts; never update the checked-in baseline. */
export async function prepareNativeTestTimings(
	args: readonly string[],
	cwd: string,
	signal?: AbortSignal,
): Promise<void> {
	buildNativeTestCommand(args);
	if (!args.includes(`--timings=${CI_TEST_TIMINGS_PATH}`)) return;
	signal?.throwIfAborted();
	const source = await open(
		resolve(cwd, CI_TEST_TIMINGS_SOURCE),
		constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
	);
	let content: string;
	try {
		const stat = await source.stat();
		if (!stat.isFile() || stat.size > CI_TEST_TIMINGS_MAX_BYTES)
			throw new Error("Native test timings input size/type limit exceeded");
		const bytes = Buffer.alloc(CI_TEST_TIMINGS_MAX_BYTES + 1);
		let length = 0;
		while (length < bytes.length) {
			signal?.throwIfAborted();
			const { bytesRead } = await source.read(bytes, length, bytes.length - length, null);
			if (bytesRead === 0) break;
			length += bytesRead;
		}
		if (length > CI_TEST_TIMINGS_MAX_BYTES)
			throw new Error("Native test timings input byte limit exceeded");
		content = JSON.stringify(
			validateNativeTestTimings(JSON.parse(bytes.subarray(0, length).toString("utf8"))),
		);
	} finally {
		await source.close();
	}
	signal?.throwIfAborted();
	await mkdir(resolve(cwd, "artifacts"), { recursive: true });
	const destination = await open(resolve(cwd, CI_TEST_TIMINGS_PATH), "wx", 0o600);
	try {
		await destination.writeFile(content);
	} finally {
		await destination.close();
	}
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
	const diagnostics =
		options.diagnostics && openNativeDiagnostics(artifacts, name, options.diagnostics);
	let childExitCode: number | null | undefined;
	let childSignal: NodeJS.Signals | null = null;
	let runnerFailed = false;
	const failure = (): NativeDiagnosticFailure | null =>
		result.timedOut
			? "timeout"
			: result.cancelled
				? "abort"
				: result.outputLimitExceeded
					? "output-limit"
					: result.error || runnerFailed
						? "error"
						: childSignal
							? "signal"
							: childExitCode
								? "nonzero-exit"
								: null;
	const observedSizes = [0, 0];
	const diagnosticState = (exitCode?: number) => ({
		pid: result.pid,
		stdoutBytes: exitCode === undefined ? (observedSizes[0] ?? 0) : result.stdoutBytes,
		stderrBytes: exitCode === undefined ? (observedSizes[1] ?? 0) : result.stderrBytes,
		exitCode: exitCode ?? childExitCode ?? undefined,
		signal: childSignal,
		failure: failure(),
	});
	const diagnose = (event: "timeout" | "abort" | "output-limit" | "error") => {
		if (diagnostics?.record(event, diagnosticState())) diagnostics.sample(event, diagnosticState());
	};
	diagnostics?.record("start", diagnosticState());
	try {
		// Exclusive creation and private permissions retain evidence from every invocation.
		const stdout = await open(result.stdoutLog, "wx+", 0o600);
		handles.push(stdout);
		const stderr = await open(result.stderrLog, "wx+", 0o600);
		handles.push(stderr);
		if (options.signal?.aborted) {
			result.cancelled = true;
			diagnose("abort");
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
		const stopFor = (event: "timeout" | "abort" | "output-limit" | "error") => {
			haltForwarding();
			// Do not postpone watchdog/abort signals to collect diagnostic evidence.
			terminate();
			diagnose(event);
		};
		const observeSize = (index: 0 | 1, size: number, fromStat = false) => {
			if (!diagnostics) return;
			const previous = observedSizes[index] ?? 0;
			if (size > previous || (fromStat && size !== previous)) diagnostics.activity(index);
			if (fromStat || size > previous) observedSizes[index] = size;
		};
		const sampleSize = async () => {
			const [out, err] = await Promise.all([stdout.stat(), stderr.stat()]);
			result.stdoutBytes = out.size;
			result.stderrBytes = err.size;
			observeSize(0, out.size, true);
			observeSize(1, err.size, true);
			if (out.size + err.size >= maxOutputBytes) {
				result.outputLimitExceeded = true;
				stopFor("output-limit");
			}
		};
		let watchdogDeadline = 0;
		const checkSize = async () => {
			if (checking) return;
			checking = true;
			try {
				await sampleSize();
				if (!termination && !finished) {
					diagnostics?.progress(diagnosticState(), watchdogDeadline - performance.now());
				}
			} catch (error) {
				recordError(error);
				stopFor("error");
			} finally {
				checking = false;
			}
		};
		const abort = () => {
			result.cancelled = true;
			stopFor("abort");
		};
		const exited = new Promise<number>((done) => {
			child.once("error", (error) => {
				recordError(error);
				stopFor("error");
				done(1);
			});
			child.once("exit", (code, signal) => {
				childExitCode = code;
				childSignal = signal;
				done(code ?? 1);
			});
		});
		options.signal?.addEventListener("abort", abort, { once: true });
		// Recheck after listener installation; pre-abort never reaches spawn above.
		if (options.signal?.aborted) abort();
		watchdogDeadline = performance.now() + timeoutMs;
		const watchdog = setTimeout(() => {
			result.timedOut = true;
			stopFor("timeout");
		}, timeoutMs);
		diagnostics?.record("spawn", diagnosticState());
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
						observeSize(index === 0 ? 0 : 1, offsets[index] ?? 0);
						// Offsets enforce the cap too, even if a child truncates its log between stats.
						if (forwarded >= maxOutputBytes) {
							result.outputLimitExceeded = true;
							stopFor("output-limit");
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
				stopFor("error");
			}
		})();
		let code = 1;
		try {
			code = await exited;
			// Never leave this invocation's background descendants running after its leader.
			if (groupExists()) terminate();
			if (childExitCode !== undefined) {
				const state = diagnosticState();
				diagnostics?.record("child-exit", state);
				if (state.failure === "nonzero-exit" || state.failure === "signal") {
					diagnostics?.sample("child-exit", state);
				}
			}
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
	} catch (error) {
		runnerFailed = true;
		throw error;
	} finally {
		if (result.error || runnerFailed) diagnose("error");
		diagnostics?.record("exit", diagnosticState(result.exitCode));
		diagnostics?.close();
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
		const args = process.argv.slice(2);
		const command = buildNativeTestCommand(args);
		const shard = args.find((arg) => arg.startsWith("--shard="))?.slice("--shard=".length);
		const [shardIndex, shardTotal] = shard?.split("/").map(Number) ?? [];
		await prepareNativeTestTimings(args, process.cwd(), controller.signal);
		const result = await runWithFileStdio({
			command,
			diagnostics: {
				shardIndex: shardIndex ?? 0,
				shardTotal: shardTotal ?? 0,
				parallel: args.includes("--parallel=2") ? 2 : null,
			},
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
