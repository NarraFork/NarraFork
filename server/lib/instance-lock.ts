import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { hostname, uptime } from "node:os";
import { basename, dirname, join } from "node:path";
import { logger } from "./logger";

/**
 * Single-instance guard for the NarraFork data directory.
 *
 * The hard requirement is asymmetric: refusing to boot when no other instance exists leaves the
 * user with a server that cannot start at all, while tolerating a rare extra instance is bounded
 * (SQLite WAL is multi-process safe; the real contention is ports/worktrees/terminals). So the
 * rule is: only refuse when we can POSITIVELY prove the recorded holder is still alive AND is
 * still the same process. Everything else — gone, identity mismatch, different boot, zombie,
 * undecidable — is treated as a stale lock and cleared.
 *
 * A bare pid is NOT proof of identity. Pids are recycled, so a leftover lock from a SIGKILLed /
 * OOM-killed / power-lost run routinely names a live unrelated process. That is why the payload
 * records the boot id and the kernel's process start time: `(bootId, pid, startTime)` is unique,
 * a pid alone is not.
 */

const ALLOW_MULTIPLE_ENV = "NARRAFORK_ALLOW_MULTIPLE";
const FORCE_UNLOCK_ENV = "NARRAFORK_FORCE_UNLOCK";
const LOCK_STATE_KEY = Symbol.for("narrafork.instanceLock");
const PID_CHECK_TIMEOUT_MS = 1500;
const PID_CHECK_MAX_BUFFER = 64 * 1024;
/**
 * Tolerance for the legacy fallback that compares an observed process start time against the
 * `startedAt` of a v1 payload (which never recorded a start time). The gap covers process spawn →
 * module evaluation → lock acquisition; measured at ~1s, so 120s is deliberately generous: this
 * comparison only ever REFUSES to call a lock stale, never causes one to be kept wrongly.
 */
const LEGACY_START_TOLERANCE_MS = 120_000;

/** Marker prefix for a boot id derived from `Date.now() - uptime()` rather than read from procfs. */
const DERIVED_BOOT_PREFIX = "boot-";
/**
 * How far two derived boot markers may drift while still counting as the same boot session.
 * `os.uptime()` moves ~1s between samples and jumps on NTP correction; 600s swallows both while
 * still separating genuine reboots, which reset the derived value by however long the box was down.
 */
const DERIVED_BOOT_TOLERANCE_S = 600;

/**
 * How many re-reads to allow when the lock file exists but is not yet parsable. `writeLockFile`
 * creates then writes, so a competitor's file is briefly empty; without this the empty window reads
 * as "corrupt" and the competitor's lock gets deleted mid-acquisition.
 */
const EMPTY_LOCK_REREADS = 3;
const EMPTY_LOCK_REREAD_DELAY_MS = 20;
/**
 * How many passes may end in "the file changed under us" before we stop granting extra attempts.
 * Bounded so a competitor rewriting the lock in a loop cannot keep us spinning here forever.
 */
const MAX_CONTENDED_RECHECKS = 3;

const CURRENT_LOCK_VERSION = 2;

interface InstanceLockPayload {
	version: number;
	pid: number;
	token: string;
	dbPath: string;
	startedAt: string;
	argv: string[];
	/** Boot session identifier. Distinguishes "pid 1234 now" from "pid 1234 before the reboot". */
	bootId: string | null;
	/** Kernel process start time (Linux jiffies since boot). Makes (pid, startTime) unique. */
	procStartTicks: number | null;
	/** Interpreter/binary path, used to compare image names where start times are unavailable. */
	execPath: string;
	/** Diagnostics only — deliberately NOT part of any decision (see classifyLockHolder). */
	hostname: string;
	uid: number | null;
}

interface InstanceLockState {
	path: string | null;
	token: string | null;
	acquired: boolean;
}

/** What we could observe about a pid right now. Three states, never a bare boolean. */
type ProcessObservation =
	| { kind: "absent" }
	| {
			kind: "present";
			startTicks: number | null;
			startedAtMs: number | null;
			zombie: boolean;
			imageName: string | null;
			cmdline: string[] | null;
			uid: number | null;
	  }
	| { kind: "unknown"; reason: string };

