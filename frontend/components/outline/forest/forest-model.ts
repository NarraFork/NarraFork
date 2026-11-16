/**
 * The forest's data of ONE space (pageless outline, F1): the levels a reader has loaded, by
 * parent, what is open, and the flat list of rows a view draws. No React and no requests of its
 * own: reads go through {@link ForestIO}, so the model runs under a test with a fake one.
 *
 * A LEVEL is the children of one parent, named by its parent key: a block's id, or the space's
 * id for the top level (the same keys the block watch uses). Levels are read lazily:
 *
 *   - the root is one folded read (`subtree?fold=default`): what is open by default and by the
 *     reader's own folding, breadth first within the server's budget;
 *   - an open row whose level is not there is read by `children`, up to
 *     {@link FOREST_LIMITS.parents} parents per request and {@link FOREST_LIMITS.chunk} children
 *     each. Without the reader asking, that stops at {@link FOREST_LIMITS.autoRows} blocks: past
 *     it an open row says "show" and waits for a click;
 *   - a level longer than a chunk ends in a "more" row that reads the next chunk in place;
 *   - a level holds at most {@link FOREST_LIMITS.pagedAbove} children at once: past that it is
 *     PAGED in place (D58): "next" replaces the window with the following
 *     {@link FOREST_LIMITS.page} children, "previous" goes back. Every cursor is the server's.
 *
 * WHAT IS OPEN is the default folding with the reader's own over it (`shared/outline-fold.ts`,
 * the same rule the server's folded read applies row by row):
 *
 *   forced (a located block's ancestors) > the reader opened it > the reader closed it >
 *   a top-level block under a space row is closed > something nobody must miss is under it
 *   (current reads) > the default of a task, a report, a detail, a fact.
 *
 * "Something under it" comes from the marks once they are read for the row, and until then
 * from what the folded read did (it went below a row its default would close).
 *
 * LIVE: a view tells the model which rows are near the viewport ({@link SpaceForest.setViewport});
 * the levels of those rows are what the block watch watches, and the closed rows among the
 * visible ones are watched as subtrees (their marks). A level the watch names, or one that
 * starts being watched after it was read, is STALE: it is read again when it is near the
 * viewport, and only it. Nothing reloads the tree.
 *
 * MARKS (what a row hides: questions, tasks, locks, changes waiting, whether anything changed
 * since the reader's last visit) are asked once for the rows on screen, debounced, never per
 * row (a marks read costs the same for one key as for a hundred).
 */
import type { OutlineViewMode } from "@shared/outline-api";
import { FOLD_MAX_OPEN_DEPTH, foldDefaultOpen } from "@shared/outline-fold";
import { isOutlineReportBlockId, isOutlineReportContainer } from "@shared/outline-report-line";
import type {
	OutlineFoldStateResponse,
	OutlineLevelsResponse,
	OutlineMarksResponse,
	OutlineSubtreeMarks,
	OutlineSubtreeResponse,
	OutlineTreeBlock,
	OutlineTreeLevel,
} from "@shared/outline-subtree-api";

export const FOREST_LIMITS = {
	/** Children one read of a level asks for. */
	chunk: 200,
	/** Children a level holds at once; a level with more is paged in place (D58). */
	pagedAbove: 2000,
	/** Children a paged level moves by. */
	page: 500,
	/** Blocks loaded without the reader asking (the default-open descent), per space. */
	autoRows: 2000,
	/** Blocks held per space; past it what is not reachable through open rows is dropped. */
	maxRows: 50_000,
	/** Parents one read of levels names (the server's limit). */
	parents: 50,
	/** Blocks one read of levels returns at most (the server's limit). */
	readBlocks: 800,
	/** Rows around the visible ones whose levels are watched and kept fresh. */
	nearRows: 300,
	/** Levels and subtrees one watch names (the protocol allows 2,000 keys together). */
	watchLevels: 1500,
	watchSubtrees: 400,
	/** Keys one marks read names (the server's limit). */
	markKeys: 100,
	/** Rows "everything inside" may open. */
	openInside: 800,
	/** Children of a closed row read to say how many it has (the server's own peek). */
	previewPeek: 12,
	/** Blocks read one by one to pin a located block's ancestors. */
	pinReads: 8,
} as const;

export interface ForestIO {
	subtree(
		spaceId: string,
		rootId: string | null,
		params: {
			asOf?: number;
			view?: OutlineViewMode;
			blocks?: number;
			fold?: "default";
			top?: "closed";
		},
	): Promise<OutlineSubtreeResponse>;
	children(
		spaceId: string,
		params: {
			parents: ReadonlyArray<string | null>;
			cursor?: string | null;
			limit?: number;
			perParent?: number;
			asOf?: number;
			view?: OutlineViewMode;
		},
	): Promise<OutlineLevelsResponse>;
	marks(spaceId: string, keys: readonly string[], since?: number): Promise<OutlineMarksResponse>;
	getFold(spaceId: string): Promise<OutlineFoldStateResponse>;
	putFold(
		spaceId: string,
		changes: Array<{ blockId: string; open: boolean | null }>,
		keepalive?: boolean,
	): Promise<unknown>;
}

/** What a read of one parent's children left in memory. */
export interface ForestLevel {
	ids: string[];
	/** The cursor the window starts after; null: the level's beginning. */
	start: string | null;
	more: boolean;
	next: string | null;
	/** Earlier pages of a paged level, oldest first: where each started and how many it held. */
	pages: Array<{ start: string | null; count: number }>;
	processHidden: number;
	/** The seq the window was read at. */
	seq: number;
	/** Only the child a closed row's preview line is read from: read whole when the row opens. */
	preview: boolean;
	/**
	 * A preview level: the direct children counted (up to what one read looks at), and whether
	 * there are more than that. Null: not counted.
	 */
	kids: { count: number; more: boolean; previewId?: string } | null;
	stale: boolean;
	busy: boolean;
	failed: boolean;
}

export type ForestPreviewKind = "result" | "report" | "details";

export interface ForestBlockRow {
	kind: "block";
	key: string;
	id: string;
	/** 0 for the rows directly under the forest's root. */
	depth: number;
	block: OutlineTreeBlock;
	parentKey: string;
	hasChildren: boolean;
	open: boolean;
	/** Shown above its level's window because a located block is under it. */
	pinned: boolean;
	/** The closed row's one line: the block it is read from, and whether more is behind it. */
	previewId: string | null;
	previewKind: ForestPreviewKind | null;
	previewMore: boolean;
	/** Direct children besides the one the line shows; null: not counted. `previewRestMore`: at least. */
	previewRest: number | null;
	previewRestMore: boolean;
	/** The row's control for everything inside it. */
	subtree: "expand" | "collapse" | null;
}

