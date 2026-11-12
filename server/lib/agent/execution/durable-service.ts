/**
 * Durable background services — `Bash({ run_in_background: true, background_kind: "service" })`
 * on the local Unix backend.
 *
 * An ordinary background command is owned by THIS process: its stdout/stderr are pipes whose
 * read end lives here, and its only record is a `background_tasks` row. A planned restart
 * (update handoff, prepared shutdown) deliberately leaves the detached process group alive,
 * yet the replacement process could neither find it nor read it, so it reported the service
 * as failed while it kept running — and the next write to the orphaned pipe could kill it
 * with SIGPIPE.
 *
 * A durable service removes both dependencies on this process:
 *  - stdout/stderr go straight to an append-only log file the child holds itself, so there
 *    is no pipe to break and any process can tail the output;
 *  - a small wrapper shell records the command's exit code to a file, so the outcome of a
 *    service that ended while no server was watching is still known;
 *  - a manifest records pid + process start token, so a later process can prove the pid
 *    still names THE SAME process (not a reused pid) before adopting or signalling it.
 *
 * Everything lives under `<NARRAFORK_HOME>/background-services/<taskId>/` and is removed
 * once the task reaches a terminal state. Windows is not supported (no process groups and
 * no start-token probe); callers fall back to the ordinary pipe-backed execution there.
 */
