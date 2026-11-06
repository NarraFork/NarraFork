/**
 * The outline's reports (汇报, P2 PR 11; design §3.4): what is stored per report and what the
 * report API returns.
 *
 * A report is one person's day (in their time zone), made by a background job from commits and
 * versions, never from block text or commit summaries (principle 6). What is stored is ids, seqs,
 * kinds and counts; titles are read when the report is shown, and today's read access decides
 * which items are shown (D4). Every item names where it points back to (`OutlineDigestLink`).
 */

/** The sections, in the order a report shows them. */
export const OUTLINE_DIGEST_SECTIONS = [
	"delegated",
	"knowledge",
	"tasks",
	"plans",
	"questions",
	"other",
] as const;
export type OutlineDigestSection = (typeof OUTLINE_DIGEST_SECTIONS)[number];

/** `daily`: a whole day; `today`: today so far, a preview the day's report replaces. */
export type OutlineDigestKind = "daily" | "today";

/** Who did something: a person (user id), a session (narrator id) or the system (actor name). */
export interface OutlineDigestActor {
	kind: "human" | "agent" | "system";
	id: string;
}

/** Items per section, as stored (`counts_json`): what lists and the inbox read. */
export interface OutlineDigestCounts {
	delegated: number;
	knowledge: number;
	tasks: number;
	plans: number;
	questions: number;
	other: number;
	/** Spaces with changes in the report. */
	spaces: number;
	/** Facts the person wrote themselves: counted, not listed. */
	ownEdits: number;
}

/** Per space, the seqs `(from, to]` a report's window covered. */
export type OutlineDigestRanges = Record<string, [number, number]>;

// ─────────────────────────────────────────────────────────────────────────────
// Stored items (`items_json`)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * A decision made in the person's name that they did not make themselves (Q5): a confirmation a
 * session made on their behalf (P2 PR 7), a plan the plan review approved as a draft for them
 * (D48 ⑦), or their answer a session wrote down from the conversation (D45). Undone by reverting
 * its commit.
 */
export type OutlineDelegatedKind = "confirmation" | "plan_review_approval" | "relayed_answer";

interface StoredBase {
	/** The space id. */
	space: string;
	/** The commit the item comes from (the last one, for a block changed several times). */
	commitId: string;
	seq: number;
	/** The commit's time. */
	at: string;
}

export interface OutlineDigestDelegatedStored extends StoredBase {
	kind: OutlineDelegatedKind;
	/** The locked plan's root, the plan root, the (first) question answered. */
	blockId: string | null;
	pageId: string | null;
	/** The session that made the decision. */
	narratorId: string | null;
	/** A confirmation's pending change. */
	pendingId?: string;
	/** A plan's version (round). */
	round?: number;
	/** A relayed answer: questions the commit answered. */
	questions?: number;
}

/** New or rewritten facts of one page. */
export interface OutlineDigestKnowledgeStored extends StoredBase {
	pageId: string;
	created: number;
	changed: number;
	/** At most three of the topmost blocks changed (the prototype's rule). */
	blocks: Array<{ id: string; seq: number; created: boolean }>;
}

export type OutlineDigestTaskEvent = "done" | "cancelled" | "reopened" | "assigned";

export interface OutlineDigestTaskStored extends StoredBase {
	event: OutlineDigestTaskEvent;
	blockId: string;
	pageId: string;
	/** Who wrote the change (the commit's actor). */
	by: OutlineDigestActor;
	/** Who was doing it: the claim's holder, or its last one. */
	executor: OutlineDigestActor | null;
	manager: OutlineDigestActor | null;
	/** Created by a person (`/goal`, the interface). */
	goal: boolean;
	/**
	 * It is the person's: they manage it, or (`assigned`) it was handed to them. A `done` task of
	 * theirs that an agent finished is what the report shows as newly done for them.
	 */
	forYou: boolean;
}

export type OutlineDigestPlanEvent = "planning" | "returned" | "approved_draft" | "approved_locked";

export interface OutlineDigestPlanStored extends StoredBase {
	event: OutlineDigestPlanEvent;
	blockId: string;
	pageId: string;
	round: number;
	/** The session planning it. */
	narratorId: string | null;
	approvedBy: OutlineDigestActor | null;
}