export interface ForestMoreRow {
	kind: "more";
	key: string;
	parentKey: string;
	depth: number;
	/**
	 * `more`: the next chunk, in place. `next` / `prev`: the following or the previous window of
	 * a paged level. `load`: an open row whose level was not read (the budget): read it.
	 * `loading`: its first read is on its way.
	 */
	mode: "more" | "next" | "prev" | "load" | "loading";
	busy: boolean;
	failed: boolean;
	/** Children before the window (a paged level), for "showing from N". */
	before: number;
	/** Children in the window. */
	shown: number;
}

export interface ForestNoteRow {
	kind: "note";
	key: string;
	depth: number;
	/** `empty`: nothing under the root. `hidden`: only tasks and questions the facts view leaves out. */
	note: "empty" | "hidden";
	count: number;
}

export interface ForestFormRow {
	kind: "form";
	key: string;
	depth: number;
	/** The block whose questions the form answers. */
	under: string;
}

export type ForestRow = ForestBlockRow | ForestMoreRow | ForestNoteRow | ForestFormRow;

export interface ForestView {
	rows: ForestRow[];
	/** Row index by block id (a block is drawn once). */
	indexOf: ReadonlyMap<string, number>;
	/** The control of the whole forest: open everything, or back to the default view. */
	all: "expand" | "collapse" | null;
	/** Tasks and questions the facts view left out of the open levels. */
	processHidden: number;
}

export type ForestStatus = "loading" | "ready" | "missing" | "unavailable" | "error";

interface RowInfo {
	depth: number;
	/** Under a task, a question or a report. */
	detail: boolean;
	/** A top-level block drawn under a space's row. */
	top: boolean;
	open: boolean;
	parentKey: string;
}

export interface SpaceForestOptions {
	spaceId: string;
	/** The block the forest is focused on; null: the whole space (its top level). */
	rootId: string | null;
	view: OutlineViewMode;
	/** Commit seq to read as of (read only, nothing live); undefined: now. */
	asOf?: number;
	io: ForestIO;
	/** The seq of the reader's last visit of the space: marks say what changed since. */
	since?: number;
	/** Timers, for tests. */
	delay?: (fn: () => void, ms: number) => () => void;
}

const FOLD_FLUSH_MS = 500;
const MARKS_DELAY_MS = 250;
const MARKS_REFRESH_MS = 400;

function makesDetail(block: OutlineTreeBlock): boolean {
	return block.task !== null || block.question !== null || isOutlineReportBlockId(block.id);
}

function isUnread(level: OutlineTreeLevel): boolean {
	return level.more && level.nextCursor === null && level.childIds.length === 0;
}

function httpStatus(error: unknown): number | null {
	const status = (error as { status?: unknown } | null)?.status;
	return typeof status === "number" ? status : null;
}

const defaultDelay = (fn: () => void, ms: number) => {
	const timer = setTimeout(fn, ms);
	return () => clearTimeout(timer);
};

export class SpaceForest {
	readonly spaceId: string;
	readonly rootId: string | null;
	readonly view: OutlineViewMode;
	readonly asOf: number | undefined;
	/** The root's parent key: the root block, or the space. */
	readonly rootKey: string;

	status: ForestStatus = "loading";
	/** The root's ancestors, top-level block first (a block root). */
	path: OutlineSubtreeResponse["path"] = [];
	pathTruncated = false;
	/** The newest seq the forest has read or been told of. */
	knownSeq = -1;
	/** The question form shown in the tree: after which row, for which block. */
	form: { afterId: string; under: string } | null = null;
	/** Marks may be lower bounds (the space has more candidates than one read looks at). */
	marksAtLeast = false;

	private readonly io: ForestIO;
	private readonly since: number | undefined;
	private readonly delay: (fn: () => void, ms: number) => () => void;
	private readonly blocks = new Map<string, OutlineTreeBlock>();
	private readonly levels = new Map<string, ForestLevel>();
	private readonly expanded = new Set<string>();
	private readonly collapsed = new Set<string>();
	/** Opened for this visit only (a located block's ancestors); never stored. */
	private readonly forced = new Set<string>();
	/** Rows the folded read went below although their default closes them. */
	private readonly hints = new Set<string>();
	private readonly marks = new Map<string, OutlineSubtreeMarks>();
	/** Levels the reader asked for: read whatever the budget says. */
	private readonly asked = new Set<string>();
	private readonly pins = new Map<string, string[]>();
	/** "Everything inside" a row: rows it may still open. */
	private readonly wishes = new Map<string, number>();
	private rootInTask = false;
	private seekQuestion: string | null = null;
	private reveal: {
		chain: string[];
		target: string;
		answer: boolean;
		reads: number;
		done: (found: boolean) => void;
	} | null = null;

	private readonly foldQueue = new Map<string, boolean | null>();
	private cancelFoldFlush: (() => void) | null = null;
	private foldWrite: Promise<unknown> = Promise.resolve();

	private near = new Set<string>();
	private visible: string[] = [];
	private marksWanted = "";
	private marksDirty = false;
	private cancelMarks: (() => void) | null = null;
	private marksBusy = false;

	private cached: ForestView | null = null;
	private previewOf = new Map<string, string>();
	private info = new Map<string, RowInfo>();
	private version = 0;
	private readonly listeners = new Set<() => void>();
	private pumping = false;
	private pumpAgain = false;
	private disposed = false;
	private reads = 0;

	constructor(options: SpaceForestOptions) {
		this.spaceId = options.spaceId;
		this.rootId = options.rootId;
		this.view = options.view;
		this.asOf = options.asOf;
		this.io = options.io;
		this.since = options.since;
		this.delay = options.delay ?? defaultDelay;
		this.rootKey = options.rootId ?? options.spaceId;
	}

	// ── subscription ──────────────────────────────────────────────────────────

	subscribe = (listener: () => void): (() => void) => {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	};

	getVersion = (): number => this.version;

	private changed(): void {
		this.cached = null;
		this.version++;
		for (const listener of this.listeners) listener();
		this.pump();
	}

