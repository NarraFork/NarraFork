/**
 * Background database integrity verification.
 *
 * Why this is not done at startup anymore: `PRAGMA quick_check` / `integrity_check` scan the whole
 * database and bun:sqlite is synchronous, so running either on the main thread blocks the event
 * loop — no HTTP, no WebSocket, no agent activity. On a multi-GB database that is minutes of hard
 * downtime on every unclean shutdown, and it happened BEFORE `Bun.serve()` bound the port, so the
 * server looked dead rather than slow.
 *
 * The design instead:
 *   1. Startup never scans. It only checks the cheap pending-repair marker (see integrity-state)
 *      left by an EARLIER probe that actually found corruption, and repairs then — before the
 *      server starts serving, and only while the attempt budget allows.
 *   2. After the server is listening, {@link scheduleBackgroundIntegrityCheck} spawns a read-only
 *      probe SUBPROCESS. It never touches this process' event loop or its write lock.
 *   3. If the probe reports corruption, we persist the pending-repair marker and warn. The repair
 *      itself is deferred to the next startup because `recoverWithCli` swaps the database file,
 *      which is not safe under live sessions.
 *   4. Everything the probe owns (pending timer, subprocess) lives in hot-reload-safe module state
 *      and is torn down by {@link cancelBackgroundIntegrityCheck} on shutdown. An orphaned probe
 *      would keep scanning a database that the replacement process may be replacing on disk.
 */

import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { envWithAmbientProxy } from "../lib/net/proxy-env";
import { getDbPath } from "./connection";
import {
	DB_INTEGRITY_MODE_ENV,
	DB_INTEGRITY_PATH_ENV,
	DB_INTEGRITY_WORKER_FLAG,
	decodeIntegrityReport,
	type IntegrityProbeMode,
	type IntegrityProbeReport,
} from "./integrity-protocol";
import {
	clearPendingDatabaseRepair,
	readPendingDatabaseRepair,
	recordCorruptionFinding,
	shouldSkipBackgroundProbe,
} from "./integrity-state";

/** Delay before the probe starts, so startup recovery and the first requests get a clear runway. */
const DEFAULT_PROBE_DELAY_MS = 30_000;
/** Hard cap on probe runtime. A scan slower than this is not worth keeping a subprocess alive for. */
const PROBE_TIMEOUT_MS = 10 * 60_000;
/** Bound the captured output; a wrecked DB can emit a very large integrity_check report. */
export const MAX_PROBE_OUTPUT_BYTES = 256 * 1024;

function isCompiledRuntime(): boolean {
	return import.meta.url.includes("$bunfs/") || import.meta.url.includes("%7EBUN/");
}

function buildProbeCommand(): string[] {
	// The compiled binary embeds server/index.ts, which dispatches on the flag; in dev we point Bun
	// at the same entry file so both runtimes share one code path.
	if (isCompiledRuntime()) return [process.execPath, DB_INTEGRITY_WORKER_FLAG];
	// Resolve the entry from THIS module's URL, never from the process cwd: the server may be
	// started from a subdirectory or by a service manager with a different WorkingDirectory, and a
	// relative path would silently turn every probe into `unavailable`.
	const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
	return [process.execPath, entry, DB_INTEGRITY_WORKER_FLAG];
}

/**
 * Read at most {@link MAX_PROBE_OUTPUT_BYTES} from a probe stream.
 *
 * The cap bounds memory and read time on a wrecked database. The probe prints its report last, so
 * output beyond the cap means the report is dropped and the caller reports `unavailable` — an
 * inconclusive verdict, never a false `ok`.
 */
async function readBounded(stream: ReadableStream<Uint8Array> | null): Promise<string> {
	if (!stream) return "";
	const decoder = new TextDecoder();
	const reader = stream.getReader();
	let out = "";
	let bytes = 0;
	try {
		while (bytes < MAX_PROBE_OUTPUT_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			bytes += value.byteLength;
			out += decoder.decode(value, { stream: true });
		}
		out += decoder.decode();
	} catch {
		// Partial output is still useful for diagnostics.
	} finally {
		try {
			await reader.cancel();
		} catch {
			// best effort
		}
	}
	return out;
}

interface BackgroundProbeState {
	scheduled: boolean;
	timer: ReturnType<typeof setTimeout> | undefined;
	/** Live probe subprocesses, so shutdown can kill them instead of orphaning the scan. */
	running: Set<{ kill: () => void }>;
	/** Set by cancel; makes the post-probe bookkeeping a no-op for an aborted run. */
	cancelled: boolean;
}

/**
 * Pinned to globalThis: Bun `--hot` re-evaluates modules independently, so a plain module-level
 * flag would reset here while main.ts kept its cached `isHotReload=false` and schedule a second
 * probe subprocess against the same database.
 */
