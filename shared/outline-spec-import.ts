/**
 * The import of a session's Dynamic Spec into the outline, as the Spec panel reads it (outline P2
 * PR 12b): `GET` / `POST /api/outline/narrators/:narratorId/spec-import`.
 */

/**
 * Why an attempt did not move the session, as the panel says it (`count` fills the sentence):
 * - `too_many_files` / `too_large`: more files (`count`) or characters than one import takes;
 * - `broken_tasks`: `tasks.json` is not a task list (imported as a page);
 * - `task_mismatch`: imported task `count` does not read as its source;
 * - `kept_blocks`: `count` blocks of an earlier attempt hold what someone added or changed;
 * - `fence_too_large`: the behavior fence's own text is over `count` KiB;
 * - `sop_too_large`: the plugin SOP in the fence is larger than its block holds;
 * - `not_started`: `count` tasks in progress could not be started by the session;
 * - `changed`: the session's Dynamic Spec changed during the import;
 * - `moved_elsewhere`: the session was moved by something else meanwhile;
 * - `off`: imports were switched off during it;
 * - `other`: anything else (the server log has it).
 */
export interface OutlineSpecImportReason {
	code:
		| "too_many_files"
		| "too_large"
		| "broken_tasks"
		| "task_mismatch"
		| "kept_blocks"
		| "fence_too_large"
		| "sop_too_large"
		| "not_started"
		| "changed"
		| "moved_elsewhere"
		| "off"
		| "other";
	count?: number;
}

export interface OutlineSpecImportStatus {
	/** How imports happen here (`outline.specImport`). `off`: nothing is shown. */
	mode: "auto" | "manual" | "off";
	/** The session is one the import moves: a root session that still keeps Dynamic Spec. */
	importable: boolean;
	/**
	 * The reader may start the import (write access to the session; for a session an
	 * administrator moved back to Dynamic Spec, administrators only).
	 */
	canImport: boolean;
	/**
	 * `idle`: never tried. `running`. `busy`: the session was busy, or the import gave way to it;
	 * it goes on later. `failed`: the last attempt did not move the session and another may.
	 * `attention`: it will not until someone looks. `imported`. `reverted`: an administrator moved
	 * the session back to Dynamic Spec (outline P2 PR 12b2); only an administrator imports it again.
	 */
	state: "idle" | "running" | "imported" | "failed" | "attention" | "busy" | "reverted";
	/** Why the last attempt did not move the session (English, from the server's log). */
	error: string | null;
	/** The same, for the panel to say in the reader's language. */
	reason: OutlineSpecImportReason | null;
	/** When that state was recorded (ISO time). */
	at: string | null;
	/** Failed attempts since the last success (persisted). */
	attempts: number;
	/**
	 * When an import last moved the session to the outline (null: never; a session created in the
	 * outline has none). The Spec panel then marks the old files read-only and links to
	 * `taskPageId` in `spaceId` (either may be null when nothing was imported).
	 */
	switchedAt: string | null;
	spaceId: string | null;
	taskPageId: string | null;
	/** When an administrator last moved the session back to Dynamic Spec. */
	revertedAt: string | null;
}

/** States the admin page lists (`GET /api/admin/outline/spec-import`). */
export const OUTLINE_SPEC_IMPORT_ADMIN_STATES = [
	"attention",
	"failed",
	"busy",
	"running",
	"imported",
	"reverted",
	"idle",
] as const;

export type OutlineSpecImportAdminState = (typeof OUTLINE_SPEC_IMPORT_ADMIN_STATES)[number];

/** One session on the admin page. */
export interface OutlineSpecImportAdminItem {
	narratorId: string;
	title: string | null;
	ownerName: string | null;
	/** `spec` or `outline` now. */
	taskBackend: string | null;
	state: OutlineSpecImportAdminState;
	trigger: string | null;
	attempts: number;
	reason: OutlineSpecImportReason | null;
	error: string | null;
	switchedAt: string | null;
	switchCount: number;
	revertedAt: string | null;
	revertCount: number;
	updatedAt: string;
	/** An administrator may move it back to Dynamic Spec (it was moved by an import). */
	canRevert: boolean;
	/** An administrator may import it again (a root session still in Dynamic Spec). */
	canReimport: boolean;
}

export interface OutlineSpecImportAdminPage {
	mode: "auto" | "manual" | "off";
	/** Sessions per state, each counted up to `countCap` (a count above it reads as "cap+"). */
	counts: Record<OutlineSpecImportAdminState, number>;
	countCap: number;
	items: OutlineSpecImportAdminItem[];
	/** Pass back as `cursor` for the next page; null at the end. */
	next: string | null;
}

