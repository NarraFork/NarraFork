/**
 * Shapes of the outline HTTP API (`/api/outline`), shared by the routes and the web client.
 *
 * Ids are opaque strings: a block's id is stable for good, its short id (`sid`) and address
 * (`key/sid`) are what people and agents write. Nothing here carries agent-facing prose; the
 * client words everything through i18n from the codes below.
 */

export type OutlineSpaceKind = "project" | "personal" | "session";

/** `facts` leaves process (tasks and what is under them) out; `all` shows everything. */
export type OutlineViewMode = "facts" | "all";

export type OutlineActorKind = "human" | "agent" | "system";

export type OutlineCommitKind = "edit" | "revert" | "import" | "confirm" | "answer" | "plan";

export type OutlineTaskStatus = "todo" | "doing" | "done" | "cancelled";

export type OutlineLinkKind = "link" | "embed" | "depends" | "tag";

/** What one version of a block changed, decoded from the stored change flags. */
export type OutlineChange =
	| "create"
	| "content"
	| "move"
	| "delete"
	| "restore"
	| "task"
	| "page"
	| "props"
	| "merge";

/** Why a revert left a block as it is. */
export type OutlineRevertSkipReason = "changed-later" | "parent-gone" | "later-children" | "cycle";

/** Limits of one view read; the server clamps what a client asks for to these. */
export const OUTLINE_VIEW_LIMITS = {
	/** Blocks one view shows unless the client asks for fewer or more. */
	defaultBlocks: 800,
	maxBlocks: 2000,
	/** UTF-8 bytes of block content one view returns at most. */
	maxBytes: 256 * 1024,
	/** Commits one timeline page returns by default and at most. */
	defaultTimeline: 50,
	maxTimeline: 200,
	/** Spaces and pages per list page. */
	defaultListPage: 50,
	maxListPage: 200,
	/** Search results. */
	defaultSearch: 20,
	maxSearch: 50,
	/** Backlinks one call returns. */
	defaultBacklinks: 50,
	maxBacklinks: 200,
} as const;

export interface OutlineSpaceSummary {
	id: string;
	key: string;
	kind: OutlineSpaceKind;
	projectId: string | null;
	narratorId: string | null;
	/**
	 * What the space belongs to, by name: the project's name or the session's title. Null for a
	 * personal space and for one whose owner is gone; the client names those.
	 */
	label: string | null;
	/** The caller's own personal space. */
	mine: boolean;
	/** The project, user or session the space belonged to is gone. */
	orphaned: boolean;
	/** Seq of the space's last commit; 0 when nothing was written yet. */
	lastSeq: number;
}

export interface OutlineSpaceDetail extends OutlineSpaceSummary {
	/** Whether the caller may change the space (and revert its commits). */
	canWrite: boolean;
	/**
	 * A session space's place in the connected outline: the space of the session's project, when
	 * that space exists and the caller may read the project. Absent or null otherwise (the session
	 * belongs to no project, or the caller reads it without reading its project).
	 */
	parent?: { spaceId: string; label: string | null } | null;
}

/**
 * The connected outline (`GET /outline/tree…`): limits of each listing. A node's children are
 * read when it is opened, a page at a time; nothing here returns block content.
 */
export const OUTLINE_TREE_LIMITS = {
	/** Project spaces per page of the tree's root. */
	projects: 30,
	/** Session spaces per page of a group. */
	sessions: 20,
	/** Pages of a space per page of its list. */
	pages: 50,
	/** Blocks and UTF-8 bytes one opened page reads; what is beyond is read by focusing it. */
	pageBlocks: 200,
	pageBytes: 64 * 1024,
	/** A group counts its spaces up to this many (shown as one less with a plus beyond). */
	countCap: 100,
} as const;

/** A space as a row of the connected outline. */
export interface OutlineTreeSpace extends OutlineSpaceSummary {
	/** When the space was last committed to; null when never, or not stamped yet. */
	lastCommitAt: string | null;
	/**
	 * A project space: how many session spaces of the project the caller may read, counted up to
	 * {@link OUTLINE_TREE_LIMITS.countCap}.
	 */
	sessions?: number;
}

