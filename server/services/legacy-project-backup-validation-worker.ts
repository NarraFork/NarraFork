import { Database } from "bun:sqlite";
import { parentPort, workerData } from "node:worker_threads";

// Point/bounded metadata reads only. Never integrity_check, checkpoint, rebuild or write.
try {
	const { path, projectId } = workerData as { path: string; projectId: string };
	const database = new Database(path, { readonly: true, create: false });
	try {
		database.exec("PRAGMA busy_timeout=0; PRAGMA query_only=ON");
		const required = [
			"projects",
			"chapters",
			"narrators",
			"narrator_messages",
			"narrator_message_refs",
			"narrator_tool_calls",
		];
		const tables = database
			.query<{ name: string }, string[]>(
				`SELECT name FROM sqlite_master WHERE type='table' AND name IN (${required.map(() => "?")}) LIMIT 6`,
			)
			.all(...required);
		if (tables.length !== required.length)
			throw new Error("Not a recognizable NarraFork project backup");
		const projects = database.query<{ id: string }, []>("SELECT id FROM projects LIMIT 2").all();
		if (projects.length !== 1 || projects[0]?.id !== projectId)
			throw new Error("Backup project identity does not match");
		parentPort?.postMessage({ valid: true });
	} finally {
		database.close();
	}
} catch {
	parentPort?.postMessage({ valid: false });
}
