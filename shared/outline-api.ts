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

export type OutlineCommitKind = "edit" | "revert" | "import";

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
	| "props";

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

export interface OutlineViewBlock {
	id: string;
	sid: string;
	parentId: string | null;
	/** Canonical in-block markdown. */
	content: string;
	task: OutlineTaskView | null;
	alias: string | null;
	tags: string[];
	/** Children shown in this view, in sibling order. */
	childIds: string[];
	/** Blocks of the view under this block that did not fit the budget. */
	hidden: number;
	/** Blocks the facts view leaves out under this block (tasks and what is under them). */
	processHidden: number;
	/** Tasks directly under this block that are neither done nor cancelled. */
	openTasks: number;
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
 * folded ids than that are never needed.
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
	collapsed: string[];
	layout: OutlineMapLayout;
	/** When it was last written; null for the defaults. */
	updatedAt: string | null;
}

export interface OutlineViewStatePutRequest {
	collapsed: string[];
	layout: OutlineMapLayout;
}