/** The root of the connected outline: the caller's own space, then a page of project spaces. */
export interface OutlineTreeResponse {
	/** The caller's personal space; null when it does not exist yet, and on later pages. */
	personal: OutlineTreeSpace | null;
	/** Project spaces the caller may read, latest commit first. */
	projects: OutlineTreeSpace[];
	nextCursor: string | null;
	/**
	 * Session spaces the caller may read that hang under no listed project space, and (admins)
	 * spaces whose owner is gone: counted up to {@link OUTLINE_TREE_LIMITS.countCap}. Zero on
	 * later pages.
	 */
	loose: number;
	orphaned: number;
}

/** A page of the session spaces of one group of the connected outline. */
export interface OutlineTreeSpacesResponse {
	spaces: OutlineTreeSpace[];
	nextCursor: string | null;
}

export interface OutlineSpaceListResponse {
	spaces: OutlineSpaceSummary[];
	nextCursor: string | null;
}

/** The space of a project or a session; null when it does not exist yet and the caller may not create it. */
export interface OutlineSpaceResolveResponse {
	space: OutlineSpaceSummary | null;
	created: boolean;
}

export interface OutlinePageSummary {
	id: string;
	sid: string;
	title: string;
	alias: string | null;
	isTask: boolean;
}

export interface OutlineSpaceDetailResponse {
	space: OutlineSpaceDetail;
}

export interface OutlinePageListResponse {
	pages: OutlinePageSummary[];
	nextCursor: string | null;
}

export interface OutlineTaskView {
	status: OutlineTaskStatus;
	/** `agent:name` or `human:name`. */
	assignee: string | null;
	due: string | null;
	/** Prerequisites as written (addresses, aliases or titles). */
	depends: string[];
}

/** Who locked a task tree (design §2.2), and the session confirming on their behalf. */
export interface OutlineLockView {
	/** The locked task. */
	blockId: string;
	by: { kind: OutlineActorKind; id: string; name: string | null };
	delegate: { narratorId: string; title: string | null } | null;
	/** Seq of the commit that locked it. */
	versionSeq: number;
	/** Whether the caller may unlock it: the locker, a manager of the space, an admin. */
	canUnlock: boolean;
}

/** A task under a fact, as its "in progress" marker lists it (design §3.1). */
export interface OutlineInProgressItem {
	id: string;
	sid: string;
	title: string;
	status: OutlineTaskStatus;
	assignee: string | null;
	/** A change to it waits for confirmation. */
	waiting: boolean;
	/** It is a question put to a person (`Ask`), not a task. */
	question?: boolean;
}

/** A question block as a page shows it (`Ask`, outline P2 PR 7). */
export interface OutlineQuestionMark {
	state: "open" | "answered" | "withdrawn";
	/** A reversible decision the asker went ahead with: nothing waits for it. */
	proceed: boolean;
}

export interface OutlineViewBlock {
	id: string;
	sid: string;
	parentId: string | null;
	/** Canonical in-block markdown. */
	content: string;
	task: OutlineTaskView | null;
	/** On a question put to a person (`Ask`): its state. */
	question?: OutlineQuestionMark | null;
	alias: string | null;
	tags: string[];
	/** Children shown in this view, in sibling order. */
	childIds: string[];
	/** Blocks of the view under this block that did not fit the budget. */
	hidden: number;
	/** Blocks the facts view leaves out under this block (tasks, questions and what is under them). */
	processHidden: number;
	/** Tasks and unanswered questions directly under this block (neither done nor cancelled). */
	openTasks: number;
	/**
	 * Those tasks (at most {@link OUTLINE_PENDING_API_LIMITS.inProgressItems}), for the "in
	 * progress" marker of the facts view.
	 */
	inProgress: OutlineInProgressItem[];
	/** The lock, on a locked task. */
	lock: OutlineLockView | null;
	/**
	 * Open changes (ids) that target this block (it waits for confirmation) or add blocks under
	 * it (a mark only).
	 */
	pending: string[];
	/**
	 * On a subagent report's container: the subagent's session title, when the reader may read
	 * that session (absent otherwise, and past the containers one view names).
	 */
	reportFrom?: string;
}