type LockHolderVerdict =
	/** The lock is ours (same process, same boot) — reuse it, e.g. across a --hot reload. */
	| { kind: "self" }
	/** Positively proven to be a live NarraFork with matching identity — refuse to boot. */
	| { kind: "live"; detail: string }
	/** Proven not to be the recorded process — safe to clear. */
	| { kind: "stale"; reason: string }
	/** Could not decide. Cleared anyway (see module docblock), but logged loudly. */
	| { kind: "unknown"; reason: string; observation: ProcessObservation };

function lockState(): InstanceLockState {
	// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
	const g = globalThis as any;
	if (!g[LOCK_STATE_KEY]) {
		g[LOCK_STATE_KEY] = { path: null, token: null, acquired: false } satisfies InstanceLockState;
	}
	return g[LOCK_STATE_KEY] as InstanceLockState;
}

// ── Boot session identity ────────────────────────────────────────────────────

/**
 * Identify the current boot session.
 *
 * `/proc/sys/kernel/random/boot_id` is exact where available. Elsewhere we record the derived boot
 * wall-clock second under a `boot-<seconds>` marker, which `bootSessionsDiffer` then compares with
 * a tolerance instead of for equality — see there for why exactness is unattainable off Linux.
 */
function currentBootId(): string | null {
	try {
		const raw = readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim();
		if (raw) return raw;
	} catch {
		// Not Linux, or procfs unavailable — fall through to the uptime-derived marker.
	}

	try {
		const bootSeconds = Math.round(Date.now() / 1000 - uptime());
		if (Number.isFinite(bootSeconds) && bootSeconds > 0) {
			return `${DERIVED_BOOT_PREFIX}${bootSeconds}`;
		}
	} catch {
		// os.uptime() unavailable — boot identity simply won't participate in the decision.
	}

	return null;
}

/** Parse a derived `boot-<seconds>` marker. Returns null for an exact procfs boot id. */
function derivedBootSeconds(bootId: string): number | null {
	if (!bootId.startsWith(DERIVED_BOOT_PREFIX)) return null;
	const seconds = Number(bootId.slice(DERIVED_BOOT_PREFIX.length));
	return Number.isFinite(seconds) ? seconds : null;
}

/**
 * Decide whether two boot ids prove different boot sessions.
 *
 * Exact procfs ids compare for equality. Derived ids must not: `Date.now()/1000 - uptime()` moves
 * by ~1s between samples and jumps on any NTP correction, so two readings taken minutes apart in
 * the SAME boot routinely disagree. Comparing those for equality is what let a live holder be
 * judged "written in a different boot session" and have its lock cleared. An earlier version
 * bucketed the value to 10s, which only moved the disagreement to the bucket edges (1004.6 → 1010
 * vs 1004.4 → 1000) instead of removing it.
 *
 * Erring towards "same boot" is the safe direction: it merely declines the cheap shortcut and
 * defers to the start-time and image-name evidence below, which is what actually settles identity.
 */
function bootSessionsDiffer(recorded: string | null, current: string | null): boolean {
	if (!recorded || !current) return false;

	const recordedSeconds = derivedBootSeconds(recorded);
	const currentSeconds = derivedBootSeconds(current);
	if (recordedSeconds !== null && currentSeconds !== null) {
		return Math.abs(recordedSeconds - currentSeconds) > DERIVED_BOOT_TOLERANCE_S;
	}
	// One side exact and the other derived means the payload was written by a different platform
	// or NarraFork version; that is not evidence about the boot session.
	if (recordedSeconds !== null || currentSeconds !== null) return false;

	return recorded !== current;
}

/** Seconds since epoch at which the machine booted, for converting Linux start jiffies. */
function bootTimeSeconds(): number | null {
	try {
		const match = /btime (\d+)/.exec(readFileSync("/proc/stat", "utf8"));
		if (match) {
			const value = Number(match[1]);
			if (Number.isFinite(value) && value > 0) return value;
		}
	} catch {
		// Fall through to the uptime approximation.
	}

	try {
		const derived = Math.round(Date.now() / 1000 - uptime());
		return Number.isFinite(derived) && derived > 0 ? derived : null;
	} catch {
		return null;
	}
}

