import { closeSync, opendirSync, openSync, readSync, writeSync } from "node:fs";
import { resolve } from "node:path";

const MAX_FILE_BYTES = 256 * 1024;
const QUIET_FILE_BYTES = 192 * 1024; // Reserve space for terminal records.
const SAMPLE_MS = 25;
const MAX_PROC_ENTRIES = 256;
const MAX_PROCESSES = 24;
const MAX_TASKS_PER_PROCESS = 16;
const QUIET_MS = 60_000;
const HEARTBEAT_MS = 120_000;
const OPEN_WARNING = "CI native test diagnostics unavailable: could not open its JSONL artifact";

export type NativeDiagnosticsOptions = {
	shardIndex: number;
	shardTotal: number;
	parallel: number | null;
	quietMs?: number;
	heartbeatMs?: number;
};

export type NativeDiagnosticFailure =
	| "timeout"
	| "abort"
	| "output-limit"
	| "error"
	| "signal"
	| "nonzero-exit";
type Event =
	| "start"
	| "spawn"
	| "heartbeat"
	| "quiet"
	| "timeout"
	| "abort"
	| "output-limit"
	| "error"
	| "child-exit"
	| "exit";
type EventState = {
	pid?: number;
	stdoutBytes: number;
	stderrBytes: number;
	exitCode?: number;
	signal?: NodeJS.Signals | null;
	failure?: NativeDiagnosticFailure | null;
};

// Only fixed kernel pseudo-files are read, never environ, cmdline, fd, logs or user paths.
function readKernelFile(path: string) {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.allocUnsafe(4096);
		return buffer.toString("utf8", 0, readSync(fd, buffer));
	} catch {
		return undefined;
	} finally {
		if (fd !== undefined) closeSync(fd);
	}
}

function numericFields(text: string | undefined, names: readonly string[]) {
	const fields: Record<string, number> = {};
	for (const line of text?.split("\n") ?? []) {
		const [key, value] = line.split(/[:\s]+/);
		if (key && value && names.includes(key) && /^\d+$/.test(value)) fields[key] = Number(value);
	}
	return fields;
}

function processStat(pid: number) {
	const text = readKernelFile(`/proc/${pid}/stat`);
	// comm can include spaces/parentheses and is never returned, even on parse failure.
	const separator = text?.lastIndexOf(") ") ?? -1;
	if (!text || separator < 0) return;
	const fields = text
		.slice(separator + 2)
		.trim()
		.split(/\s+/);
	const state = fields[0] ?? "";
	const [ppid, group, session, userTicks, systemTicks, threads, rssPages] = [
		1, 2, 3, 11, 12, 17, 21,
	].map((index) => Number(fields[index]));
	if (
		!/^[RSDZTWtXxKPI]$/.test(state) ||
		[ppid, group, session, userTicks, systemTicks, threads, rssPages].some(
			(n) => !Number.isSafeInteger(n),
		)
	)
		return;
	return { pid, ppid, group, session, state, userTicks, systemTicks, threads, rssPages };
}

function sampleLinux(root: number | undefined) {
	if (process.platform !== "linux") return undefined;
	const deadline = performance.now() + SAMPLE_MS;
	const read = (path: string) => (performance.now() < deadline ? readKernelFile(path) : undefined);
	const pressure = (kind: "cpu" | "memory" | "io") => {
		const source = read(`/proc/pressure/${kind}`);
		const average = (mode: "some" | "full") => {
			const entry = source?.split("\n").find((line) => line.startsWith(`${mode} `));
			const value = entry?.match(/\bavg10=(\d+\.\d+)\b/)?.[1];
			return value === undefined ? undefined : Number(value);
		};
		return { someAvg10: average("some"), fullAvg10: average("full") };
	};
	const hostPressure = { cpu: pressure("cpu"), memory: pressure("memory"), io: pressure("io") };
	const processes: NonNullable<ReturnType<typeof processStat>>[] = [];
	let processScanLimited = false;
	if (root) {
		const addProcess = (pid: number) => {
			if (processes.length >= MAX_PROCESSES || processes.some((entry) => entry.pid === pid)) return;
			const stat = processStat(pid);
			// This invocation owns a newly created POSIX session; never emit other processes.
			if (stat?.session === root && (pid !== root || stat.ppid === process.pid))
				processes.push(stat);
		};
		addProcess(root);
		// Look at the owned leader's actual descendants first: a busy machine may have too
		// many older PIDs to find recent children in a capped global directory scan.
		for (const { pid } of processes) {
			if (processes.length >= MAX_PROCESSES || performance.now() >= deadline) break;
			try {
				const tasks = opendirSync(`/proc/${pid}/task`);
				try {
					for (let i = 0; i < MAX_TASKS_PER_PROCESS && performance.now() < deadline; i++) {
						const task = tasks.readSync();
						if (!task) break;
						if (!/^\d+$/.test(task.name)) continue;
						const children = read(`/proc/${pid}/task/${task.name}/children`);
						for (const child of children?.match(/\b\d+ /g) ?? []) {
							if (processes.length >= MAX_PROCESSES || performance.now() >= deadline) break;
							addProcess(Number(child));
						}
					}
				} finally {
					tasks.closeSync();
				}
			} catch {
				// A process can exit while sampled. The fallback can still find reparented members.
			}
		}
		try {
			const proc = opendirSync("/proc");
			try {
				let entries = 0;
				while (
					entries < MAX_PROC_ENTRIES &&
					processes.length < MAX_PROCESSES &&
					performance.now() < deadline
				) {
					const entry = proc.readSync();
					if (!entry) break;
					entries++;
					if (!/^\d+$/.test(entry.name)) continue;
					addProcess(Number(entry.name));
				}
				processScanLimited =
					entries === MAX_PROC_ENTRIES ||
					processes.length === MAX_PROCESSES ||
					performance.now() >= deadline;
			} finally {
				proc.closeSync();
			}
		} catch {
			processScanLimited = true;
		}
	}
	const memoryKiB = numericFields(read("/proc/meminfo"), [
		"MemAvailable",
		"MemTotal",
		"SwapFree",
		"SwapTotal",
	]);
	const load = read("/proc/loadavg")
		?.split(" ", 3)
		.filter((n) => /^\d+\.\d+$/.test(n))
		.map(Number);
	const cgroupPath = read("/proc/self/cgroup")
		?.split("\n")
		.find((line) => line.startsWith("0::/"))
		?.slice(3);
	// The path is used only to resolve known cgroup v2 counters, and is not serialized.
	const cgroup =
		cgroupPath && /^\/(?:[\w./:@-]*)$/.test(cgroupPath) && !cgroupPath.split("/").includes("..")
			? `/sys/fs/cgroup${cgroupPath.replace(/\/$/, "")}`
			: undefined;
	return {
		memoryKiB,
		load,
		hostPressure,
		cgroupCpu: cgroup
			? numericFields(read(`${cgroup}/cpu.stat`), [
					"usage_usec",
					"nr_periods",
					"nr_throttled",
					"throttled_usec",
				])
			: undefined,
		cgroupMemoryEvents: cgroup
			? numericFields(read(`${cgroup}/memory.events`), ["high", "max", "oom", "oom_kill"])
			: undefined,
		processScanLimited,
		processes,
	};
}

