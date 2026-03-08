import { type FSWatcher, watch } from "node:fs";
import { eventBus } from "../lib/event-bus";
import { logger } from "../lib/logger";
import { toForwardSlash } from "../lib/platform-path";
import type { Locale } from "../lib/prompt-i18n";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";
import { checkCommitThresholds } from "./narrator-auto-commit";

/** Debounce interval for file change events (ms). */
const DEBOUNCE_MS = 1500;

/** Minimum interval between commit threshold checks per narrator (ms). */
const THRESHOLD_CHECK_INTERVAL_MS = 10_000;

/** Tracks last threshold check time per narrator to avoid excessive checks. */
const lastThresholdCheck = new Map<string, number>();

/**
 * Patterns to ignore when receiving fs.watch events.
 * These fire constantly during git operations, builds, etc.
 */
const IGNORE_PATTERNS = [
	".git",
	"node_modules",
	".next",
	"dist",
	"__pycache__",
	".DS_Store",
	"Thumbs.db",
];

function shouldIgnore(filename: string | null): boolean {
	if (!filename) return true;
	const fwd = toForwardSlash(filename);
	return IGNORE_PATTERNS.some((p) => fwd === p || fwd.startsWith(`${p}/`));
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
}

export const worktreeWatcher = {
	_entries: new Map<string, WatcherEntry>(),

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

			logger.info("Worktree watcher started", { worktreePath, chapterId, narratorId });
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
		lastThresholdCheck.delete(narratorId);
		if (entry.narratorIds.size === 0) {
			this._removeEntry(worktreePath);
			logger.info("Worktree watcher stopped (no narrators left)", { worktreePath });
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
			logger.info("Worktree watcher force-stopped", { worktreePath });
		}
	},

	/** Shut down all watchers (server shutdown). */
	shutdown(): void {
		for (const [path] of this._entries) {
			this._removeEntry(path);
		}
		logger.info("All worktree watchers shut down");
	},

	/** Internal: debounced handler for file change events. */
	_onFileChange(worktreePath: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;

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
		const { chapterId, narratorIds, locale } = entry;

		const [statusSummary, lineStats, currentHead] = await Promise.all([
			gitService.getStatusSummary(worktreePath),
			gitService.getUncommittedLineStats(worktreePath),
			gitService.getHeadCommit(worktreePath).catch(() => ""),
		]);

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
				linesAdded: lineStats.added,
				linesRemoved: lineStats.removed,
			});
		}

		// Check commit thresholds for each narrator (rate-limited)
		const filesChanged = statusSummary.staged + statusSummary.unstaged + statusSummary.untracked;
		if (filesChanged > 0) {
			const now = Date.now();
			for (const narratorId of narratorIds) {
				const lastCheck = lastThresholdCheck.get(narratorId) ?? 0;
				if (now - lastCheck < THRESHOLD_CHECK_INTERVAL_MS) continue;
				lastThresholdCheck.set(narratorId, now);
				checkCommitThresholds(narratorId, chapterId, worktreePath, locale, {
					linesAdded: lineStats.added,
					linesRemoved: lineStats.removed,
					filesChanged,
				}).catch((err) => {
					logger.debug("Commit threshold check failed (watcher)", {
						narratorId,
						error: String(err),
					});
				});
			}
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
