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
 *
 * The native worker is opt-in (`NARRAFORK_ENABLE_NATIVE_WATCHER`), so polling is not a
 * rare degraded mode — it is the default path for every attached narrator. That makes
 * the per-tick cost a main-thread budget question rather than a footnote: a polled tick
 * that finds an unchanged git status therefore skips the snapshot capture and DAG
 * advance, which is where the expensive work is — but only for a bounded run of ticks,
 * because an unchanged status signature does not prove an unchanged workspace. See
 * `_processChange` and `MAX_SKIPPED_POLLS`.
 */

import { relative } from "node:path";
import { LOCAL_DEVICE_ID } from "../lib/agent/execution/backend";
import { eventBus } from "../lib/event-bus";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import type { Locale } from "../lib/prompt-i18n";
import { isNativeWatcherEnabled, ParcelRecursiveWatcher } from "../lib/watcher/parcel-watcher";
import { advanceChapterSnapshot } from "./chapter-snapshot-ref";
import { commitSyncService } from "./commit-sync-service";
import { recordAttributions, wasRecentlyAttributed } from "./file-attribution-service";
import { gitService } from "./git-service";
import { getStatusSummaryCached, invalidateStatus } from "./git-status-cache";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

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
	/** Paths reported by the native watcher during the current debounce window. */
	pendingPaths?: Set<string>;
	/** True when more paths changed than {@link MAX_PENDING_PATHS} allows. */
	pendingPathsTruncated?: boolean;
	/**
	 * Consecutive polled ticks skipped on an unchanged status signature.
	 *
	 * Reset by any tick that actually captures. Bounded by {@link MAX_SKIPPED_POLLS};
	 * see `_processChange` for why an unchanged signature is not proof of an unchanged
	 * workspace.
	 */
	skippedPolls?: number;
}

/**
 * Skipped polled ticks after which one capture runs regardless of the signature.
 *
 * The signature is *not* strictly content-derived, contrary to what this file used to
 * claim. It folds in `git diff --numstat` counts, the status code and the path, so a
 * same-size edit to an already-dirty file — replacing `foo` with `bar` on one line —
 * keeps `1 1`, keeps ` M`, keeps the path, and produces a byte-identical signature while
 * the file on disk has different content. Every such tick was skipped, and polling is the
 * default path (the native watcher needs `NARRAFORK_ENABLE_NATIVE_WATCHER`), so "an
 * external edit is revertable" quietly did not hold for that shape of edit.
 *
 * 12 ticks at the default 5 s interval is one forced capture per minute, chosen against
 * the two costs it sits between: a capture is a warm `add -A` plus a DAG link (tens of
 * milliseconds, deduplicated by hash when nothing changed), and the exposure is how long
 * a missed edit can go without a boundary. A minute keeps the idle overhead at ~1/12th of
 * the unconditional behaviour this replaced while bounding the gap to something a user
 * would still recognise as "just now". The intermediate states between forced captures
 * genuinely have no boundary; the sweep is what stops the gap from being unbounded.
 */
export const MAX_SKIPPED_POLLS = 12;

/**
 * Upper bound on paths tracked per debounce window.
 *
 * A build or dependency install can touch tens of thousands of files; retaining
 * them all would defeat the point of watching cheaply. Past the cap the batch is
 * marked truncated and attributed in aggregate instead of per path.
 */