	dispose(): void {
		this.disposed = true;
		this.cancelMarks?.();
		this.cancelFoldFlush?.();
		this.flushFold(true);
		this.reveal?.done(false);
		this.reveal = null;
		this.listeners.clear();
	}

	// ── reading ───────────────────────────────────────────────────────────────

	blockOf(id: string): OutlineTreeBlock | undefined {
		return this.blocks.get(id);
	}

	levelOf(parentKey: string): ForestLevel | undefined {
		return this.levels.get(parentKey);
	}

	marksOf(id: string): OutlineSubtreeMarks | undefined {
		return this.marks.get(id);
	}

	/** Blocks held (the memory the forest takes). */
	get size(): number {
		return this.blocks.size;
	}

	/** Whether the reader has a stored folding for the block (for tests and the page control). */
	foldOf(id: string): "expanded" | "collapsed" | null {
		return this.expanded.has(id) ? "expanded" : this.collapsed.has(id) ? "collapsed" : null;
	}

	/** The first read: the reader's folding and the root's folded subtree. */
	async load(): Promise<void> {
		this.status = "loading";
		try {
			const [fold, root] = await Promise.all([
				this.io.getFold(this.spaceId),
				this.io.subtree(this.spaceId, this.rootId, this.rootParams()),
			]);
			if (this.disposed) return;
			this.expanded.clear();
			this.collapsed.clear();
			for (const id of fold.expanded) this.expanded.add(id);
			for (const id of fold.collapsed) this.collapsed.add(id);
			// What the reader did while the read was on its way stays on top.
			for (const [id, open] of this.foldQueue) this.applyFold(id, open);
			this.applyRoot(root);
			this.status = "ready";
		} catch (error) {
			if (this.disposed) return;
			const status = httpStatus(error);
			this.status = status === 404 ? "missing" : status === 409 ? "unavailable" : "error";
		}
		this.changed();
	}

	private rootParams() {
		return {
			...(this.asOf !== undefined ? { asOf: this.asOf } : {}),
			view: this.view,
			fold: "default" as const,
			...(this.rootId === null ? { top: "closed" as const } : {}),
		};
	}

	private readParams() {
		return { ...(this.asOf !== undefined ? { asOf: this.asOf } : {}), view: this.view };
	}

	private noteSeq(seq: number): void {
		if (seq > this.knownSeq) this.knownSeq = seq;
	}

	private applyRoot(read: OutlineSubtreeResponse): void {
		this.path = read.path;
		this.pathTruncated = read.pathTruncated;
		this.rootInTask = read.rootInTask;
		for (const block of read.blocks) this.blocks.set(block.id, block);
		const closed = new Set(read.closed ?? []);
		const went = new Set<string>();
		for (const level of read.levels) {
			if (isUnread(level)) continue;
			const key = level.parentId ?? this.spaceId;
			const peeked = read.closedKids?.[key];
			went.add(key);
			this.levels.set(key, {
				ids: [...level.childIds],
				start: null,
				more: level.more,
				next: level.nextCursor,
				pages: [],
				processHidden: level.processHidden,
				seq: read.seq,
				preview: closed.has(key),
				kids: peeked
					? { count: peeked.kids, more: peeked.more, previewId: peeked.previewId }
					: null,
				stale: false,
				busy: false,
				failed: false,
			});
		}
		// Rows the read went below although their default closes them: something nobody must
		// miss is under them. Kept as a hint until their marks are read.
		const stack: Array<{ key: string; over: boolean }> = [
			{
				key: this.rootKey,
				over: this.rootInTask || (this.rootId !== null && this.isDetailMaker(this.rootId)),
			},
		];
		while (stack.length > 0) {
			const at = stack.pop() as { key: string; over: boolean };
			for (const id of this.levels.get(at.key)?.ids ?? []) {
				const block = this.blocks.get(id);
				if (!block?.hasChildren || closed.has(id) || !went.has(id)) continue;
				const top = this.rootId === null && at.key === this.spaceId;
				if (
					!top &&
					!this.expanded.has(id) &&
					!foldDefaultOpen({
						root: false,
						task: block.task?.status ?? null,
						report: isOutlineReportBlockId(id),
						detail: at.over,
					})
				) {
					this.hints.add(id);
				}
				stack.push({ key: id, over: at.over || makesDetail(block) });
			}
		}
		this.noteSeq(read.seq);
	}

	private isDetailMaker(id: string): boolean {
		const block = this.blocks.get(id);
		return !!block && makesDetail(block);
	}

	// ── what is open ──────────────────────────────────────────────────────────

	private over(id: string): boolean {
		if (this.asOf !== undefined) return false;
		const marks = this.marks.get(id);
		if (marks) return marks.questions + marks.locked + marks.pending > 0;
		return this.hints.has(id);
	}

	private defaultOpen(block: OutlineTreeBlock, detail: boolean, top: boolean): boolean {
		if (top) return false;
		if (this.over(block.id)) return true;
		return foldDefaultOpen({
			root: false,
			task: block.task?.status ?? null,
			report: isOutlineReportBlockId(block.id),
			detail,
		});
	}

	private isOpen(block: OutlineTreeBlock, depth: number, detail: boolean, top: boolean): boolean {
		if (!block.hasChildren) return false;
		// (The server counts the root as depth 0, so a row at `depth` here is one deeper.)
		if (depth + 1 >= FOLD_MAX_OPEN_DEPTH) return false;
		if (this.forced.has(block.id)) return true;
		if (this.expanded.has(block.id)) return true;
		if (this.collapsed.has(block.id)) return false;
		return this.defaultOpen(block, detail, top);
	}

	private applyFold(id: string, open: boolean | null): void {
		this.expanded.delete(id);
		this.collapsed.delete(id);
		if (open === true) this.expanded.add(id);
		else if (open === false) this.collapsed.add(id);
	}

	private queueFold(id: string, open: boolean | null): void {
		this.applyFold(id, open);
		this.foldQueue.set(id, open);
		this.cancelFoldFlush?.();
		this.cancelFoldFlush = this.delay(() => this.flushFold(false), FOLD_FLUSH_MS);
	}

	/** Send the reader's folding not sent yet (`leaving`: the page is going away). */
	flushFold(leaving: boolean): Promise<unknown> {
		this.cancelFoldFlush?.();
		this.cancelFoldFlush = null;
		if (this.foldQueue.size === 0) return this.foldWrite;
		const changes = [...this.foldQueue].map(([blockId, open]) => ({ blockId, open }));
		this.foldQueue.clear();
		// One write at a time, in the order the reader folded.
		this.foldWrite = this.foldWrite
			.then(() => this.io.putFold(this.spaceId, changes, leaving))
			.catch(() => undefined);
		return this.foldWrite;
	}

