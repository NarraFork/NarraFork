import { type FSWatcher, readdirSync, statSync, watch } from "node:fs";
import { join } from "node:path";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";

/** Debounce interval for file change events (ms). */
const DEBOUNCE_MS = 1500;

// ── Directory-level ignore (prevents inotify registration entirely) ─────────

/**
 * Directories to skip during tree walk.
 *
 * Unlike the old approach (recursive fs.watch + JS callback filter), these
 * directories are never watched at all — no inotify watch is registered, so
 * the kernel never delivers events for them. This is the key to avoiding CPU
 * saturation on Linux where Bun ≤1.3 registers per-file inotify watches
 * inside recursive fs.watch (see oven-sh/bun#28290).
 */
const SKIP_DIRS = new Set([
	".git",
	"node_modules",
	".next",
	"dist",
	"build",
	"out",
	"__pycache__",
	".cache",
	".parcel-cache",
	".turbo",
	".nuxt",
	".output",
	".svelte-kit",
	"target",
	".venv",
	"venv",
	"vendor",
	".gradle",
	".idea",
	".vscode",
	"coverage",
	".nyc_output",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	".worktrees",
]);

// ── File-level ignore (callback filter for individual file events) ──────────

const IGNORE_FILES = new Set([".DS_Store", "Thumbs.db"]);
const IGNORE_EXTENSIONS = [".swp", ".swo"];

function shouldIgnoreFile(filename: string | null): boolean {
	if (!filename) return true;
	if (IGNORE_FILES.has(filename)) return true;
	for (const ext of IGNORE_EXTENSIONS) {
		if (filename.endsWith(ext)) return true;
	}
	return false;
}

// ── Rate limiter ────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 2000;
const RATE_LIMIT = 200;

interface RateLimitState {
	windowStart: number;
	count: number;
	warned: boolean;
}

// ── Watcher entry ───────────────────────────────────────────────────────────

interface WatcherEntry {
	/** One non-recursive FSWatcher per watched directory. */
	watchers: Map<string, FSWatcher>;
	chapterId: string;
	narratorIds: Set<string>;
	locale: Locale;
	debounceTimer?: ReturnType<typeof setTimeout>;
	lastHeadSha?: string;
	rateLimit: RateLimitState;
}

// ── Tree walk + per-directory watch ─────────────────────────────────────────

/**
 * Recursively walk `rootPath`, registering a non-recursive `fs.watch()` on
 * every directory whose name is not in {@link SKIP_DIRS}.
 *
 * Returns a `Map<absoluteDirPath, FSWatcher>`.
 */
function walkAndWatch(
	rootPath: string,
	onEvent: (dirPath: string, eventType: string, filename: string | null) => void,
	onError: (dirPath: string, err: Error) => void,
): Map<string, FSWatcher> {
	const watchers = new Map<string, FSWatcher>();

	function addWatch(dirPath: string): void {
		if (watchers.has(dirPath)) return;
		try {
			const w = watch(dirPath, (eventType, filename) => {
				onEvent(dirPath, eventType, filename);
			});
			w.on("error", (err) => onError(dirPath, err));
			watchers.set(dirPath, w);
		} catch {
			// Directory may have been removed between readdir and watch
		}
	}

	function walk(dirPath: string): void {
		addWatch(dirPath);
		let entries: import("node:fs").Dirent[];
		try {
			entries = readdirSync(dirPath, { withFileTypes: true }) as import("node:fs").Dirent[];
		} catch {
			return; // Permission denied or removed
		}
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const name = String(entry.name);
			if (SKIP_DIRS.has(name)) continue;
			walk(join(dirPath, name));
		}
	}

	walk(rootPath);
	return watchers;
}

// ── Public API ──────────────────────────────────────────────────────────────