const MAX_PENDING_PATHS = 500;

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
				worktreeWatcher._onFileChange(
					rootPath,
					events.length,
					events.map((event) => event.path),
				);
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
	_onFileChange(worktreePath: string, eventCount = 1, changedPaths?: readonly string[]): void {
		const entry = this._entries.get(worktreePath);
		if (!entry) return;

		// Accumulate the paths seen during this debounce window so the flush can
		// attribute them. Bounded, because a runaway writer must not grow this set
		// without limit — beyond the cap the flush falls back to a git-status diff.
		if (changedPaths?.length) {
			if (!entry.pendingPaths) entry.pendingPaths = new Set();
			if (entry.pendingPaths.size < MAX_PENDING_PATHS) {
				for (const path of changedPaths) {
					entry.pendingPaths.add(path);
					if (entry.pendingPaths.size >= MAX_PENDING_PATHS) {
						entry.pendingPathsTruncated = true;
						break;
					}
				}
			} else {
				entry.pendingPathsTruncated = true;
			}
		}

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
			// Flagged as polled: this tick has no evidence anything was written, so
			// `_processChange` may skip the snapshot work when the status is unchanged.
			// Without that, polling — which is the *default* path, since the native watcher
			// requires an opt-in env var — ran a whole-tree capture plus a DAG advance every
			// interval per chapter, forever, on an idle workspace.
			this._enqueueProcessChange(worktreePath, entry, true);
		}, FALLBACK_POLL_INTERVAL_MS);
	},

	/**
	 * Internal: coalesce concurrent git-status refreshes per worktree.
	 *
	 * `polled` distinguishes a timer tick — which is speculative, since nothing said
	 * anything changed — from a watcher event, which is evidence of a write. Only the
	 * speculative kind is allowed to skip snapshot work on an unchanged status.
	 *
	 * A coalesced follow-up drops the flag: `pendingProcess` was set because a *second*
	 * trigger arrived while the first was running, and there is no way to tell whether
	 * that one was a poll or an event, so it is treated as an event. Erring toward doing
	 * the work is the right direction on a data-safety path.
	 */
	_enqueueProcessChange(worktreePath: string, entry: WatcherEntry, polled = false): void {
		if (!this._entries.has(worktreePath)) return;
		if (entry.processing) {
			entry.pendingProcess = true;
			return;
		}

		entry.processing = true;
		this._processChange(worktreePath, entry, polled)
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
	async _processChange(worktreePath: string, entry: WatcherEntry, polled = false): Promise<void> {
		const { chapterId, narratorIds } = entry;

		// Claim the paths accumulated during this window before any await, so a
		// concurrent event batch starts a fresh set rather than mutating this one.
		const changedPaths = entry.pendingPaths;
		const pathsTruncated = entry.pendingPathsTruncated === true;
		entry.pendingPaths = undefined;
		entry.pendingPathsTruncated = false;

		// Files changed on disk → the cached status is stale. Invalidate then
		// read through the shared cache so concurrent narrators reuse one query.
		invalidateStatus(worktreePath);
		const statusSummary = await getStatusSummaryCached(worktreePath, { ttlMs: 0 });
		const currentHead = statusSummary.headSha;
		const previousHead = entry.lastHeadSha;
		const statusSignature = getStatusSignature(statusSummary);
		const statusChanged = statusSignature !== entry.lastStatusSignature;

		// Snapshot work is skipped on a *polling* tick whose status is byte-identical to
		// the previous tick's, up to {@link MAX_SKIPPED_POLLS} ticks in a row. It stays
		// unconditional for a real watcher event, because that event is proof something
		// was written.
		//
		// The status query has to come first for this, which is why the call moved above
		// the snapshot step: the signature is the evidence the decision rests on. It
		// costs nothing extra — this tick was going to run it anyway.
		//
		// What the signature does and does not establish:
		//
		//   - It is derived from git's own view of the workspace rather than from mtimes:
		//     `getStatusSignature` folds in per file the path, the status code and the
		//     staged/unstaged line counts from `git diff --numstat`. A `touch` alone does
		//     not move it, and that is correct — identical bytes produce an identical
		//     tree, so a capture would have written no new object and linked no snapshot.
		//   - It is *not* content-derived, which this comment used to assert. Line counts
		//     are not content: editing one line of an already-dirty file in place
		//     (`foo` → `bar`) leaves `1 1`, ` M` and the path all unchanged, so the
		//     signature repeats even though the bytes differ. Those ticks are skipped, and
		//     the intermediate states therefore have no boundary of their own — which is
		//     what {@link MAX_SKIPPED_POLLS} bounds: the run converges on a capture, so
		//     the latest state becomes revertable rather than the edit going unrecorded
		//     indefinitely.
		//   - Ignored files are outside this entirely: `status` does not report them, and a
		//     snapshot excludes them, so a capture would not have seen the change either.
		//     The one apparent exception is a tracked-but-ignored file, which *is* in the
		//     tree; `status` reports those (verified: `git add -f .env` then editing it
		//     shows as ` M .env`), so they are covered.
		//   - Any real tool call captures its own boundaries through the tool hooks, so
		//     what is at stake here is only edits made outside the tool path.
		//
		// What it replaces: ~9 git subprocesses per chapter every 5 s forever, since
		// polling is the *default* path (the native watcher is opt-in via
		// `NARRAFORK_ENABLE_NATIVE_WATCHER`), including a whole-tree `add -A` and a
		// `chapters` UPDATE that has no index to use.
		const skipped = entry.skippedPolls ?? 0;
		const sweepDue = skipped >= MAX_SKIPPED_POLLS;
		if (!polled || statusChanged || entry.lastStatusSignature === undefined || sweepDue) {
			// Counted from the last tick that actually took a boundary, so the sweep fires
			// once per run of skips rather than on every tick after the threshold.
			entry.skippedPolls = 0;
			await this._recordExternalChanges(worktreePath, entry, changedPaths, pathsTruncated);
		} else {
			entry.skippedPolls = skipped + 1;
			if (changedPaths?.size) {
				// Paths arrived from the native watcher but the status is unchanged, so no
				// boundary is needed — the attribution still is, since the modification view is
				// what tells the user who touched a file.
				await this._recordExternalChanges(worktreePath, entry, changedPaths, pathsTruncated, {
					skipSnapshot: true,
				});
			}
		}

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

	/**
	 * Internal: attribute changes this watcher saw that no tool claimed, and record a
	 * workspace boundary for them.
	 *
	 * "External" means a terminal command, an editor, or a build script — anything
	 * outside the tool path. The tool path shadows its own writes via
	 * `markRecentlyAttributed`, so whatever remains here genuinely came from
	 * elsewhere and would otherwise be invisible in the modification view.
	 *
	 * A tree snapshot is taken only while a narrator is attached: capturing on every
	 * idle-period edit would pay `write-tree` for changes no session is going to ask
	 * about.
	 */
	async _recordExternalChanges(
		worktreePath: string,
		entry: WatcherEntry,
		changedPaths: Set<string> | undefined,
		truncated: boolean,
		options?: { skipSnapshot?: boolean },
	): Promise<void> {
		if (entry.narratorIds.size === 0) return;
		// Attribute to any attached narrator: the workspace timeline is shared by all
		// of them, and an external edit belongs to none in particular.
		const [narratorId] = entry.narratorIds;

		if (changedPaths?.size) {
			const unclaimed: string[] = [];
			for (const absolutePath of changedPaths) {
				const relPath = relative(worktreePath, absolutePath);
				if (!relPath || relPath.startsWith("..")) continue;
				if (wasRecentlyAttributed(worktreePath, relPath)) continue;
				unclaimed.push(relPath);
			}
			if (unclaimed.length > 0) {
				try {
					await recordAttributions(
						{
							deviceId: LOCAL_DEVICE_ID,
							workspacePath: worktreePath,
							narratorId: null,
							action: "external",
							toolName: null,
							toolUseId: null,
						},
						unclaimed,
					);
				} catch (err) {
					logger.debug("Failed to record external file attributions", {
						worktreePath,
						error: String(err),
					});
				}
			}
		}

		if (truncated) {
			logger.debug("External change batch truncated; attributed in aggregate", {
				worktreePath,
				cap: MAX_PENDING_PATHS,
			});
		}

		// A boundary here is what makes an external edit revertable at all — but only
		// when something actually changed. See `_processChange` for why an unchanged git
		// status is sufficient grounds to skip it.
		if (options?.skipSnapshot) return;
		const treeHash = await worktreeTreeSnapshot.tryCapture(worktreePath, LOCAL_DEVICE_ID);
		if (treeHash) {
			// Link it into the snapshot DAG with the tree just captured. Without this the
			// lineage would only advance on narrator tool calls, so a fork taken after
			// the user edited in their own editor — or after a build script wrote — would
			// start from a state that predates those writes and silently lose them.
			await advanceChapterSnapshot(worktreePath, treeHash, "external workspace change");
			eventBus.emit({
				type: "chapter:external_change_recorded",
				chapterId: entry.chapterId,
				worktreePath,
				treeHash,
				narratorId,
			});
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