export interface OutlineBlockViewResponse {
	space: OutlineSpaceDetail;
	pageId: string;
	rootId: string;
	/** The seq the view is as of. */
	seq: number;
	/** Read from the current state rather than from history. */
	current: boolean;
	/** The view applied: `all` when the root is a task or under one. */
	view: OutlineViewMode;
	/**
	 * The root is under a task or inside a subagent report: its blocks are details, folded by
	 * default (`shared/outline-fold.ts`). Absent from an older server: false.
	 */
	rootInTask?: boolean;
	/** The root's ancestors, the page first. */
	path: Array<{ id: string; sid: string; title: string }>;
	/** The blocks shown, the root first, breadth first. */
	blocks: OutlineViewBlock[];
	hiddenByBudget: number;
	hiddenByView: number;
	/** The page has more blocks than one read loads; some were left out. */
	pageTruncated: boolean;
	/**
	 * Live blocks of the page, the page included, as the read counted them (at least this many
	 * with `pageTruncated`): whether it can be edited live (PR8's limits) is known before joining.
	 */
	pageBlocks: number;
}

export interface OutlineCommitSummary {
	id: string;
	seq: number;
	kind: OutlineCommitKind;
	actorKind: OutlineActorKind;
	/** A person's username, when a person wrote it and the account still exists. */
	actorName: string | null;
	/** Username of the person accountable for the commit (an agent's user). */
	responsibleName: string | null;
	/** The session that wrote it, for an agent's commit. */
	narratorId: string | null;
	createdAt: string;
	summary: string;
}

export interface OutlineTimelineResponse {
	/** Commits that touched the page, newest first. */
	commits: OutlineCommitSummary[];
	/** Pass as `before` for the next (older) page; null when there is none. */
	nextBefore: number | null;
}

export interface OutlineBlockHistoryEntry {
	seq: number;
	changes: OutlineChange[];
	deleted: boolean;
	/** The page the block was on in this version. */
	pageId: string;
	commit: OutlineCommitSummary | null;
}

export interface OutlineBlockHistoryResponse {
	/** Versions of the block, newest first. */
	entries: OutlineBlockHistoryEntry[];
	nextBefore: number | null;
}

export interface OutlineBacklinkView {
	blockId: string;
	spaceId: string;
	pageId: string;
	address: string;
	title: string;
	kind: OutlineLinkKind;
}

export interface OutlineBacklinksResponse {
	links: OutlineBacklinkView[];
	truncated: boolean;
}

export interface OutlineSearchHitView {
	blockId: string;
	spaceId: string;
	pageId: string;
	address: string;
	alias: string | null;
	title: string;
	snippet: string;
	/** Titles of the ancestors, the page first. */
	path: string[];
	/** A task, under one, or session notes. */
	process: boolean;
}

export interface OutlineSearchResponse {
	hits: OutlineSearchHitView[];
}

export interface OutlineRevertResponse {
	reverted: { id: string; seq: number };
	/** The compensating commit; null when nothing could be (or needed to be) put back. */
	commit: { id: string; seq: number } | null;
	pageIds: string[];
	/** Blocks put back. */
	changed: number;
	/** Blocks left as they are, and why. */
	skipped: Array<{
		blockId: string;
		sid: string;
		address: string;
		reason: OutlineRevertSkipReason;
	}>;
	/** Blocks put back with an adjustment (an alias dropped, a position moved). */
	adjusted: number;
}

/**
 * Limits of `GET /api/outline/resolve`: what a tool card or a link names, turned into a place to
 * open. One space is consulted per request.
 */
export const OUTLINE_RESOLVE_REQUEST_LIMITS = {
	/** Characters of a reference (`key/sid`, `key/alias`, a bare sid, alias or title). */
	maxRef: 300,
} as const;

