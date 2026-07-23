// Persistence of browser-session handoff data across a planned-update restart.
//
// Written by the outgoing process during a seamless-update shutdown and consumed (read-once,
// then deleted) by the replacement process at startup. The file lives under the updates dir,
// alongside the planned-update recovery snapshot.

import {
	chmodSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { logger } from "../logger";
import { getNarraforkPath } from "../narrafork-home";
import type { BrowserSessionHandoff } from "./session";

const UPDATE_DIR = getNarraforkPath("updates");
const HANDOFF_PATH = join(UPDATE_DIR, "browser-sessions-handoff.json");

/** Handoff files older than this are considered stale and ignored (and deleted). */
const HANDOFF_MAX_AGE_MS = 5 * 60 * 1000;

export interface BrowserHandoffFile {
	/** PID of the process that captured this handoff (diagnostics only). */
	capturedByPid: number;
	/** ISO timestamp of capture, used for staleness detection. */
	capturedAt: string;
	/** CDP WebSocket endpoints for each preserved Chrome instance, keyed by headless mode. */
	wsEndpoints: { headless?: string; headed?: string };
	/** Sessions to restore after reconnecting. */
	sessions: BrowserSessionHandoff[];
}

function isHandoffSession(value: unknown): value is BrowserSessionHandoff {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	return (
		typeof v.sessionId === "string" &&
		typeof v.narratorId === "string" &&
		typeof v.url === "string" &&
		typeof v.currentPageUrl === "string" &&
		typeof v.contextId === "string" &&
		typeof v.headless === "boolean" &&
		typeof v.ttlMs === "number" &&
		typeof v.networkCaptureEnabled === "boolean"
	);
}

function parseHandoffFile(value: unknown): BrowserHandoffFile | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.capturedAt !== "string") return null;
	if (!v.wsEndpoints || typeof v.wsEndpoints !== "object") return null;
	if (!Array.isArray(v.sessions)) return null;
	const sessions = v.sessions.filter(isHandoffSession);
	const endpoints = v.wsEndpoints as Record<string, unknown>;
	return {
		capturedByPid: typeof v.capturedByPid === "number" ? v.capturedByPid : 0,
		capturedAt: v.capturedAt,
		wsEndpoints: {
			...(typeof endpoints.headless === "string" ? { headless: endpoints.headless } : {}),
			...(typeof endpoints.headed === "string" ? { headed: endpoints.headed } : {}),
		},
		sessions,
	};
}

/** Atomically write the handoff file (temp + rename). */
export function writeBrowserHandoff(
	data: Omit<BrowserHandoffFile, "capturedByPid" | "capturedAt"> & {
		capturedByPid?: number;
		capturedAt?: string;
	},
): void {
	const payload: BrowserHandoffFile = {
		capturedByPid: data.capturedByPid ?? process.pid,
		capturedAt: data.capturedAt ?? new Date().toISOString(),
		wsEndpoints: data.wsEndpoints,
		sessions: data.sessions,
	};
	// The payload contains live CDP endpoints, which effectively grant control of the preserved
	// browser. Keep both the directory and file private even when the process umask is permissive.
	mkdirSync(UPDATE_DIR, { recursive: true, mode: 0o700 });
	if (process.platform !== "win32") chmodSync(UPDATE_DIR, 0o700);
	const tempPath = `${HANDOFF_PATH}.${process.pid}.${Date.now()}.tmp`;
	try {
		writeFileSync(tempPath, JSON.stringify(payload, null, 2), {
			encoding: "utf8",
			flag: "wx",
			mode: 0o600,
		});
		if (process.platform !== "win32") chmodSync(tempPath, 0o600);
		renameSync(tempPath, HANDOFF_PATH);
	} catch (error) {
		try {
			unlinkSync(tempPath);
		} catch {
			// The temp file may not have been created, or rename may already have consumed it.
		}
		throw error;
	}
	logger.info("Browser session handoff written", {
		path: HANDOFF_PATH,
		sessionCount: payload.sessions.length,
	});
}

/** Delete the handoff file if present (best-effort). */
export function removeBrowserHandoff(): void {
	try {
		unlinkSync(HANDOFF_PATH);
	} catch {
		// already absent
	}
}

/**
 * Read the handoff file exactly once: parse it, delete it immediately, and return the parsed
 * contents. Returns null when absent, corrupt, or stale (older than HANDOFF_MAX_AGE_MS). Deleting
 * before use ensures a normal restart or a failed/rolled-back update never reconnects to a dead
 * wsEndpoint on a subsequent boot.
 */
export function consumeBrowserHandoff(): BrowserHandoffFile | null {
	if (!existsSync(HANDOFF_PATH)) return null;
	let raw: string;
	try {
		raw = readFileSync(HANDOFF_PATH, "utf8");
	} catch (error) {
		logger.warn("Failed to read browser handoff file", {
			path: HANDOFF_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		removeBrowserHandoff();
		return null;
	}
	// Read-once: always delete the file before returning, regardless of parse outcome.
	removeBrowserHandoff();

	let parsed: BrowserHandoffFile | null;
	try {
		parsed = parseHandoffFile(JSON.parse(raw));
	} catch (error) {
		logger.warn("Failed to parse browser handoff file", {
			path: HANDOFF_PATH,
			error: error instanceof Error ? error.message : String(error),
		});
		return null;
	}
	if (!parsed) {
		logger.warn("Browser handoff file has an invalid shape; ignoring", { path: HANDOFF_PATH });
		return null;
	}

	const ageMs = Date.now() - Date.parse(parsed.capturedAt);
	if (!Number.isFinite(ageMs) || ageMs > HANDOFF_MAX_AGE_MS) {
		logger.warn("Browser handoff file is stale; ignoring", {
			path: HANDOFF_PATH,
			capturedAt: parsed.capturedAt,
			ageMs,
		});
		return null;
	}
	return parsed;
}

/** Exposed for tests. */
export const _internal = { UPDATE_DIR, HANDOFF_PATH, HANDOFF_MAX_AGE_MS };