// ── Reading process identity ─────────────────────────────────────────────────

/**
 * Parse `/proc/<pid>/stat`.
 *
 * The comm field is parenthesised and may itself contain spaces and parentheses, so fields are
 * split only AFTER the last `)`. `after[0]` is then field 3 (state) and `after[19]` is field 22
 * (starttime, in clock ticks since boot).
 */
function parseProcStat(raw: string): { state: string; startTicks: number } | null {
	const close = raw.lastIndexOf(")");
	if (close < 0) return null;
	const after = raw.slice(close + 2).split(" ");
	const state = after[0];
	const startTicks = Number(after[19]);
	if (!state || !Number.isFinite(startTicks)) return null;
	return { state, startTicks };
}

/**
 * Read process identity from procfs.
 *
 * Crucially, `/proc/<pid>/stat` is world-readable, so this works even for processes owned by other
 * users — the case where `process.kill(pid, 0)` returns EPERM and tells us nothing.
 */
function observeViaProcfs(pid: number): ProcessObservation | null {
	let raw: string;
	try {
		raw = readFileSync(`/proc/${pid}/stat`, "utf8");
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ENOENT") return { kind: "absent" };
		return null;
	}

	const stat = parseProcStat(raw);
	if (!stat) return null;

	const btime = bootTimeSeconds();
	const startedAtMs = btime === null ? null : Math.round((btime + stat.startTicks / 100) * 1000);

	let cmdline: string[] | null = null;
	try {
		cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
	} catch {
		// Zombies and some kernel threads expose an empty cmdline; not required for the decision.
	}

	let uid: number | null = null;
	try {
		uid = statSync(`/proc/${pid}`).uid;
	} catch {
		// Optional diagnostic only.
	}

	return {
		kind: "present",
		startTicks: stat.startTicks,
		startedAtMs,
		zombie: stat.state === "Z",
		imageName: cmdline?.[0] ? basename(cmdline[0]) : null,
		cmdline,
		uid,
	};
}

function parseCsvLine(line: string): string[] {
	const fields: string[] = [];
	let current = "";
	let inQuotes = false;

	for (let i = 0; i < line.length; i++) {
		const char = line[i];
		if (char === '"') {
			if (inQuotes && line[i + 1] === '"') {
				current += '"';
				i++;
			} else {
				inQuotes = !inQuotes;
			}
		} else if (char === "," && !inQuotes) {
			fields.push(current);
			current = "";
		} else {
			current += char;
		}
	}
	fields.push(current);

	return fields.map((field) => field.trim().replace(/^\uFEFF/, ""));
}

/**
 * Read a Windows process creation time, in epoch milliseconds.
 *
 * Without this the Windows guard never fires at all: `tasklist` reports no start time, so a live
 * holder whose image name matched fell through every comparison to `unknown` and had its lock
 * cleared — i.e. the single-instance check was permanently inert on Windows. Supplying a start time
 * here is what activates the existing `startedAt` drift comparison in `classifyLockHolder`.
 *
 * Only ever called while classifying an EXISTING lock file, never on the free-lock path, so the
 * subprocess cost stays off normal startup. CIM is tried first and `wmic` second because wmic is
 * deprecated and absent from recent Windows builds.
 */