/**
 * Where a reference or a commit points: the block to focus and the page it is on. For a commit,
 * the first page it changed, shown as of the commit (`asOf`).
 */
export interface OutlineResolveResponse {
	spaceId: string;
	spaceKey: string;
	blockId: string;
	pageId: string;
	isPage: boolean;
	/** `key/sid` of the block. */
	address: string;
	title: string;
	deleted: boolean;
	/** Set for a commit: show the page as of this seq. */
	asOf?: number;
}

/** The mind map's direction (design §6.10): rightward (the default) or downward. */
export type OutlineMapLayout = "right" | "down";

/**
 * Limits of `GET/PUT /api/outline/view-state/:pageId`: one person's folding and mind-map
 * direction of one page (design §7.1 `outline_view_state`). Folding is personal and never part
 * of the block model; a page shows at most `maxCollapsed` blocks per view (design §7.2), so more
 * folded ids than that are never needed. `maxCollapsed` bounds the blocks the reader closed and
 * the blocks they opened TOGETHER (`shared/outline-fold.ts`): one budget, not one each.
 */
export const OUTLINE_VIEW_STATE_LIMITS = {
	maxCollapsed: 2000,
	/** Characters of one block id. */
	maxIdChars: 64,
	/**
	 * Pages one person keeps a view state for: writing another drops the least recently written
	 * (one bounded statement per write).
	 */
	maxPagesPerUser: 500,
	/** Bytes of a PUT body. */
	maxBodyBytes: 160 * 1024,
	/** The client waits this long after the last change before writing. */
	writeDebounceMs: 800,
} as const;

/** A block id as servers and clients make them (`generateId`, the live editor's ids). */
export const OUTLINE_BLOCK_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

/** One person's view state of one page; defaults when they never changed it. */
export interface OutlineViewStateResponse {
	pageId: string;
	/** Blocks the reader closed that the page shows open by default. */
	collapsed: string[];
	/** Blocks the reader opened that the page folds by default (`shared/outline-fold.ts`). */
	expanded: string[];
	layout: OutlineMapLayout;
	/** When it was last written; null for the defaults. */
	updatedAt: string | null;
}

export interface OutlineViewStatePutRequest {
	collapsed: string[];
	/** Left out (a client from before the default folding): what is stored is kept. */
	expanded?: string[];
	layout: OutlineMapLayout;
}

// ─────────────────────────────────────────────────────────────────────────────
// Locks and pending confirmation (design §2.2, §2.6)
// ─────────────────────────────────────────────────────────────────────────────

export const OUTLINE_PENDING_API_LIMITS = {
	/** Tasks one "in progress" marker lists. */
	inProgressItems: 10,
	/** Unanswered questions of a page its summary names (the newest). */
	openQuestions: 200,
	/** Characters of a rejection's reason. */
	maxReasonChars: 500,
} as const;

export type OutlinePendingStatus = "open" | "confirmed" | "rejected" | "withdrawn";

/** A change waiting for confirmation (or decided), as a page lists it. */
export interface OutlinePendingSummary {
	id: string;
	/** `P` and the id: how people and agents name it. */
	label: string;
	status: OutlinePendingStatus;
	/** The locked task whose plan it changes. */
	rootBlockId: string | null;
	pageId: string;
	summary: string;
	createdAt: string;
	updatedAt: string;
	/** The session that proposed it. */
	proposer: { narratorId: string | null; title: string | null };
	/** Who decides it: the locker, or the session they named. */
	decider: {
		by: { kind: OutlineActorKind; id: string; name: string | null };
		delegate: { narratorId: string; title: string | null } | null;
	};
	/** Existing blocks it targets (rewrites, moves, deletes, changes the task of): they wait. */
	blockIds: string[];
	/**
	 * Existing blocks it adds blocks under (a proposed new step's parent): marked like the
	 * targets, but they do not wait.
	 */
	addedUnder: string[];
	/** Operations it holds. */
	ops: number;
	/** A block it touches changed since it was proposed: confirming merges, or may fail. */
	changedSince: boolean;
	/** Whether the caller decides it (they locked the plan). */
	canDecide: boolean;
}

