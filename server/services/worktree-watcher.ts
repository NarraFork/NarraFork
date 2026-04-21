/**
 * Worktree file watcher service.
 *
 * Monitors worktree directories for file changes and broadcasts git status
 * updates to subscribed narrators via WebSocket.
 *
 * Architecture (modelled after VS Code):
 *   @parcel/watcher (1 native recursive subscription per worktree)
 *     → event coalescing (75ms aggregate + merge)
 *     → throttled emission (500/batch, 200ms rest)
 *     → debounce (1.5s) + rate limit
 *     → git status query + WS broadcast
 *
 * This replaces the previous approach of N × fs.watch() per worktree
 * (one per subdirectory), which consumed O(directories) inotify watches.
 * Now each worktree uses exactly 1 inotify watch via @parcel/watcher.
 */

import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { ParcelRecursiveWatcher } from "../lib/watcher/parcel-watcher";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";

/** Debounce interval for file change events (ms). */
const DEBOUNCE_MS = 1500;

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
	chapterId: string;
	narratorIds: Set<string>;
	locale: Locale;
	debounceTimer?: ReturnType<typeof setTimeout>;
	lastHeadSha?: string;
	rateLimit: RateLimitState;
}

// ── Singleton ParcelRecursiveWatcher ────────────────────────────────────────

/**
 * Single shared ParcelRecursiveWatcher instance, pinned to globalThis
 * so it survives Bun hot reloads.
 */
const parcelWatcher = hotSafe<ParcelRecursiveWatcher>(
	"narrafork.worktreeWatcher.parcel",
	() =>
		new ParcelRecursiveWatcher((rootPath, _events) => {
			// Events from parcel are already coalesced and throttled.
			// We just need to trigger the debounced git-status flow.
			worktreeWatcher._onFileChange(rootPath);
		}),
);

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
	 * Uses @parcel/watcher for a single native recursive subscription per
	 * worktree root, replacing the previous N × fs.watch() approach.
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

		const entry: WatcherEntry = {
			chapterId,
			narratorIds: new Set([narratorId]),
			locale,
			rateLimit: { windowStart: Date.now(), count: 0, warned: false },
		};

		this._entries.set(worktreePath, entry);

		// Start the parcel watcher (async, fire-and-forget)
		parcelWatcher.watch(worktreePath).catch((err) => {
			logger.warn("Failed to start worktree watcher", {
				worktreePath,
				error: String(err),
			});
		});

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
			activeEntries: this._entries.size,
		});
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
		// Also shut down the underlying parcel watcher
		parcelWatcher.shutdown().catch(() => {});
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
			eventBus.emit({
				type: "narrator:ws_broadcast",
				narratorId,
				message: {
					type: "git_status",
					narratorId,
					chapterId,
					toolUseId: "",
					status: statusWithoutFiles as typeof statusSummary,
					linesAdded: statusSummary.linesAdded,
					linesRemoved: statusSummary.linesRemoved,
				},
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
						eventBus.emit({
							type: "narrator:ws_broadcast",
							narratorId,
							message: {
								type: "commits_updated",
								narratorId,
								chapterId,
								newCount,
							},
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
		this._entries.delete(worktreePath);

		// Stop the underlying parcel watcher for this path
		parcelWatcher.unwatch(worktreePath).catch(() => {});
	},
};