function observeWindowsStartTimeMs(pid: number): number | null {
	const viaCim = spawnSync(
		"powershell",
		[
			"-NoProfile",
			"-NonInteractive",
			"-Command",
			`(Get-CimInstance Win32_Process -Filter "ProcessId=${pid}").CreationDate.ToUniversalTime().ToString("o")`,
		],
		{
			encoding: "utf8",
			maxBuffer: PID_CHECK_MAX_BUFFER,
			timeout: PID_CHECK_TIMEOUT_MS,
			windowsHide: true,
		},
	);
	if (!viaCim.error && viaCim.status === 0) {
		const parsed = Date.parse(String(viaCim.stdout ?? "").trim());
		if (Number.isFinite(parsed)) return parsed;
	}

	const viaWmic = spawnSync(
		"wmic",
		["process", "where", `processid=${pid}`, "get", "CreationDate", "/VALUE"],
		{
			encoding: "utf8",
			maxBuffer: PID_CHECK_MAX_BUFFER,
			timeout: PID_CHECK_TIMEOUT_MS,
			windowsHide: true,
		},
	);
	if (viaWmic.error || viaWmic.status !== 0) return null;
	// WMI datetime: yyyymmddHHMMSS.ffffff±UUU, where UUU is the UTC offset in MINUTES.
	const match = /CreationDate=(\d{14})\.(\d{6})([+-]\d{3})/.exec(String(viaWmic.stdout ?? ""));
	if (!match) return null;
	const [, stamp, micros, offset] = match;
	const offsetMinutes = Number(offset);
	if (!Number.isFinite(offsetMinutes)) return null;
	const iso =
		`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}` +
		`T${stamp.slice(8, 10)}:${stamp.slice(10, 12)}:${stamp.slice(12, 14)}` +
		`.${micros.slice(0, 3)}Z`;
	const asUtc = Date.parse(iso);
	if (!Number.isFinite(asUtc)) return null;
	return asUtc - offsetMinutes * 60_000;
}

/**
 * Observe a pid on Windows via `tasklist`, plus a creation time from CIM/wmic.
 *
 * The image name (CSV column 0) alone cannot settle identity — every NarraFork runs under the same
 * `bun.exe` — so the creation time is what actually distinguishes "still our process" from "this pid
 * was recycled". A missing creation time degrades to the pre-existing `unknown` handling.
 */
function observeViaWindowsTasklist(pid: number): ProcessObservation | null {
	const result = spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], {
		encoding: "utf8",
		maxBuffer: PID_CHECK_MAX_BUFFER,
		timeout: PID_CHECK_TIMEOUT_MS,
		windowsHide: true,
	});

	if (result.error || result.status === null) {
		logger.warn("Failed to check Windows process liveness with tasklist", {
			pid,
			error: result.error ? String(result.error) : null,
			status: result.status,
			signal: result.signal,
		});
		return null;
	}

	if (result.status !== 0) {
		logger.warn("tasklist returned a non-zero status while checking process liveness", {
			pid,
			status: result.status,
			stderr: String(result.stderr ?? "").slice(0, 200),
		});
		return null;
	}

	for (const line of String(result.stdout ?? "").split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed) continue;
		const fields = parseCsvLine(trimmed);
		if (fields[1] !== String(pid)) continue;
		const imageName = fields[0] || null;
		return {
			kind: "present",
			startTicks: null,
			startedAtMs: observeWindowsStartTimeMs(pid),
			zombie: false,
			imageName,
			cmdline: imageName ? [imageName] : null,
			uid: null,
		};
	}

	return { kind: "absent" };
}

/** Observe a pid on macOS/BSD via a single `ps` call yielding start time and command name. */
function observeViaPs(pid: number): ProcessObservation | null {
	const result = spawnSync("ps", ["-p", String(pid), "-o", "lstart=,comm="], {
		encoding: "utf8",
		maxBuffer: PID_CHECK_MAX_BUFFER,
		timeout: PID_CHECK_TIMEOUT_MS,
	});

	if (result.error || result.status === null) return null;
	// ps exits non-zero precisely when no matching process exists.
	if (result.status !== 0) return { kind: "absent" };

	const line = String(result.stdout ?? "")
		.split(/\r?\n/)
		.map((entry) => entry.trim())
		.find(Boolean);
	if (!line) return { kind: "absent" };

	// `lstart` is a fixed 5-token date ("Thu Jul 31 23:54:07 2026"), comm is whatever follows.
	const tokens = line.split(/\s+/);
	const command = tokens.slice(5).join(" ");
	const parsed = Date.parse(tokens.slice(0, 5).join(" "));

	return {
		kind: "present",
		startTicks: null,
		startedAtMs: Number.isFinite(parsed) ? parsed : null,
		zombie: false,
		imageName: command ? basename(command) : null,
		cmdline: command ? [command] : null,
		uid: null,
	};
}

/**
 * Last-resort liveness probe.
 *
 * EPERM deliberately maps to `unknown`, not `present`: "a process with this pid exists but belongs
 * to someone else" says nothing about whether it is our NarraFork, and treating it as alive is
 * exactly what made a recycled pid owned by root permanently unbootable.
 */