	private setOpen(id: string, open: boolean): boolean {
		const block = this.blocks.get(id);
		const at = this.info.get(id);
		if (!block || !at || !block.hasChildren) return false;
		this.forced.delete(id);
		const was = this.isOpen(block, at.depth, at.detail, at.top);
		const byDefault = this.defaultOpen(block, at.detail, at.top);
		if (open === byDefault) {
			if (this.expanded.has(id) || this.collapsed.has(id)) this.queueFold(id, null);
		} else if (this.foldOf(id) !== (open ? "expanded" : "collapsed")) {
			this.queueFold(id, open);
		}
		if (open) this.asked.add(id);
		return was !== open;
	}

	/** The arrow: flip one row. */
	toggle(id: string): void {
		const at = this.info.get(id);
		if (!at) return;
		if (at.open) {
			this.wishes.clear();
			this.seekQuestion = null;
			if (this.form && this.isUnder(this.form.afterId, id)) this.form = null;
		}
		this.setOpen(id, !at.open);
		this.changed();
	}

	/**
	 * Everything inside a row (Alt on its arrow, its quick control, its preview line): open it
	 * and what loads under it, up to {@link FOREST_LIMITS.openInside} rows; or, `open` false,
	 * back to the default view inside it (the reader's own folding of what is loaded there is
	 * dropped).
	 */
	foldInside(id: string | null, open: boolean): void {
		const root = id ?? this.rootKey;
		if (open) {
			this.wishes.set(root, FOREST_LIMITS.openInside);
			if (id !== null) this.setOpen(id, true);
		} else {
			this.wishes.clear();
			// The row itself too: closed again where its default closes it.
			for (const under of [...(id !== null ? [id] : []), ...this.loadedUnder(root)]) {
				if (this.expanded.has(under) || this.collapsed.has(under)) this.queueFold(under, null);
				this.forced.delete(under);
			}
		}
		this.changed();
	}

	/** Loaded blocks under a parent key, any depth (bounded by what is loaded). */
	private loadedUnder(parentKey: string): string[] {
		const out: string[] = [];
		const stack = [parentKey];
		const seen = new Set<string>();
		while (stack.length > 0) {
			const key = stack.pop() as string;
			for (const id of this.levels.get(key)?.ids ?? []) {
				if (seen.has(id)) continue;
				seen.add(id);
				out.push(id);
				stack.push(id);
			}
		}
		return out;
	}

	private isUnder(id: string, ancestor: string): boolean {
		for (
			let at = this.blocks.get(id);
			at;
			at = at.parentId ? this.blocks.get(at.parentId) : undefined
		) {
			if (at.id === ancestor) return true;
			if (!at.parentId) return false;
		}
		return false;
	}

	// ── rows ──────────────────────────────────────────────────────────────────

