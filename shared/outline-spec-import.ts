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