function observeViaSignal(pid: number): ProcessObservation {
	try {
		process.kill(pid, 0);
		return {
			kind: "present",
			startTicks: null,
			startedAtMs: null,
			zombie: false,
			imageName: null,
			cmdline: null,
			uid: null,
		};
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		if (code === "ESRCH") return { kind: "absent" };
		return { kind: "unknown", reason: `signal probe failed with ${code ?? "unknown error"}` };
	}
}

function observeProcess(pid: number): ProcessObservation {
	if (!Number.isInteger(pid) || pid <= 0) {
		return { kind: "absent" };
	}

	if (process.platform === "linux" || process.platform === "android") {
		const viaProcfs = observeViaProcfs(pid);
		if (viaProcfs) return viaProcfs;
	} else if (process.platform === "win32") {
		const viaTasklist = observeViaWindowsTasklist(pid);
		if (viaTasklist) return viaTasklist;
	} else {
		const viaPs = observeViaPs(pid);
		if (viaPs) return viaPs;
	}

	return observeViaSignal(pid);
}

// ── Payload IO ───────────────────────────────────────────────────────────────

/** Block the thread briefly. Only used on the startup path, where a few ms cost nothing. */
function sleepSync(ms: number): void {
	Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Read the lock payload, tolerating the instant during which a competitor is writing one.
 *
 * `writeLockFile` creates the file with `wx` and only then writes to it, so the file is briefly
 * observable as empty. Treating that as "unparsable, therefore stale" would delete the lock of a
 * process that is in the middle of successfully acquiring it — the same class of bug as clearing a
 * live holder. The writer finishes in microseconds, so a couple of re-reads settle it; still
 * unparsable after that means genuinely corrupt.
 */
function readLockPayloadSettled(path: string): InstanceLockPayload | null {
	for (let attempt = 0; ; attempt++) {
		const payload = readLockPayload(path);
		if (payload) return payload;
		if (!existsSync(path)) return null;
		if (attempt >= EMPTY_LOCK_REREADS) return null;
		sleepSync(EMPTY_LOCK_REREAD_DELAY_MS);
	}
}

/**
 * Take the existing lock file out of the way, but only if it still holds the payload we judged.
 *
 * `rename` is the atomic claim: when two processes both decide the same lock is stale, only one can
 * move that file away and the loser gets ENOENT. Deleting unconditionally — which is what this used
 * to do — let the loser delete the WINNER's freshly created lock and boot a second instance, with
 * both then fighting over ports, worktrees and terminals. The token comparison after the rename
 * covers the rarer "file was replaced between our read and our rename" case.
 *
 * Returns false when the file no longer matches what was classified; the caller must re-classify
 * rather than act on a stale verdict.
 */
function clearLockForRetry(path: string, expected: InstanceLockPayload | null): boolean {
	if (!expected) {
		// Corrupt or already gone: there is no token to protect, so nothing can be stolen.
		try {
			unlinkSync(path);
		} catch (err) {
			if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
		}
		return true;
	}

	const claimed = `${path}.clearing-${randomUUID()}`;
	try {
		renameSync(path, claimed);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException)?.code;
		// ENOENT: a competitor already moved or removed it. EPERM/EACCES/EBUSY: Windows may refuse
		// while another handle is open. Either way we did not win the claim.
		if (code === "ENOENT" || code === "EPERM" || code === "EACCES" || code === "EBUSY") {
			return false;
		}
		throw err;
	}

	const moved = readLockPayload(claimed);
	if (moved && moved.token !== expected.token) {
		// We moved away a lock that is not the one we judged. Put it back so its owner keeps it.
		try {
			renameSync(claimed, path);
		} catch {
			// Losing this restore would strand a live holder without its file, so say so loudly
			// rather than pretend the clear succeeded.
			logger.error("Failed to restore a NarraFork instance lock that was not ours to clear", {
				path,
				claimed,
			});
		}
		return false;
	}

	try {
		unlinkSync(claimed);
	} catch (err) {
		if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") throw err;
	}
	return true;
}

