import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeReadDatabase } from "../server/lib/db-worker/pool";
import { getTestDb } from "./setup";

export function getWorkerTestDb() {
	const root = mkdtempSync(join(tmpdir(), "worker-test-db-"));
	const fixture = getTestDb(join(root, "state.db"));
	fixture.sqlite.exec("PRAGMA journal_mode=WAL; PRAGMA busy_timeout=0;");
	return {
		...fixture,
		async disposeWorkerDb() {
			await closeReadDatabase(fixture.sqlite.filename, { timeoutMs: 5000 });
			fixture.sqlite.close(true);
			rmSync(root, { recursive: true, force: true });
		},
	};
}