export type OutlineDigestQuestionEvent = "asked" | "answered" | "withdrawn";

export interface OutlineDigestQuestionStored extends StoredBase {
	event: OutlineDigestQuestionEvent;
	blockId: string;
	pageId: string;
	/** The person asked. */
	to: string | null;
	/** Who answered (`answered`). */
	by: OutlineDigestActor | null;
	/** The answer took the asker's recommendation. */
	adopted: boolean;
	/** A session wrote the answer down from the conversation. */
	relayed: boolean;
	/** The asked person is the report's reader. */
	toYou: boolean;
}

/**
 * Commits that are neither of the above: reverts (listed one by one), imports, confirmations by
 * people, a task handed to a subagent (`delegation`) and the subagent's report under it
 * (`report`, outline P2 PR 9), and commits of other system actors the report does not know.
 */
export type OutlineDigestOtherEvent =
	| "revert"
	| "import"
	| "confirm"
	| "delegation"
	| "report"
	| "system";

export interface OutlineDigestOtherStored extends StoredBase {
	event: OutlineDigestOtherEvent;
	actor: OutlineDigestActor;
	/** Blocks the commit wrote a version of (at most what the read covered). */
	blocks: number;
	/** The task a delegation handed over, or a report was written under. */
	blockId?: string | null;
	pageId?: string | null;
}

/** A space of a report: its range and what is counted but not listed. */
export interface OutlineDigestSpaceStored {
	id: string;
	kind: "project" | "personal" | "session";
	from: number;
	to: number;
	commits: number;
	/** The day had more commits or versions than one read covers: summarized in part. */
	truncated: boolean;
	/** Facts deleted (counted only). */
	deletedFacts: number;
	ownEdits: number;
	tasksCreated: number;
	tasksStarted: number;
	/** Tasks the lease job gave back (a session stopped renewing). */
	leaseReturned: number;
	/** Plan reviews that left comments (a `plan-review` commit that did not decide the plan). */
	reviewComments: number;
	/** This space's items past the caps, per section (absent: none). */
	more?: Partial<Record<OutlineDigestSection, number>>;
}

export interface OutlineDigestStored {
	v: 1;
	/** Spaces with changes, busiest first (at most 50). */
	spaces: OutlineDigestSpaceStored[];
	/** Spaces with changes past that. */
	moreSpaces: number;
	delegated: OutlineDigestDelegatedStored[];
	knowledge: OutlineDigestKnowledgeStored[];
	tasks: OutlineDigestTaskStored[];
	plans: OutlineDigestPlanStored[];
	questions: OutlineDigestQuestionStored[];
	other: OutlineDigestOtherStored[];
	/** Items past the caps: counted, not listed (the sum of the spaces' `more`). */
	more: Record<OutlineDigestSection, number>;
}

// ─────────────────────────────────────────────────────────────────────────────
// The API (`/api/outline/digests`)
// ─────────────────────────────────────────────────────────────────────────────

/** A report as lists show it: never its items. */
export interface OutlineDigestHead {
	id: string;
	kind: OutlineDigestKind;
	/** The day, `YYYY-MM-DD`, in `timeZone`. */
	periodKey: string;
	timeZone: string;
	periodStart: string;
	periodEnd: string;
	counts: OutlineDigestCounts;
	/** Items in all sections, as made. */
	itemCount: number;
	truncated: boolean;
	createdAt: string;
	seenAt: string | null;
}

/** `GET /digests`: the person's reports, newest day first. */
export interface OutlineDigestListResponse {
	digests: OutlineDigestHead[];
	/** The current "today so far" preview, if one was made. */
	preview: OutlineDigestHead | null;
	/** Pass back as `before` for older days; null on the last page. */
	nextCursor: string | null;
}

/** Where an item points back to. */
export interface OutlineDigestLink {
	spaceId: string;
	spaceKey: string;
	/** The block (focus it: `/outline/<spaceId>/<blockId>`). */
	blockId: string | null;
	pageId: string | null;
	/** `key/sid` of the block. */
	address: string | null;
	/** The commit: `/outline/ref?space=<spaceKey>&commit=<seq>` shows the page as of it. */
	seq: number | null;
	commitId: string | null;
	/** The session, when the reader may read it. */
	narratorId: string | null;
}

