import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, readdir, rm, rmdir, stat } from "node:fs/promises";
import { resolve } from "node:path";
import {
	STORAGE_CATEGORY_KEYS,
	STORAGE_CATEGORY_PROGRESS_MESSAGE,
	type StorageCategoryKey,
} from "@shared/storage-categories";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import { chatAttachments, chatRooms, narratorMessages, narrators, projects } from "../db/schema";
import {
	CHAT_DRAFT_ATTACHMENT_TTL_MS,
	deleteChatAttachmentFiles,
	getChatAttachmentsDir,
	listStoredChatAttachmentNames,
} from "../lib/chat-attachments";
import {
	DirectoryMeasureAbortedError,
	measureDirectoriesOffThread,
} from "../lib/fs-scan-worker/client";
import { logger } from "../lib/logger";
import { getNarraforkHome, getNarraforkPath } from "../lib/narrafork-home";
import { REQUEST_RECORDING_DIR, REQUEST_RECORDING_SAVED_DIR } from "../lib/request-recorder";
import { safeSpawn } from "../lib/spawn";
import { contentJsonHasImageBlocks, getUploadsDir, isWithinDir } from "../lib/uploads";
import { blockReadsEnabled, imageEnvelopeOwners } from "./narrator-block-scans";
import {
	DatabaseStorageScanCancelledError,
	DatabaseStorageUnsupportedError,
} from "./storage/database-storage-port";
import { databaseStoragePort } from "./storage/store";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StorageCategoryResult {
	key: string;
	sizeBytes: number;
	/**
	 * True when a directory-walk limit stopped the measurement, making `sizeBytes`
	 * a lower bound. Reported rather than swallowed: an understated figure would
	 * mislead an operator judging whether a category is worth cleaning up.
	 */
	truncated?: boolean;
	/**
	 * Set when the category could NOT be measured, which is not the same as measuring zero.
	 *
	 * `sizeBytes` is then meaningless and must not be summed into a total or rendered as a
	 * quantity — the whole reason this field exists is that a category reporting `0` with no
	 * explanation reads as "nothing here", so an operator would conclude a multi-gigabyte
	 * database weighed nothing rather than that nobody measured it.
	 */
	unavailable?: { backend: string; reason: string };
	details?: Record<string, unknown>;
}

export interface StorageScanResult {
	categories: StorageCategoryResult[];
	totalBytes: number;
	/** True when any category was truncated, so `totalBytes` is a lower bound. */
	truncated?: boolean;
	scannedAt: number; // epoch ms
}

// ── Paths ──────────────────────────────────────────────────────────────────

const NARRAFORK_DIR = getNarraforkHome();
const SHARES_DIR = resolve(NARRAFORK_DIR, "shares");
const TREE_SNAPSHOTS_DIR = resolve(NARRAFORK_DIR, "tree-snapshots");
/**
 * Git-ignored files dormant chapters parked outside their worktrees, before chapters
 * were removed.
 *
 * Accounted for here because it is the one data area holding content git refuses to
 * track — `.env` files, local credentials — and nothing else in the storage view would
 * ever mention it. Nothing owns these archives any more, and nothing deletes them: the
 * user decides what to keep.
 *
 * Resolved per call rather than into a module constant, unlike the paths above.
 * `getNarraforkHome` reads `NARRAFORK_HOME` on every call precisely so an override can
 * land after import, and freezing this one at module load meant the sweep and its caller
 * could be looking at different directories — the sweep would find nothing, report
 * success, and leave the archives in place.
 */
function dormantIgnoredDir(): string {
	return getNarraforkPath("dormant-ignored");
}

// ── Cache ──────────────────────────────────────────────────────────────────

const CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
let cachedResult: StorageScanResult | null = null;

export function getCachedScanResult(): StorageScanResult | null {
	if (!cachedResult) return null;
	if (Date.now() - cachedResult.scannedAt > CACHE_TTL_MS) {
		cachedResult = null;
		return null;
	}
	return cachedResult;
}

export function invalidateStorageCache(): void {
	cachedResult = null;
}

// ── Helpers ────────────────────────────────────────────────────────────────

export interface DirSizeResult {
	sizeBytes: number;
	/** Entries actually visited (files + directories), for observability. */
	entriesScanned: number;
	/**
	 * True when a limit stopped the walk, so `sizeBytes` is a lower bound.
	 *
	 * Surfaced all the way to the storage UI: a silently truncated total would
	 * understate disk usage and mislead the operator deciding whether to clean up.
	 */
	truncated: boolean;
}

