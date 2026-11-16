/**
 * History of any block, as the outline shows it (pageless outline, F2): pure helpers and the
 * restore's state machine, no React and no requests of their own (the requests are passed in).
 *
 *   - {@link historyProblemOf}: what a failed call of history means, in the terms the screens
 *     speak (someone changed it since the preview, the preview ran out, the history is not
 *     ready or starts later, the place is gone, the reader may not change it);
 *   - {@link previewGroupOf}: which group of the change list a restore's entry is shown in;
 *   - {@link diffMarksOf}: the blocks of the forest as of `then` that a comparison names
 *     (they were there then: removed, moved away, changed);
 *   - {@link RestoreRun}: preview (paged) → confirm → one call after another until `done`, with
 *     stop, re-preview after a conflict or an expired token, and per-block "move back".
 *
 * The restore is the server's (H3, `shared/outline-restore-api.ts`): owner rule D58 says what it
 * touches (only what was under the subtree then); this file only shows it and drives it.
 */
import type {
	OutlineDiffEntry,
	OutlineDiffKind,
	OutlineMoveBackResponse,
	OutlineRestoreEntry,
	OutlineRestorePreviewResponse,
	OutlineRestoreResponse,
	OutlineRestoreSkip,
	OutlineRestoreSkipReason,
} from "@shared/outline-restore-api";
import { OUTLINE_RESTORE_ERROR_CODES } from "@shared/outline-restore-api";
import { OUTLINE_HISTORY_ERROR_CODES } from "@shared/outline-subtree-api";
import { ApiError } from "../../../lib/api";

// ─────────────────────────────────────────────────────────────────────────────
// What a failure means
// ─────────────────────────────────────────────────────────────────────────────

export type HistoryProblem =
	/**
	 * The subtree changed after the preview: nothing more was written. `own`: the change was the
	 * reader's own move-back from this dialog (not someone else's).
	 */
	| { kind: "conflict"; conflictSeq: number | null; own?: boolean }
	/** The preview is older than its token allows. */
	| { kind: "expired" }
	/** The preview is someone else's. */
	| { kind: "person" }
	/** The preview (or its cursor) is not valid any more. */
	| { kind: "token" }
	/** The space's history is still being prepared. */
	| { kind: "not-ready" }
	/** The point asked for is before the history kept. */
	| { kind: "before-floor"; floorSeq: number | null }
	/** The block was not in the outline at that point (or is not now). */
	| { kind: "root" }
	/** A move-back has nowhere to go: the block it was under is deleted. */
	| { kind: "parent-gone" }
	/** The reader may read the space but not change it. */
	| { kind: "forbidden" }
	/** The space or block cannot be read (does not exist, or no access). */
	| { kind: "missing" }
	| { kind: "other"; error: unknown };

