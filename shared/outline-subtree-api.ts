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
