/**
 * Wire types of the outline reads that know no page (pageless outline, H2): any block's subtree
 * loaded lazily, one level per parent; what is under a block (marks); what changed under it;
 * its timeline. Routes are under `/api/outline/spaces/:spaceId/…` (`server/routes/outline-subtree.ts`).
 *
 * A LEVEL is named by its parent: a block id, or `null` for the top level of the space. Where a
 * single string must name either (marks, subscriptions), the space's own id stands for the top.
 */
import type {
	OutlineCommitSummary,
	OutlineLockView,
	OutlineQuestionMark,
	OutlineTaskView,
	OutlineViewMode,
} from "./outline-api";

export const OUTLINE_SUBTREE_LIMITS = {
	/**
	 * Blocks one subtree read returns (shows) unless asked otherwise, and at most. Rows the view
	 * leaves out (the facts view's tasks and questions) do not count; whatever the view, one read
	 * takes at most `maxBlocks` rows from the store, and where those run out first a level says
	 * `more` with a cursor after the last row read.
	 */
	defaultBlocks: 400,
	/** As of a seq, a read on the server's main thread stays at 800 rows (H1's measurement). */
	maxBlocks: 800,
	/** Blocks one read of levels returns unless asked otherwise, and at most. */
	defaultLevelBlocks: 200,
	maxLevelBlocks: 800,
	/** UTF-8 bytes of block content one read returns at most. */
	maxBytes: 256 * 1024,
	/** Parents one read of levels names at most. */
	maxParents: 50,
	/** Ancestors a read names in `path` (the nearest ones). */
	maxPath: 100,
	/** Closed rows of one folded read that get the child their preview line is read from. */
	maxPreviews: 50,
	/** Children of a closed row a folded read looks at to say how many it has (then "N+"). */
	previewPeek: 12,
	/** Keys one marks read names at most. */
	maxMarkKeys: 100,
	/** Open changes one read marks its blocks with; past it the read says `pendingTruncated`. */
	pendingRows: 500,
	/** Candidates of each kind a marks read looks at; past it the counts are lower bounds. */
	markCandidates: 500,
	/** Blocks a marks read looks up while walking candidates up to the space. */
	markWalkRows: 4000,
	/** Changed children one read returns unless asked otherwise, and at most. */
	defaultChanged: 100,
	maxChanged: 200,
	/** Commits one timeline page returns by default and at most. */
	defaultTimeline: 50,
	maxTimeline: 200,
} as const;

/** A block as a lazily loaded tree shows it. */
export interface OutlineTreeBlock {
	id: string;
	sid: string;
	parentId: string | null;
	orderKey: string;
	/** Canonical in-block markdown. */
	content: string;
	task: OutlineTaskView | null;
	question: OutlineQuestionMark | null;
	alias: string | null;
	tags: string[];
	/** `from_seq` of the version read. */
	versionSeq: number;
	/**
	 * It had live children at the seq read, whether or not the read loaded them (see
	 * `levels`), and whatever they are: in the facts view a block whose only children are tasks
	 * or questions still says true, and its level then comes back empty with `processHidden`.
	 */
	hasChildren: boolean;
	/** The lock, on a locked task. */
	lock: OutlineLockView | null;
	/** Open changes (ids) that target this block or add blocks under it; current reads only. */
	pending: string[];
	/** On a subagent report's container: its session's title, when the reader may read it. */
	reportFrom?: string;
}

/** What a read loaded of one parent's children. */
export interface OutlineTreeLevel {
	/** Null: the top level of the space. */
	parentId: string | null;
	/** The children loaded, in sibling order (their blocks are in `blocks`). */
	childIds: string[];
	/** The level holds more children than `childIds`, after them. */
	more: boolean;
	/**
	 * Where a read of this level continues (`cursor` of a levels read). Null with `more`: none
	 * of this read's children were loaded, so continue from where this read started.
	 */
	nextCursor: string | null;
	/** Tasks and questions among the children read that the facts view left out. */
	processHidden: number;
}

interface OutlineTreeRead {
	spaceId: string;
	/** The seq the read is as of; for a current read, the space's last commit when it started. */
	seq: number;
	/** Read from the current state rather than from history. */
	current: boolean;
	/** The view applied. */
	view: OutlineViewMode;
	blocks: OutlineTreeBlock[];
	/**
	 * One entry per parent the read looked at. A block with `hasChildren` and no entry here has
	 * none of its children loaded.
	 */
	levels: OutlineTreeLevel[];
	/**
	 * More open changes touch the blocks read than one read looks at
	 * ({@link OUTLINE_SUBTREE_LIMITS.pendingRows}): some `pending` lists are incomplete.
	 */
	pendingTruncated?: boolean;
}