	getView = (): ForestView => {
		if (this.cached) return this.cached;
		const rows: ForestRow[] = [];
		const info = new Map<string, RowInfo>();
		let processHidden = 0;
		// One stack: a row to emit, or a level to lay out (pushed in reverse, so that popping
		// gives document order).
		const stack: Array<{ row: ForestRow } | { key: string; depth: number; over: boolean }> = [
			{
				key: this.rootKey,
				depth: 0,
				over: this.rootInTask || (this.rootId !== null && this.isDetailMaker(this.rootId)),
			},
		];
		const seen = new Set<string>();
		/** Headings whose first child a report's line is read from, by the report's row. */
		const previewOf = new Map<string, string>();
		while (stack.length > 0) {
			const at = stack.pop() as (typeof stack)[number];
			if ("row" in at) {
				rows.push(at.row);
				continue;
			}
			const level = this.levels.get(at.key);
			const top = this.rootId === null && at.key === this.spaceId;
			if (!level || level.preview) {
				const waiting =
					!level?.failed && (this.asked.has(at.key) || this.blocks.size < FOREST_LIMITS.autoRows);
				rows.push({
					kind: "more",
					key: `load:${at.key}`,
					parentKey: at.key,
					depth: at.depth,
					mode: waiting ? "loading" : "load",
					busy: waiting,
					failed: level?.failed ?? false,
					before: 0,
					shown: 0,
				});
				continue;
			}
			processHidden += level.processHidden;
			const before = level.pages.reduce((sum, page) => sum + page.count, 0);
			const more = (mode: ForestMoreRow["mode"]): ForestMoreRow => ({
				kind: "more",
				key: `${mode}:${at.key}`,
				parentKey: at.key,
				depth: at.depth,
				mode,
				busy: level.busy,
				failed: level.failed,
				before,
				shown: level.ids.length,
			});
			const inWindow = new Set(level.ids);
			const pinned = (this.pins.get(at.key) ?? []).filter(
				(id) => !inWindow.has(id) && this.blocks.has(id),
			);
			if (level.more) {
				const paged =
					level.pages.length > 0 ||
					level.ids.length + FOREST_LIMITS.chunk > FOREST_LIMITS.pagedAbove;
				stack.push({ row: more(paged ? "next" : "more") });
			} else if (
				level.ids.length === 0 &&
				pinned.length === 0 &&
				(at.key === this.rootKey || level.processHidden > 0)
			) {
				stack.push({
					row: {
						kind: "note",
						key: `note:${at.key}`,
						depth: at.depth,
						note: level.processHidden > 0 ? "hidden" : "empty",
						count: level.processHidden,
					},
				});
			}
			const ids = [...pinned, ...level.ids];
			for (let i = ids.length - 1; i >= 0; i--) {
				const id = ids[i] as string;
				const block = this.blocks.get(id);
				if (!block || seen.has(id)) continue;
				seen.add(id);
				const open = this.isOpen(block, at.depth, at.over, top);
				info.set(id, { depth: at.depth, detail: at.over, top, open, parentKey: at.key });
				const first = open ? undefined : this.levels.get(id);
				const finished = block.task?.status === "done" || block.task?.status === "cancelled";
				let previewBlock = first ? this.blocks.get(first.ids[0] ?? "") : undefined;
				// A finished task's line is its first note; subtasks and reports before it are not.
				if (first && finished) {
					const isNote = (kid: OutlineTreeBlock | undefined) =>
						!!kid && !kid.task && !kid.question && !isOutlineReportBlockId(kid.id);
					if (!isNote(previewBlock)) {
						previewBlock =
							first.ids.map((kid) => this.blocks.get(kid)).find(isNote) ??
							(first.kids?.previewId ? this.blocks.get(first.kids.previewId) : undefined) ??
							previewBlock;
					}
				}
				// A report's line is its first paragraph: what stands under its first heading.
				const report = isOutlineReportContainer(id, block.content);
				if (report && previewBlock?.hasChildren && /^#{1,6}\s/.test(previewBlock.content)) {
					const under = this.levels.get(previewBlock.id);
					const paragraph = under ? this.blocks.get(under.ids[0] ?? "") : undefined;
					if (paragraph) previewBlock = paragraph;
					else if (!under) previewOf.set(previewBlock.id, id);
				}
				// (Only subtasks under it: its title is all there is.)
				const usable =
					previewBlock !== undefined &&
					!(finished && (previewBlock.task || isOutlineReportBlockId(previewBlock.id)));
				if (open) {
					stack.push({ key: id, depth: at.depth + 1, over: at.over || makesDetail(block) });
				}
				stack.push({
					row: {
						kind: "block",
						key: `block:${id}`,
						id,
						depth: at.depth,
						block,
						parentKey: at.key,
						hasChildren: block.hasChildren,
						open,
						pinned: !inWindow.has(id),
						previewId: usable ? (previewBlock as OutlineTreeBlock).id : null,
						previewKind: !usable ? null : report ? "report" : finished ? "result" : "details",
						previewMore:
							!!first && (first.more || first.ids.length > 1 || !!previewBlock?.hasChildren),
						previewRest: first
							? first.kids
								? Math.max(0, first.kids.count - 1)
								: first.more
									? null
									: Math.max(0, first.ids.length - 1)
							: null,
						previewRestMore: first?.kids ? first.kids.more : false,
						subtree: null,
					},
				});
			}
			if (level.pages.length > 0) stack.push({ row: more("prev") });
		}
		// The rows' "everything inside" controls, and the forest's own: one pass with the open
		// rows above the row being visited.
		const indexOf = new Map<string, number>();
		const above: Array<{ row: ForestBlockRow; deep: boolean; closed: boolean; own: boolean }> = [];
		const whole = { deep: false, closed: false, own: false };
		const settle = (depth: number) => {
			while (above.length > 0 && (above.at(-1) as (typeof above)[number]).row.depth >= depth) {
				const done = above.pop() as (typeof above)[number];
				done.row.subtree = !done.deep
					? null
					: done.closed
						? "expand"
						: done.own
							? "collapse"
							: null;
			}
		};
		for (let i = 0; i < rows.length; i++) {
			const row = rows[i] as ForestRow;
			if (row.kind !== "block") continue;
			settle(row.depth);
			indexOf.set(row.id, i);
			if (!row.hasChildren) continue;
			const own = this.expanded.has(row.id) || this.forced.has(row.id);
			for (const up of above) {
				up.deep = true;
				if (!row.open) up.closed = true;
				if (own) up.own = true;
			}
			whole.deep = true;
			if (!row.open) whole.closed = true;
			if (own || this.collapsed.has(row.id)) whole.own = true;
			// An open row whose level waits for the reader (the budget) is closed to the controls:
			// "everything inside" reads it.
			const next = rows[i + 1];
			if (row.open && next?.kind === "more" && next.mode === "load" && next.parentKey === row.id) {
				for (const up of above) up.closed = true;
				whole.closed = true;
			}
			if (row.open) above.push({ row, deep: false, closed: false, own: false });
			else if (
				this.levels.get(row.id)?.ids.some((kid) => this.blocks.get(kid)?.hasChildren) ||
				(row.previewId && this.blocks.get(row.previewId)?.hasChildren)
			)
				row.subtree = "expand";
		}
		settle(-1);
		// The question form, under the row it belongs to.
		if (this.form) {
			const at = indexOf.get(this.form.afterId);
			if (at !== undefined) {
				rows.splice(at + 1, 0, {
					kind: "form",
					key: `form:${this.form.under}`,
					depth: (rows[at] as ForestBlockRow).depth,
					under: this.form.under,
				});
				for (const [id, index] of indexOf) if (index > at) indexOf.set(id, index + 1);
			}
		}
		this.info = info;
		this.previewOf = previewOf;
		this.cached = {
			rows,
			indexOf,
			all: !whole.deep ? null : whole.closed ? "expand" : whole.own ? "collapse" : null,
			processHidden,
		};
		return this.cached;
	};

	// ── loading ───────────────────────────────────────────────────────────────

	/** Rows the view shows (and around them): what is watched, kept fresh and marked. */
	setViewport(first: number, last: number): void {
		const { rows } = this.getView();
		const near = new Set<string>();
		const from = Math.max(0, first - FOREST_LIMITS.nearRows);
		const to = Math.min(rows.length - 1, last + FOREST_LIMITS.nearRows);
		for (let i = from; i <= to && near.size < FOREST_LIMITS.watchLevels; i++) {
			const row = rows[i] as ForestRow;
			if (row.kind === "block" || row.kind === "more") near.add(row.parentKey);
		}
		near.add(this.rootKey);
		const visible: string[] = [];
		for (let i = Math.max(0, first); i <= Math.min(rows.length - 1, last); i++) {
			const row = rows[i] as ForestRow;
			if (row.kind === "block" && row.hasChildren) visible.push(row.id);
		}
		const sameNear = near.size === this.near.size && [...near].every((key) => this.near.has(key));
		const marksKey = visible.slice(0, FOREST_LIMITS.markKeys).join(",");
		this.near = near;
		this.visible = visible;
		if (marksKey !== this.marksWanted) {
			this.marksWanted = marksKey;
			this.scheduleMarks(MARKS_DELAY_MS);
		}
		if (!sameNear) {
			for (const listener of this.watchListeners) listener();
			this.pump();
		}
	}

	private readonly watchListeners = new Set<() => void>();

	/** Told when what should be watched may have changed. */
	onWatchKeys(listener: () => void): () => void {
		this.watchListeners.add(listener);
		return () => this.watchListeners.delete(listener);
	}

