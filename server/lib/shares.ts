import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { logger } from "./logger";
import { getNarraforkPath } from "./narrafork-home";
import { settings } from "./settings";

const SHARES_DIR = getNarraforkPath("shares");

/**
 * Expiry for a SCREENSHOT PREVIEW share (Browser / WebFetch `screenshot`).
 *
 * These are not "temporary download links": the URL is persisted inside the tool
 * call and remains part of the conversation, so the user can scroll back to it
 * days later. At the original 1 hour every screenshot older than an hour turned
 * into a dead 404 — with the server still running — and the card rendered an
 * empty reserved box. A week keeps replay working for any realistic session while
 * still bounding disk use.
 *
 * A longer expiry does NOT make the URL durable: `cleanupStaleShares()` wipes the
 * whole directory on every server start, so a share never survives a restart. The
 * render layer must therefore still fall back to a saved file path — this constant
 * only fixes the in-session case.
 */
export const SCREENSHOT_PREVIEW_EXPIRY_HOURS = 24 * 7;

/**
 * Whether an expiry is long enough for a share whose URL is PERSISTED in the
 * conversation (screenshot previews).
 *
 * Extracted as a pure predicate so the policy can be asserted for arbitrary
 * values — including the 1-hour setting that shipped broken — without mutating
 * any module or file.
 */
export function isDurablePreviewExpiry(expiryHours: number): boolean {
	// One full day is the floor: below that, scrolling back through a long session
	// hits dead 404s. The upper bound keeps these files from accumulating forever,
	// since nothing else prunes them while the server stays up.
	return expiryHours >= 24 && expiryHours <= 24 * 30;
}

export interface ShareRecord {
	id: string;
	originalName: string;
	storagePath: string;
	size: number;
	expiresAt: Date;
	createdBy: string;
}

/** In-memory store — shares are ephemeral and don't survive server restarts. */
const shares = new Map<string, ShareRecord>();
const timers = new Map<string, Timer>();

/** Ensure the shares root directory exists. */
function ensureSharesDir(): void {
	mkdirSync(SHARES_DIR, { recursive: true });
}

export function getSharesDir(): string {
	return SHARES_DIR;
}

export interface CreateShareOpts {
	/** Pre-generated share ID (must match the share directory name). */
	id: string;
	originalName: string;
	storagePath: string;
	size: number;
	createdBy: string;
	expiryHours?: number;
}

export function createShare(opts: CreateShareOpts): ShareRecord {
	const id = opts.id;
	const expiryHours = opts.expiryHours ?? settings.shares?.defaultExpiryHours ?? 24;
	const expiresAt = new Date(Date.now() + expiryHours * 60 * 60 * 1000);

	const record: ShareRecord = {
		id,
		originalName: opts.originalName,
		storagePath: opts.storagePath,
		size: opts.size,
		expiresAt,
		createdBy: opts.createdBy,
	};

	shares.set(id, record);

	// Schedule auto-deletion
	const timer = setTimeout(
		() => {
			deleteShare(id);
		},
		expiryHours * 60 * 60 * 1000,
	);
	// Unref so the timer doesn't prevent process exit
	if (typeof timer === "object" && "unref" in timer) timer.unref();
	timers.set(id, timer);

	logger.info("Share created", {
		id,
		originalName: opts.originalName,
		expiresAt: expiresAt.toISOString(),
	});
	return record;
}

export function getShare(id: string): ShareRecord | null {
	const record = shares.get(id);
	if (!record) return null;
	if (record.expiresAt.getTime() < Date.now()) {
		deleteShare(id);
		return null;
	}
	return record;
}

export function deleteShare(id: string): void {
	const record = shares.get(id);
	if (record) {
		// Remove the share directory
		const shareDir = resolve(SHARES_DIR, id);
		if (existsSync(shareDir)) {
			rmSync(shareDir, { recursive: true, force: true });
		}
		shares.delete(id);
		logger.info("Share deleted", { id, originalName: record.originalName });
	}

	const timer = timers.get(id);
	if (timer) {
		clearTimeout(timer);
		timers.delete(id);
	}
}

/**
 * Clean up any leftover share directories from previous server runs.
 * Called once at startup.
 */
export function cleanupStaleShares(): void {
	try {
		ensureSharesDir();
		const entries = readdirSync(SHARES_DIR, { withFileTypes: true });
		let cleaned = 0;
		for (const entry of entries) {
			if (entry.isDirectory()) {
				const dirPath = resolve(SHARES_DIR, entry.name);
				rmSync(dirPath, { recursive: true, force: true });
				cleaned++;
			}
		}
		if (cleaned > 0) {
			logger.info("Cleaned up stale shares from previous run", { count: cleaned });
		}
	} catch {
		// Non-fatal — directory may not exist yet
	}
}

/** Get the maximum allowed file size in bytes. */
export function getMaxShareSizeBytes(): number {
	return (settings.shares?.maxFileSizeMb ?? 500) * 1024 * 1024;
}

/** Build the share directory path for a given share ID. */
export function getShareDir(id: string): string {
	ensureSharesDir();
	const dir = resolve(SHARES_DIR, id);
	mkdirSync(dir, { recursive: true });
	return dir;
}