export interface CategoryScanOptions {
	signal?: AbortSignal;
	onProgress?: (progress: { done: number; total: number | null }) => void;
}

function directoryProgress(
	onProgress: CategoryScanOptions["onProgress"],
): ((progress: { entriesScanned: number; sizeBytes: number }) => void) | undefined {
	if (!onProgress) return undefined;
	return (progress) => {
		onProgress({ done: progress.entriesScanned, total: null });
	};
}

/**
 * Recursively sum file sizes in one directory.
 *
 * The walk itself runs in a filesystem worker. Symlinks are not followed, and
 * entry count and depth are capped; hitting either sets `truncated`.
 */
async function measureDirSize(
	dirPath: string,
	options: CategoryScanOptions = {},
): Promise<DirSizeResult> {
	throwIfAborted(options.signal);
	if (!existsSync(dirPath)) return { sizeBytes: 0, entriesScanned: 0, truncated: false };
	const [measured] = await measureDirectoriesOffThread([dirPath], {
		signal: options.signal,
		onProgress: directoryProgress(options.onProgress),
	});
	if (!measured) throw new Error("Filesystem scan worker returned no directory measurement");
	return measured;
}

/**
 * Bytes-only wrapper for callers that report reclaimed space rather than a scan
 * total. Truncation is logged rather than returned because these callers delete the
 * directory immediately afterwards, so the number is a report, not a decision input.
 */
async function dirSize(dirPath: string): Promise<number> {
	const result = await measureDirSize(dirPath);
	if (result.truncated) {
		logger.warn("Directory size measurement hit a scan limit; reported size is a lower bound", {
			path: dirPath,
			entriesScanned: result.entriesScanned,
		});
	}
	return result.sizeBytes;
}

export function buildReferencedUploadOwnerIds(
	existingNarratorIds: Iterable<string>,
	messageRows: Array<{ narratorId: string | null; contentJson: unknown }>,
): Set<string> {
	const ownerIds = new Set(existingNarratorIds);
	for (const row of messageRows) {
		if (!row.narratorId || !contentJsonHasImageBlocks(row.contentJson)) continue;
		ownerIds.add(row.narratorId);
	}
	return ownerIds;
}

/**
 * Narrators whose upload dir must stay: every existing narrator, and the owner of any
 * message with an image block. With block reads, block-format messages answer from their
 * `input_image` asset rows (the same `{type: "image", imageId}` elements
 * `contentJsonHasImageBlocks` looks for) instead of a substring scan of every message.
 */
