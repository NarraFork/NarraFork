import { afterAll, expect, spyOn, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import * as fsPromises from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db, sqlite } from "../../db";
import { logger } from "../../lib/logger";
import { directoryKey, ensureProjectRootKeys, scheduleProjectIndexRebuild } from "../project-index";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "nf-project-index-scale-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Uses the preload's isolated SQLite database, never the user's application HOME.
// Optional same-machine A/B: point NF_PROJECT_INDEX_BASELINE_MODULE at a temporary
// copy of the pre-change production module beside project-index.ts.
test("12,227 unchanged sessions sharing a cwd resolve it once without row transactions", async () => {
	const count = 12_227;
	const now = new Date().toISOString();
	const key = await directoryKey(dir);
	sqlite
		.query(
			"insert into projects (id, name, git_path, root_key, created_at, updated_at) values (?, ?, ?, ?, ?, ?)",
		)
		.run("scale-project", "scale-project", dir, key, now, now);
	const narrator = sqlite.query(
		"insert into narrators (id, cwd, created_at, updated_at) values (?, ?, ?, ?)",
	);
	const link = sqlite.query(
		"insert into narrator_project_links (narrator_id, project_id, role, source, directory, updated_at) values (?, ?, 'primary', 'cwd', ?, ?)",
	);
	sqlite.transaction(() => {
		for (let index = 0; index < count; index++) {
			const id = `scale-${String(index).padStart(5, "0")}`;
			narrator.run(id, dir, now, now);
			link.run(id, "scale-project", key, now);
		}
	})();
	await ensureProjectRootKeys();

	const baselinePath = process.env.NF_PROJECT_INDEX_BASELINE_MODULE;
	if (baselinePath) {
		const baseline = await import(baselinePath);
		await baseline.ensureProjectRootKeys();
		const realpaths = spyOn(fsPromises, "realpath");
		const transactions = spyOn(db, "transaction");
		const started = performance.now();
		try {
			await baseline.scheduleProjectIndexRebuild();
			const resolutions = realpaths.mock.calls.filter(([path]) => path === dir).length;
			console.info("Project index scale baseline", {
				count,
				ms: performance.now() - started,
				directoryResolutions: resolutions,
				transactions: transactions.mock.calls.length,
			});
			expect(resolutions).toBe(count);
			expect(transactions.mock.calls.length).toBe(count);
		} finally {
			realpaths.mockRestore();
			transactions.mockRestore();
		}
	}

	const realpaths = spyOn(fsPromises, "realpath");
	const transactions = spyOn(db, "transaction");
	const logs = spyOn(logger, "info");
	let heartbeats = 0;
	const timer = setInterval(() => heartbeats++, 1);
	const started = performance.now();
	try {
		await scheduleProjectIndexRebuild();
		expect(realpaths.mock.calls.filter(([path]) => path === dir)).toHaveLength(1);
		expect(transactions).not.toHaveBeenCalled();
		expect(heartbeats).toBeGreaterThan(1);
		const metrics = logs.mock.calls.find(([message]) => message === "Project index rebuilt")?.[1];
		expect(metrics).toMatchObject({
			scanned: count,
			changed: 0,
			skipped: count,
			failed: 0,
			directoryResolutions: 1,
			gitProbes: 0,
		});
		console.info("Project index scale optimized", {
			count,
			ms: performance.now() - started,
			directoryResolutions: 1,
			transactions: 0,
			heartbeats,
		});
	} finally {
		clearInterval(timer);
		realpaths.mockRestore();
		transactions.mockRestore();
		logs.mockRestore();
	}
}, 60_000);
