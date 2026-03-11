/**
 * Safe process spawning utilities.
 *
 * On Windows, pipe buffers are small (~4 KB).  If stdout or stderr is opened
 * as `"pipe"` but never consumed, the child process blocks on write and never
 * exits — leaking a "Git for Windows" (or any other) process.
 *
 * `safeSpawn` guarantees that both streams are drained in parallel *before*
 * awaiting `proc.exited`, eliminating the deadlock.
 *
 * A Redisson-style watchdog mechanism periodically checks process health:
 *   - If stdout/stderr produced new output since the last check → renew (process is alive)
 *   - If the process PID is gone → kill (zombie cleanup)
 *   - If no output AND pid alive → suspicious but still renew (may be waiting on I/O)
 * The watchdog never hard-kills a healthy process; callers can hook into
 * `onLongRunning` to surface a "terminate" button in the UI.
 */

import { logger } from "./logger";

export interface SafeSpawnResult {
	stdout: string;
	stderr: string;
	exitCode: number;
}

/** Watchdog check interval in milliseconds. */
const WATCHDOG_INTERVAL_MS = 15_000;

/**
 * Callback invoked by the watchdog on each tick.
 * Return `"kill"` to terminate the process, or `"renew"` to let it continue.
 */
export type WatchdogCallback = (info: WatchdogInfo) => "kill" | "renew";

export interface WatchdogInfo {
	/** Total elapsed time since spawn (ms). */
	elapsed: number;
	/** Whether stdout/stderr produced new bytes since the last check. */
	hadOutput: boolean;
	/** Whether the process PID is still alive. */
	pidAlive: boolean;
	/** Number of watchdog ticks so far. */
	tick: number;
}

export interface SafeSpawnOptions {
	/** Command + arguments array, passed directly to `Bun.spawn`. */
	cmd: string[];
	/** Working directory. */
	cwd?: string;
	/** Environment variables. */
	env?: Record<string, string | undefined>;
	/**
	 * Hard timeout in milliseconds.  When elapsed the process is killed
	 * unconditionally (no watchdog check).
	 * No default — callers decide whether a hard timeout is appropriate.
	 */
	timeout?: number;
	/** AbortSignal for external cancellation (e.g. narrator interrupt). */
	signal?: AbortSignal;
	/**
	 * Watchdog callback, invoked every 15 s while the process is running.
	 * If omitted, the default policy is:
	 *   - pid dead + no output → kill
	 *   - otherwise → renew
	 */
	watchdog?: WatchdogCallback;
	/**
	 * Called when the process has been running for a long time (≥60 s).
	 * Useful for agent tools to push a "terminate" button to the UI.
	 * Called at most once per safeSpawn invocation.
	 */
	onLongRunning?: (elapsed: number) => void;
}

/**
 * Check whether a PID is still alive.
 * Uses `process.kill(pid, 0)` which works cross-platform:
 * signal 0 doesn't send a real signal — it just checks if the process exists.
 * Throws ESRCH if the process doesn't exist (both Unix and Windows).
 */
function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

/**
 * Spawn a process and safely drain both stdout and stderr before awaiting exit.
 *
 * This prevents the Windows pipe-buffer deadlock where an unconsumed stderr
 * (or stdout) causes the child to hang forever.
 *
 * Includes a Redisson-style watchdog that periodically checks process health
 * and renews or kills based on output activity and PID liveness.
 */
