/**
 * The import of a session's Dynamic Spec into the outline, as the Spec panel reads it (outline P2
 * PR 12b): `GET` / `POST /api/outline/narrators/:narratorId/spec-import`.
 */
export interface OutlineSpecImportStatus {
	/** How imports happen here (`outline.specImport`). `off`: nothing is shown. */
	mode: "auto" | "manual" | "off";
	/** The session is one the import moves: a root session that still keeps Dynamic Spec. */
	importable: boolean;
	/** The reader may start the import (write access to the session). */
	canImport: boolean;
	/**
	 * `idle`: not tried since the server started. `running`. `failed`: the last attempt did not
	 * move the session and another may. `attention`: it will not until someone looks. `imported`.
	 */
	state: "idle" | "running" | "imported" | "failed" | "attention";
	/** Why the last attempt did not move the session (English, from the server's log). */
	error: string | null;
	/** When that state was recorded (ISO time). */
	at: string | null;
}