	/** What the block watch should watch now: loaded levels near the viewport, visible closed rows. */
	watchKeys(): { levels: string[]; subtrees: string[] } {
		if (this.asOf !== undefined || this.status !== "ready") return { levels: [], subtrees: [] };
		const levels = [...this.near].filter((key) => this.levels.has(key));
		const subtrees: string[] = [];
		for (const id of this.visible) {
			if (subtrees.length >= FOREST_LIMITS.watchSubtrees) break;
			if (this.info.get(id)?.open === false) subtrees.push(id);
		}
		return { levels: levels.slice(0, FOREST_LIMITS.watchLevels), subtrees };
	}

	private pump(): void {
		if (this.disposed || this.status !== "ready") return;
		if (this.pumping) {
			this.pumpAgain = true;
			return;
		}
		this.pumping = true;
		void this.pumpOnce()
			.catch(() => undefined)
			.finally(() => {
				this.pumping = false;
				if (this.pumpAgain) {
					this.pumpAgain = false;
					this.pump();
				}
			});
	}

	private async pumpOnce(): Promise<void> {
		const { rows } = this.getView();
		// (A wish made while this round waits for a read is the next round's.)
		const wished = [...this.wishes.keys()];
		// "Everything inside": open what has loaded under the wished rows.
		if (this.applyWishes()) {
			this.changed();
			return;
		}
		// Levels to read from their beginning: open rows without theirs, and stale simple ones.
		const start: string[] = [];
		const ranges: string[] = [];
		for (const row of rows) {
			if (row.kind !== "more" || (row.mode !== "loading" && row.mode !== "load")) continue;
			const level = this.levels.get(row.parentKey);
			if (level?.busy || level?.failed) continue;
			if (this.asked.has(row.parentKey) || this.blocks.size < FOREST_LIMITS.autoRows)
				start.push(row.parentKey);
		}
		for (const key of this.near) {
			const level = this.levels.get(key);
			if (!level?.stale || level.busy) continue;
			if (
				level.start === null &&
				level.pages.length === 0 &&
				level.ids.length <= FOREST_LIMITS.chunk
			)
				start.push(key);
			else ranges.push(key);
		}
		// Closed rows on screen whose preview went stale are read again too (their one line).
		for (const id of this.visible) {
			const level = this.levels.get(id);
			if (level?.stale && !level.busy && !start.includes(id) && !ranges.includes(id))
				start.push(id);
		}
		if (start.length > 0) {
			// As many parents as one read can bring a whole chunk of each.
			await this.readFromStart(
				[...new Set(start)].slice(
					0,
					Math.min(
						FOREST_LIMITS.parents,
						Math.floor(FOREST_LIMITS.readBlocks / FOREST_LIMITS.chunk),
					),
				),
				false,
			);
			this.changed();
			return;
		}
		// Closed rows on screen without the child their one line is read from.
		const onScreen = new Set(this.visible);
		const previews = [
			...this.visible.filter((id) => this.info.get(id)?.open === false && !this.levels.has(id)),
			...[...this.previewOf]
				.filter(([heading, row]) => onScreen.has(row) && !this.levels.has(heading))
				.map(([heading]) => heading),
		];
		if (previews.length > 0) {
			await this.readFromStart(previews.slice(0, FOREST_LIMITS.parents), true);
			this.changed();
			return;
		}
		if (ranges.length > 0) {
			const key = ranges[0] as string;
			const level = this.levels.get(key) as ForestLevel;
			await this.readWindow(
				key,
				level.start,
				Math.max(level.ids.length, FOREST_LIMITS.chunk),
				level.pages,
			);
			this.changed();
			return;
		}
		if (await this.advanceReveal()) {
			this.changed();
			return;
		}
		// Nothing left to read: what was asked to open whole has opened as far as it goes.
		this.settleQuestion();
		for (const root of wished) this.wishes.delete(root);
		this.sweep();
	}

	private blank(key: string): ForestLevel {
		const level: ForestLevel = {
			ids: [],
			start: null,
			more: false,
			next: null,
			pages: [],
			processHidden: 0,
			seq: -1,
			preview: true,
			kids: null,
			stale: false,
			busy: false,
			failed: false,
		};
		this.levels.set(key, level);
		return level;
	}

	/** Read the first chunk of several levels in one request. */
	private async readFromStart(keys: string[], preview: boolean): Promise<void> {
		for (const key of keys) (this.levels.get(key) ?? this.blank(key)).busy = true;
		const perParent = preview ? FOREST_LIMITS.previewPeek : FOREST_LIMITS.chunk;
		try {
			const read = await this.io.children(this.spaceId, {
				parents: keys.map((key) => (key === this.spaceId ? null : key)),
				perParent,
				limit: FOREST_LIMITS.readBlocks,
				...this.readParams(),
			});
			this.reads++;
			for (const block of read.blocks) this.blocks.set(block.id, block);
			const got = new Map(read.levels.map((level) => [level.parentId ?? this.spaceId, level]));
			for (const key of keys) {
				const level = this.levels.get(key);
				if (!level) continue;
				level.busy = false;
				const found = got.get(key);
				// Not reached by this read (its budget): it stays wanted.
				if (!found || isUnread(found)) continue;
				this.levels.set(key, {
					ids: [...found.childIds],
					start: null,
					more: found.more,
					next: found.nextCursor,
					pages: [],
					processHidden: found.processHidden,
					seq: read.seq,
					preview,
					kids: preview ? { count: found.childIds.length, more: found.more } : null,
					stale: false,
					busy: false,
					failed: false,
				});
				this.noteLeaf(key, found);
			}
			this.noteSeq(read.seq);
		} catch (error) {
			for (const key of keys) {
				const level = this.levels.get(key);
				if (!level) continue;
				level.busy = false;
				level.failed = true;
			}
			if (httpStatus(error) === 404) this.status = "missing";
		}
	}

	/** A level read whole and empty: its row has no children (any more). */
	private noteLeaf(key: string, level: OutlineTreeLevel): void {
		const block = this.blocks.get(key);
		if (!block) return;
		// (Children the facts view leaves out still count: the row keeps its arrow and says so.)
		const has = level.childIds.length > 0 || level.more || level.processHidden > 0;
		if (!has && block.hasChildren) this.blocks.set(key, { ...block, hasChildren: false });
	}

