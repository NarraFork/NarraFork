import { type ReadBackendSelection, selectReadBackend } from "../../db/backend/read-selector";
import { PostgresProjectReadAdapter } from "./postgres-project-read-adapter";
import type { ProjectReadAdapter } from "./project-read-adapter";
import { SqliteProjectReadAdapter } from "./sqlite-project-read-adapter";

let injected: ProjectReadAdapter | undefined;

export function setProjectReadAdapter(adapter: ProjectReadAdapter | undefined): void {
	injected = adapter;
}

export function projectReadAdapter(): ProjectReadAdapter {
	if (injected) return injected;
	const selection = selectReadBackend(process.env.NF_READ_BACKEND);
	if (selection.backend !== "sqlite") {
		throw new Error("PostgreSQL read backend requires an explicitly injected adapter");
	}
	return new SqliteProjectReadAdapter();
}

/**
 * The backend actually serving project reads right now — not the configured intent.
 *
 * In production PostgreSQL mode the master switch owns backend selection and the
 * legacy `NF_READ_BACKEND` selector must be absent (`postgres-runtime` throws if it
 * is set), so asking the selector there always answers "sqlite" even while the
 * injected adapter serves every read from PostgreSQL. Callers that gate
 * backend-specific behavior — the graph route's SQLite commit refresh — must ask
 * here instead. With no injected adapter the answer is exactly the selector's, so
 * the SQLite path is byte-for-byte unchanged.
 *
 * Read-only metadata: this never opens a connection and never changes what any
 * adapter queries or returns.
 */
export function projectReadBackend(): ReadBackendSelection {
	if (injected) {
		// The composition seam injects only the PostgreSQL adapter; anything else
		// (test doubles) keeps the historical SQLite behavior.
		return injected instanceof PostgresProjectReadAdapter
			? { backend: "postgres", readOnly: true }
			: { backend: "sqlite", readOnly: true };
	}
	return selectReadBackend(process.env.NF_READ_BACKEND);
}