/** `GET /spaces/:spaceId/children` */
export type OutlineLevelsResponse = OutlineTreeRead;

/** `GET /spaces/:spaceId/subtree` and `GET /spaces/:spaceId/blocks/:blockId/subtree` */
export interface OutlineSubtreeResponse extends OutlineTreeRead {
	/** Null: the whole space. Otherwise the root is the first of `blocks`. */
	rootId: string | null;
	/** The root's ancestors, the top-level block first; the nearest ones when there are many. */
	path: Array<{ id: string; sid: string; title: string }>;
	pathTruncated: boolean;
	/** The root is a task or a question, under one, or inside a subagent report. */
	rootInTask: boolean;
	/** Some levels were not loaded whole, or not at all, because the budget ran out. */
	truncated: boolean;
	/**
	 * With `fold=default`: the rows the read did not go below because they are closed (by the
	 * default folding with the reader's own over it). A closed row may have a level entry with
	 * the one child its preview line is read from.
	 */
	closed?: string[];
	/**
	 * With `fold=default`: of the closed rows that got their preview child, how many direct
	 * children the view shows under each, counted up to
	 * {@link OUTLINE_SUBTREE_LIMITS.previewPeek}; `more`: there are more than `kids`.
	 * `previewId`: on a finished task whose first child is not a note, the first note among
	 * the children looked at (its preview line is its result, not a subtask); that block is in
	 * `blocks` without being part of a level of this read.
	 */
	closedKids?: Record<string, { kids: number; more: boolean; previewId?: string }>;
	/**
	 * With `fold=default`: the space has more open questions, locks or open changes than one
	 * read looks at ({@link OUTLINE_SUBTREE_LIMITS.markCandidates} of each), or the walk up
	 * from them was cut short, so a row in `closed` may hide one of them after all.
	 */
	attentionAtLeast?: boolean;
}

/** What is under one block (the block itself not counted), or in the whole space. */
export interface OutlineSubtreeMarks {
	/** A block id, or the space id for the whole space. */
	key: string;
	/** Questions put to a person, not answered yet. */
	questions: number;
	tasks: { todo: number; doing: number };
	/** Locked tasks, whatever their status (a finished task can still be locked). */
	locked: number;
	/** Open changes waiting for confirmation that touch a block there. */
	pending: number;
	/**
	 * With `since`: whether the block itself changed in `(since, seq]`, and whether anything
	 * that was under it did. For the space key, `below` says whether the space had a commit.
	 */
	changed?: { self: boolean; below: boolean };
}

/** `GET /spaces/:spaceId/marks` */
export interface OutlineMarksResponse {
	spaceId: string;
	/** The space's last commit when the read started: the upper end of `changed`. */
	seq: number;
	/** One per key asked for that is a live block of the space (or the space itself). */
	marks: OutlineSubtreeMarks[];
	/**
	 * The space has more open questions, open tasks or open changes than one read looks at, or
	 * the walk up from them was cut short: every count is a lower bound.
	 */
	atLeast: boolean;
}

/** A child that differs between the two ends of a range of seqs. */
export interface OutlineChangedChild {
	blockId: string;
	/** The placement under this parent: since which seq, and until which (null: still there). */
	fromSeq: number;
	toSeq: number | null;
	orderKey: string;
	/** The child has a version of its own in the range. */
	self: boolean;
	/** Something that was under it changed in the range: its own level differs too. */
	below: boolean;
}

/** `GET /spaces/:spaceId/changed-children` */
export interface OutlineChangedChildrenResponse {
	spaceId: string;
	parentId: string | null;
	after: number;
	/** The upper end actually read: the one asked for, capped at the space's last commit. */
	upTo: number;
	children: OutlineChangedChild[];
	/** Pass as `cursor` for the next page; null when there is none. */
	nextCursor: string | null;
}

/** `GET /spaces/:spaceId/commits` and `GET /spaces/:spaceId/blocks/:blockId/commits` */
export interface OutlineSubtreeTimelineResponse {
	/** Commits that changed the block or anything that was under it, newest first. */
	commits: OutlineCommitSummary[];
	/** Pass as `before` for the next (older) page; null when there is none. */
	nextBefore: number | null;
	/** History at or below this seq is not kept: the timeline ends above it. */
	floorSeq: number;
}