interface ViewBase {
	link: OutlineDigestLink;
	/** The block's title now (its first line); null when the item has no block. */
	title: string | null;
	/** The block is deleted now. */
	deleted: boolean;
	at: string;
}

/** A session as the reader may see it: named only when they may read it. */
export interface OutlineDigestSession {
	narratorId: string | null;
	title: string | null;
	hidden: boolean;
}

export interface OutlineDigestDelegatedView extends ViewBase {
	kind: OutlineDelegatedKind;
	session: OutlineDigestSession;
	pendingId: string | null;
	round: number | null;
	questions: number | null;
	/** The decision still stands as it was made (not undone, not superseded). */
	stands: boolean;
	/** It can be undone in one click (`POST /digests/undo`): it stands and the reader may write. */
	canUndo: boolean;
}

export interface OutlineDigestKnowledgeView extends ViewBase {
	created: number;
	changed: number;
	blocks: Array<{ link: OutlineDigestLink; title: string; deleted: boolean; created: boolean }>;
}

export interface OutlineDigestTaskView extends ViewBase {
	event: OutlineDigestTaskEvent;
	by: OutlineDigestActor;
	executor: OutlineDigestActor | null;
	manager: OutlineDigestActor | null;
	goal: boolean;
	forYou: boolean;
	/** `done` by an agent, of a task the reader manages: newly done for them. */
	newlyDoneForYou: boolean;
}

export interface OutlineDigestPlanView extends ViewBase {
	event: OutlineDigestPlanEvent;
	round: number;
	session: OutlineDigestSession;
	approvedBy: OutlineDigestActor | null;
}

export interface OutlineDigestQuestionView extends ViewBase {
	event: OutlineDigestQuestionEvent;
	to: string | null;
	by: OutlineDigestActor | null;
	adopted: boolean;
	relayed: boolean;
	toYou: boolean;
}

export interface OutlineDigestOtherView extends ViewBase {
	event: OutlineDigestOtherEvent;
	actor: OutlineDigestActor;
	blocks: number;
}

export interface OutlineDigestSpaceView {
	id: string;
	key: string;
	kind: "project" | "personal" | "session";
	/** The project's name or the session's title (when the reader may read it); null otherwise. */
	label: string | null;
	from: number;
	to: number;
	commits: number;
	truncated: boolean;
	deletedFacts: number;
	ownEdits: number;
	tasksCreated: number;
	tasksStarted: number;
	leaseReturned: number;
	reviewComments: number;
}

/** `GET /digests/:id`: a report as the reader may see it now. */
export interface OutlineDigestDetailResponse {
	/** Its counts are those of what is shown (items of spaces the reader can no longer read go). */
	digest: OutlineDigestHead;
	spaces: OutlineDigestSpaceView[];
	moreSpaces: number;
	delegated: OutlineDigestDelegatedView[];
	knowledge: OutlineDigestKnowledgeView[];
	tasks: OutlineDigestTaskView[];
	plans: OutlineDigestPlanView[];
	questions: OutlineDigestQuestionView[];
	other: OutlineDigestOtherView[];
	more: Record<OutlineDigestSection, number>;
}

/** `POST /digests/now`: a "today so far" preview is being made (or one was made a moment ago). */
export interface OutlineDigestNowResponse {
	queued: boolean;
	/** The preview there is now (being replaced when `queued`). */
	previewId: string | null;
}

/** `POST /digests/undo`: a decision made in the person's name, taken back by reverting it. */
export interface OutlineDigestUndoResponse {
	kind: OutlineDelegatedKind;
	/** The compensating commit; null when nothing could be put back. */
	commit: { id: string; seq: number } | null;
	/** Blocks changed since, left alone (the revert's skips). */
	skipped: number;
}

/** The person's report settings, as `GET /user-preferences` returns them. */
export interface OutlineDigestSettings {
	/** IANA time zone; null: the server's. */
	outlineDigestTimeZone: string | null;
	/** `HH:MM`; null: 07:00. */
	outlineDigestTime: string | null;
}

/** When a report is made if the person set no time. */
export const OUTLINE_DIGEST_DEFAULT_TIME = "07:00";

/** `HH:MM`, 00:00–23:59. */
export const OUTLINE_DIGEST_TIME_PATTERN = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
