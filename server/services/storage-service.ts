import type { Dirent } from "node:fs";
import { existsSync } from "node:fs";
import { lstat, readdir, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, sql } from "drizzle-orm";
import { db } from "../db";
import {
	chapters,
	chatAttachments,
	chatRooms,
	narratorMessages,
	narrators,
	projects,
} from "../db/schema";
import {
	CHAT_DRAFT_ATTACHMENT_TTL_MS,
	deleteChatAttachmentFiles,
	getChatAttachmentsDir,
	listStoredChatAttachmentNames,
} from "../lib/chat-attachments";
import { logger } from "../lib/logger";
import { getNarraforkHome, getNarraforkPath } from "../lib/narrafork-home";
import { safeSpawn } from "../lib/spawn";
import { contentJsonHasImageBlocks, getUploadsDir } from "../lib/uploads";
import { databaseCleanupService } from "./database-cleanup-service";
import { dropRecentlyAttributed } from "./file-attribution-service";
import { gitService } from "./git-service";
import { dropStatus } from "./git-status-cache";
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
 * Git-ignored files a dormant chapter parked outside its worktree.
 *
 * Accounted for here because it is the one data area holding content git refuses to
 * track — `.env` files, local credentials — and nothing else in the storage view would
 * ever mention it. A chapter's own terminal transitions now discard its archive, but
 * directories created before that was true have no owner at all, which is what the
 * sweep below collects.
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

/**
 * Entry budget for one {@link measureDirSize} call.
 *
 * Derived from the largest thing this scan realistically walks: a checked-out
 * worktree of a big monorepo with `node_modules` present is on the order of a few
 * hundred thousand files. 2,000,000 leaves an order of magnitude of headroom above
 * that while still bounding a pathological or hostile tree — at ~2 syscalls per
 * entry this is seconds of async I/O, not an unbounded walk. Every category shares
 * the constant because they are all measured by the same function.
 */
const DIR_SCAN_MAX_ENTRIES = 2_000_000;

/**
 * Depth budget for one {@link measureDirSize} call.
 *
 * Real trees measured here (uploads/<narrator>/, shares/<id>/, bare snapshot repos,
 * git worktrees) are well under 30 levels; 64 is generous for deliberately nested
 * source trees while keeping recursion far from any stack limit. Symlinks are not
 * followed, so this is a guard against genuinely deep directories rather than
 * against link cycles.
 */
const DIR_SCAN_MAX_DEPTH = 64;

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

/**
 * Recursively sum file sizes in a directory (async to avoid blocking the event loop).
 *
 * Bounded on three axes and never follows symlinks:
 *  - `lstat` is used instead of `stat`, and only real directories are recursed into,
 *    so a self-referential or mutually-referential directory link (which `readdir`'s
 *    Dirent reports as a directory when it resolves to one) cannot spin forever;
 *  - symlinked files are skipped rather than counted, because their bytes belong to
 *    the target and would otherwise be double counted;
 *  - entry count and depth are capped, and hitting either sets `truncated` instead of
 *    quietly returning a smaller number.
 */
