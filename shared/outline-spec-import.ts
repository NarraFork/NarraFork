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
	/** The reader may start the import (write access to the session). */
	canImport: boolean;
	/**
	 * `idle`: not tried since the server started. `running`. `busy`: the session was busy, or the
	 * import gave way to it; it goes on later. `failed`: the last attempt did not move the session
	 * and another may. `attention`: it will not until someone looks. `imported`.
	 */
	state: "idle" | "running" | "imported" | "failed" | "attention" | "busy";
	/** Why the last attempt did not move the session (English, from the server's log). */
	error: string | null;
	/** The same, for the panel to say in the reader's language. */
	reason: OutlineSpecImportReason | null;
	/** When that state was recorded (ISO time). */
	at: string | null;
}