const probeState = hotSafe<BackgroundProbeState>("narrafork.dbIntegrityProbe", () => ({
	scheduled: false,
	timer: undefined,
	running: new Set(),
	cancelled: false,
}));

/** Run the read-only probe in a subprocess. Never throws; failures resolve to `unavailable`. */
export async function runIntegrityProbe(
	mode: IntegrityProbeMode,
	options: {
		timeoutMs?: number;
		/** test-only: override the spawned command (timeout / oversized-output coverage). */
		command?: string[];
	} = {},
): Promise<IntegrityProbeReport> {
	const dbPath = getDbPath();
	const startedAt = Date.now();
	if (!existsSync(dbPath)) {
		return { status: "unavailable", mode, details: "database file not found", durationMs: 0 };
	}

	let proc: ReturnType<typeof Bun.spawn> | undefined;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let handle: { kill: () => void } | undefined;
	try {
		proc = Bun.spawn(options.command ?? buildProbeCommand(), {
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			// The probe is another NarraFork process and re-runs
			// `neutralizeAmbientProxyEnv()`; pass the real ambient proxy values so its
			// snapshot matches ours rather than the blanked placeholders.
			env: {
				...envWithAmbientProxy(),
				[DB_INTEGRITY_PATH_ENV]: dbPath,
				[DB_INTEGRITY_MODE_ENV]: mode,
				// The probe must not re-enter server startup paths that take the instance lock.
				NARRAFORK_ALLOW_MULTIPLE: "1",
			},
		});

		const spawned = proc;
		// Registered so shutdown can terminate a scan in flight. A probe that outlives its parent
		// keeps a read-only handle on a file the replacement process may be swapping (recoverWithCli)
		// or rewriting (admin VACUUM), and its report has nowhere to go.
		handle = {
			kill: () => {
				try {
					spawned.kill();
				} catch {
					// best effort
				}
			},
		};
		probeState.running.add(handle);

		let timedOut = false;
		timer = setTimeout(() => {
			timedOut = true;
			handle?.kill();
		}, options.timeoutMs ?? PROBE_TIMEOUT_MS);

		const [stdout, stderr] = await Promise.all([
			readBounded(spawned.stdout as ReadableStream<Uint8Array> | null),
			readBounded(spawned.stderr as ReadableStream<Uint8Array> | null),
		]);
		const exitCode = await spawned.exited;

		if (timedOut) {
			return {
				status: "unavailable",
				mode,
				details: `probe timed out after ${options.timeoutMs ?? PROBE_TIMEOUT_MS}ms`,
				durationMs: Date.now() - startedAt,
			};
		}

		const report = decodeIntegrityReport(stdout);
		if (report) return report;

		return {
			status: "unavailable",
			mode,
			details: `probe produced no report (exit ${exitCode}): ${stderr.slice(0, 500) || stdout.slice(0, 500)}`,
			durationMs: Date.now() - startedAt,
		};
	} catch (err) {
		return {
			status: "unavailable",
			mode,
			details: `failed to spawn probe: ${err instanceof Error ? err.message : String(err)}`,
			durationMs: Date.now() - startedAt,
		};
	} finally {
		if (timer) clearTimeout(timer);
		if (handle) probeState.running.delete(handle);
	}
}

export interface BackgroundIntegrityCheckOptions {
	/** Skip the probe when the previous shutdown was clean (WAL + NORMAL makes the file trustworthy). */
	wasClean: boolean;
	/** Skip on Bun --hot reloads: the same process already verified (or skipped) this database. */
	isHotReload: boolean;
	delayMs?: number;
	/** test-only: replace the subprocess probe so the decision/bookkeeping paths need no spawn. */
	probe?: (mode: IntegrityProbeMode) => Promise<IntegrityProbeReport>;
	/** test-only: called once the probe result has been fully handled. */
	onSettled?: (report: IntegrityProbeReport) => void;
}

/** Why the probe was (or was not) scheduled. Returned so the decision is observable in tests. */
export type BackgroundIntegrityDecision =
	| "scheduled"
	| "already_scheduled"
	| "disabled_by_env"
	| "hot_reload"
	| "repair_pending"
	| "clean_shutdown";

/**
 * Verify the database in the background, after the server is already serving.
 *
 * Returns immediately. The probe itself runs in a subprocess, so nothing here occupies the main
 * thread beyond spawning and reading a short report.
 */