function readLockPayload(path: string): InstanceLockPayload | null {
	try {
		const raw = readFileSync(path, "utf8").trim();
		if (!raw) return null;
		const payload = JSON.parse(raw) as Partial<InstanceLockPayload>;
		if (typeof payload.pid !== "number" || typeof payload.token !== "string") return null;
		return {
			version: typeof payload.version === "number" ? payload.version : 1,
			pid: payload.pid,
			token: payload.token,
			dbPath: String(payload.dbPath ?? ""),
			startedAt: String(payload.startedAt ?? ""),
			argv: Array.isArray(payload.argv) ? payload.argv.map(String) : [],
			bootId: typeof payload.bootId === "string" && payload.bootId ? payload.bootId : null,
			procStartTicks:
				typeof payload.procStartTicks === "number" && Number.isFinite(payload.procStartTicks)
					? payload.procStartTicks
					: null,
			execPath: String(payload.execPath ?? ""),
			hostname: String(payload.hostname ?? ""),
			uid: typeof payload.uid === "number" ? payload.uid : null,
		};
	} catch {
		return null;
	}
}

/**
 * Our own kernel start time, read straight from procfs and memoised.
 *
 * Deliberately does NOT go through `observeProcess`: on Windows/macOS that would spawn a
 * subprocess purely to learn something about ourselves that those platforms cannot report anyway,
 * adding startup latency for no gain.
 */
let cachedSelfStartTicks: number | null | undefined;
function selfStartTicks(): number | null {
	if (cachedSelfStartTicks !== undefined) return cachedSelfStartTicks;
	try {
		cachedSelfStartTicks =
			parseProcStat(readFileSync("/proc/self/stat", "utf8"))?.startTicks ?? null;
	} catch {
		cachedSelfStartTicks = null;
	}
	return cachedSelfStartTicks;
}

function buildPayload(dbPath: string, token: string): InstanceLockPayload {
	return {
		version: CURRENT_LOCK_VERSION,
		pid: process.pid,
		token,
		dbPath,
		startedAt: new Date().toISOString(),
		argv: process.argv.slice(0, 8),
		bootId: currentBootId(),
		procStartTicks: selfStartTicks(),
		execPath: process.execPath,
		hostname: hostname(),
		uid: typeof process.getuid === "function" ? process.getuid() : null,
	};
}

function writeLockFile(path: string, payload: InstanceLockPayload): void {
	const fd = openSync(path, "wx");
	try {
		writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
	} finally {
		closeSync(fd);
	}
}

// ── Classification ───────────────────────────────────────────────────────────

/**
 * Decide what the existing lock file represents.
 *
 * Ordered so that every cheap, decisive disproof runs before the expensive/ambiguous checks, and
 * so that `live` is only ever returned on positive evidence of a matching live process.
 *
 * `hostname` is intentionally excluded from the decision: container hostnames default to a random
 * container id, so a rebuilt container would look "foreign" to its own lock and reintroduce this
 * very class of bug from the other direction.
 */