export function referencedUploadOwnerIds(narratorIds: Iterable<string>): Set<string> {
	if (blockReadsEnabled()) {
		const { owners, unindexed } = imageEnvelopeOwners();
		return buildReferencedUploadOwnerIds([...narratorIds, ...owners], unindexed);
	}
	// Only messages that contain an image block can pin an upload dir. Pre-filter
	// with a substring match on content_json (a superset of contentJsonHasImageBlocks,
	// which requires the literal `"type":"image"`) so we avoid loading every
	// message's content_json into memory. The exact check below stays authoritative.
	const uploadMessageOwners = db
		.select({ narratorId: narratorMessages.narratorId, contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(sql`${narratorMessages.contentJson} LIKE '%"type":"image"%'`)
		.all();
	return buildReferencedUploadOwnerIds(narratorIds, uploadMessageOwners);
}

// ── Scan functions (each returns one category) ─────────────────────────────

/**
 * The "nobody measured this" database category.
 *
 * One helper for both routes to it (the capability check and the port's rejection) so the two can
 * never drift into reporting the same situation differently — a category that is `unavailable` on
 * one path and a bare `0` on the other is precisely the misreading this field exists to prevent.
 */
function unmeasurableDatabaseCategory(backend: string, reason: string): StorageCategoryResult {
	logger.info("Database storage measurement is unavailable on this backend", { backend, reason });
	return { key: "database", sizeBytes: 0, unavailable: { backend, reason } };
}

/**
 * The database category, measured through {@link databaseStoragePort}.
 *
 * Goes through the port rather than calling the cleanup service directly so this scan states what
 * it needs (a byte total, serializable detail, progress, cancellation) instead of what SQLite
 * happens to offer. The port also owns the wall-clock budget, so this step always settles.
 *
 * A backend that cannot measure itself produces an `unavailable` category, NOT a zero: the total
 * below deliberately excludes it and the UI can say "not measurable on this backend". Every other
 * failure still propagates — an unreadable database is a problem to report, not to paper over.
 *
 * Both routes to `unavailable` are live and neither is redundant. `capabilities.breakdown` is read
 * FIRST so a backend that cannot measure is never asked to (the port guarantees such a call only
 * rejects, and a scan step that exists to produce a rejection is wasted work on the request path).
 * The rejection is still handled, because the adapter reads its capabilities at access time: the
 * flag can stop being true between the check and the call — the SQLite adapter loses
 * `offRequestThreadScan` exactly that way when the pool is torn down mid-scan.
 */
async function scanDatabase(
	onTableProgress?: (progress: { done: number; total: number; tableName: string }) => void,
	signal?: AbortSignal,
): Promise<StorageCategoryResult> {
	const capabilities = databaseStoragePort.capabilities;
	if (!capabilities.breakdown) {
		return unmeasurableDatabaseCategory(capabilities.backend, "breakdown");
	}

	try {
		const report = await databaseStoragePort.scanBreakdown({
			onProgress: onTableProgress,
			signal,
		});
		return {
			key: "database",
			sizeBytes: report.sizeBytes,
			...(report.incomplete ? { truncated: true } : {}),
			details: report.details,
		};
	} catch (err) {
		if (err instanceof DatabaseStorageUnsupportedError) {
			return unmeasurableDatabaseCategory(err.backend, err.capability);
		}
		// A cancelled scan is the caller's own abort coming back; re-shape it into the error the
		// generator's callers already understand rather than reporting a failed category.
		if (err instanceof DatabaseStorageScanCancelledError) throw new StorageScanAbortedError();
		throw err;
	}
}

/**
 * Uploads (`~/.narrafork/uploads`).
 *
 * Reports only the per-narrator image directories. Avatars live under
 * `uploads/avatars`, are keyed to user accounts rather than sessions, and are
 * deliberately skipped by {@link cleanupOrphanedUploads} — counting them here
 * would inflate a figure whose cleanup button can never reclaim them. Their
 * size still ships in `details` so the omission stays visible instead of silent.
 */
export async function scanUploads(
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	const uploadsDir = getUploadsDir();
	let narratorBytes = 0;
	let narratorCount = 0;
	let avatarBytes = 0;
	let truncated = false;
	throwIfAborted(options.signal);
	let entries: Dirent[];
	try {
		entries = await readdir(uploadsDir, { withFileTypes: true });
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		entries = [];
	}
	for (const entry of entries) {
		throwIfAborted(options.signal);
		const fullPath = resolve(uploadsDir, entry.name);
		if (entry.isDirectory()) {
			// A worker failure must reject the category, not publish a partial total.
			const measured = await measureDirSize(fullPath, options);
			truncated ||= measured.truncated;
			if (entry.name === "avatars") {
				avatarBytes = measured.sizeBytes;
				continue;
			}
			narratorBytes += measured.sizeBytes;
			narratorCount++;
			continue;
		}
		// Stray files directly under the uploads root belong to no narrator. Count them
		// here so the reported size never understates what the directory holds.
		if (entry.isFile()) {
			try {
				narratorBytes += (await stat(fullPath)).size;
			} catch {
				// skip inaccessible files
			}
		}
	}
	throwIfAborted(options.signal);
	return {
		key: "uploads",
		sizeBytes: narratorBytes,
		...(truncated ? { truncated } : {}),
		details: {
			narratorDirs: narratorCount,
			avatarBytes,
		},
	};
}

/**
 * Chat attachments (`~/.narrafork/chat-attachments`).
 *
 * Its own category rather than folded into `uploads`: the two have different owners
 * and different reclamation rules (a room vs. a narrator), so a combined figure
 * could not tell an operator which cleanup button would actually free it.
 */
async function scanChatAttachments(
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	const dir = getChatAttachmentsDir();
	const measured = await measureDirSize(dir, options);
	let roomCount = 0;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		roomCount = entries.filter((entry) => entry.isDirectory()).length;
	} catch {
		// dir may not exist
	}
	return {
		key: "chatAttachments",
		sizeBytes: measured.sizeBytes,
		...(measured.truncated ? { truncated: true } : {}),
		details: { roomDirs: roomCount },
	};
}

/** Saved bundles have their own category and are never reclaimed by rolling-buffer cleanup. */
export async function scanRequestRecordings(
	saved = false,
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	const directory = saved ? REQUEST_RECORDING_SAVED_DIR : REQUEST_RECORDING_DIR;
	const measured = await measureDirSize(resolve(NARRAFORK_DIR, directory), options);
	return {
		key: saved ? "savedRequestRecordings" : "requestRecordings",
		sizeBytes: measured.sizeBytes,
		...(measured.truncated ? { truncated: true } : {}),
		details: { retention: saved ? "manual" : "rolling" },
	};
}

async function scanShares(options: CategoryScanOptions = {}): Promise<StorageCategoryResult> {
	const measured = await measureDirSize(SHARES_DIR, options);
	let fileCount = 0;
	try {
		const entries = await readdir(SHARES_DIR, { withFileTypes: true });
		fileCount = entries.filter((e) => e.isDirectory()).length;
	} catch {
		// dir may not exist
	}
	return {
		key: "shares",
		sizeBytes: measured.sizeBytes,
		...(measured.truncated ? { truncated: true } : {}),
		details: { shareCount: fileCount },
	};
}

/**
 * Workspace tree snapshots (`~/.narrafork/tree-snapshots`).
 *
 * These grow with every recorded tool boundary, so they need to be visible in the
 * storage breakdown rather than accumulating unaccounted for.
 */
async function scanTreeSnapshots(
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	const measured = await measureDirSize(TREE_SNAPSHOTS_DIR, options);
	let repoCount = 0;
	try {
		const entries = await readdir(TREE_SNAPSHOTS_DIR, { withFileTypes: true });
		repoCount = entries.filter((e) => e.isDirectory()).length;
	} catch {
		// dir may not exist yet
	}
	return {
		key: "treeSnapshots",
		sizeBytes: measured.sizeBytes,
		...(measured.truncated ? { truncated: true } : {}),
		details: { repoCount },
	};
}

/**
 * Ignored-file archives left by dormant chapters (`~/.narrafork/dormant-ignored`).
 *
 * Reported separately from the snapshot repositories because the contents are the
 * user's untracked secrets rather than derived data. Chapters are gone, so every
 * archive is unowned.
 */
async function scanDormantIgnored(
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	const dir = dormantIgnoredDir();
	const measured = await measureDirSize(dir, options);
	let archiveCount = 0;
	let orphanCount = 0;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());
		archiveCount = dirs.length;
		orphanCount = dirs.length;
	} catch {
		// dir may not exist yet
	}
	return {
		key: "dormantIgnored",
		sizeBytes: measured.sizeBytes,
		...(measured.truncated ? { truncated: true } : {}),
		details: { archiveCount, orphanCount },
	};
}

