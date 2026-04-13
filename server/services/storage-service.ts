import { existsSync } from "node:fs";
import { readdir, rm, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { logger } from "../lib/logger";
import { databaseCleanupService } from "./database-cleanup-service";
import { gitService } from "./git-service";

// ── Types ──────────────────────────────────────────────────────────────────

export interface StorageCategoryResult {
	key: string;
	sizeBytes: number;
	details?: Record<string, unknown>;
}

export interface StorageScanResult {
	categories: StorageCategoryResult[];
	totalBytes: number;
	scannedAt: number; // epoch ms
}

// ── Paths ──────────────────────────────────────────────────────────────────

const NARRAFORK_DIR = resolve(homedir(), ".narrafork");
const UPLOADS_DIR = resolve(NARRAFORK_DIR, "uploads");
const SHARES_DIR = resolve(NARRAFORK_DIR, "shares");

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

/** Recursively sum file sizes in a directory (async to avoid blocking the event loop). */
async function dirSize(dirPath: string): Promise<number> {
	if (!existsSync(dirPath)) return 0;
	let total = 0;
	try {
		const entries = await readdir(dirPath, { withFileTypes: true });
		for (const entry of entries) {
			const full = resolve(dirPath, entry.name);
			try {
				if (entry.isDirectory()) {
					total += await dirSize(full);
				} else if (entry.isFile()) {
					total += (await stat(full)).size;
				}
			} catch {
				// skip inaccessible files
			}
		}
	} catch {
		// directory not readable
	}
	return total;
}

// ── Scan functions (each returns one category) ─────────────────────────────

async function scanDatabase(): Promise<StorageCategoryResult> {
	const breakdown = await databaseCleanupService.scanDatabaseBreakdown();
	return {
		key: "database",
		sizeBytes: breakdown.mainBytes + breakdown.walBytes + breakdown.shmBytes,
		details: breakdown as unknown as Record<string, unknown>,
	};
}

async function scanUploads(): Promise<StorageCategoryResult> {
	const totalSize = await dirSize(UPLOADS_DIR);
	let narratorCount = 0;
	let avatarSize = 0;
	try {
		const entries = await readdir(UPLOADS_DIR, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (entry.name === "avatars") {
				avatarSize = await dirSize(resolve(UPLOADS_DIR, "avatars"));
			} else {
				narratorCount++;
			}
		}
	} catch {
		// dir may not exist
	}
	return {
		key: "uploads",
		sizeBytes: totalSize,
		details: {
			narratorDirs: narratorCount,
			avatarBytes: avatarSize,
			narratorBytes: totalSize - avatarSize,
		},
	};
}

async function scanShares(): Promise<StorageCategoryResult> {
	const totalSize = await dirSize(SHARES_DIR);
	let fileCount = 0;
	try {
		const entries = await readdir(SHARES_DIR, { withFileTypes: true });
		fileCount = entries.filter((e) => e.isDirectory()).length;
	} catch {
		// dir may not exist
	}
	return {
		key: "shares",
		sizeBytes: totalSize,
		details: { shareCount: fileCount },
	};
}

async function scanWorktrees(): Promise<StorageCategoryResult> {
	let totalSize = 0;
	let worktreeCount = 0;
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
			const projSize = await dirSize(wtDir);
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
		details: { worktreeCount, projects: projectList },
	};
}

async function scanContainers(): Promise<StorageCategoryResult> {
	try {
		const proc = Bun.spawn(["podman", "system", "df", "--format", "json"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const text = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		if (exitCode !== 0) {
			return { key: "containers", sizeBytes: 0, details: { available: false } };
		}
		const data = JSON.parse(text);
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

export async function* scanStorage(): AsyncGenerator<
	{ type: "progress"; message: string } | { type: "category"; data: StorageCategoryResult },
	StorageScanResult
> {
	const categories: StorageCategoryResult[] = [];

	yield { type: "progress", message: "scanning_database" };
	const dbResult = await scanDatabase();
	categories.push(dbResult);
	yield { type: "category", data: dbResult };

	yield { type: "progress", message: "scanning_uploads" };
	const uploadsResult = await scanUploads();
	categories.push(uploadsResult);
	yield { type: "category", data: uploadsResult };

	yield { type: "progress", message: "scanning_shares" };
	const sharesResult = await scanShares();
	categories.push(sharesResult);
	yield { type: "category", data: sharesResult };

	yield { type: "progress", message: "scanning_worktrees" };
	const worktreesResult = await scanWorktrees();
	categories.push(worktreesResult);
	yield { type: "category", data: worktreesResult };

	yield { type: "progress", message: "scanning_containers" };
	const containersResult = await scanContainers();
	categories.push(containersResult);
	yield { type: "category", data: containersResult };

	const result: StorageScanResult = {
		categories,
		totalBytes: categories.reduce((sum, c) => sum + c.sizeBytes, 0),
		scannedAt: Date.now(),
	};
	cachedResult = result;
	return result;
}

// ── Cleanup functions ──────────────────────────────────────────────────────

export async function cleanupOrphanedUploads(): Promise<{ removed: number; freedBytes: number }> {
	if (!existsSync(UPLOADS_DIR)) return { removed: 0, freedBytes: 0 };

	const entries = await readdir(UPLOADS_DIR, { withFileTypes: true });
	const narratorIds = new Set(
		db
			.select({ id: narrators.id })
			.from(narrators)
			.all()
			.map((n) => n.id),
	);

	let removed = 0;
	let freedBytes = 0;

	for (const entry of entries) {
		if (!entry.isDirectory() || entry.name === "avatars") continue;
		if (!narratorIds.has(entry.name)) {
			const dirPath = resolve(UPLOADS_DIR, entry.name);
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

	cachedResult = null;
	return { removed, freedBytes };
}

export async function pruneContainerImages(): Promise<{ success: boolean; output: string }> {
	try {
		// Only prune dangling images (-f without -a) to avoid removing intentionally kept images
		const proc = Bun.spawn(["podman", "image", "prune", "-f"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		const output = await new Response(proc.stdout).text();
		const exitCode = await proc.exited;
		cachedResult = null;
		return { success: exitCode === 0, output: output.trim() };
	} catch {
		return { success: false, output: "Podman is not available" };
	}
}

export const storageService = {
	getCachedScanResult,
	invalidateStorageCache,
	scanStorage,
	cleanupOrphanedUploads,
	cleanupAllShares,
	cleanupOrphanedWorktrees,
	pruneContainerImages,
};
