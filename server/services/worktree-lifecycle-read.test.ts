import { Database } from "bun:sqlite";
import { expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbWorkerConnections, runReadTask } from "../lib/db-worker/pool";
import { runWorktreeLifecycleRead } from "./worktree-lifecycle-read";

test("retirement provenance retains one snapshot across concurrent chapter and owner changes", async () => {
	const directory = await mkdtemp(join(tmpdir(), "worktree-read-snapshot-"));
	const path = join(directory, "fixture.sqlite");
	const reader = new Database(path);
	const writer = new Database(path);
	try {
		reader.exec(`
			PRAGMA journal_mode = WAL;
			CREATE TABLE chapters (id TEXT, worktree_path TEXT, snapshot_shadow_key TEXT);
			CREATE TABLE narrators (id TEXT, cwd TEXT, workspace_context TEXT, workspace_revision INTEGER, chapter_id TEXT);
			INSERT INTO chapters VALUES ('chapter', '/before', 'local-before');
			INSERT INTO narrators VALUES ('owner', '/before', '{"cwd":"/before"}', 0, 'chapter');
		`);
		const controller = new AbortController();
		let checkpoints = 0;
		const checkpoint = spyOn(controller.signal, "throwIfAborted").mockImplementation(() => {
			if (++checkpoints !== 2) return;
			writer.transaction(() => {
				writer.exec("UPDATE chapters SET worktree_path = '/after'");
				writer.exec("UPDATE narrators SET cwd = '/after', workspace_revision = 1");
			})();
		});
		const task = { kind: "worktree-lifecycle-read-v1" as const, chapterIds: ["chapter"], limit: 2 };
		try {
			const snapshot = runWorktreeLifecycleRead(reader, task, controller.signal);
			expect(snapshot.rows[0].path).toBe("/before");
			expect(snapshot.owners[0].cwd).toBe("/before");
			expect(snapshot.owners[0].revision).toBe(0);
		} finally {
			checkpoint.mockRestore();
		}
		const fresh = await runReadTask<ReturnType<typeof runWorktreeLifecycleRead>>(path, task);
		expect(fresh.rows[0].path).toBe("/after");
		expect(fresh.owners[0].cwd).toBe("/after");
		expect(fresh.owners[0].revision).toBe(1);
	} finally {
		await closeDbWorkerConnections(path);
		writer.close();
		reader.close();
		await rm(directory, { recursive: true, force: true });
	}
});