async function scanWorktrees(options: CategoryScanOptions = {}): Promise<StorageCategoryResult> {
	let totalSize = 0;
	let worktreeCount = 0;
	let truncated = false;
	const projectList: Array<{ name: string; sizeBytes: number; worktreeCount: number }> = [];

	throwIfAborted(options.signal);
	const allProjects = db
		.select({ id: projects.id, name: projects.name, gitPath: projects.gitPath })
		.from(projects)
		.all();

	for (const proj of allProjects) {
		throwIfAborted(options.signal);
		if (!proj.gitPath) continue;
		const wtDir = resolve(proj.gitPath, ".worktrees");
		if (!existsSync(wtDir)) continue;
		const measured = await measureDirSize(wtDir, options);
		truncated ||= measured.truncated;
		const projSize = measured.sizeBytes;
		let projWtCount = 0;
		try {
			const entries = await readdir(wtDir, { withFileTypes: true });
			projWtCount = entries.filter((e) => e.isDirectory()).length;
		} catch {
			// A directory may disappear after it was measured.
		}
		totalSize += projSize;
		worktreeCount += projWtCount;
		if (projSize > 0) {
			projectList.push({
				name: proj.name,
				sizeBytes: projSize,
				worktreeCount: projWtCount,
			});
		}
	}
	throwIfAborted(options.signal);

	return {
		key: "worktrees",
		sizeBytes: totalSize,
		...(truncated ? { truncated } : {}),
		details: { worktreeCount, projects: projectList },
	};
}