async function measureDirSize(dirPath: string): Promise<DirSizeResult> {
	if (!existsSync(dirPath)) return { sizeBytes: 0, entriesScanned: 0, truncated: false };
	let sizeBytes = 0;
	let entriesScanned = 0;
	let truncated = false;

	const walk = async (current: string, depth: number): Promise<void> => {
		if (truncated) return;
		if (depth > DIR_SCAN_MAX_DEPTH) {
			truncated = true;
			return;
		}
		let entries: Dirent[];
		try {
			entries = await readdir(current, { withFileTypes: true });
		} catch {
			// directory not readable
			return;
		}
		for (const entry of entries) {
			if (truncated) return;
			if (entriesScanned >= DIR_SCAN_MAX_ENTRIES) {
				truncated = true;
				return;
			}
			entriesScanned++;
			const full = resolve(current, entry.name);
			try {
				// lstat, not stat: a symlink must be identified as a link even when it
				// points at a directory, otherwise a link cycle recurses without end.
				const info = await lstat(full);
				if (info.isSymbolicLink()) continue;
				if (info.isDirectory()) await walk(full, depth + 1);
				else if (info.isFile()) sizeBytes += info.size;
			} catch {
				// skip inaccessible entries
			}
		}
	};

	await walk(dirPath, 0);
	return { sizeBytes, entriesScanned, truncated };
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

// ── Scan functions (each returns one category) ─────────────────────────────

async function scanDatabase(
	onTableProgress?: (progress: { done: number; total: number; tableName: string }) => void,
	signal?: AbortSignal,
): Promise<StorageCategoryResult> {
	const breakdown = await databaseCleanupService.scanDatabaseBreakdown({
		onProgress: onTableProgress,
		signal,
	});
	return {
		key: "database",
		sizeBytes: breakdown.mainBytes + breakdown.walBytes + breakdown.shmBytes,
		details: breakdown as unknown as Record<string, unknown>,
	};
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
export async function scanUploads(): Promise<StorageCategoryResult> {
	const uploadsDir = getUploadsDir();
	let narratorBytes = 0;
	let narratorCount = 0;
	let avatarBytes = 0;
	let truncated = false;
	try {
		const entries = await readdir(uploadsDir, { withFileTypes: true });
		for (const entry of entries) {
			const fullPath = resolve(uploadsDir, entry.name);
			if (entry.isDirectory()) {
				const measured = await measureDirSize(fullPath);
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
	} catch {
		// dir may not exist
	}
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
async function scanChatAttachments(): Promise<StorageCategoryResult> {
	const dir = getChatAttachmentsDir();
	const measured = await measureDirSize(dir);
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

async function scanShares(): Promise<StorageCategoryResult> {
	const measured = await measureDirSize(SHARES_DIR);
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
async function scanTreeSnapshots(): Promise<StorageCategoryResult> {
	const measured = await measureDirSize(TREE_SNAPSHOTS_DIR);
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
 * user's untracked secrets rather than derived data, so "how much is here and is any of
 * it orphaned" is a question worth being able to answer.
 */
async function scanDormantIgnored(): Promise<StorageCategoryResult> {
	const dir = dormantIgnoredDir();
	const measured = await measureDirSize(dir);
	let archiveCount = 0;
	let orphanCount = 0;
	try {
		const entries = await readdir(dir, { withFileTypes: true });
		const dirs = entries.filter((e) => e.isDirectory());
		archiveCount = dirs.length;
		if (dirs.length > 0) {
			// One bounded query rather than a lookup per directory: the id set is
			// human-scale (one entry per chapter that has ever gone dormant).
			const liveChapterIds = new Set(
				db
					.select({ id: chapters.id })
					.from(chapters)
					.all()
					.map((row) => row.id),
			);
			orphanCount = dirs.filter((dir) => !liveChapterIds.has(dir.name)).length;
		}
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

async function scanWorktrees(): Promise<StorageCategoryResult> {
	let totalSize = 0;
	let worktreeCount = 0;
	let truncated = false;
	const projectList: Array<{ name: string; sizeBytes: number; worktreeCount: number }> = [];

	try {
		const allProjects = db
			.select({ id: projects.id, name: projects.name, gitPath: projects.gitPath })
			.from(projects)
			.all();

		for (const proj of allProjects) {
			if (!proj.gitPath) continue;
			const wtDir = resolve(proj.gitPath, ".worktrees");
			if (!existsSync(wtDir)) continue;
			const measured = await measureDirSize(wtDir);
			truncated ||= measured.truncated;
			const projSize = measured.sizeBytes;
			let projWtCount = 0;
			try {
				const entries = await readdir(wtDir, { withFileTypes: true });
				projWtCount = entries.filter((e) => e.isDirectory()).length;
			} catch {
				// skip
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
	} catch (err) {
		logger.error("Failed to scan worktrees", { error: String(err) });
	}

	return {
		key: "worktrees",
		sizeBytes: totalSize,
		...(truncated ? { truncated } : {}),
		details: { worktreeCount, projects: projectList },
	};
}

async function scanContainers(): Promise<StorageCategoryResult> {
	try {
		const result = await safeSpawn({
			cmd: ["podman", "system", "df", "--format", "json"],
			timeout: 15_000,
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

export async function* scanStorage(
	options: { signal?: AbortSignal } = {},
): AsyncGenerator<
	| { type: "progress"; message: string; detail?: { done: number; total: number } }
	| { type: "category"; data: StorageCategoryResult },
	StorageScanResult
> {
	const { signal } = options;
	const categories: StorageCategoryResult[] = [];

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_database" };
	// The database scan measures ~116 tables and is by far the longest step, so stream table-level
	// progress instead of leaving the UI on one static message for seconds. Progress is produced by
	// a callback while we await the scan, so pump it through a queue and yield as it arrives.
	const dbProgress = createProgressPump(signal);
	const dbScan = scanDatabase(dbProgress.push, signal).finally(dbProgress.close);
	// Attached now so an abort-driven rejection is never an unhandled rejection, even if the code
	// below stops awaiting `dbScan` (for example because the consumer abandons the generator).
	dbScan.catch(() => {});
	for await (const progress of dbProgress.drain()) {
		yield {
			type: "progress",
			message: "scanning_database",
			detail: { done: progress.done, total: progress.total },
		};
	}
	if (signal?.aborted) {
		// The pump was closed by the abort, so `dbScan` may still be running. Do not await it: the
		// worker tasks are already cancelled and the caller is gone.
		throw new StorageScanAbortedError();
	}
	const dbResult = await dbScan;
	categories.push(dbResult);
	yield { type: "category", data: dbResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_uploads" };
	const uploadsResult = await scanUploads();
	categories.push(uploadsResult);
	yield { type: "category", data: uploadsResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_chat_attachments" };
	const chatAttachmentsResult = await scanChatAttachments();
	categories.push(chatAttachmentsResult);
	yield { type: "category", data: chatAttachmentsResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_shares" };
	const sharesResult = await scanShares();
	categories.push(sharesResult);
	yield { type: "category", data: sharesResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_worktrees" };
	const worktreesResult = await scanWorktrees();
	categories.push(worktreesResult);
	yield { type: "category", data: worktreesResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_tree_snapshots" };
	const treeSnapshotsResult = await scanTreeSnapshots();
	categories.push(treeSnapshotsResult);
	yield { type: "category", data: treeSnapshotsResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_dormant_ignored" };
	const dormantIgnoredResult = await scanDormantIgnored();
	categories.push(dormantIgnoredResult);
	yield { type: "category", data: dormantIgnoredResult };

	throwIfAborted(signal);
	yield { type: "progress", message: "scanning_containers" };
	const containersResult = await scanContainers();
	categories.push(containersResult);
	yield { type: "category", data: containersResult };

	throwIfAborted(signal);

	const truncated = categories.some((c) => c.truncated === true);
	const result: StorageScanResult = {
		categories,
		totalBytes: categories.reduce((sum, c) => sum + c.sizeBytes, 0),
		...(truncated ? { truncated } : {}),
		scannedAt: Date.now(),
	};
	cachedResult = result;
	return result;
}

// ── Cleanup functions ──────────────────────────────────────────────────────

export async function cleanupOrphanedUploads(): Promise<{ removed: number; freedBytes: number }> {
	const uploadsDir = getUploadsDir();
	if (!existsSync(uploadsDir)) return { removed: 0, freedBytes: 0 };

	const entries = await readdir(uploadsDir, { withFileTypes: true });
	const narratorIds = db
		.select({ id: narrators.id })
		.from(narrators)
		.all()
		.map((n) => n.id);
	// Only messages that contain an image block can pin an upload dir. Pre-filter
	// with a substring match on content_json (a superset of contentJsonHasImageBlocks,
	// which requires the literal `"type":"image"`) so we avoid loading every
	// message's content_json into memory. The exact check below stays authoritative.
	const uploadMessageOwners = db
		.select({ narratorId: narratorMessages.narratorId, contentJson: narratorMessages.contentJson })
		.from(narratorMessages)
		.where(sql`${narratorMessages.contentJson} LIKE '%"type":"image"%'`)
		.all();
	const preservedOwnerIds = buildReferencedUploadOwnerIds(narratorIds, uploadMessageOwners);

	let removed = 0;
	let freedBytes = 0;

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "avatars") continue;
		if (!preservedOwnerIds.has(entry.name)) {
			const dirPath = resolve(uploadsDir, entry.name);
			const size = await dirSize(dirPath);
			await rm(dirPath, { recursive: true, force: true });
			removed++;
			freedBytes += size;
			logger.info("Removed orphaned upload dir", { narratorId: entry.name, size });
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

/**
 * Remove ignored-file archives whose chapter no longer exists.
 *
 * The archive is written when a chapter goes dormant and consumed when it wakes, so its
 * lifetime is bounded by a chapter that can still do both. Chapter deletion, project
 * deletion and batch cleanup now discard it directly, but directories created before
 * that was true have no owner and no expiry — and what they hold is precisely the files
 * git refuses to track, i.e. the user's plaintext credentials sitting under
 * `~/.narrafork` indefinitely.
 *
 * Keyed on the chapter row existing at all rather than on its status: a dormant chapter
 * still needs its archive, and any status can still be woken or deleted, so the row
 * disappearing is the only signal that nothing will ever read it again.
 */
export async function cleanupOrphanedIgnoredArchives(): Promise<{
	removed: number;
	freedBytes: number;
}> {
	const baseDir = dormantIgnoredDir();
	if (!existsSync(baseDir)) return { removed: 0, freedBytes: 0 };

	let removed = 0;
	let freedBytes = 0;
	try {
		const entries = await readdir(baseDir, { withFileTypes: true });
		const liveChapterIds = new Set(
			db
				.select({ id: chapters.id })
				.from(chapters)
				.all()
				.map((row) => row.id),
		);
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (liveChapterIds.has(entry.name)) continue;
			const dirPath = resolve(baseDir, entry.name);
			// Per directory, not around the loop: one unreadable or permission-denied
			// archive must not stop the sweep, because everything after it would then stay
			// on disk indefinitely while the caller was told the clean-up ran.
			try {
				const size = await dirSize(dirPath);
				await rm(dirPath, { recursive: true, force: true });
				removed++;
				freedBytes += size;
				logger.info("Removed an ignored-file archive with no chapter", {
					chapterId: entry.name,
					size,
				});
			} catch (err) {
				logger.warn("Could not remove an orphaned ignored-file archive", {
					chapterId: entry.name,
					error: String(err),
				});
			}
		}
	} catch (err) {
		logger.error("Failed to clean up orphaned ignored-file archives", { error: String(err) });
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

export async function cleanupOrphanedWorktrees(): Promise<{
	removed: number;
	freedBytes: number;
}> {
	let removed = 0;
	let freedBytes = 0;

	try {
		const allProjects = db
			.select({ id: projects.id, gitPath: projects.gitPath })
			.from(projects)
			.all();

		for (const proj of allProjects) {
			if (!proj.gitPath) continue;
			const wtDir = resolve(proj.gitPath, ".worktrees");
			if (!existsSync(wtDir)) continue;

			// Get active chapter worktree paths for this project
			const activeChapters = db
				.select({ worktreePath: chapters.worktreePath })
				.from(chapters)
				.where(eq(chapters.projectId, proj.id))
				.all()
				.map((c) => c.worktreePath)
				.filter(Boolean) as string[];

			const activePaths = new Set(activeChapters);

			const entries = await readdir(wtDir, { withFileTypes: true });
			for (const entry of entries) {
				if (!entry.isDirectory()) continue;
				const fullPath = resolve(wtDir, entry.name);
				if (!activePaths.has(fullPath)) {
					const size = await dirSize(fullPath);
					// Try git worktree remove first to keep .git/worktrees clean
					try {
						await gitService.removeWorktree(proj.gitPath, fullPath);
					} catch {
						// Fallback to direct removal if git command fails
						await rm(fullPath, { recursive: true, force: true });
					}
					// The worktree's snapshot shadow repo is keyed by its path, so it is
					// unreachable once the worktree is gone and would leak otherwise.
					//
					// Deliberately not forced. "No active chapter claims this directory" is
					// not the same as "no chapter wants this history": a dormant chapter has
					// no `worktreePath`, and if its worktree removal had failed the directory
					// would still be here — sweeping it would then delete that chapter's
					// entire snapshot lineage. The guard inside `destroy` declines those.
					await worktreeTreeSnapshot.destroy(fullPath).catch((err) =>
						logger.debug("Failed to remove tree snapshots for orphaned worktree", {
							path: fullPath,
							error: String(err),
						}),
					);
					// Same reason, for the status/boundary caches keyed by that path: the
					// directory is gone, so nothing can read those entries again.
					dropStatus(fullPath);
					dropRecentlyAttributed(fullPath);
					removed++;
					freedBytes += size;
					logger.info("Removed orphaned worktree", { path: fullPath, size });
				}
			}

			// Prune stale worktree references
			try {
				await gitService.pruneWorktrees(proj.gitPath);
			} catch {
				// Non-critical — skip
			}
		}
	} catch (err) {
		logger.error("Failed to cleanup orphaned worktrees", { error: String(err) });
	}

	// Ignored-file archives are swept on the same trigger: they are the same class of
	// leftover (per-chapter state outside the repository, orphaned when a chapter row
	// goes), and a user reclaiming space has no reason to run two separate actions.
	try {
		const archives = await cleanupOrphanedIgnoredArchives();
		removed += archives.removed;
		freedBytes += archives.freedBytes;
	} catch (err) {
		logger.warn("Failed to sweep orphaned ignored-file archives", { error: String(err) });
	}

	// Repack the surviving snapshot repos. Each captured state writes loose objects,
	// so without this they grow with every tool call. Runs after the orphan sweep so
	// removed repos are not repacked first.
	try {
		await worktreeTreeSnapshot.gcAll();
	} catch (err) {
		logger.warn("Failed to gc tree snapshot repositories", { error: String(err) });
	}

	cachedResult = null;
	return { removed, freedBytes };
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
	cleanupOrphanedIgnoredArchives,
	cleanupAllShares,
	cleanupOrphanedWorktrees,
	pruneContainerImages,
};