function classifyLockHolder(payload: InstanceLockPayload | null): LockHolderVerdict {
	if (!payload) return { kind: "stale", reason: "lock file is missing or unparsable" };

	const bootId = currentBootId();

	// Same pid within the same boot session: this really is us (hot reload, re-entrant import).
	if (payload.pid === process.pid && !bootSessionsDiffer(payload.bootId, bootId)) {
		return { kind: "self" };
	}

	// A lock written in a previous boot cannot describe a process running now.
	if (bootSessionsDiffer(payload.bootId, bootId)) {
		return {
			kind: "stale",
			reason: `lock was written in a different boot session (${payload.bootId} != ${bootId})`,
		};
	}

	const observation = observeProcess(payload.pid);

	if (observation.kind === "absent") {
		return { kind: "stale", reason: `pid ${payload.pid} does not exist` };
	}

	if (observation.kind === "unknown") {
		return {
			kind: "unknown",
			reason: `could not determine the state of pid ${payload.pid}: ${observation.reason}`,
			observation,
		};
	}

	// The strongest signal: the kernel start time pins the pid to one specific process.
	if (payload.procStartTicks !== null && observation.startTicks !== null) {
		if (payload.procStartTicks !== observation.startTicks) {
			return {
				kind: "stale",
				reason:
					`pid ${payload.pid} was recycled (recorded start ${payload.procStartTicks} ticks, ` +
					`observed ${observation.startTicks} ticks)`,
			};
		}

		if (observation.zombie) {
			return { kind: "stale", reason: `pid ${payload.pid} is a zombie awaiting reaping` };
		}

		return {
			kind: "live",
			detail: `pid ${payload.pid} matches the recorded process start time`,
		};
	}

	if (observation.zombie) {
		return { kind: "stale", reason: `pid ${payload.pid} is a zombie awaiting reaping` };
	}

	// No start time on at least one side (v1 payload, or a platform without procfs). Compare the
	// image name where both are known — "same pid, different executable" proves recycling.
	const recordedImage = payload.execPath ? basename(payload.execPath).toLowerCase() : null;
	const observedImage = observation.imageName?.toLowerCase() ?? null;
	if (recordedImage && observedImage) {
		const matches =
			recordedImage === observedImage ||
			recordedImage.replace(/\.exe$/, "") === observedImage.replace(/\.exe$/, "");
		if (!matches) {
			return {
				kind: "stale",
				reason: `pid ${payload.pid} now runs "${observation.imageName}", not "${basename(payload.execPath)}"`,
			};
		}
	}

	// Legacy fallback: a v1 payload has no start ticks, but `startedAt` was written moments after
	// the process started, so a large gap against the observed start time proves recycling.
	const recordedStartMs = Date.parse(payload.startedAt);
	if (Number.isFinite(recordedStartMs) && observation.startedAtMs !== null) {
		const drift = Math.abs(observation.startedAtMs - recordedStartMs);
		if (drift > LEGACY_START_TOLERANCE_MS) {
			return {
				kind: "stale",
				reason:
					`pid ${payload.pid} started ${Math.round(drift / 1000)}s away from the recorded ` +
					`lock time, so the original process is gone`,
			};
		}
		return {
			kind: "live",
			detail: `pid ${payload.pid} start time is consistent with the recorded lock time`,
		};
	}

	return {
		kind: "unknown",
		reason:
			`pid ${payload.pid} exists but carries no verifiable identity ` +
			`(no start time or image name to compare)`,
		observation,
	};
}

// ── Public API ───────────────────────────────────────────────────────────────

export function getInstanceLockPath(dbPath: string): string {
	return join(dirname(dbPath), "narrafork.lock");
}

function describeHolder(payload: InstanceLockPayload): Record<string, unknown> {
	return {
		ownerPid: payload.pid,
		ownerStartedAt: payload.startedAt,
		ownerArgv: payload.argv,
		ownerBootId: payload.bootId,
		ownerHostname: payload.hostname,
		ownerExecPath: payload.execPath,
		ownerUid: payload.uid,
		lockVersion: payload.version,
	};
}