async function scanContainers(options: CategoryScanOptions = {}): Promise<StorageCategoryResult> {
	try {
		const result = await safeSpawn({
			cmd: ["podman", "system", "df", "--format", "json"],
			timeout: 15_000,
			signal: options.signal,
		});
		if (result.exitCode !== 0) {
			return { key: "containers", sizeBytes: 0, details: { available: false } };
		}
		const data = JSON.parse(result.stdout);
		let totalSize = 0;
		const info: Record<string, unknown> = { available: true };

		// podman system df --format json returns an array or object with Images/Containers/Volumes
		if (Array.isArray(data)) {
			// Newer podman format: array of { Type, Total, Active, Size, Reclaimable }
			for (const item of data) {
				const size = item.Size ?? item.TotalSize ?? 0;
				totalSize += typeof size === "number" ? size : 0;
				if (item.Type) {
					info[String(item.Type).toLowerCase()] = {
						total: item.Total ?? 0,
						active: item.Active ?? 0,
						size,
						reclaimable: item.Reclaimable ?? 0,
					};
				}
			}
		} else if (data && typeof data === "object") {
			// Older format: { Images: [...], Containers: [...], Volumes: [...] }
			for (const [key, arr] of Object.entries(data)) {
				if (!Array.isArray(arr)) continue;
				let catSize = 0;
				for (const item of arr) {
					const s =
						(item as Record<string, unknown>).Size ??
						(item as Record<string, unknown>).VirtualSize ??
						0;
					catSize += typeof s === "number" ? s : 0;
				}
				totalSize += catSize;
				info[key.toLowerCase()] = { count: arr.length, sizeBytes: catSize };
			}
		}

		return { key: "containers", sizeBytes: totalSize, details: info };
	} catch {
		return { key: "containers", sizeBytes: 0, details: { available: false } };
	}
}

// ── Full scan (SSE-friendly generator) ─────────────────────────────────────

interface TableProgress {
	done: number;
	total: number;
	tableName: string;
}

/**
 * Bridge a push-style progress callback into an async iterable the SSE generator can yield from.
 *
 * Progress events are coalesced: only the most recent one is kept while the consumer is busy. The
 * scan can report a table every few milliseconds, and the UI only ever renders the latest count, so
 * dropping intermediate values keeps the SSE stream from becoming its own bottleneck.
 *
 * `drain()` only ends once `close()` has been called, so closing must not depend solely on the scan
 * promise settling: an abort that never surfaces as a rejection (for example the non-abortable
 * main-thread fallback finishing late) would otherwise leave the consumer parked forever. The
 * optional signal therefore closes the pump directly.
 */
export function createProgressPump(signal?: AbortSignal): {
	push: (progress: TableProgress) => void;
	close: () => void;
	drain: () => AsyncGenerator<TableProgress, void>;
} {
	let latest: TableProgress | null = null;
	let closed = false;
	let notify: (() => void) | null = null;

	const wake = () => {
		const resume = notify;
		notify = null;
		resume?.();
	};

	const close = () => {
		closed = true;
		wake();
	};

	if (signal) {
		if (signal.aborted) closed = true;
		else signal.addEventListener("abort", close, { once: true });
	}

	return {
		push: (progress) => {
			latest = progress;
			wake();
		},
		close,
		drain: async function* () {
			for (;;) {
				if (latest) {
					const value = latest;
					latest = null;
					yield value;
					continue;
				}
				if (closed) return;
				await new Promise<void>((resolve) => {
					notify = resolve;
				});
			}
		},
	};
}

export class StorageScanAbortedError extends Error {
	constructor() {
		super("storage scan aborted");
		this.name = "StorageScanAbortedError";
	}
}

function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new StorageScanAbortedError();
}

function rethrowScanFailure(error: unknown): never {
	if (error instanceof StorageScanAbortedError) throw error;
	if (error instanceof DirectoryMeasureAbortedError) throw new StorageScanAbortedError();
	throw error;
}

export function assembleStorageScanResult(categories: StorageCategoryResult[]): StorageScanResult {
	const truncated = categories.some((c) => c.truncated === true);
	// An unmeasurable category contributes nothing to the total AND makes the total a lower bound.
	// Adding its placeholder zero would be arithmetically harmless and semantically wrong: the sum
	// would read as complete while a whole category was missing from it.
	const unavailable = categories.filter((c) => c.unavailable);
	return {
		categories,
		totalBytes: categories.filter((c) => !c.unavailable).reduce((sum, c) => sum + c.sizeBytes, 0),
		...(truncated || unavailable.length > 0 ? { truncated: true } : {}),
		scannedAt: Date.now(),
	};
}

/** Merge one finished category into the shared cache. Other categories stay put. */
export function rememberStorageCategory(category: StorageCategoryResult): StorageScanResult {
	const previous =
		cachedResult && Date.now() - cachedResult.scannedAt <= CACHE_TTL_MS
			? cachedResult.categories
			: [];
	const merged = new Map(previous.map((entry) => [entry.key, entry]));
	merged.set(category.key, category);
	const ordered = STORAGE_CATEGORY_KEYS.map((key) => merged.get(key)).filter(
		(entry): entry is StorageCategoryResult => Boolean(entry),
	);
	for (const entry of merged.values()) {
		if (!ordered.some((existing) => existing.key === entry.key)) ordered.push(entry);
	}
	const result = assembleStorageScanResult(ordered);
	cachedResult = result;
	return result;
}