/** What a move back answers (`POST /api/admin/outline/spec-import/:narratorId/revert`). */
export interface OutlineSpecImportRevertResult {
	reverted: true;
	/** The markers were written on the task and behavior pages. */
	marked: boolean;
	/**
	 * The old behavior fence holds the version the import read again (written back, or held
	 * already). False when it should have been written back and was not: the page warns.
	 */
	fenceRestored: boolean;
	/** Tasks the session held in the outline, reopened at once. */
	released: number;
}

// ─────────────────────────────────────────────────────────────────────────────
// Content the old Spec panel may have swallowed (outline P2 PR 12c)
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Where a finding stands: `open` (not on the page: not attached yet, or it could not be),
 * `attached` (on the file's imported page, as a block of its own), `dismissed` (a person said it
 * is nothing; its block is taken away when nobody else wrote in it).
 */
export const OUTLINE_SPEC_LOSS_STATUSES = ["open", "attached", "dismissed"] as const;

export type OutlineSpecLossStatus = (typeof OUTLINE_SPEC_LOSS_STATUSES)[number];

export type OutlineSpecLossAttachNote =
	| "no_page"
	| "page_cap"
	| "session_cap"
	| "restored"
	| "failed";

/** `SpecLossKind` of `shared/spec-content-loss.ts`, restated for the API. */
export type OutlineSpecLossKind =
	| "table"
	| "html"
	| "image"
	| "taskItem"
	| "footnote"
	| "frontMatter";

/**
 * One place where a save from the old Spec panel may have swallowed content: the file, the save,
 * and how many structures of each kind the revision before it held that the save and the current
 * revision do not. The lost text itself is read with the finding's detail only.
 */
export interface OutlineSpecLossFinding {
	id: string;
	narratorId: string;
	/** The session's title (lists of several sessions show it). */
	title: string | null;
	path: string;
	/** When the person saved (ISO time; null when not recorded). */
	savedAt: string | null;
	kinds: Partial<Record<OutlineSpecLossKind, number>>;
	/** The excerpt kept does not hold everything that was lost. */
	truncated: boolean;
	status: OutlineSpecLossStatus;
	/**
	 * The block on the imported page, in the session's space: of an `attached` finding, and of a
	 * `dismissed` one whose block was kept because someone else wrote in it.
	 */
	blockId: string | null;
	/**
	 * Why an `open` finding is not on the page (null: not tried yet):
	 * - `no_page`: the file's imported page is not there;
	 * - `page_cap` / `session_cap`: more findings than are attached to one page, or for one
	 *   session in one pass, automatically (the latter are attached by a later pass);
	 * - `restored`: the file's current revision holds the content again;
	 * - `failed`: the attach did not succeed (tried again by a later pass).
	 */
	attachNote: OutlineSpecLossAttachNote | null;
	spaceId: string | null;
	resolvedAt: string | null;
	createdAt: string;
	/**
	 * An `open` finding of a session whose tasks are in the outline: a person may ask for it to
	 * be put on the file's imported page (it may still be refused: the page was deleted).
	 */
	attachable: boolean;
}

/** The lost text, in pieces of one kind each, as it stood before the save. */
export interface OutlineSpecLossDetail extends OutlineSpecLossFinding {
	parts: Array<{ kind: OutlineSpecLossKind; text: string }>;
}

/** How the scan is doing (administrators). */
export interface OutlineSpecLossScanStatus {
	running: boolean;
	/** The last pass that ended in this process: when, and what it did. */
	lastPass: {
		at: string;
		/** Sessions looked at (unchanged ones are skipped, not counted in `scanned`). */
		sessions: number;
		scanned: number;
		found: number;
		/** Findings put on their imported pages. */
		attached: number;
		/** Sessions left for the next pass. */
		left: number;
	} | null;
}

export interface OutlineSpecLossPage {
	items: OutlineSpecLossFinding[];
	next: string | null;
	/** Findings per status, each counted up to `countCap`. */
	counts: Record<OutlineSpecLossStatus, number>;
	countCap: number;
	/** The reader may attach and dismiss (write access to the session, or an administrator). */
	canAct: boolean;
	/** Administrators' list only. */
	scan?: OutlineSpecLossScanStatus;
}

/**
 * What a person asks about one finding: `dismiss` (open or attached), `reopen` (a dismissed one;
 * it is attached again), `attach` (an open one the automatic attach left out).
 */
export type OutlineSpecLossAction = "attach" | "dismiss" | "reopen";
