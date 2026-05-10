/**
 * Worktree file watcher service.
 *
 * Monitors worktree directories for file changes and broadcasts git status
 * updates to subscribed narrators via WebSocket.
 *
 * Architecture (modelled after VS Code):
 *   optional isolated @parcel/watcher worker process
 *     → event coalescing (75ms aggregate + merge)
 *     → throttled emission (500/batch, 200ms rest)
 *     → debounce (1.5s) + rate limit
 *     → git status query + WS broadcast
 *
 * If the native worker is disabled or unhealthy, the service keeps the same
 * registry active and falls back to low-frequency git-status polling. The main
 * server never loads @parcel/watcher's native addon directly.
 */

import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { isNativeWatcherEnabled, ParcelRecursiveWatcher } from "../lib/watcher/parcel-watcher";
import { commitSyncService } from "./commit-sync-service";
import { gitService } from "./git-service";

/** Debounce interval for file change events (ms). */
const DEBOUNCE_MS = 1500;

// ── Rate limiter ────────────────────────────────────────────────────────────

const RATE_WINDOW_MS = 2000;
const RATE_LIMIT = 200;
const FALLBACK_POLL_INTERVAL_MS = Math.max(
	1000,
	Number(process.env.NARRAFORK_WATCHER_POLL_INTERVAL_MS) || 5000,
);

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
	pollTimer?: ReturnType<typeof setInterval>;
	lastHeadSha?: string;
	lastStatusSignature?: string;
	processing: boolean;
	pendingProcess: boolean;
	rateLimit: RateLimitState;
}

interface StatusSignatureFileInput {
	status: string;
	path: string;
	linesAdded: number;
	linesRemoved: number;
	stagedLinesAdded: number;
	stagedLinesRemoved: number;
	unstagedLinesAdded: number;
	unstagedLinesRemoved: number;
}

interface StatusSignatureInput {
	hasChanges: boolean;
	staged: number;
	unstaged: number;
	untracked: number;
	totalFiles: number;
	headSha?: string;
	branch?: string;
	linesAdded: number;
	linesRemoved: number;
	files?: StatusSignatureFileInput[];
}

function getStatusSignature(status: StatusSignatureInput): string {
	return JSON.stringify({
		hasChanges: status.hasChanges,
		staged: status.staged,
		unstaged: status.unstaged,
		untracked: status.untracked,
		totalFiles: status.totalFiles,
		headSha: status.headSha,
		branch: status.branch,
		linesAdded: status.linesAdded,
		linesRemoved: status.linesRemoved,
		files: [...(status.files ?? [])]
			.sort((a, b) => a.path.localeCompare(b.path) || a.status.localeCompare(b.status))
			.map((file) => ({
				status: file.status,
				path: file.path,
				linesAdded: file.linesAdded,
				linesRemoved: file.linesRemoved,
				stagedLinesAdded: file.stagedLinesAdded,
				stagedLinesRemoved: file.stagedLinesRemoved,
				unstagedLinesAdded: file.unstagedLinesAdded,
				unstagedLinesRemoved: file.unstagedLinesRemoved,
			})),
	});
}

// ── Singleton ParcelRecursiveWatcher ────────────────────────────────────────

/**
 * Single shared ParcelRecursiveWatcher instance, pinned to globalThis
 * so it survives Bun hot reloads.
 */