import { type ChildProcess, spawn } from "node:child_process";
import { closeSync, openSync } from "node:fs";
import {
	mkdir,
	open,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	truncate,
	writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../../logger";
import { getNarraforkPath } from "../../narrafork-home";
import { IS_WINDOWS } from "../../platform";
import type { ExecHandle } from "./backend";

/** How often a live handle looks for new log bytes. */
const TAIL_INTERVAL_MS = 250;
/** How often an adopted (no ChildProcess) handle checks whether the process is still alive. */
const LIVENESS_INTERVAL_MS = 1_000;
/** Bytes read from the log per tail tick; anything beyond is skipped with a marker. */
const MAX_READ_PER_TICK = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;
/** The log is truncated in place once it grows past this and the reader has caught up. */
export const SERVICE_LOG_MAX_BYTES = 32 * 1024 * 1024;
/** Output replayed into the task buffer when a restarted server adopts a running service. */
const ADOPT_REPLAY_BYTES = 64 * 1024;
const SIGKILL_DELAY_MS = 500;
const MANIFEST_VERSION = 1;
const MAX_SWEEP_ENTRIES = 1_000;

export interface DurableServiceManifest {
	version: number;
	taskId: string;
	/** Wrapper shell pid; it leads its own process group (pgid === pid). */
	pid: number;
	/** Opaque OS start token proving `pid` still names the spawned process. */
	startToken: string;
	command: string;
	cwd: string;
	/** Epoch ms when the service was spawned. */
	startedAt: number;
	/** Wall-clock budget from `startedAt`; absent means unlimited. */
	timeoutMs?: number;
}

export function isDurableServiceSupported(): boolean {
	return !IS_WINDOWS && (process.platform === "linux" || process.platform === "darwin");
}

export function getServicesRoot(): string {
	return getNarraforkPath("background-services");
}

function serviceDir(taskId: string): string {
	if (!/^[A-Za-z0-9_-]+$/.test(taskId)) throw new Error(`Invalid service task id: ${taskId}`);
	return join(getServicesRoot(), taskId);
}

export function serviceLogPath(taskId: string): string {
	return join(serviceDir(taskId), "output.log");
}

function exitCodePath(taskId: string): string {
	return join(serviceDir(taskId), "exit-code");
}

function manifestPath(taskId: string): string {
	return join(serviceDir(taskId), "service.json");
}

// ── Process identity ────────────────────────────────────────────────────

/**
 * Read a token that changes whenever `pid` is reused. Linux: field 22 (starttime, in clock
 * ticks since boot) of /proc/<pid>/stat. macOS: `ps -o lstart=`. Null when the process does
 * not exist or the platform cannot answer — callers must then treat the pid as NOT ours.
 */
export async function readProcessStartToken(pid: number): Promise<string | null> {
	if (!Number.isSafeInteger(pid) || pid <= 1) return null;
	if (process.platform === "linux") {
		try {
			const raw = await readFile(`/proc/${pid}/stat`, "utf8");
			// comm (field 2) may contain spaces and parentheses; fields resume after the LAST ')'.
			const rest = raw.slice(raw.lastIndexOf(")") + 2).split(" ");
			// rest[0] is field 3 (state), so field 22 is rest[19].
			const startTime = rest[19];
			if (!startTime) return null;
			// A zombie still answers but is no longer running anything.
			if (rest[0] === "Z") return null;
			return `linux:${startTime}`;
		} catch {
			return null;
		}
	}
	if (process.platform === "darwin") {
		return new Promise((resolve) => {
			let out = "";
			const ps = spawn("ps", ["-o", "lstart=", "-o", "stat=", "-p", String(pid)], {
				stdio: ["ignore", "pipe", "ignore"],
			});
			const timer = setTimeout(() => ps.kill("SIGKILL"), 3_000);
			ps.stdout?.on("data", (c: Buffer) => {
				if (out.length < 512) out += c.toString("utf8");
			});
			ps.once("error", () => {
				clearTimeout(timer);
				resolve(null);
			});
			ps.once("close", (code) => {
				clearTimeout(timer);
				const line = out.trim();
				if (code !== 0 || !line || /\bZ\S*$/.test(line)) return resolve(null);
				resolve(`darwin:${line.replace(/\s+\S+$/, "")}`);
			});
		});
	}
	return null;
}

/** True only when `pid` is alive AND is still the process the manifest describes. */
export async function isSameProcess(pid: number, startToken: string): Promise<boolean> {
	try {
		process.kill(pid, 0);
	} catch {
		// ESRCH: gone. EPERM: exists but belongs to someone else — therefore not ours.
		return false;
	}
	return (await readProcessStartToken(pid)) === startToken;
}

// ── Manifest ────────────────────────────────────────────────────────────

async function writeManifest(manifest: DurableServiceManifest): Promise<void> {
	const target = manifestPath(manifest.taskId);
	const tmp = `${target}.tmp`;
	await writeFile(tmp, JSON.stringify(manifest), { mode: 0o600 });
	await rename(tmp, target);
}

export async function readManifest(taskId: string): Promise<DurableServiceManifest | null> {
	try {
		const parsed = JSON.parse(
			await readFile(manifestPath(taskId), "utf8"),
		) as Partial<DurableServiceManifest>;
		if (
			parsed.version !== MANIFEST_VERSION ||
			parsed.taskId !== taskId ||
			typeof parsed.pid !== "number" ||
			typeof parsed.startToken !== "string" ||
			typeof parsed.startedAt !== "number"
		)
			return null;
		return parsed as DurableServiceManifest;
	} catch {
		return null;
	}
}

async function readExitCode(taskId: string): Promise<number | null> {
	try {
		const raw = (await readFile(exitCodePath(taskId), "utf8")).trim();
		const code = Number.parseInt(raw, 10);
		return Number.isSafeInteger(code) ? code : null;
	} catch {
		return null;
	}
}

/** Remove a service's directory. Safe to call for any task id; never throws. */
export async function removeServiceArtifacts(taskId: string): Promise<void> {
	try {
		await rm(serviceDir(taskId), { recursive: true, force: true });
	} catch (error) {
		logger.warn("Failed to remove background service artifacts", { taskId, error: String(error) });
	}
}

/**
 * Delete directories of services that no running task references. Bounded: a pathological
 * directory listing is cut at {@link MAX_SWEEP_ENTRIES}.
 */
export async function sweepServiceArtifacts(keepTaskIds: ReadonlySet<string>): Promise<number> {
	let entries: string[];
	try {
		entries = await readdir(getServicesRoot());
	} catch {
		return 0;
	}
	let removed = 0;
	for (const name of entries.slice(0, MAX_SWEEP_ENTRIES)) {
		if (keepTaskIds.has(name) || !/^[A-Za-z0-9_-]+$/.test(name)) continue;
		await removeServiceArtifacts(name);
		removed++;
	}
	return removed;
}

// ── Signalling ──────────────────────────────────────────────────────────

function signalGroup(pid: number, signal: NodeJS.Signals): boolean {
	try {
		process.kill(-pid, signal);
		return true;
	} catch {
		try {
			process.kill(pid, signal);
			return true;
		} catch {
			return false;
		}
	}
}

// ── Spawn ───────────────────────────────────────────────────────────────

/**
 * The wrapper: run the user's command through the configured shell, then atomically record
 * its exit status. Parameters travel in the environment (never interpolated into script
 * text) and are unset before the user command runs. SIGHUP is ignored so losing a
 * controlling terminal/session never ends the service.
 */
const WRAPPER_SCRIPT = [
	'__nf_shell="$NARRAFORK_SERVICE_SHELL"',
	'__nf_flags="$NARRAFORK_SERVICE_SHELL_FLAGS"',
	'__nf_cmd="$NARRAFORK_SERVICE_COMMAND"',
	'__nf_exit="$NARRAFORK_SERVICE_EXIT_FILE"',
	"unset NARRAFORK_SERVICE_SHELL NARRAFORK_SERVICE_SHELL_FLAGS NARRAFORK_SERVICE_COMMAND NARRAFORK_SERVICE_EXIT_FILE",
	"trap '' HUP",
	'if [ "$__nf_flags" = "-l -c" ]; then "$__nf_shell" -l -c "$__nf_cmd"; else "$__nf_shell" -c "$__nf_cmd"; fi',
	"__nf_code=$?",
	'printf "%s" "$__nf_code" > "$__nf_exit.tmp" && mv -f "$__nf_exit.tmp" "$__nf_exit"',
	'exit "$__nf_code"',
].join("\n");

export interface SpawnDurableServiceParams {
	taskId: string;
	command: string;
	cwd: string;
	env: Record<string, string | undefined>;
	shellPath: string;
	/** Use a login shell (`-l -c`) for the user command. */
	login: boolean;
	timeoutMs?: number;
	signal?: AbortSignal;
}

export async function spawnDurableService(params: SpawnDurableServiceParams): Promise<ExecHandle> {
	params.signal?.throwIfAborted();
	const dir = serviceDir(params.taskId);
	await mkdir(dir, { recursive: true, mode: 0o700 });
	const logPath = serviceLogPath(params.taskId);
	// O_APPEND: after an in-place truncate the child's writes land at the new end instead of
	// leaving a sparse hole at its old offset.
	const logFd = openSync(logPath, "a", 0o600);
	let proc: ChildProcess;
	try {
		params.signal?.throwIfAborted();
		proc = spawn("/bin/sh", ["-c", WRAPPER_SCRIPT], {
			cwd: params.cwd,
			env: {
				...params.env,
				NARRAFORK_SERVICE_SHELL: params.shellPath,
				NARRAFORK_SERVICE_SHELL_FLAGS: params.login ? "-l -c" : "-c",
				NARRAFORK_SERVICE_COMMAND: params.command,
				NARRAFORK_SERVICE_EXIT_FILE: exitCodePath(params.taskId),
			},
			stdio: ["ignore", logFd, logFd],
			detached: true,
		});
	} finally {
		// The child holds its own duplicate; this process never writes to the log.
		closeSync(logFd);
	}
	// Not referenced: the service must not keep this process's event loop alive.
	proc.unref();
	const handle = new DurableServiceHandle({
		taskId: params.taskId,
		pid: proc.pid,
		proc,
		readFrom: 0,
	});
	if (proc.pid !== undefined) {
		const startToken = await readProcessStartToken(proc.pid);
		if (startToken) {
			try {
				await writeManifest({
					version: MANIFEST_VERSION,
					taskId: params.taskId,
					pid: proc.pid,
					startToken,
					command: params.command,
					cwd: params.cwd,
					startedAt: Date.now(),
					...(params.timeoutMs !== undefined ? { timeoutMs: params.timeoutMs } : {}),
				});
			} catch (error) {
				// Without a manifest a restart cannot adopt it; the service itself still runs.
				logger.warn("Failed to record background service manifest", {
					taskId: params.taskId,
					error: String(error),
				});
			}
		}
	}
	if (params.signal) {
		const onAbort = () => void handle.kill();
		if (params.signal.aborted) onAbort();
		else {
			params.signal.addEventListener("abort", onAbort, { once: true });
			const cleanup = () => params.signal?.removeEventListener("abort", onAbort);
			void handle.whenSettled.then(cleanup, cleanup);
		}
	}
	return handle;
}

/**
 * Re-attach to a service a previous server process started. Returns null when no manifest
 * exists or the recorded pid no longer names the same process (exited or reused); the
 * caller then settles the task from {@link readOrphanedServiceOutcome}.
 */
export async function adoptDurableService(
	taskId: string,
): Promise<{ handle: DurableServiceHandle; manifest: DurableServiceManifest } | null> {
	const manifest = await readManifest(taskId);
	if (!manifest) return null;
	if (!(await isSameProcess(manifest.pid, manifest.startToken))) return null;
	let size = 0;
	try {
		size = (await stat(serviceLogPath(taskId))).size;
	} catch {
		// Missing log: nothing to replay; the child may recreate nothing, tail stays empty.
	}
	const replayFrom = Math.max(0, size - ADOPT_REPLAY_BYTES);
	const handle = new DurableServiceHandle({
		taskId,
		pid: manifest.pid,
		startToken: manifest.startToken,
		readFrom: replayFrom,
		replayNotice:
			replayFrom > 0
				? `[NarraFork restarted and re-attached to this service; showing the last ${Math.round(ADOPT_REPLAY_BYTES / 1024)} KB of earlier output]\n`
				: "[NarraFork restarted and re-attached to this service]\n",
	});
	return { handle, manifest };
}

/** For a service whose process is gone: its recorded exit code and the end of its log. */
export async function readOrphanedServiceOutcome(
	taskId: string,
	maxBytes = ADOPT_REPLAY_BYTES,
): Promise<{ hasManifest: boolean; exitCode: number | null; logTail: string }> {
	const hasManifest = (await readManifest(taskId)) !== null;
	const exitCode = await readExitCode(taskId);
	let logTail = "";
	try {
		const fh = await open(serviceLogPath(taskId), "r");
		try {
			const { size } = await fh.stat();
			const length = Math.min(size, maxBytes);
			const buf = Buffer.alloc(length);
			await fh.read(buf, 0, length, size - length);
			logTail = buf.toString("utf8");
		} finally {
			await fh.close();
		}
	} catch {
		// No log.
	}
	return { hasManifest, exitCode, logTail };
}

// ── Handle ──────────────────────────────────────────────────────────────

interface DurableServiceHandleInit {
	taskId: string;
	pid: number | undefined;
	/** Present when THIS process spawned the wrapper. */
	proc?: ChildProcess;
	/** Present for an adopted process; used to re-verify identity before signalling. */
	startToken?: string;
	readFrom: number;
	replayNotice?: string;
}

/**
 * ExecHandle over a durable service. Output is delivered by tailing the log file; `exited`
 * resolves only after the final bytes were delivered so callers can rely on the ordinary
 * "output, then exit" contract.
 */
export class DurableServiceHandle implements ExecHandle {
	readonly pid?: number;
	readonly exited: Promise<number | null>;
	readonly whenSettled: Promise<void>;
	private readonly taskId: string;
	private readonly proc?: ChildProcess;
	private readonly startToken?: string;
	private offset: number;
	private callbacks: Array<(chunk: Uint8Array) => void> = [];
	private pending: Uint8Array[] = [];
	private exitedFlag = false;
	private stopped = false;
	private tailTimer: ReturnType<typeof setTimeout> | null = null;
	private reading = false;
	private resolveExited!: (code: number | null) => void;

	constructor(init: DurableServiceHandleInit) {
		this.taskId = init.taskId;
		this.pid = init.pid;
		this.proc = init.proc;
		this.startToken = init.startToken;
		this.offset = init.readFrom;
		if (init.replayNotice) this.pending.push(Buffer.from(init.replayNotice));
		this.exited = new Promise<number | null>((resolve) => {
			this.resolveExited = resolve;
		});
		this.whenSettled = this.exited.then(() => undefined);
		if (init.proc) {
			const proc = init.proc;
			if (proc.pid === undefined) {
				// Spawn failed synchronously enough that no process exists.
				proc.once("error", (err) => {
					this.pending.push(Buffer.from(`Error: ${err.message}\n`));
					void this.finish(null);
				});
			} else {
				proc.once("exit", (code) => void this.finish(code ?? null));
				proc.once("error", () => {
					// A failed kill/send says nothing about exit; the exit event decides.
				});
			}
		} else {
			this.scheduleLivenessCheck();
		}
		this.scheduleTail();
	}

	onData(cb: (chunk: Uint8Array) => void): void {
		this.callbacks.push(cb);
		if (this.pending.length > 0) {
			const queued = this.pending;
			this.pending = [];
			for (const chunk of queued) this.deliver(chunk);
		}
	}

	isExited(): boolean {
		return this.exitedFlag;
	}

	/** Stop tailing WITHOUT touching the process (server shutdown that preserves services). */
	detach(): void {
		this.stopped = true;
		if (this.tailTimer) clearTimeout(this.tailTimer);
		this.tailTimer = null;
	}

	async kill(): Promise<void> {
		const pid = this.pid;
		if (pid === undefined || this.exitedFlag) return;
		// An adopted pid must still be the same process before it is signalled.
		if (this.startToken && !(await isSameProcess(pid, this.startToken))) return;
		signalGroup(pid, "SIGTERM");
		await Bun.sleep(SIGKILL_DELAY_MS);
		if (this.exitedFlag) return;
		if (this.startToken && !(await isSameProcess(pid, this.startToken))) return;
		signalGroup(pid, "SIGKILL");
	}

	private deliver(chunk: Uint8Array): void {
		if (this.callbacks.length === 0) {
			this.pending.push(chunk);
			return;
		}
		for (const cb of this.callbacks) cb(chunk);
	}

	private scheduleTail(): void {
		if (this.stopped || this.exitedFlag) return;
		this.tailTimer = setTimeout(() => {
			this.tailTimer = null;
			void this.readNew().finally(() => this.scheduleTail());
		}, TAIL_INTERVAL_MS);
		this.tailTimer.unref?.();
	}

	private scheduleLivenessCheck(): void {
		const timer = setInterval(async () => {
			if (this.stopped || this.exitedFlag) {
				clearInterval(timer);
				return;
			}
			const pid = this.pid;
			if (pid !== undefined && this.startToken && (await isSameProcess(pid, this.startToken)))
				return;
			clearInterval(timer);
			// Give the wrapper's `mv` a moment if it raced with our probe.
			await Bun.sleep(100);
			await this.finish(await readExitCode(this.taskId));
		}, LIVENESS_INTERVAL_MS);
		timer.unref?.();
	}

	/** Read whatever the child appended since the last tick (bounded per tick). */
	private async readNew(): Promise<void> {
		if (this.reading) return;
		this.reading = true;
		try {
			const path = serviceLogPath(this.taskId);
			let fh: Awaited<ReturnType<typeof open>>;
			try {
				fh = await open(path, "r");
			} catch {
				return;
			}
			try {
				const { size } = await fh.stat();
				if (size < this.offset) this.offset = 0; // truncated underneath us
				let available = size - this.offset;
				if (available > MAX_READ_PER_TICK) {
					const skipped = available - MAX_READ_PER_TICK;
					this.deliver(
						Buffer.from(`\n[NarraFork skipped ${skipped} bytes of fast service output]\n`),
					);
					this.offset += skipped;
					available = MAX_READ_PER_TICK;
				}
				while (available > 0) {
					const length = Math.min(available, READ_CHUNK_BYTES);
					const buf = Buffer.alloc(length);
					const { bytesRead } = await fh.read(buf, 0, length, this.offset);
					if (bytesRead <= 0) break;
					this.offset += bytesRead;
					available -= bytesRead;
					this.deliver(buf.subarray(0, bytesRead));
				}
				// Caught up and oversized: reclaim disk in place (the child appends with O_APPEND).
				if (!this.exitedFlag && this.offset >= SERVICE_LOG_MAX_BYTES) {
					await truncate(path, 0);
					this.offset = 0;
				}
			} finally {
				await fh.close();
			}
		} catch (error) {
			logger.debug("Background service log tail failed", {
				taskId: this.taskId,
				error: String(error),
			});
		} finally {
			this.reading = false;
		}
	}

	private async finish(code: number | null): Promise<void> {
		if (this.exitedFlag) return;
		if (this.tailTimer) clearTimeout(this.tailTimer);
		this.tailTimer = null;
		// Drain what the process wrote before it exited, then report the exit.
		while (this.reading) await Bun.sleep(10);
		await this.readNew();
		this.exitedFlag = true;
		this.resolveExited(code);
	}
}