export function acquireInstanceLock(dbPath: string): void {
	if (process.env[ALLOW_MULTIPLE_ENV] === "1") {
		logger.warn("NarraFork instance lock bypassed by environment override", {
			env: ALLOW_MULTIPLE_ENV,
			dbPath,
		});
		return;
	}

	const path = getInstanceLockPath(dbPath);
	const state = lockState();
	if (state.acquired && state.path === path) return;

	mkdirSync(dirname(path), { recursive: true });
	const forceUnlock = process.env[FORCE_UNLOCK_ENV] === "1";

	// Budget: one pass to claim a free lock, one more after clearing a lock we proved stale, plus a
	// small allowance for passes that decided nothing because a competitor changed the file first.
	// Those re-checks are not evidence of anything and must not consume the real attempts, but they
	// are bounded too — an unbounded loop would spin forever against a process that keeps rewriting.
	let contendedRechecks = 0;
	for (let attempt = 0; attempt < 2; ) {
		attempt++;
		const token = randomUUID();
		try {
			writeLockFile(path, buildPayload(dbPath, token));
			state.path = path;
			state.token = token;
			state.acquired = true;
			logger.info("NarraFork instance lock acquired", { path, pid: process.pid, dbPath });
			return;
		} catch (err) {
			const code = (err as NodeJS.ErrnoException)?.code;
			if (code !== "EEXIST") throw err;
		}

		const existing = existsSync(path) ? readLockPayloadSettled(path) : null;
		const verdict = classifyLockHolder(existing);

		if (verdict.kind === "self" && existing) {
			state.path = path;
			state.token = existing.token;
			state.acquired = true;
			logger.info("Reusing NarraFork instance lock for current process", {
				path,
				pid: process.pid,
			});
			return;
		}

		if (verdict.kind === "live" && existing) {
			if (forceUnlock) {
				logger.warn("Forcibly taking over a live NarraFork instance lock", {
					env: FORCE_UNLOCK_ENV,
					path,
					dbPath,
					detail: verdict.detail,
					...describeHolder(existing),
				});
			} else {
				const message =
					`Another NarraFork process (pid ${existing.pid}) is already using ${dbPath}.\n` +
					`  Lock file: ${path}\n` +
					`  Holder started: ${existing.startedAt}\n` +
					`  Holder command: ${existing.argv.join(" ") || "(unknown)"}\n` +
					`Stop that process first. If you are certain no NarraFork is running, delete the ` +
					`lock file above, or start once with ${FORCE_UNLOCK_ENV}=1 to take it over.`;
				logger.error("NarraFork instance lock is held by a live process", {
					path,
					dbPath,
					detail: verdict.detail,
					...describeHolder(existing),
				});
				throw new Error(message);
			}
		} else if (verdict.kind === "unknown") {
			// Undecidable. Clearing the lock is the lesser evil: refusing here would make an
			// unverifiable pid permanently block startup, which is worse than the bounded risk of a
			// second instance. Logged at error level so it is never silent.
			logger.error("NarraFork instance lock could not be verified — clearing it to allow startup", {
				path,
				dbPath,
				reason: verdict.reason,
				...(existing ? describeHolder(existing) : {}),
			});
		} else if (verdict.kind === "stale") {
			logger.warn("Removed stale NarraFork instance lock", {
				path,
				dbPath,
				reason: verdict.reason,
				...(existing ? describeHolder(existing) : {}),
			});
		}

		if (!clearLockForRetry(path, existing)) {
			// Someone else replaced the file between our read and our clear, so the verdict above
			// describes a payload that is already gone. Re-classify what is there now instead of
			// acting on it, and do not spend one of the two real attempts on a decision we skipped.
			logger.warn("NarraFork instance lock changed while it was being cleared — re-checking", {
				path,
				dbPath,
			});
			if (contendedRechecks++ < MAX_CONTENDED_RECHECKS) attempt--;
		}
	}

	throw new Error(`Failed to acquire NarraFork instance lock at ${path}`);
}

export function releaseInstanceLock(): void {
	const state = lockState();
	if (!state.acquired || !state.path || !state.token) return;

	try {
		const existing = existsSync(state.path) ? readLockPayload(state.path) : null;
		if (existing?.pid === process.pid && existing.token === state.token) {
			unlinkSync(state.path);
			logger.info("NarraFork instance lock released", { path: state.path, pid: process.pid });
		}
	} catch (err) {
		logger.warn("Failed to release NarraFork instance lock", {
			path: state.path,
			error: String(err),
		});
	} finally {
		state.path = null;
		state.token = null;
		state.acquired = false;
	}
}

// Register synchronously: exit handlers cannot await cleanup.
// biome-ignore lint/suspicious/noExplicitAny: global symbol storage survives hot reload
const g = globalThis as any;
const EXIT_HANDLER_KEY = Symbol.for("narrafork.instanceLock.exitHandler");
if (!g[EXIT_HANDLER_KEY]) {
	g[EXIT_HANDLER_KEY] = true;
	process.on("exit", () => releaseInstanceLock());
}

/** Exported for tests: lets them assert the decision without spawning real servers. */
export const __testing = {
	classifyLockHolder,
	observeProcess,
	currentBootId,
	readLockPayload,
	bootSessionsDiffer,
	clearLockForRetry,
	readLockPayloadSettled,
	DERIVED_BOOT_PREFIX,
	DERIVED_BOOT_TOLERANCE_S,
};