const parcelWatcher = hotSafe<ParcelRecursiveWatcher>(
	"narrafork.worktreeWatcher.parcel",
	() =>
		new ParcelRecursiveWatcher(
			(rootPath, events) => {
				// Events from parcel are already coalesced and throttled.
				// We just need to trigger the debounced git-status flow.
				worktreeWatcher._onFileChange(rootPath, events.length);
			},
			(reason) => {
				worktreeWatcher._onWatcherBackendUnavailable(reason);
			},
		),
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
			processing: false,
			pendingProcess: false,
			rateLimit: { windowStart: Date.now(), count: 0, warned: false },
		};

		this._entries.set(worktreePath, entry);

		// Start the native parcel watcher through an isolated worker process.
		// If disabled or unhealthy, keep the registry alive and use polling fallback.
		if (isNativeWatcherEnabled()) {
			parcelWatcher.watch(worktreePath).catch((err) => {
				logger.warn("Failed to start native worktree watcher", {
					worktreePath,
					error: String(err),
				});
				this._startFallbackPolling(worktreePath, entry, String(err));
			});
		} else {
			this._startFallbackPolling(worktreePath, entry, "native watcher disabled");
		}

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
	_onFileChange(worktreePath: string, eventCount = 1): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;

		const normalizedEventCount = Math.max(1, eventCount);
		const now = Date.now();
		const rl = entry.rateLimit;
		if (now - rl.windowStart > RATE_WINDOW_MS) {
			rl.windowStart = now;
			rl.count = 0;
			rl.warned = false;
		}
		rl.count += normalizedEventCount;
		if (rl.count > RATE_LIMIT) {
			if (entry.debounceTimer) {
				clearTimeout(entry.debounceTimer);
				entry.debounceTimer = undefined;
			}
			if (!rl.warned) {
				rl.warned = true;
				logger.warn("Worktree watcher rate limit exceeded, suppressing events", {
					worktreePath,
					eventsInWindow: rl.count,
					eventCount: normalizedEventCount,
					windowMs: RATE_WINDOW_MS,
				});
			}
			return;
		}

		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		entry.debounceTimer = setTimeout(() => {
			entry.debounceTimer = undefined;
			this._enqueueProcessChange(worktreePath, entry);
		}, DEBOUNCE_MS);
	},

	/** Internal: native watcher failed/disabled; enable polling for all active worktrees. */
	_onWatcherBackendUnavailable(reason: string): void {
		for (const [worktreePath, entry] of this._entries) {
			this._startFallbackPolling(worktreePath, entry, reason);
		}
	},

	/** Internal: start low-frequency git status polling fallback. */
	_startFallbackPolling(worktreePath: string, entry: WatcherEntry, reason: string): void {
		if (entry.pollTimer) return;
		logger.info("Worktree watcher fallback polling started", {
			worktreePath,
			chapterId: entry.chapterId,
			reason,
			intervalMs: FALLBACK_POLL_INTERVAL_MS,
		});
		entry.pollTimer = setInterval(() => {
			if (!this._entries.has(worktreePath)) return;
			this._enqueueProcessChange(worktreePath, entry);
		}, FALLBACK_POLL_INTERVAL_MS);
	},

	/** Internal: coalesce concurrent git-status refreshes per worktree. */
	_enqueueProcessChange(worktreePath: string, entry: WatcherEntry): void {
		if (!this._entries.has(worktreePath)) return;
		if (entry.processing) {
			entry.pendingProcess = true;
			return;
		}

		entry.processing = true;
		this._processChange(worktreePath, entry)
			.catch((err) => {
				logger.debug("Worktree watcher change processing failed", {
					worktreePath,
					error: String(err),
				});
			})
			.finally(() => {
				entry.processing = false;
				if (!this._entries.has(worktreePath)) return;
				if (entry.pendingProcess) {
					entry.pendingProcess = false;
					this._enqueueProcessChange(worktreePath, entry);
				}
			});
	},

	/** Internal: process a debounced file change event. */
	async _processChange(worktreePath: string, entry: WatcherEntry): Promise<void> {
		const { chapterId, narratorIds } = entry;

		const statusSummary = await gitService.getStatusSummary(worktreePath);
		const currentHead = statusSummary.headSha;
		const previousHead = entry.lastHeadSha;
		const statusSignature = getStatusSignature(statusSummary);
		const statusChanged = statusSignature !== entry.lastStatusSignature;

		if (statusChanged) {
			entry.lastStatusSignature = statusSignature;

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
		}

		// Detect new commits (HEAD changed)
		if (currentHead && previousHead && currentHead !== previousHead) {
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
		} else if (currentHead && !previousHead) {
			entry.lastHeadSha = currentHead;
		}

		if (statusChanged) {
			eventBus.emit({ type: "chapter:files_changed", chapterId, worktreePath });
		}
	},

	/** Internal: close and remove a watcher entry. */
	_removeEntry(worktreePath: string): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;
		if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
		if (entry.pollTimer) clearInterval(entry.pollTimer);
		entry.pendingProcess = false;
		this._entries.delete(worktreePath);

		// Stop the underlying parcel watcher for this path
		parcelWatcher.unwatch(worktreePath).catch(() => {});
	},
};