	/** Read `target` children of one level from `start`, in as many requests as that takes. */
	private async readWindow(
		key: string,
		start: string | null,
		target: number,
		pages: ForestLevel["pages"],
	): Promise<void> {
		const level = this.levels.get(key) ?? this.blank(key);
		level.busy = true;
		level.failed = false;
		const ids: string[] = [];
		let cursor = start;
		let more = false;
		let next: string | null = null;
		let processHidden = 0;
		let seq = -1;
		try {
			for (;;) {
				const take = Math.min(FOREST_LIMITS.readBlocks, target - ids.length);
				const read = await this.io.children(this.spaceId, {
					parents: [key === this.spaceId ? null : key],
					cursor,
					perParent: take,
					limit: take,
					...this.readParams(),
				});
				this.reads++;
				for (const block of read.blocks) this.blocks.set(block.id, block);
				const found = read.levels.find((l) => (l.parentId ?? this.spaceId) === key);
				seq = read.seq;
				if (!found) break;
				ids.push(...found.childIds);
				processHidden += found.processHidden;
				more = found.more;
				next = found.nextCursor;
				// (A read that brought nothing and no cursor would never end.)
				if (!more || next === null || ids.length >= target || found.childIds.length === 0) break;
				cursor = next;
			}
			this.levels.set(key, {
				ids,
				start,
				more,
				next,
				pages,
				processHidden,
				seq,
				preview: false,
				kids: null,
				stale: false,
				busy: false,
				failed: false,
			});
			this.noteSeq(seq);
		} catch (error) {
			level.busy = false;
			level.failed = true;
			if (httpStatus(error) === 404) this.status = "missing";
		}
	}

	/** A "more" row was used. */
	async more(parentKey: string, mode: ForestMoreRow["mode"]): Promise<void> {
		const level = this.levels.get(parentKey);
		if (mode === "load" || mode === "loading") {
			this.asked.add(parentKey);
			if (level) level.failed = false;
			this.changed();
			return;
		}
		if (!level || level.busy) return;
		if (mode === "more") {
			level.busy = true;
			level.failed = false;
			this.changed();
			try {
				const read = await this.io.children(this.spaceId, {
					parents: [parentKey === this.spaceId ? null : parentKey],
					cursor: level.next,
					perParent: FOREST_LIMITS.chunk,
					limit: FOREST_LIMITS.chunk,
					...this.readParams(),
				});
				this.reads++;
				for (const block of read.blocks) this.blocks.set(block.id, block);
				const found = read.levels.find((l) => (l.parentId ?? this.spaceId) === parentKey);
				const have = new Set(level.ids);
				if (found) {
					level.ids = [...level.ids, ...found.childIds.filter((id) => !have.has(id))];
					level.more = found.more;
					level.next = found.nextCursor;
					level.processHidden += found.processHidden;
				}
				this.noteSeq(read.seq);
			} catch {
				level.failed = true;
			}
			level.busy = false;
			this.changed();
			return;
		}
		const back = level.pages.at(-1);
		if (mode === "prev" && !back) return;
		level.busy = true;
		this.changed();
		if (mode === "next") {
			const pages = [...level.pages, { start: level.start, count: level.ids.length }];
			await this.readWindow(parentKey, level.next, FOREST_LIMITS.page, pages);
		} else if (back) {
			await this.readWindow(parentKey, back.start, back.count, level.pages.slice(0, -1));
		}
		this.changed();
	}

	private applyWishes(): boolean {
		let changed = false;
		for (const [root, left] of [...this.wishes]) {
			let room = left;
			let closedLeft = false;
			for (const id of this.loadedUnder(root)) {
				const at = this.info.get(id);
				const block = this.blocks.get(id);
				if (!at || !block?.hasChildren) continue;
				if (at.open) {
					// Open, its level waiting for the reader (the budget): asked for now.
					const level = this.levels.get(id);
					if ((!level || level.preview) && !this.asked.has(id) && room > 0) {
						this.asked.add(id);
						room--;
						changed = true;
					}
					continue;
				}
				if (room <= 0) {
					closedLeft = true;
					break;
				}
				if (this.setOpen(id, true)) {
					room--;
					changed = true;
				}
			}
			if (room <= 0 && closedLeft) this.wishes.delete(root);
			else this.wishes.set(root, room);
		}
		return changed;
	}

	// ── locating ──────────────────────────────────────────────────────────────

	/**
	 * Bring a block on screen: the ancestors given (outermost first, as a subtree read's `path`
	 * names them) are opened for this visit, each read where it is not loaded and pinned above
	 * its level's window where the window does not hold it. Resolves true once the block has a
	 * row, false when it cannot get one (it is not under this forest's root, or left out by the
	 * view).
	 */
	locate(pathIds: readonly string[], blockId: string, answer = false): Promise<boolean> {
		this.reveal?.done(false);
		let chain = [...pathIds, blockId];
		if (this.rootId !== null) {
			const at = chain.indexOf(this.rootId);
			if (at < 0 || at === chain.length - 1) return Promise.resolve(false);
			chain = chain.slice(at + 1);
		}
		return new Promise<boolean>((resolve) => {
			this.reveal = {
				chain,
				target: blockId,
				answer,
				reads: FOREST_LIMITS.pinReads,
				done: resolve,
			};
			for (const id of chain.slice(0, -1)) {
				this.forced.add(id);
				this.asked.add(id);
			}
			this.asked.add(this.rootKey);
			this.changed();
		});
	}

	private async advanceReveal(): Promise<boolean> {
		const reveal = this.reveal;
		if (!reveal) return false;
		const finish = (found: boolean) => {
			this.reveal = null;
			if (found && reveal.answer) {
				this.form = {
					afterId: reveal.target,
					under: this.blocks.get(reveal.target)?.parentId ?? reveal.target,
				};
			}
			reveal.done(found);
			return found && reveal.answer;
		};
		let parentKey = this.rootKey;
		for (const id of reveal.chain) {
			const level = this.levels.get(parentKey);
			// Its level is on its way (the walk asks for it): wait for the next round.
			if (!level || level.preview || level.busy) return false;
			if (level.failed) return finish(false);
			const pinned = this.pins.get(parentKey)?.includes(id) === true;
			if (!level.ids.includes(id) && !pinned) {
				// Past the level's window (or left out by the view): read the block itself.
				if (reveal.reads-- <= 0) return finish(false);
				let block = this.blocks.get(id);
				if (!block || block.parentId !== (parentKey === this.spaceId ? null : parentKey)) {
					try {
						const read = await this.io.subtree(this.spaceId, id, {
							...this.readParams(),
							blocks: 2,
						});
						this.reads++;
						block = read.blocks[0];
					} catch {
						return finish(false);
					}
				}
				if (!block || block.parentId !== (parentKey === this.spaceId ? null : parentKey))
					return finish(false);
				this.blocks.set(block.id, block);
				this.pins.set(parentKey, [id]);
				return true;
			}
			if (id === reveal.target) return finish(true);
			// The ancestor has a row; its own level is read because it is forced open.
			if (!this.blocks.get(id)?.hasChildren) return finish(false);
			parentKey = id;
		}
		return finish(false);
	}