/** `details` of the error a read of history answers with when it cannot be right (HTTP 409). */
export interface OutlineHistoryUnavailableDetails {
	/**
	 * `not-ready`: the space is still being prepared for reads of its history (try again
	 * shortly). `before-floor`: the seq asked for is older than the history kept.
	 */
	reason: "not-ready" | "before-floor";
	floorSeq: number;
	/** The seq the read asked for; null when it asked for none. */
	seq: number | null;
}

export const OUTLINE_HISTORY_ERROR_CODES = {
	"not-ready": "OUTLINE_HISTORY_NOT_READY",
	"before-floor": "OUTLINE_HISTORY_BEFORE_FLOOR",
} as const;

// ─────────────────────────────────────────────────────────────────────────────
// A reader's own folding, by block (pageless outline, F1)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * What a reader opened and closed in one space, one row per block (`outline_fold_state`). A
 * block in neither set follows the default folding (`shared/outline-fold.ts`), so a task that
 * gets done later closes by itself. Personal, never part of the block model, never a commit.
 */
export const OUTLINE_FOLD_STATE_LIMITS = {
	/**
	 * Blocks one reader has a stored folding for in one space. Writing more drops the ones
	 * written longest ago (they go back to the default).
	 */
	maxPerSpace: 2000,
	/** Blocks one write names at most. */
	maxChanges: 500,
	/** Bytes of a write's body. */
	maxBodyBytes: 64 * 1024,
	/** Resets one write carries at most (applied before its changes). */
	maxResets: 50,
} as const;

/** `GET /spaces/:spaceId/fold-state` and the answer of a write. */
export interface OutlineFoldStateResponse {
	spaceId: string;
	/** Opened by the reader: closed by default. */
	expanded: string[];
	/** Closed by the reader: open by default. */
	collapsed: string[];
	/**
	 * A reset under a block could not place every stored row (its bounded walk up stopped):
	 * some under the block may still be there.
	 */
	incomplete?: true;
	/** The write was older than one already applied for its writer: nothing was changed. */
	ignored?: true;
}

/**
 * `DELETE /spaces/:spaceId/fold-state?under=<block>`: the reader's folding back to the
 * default, of the whole space (no `under`, or the space's id) or of a block and everything
 * under it. One request, whatever the number of rows. Answers with the state after it.
 */
export type OutlineFoldStateResetQuery = { under?: string };

// ─────────────────────────────────────────────────────────────────────────────
// Open tasks under a block (pageless outline, F1: the "in progress" count's list)
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_OPEN_TASKS_LIMITS = {
	/** Tasks one page lists at most (default 20). */
	maxLimit: 50,
} as const;

/** One open task under the block asked about. */
export interface OutlineOpenTaskItem {
	id: string;
	/** The first line of its text, short. */
	title: string;
	status: "todo" | "doing";
	assignee: string | null;
}

/**
 * `GET /spaces/:spaceId/open-tasks?under=<key>&cursor=&limit=`: the open tasks (to do, in
 * progress) strictly under a block (`under` the space's id: the whole space), in progress
 * first, then by id; cursor-paged. Built from the same candidates as the marks read (the
 * space's open-task index, at most `markCandidates`), so it lists what the count counted;
 * `atLeast`: the space has more open tasks than one read looks at, the list may miss some.
 */
export interface OutlineOpenTasksResponse {
	under: string;
	items: OutlineOpenTaskItem[];
	nextCursor: string | null;
	atLeast: boolean;
}

/**
 * `PUT /spaces/:spaceId/fold-state`: changes, not the whole state, so two tabs of one reader do
 * not undo each other. `open: null` puts the block back to its default (its row is removed).
 * Ids that are not live blocks of the space are dropped silently.
 */
export interface OutlineFoldStatePutBody {
	changes?: Array<{ blockId: string; open: boolean | null }>;
	/**
	 * Back to the default BEFORE the changes, in the same transaction: null (or the space's
	 * id) for the whole space, a block for it and everything under it. At most
	 * `maxResets`. A write needs changes or resets.
	 */
	reset?: Array<string | null>;
	/**
	 * Who writes (one id per view, 8–64 of `A–Z a–z 0–9 _ -`) and the write's number, rising:
	 * the server ignores a write numbered at or below one it applied for that writer (the
	 * answer says `ignored`). Both or neither.
	 */
	writer?: string;
	n?: number;
}