/** `GET /spaces/:spaceId/pages/:pageId/pending`: what waits for confirmation on a page. */
export interface OutlinePagePendingResponse {
	pending: OutlinePendingSummary[];
	/** Locked tasks of the page. */
	locks: OutlineLockView[];
	/**
	 * Blocks of the page that are questions put to a person and not answered yet (the newest
	 * {@link OUTLINE_PENDING_API_LIMITS.openQuestions}): the blocks above them are not folded by
	 * default, and a row the reader folded counts the ones it hides. Absent from an older server.
	 */
	questions?: string[];
}

/** Limits of `GET /spaces/:spaceId/report-authors`: who wrote the subagent reports of a page. */
export const OUTLINE_REPORT_AUTHORS_API_LIMITS = {
	/** Report containers one request names. */
	maxIds: 20,
} as const;

/** The subagent's session title by report container, for those the reader may be told. */
export interface OutlineReportAuthorsResponse {
	authors: Record<string, string>;
}

/** One block of a pending change: as proposed against, as proposed, and as it is now. */
export interface OutlinePendingDiffEntry {
	blockId: string;
	sid: string;
	kind: "update" | "insert" | "delete" | "move" | "task" | "restore";
	base: string | null;
	proposed: string | null;
	now: string | null;
	changedSince: boolean;
	/** For a task change: the fields as proposed (null: the checkbox taken away). */
	task?: {
		status?: OutlineTaskStatus;
		assignee?: string | null;
		due?: string | null;
		depends?: string[] | null;
	} | null;
	/** For a move or an insert: the parent's title (null: the top level). */
	parentTitle?: string | null;
	/** For a delete: blocks in or under it others added, changed or moved away since it was proposed. */
	changedUnder?: number;
	/**
	 * For a delete: its subtree could not be checked for changes since it was proposed: too many
	 * blocks (`size`), or too many writers of the proposing session on one block (`writers`).
	 */
	subtreeUnchecked?: "size" | "writers";
}

/** `GET /pending/:id`: a pending change block by block (bounded). */
export interface OutlinePendingDetailResponse {
	pending: OutlinePendingSummary;
	entries: OutlinePendingDiffEntry[];
	/** More blocks than the diff shows. */
	truncated: boolean;
}

/** `POST /pending/:id/confirm` and `/reject`. */
export interface OutlinePendingDecisionResponse {
	pending: OutlinePendingSummary;
	/** The `confirm` commit; null for a rejection, or a confirmation that changed nothing. */
	commit: { id: string; seq: number } | null;
}

/** Why a confirmation failed, beside the error's code (`OUTLINE_PENDING_CONFLICT`). */
export interface OutlinePendingConflictBody {
	code: string;
	message: string;
	details?: string[];
}

/** `POST /spaces/:spaceId/blocks/:blockId/lock`. */
export interface OutlineLockRequest {
	/** The session that may confirm step changes on the locker's behalf (one the caller may write). */
	delegate?: string | null;
}

