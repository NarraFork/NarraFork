/**
 * Wire protocol between the server process and the out-of-process database integrity probe.
 *
 * Kept dependency-free on purpose: the probe subprocess entry imports this module, so it must
 * not transitively pull in the DB layer, the logger, or anything that opens files.
 */

/** argv flag that switches the single binary entry into integrity-probe mode. */
export const DB_INTEGRITY_WORKER_FLAG = "--narrafork-db-integrity-check";

/** Env var carrying the database path the probe should inspect. */
export const DB_INTEGRITY_PATH_ENV = "NARRAFORK_DB_INTEGRITY_PATH";

/** Env var selecting `quick_check` (default) or the authoritative `integrity_check`. */
export const DB_INTEGRITY_MODE_ENV = "NARRAFORK_DB_INTEGRITY_MODE";

export type IntegrityProbeMode = "quick" | "full";

export type IntegrityProbeStatus =
	/** The check ran and the database is healthy. */
	| "ok"
	/** The check ran and reported (or threw) corruption. */
	| "corrupt"
	/** The check could not run (path missing, read-only open refused, …) — inconclusive. */
	| "unavailable";

export interface IntegrityProbeReport {
	status: IntegrityProbeStatus;
	mode: IntegrityProbeMode;
	details: string;
	durationMs: number;
}

/** Marker line prefix so the parent can find the report even if SQLite writes to stdout. */
export const DB_INTEGRITY_REPORT_PREFIX = "narrafork-db-integrity-report:";

export function encodeIntegrityReport(report: IntegrityProbeReport): string {
	return `${DB_INTEGRITY_REPORT_PREFIX}${JSON.stringify(report)}`;
}

export function decodeIntegrityReport(stdout: string): IntegrityProbeReport | null {
	const marker = stdout.lastIndexOf(DB_INTEGRITY_REPORT_PREFIX);
	if (marker === -1) return null;
	const start = marker + DB_INTEGRITY_REPORT_PREFIX.length;
	const newline = stdout.indexOf("\n", start);
	const raw = (newline === -1 ? stdout.slice(start) : stdout.slice(start, newline)).trim();
	try {
		const parsed = JSON.parse(raw) as Partial<IntegrityProbeReport>;
		if (parsed.status !== "ok" && parsed.status !== "corrupt" && parsed.status !== "unavailable") {
			return null;
		}
		return {
			status: parsed.status,
			mode: parsed.mode === "full" ? "full" : "quick",
			details: String(parsed.details ?? ""),
			durationMs: Number(parsed.durationMs) || 0,
		};
	} catch {
		return null;
	}
}