/** Best effort and bounded. Synchronous local appends keep terminal records visible even if CI kills the wrapper. */
export function openNativeDiagnostics(
	artifacts: string,
	runName: string,
	options: NativeDiagnosticsOptions,
) {
	const { shardIndex, shardTotal, parallel } = options;
	if (![shardIndex, shardTotal].every((n) => Number.isSafeInteger(n) && n > 0)) return;
	const stem = `native-tests-${shardIndex}-of-${shardTotal}`;
	let fd: number;
	try {
		try {
			fd = openSync(resolve(artifacts, `${stem}-diagnostics.jsonl`), "wx", 0o600);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			fd = openSync(resolve(artifacts, `${stem}-${runName}-diagnostics.jsonl`), "wx", 0o600);
		}
	} catch {
		// Avoid the wrapper's stderr error/abort listeners for a diagnostic-only warning.
		try {
			writeSync(2, `${OPEN_WARNING}\n`);
		} catch {
			/* Best effort. */
		}
		return;
	}
	const started = performance.now();
	const elapsed = () => Math.round(performance.now() - started);
	const interval = (value: number | undefined, fallback: number) =>
		value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
	const quietMs = interval(options.quietMs, QUIET_MS);
	const heartbeatMs = interval(options.heartbeatMs, HEARTBEAT_MS);
	let lastHeartbeatElapsedMs = 0;
	let lastOutputElapsedMs: number | null = null;
	const lastStreamElapsedMs: [number | null, number | null] = [null, null];
	let lastQuietElapsedMs = 0;
	let written = 0;
	let enabled = true;
	const events = new Set<Event>();
	const write = (event: Event | "sample", state: EventState, extra?: Record<string, unknown>) => {
		if (!enabled) return;
		try {
			const line = `${JSON.stringify({
				schemaVersion: 1,
				timestamp: new Date().toISOString(),
				event,
				shard: `${shardIndex}/${shardTotal}`,
				parallel,
				bunVersion: process.versions.bun ?? null,
				pid: state.pid ?? null,
				elapsedMs: elapsed(),
				stdoutBytes: state.stdoutBytes,
				stderrBytes: state.stderrBytes,
				lastOutputElapsedMs,
				lastStdoutElapsedMs: lastStreamElapsedMs[0],
				lastStderrElapsedMs: lastStreamElapsedMs[1],
				exitCode: state.exitCode ?? null,
				signal: state.signal ?? null,
				failure: state.failure ?? null,
				...extra,
			})}\n`;
			const size = Buffer.byteLength(line);
			if (written + size > MAX_FILE_BYTES) return;
			const actual = writeSync(fd, line);
			written += actual;
			if (actual !== size) enabled = false;
		} catch {
			enabled = false;
		}
	};
	const sample = (reason: Event, state: EventState) => {
		if (!enabled) return;
		try {
			const resources = sampleLinux(state.pid);
			if (resources) write("sample", state, { reason, resources });
		} catch {
			// Incomplete or unavailable diagnostic data cannot fail the test runner.
		}
	};
	return {
		activity(index: 0 | 1) {
			lastOutputElapsedMs = elapsed();
			lastStreamElapsedMs[index] = lastOutputElapsedMs;
		},
		progress(state: EventState, watchdogRemainingMs: number) {
			if (!enabled || written >= QUIET_FILE_BYTES) return;
			const now = elapsed();
			if (now - lastHeartbeatElapsedMs >= heartbeatMs) {
				lastHeartbeatElapsedMs = now;
				write("heartbeat", state);
			}
			if (now - Math.max(lastOutputElapsedMs ?? 0, lastQuietElapsedMs) < quietMs) return;
			lastQuietElapsedMs = now;
			write("quiet", state);
			// Do not run a preemptive snapshot close to the existing watchdog's deadline.
			if (watchdogRemainingMs > SAMPLE_MS * 2) sample("quiet", state);
		},
		record(event: Event, state: EventState) {
			if (events.has(event)) return false;
			events.add(event);
			write(event, state);
			return true;
		},
		sample,
		close() {
			enabled = false;
			try {
				closeSync(fd);
			} catch {
				/* Diagnostics are best effort. */
			}
		},
	};
}
