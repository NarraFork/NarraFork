import { type FSWatcher, watch } from "node:fs";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { toForwardSlash } from "../lib/platform-path";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";

/** Debounce interval for file change events (ms). */
const DEBOUNCE_MS = 1500;

/**
 * Patterns to ignore when receiving fs.watch events.
 * These fire constantly during git operations, builds, package installs, etc.
 * On Linux, fs.watch({ recursive: true }) uses inotify which still delivers
 * events for these directories — the callback filters them, but the kernel
 * overhead of dispatching thousands of events per second can saturate a CPU core.
 * Keep this list comprehensive to minimize wasted event processing.
 */
const IGNORE_PATTERNS = [
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
	".DS_Store",
	"Thumbs.db",
	"coverage",
	".nyc_output",
	".pytest_cache",
	".mypy_cache",
	".ruff_cache",
	".tox",
	"*.swp",
	"*.swo",
];

/** Patterns matched by exact filename (no path prefix check needed). */
const IGNORE_EXACT = new Set([".DS_Store", "Thumbs.db"]);

/** Patterns matched by extension (glob-like entries starting with *). */
const IGNORE_EXTENSIONS: string[] = [];

/** Patterns matched by directory prefix. */
const IGNORE_DIRS: string[] = [];

// Pre-partition patterns for faster matching
for (const p of IGNORE_PATTERNS) {
	if (p.startsWith("*.")) {
		IGNORE_EXTENSIONS.push(p.slice(1)); // e.g. ".swp"
	} else if (!IGNORE_EXACT.has(p)) {
		IGNORE_DIRS.push(p);
	}
}

function shouldIgnore(filename: string | null): boolean {
	if (!filename) return true;
	const fwd = toForwardSlash(filename);
	if (IGNORE_EXACT.has(fwd)) return true;
	for (const ext of IGNORE_EXTENSIONS) {
		if (fwd.endsWith(ext)) return true;
	}
	for (const dir of IGNORE_DIRS) {
		if (fwd === dir || fwd.startsWith(`${dir}/`)) return true;
	}
	return false;
}

/**
 * Rate limiter: tracks event count in a sliding window.
 * When the rate exceeds the threshold, events are suppressed until the window resets.
 */
const RATE_WINDOW_MS = 2000;
const RATE_LIMIT = 200; // max events per window before suppression

interface RateLimitState {
	/** Timestamp of the current window start. */
	windowStart: number;
	/** Number of events in the current window. */
	count: number;
	/** Whether we've already logged a warning for this suppression burst. */
	warned: boolean;
}

interface WatcherEntry {
	watcher: FSWatcher;
	chapterId: string;
	/** Narrator IDs currently interested in this worktree. */
	narratorIds: Set<string>;
	/** Locale for commit threshold messages (from the first narrator that registered). */
	locale: Locale;
	debounceTimer?: ReturnType<typeof setTimeout>;
	/** Last known HEAD SHA — used to detect new commits. */
	lastHeadSha?: string;
	/** Rate limiter state for this watcher. */
	rateLimit: RateLimitState;
}

export const worktreeWatcher = {
	_entries: hotSafe<Map<string, WatcherEntry>>(
		"narrafork.worktreeWatcher.entries",
		() => new Map(),
	),

	/** Get the number of active watchers (for diagnostics). */
	getActiveCount(): number {
		return this._entries.size;
	},

	/** Get active watcher paths and their narrator counts (for diagnostics). */
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
			const fsWatcher = watch(worktreePath, { recursive: true }, (_eventType, filename) => {
				if (shouldIgnore(filename)) return;
				this._onFileChange(worktreePath);
			});

			fsWatcher.on("error", (err) => {
				logger.warn("Worktree watcher error", {
					worktreePath,
					error: String(err),
				});
				// Clean up broken watcher
				this._removeEntry(worktreePath);
			});

			const entry: WatcherEntry = {
				watcher: fsWatcher,
				chapterId,
				narratorIds: new Set([narratorId]),
				locale,
				rateLimit: { windowStart: Date.now(), count: 0, warned: false },
			};

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
				activeWatchers: this._entries.size,
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
				activeWatchers: this._entries.size,
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
				activeWatchers: this._entries.size,
			});
		}
	},

	/** Shut down all watchers (server shutdown or startup recovery). */
	shutdown(): void {
		const count = this._entries.size;
		// Snapshot keys first — _removeEntry mutates the Map, and deleting
		// during for..of iteration can skip entries on some engines.
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

		// Rate limiting: suppress excessive events to prevent CPU saturation.
		// On Linux, fs.watch({ recursive: true }) can fire thousands of inotify
		// events per second during builds/installs even for ignored directories,
		// because the kernel delivers events before our JS callback can filter them.
		const now = Date.now();
		const rl = entry.rateLimit;
		if (now - rl.windowStart > RATE_WINDOW_MS) {
			// Reset window
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
			// First time we got a HEAD — just record it
			entry.lastHeadSha = currentHead;
		}

		eventBus.emit({ type: "chapter:files_changed", chapterId, worktreePath });
	},

	/** Internal: close and remove a watcher entry. */
	_removeEntry(worktreePath: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		try {
			entry.watcher.close();
		} catch {
			// Watcher may already be closed
		}
		this._entries.delete(worktreePath);
	},
};