	/** Forget what locating pinned and forced open (the tree's "collapse all"). */
	clearLocated(): void {
		if (this.pins.size === 0 && this.forced.size === 0) return;
		this.pins.clear();
		this.forced.clear();
		this.changed();
	}

	// ── questions ─────────────────────────────────────────────────────────────

	/**
	 * A closed row's count of unanswered questions was used: what is inside it opens as it
	 * loads, and the form that answers the first question found comes up under that question.
	 */
	openQuestions(id: string): void {
		this.seekQuestion = id;
		this.form = null;
		this.foldInside(id, true);
	}

	closeForm(): void {
		if (!this.form) return;
		this.form = null;
		this.changed();
	}

	private settleQuestion(): void {
		const root = this.seekQuestion;
		if (!root) return;
		for (const id of this.loadedUnder(root)) {
			const block = this.blocks.get(id);
			if (block?.question?.state !== "open" || !this.info.has(id)) continue;
			this.seekQuestion = null;
			this.form = { afterId: id, under: block.parentId ?? id };
			this.changed();
			return;
		}
	}

	// ── live ──────────────────────────────────────────────────────────────────

	private markStale(key: string): void {
		const level = this.levels.get(key);
		if (level) level.stale = true;
	}

	private staleAll(): void {
		for (const level of this.levels.values()) level.stale = true;
		this.marksDirty = true;
	}

	/** The watch confirmed a set as of `seq`; `added` were not watched before. */
	onWatching(seq: number, added: { levels: readonly string[]; subtrees: readonly string[] }): void {
		if (seq > this.knownSeq) {
			// Past everything read or told: whatever is watched may have changed.
			this.staleAll();
		} else {
			// A key new in the set has no past: read it again unless it was read at this seq.
			for (const key of [...added.levels, ...added.subtrees]) {
				const level = this.levels.get(key);
				if (level && level.seq < seq) level.stale = true;
			}
		}
		this.noteSeq(seq);
		this.afterLive();
	}

	onChanged(frame: {
		seq: number;
		levels: readonly string[];
		subtrees: readonly string[];
		all: boolean;
	}): void {
		if (frame.all) this.staleAll();
		else {
			for (const key of frame.levels) this.markStale(key);
			for (const key of frame.subtrees) {
				// A closed row: its one line may have changed, and what is loaded under it is
				// not watched, so it is read again when the row opens.
				this.markStale(key);
				if (this.info.get(key)?.open === false) {
					for (const under of this.loadedUnder(key)) this.levels.delete(under);
				}
			}
		}
		this.noteSeq(frame.seq);
		this.marksDirty = true;
		this.afterLive();
	}

	/** Changes waiting for confirmation changed: rows show them, and marks count them. */
	onPending(): void {
		this.staleAll();
		this.afterLive();
	}

	/** Access was lost (or the space is gone): read the root again and show the answer. */
	onDenied(): void {
		void this.io
			.subtree(this.spaceId, this.rootId, { ...this.rootParams(), blocks: 1 })
			.then(() => undefined)
			.catch((error: unknown) => {
				if (httpStatus(error) === 404 && !this.disposed) {
					this.status = "missing";
					this.changed();
				}
			});
	}

	private afterLive(): void {
		if (this.marksDirty) this.scheduleMarks(MARKS_REFRESH_MS);
		this.pump();
	}

	// ── marks ─────────────────────────────────────────────────────────────────

	private scheduleMarks(ms: number): void {
		if (this.disposed) return;
		this.cancelMarks?.();
		this.cancelMarks = this.delay(() => void this.readMarks(), ms);
	}

	private async readMarks(): Promise<void> {
		this.cancelMarks = null;
		if (this.disposed || this.status !== "ready" || this.asOf !== undefined) return;
		if (this.marksBusy) {
			this.scheduleMarks(MARKS_REFRESH_MS);
			return;
		}
		const keys = this.visible.slice(0, FOREST_LIMITS.markKeys);
		this.marksDirty = false;
		if (keys.length === 0) return;
		this.marksBusy = true;
		try {
			const since = this.since !== undefined && this.since >= 0 ? this.since : undefined;
			const read = await this.io.marks(this.spaceId, keys, since);
			if (this.disposed) return;
			const got = new Set<string>();
			let changed = false;
			for (const marks of read.marks) {
				got.add(marks.key);
				const was = this.marks.get(marks.key);
				if (!was || JSON.stringify(was) !== JSON.stringify(marks)) changed = true;
				this.marks.set(marks.key, marks);
			}
			// A key the read has nothing for is no live block any more.
			for (const key of keys) if (!got.has(key) && this.marks.delete(key)) changed = true;
			if (this.marksAtLeast !== read.atLeast) changed = true;
			this.marksAtLeast = read.atLeast;
			this.noteSeq(read.seq);
			if (changed) this.changed();
		} catch {
			// Marks are an addition: the rows stay as they are.
		} finally {
			this.marksBusy = false;
		}
	}

	// ── memory ────────────────────────────────────────────────────────────────

	/** Drop what no open row leads to once the forest holds more than it may. */
	private sweep(): void {
		if (this.blocks.size <= FOREST_LIMITS.maxRows) return;
		const keepLevels = new Set<string>([this.rootKey]);
		const keepBlocks = new Set<string>();
		if (this.rootId) keepBlocks.add(this.rootId);
		for (const row of this.getView().rows) {
			if (row.kind !== "block") continue;
			keepBlocks.add(row.id);
			if (row.open) keepLevels.add(row.id);
			else if (row.previewId) {
				keepBlocks.add(row.previewId);
				keepLevels.add(row.id);
			}
		}
		for (const key of [...this.levels.keys()]) if (!keepLevels.has(key)) this.levels.delete(key);
		for (const id of [...this.blocks.keys()]) if (!keepBlocks.has(id)) this.blocks.delete(id);
		for (const id of [...this.marks.keys()]) if (!keepBlocks.has(id)) this.marks.delete(id);
		this.cached = null;
	}

	/** Requests made after the first (for tests). */
	get readCount(): number {
		return this.reads;
	}
}
