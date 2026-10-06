/**
 * Persistent "this database needs repair" marker.
 *
 * The integrity probe runs in the background, AFTER the server is already serving requests, so a
 * corruption finding can no longer be acted on inline: `recoverWithCli` closes the database and
 * swaps files on disk, which is unsafe while sessions are live. Instead the finding is written here
 * and the repair runs on the next startup, before any request is accepted.
 *
 * Stored as a small file (not a table) on purpose — the database it describes may be unreadable.
 *
 * State machine (the `state` field), because "flagged" and "still worth auto-repairing" are NOT
 * the same thing:
 *
 *   pending  A probe confirmed corruption and automatic repair is still owed. Startup attempts the
 *            repair (bounded by {@link MAX_AUTOMATIC_REPAIR_ATTEMPTS}); the background probe is
 *            skipped because a repair is already queued and another verdict changes nothing.
 *   manual   Automatic repair is given up (attempt budget spent). Startup does NOT scan or repair —
 *            it logs an actionable hint and serves normally, because every retry cost minutes of
 *            blocked startup plus a near-database-sized backup on disk. The background probe DOES
 *            still run, so a database repaired by hand is detected and the marker cleared.
 *   unknown  The marker file was unreadable (truncated by a kill mid-write, hand-edited, …). We
 *            cannot claim corruption, but we must not silently drop a possible finding either:
 *            no automatic repair, and the background probe decides.
 *
 * Attempts are persisted BEFORE each repair attempt so a crash or a CLI timeout during recovery
 * still consumes budget. Without that, a repair that reliably times out retried forever.
 */

import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { getNarraforkPath } from "../lib/narrafork-home";
import type { IntegrityProbeMode } from "./integrity-protocol";

/**
 * How many times startup may run the blocking automatic recovery for one finding.
 *
 * Deliberately tiny: `tryWalRecovery` + full `integrity_check` + `recoverWithCli` are synchronous
 * and run before `Bun.serve()` binds the port, and each `recoverWithCli` call copies the whole
 * database aside. Two attempts bound both the downtime and the disk growth.
 */
export const MAX_AUTOMATIC_REPAIR_ATTEMPTS = 2;

export type DatabaseRepairState = "pending" | "manual" | "unknown";

export interface PendingDatabaseRepair {
	mode: IntegrityProbeMode;
	details: string;
	detectedAt: string;
	state: DatabaseRepairState;
	/** Completed (or started-and-aborted) automatic repair attempts for this finding. */
	attempts: number;
	lastAttemptAt: string | null;
}

/** Callers may omit the bookkeeping fields; they default to a fresh `pending` finding. */
export type PendingDatabaseRepairInput = Pick<
	PendingDatabaseRepair,
	"mode" | "details" | "detectedAt"
> &
	Partial<Pick<PendingDatabaseRepair, "state" | "attempts" | "lastAttemptAt">>;

/** Marker writes never throw: losing the marker must not lose the corruption report. */
export interface MarkerWriteResult {
	ok: boolean;
	error?: string;
}

function statePath(): string {
	return getNarraforkPath("db-integrity-state.json");
}

function normalizeState(value: unknown): DatabaseRepairState {
	// Legacy markers (written before the state machine existed) carry no state field and always
	// meant "repair on next startup".
	if (value === "manual" || value === "unknown" || value === "pending") return value;
	return "pending";
}

function normalizeAttempts(value: unknown): number {
	const parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed <= 0) return 0;
	return Math.floor(parsed);
}

function normalize(input: PendingDatabaseRepairInput): PendingDatabaseRepair {
	return {
		mode: input.mode === "full" ? "full" : "quick",
		details: String(input.details ?? ""),
		detectedAt: String(input.detectedAt ?? ""),
		state: normalizeState(input.state),
		attempts: normalizeAttempts(input.attempts),
		lastAttemptAt: input.lastAttemptAt ? String(input.lastAttemptAt) : null,
	};
}

/** Read the pending-repair marker, or null when the database is not flagged. */
export function readPendingDatabaseRepair(): PendingDatabaseRepair | null {
	const path = statePath();
	if (!existsSync(path)) return null;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<PendingDatabaseRepair>;
		if (!parsed || typeof parsed !== "object") return null;
		// Legacy format (mode/details/detectedAt only) reads back as attempts=0, state=pending.
		return normalize(parsed as PendingDatabaseRepairInput);
	} catch {
		// A malformed marker still means "something flagged this database", but it is not evidence of
		// corruption either — so it becomes `unknown`: no blocking auto-repair, background probe
		// decides, and the next write replaces it with a well-formed record.
		return {
			mode: "quick",
			details: "unreadable integrity marker",
			detectedAt: "",
			state: "unknown",
			attempts: 0,
			lastAttemptAt: null,
		};
	}
}