/**
 * Measure one category.
 *
 * Categories do not wait on each other. Directory walks run in filesystem workers;
 * the database measurement keeps its own read-worker path. `await Promise.resolve()`
 * lets every category reach its first real wait before any of them does synchronous
 * sqlite on the way into the database scan.
 */
export async function scanStorageCategory(
	key: StorageCategoryKey,
	options: CategoryScanOptions = {},
): Promise<StorageCategoryResult> {
	await Promise.resolve();
	throwIfAborted(options.signal);
	// The database step still has synchronous sqlite before its first internal await.
	// Yielding a turn lets sibling directory workers spawn first when a full scan
	// starts every category together.
	if (key === "database") {
		await new Promise<void>((resolve) => {
			setTimeout(resolve, 0);
		});
		throwIfAborted(options.signal);
	}
	try {
		switch (key) {
			case "database":
				return await scanDatabase((progress) => {
					options.onProgress?.({ done: progress.done, total: progress.total });
				}, options.signal);
			case "uploads":
				return await scanUploads(options);
			case "chatAttachments":
				return await scanChatAttachments(options);
			case "shares":
				return await scanShares(options);
			case "worktrees":
				return await scanWorktrees(options);
			case "treeSnapshots":
				return await scanTreeSnapshots(options);
			case "requestRecordings":
				return await scanRequestRecordings(false, options);
			case "savedRequestRecordings":
				return await scanRequestRecordings(true, options);
			case "dormantIgnored":
				return await scanDormantIgnored(options);
			case "containers":
				return await scanContainers(options);
		}
	} catch (error) {
		rethrowScanFailure(error);
	}
}

type StorageScanEvent =
	| {
			type: "progress";
			message: string;
			detail?: { done: number; total: number | null };
	  }
	| { type: "category"; data: StorageCategoryResult }
	| { type: "error"; error: unknown }
	| { type: "done" };

/**
 * Scan every category at once.
 *
 * Completion order is whatever finishes first. The returned category list is
 * still the stable display order. A failure in one category aborts the rest and
 * rejects the generator, matching the previous all-or-nothing contract.
 */
export async function* scanStorage(
	options: { signal?: AbortSignal } = {},
): AsyncGenerator<
	| { type: "progress"; message: string; detail?: { done: number; total: number | null } }
	| { type: "category"; data: StorageCategoryResult },
	StorageScanResult
> {
	const callerSignal = options.signal;
	throwIfAborted(callerSignal);
	const linked = new AbortController();
	if (callerSignal) {
		if (callerSignal.aborted) linked.abort();
		else callerSignal.addEventListener("abort", () => linked.abort(), { once: true });
	}

	const finished: StorageCategoryResult[] = [];
	const queue: StorageScanEvent[] = [];
	let notify: (() => void) | null = null;
	let remaining = STORAGE_CATEGORY_KEYS.length;
	let failure: unknown = null;

	const push = (event: StorageScanEvent) => {
		queue.push(event);
		const resume = notify;
		notify = null;
		resume?.();
	};

	for (const key of STORAGE_CATEGORY_KEYS) {
		void (async () => {
			try {
				push({ type: "progress", message: STORAGE_CATEGORY_PROGRESS_MESSAGE[key] });
				const result = await scanStorageCategory(key, {
					signal: linked.signal,
					onProgress: (detail) => {
						push({
							type: "progress",
							message: STORAGE_CATEGORY_PROGRESS_MESSAGE[key],
							detail,
						});
					},
				});
				finished.push(result);
				push({ type: "category", data: result });
			} catch (error) {
				if (!failure) {
					failure = error;
					linked.abort();
					push({ type: "error", error });
				}
			} finally {
				remaining--;
				if (remaining === 0) push({ type: "done" });
			}
		})();
	}

	while (true) {
		if (queue.length === 0) {
			await new Promise<void>((resolve) => {
				notify = resolve;
			});
			continue;
		}
		const event = queue.shift();
		if (!event || event.type === "done") break;
		if (event.type === "error") rethrowScanFailure(event.error);
		yield event;
	}
	if (failure) rethrowScanFailure(failure);

	const ordered = STORAGE_CATEGORY_KEYS.map((key) =>
		finished.find((entry) => entry.key === key),
	).filter((entry): entry is StorageCategoryResult => Boolean(entry));
	const result = assembleStorageScanResult(ordered);
	cachedResult = result;
	return result;
}