export const worktreeWatcher = {
	_entries: hotSafe<Map<string, WatcherEntry>>(
		"narrafork.worktreeWatcher.entries",
		() => new Map(),
	),

	getActiveCount(): number {
		return this._entries.size;
	},

	getActivePaths(): Array<{ path: string; chapterId: string; narratorCount: number }> {
		const result: Array<{ path: string; chapterId: string; narratorCount: number }> = [];
		for (const [path, entry] of this._entries) {
			result.push({
				path,
				chapterId: entry.chapterId,
				narratorCount: entry.narratorIds.size,
			});
		}
		return result;
	},

	/**
	 * Start watching a worktree directory for file changes.
	 * Multiple narrators can share the same watcher (same chapter).
	 *
	 * Instead of a single recursive `fs.watch` (which on Linux/Bun registers
	 * inotify watches on every file including `.git/objects`), we manually walk
	 * the directory tree and create one non-recursive watcher per directory,
	 * skipping {@link SKIP_DIRS} entirely so no inotify resources are wasted.
	 */
	watch(worktreePath: string, chapterId: string, narratorId: string, locale: Locale): void {
		const existing = this._entries.get(worktreePath);
		if (existing) {
			existing.narratorIds.add(narratorId);
			logger.debug("Worktree watcher: narrator added to existing watcher", {
				worktreePath,
				narratorId,
				totalNarrators: existing.narratorIds.size,
			});
			return;
		}

		try {
			const entry: WatcherEntry = {
				watchers: new Map(),
				chapterId,
				narratorIds: new Set([narratorId]),
				locale,
				rateLimit: { windowStart: Date.now(), count: 0, warned: false },
			};

			const onEvent = (dirPath: string, eventType: string, filename: string | null) => {
				if (shouldIgnoreFile(filename)) return;

				// Detect newly created subdirectories and start watching them.
				// On Linux, `rename` is emitted for both creation and deletion.
				if (eventType === "rename" && filename) {
					const fullPath = join(dirPath, filename);
					if (!SKIP_DIRS.has(filename) && !entry.watchers.has(fullPath)) {
						try {
							const st = statSync(fullPath);
							if (st.isDirectory()) {
								// Recursively watch the new subtree
								const newWatchers = walkAndWatch(fullPath, onEvent, onError);
								for (const [p, w] of newWatchers) {
									entry.watchers.set(p, w);
								}
							}
						} catch {
							// Path was deleted or inaccessible — ignore
						}
					}
				}

				this._onFileChange(worktreePath);
			};

			const onError = (dirPath: string, err: Error) => {
				// A single sub-watcher errored (directory removed, etc.)
				// Close just that watcher; the rest keep running.
				const w = entry.watchers.get(dirPath);
				if (w) {
					try {
						w.close();
					} catch {}
					entry.watchers.delete(dirPath);
				}
				logger.debug("Worktree sub-watcher error (removed)", {
					dirPath,
					error: String(err),
				});
				// If ALL watchers are gone, clean up the entry entirely
				if (entry.watchers.size === 0) {
					logger.warn("Worktree watcher: all sub-watchers lost", { worktreePath });
					this._removeEntry(worktreePath);
				}
			};

			const watchers = walkAndWatch(worktreePath, onEvent, onError);
			entry.watchers = watchers;

			this._entries.set(worktreePath, entry);

			// Capture initial HEAD SHA
			gitService
				.getHeadCommit(worktreePath)
				.then((sha) => {
					if (this._entries.has(worktreePath)) {
						entry.lastHeadSha = sha;
					}
				})
				.catch(() => {});

			logger.info("Worktree watcher started", {
				worktreePath,
				chapterId,
				narratorId,
				dirWatchers: watchers.size,
				activeEntries: this._entries.size,
			});
		} catch (err) {
			logger.warn("Failed to start worktree watcher", {
				worktreePath,
				error: String(err),
			});
		}
	},

	/**
	 * Remove a narrator's interest in a worktree.
	 * When the last narrator leaves, the watcher is closed.
	 */
	unwatch(worktreePath: string, narratorId: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;

		entry.narratorIds.delete(narratorId);
		if (entry.narratorIds.size === 0) {
			this._removeEntry(worktreePath);
			logger.info("Worktree watcher stopped (no narrators left)", {
				worktreePath,
				activeEntries: this._entries.size,
			});
		} else {
			logger.debug("Worktree watcher: narrator removed", {
				worktreePath,
				narratorId,
				remaining: entry.narratorIds.size,
			});
		}
	},

	/**
	 * Force-close a watcher for a worktree path (e.g. before dormant removes the directory).
	 */
	unwatchAll(worktreePath: string): void {
		if (this._entries.has(worktreePath)) {
			this._removeEntry(worktreePath);
			logger.info("Worktree watcher force-stopped", {
				worktreePath,
				activeEntries: this._entries.size,
			});
		}
	},

	/** Shut down all watchers (server shutdown or startup recovery). */
	shutdown(): void {
		const count = this._entries.size;
		const paths = [...this._entries.keys()];
		for (const path of paths) {
			this._removeEntry(path);
		}
		if (count > 0) {
			logger.info("All worktree watchers shut down", { count });
		}
	},

	/** Internal: debounced handler for file change events with rate limiting. */
	_onFileChange(worktreePath: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;

		const now = Date.now();
		const rl = entry.rateLimit;
		if (now - rl.windowStart > RATE_WINDOW_MS) {
			rl.windowStart = now;
			rl.count = 0;
			rl.warned = false;
		}
		rl.count++;
		if (rl.count > RATE_LIMIT) {
			if (!rl.warned) {
				rl.warned = true;
				logger.warn("Worktree watcher rate limit exceeded, suppressing events", {
					worktreePath,
					eventsInWindow: rl.count,
					windowMs: RATE_WINDOW_MS,
				});
			}
			return;
		}

		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		entry.debounceTimer = setTimeout(() => {
			entry.debounceTimer = undefined;
			this._processChange(worktreePath, entry).catch((err) => {
				logger.debug("Worktree watcher change processing failed", {
					worktreePath,
					error: String(err),
				});
			});
		}, DEBOUNCE_MS);
	},

	/** Internal: process a debounced file change event. */
	async _processChange(worktreePath: string, entry: WatcherEntry): Promise<void> {
		const { chapterId, narratorIds } = entry;

		const statusSummary = await gitService.getStatusSummary(worktreePath);
		const currentHead = statusSummary.headSha;

		// Strip files array from WS broadcast to keep payloads small
		const { files: _files, ...statusWithoutFiles } = statusSummary;

		// Broadcast git status to all subscribed narrators
		for (const narratorId of narratorIds) {
			broadcastToNarrator(narratorId, {
				type: "git_status",
				narratorId,
				chapterId,
				toolUseId: "",
				status: statusWithoutFiles as typeof statusSummary,
				linesAdded: statusSummary.linesAdded,
				linesRemoved: statusSummary.linesRemoved,
			});
		}

		// Detect new commits (HEAD changed)
		if (currentHead && entry.lastHeadSha && currentHead !== entry.lastHeadSha) {
			entry.lastHeadSha = currentHead;

			// Sync commit history from git log
			try {
				const newCount = await commitSyncService.syncChapterCommits(chapterId);
				if (newCount > 0) {
					eventBus.emit({ type: "chapter:commits_updated", chapterId, newCount });
					for (const narratorId of narratorIds) {
						broadcastToNarrator(narratorId, {
							type: "commits_updated",
							narratorId,
							chapterId,
							newCount,
						});
					}
				}
			} catch (err) {
				logger.debug("Commit sync failed (watcher)", {
					chapterId,
					error: String(err),
				});
			}
		} else if (currentHead && !entry.lastHeadSha) {
			entry.lastHeadSha = currentHead;
		}

		eventBus.emit({ type: "chapter:files_changed", chapterId, worktreePath });
	},

	/** Internal: close and remove a watcher entry. */
	_removeEntry(worktreePath: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		for (const w of entry.watchers.values()) {
			try {
				w.close();
			} catch {}
		}
		entry.watchers.clear();
		this._entries.delete(worktreePath);
	},
};