export function scheduleBackgroundIntegrityCheck(
	options: BackgroundIntegrityCheckOptions,
): BackgroundIntegrityDecision {
	if (probeState.scheduled) return "already_scheduled";

	const explicitMode = process.env.NARRAFORK_DB_INTEGRITY_CHECK?.trim();
	// NARRAFORK_DB_INTEGRITY_CHECK:
	//   off     never verify;
	//   full    verify with the authoritative (slower) `integrity_check`;
	//   always  verify on every startup, including after a clean shutdown (still `quick_check`
	//           unless `full` / NARRAFORK_DB_FULL_INTEGRITY_CHECK=1 asks for more).
	if (explicitMode === "off") {
		logger.info("Background database integrity check disabled", { via: "env" });
		return "disabled_by_env";
	}
	const forceFull =
		explicitMode === "full" || process.env.NARRAFORK_DB_FULL_INTEGRITY_CHECK === "1";

	if (options.isHotReload) return "hot_reload";
	// Only a repair that startup still owes suppresses the probe — another verdict would not change
	// what happens next. A marker in `manual` (automatic repair given up) or `unknown` state MUST
	// keep probing: that is the only way a hand-repaired database ever gets un-flagged, and the only
	// way we learn the corruption is still there.
	if (shouldSkipBackgroundProbe(readPendingDatabaseRepair())) return "repair_pending";
	if (options.wasClean && !forceFull && explicitMode !== "always") {
		logger.info("Background database integrity check skipped", { reason: "clean_shutdown" });
		return "clean_shutdown";
	}

	probeState.scheduled = true;
	probeState.cancelled = false;
	const mode: IntegrityProbeMode = forceFull ? "full" : "quick";
	const delayMs = options.delayMs ?? DEFAULT_PROBE_DELAY_MS;

	const timer = setTimeout(() => {
		probeState.timer = undefined;
		void (async () => {
			logger.info("Background database integrity check started", {
				mode,
				reason: options.wasClean ? "forced" : "unclean_shutdown",
			});
			const report = await (options.probe ?? runIntegrityProbe)(mode);
			if (probeState.cancelled) return;
			handleProbeReport(report);
			options.onSettled?.(report);
		})();
	}, delayMs);
	probeState.timer = timer;
	// Never hold the event loop open just for the probe.
	timer.unref?.();
	return "scheduled";
}

/** Log + persist a probe verdict. Extracted so the bookkeeping is testable without a subprocess. */
function handleProbeReport(report: IntegrityProbeReport): void {
	if (report.status === "ok") {
		logger.info("Background database integrity check passed", {
			mode: report.mode,
			durationMs: report.durationMs,
		});
		// A healthy database clears a stale flag. This is how a marker left in `manual` state
		// (automatic repair abandoned, repaired by hand since) stops haunting every startup.
		if (readPendingDatabaseRepair()) {
			clearPendingDatabaseRepair();
			logger.info("Cleared stale database repair flag after a passing integrity check");
		}
		return;
	}
	if (report.status === "unavailable") {
		// Inconclusive, not a corruption signal — do not flag the database for repair.
		logger.warn("Background database integrity check could not run", {
			mode: report.mode,
			details: report.details,
		});
		return;
	}
	// Corruption. Log FIRST and unconditionally: persisting the marker can fail (disk full,
	// permissions) and a confirmed corruption finding must never be lost just because the
	// bookkeeping was. The repair itself waits for the next startup, because recoverWithCli
	// replaces the database file underneath live sessions.
	logger.error("Database corruption detected — repair scheduled for next startup", {
		mode: report.mode,
		details: report.details,
		durationMs: report.durationMs,
	});
	const outcome = recordCorruptionFinding({
		mode: report.mode,
		details: report.details,
		detectedAt: new Date().toISOString(),
	});
	if (outcome.action === "failed") {
		logger.error("Failed to persist the database repair flag — repair will NOT be retried", {
			error: outcome.error,
			hint: "free disk space in the NarraFork home directory and restart",
		});
	} else if (outcome.action === "kept" && outcome.state === "manual") {
		logger.error("Corruption persists after automatic repair was abandoned", {
			hint: `sqlite3 "${getDbPath()}" ".recover" | sqlite3 "${getDbPath()}.manual"`,
		});
	}
}

/**
 * Tear down the background probe: cancel a pending schedule and kill any scan in flight.
 *
 * Called from the graceful-shutdown sequence. Without it the probe subprocess is orphaned for up to
 * {@link PROBE_TIMEOUT_MS} and keeps scanning a database the next process may be replacing.
 */
export function cancelBackgroundIntegrityCheck(): { timerCleared: boolean; killed: number } {
	probeState.cancelled = true;
	const timerCleared = probeState.timer !== undefined;
	if (probeState.timer) {
		clearTimeout(probeState.timer);
		probeState.timer = undefined;
	}
	let killed = 0;
	for (const handle of probeState.running) {
		handle.kill();
		killed++;
	}
	probeState.running.clear();
	probeState.scheduled = false;
	if (timerCleared || killed > 0) {
		logger.info("Background database integrity check cancelled", { timerCleared, killed });
	}
	return { timerCleared, killed };
}