// ── Cleanup functions ──────────────────────────────────────────────────────

export async function removeUploadDirectoryWithoutMedia(
	narratorId: string,
	measureBytes = true,
): Promise<{ removed: number; freedBytes: number }> {
	const root = getUploadsDir();
	const dirPath = resolve(root, narratorId);
	if (!isWithinDir(root, dirPath)) return { removed: 0, freedBytes: 0 };

	// Existing media, including a symlink or an empty directory, preserves the
	// entire owner directory. References can survive in forks and tool results.
	try {
		await lstat(resolve(dirPath, "media"));
		return { removed: 0, freedBytes: 0 };
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
	}

	// Never recursively remove the owner root: media can be created at any time.
	let children: Dirent[];
	try {
		children = await readdir(dirPath, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, freedBytes: 0 };
		throw err;
	}
	let freedBytes = 0;
	for (const child of children) {
		// Case-insensitive filesystems can report an existing MEDIA spelling.
		if (child.name.toLowerCase() === "media") continue;
		const childPath = resolve(dirPath, child.name);
		try {
			const size = !measureBytes
				? 0
				: child.isDirectory()
					? await dirSize(childPath)
					: child.isFile()
						? (await lstat(childPath)).size
						: 0;
			await rm(childPath, { recursive: true, force: true });
			freedBytes += size;
		} catch (err) {
			if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
		}
	}
	try {
		await rmdir(dirPath);
		return { removed: 1, freedBytes };
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ENOTEMPTY" && code !== "EEXIST" && code !== "ENOENT") throw err;
		return { removed: 0, freedBytes };
	}
}

export async function cleanupOrphanedUploads(): Promise<{ removed: number; freedBytes: number }> {
	const uploadsDir = getUploadsDir();
	if (!existsSync(uploadsDir)) return { removed: 0, freedBytes: 0 };

	let entries: Dirent[];
	try {
		entries = await readdir(uploadsDir, { withFileTypes: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return { removed: 0, freedBytes: 0 };
		throw err;
	}
	const narratorIds = db
		.select({ id: narrators.id })
		.from(narrators)
		.all()
		.map((n) => n.id);
	const preservedOwnerIds = referencedUploadOwnerIds(narratorIds);

	let removed = 0;
	let freedBytes = 0;

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "avatars") continue;
		if (!preservedOwnerIds.has(entry.name)) {
			const result = await removeUploadDirectoryWithoutMedia(entry.name);
			removed += result.removed;
			freedBytes += result.freedBytes;
			if (result.removed) {
				logger.info("Removed orphaned upload dir", {
					narratorId: entry.name,
					size: result.freedBytes,
				});
			}
		}
	}

	// Invalidate cache
	cachedResult = null;
	return { removed, freedBytes };
}

/**
 * Reclaim chat attachments nothing can reach.
 *
 * Three distinct kinds of garbage, and they are NOT the same problem:
 *
 *  1. **Abandoned drafts** — a row with `message_id` null, older than the grace
 *     window. Uploads are persisted before their message exists, so a composer that
 *     is closed without sending leaves one behind. The window matters: sweeping
 *     unclaimed rows immediately would delete an attachment a user is still typing
 *     a message around.
 *  2. **Files with no row** — a write that landed while the DB insert failed, or a
 *     leftover from an older build. Reconciled per room against the rows, so the
 *     comparison stays bounded by one room's attachment count.
 *  3. **Directories with no room** — the room (or its narrator) was deleted. The
 *     `chat_attachments` rows cascaded away with it; the files did not.
 *
 * Every read is bounded and indexed. Deliberately no whole-table scan of
 * `chat_attachments`: the drafts query is filtered by the partial-index-friendly
 * `(room_id, claimed_at)` predicate and capped, and the per-room reconciliation only
 * ever reads the rooms that actually have a directory on disk.
 */