/**
 * Write the marker atomically (temp file + rename) and never throw.
 *
 * Both properties matter: a direct overwrite killed mid-write leaves truncated JSON, and a throw
 * here used to abort the caller before it could log the corruption it had just confirmed.
 */
export function writePendingDatabaseRepair(input: PendingDatabaseRepairInput): MarkerWriteResult {
	const path = statePath();
	const tempPath = `${path}.tmp.${process.pid}.${Date.now()}`;
	try {
		mkdirSync(dirname(path), { recursive: true });
		writeFileSync(tempPath, `${JSON.stringify(normalize(input), null, 2)}\n`, "utf8");
		renameSync(tempPath, path);
		return { ok: true };
	} catch (err) {
		try {
			if (existsSync(tempPath)) unlinkSync(tempPath);
		} catch {
			// best effort
		}
		return { ok: false, error: err instanceof Error ? err.message : String(err) };
	}
}

export function clearPendingDatabaseRepair(): void {
	const path = statePath();
	if (!existsSync(path)) return;
	try {
		unlinkSync(path);
	} catch {
		// Best effort: a stale marker only costs one extra repair attempt on the next boot.
	}
}

/** Startup may only run the blocking recovery while the finding is pending and budget remains. */
export function shouldAttemptAutomaticRepair(repair: PendingDatabaseRepair): boolean {
	return repair.state === "pending" && repair.attempts < MAX_AUTOMATIC_REPAIR_ATTEMPTS;
}

/**
 * Only a queued automatic repair suppresses the background probe. `manual` and `unknown` markers
 * must keep verifying, otherwise a hand-repaired database stays flagged forever and a real
 * corruption can never be re-confirmed.
 */
export function shouldSkipBackgroundProbe(repair: PendingDatabaseRepair | null): boolean {
	return repair?.state === "pending";
}

/** Consume one attempt from the budget. Persisted before the repair runs, so crashes still count. */
export function recordAutomaticRepairAttempt(repair: PendingDatabaseRepair): {
	repair: PendingDatabaseRepair;
	write: MarkerWriteResult;
} {
	const next: PendingDatabaseRepair = {
		...repair,
		attempts: repair.attempts + 1,
		lastAttemptAt: new Date().toISOString(),
	};
	return { repair: next, write: writePendingDatabaseRepair(next) };
}

/** Stop automatic repair for this finding; the database stays flagged for a human. */
export function abandonAutomaticRepair(repair: PendingDatabaseRepair): {
	repair: PendingDatabaseRepair;
	write: MarkerWriteResult;
} {
	const next: PendingDatabaseRepair = { ...repair, state: "manual" };
	return { repair: next, write: writePendingDatabaseRepair(next) };
}

export type CorruptionRecordAction =
	/** Marker written (or replaced) — a repair is now queued for the next startup. */
	| "recorded"
	/** Existing marker left untouched: the finding is already queued or already given up on. */
	| "kept"
	/** Nothing could be persisted. The caller must still log the finding. */
	| "failed";

/**
 * Persist a corruption finding, idempotently.
 *
 * Re-detecting the same corruption must not reset the attempt budget or flip a `manual` marker
 * back to `pending` — that is exactly how the old code turned one bad database into an endless
 * "block startup for minutes, fail, copy the database aside, repeat" loop.
 */
export function recordCorruptionFinding(
	finding: Pick<PendingDatabaseRepair, "mode" | "details" | "detectedAt">,
): { action: CorruptionRecordAction; state: DatabaseRepairState; error?: string } {
	const existing = readPendingDatabaseRepair();
	if (existing && (existing.state === "pending" || existing.state === "manual")) {
		return { action: "kept", state: existing.state };
	}
	// An `unknown` marker is SYNTHESIZED by readPendingDatabaseRepair when the file cannot be
	// parsed, so its attempts field is always 0 and carries no information about how much budget
	// the real record had consumed. Recording over it as `pending`/attempts=0 would hand a
	// database that had already exhausted its budget a fresh round of minutes-long blocking
	// repairs — the very loop this state machine exists to end. Treat an unreadable marker as
	// "budget unknown, therefore spent": flag it for a human instead of re-arming automation.
	if (existing?.state === "unknown") {
		const write = writePendingDatabaseRepair({
			...finding,
			state: "manual",
			attempts: MAX_AUTOMATIC_REPAIR_ATTEMPTS,
		});
		if (!write.ok) return { action: "failed", state: "manual", error: write.error };
		return { action: "recorded", state: "manual" };
	}
	const write = writePendingDatabaseRepair({
		...finding,
		state: "pending",
		attempts: existing?.attempts ?? 0,
	});
	if (!write.ok) return { action: "failed", state: "pending", error: write.error };
	return { action: "recorded", state: "pending" };
}