/** `POST …/lock` and `DELETE …/lock`. */
export interface OutlineLockResponse {
	lock: OutlineLockView | null;
	commit: { id: string; seq: number } | null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Questions and the digest (`Ask` and the inbox, outline P2 PR 7)
// ─────────────────────────────────────────────────────────────────────────────

/** A question put to a person, as the inbox, a page's side panel and the `Ask` card show it. */
export interface OutlineQuestionView {
	blockId: string;
	spaceId: string;
	sid: string;
	/** `key/sid`. */
	address: string;
	/** Its parent: a question, for a sub-question. */
	parentId: string | null;
	/** `Q12`. */
	alias: string | null;
	/** The question (canonical in-block markdown). */
	text: string;
	options: string[];
	/** The asker's recommendation: an option (1-based) or in words, and why. */
	recommend: { option: number | null; text: string | null; reason: string | null };
	/** The asker went ahead with its recommendation (reversible): nothing waits for it. */
	proceed: boolean;
	state: "open" | "answered" | "withdrawn";
	/** The person asked. */
	to: { userId: string | null; name: string | null };
	answer: {
		option: number | null;
		text: string | null;
		/** It is the recommendation. */
		adopted: boolean;
		by: { userId: string; name: string | null };
		at: string;
		/** Written down by the asking session from the conversation. */
		relayed: boolean;
		/** The door the relayed message came through (`gateway:…`, `oauth:…`), when not NarraFork. */
		relayedVia: string | null;
	} | null;
	/**
	 * The asking session. `hidden`: the viewer may not read it, so neither its id nor its title is
	 * given (a placeholder is shown).
	 */
	askedBy: { narratorId: string | null; title: string | null; hidden: boolean };
	createdAt: string | null;
	/** The viewer is the person asked, it is open, and they may write the space. */
	canAnswer: boolean;
	/** The block's version: an answer names it, and is refused when it changed since. */
	versionSeq: number;
}

/** `GET /blocks/:blockId/questions`: the questions under a block (or a question and its items). */
export interface OutlineQuestionGroupResponse {
	group: {
		blockId: string;
		spaceId: string;
		spaceKey: string;
		pageId: string;
		title: string;
		/** The block is itself a question (one asked at the top of a page). */
		isQuestion: boolean;
	};
	questions: OutlineQuestionView[];
	/** More questions than shown. */
	truncated: boolean;
}

/** One answer: a choice, words, both, or the recommendation (`adopt`). */
export interface OutlineAnswerInput {
	blockId: string;
	option?: number;
	text?: string;
	adopt?: boolean;
	/**
	 * The question's version the person read (`OutlineQuestionView.versionSeq`): checked.
	 * Required over HTTP ({@link OutlineAnswerRequest}); the service's own callers may omit it.
	 */
	versionSeq?: number;
}

/** One answer as the API takes it: always with the version read. */
export type OutlineAnswerHttpInput = OutlineAnswerInput & { versionSeq: number };

/** `POST /questions/answer`: questions of one space answered at once. */
export interface OutlineAnswerRequest {
	answers: OutlineAnswerHttpInput[];
}

export interface OutlineAnswerResponse {
	/** The `answer` commit. */
	commitId: string | null;
	answered: string[];
}

/** A confirmation an agent made on the person's behalf, not acknowledged yet (their digest). */
export interface OutlineDigestItem {
	pendingId: string;
	/** `P` and 8 characters. */
	label: string;
	spaceId: string;
	spaceKey: string;
	pageId: string;
	rootBlockId: string | null;
	summary: string;
	opCount: number;
	decidedAt: string | null;
	/**
	 * The session that confirmed it. `hidden`: the viewer may not read it, so neither its id nor
	 * its title is given (a placeholder is shown).
	 */
	decidedBy: { narratorId: string | null; title: string | null; hidden: boolean };
	/** The `confirm` commit: reverting it takes the change back. */
	commitId: string | null;
	/** The viewer may write the space, so may revert it (acknowledging needs no access). */
	canRevert: boolean;
}

/** `GET /digest`. */
export interface OutlineDigestResponse {
	items: OutlineDigestItem[];
	/** More than shown. */
	truncated: boolean;
}

// ─────────────────────────────────────────────────────────────────────────────
// Plans (outline P2 PR 8): a plan is a task tree; ExitPlanMode submits its root, and the person
// decides against the diff from the previous version.
// ─────────────────────────────────────────────────────────────────────────────

/** A task's fields as a plan diff shows them. */
export interface OutlinePlanTaskView {
	status: OutlineTaskStatus;
	assignee: string | null;
	due: string | null;
	depends: string[];
}

/** What changed about one block of a plan. */
export type OutlinePlanChange = "added" | "removed" | "text" | "task" | "moved";

/** One block of a plan's diff against its previous version, in tree order. */
export interface OutlinePlanDiffEntry {
	blockId: string;
	sid: string;
	changes: OutlinePlanChange[];
	/** Depth under the plan root (0: the root), in the tree it is shown from (removed: before). */
	depth: number;
	/** The text before and after (clipped); null when the block was not there. */
	before: string | null;
	after: string | null;
	/** The task fields before and after; null when it was not a task (or not there). */
	taskBefore: OutlinePlanTaskView | null;
	taskAfter: OutlinePlanTaskView | null;
	/** For an added, moved or removed block: its parent's title (where it is, or was). */
	parentTitle?: string | null;
}

/** How many blocks of each kind a plan diff has (each block counted once per change). */
export interface OutlinePlanDiffCounts {
	added: number;
	removed: number;
	text: number;
	task: number;
	moved: number;
}

/** `GET /plans/:blockId/diff`: a plan against the version it is compared with (bounded). */
export interface OutlinePlanDiffResponse {
	root: { blockId: string; spaceId: string; address: string; title: string };
	/** The seq compared from (0: nothing before, everything is new) and the seq shown. */
	fromSeq: number;
	toSeq: number;
	counts: OutlinePlanDiffCounts;
	entries: OutlinePlanDiffEntry[];
	/** More changes than shown, or a plan larger than one diff reads. */
	truncated: boolean;
}

/** One comment of a plan review (outline P2 PR 8b): a child block of the review's block. */
export interface OutlinePlanReviewComment {
	/** The comment's text, without the link to its target. */
	text: string;
	/** The block of the plan it is about, when it names one. */
	target: { address: string; title: string } | null;
}

/**
 * A plan review's comments (outline P2 PR 8b, D48 Q1): one block 「审查意见（第 N 版）」 under the
 * plan root, each comment a child of it. The person decides with them in view; nothing goes back
 * to the planning agent until they decide.
 */
export interface OutlinePlanReview {
	/** The review's block under the plan root, and its address. */
	blockId: string;
	address: string;
	/** The version reviewed. */
	round: number;
	/** How many comments it holds (as written). */
	count: number;
	/** The comments as written, at most `OUTLINE_PLAN_LIMITS.reviewComments`. */
	comments: OutlinePlanReviewComment[];
	/**
	 * The seq of the version the review reviewed (the submission's): what the person changed
	 * since then is what the agent is told they changed while deciding.
	 */
	submittedSeq: number;
}

/**
 * What a pending ExitPlanMode of an outline session carries in its input (`_planRoot`,
 * `_planSeq`, `_planBaseSeq`, `_planDiff`, `_planReview`): enough for the approval card to show
 * its summary and fetch the diff.
 */
export interface OutlinePlanSubmission {
	root: {
		blockId: string;
		spaceId: string;
		/** The page the plan is on (what the card subscribes to, to refresh its diff). */
		pageId: string;
		address: string;
		title: string;
		round: number;
	};
	/** The seq of the version submitted. */
	seq: number;
	/** The seq it is compared with. */
	baseSeq: number;
	counts: OutlinePlanDiffCounts;
	truncated: boolean;
	/** What the agent said changed in this version. */
	summary: string | null;
	/** The plan review's comments on this version, when a review left any (PR 8b). */
	review: OutlinePlanReview | null;
}

/** `POST /narrators/permissions/:requestId/plan`: the person's decision on a submitted plan. */
export interface OutlinePlanDecisionRequest {
	/** `return`: back to the agent with feedback; `draft`: execute; `lock`: lock, then execute. */
	action: "return" | "draft" | "lock";
	feedback?: string;
	/** `lock`: the session that may confirm step changes on the person's behalf. */
	delegate?: string | null;
	/** The seq of the diff the person looked at: a change by someone else since is a 409. */
	seenSeq: number;
	/** Reset the context onto the plan before executing. */
	compactAfter?: boolean;
}

export interface OutlinePlanDecisionResponse {
	ok: true;
	/** The commit the decision wrote. */
	commit: { id: string; seq: number } | null;
}