export async function cleanupOrphanedChatAttachments(): Promise<{
	removed: number;
	freedBytes: number;
}> {
	const root = getChatAttachmentsDir();
	if (!existsSync(root)) return { removed: 0, freedBytes: 0 };

	let removed = 0;
	let freedBytes = 0;

	// (1) Abandoned drafts. Capped so one sweep cannot turn into an unbounded delete;
	// whatever is left over is collected by the next run.
	const DRAFT_SWEEP_LIMIT = 500;
	const cutoff = new Date(Date.now() - CHAT_DRAFT_ATTACHMENT_TTL_MS).toISOString();
	const staleDrafts = db
		.select({
			id: chatAttachments.id,
			roomId: chatAttachments.roomId,
			storedName: chatAttachments.storedName,
			sizeBytes: chatAttachments.sizeBytes,
		})
		.from(chatAttachments)
		.where(sql`${chatAttachments.messageId} IS NULL AND ${chatAttachments.createdAt} < ${cutoff}`)
		.limit(DRAFT_SWEEP_LIMIT)
		.all();
	if (staleDrafts.length > 0) {
		db.delete(chatAttachments)
			.where(
				sql`${chatAttachments.id} IN (${sql.join(
					staleDrafts.map((row) => sql`${row.id}`),
					sql`, `,
				)})`,
			)
			.run();
		deleteChatAttachmentFiles(staleDrafts);
		removed += staleDrafts.length;
		freedBytes += staleDrafts.reduce((total, row) => total + row.sizeBytes, 0);
		logger.info("Removed abandoned chat attachment drafts", { count: staleDrafts.length });
	}

	// (2) + (3) Reconcile the directories on disk against the rooms and rows.
	const liveRoomIds = new Set(
		db
			.select({ id: chatRooms.id })
			.from(chatRooms)
			.all()
			.map((r) => r.id),
	);
	let entries: Dirent[];
	try {
		entries = await readdir(root, { withFileTypes: true });
	} catch {
		cachedResult = null;
		return { removed, freedBytes };
	}

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const roomId = entry.name;
		const dirPath = resolve(root, roomId);

		if (!liveRoomIds.has(roomId)) {
			const size = await dirSize(dirPath);
			await rm(dirPath, { recursive: true, force: true });
			removed++;
			freedBytes += size;
			logger.info("Removed chat attachments for a deleted room", { roomId, size });
			continue;
		}

		// One room's rows: bounded by that room's attachment count and served by the
		// `(room_id, claimed_at)` index.
		const known = new Set(
			db
				.select({ storedName: chatAttachments.storedName })
				.from(chatAttachments)
				.where(eq(chatAttachments.roomId, roomId))
				.all()
				.map((row) => row.storedName),
		);
		for (const storedName of listStoredChatAttachmentNames(roomId)) {
			if (known.has(storedName)) continue;
			const filePath = resolve(dirPath, storedName);
			try {
				const size = (await stat(filePath)).size;
				await rm(filePath, { force: true });
				removed++;
				freedBytes += size;
				logger.info("Removed unreferenced chat attachment file", { roomId, storedName, size });
			} catch {
				// Already gone, or unreadable — nothing to reclaim either way.
			}
		}
	}

	cachedResult = null;
	return { removed, freedBytes };
}

export async function cleanupAllShares(): Promise<{ removed: number; freedBytes: number }> {
	if (!existsSync(SHARES_DIR)) return { removed: 0, freedBytes: 0 };

	const entries = await readdir(SHARES_DIR, { withFileTypes: true });
	let removed = 0;
	let freedBytes = 0;

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const dirPath = resolve(SHARES_DIR, entry.name);
		const size = await dirSize(dirPath);
		await rm(dirPath, { recursive: true, force: true });
		removed++;
		freedBytes += size;
	}

	cachedResult = null;
	return { removed, freedBytes };
}

/**
 * Repack the tree-snapshot repositories. Each captured state writes loose objects, so
 * without this they grow with every tool call.
 *
 * Worktree directories under `<project>/.worktrees` are never removed here: those left
 * by removed chapters have no owner record, and deleting one would lose whatever it
 * still holds.
 */
export async function repackTreeSnapshots(): Promise<{
	removed: number;
	freedBytes: number;
}> {
	try {
		await worktreeTreeSnapshot.gcAll();
	} catch (err) {
		logger.warn("Failed to gc tree snapshot repositories", { error: String(err) });
	}

	cachedResult = null;
	return { removed: 0, freedBytes: 0 };
}

export async function pruneContainerImages(): Promise<{ success: boolean; output: string }> {
	try {
		// Only prune dangling images (-f without -a) to avoid removing intentionally kept images
		const result = await safeSpawn({ cmd: ["podman", "image", "prune", "-f"], timeout: 60_000 });
		cachedResult = null;
		return {
			success: result.exitCode === 0,
			output: (result.stdout || result.stderr).trim(),
		};
	} catch {
		return { success: false, output: "Podman is not available" };
	}
}

export const storageService = {
	getCachedScanResult,
	invalidateStorageCache,
	scanStorage,
	cleanupOrphanedUploads,
	cleanupOrphanedChatAttachments,
	cleanupAllShares,
	repackTreeSnapshots,
	pruneContainerImages,
};