export async function safeSpawn(opts: SafeSpawnOptions): Promise<SafeSpawnResult> {
	let proc: ReturnType<typeof Bun.spawn>;
	try {
		proc = Bun.spawn(opts.cmd, {
			cwd: opts.cwd,
			env: opts.env,
			stdout: "pipe",
			stderr: "pipe",
		});
	} catch (err) {
		// ENOENT means the executable was not found in PATH (e.g. git not installed)
		if (err instanceof Error && err.message.includes("ENOENT")) {
			const cmd = opts.cmd[0];
			throw new Error(
				`Command "${cmd}" not found. Please ensure it is installed and available in your system PATH.`,
				{ cause: err },
			);
		}
		throw err;
	}

	let killed = false;
	let hardTimer: ReturnType<typeof setTimeout> | undefined;
	let watchdogTimer: ReturnType<typeof setInterval> | undefined;

	const kill = () => {
		if (killed) return;
		killed = true;
		try {
			proc.kill();
		} catch {
			/* already gone */
		}
		// Windows: proc.kill() 只终止主进程，不会杀子进程树。
		// taskkill /T /F 确保整个进程树被清理（如 sh.exe → git.exe 链）。
		if (process.platform === "win32" && proc.pid) {
			try {
				Bun.spawnSync(["taskkill", "/T", "/F", "/PID", String(proc.pid)], {
					stdio: ["ignore", "ignore", "ignore"],
				});
			} catch {
				/* best effort */
			}
		}
	};

	// --- Hard timeout (unconditional kill) ---
	if (opts.timeout != null && opts.timeout > 0) {
		hardTimer = setTimeout(() => {
			logger.warn("safeSpawn: hard timeout, killing", {
				cmd: opts.cmd.join(" "),
				timeout: opts.timeout,
			});
			kill();
		}, opts.timeout);
	}

	// --- External abort ---
	const abortHandler = () => kill();
	if (opts.signal) {
		if (opts.signal.aborted) {
			kill();
		} else {
			opts.signal.addEventListener("abort", abortHandler, { once: true });
		}
	}

	// --- Watchdog (Redisson-style renew/kill) ---
	let lastOutputLength = 0;
	let currentOutputLength = 0;
	let longRunningFired = false;
	const spawnedAt = Date.now();

	// Track output length as streams are consumed
	const trackOutput = (chunk: string) => {
		currentOutputLength += chunk.length;
	};

	if (!killed) {
		let tick = 0;
		watchdogTimer = setInterval(() => {
			if (killed) return;
			tick++;

			const elapsed = Date.now() - spawnedAt;
			const hadOutput = currentOutputLength > lastOutputLength;
			lastOutputLength = currentOutputLength;
			const pidAlive = proc.pid ? isPidAlive(proc.pid) : false;

			const info: WatchdogInfo = { elapsed, hadOutput, pidAlive, tick };

			// Invoke custom or default watchdog
			const decision = opts.watchdog ? opts.watchdog(info) : defaultWatchdog(info);

			if (decision === "kill") {
				logger.warn("safeSpawn: watchdog killed process", {
					cmd: opts.cmd.join(" "),
					elapsed,
					hadOutput,
					pidAlive,
					tick,
				});
				kill();
				return;
			}

			// 60s 阈值后触发一次回调，通知调用方进程长时间运行。
			// 在 agent 工具层中，此回调经 事件总线 → WS 推送到前端显示终止按钮。
			if (!longRunningFired && elapsed >= 60_000 && opts.onLongRunning) {
				longRunningFired = true;
				opts.onLongRunning(elapsed);
			}
		}, WATCHDOG_INTERVAL_MS);
	}

	try {
		// 关键：先并行读完 stdout/stderr 再 await exit。
		// Windows 管道缓冲区仅 4KB，如果不先消费输出，子进程 write() 会阻塞，
		// 而 await proc.exited 又在等子进程退出 → 死锁。
		const [stdout, stderr] = await Promise.all([
			drainStream(proc.stdout as ReadableStream<Uint8Array>, trackOutput),
			drainStream(proc.stderr as ReadableStream<Uint8Array>, trackOutput),
		]);
		const exitCode = await proc.exited;

		return { stdout, stderr, exitCode };
	} finally {
		if (hardTimer != null) clearTimeout(hardTimer);
		if (watchdogTimer != null) clearInterval(watchdogTimer);
		opts.signal?.removeEventListener("abort", abortHandler);
	}
}

/**
 * Default watchdog policy:
 *   - PID dead + no recent output → kill (process leaked / zombie)
 *   - Otherwise → renew
 */
function defaultWatchdog(info: WatchdogInfo): "kill" | "renew" {
	if (!info.pidAlive && !info.hadOutput) return "kill";
	return "renew";
}

/**
 * Read a ReadableStream to completion, calling `onChunk` with each decoded
 * text fragment for output-length tracking.
 */
async function drainStream(
	stream: ReadableStream<Uint8Array>,
	onChunk: (text: string) => void,
): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	const chunks: string[] = [];
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const text = decoder.decode(value, { stream: true });
			chunks.push(text);
			// onChunk 回调更新 currentOutputLength，供看门狗判断进程是否仍有输出
			onChunk(text);
		}
		// Flush any remaining bytes
		const final = decoder.decode();
		if (final) {
			chunks.push(final);
			onChunk(final);
		}
	} finally {
		reader.releaseLock();
	}
	return chunks.join("");
}