function numberOf(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** What a failed call of history (timeline, diff, preview, restore, move-back) means. */
export function historyProblemOf(error: unknown): HistoryProblem {
	if (!(error instanceof ApiError)) return { kind: "other", error };
	const code = typeof error.data?.code === "string" ? error.data.code : null;
	const details = (error.data?.details ?? {}) as Record<string, unknown>;
	switch (code) {
		case OUTLINE_RESTORE_ERROR_CODES.conflict:
			return { kind: "conflict", conflictSeq: numberOf(details.conflictSeq) };
		case OUTLINE_RESTORE_ERROR_CODES.token:
			return details.reason === "expired"
				? { kind: "expired" }
				: details.reason === "person"
					? { kind: "person" }
					: { kind: "token" };
		case OUTLINE_RESTORE_ERROR_CODES.root:
			return { kind: "root" };
		case OUTLINE_RESTORE_ERROR_CODES.parentGone:
			return { kind: "parent-gone" };
		case OUTLINE_HISTORY_ERROR_CODES["not-ready"]:
			return { kind: "not-ready" };
		case OUTLINE_HISTORY_ERROR_CODES["before-floor"]:
			return { kind: "before-floor", floorSeq: numberOf(details.floorSeq) };
	}
	if (error.status === 403) return { kind: "forbidden" };
	if (error.status === 404) return { kind: "missing" };
	return { kind: "other", error };
}

/** A new preview is the way on (the list as it is now): after a conflict or a stale token. */
export function needsNewPreview(problem: HistoryProblem): boolean {
	return (
		problem.kind === "conflict" ||
		problem.kind === "expired" ||
		problem.kind === "person" ||
		problem.kind === "token"
	);
}

/** Trying the same again may work (the history was being prepared, a transient failure). */
export function canRetry(problem: HistoryProblem): boolean {
	return problem.kind === "not-ready" || problem.kind === "other";
}

// ─────────────────────────────────────────────────────────────────────────────
// The change list of a restore
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The groups of a restore's change list, in the order they are shown: what goes, what comes
 * back, what moves back out, what is put back, what is left as it is, and what moved away
 * (listed only, each with its own "move back").
 */
export const PREVIEW_GROUPS = [
	"delete",
	"restore",
	"move-out",
	"put-back",
	"kept",
	"moved-away",
] as const;
export type PreviewGroup = (typeof PREVIEW_GROUPS)[number];

/** The group an entry of the change list is shown in. */
export function previewGroupOf(entry: OutlineRestoreEntry): PreviewGroup {
	if (entry.action === "none") return "moved-away";
	// A put-back that cannot move it still puts its text and fields back: it stays a put-back.
	if (entry.skip && entry.action !== "put-back") return "kept";
	if (entry.action === "delete" || entry.action === "delete-unless-holds") return "delete";
	return entry.action;
}

/**
 * The entries of a preview's pages in one list, depth first as the server gave them; a block a
 * later page says is left alone (`skipped`) carries that reason on its entry.
 */
export function mergePreviewPages(
	pages: ReadonlyArray<Pick<OutlineRestorePreviewResponse, "entries" | "skipped">>,
): { entries: OutlineRestoreEntry[]; skippedElsewhere: OutlineRestoreSkip[] } {
	const entries: OutlineRestoreEntry[] = [];
	const at = new Map<string, number>();
	for (const page of pages) {
		for (const entry of page.entries) {
			const known = at.get(entry.blockId);
			if (known !== undefined) entries[known] = entry;
			else {
				at.set(entry.blockId, entries.length);
				entries.push(entry);
			}
		}
	}
	const skippedElsewhere: OutlineRestoreSkip[] = [];
	for (const page of pages) {
		for (const skip of page.skipped) {
			const known = at.get(skip.blockId);
			if (known === undefined) {
				if (!skippedElsewhere.some((s) => s.blockId === skip.blockId)) skippedElsewhere.push(skip);
				continue;
			}
			const entry = entries[known] as OutlineRestoreEntry;
			if (!entry.skip) entries[known] = { ...entry, skip: skip.reason };
		}
	}
	return { entries, skippedElsewhere };
}

/** The entries by group (groups with none are left out), in {@link PREVIEW_GROUPS} order. */
export function groupPreview(
	entries: readonly OutlineRestoreEntry[],
): Array<{ group: PreviewGroup; entries: OutlineRestoreEntry[] }> {
	const by = new Map<PreviewGroup, OutlineRestoreEntry[]>();
	for (const entry of entries) {
		const group = previewGroupOf(entry);
		const list = by.get(group) ?? [];
		list.push(entry);
		by.set(group, list);
	}
	return PREVIEW_GROUPS.filter((group) => by.has(group)).map((group) => ({
		group,
		entries: by.get(group) as OutlineRestoreEntry[],
	}));
}

/** Skips with the same block once (the last reason a call gave wins). */
export function mergeSkips(
	into: readonly OutlineRestoreSkip[],
	more: readonly OutlineRestoreSkip[],
): OutlineRestoreSkip[] {
	const out = new Map(into.map((skip) => [skip.blockId, skip]));
	for (const skip of more) out.set(skip.blockId, skip);
	return [...out.values()];
}

/** The skip reasons, in the order a result lists them. */
export const SKIP_REASONS: readonly OutlineRestoreSkipReason[] = [
	"lock-kept",
	"holds-kept",
	"parent-moved-away",
	"parent-gone",
	"place-taken",
	"refused",
	"parent-refused",
];

// ─────────────────────────────────────────────────────────────────────────────
// A comparison
// ─────────────────────────────────────────────────────────────────────────────

/** Kinds of a comparison whose block was under the root at `then` (so the as-of forest has it). */
const THEN_KINDS: ReadonlySet<OutlineDiffKind> = new Set(["removed", "moved-away", "changed"]);

/** The blocks of the forest as of `then` a comparison names, with what happened to them. */
export function diffMarksOf(
	pages: ReadonlyArray<{ entries: readonly OutlineDiffEntry[] }>,
): Map<string, OutlineDiffKind> {
	const out = new Map<string, OutlineDiffKind>();
	for (const page of pages) {
		for (const entry of page.entries) {
			if (THEN_KINDS.has(entry.kind)) out.set(entry.blockId, entry.kind);
		}
	}
	return out;
}

/** The entries of a comparison's pages, each block once (a later page wins). */
export function diffEntriesOf(
	pages: ReadonlyArray<{ entries: readonly OutlineDiffEntry[] }>,
): OutlineDiffEntry[] {
	const at = new Map<string, number>();
	const out: OutlineDiffEntry[] = [];
	for (const page of pages) {
		for (const entry of page.entries) {
			const known = at.get(entry.blockId);
			if (known !== undefined) out[known] = entry;
			else {
				at.set(entry.blockId, out.length);
				out.push(entry);
			}
		}
	}
	return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// The restore, driven
// ─────────────────────────────────────────────────────────────────────────────

export interface RestoreIO {
	preview(body: {
		rootId: string | null;
		thenSeq: number;
		token?: string;
		cursor?: string;
	}): Promise<OutlineRestorePreviewResponse>;
	restore(body: { token: string; cursor?: string }): Promise<OutlineRestoreResponse>;
	moveBack(blockId: string, thenSeq: number): Promise<OutlineMoveBackResponse>;
}

export type RestorePhase =
	/** The first page of the preview is being read. */
	| "loading"
	/** The change list is shown; nothing is written yet. */
	| "preview"
	/** Confirmed: one call after another until the server says `done`. */
	| "running"
	/** The reader stopped it between two calls; confirming again continues. */
	| "stopped"
	| "done"
	/** A call failed: `problem` says why (a conflict or a stale preview: preview again). */
	| "failed";

export interface RestoreProgress {
	calls: number;
	commits: Array<{ id: string; seq: number }>;
	/** Blocks the restore's commits changed. */
	changed: number;
	/** Blocks it left alone, with why. */
	skipped: OutlineRestoreSkip[];
	skippedTruncated: boolean;
	/** Blocks under the root then that have moved away (the largest a call saw). */
	movedAway: number;
	/** Held for confirmation instead of written. */
	pending: { id: string; label: string } | null;
}

export type MoveBackState =
	| { state: "moving" }
	| { state: "moved"; restored: boolean; orderKeyMoved: boolean }
	| { state: "failed"; problem: HistoryProblem };

export interface RestoreState {
	phase: RestorePhase;
	/** The preview's entries so far, depth first. */
	entries: OutlineRestoreEntry[];
	/** Blocks a later page found left alone whose entry was not listed. */
	skippedElsewhere: OutlineRestoreSkip[];
	/** More of the change list is there to read. */
	more: boolean;
	loadingMore: boolean;
	/** The seq the preview is of (the space's last commit when it was read). */
	nowSeq: number | null;
	progress: RestoreProgress;
	/** Why the last call failed (phase `failed`, or a page of the preview that did not come). */
	problem: HistoryProblem | null;
	/** "Move back" of the moved-away blocks, by block. */
	moveBack: Readonly<Record<string, MoveBackState>>;
	/** The change list was read again after a move-back (the subtree changed). */
	refreshed: number;
	/** "Show the whole list" is reading page after page. */
	loadingAll: boolean;
	/**
	 * What confirmations of an earlier preview in this dialog already wrote (a restore stopped
	 * by a conflict, then previewed again): it stays written, and is said.
	 */
	earlier: { changed: number; commits: number };
}

const EMPTY_PROGRESS: RestoreProgress = {
	calls: 0,
	commits: [],
	changed: 0,
	skipped: [],
	skippedTruncated: false,
	movedAway: 0,
	pending: null,
};

/** Calls one confirmation makes at most before it gives up (the server progresses each call). */
export const RESTORE_MAX_CALLS = 5_000;

/**
 * A restore of one subtree to one seq, from its preview to its result. `subscribe` and
 * `getState` make it a store for `useSyncExternalStore`; every change replaces the state object.
 */
export class RestoreRun {
	private state: RestoreState;
	private readonly listeners = new Set<() => void>();
	private token: string | null = null;
	private previewCursor: string | null = null;
	private pages: OutlineRestorePreviewResponse[] = [];
	private restoreCursor: string | null = null;
	/** Bumped by every new preview: answers of an older one are dropped. */
	private generation = 0;
	private stopAsked = false;
	/** "Show the whole list" was asked to stop. */
	private stopListAsked = false;
	/** Seqs of the commits this dialog's own move-backs wrote. */
	private readonly ownSeqs = new Set<number>();
	/** The current preview was confirmed (a failed call then is retried by confirming again). */
	private confirmed = false;
	private disposed = false;

	constructor(
		private readonly io: RestoreIO,
		readonly rootId: string | null,
		readonly thenSeq: number,
		/** Between two calls of a confirmation (the app yields to the browser). */
		private readonly pause: () => Promise<void> = () =>
			new Promise((resolve) => setTimeout(resolve, 0)),
	) {
		this.state = {
			phase: "loading",
			entries: [],
			skippedElsewhere: [],
			more: false,
			loadingMore: false,
			nowSeq: null,
			progress: EMPTY_PROGRESS,
			problem: null,
			moveBack: {},
			refreshed: 0,
			loadingAll: false,
			earlier: { changed: 0, commits: 0 },
		};
	}

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getState = (): RestoreState => this.state;

	private set(patch: Partial<RestoreState>): void {
		if (this.disposed) return;
		this.state = { ...this.state, ...patch };
		for (const listener of this.listeners) listener();
	}

	dispose(): void {
		this.disposed = true;
		this.stopAsked = true;
		this.listeners.clear();
	}

	/** Read the change list from its first page (again): a new token, nothing written. */
	async preview(): Promise<void> {
		const generation = ++this.generation;
		this.token = null;
		this.previewCursor = null;
		this.restoreCursor = null;
		this.pages = [];
		this.stopAsked = false;
		this.stopListAsked = true;
		this.confirmed = false;
		// What an earlier confirmation wrote stays written: it is carried, not forgotten.
		const { progress, earlier } = this.state;
		this.set({
			earlier: {
				changed: earlier.changed + progress.changed,
				commits: earlier.commits + progress.commits.length,
			},
			loadingAll: false,
			phase: "loading",
			entries: [],
			skippedElsewhere: [],
			more: false,
			loadingMore: false,
			nowSeq: null,
			progress: EMPTY_PROGRESS,
			problem: null,
		});
		try {
			const page = await this.io.preview({ rootId: this.rootId, thenSeq: this.thenSeq });
			if (generation !== this.generation) return;
			this.token = page.token;
			this.take(page);
			this.set({ phase: "preview", nowSeq: page.nowSeq });
		} catch (error) {
			if (generation !== this.generation) return;
			this.set({ phase: "failed", problem: historyProblemOf(error) });
		}
	}

	private take(page: OutlineRestorePreviewResponse): void {
		this.pages.push(page);
		this.previewCursor = page.nextCursor;
		const merged = mergePreviewPages(this.pages);
		this.set({
			entries: merged.entries,
			skippedElsewhere: merged.skippedElsewhere,
			more: page.nextCursor !== null,
		});
	}

	/** The next page of the change list. */
	async more(): Promise<void> {
		const { phase, loadingMore } = this.state;
		if (loadingMore || !this.token || !this.previewCursor) return;
		if (phase !== "preview" && phase !== "stopped" && phase !== "done") return;
		const generation = this.generation;
		this.set({ loadingMore: true, problem: null });
		try {
			const page = await this.io.preview({
				rootId: this.rootId,
				thenSeq: this.thenSeq,
				token: this.token,
				cursor: this.previewCursor,
			});
			if (generation !== this.generation) return;
			this.take(page);
			this.set({ loadingMore: false });
		} catch (error) {
			if (generation !== this.generation) return;
			const problem = historyProblemOf(error);
			// A stale preview cannot be continued: it is read again from the start.
			this.set(
				needsNewPreview(problem)
					? { loadingMore: false, phase: "failed", problem }
					: { loadingMore: false, problem },
			);
		}
	}

	/**
	 * "Show the whole list": read page after page until the change list is complete, the reader
	 * stops it ({@link stopList}), or a page fails. Each page is one bounded read of the server.
	 */
	async moreAll(): Promise<void> {
		if (this.state.loadingAll || !this.state.more) return;
		const generation = this.generation;
		this.stopListAsked = false;
		this.set({ loadingAll: true });
		while (
			this.state.more &&
			!this.stopListAsked &&
			!this.disposed &&
			generation === this.generation &&
			this.state.phase === "preview" &&
			this.state.problem === null
		) {
			await this.more();
		}
		if (generation === this.generation) this.set({ loadingAll: false });
	}

	/** Stop "Show the whole list" after the page in flight. */
	stopList(): void {
		this.stopListAsked = true;
	}

	/** A move-back of this dialog is in flight. */
	private moving(): boolean {
		return Object.values(this.state.moveBack).some((m) => m.state === "moving");
	}

	/**
	 * Whether the restore can be confirmed now. Owner rule D58: the change list is shown BEFORE
	 * confirming, so the whole list must be loaded (no page left), with something to change in
	 * it; and not while a move-back is in flight (it changes the subtree under the preview).
	 */
	canConfirm(): boolean {
		const { phase, more, loadingMore, entries } = this.state;
		if (!this.token || this.moving()) return false;
		if (phase === "stopped") return true;
		return (
			phase === "preview" &&
			!more &&
			!loadingMore &&
			entries.some((entry) => entry.action !== "none")
		);
	}

	/**
	 * Confirm: call the restore again and again (with its cursor) until it is done, the reader
	 * stops it, or a call fails. Continues where it stopped when called again. Refused unless
	 * {@link canConfirm}.
	 */
	async confirm(): Promise<void> {
		if (!this.token || !this.canConfirm()) return;
		const generation = this.generation;
		const token = this.token;
		this.stopAsked = false;
		this.confirmed = true;
		this.set({ phase: "running", problem: null });
		let progress = this.state.progress;
		while (true) {
			if (progress.calls >= RESTORE_MAX_CALLS) {
				this.set({
					phase: "failed",
					problem: { kind: "other", error: new Error("The restore did not finish") },
				});
				return;
			}
			let answer: OutlineRestoreResponse;
			try {
				answer = await this.io.restore({
					token,
					...(this.restoreCursor ? { cursor: this.restoreCursor } : {}),
				});
			} catch (error) {
				if (generation !== this.generation) return;
				const problem = historyProblemOf(error);
				if (
					problem.kind === "conflict" &&
					problem.conflictSeq !== null &&
					this.ownSeqs.has(problem.conflictSeq)
				)
					problem.own = true;
				this.set({ phase: "failed", problem });
				return;
			}
			if (generation !== this.generation) return;
			this.restoreCursor = answer.cursor;
			progress = {
				calls: progress.calls + 1,
				commits: [...progress.commits, ...answer.commits],
				changed: progress.changed + answer.changed,
				skipped: mergeSkips(progress.skipped, answer.skipped),
				skippedTruncated: progress.skippedTruncated || answer.skippedTruncated,
				movedAway: Math.max(progress.movedAway, answer.movedAway),
				pending: answer.pending ?? progress.pending,
			};
			if (answer.done) {
				this.set({ phase: "done", progress });
				return;
			}
			if (this.stopAsked) {
				this.set({ phase: "stopped", progress });
				return;
			}
			this.set({ progress });
			await this.pause();
			if (generation !== this.generation || this.disposed) return;
			if (this.stopAsked) {
				this.set({ phase: "stopped" });
				return;
			}
		}
	}

	/**
	 * After a failure: a stale preview (a conflict, an expired or foreign token) is read again
	 * from the start; anything else is tried again where it failed (a confirmed restore
	 * continues from its cursor, skipping what is done; a preview is read again).
	 */
	async retry(): Promise<void> {
		const { phase, problem } = this.state;
		if (phase !== "failed") return;
		if (!this.token || !this.confirmed || (problem && needsNewPreview(problem))) {
			await this.preview();
			return;
		}
		this.set({ phase: "stopped" });
		await this.confirm();
	}

	/** Stop a running confirmation after the call in flight (what it wrote stays). */
	stop(): void {
		if (this.state.phase === "running") this.stopAsked = true;
	}

	/**
	 * Put one moved-away block back where it was at `then`. While the preview is not confirmed
	 * the change list is read again afterwards (the subtree changed, and the old preview would be
	 * refused as a conflict); once confirmed (stopped, failed or done) the list stays, and what
	 * the restore wrote stays said.
	 */
	async moveBack(blockId: string): Promise<void> {
		const now = this.state.moveBack[blockId];
		if (now && now.state !== "failed") return;
		if (this.state.phase === "running" || this.state.phase === "loading") return;
		this.set({ moveBack: { ...this.state.moveBack, [blockId]: { state: "moving" } } });
		try {
			const answer = await this.io.moveBack(blockId, this.thenSeq);
			if (answer.commit) this.ownSeqs.add(answer.commit.seq);
			this.set({
				moveBack: {
					...this.state.moveBack,
					[blockId]: {
						state: "moved",
						restored: answer.restored,
						orderKeyMoved: answer.orderKeyMoved,
					},
				},
			});
			if (
				answer.commit &&
				!this.confirmed &&
				(this.state.phase === "preview" || this.state.phase === "failed")
			) {
				const refreshed = this.state.refreshed + 1;
				await this.preview();
				this.set({ refreshed });
			}
		} catch (error) {
			this.set({
				moveBack: {
					...this.state.moveBack,
					[blockId]: { state: "failed", problem: historyProblemOf(error) },
				},
			});
		}
	}

	/** The moved-away blocks listed by the preview (each with its own "move back"). */
	movedAway(): OutlineRestoreEntry[] {
		return this.state.entries.filter((entry) => entry.action === "none");
	}
}
