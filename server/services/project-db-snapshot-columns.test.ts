/**
 * Snapshot coordinates surviving the project-database round trip.
 *
 * The project database is the portable backup a shared project is re-imported from, and
 * it used to carry `merge_commit_sha` but none of the snapshot columns. That is not a
 * cosmetic omission: a commit-free merge writes nothing to the user's git history, so
 * those columns are the *only* description of what happened. Without them a re-imported
 * chapter reads as "merged, but with no merge commit", which `unmerge` and `wake` both
 * reject — and the merged-away uncommitted work becomes unreachable.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, projects } from "../db/schema";
import { generateId } from "../lib/id";
import { projectDbManager } from "../lib/project-db";
import { fullSync } from "./project-db-sync";
import { importProject } from "./project-import";

const tempDirs: string[] = [];
const createdProjects: string[] = [];

afterEach(async () => {
	for (const projectId of createdProjects.splice(0)) {
		projectDbManager.close(projectId);
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

/** Every snapshot coordinate a chapter can hold, with distinguishable values. */
const COORDINATES = {
	snapshotCommitSha: "a".repeat(40),
	snapshotShadowKey: "local\u0000/tmp/some/worktree",
	dormantSnapshotCommitSha: "b".repeat(40),
	preMergeTargetSha: "c".repeat(40),
	mergeSnapshotCommitSha: "d".repeat(40),
	preMergeTargetSnapshotSha: "e".repeat(40),
	mergedSourceSnapshotSha: "f".repeat(40),
	parkedSnapshotCommitSha: "1".repeat(40),
	parkedSnapshotBaseTree: "2".repeat(40),
} as const;

describe("project database snapshot columns", () => {
	test("imports legacy narrator columns without restoring retired settings", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-pdb-legacy-"));
		tempDirs.push(gitPath);
		const now = new Date().toISOString();
		const projectId = generateId();
		const chapterId = generateId();
		const narratorId = generateId();
		createdProjects.push(projectId);
		await db
			.insert(projects)
			.values({ id: projectId, name: "Legacy backup", gitPath, createdAt: now, updatedAt: now });
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "Legacy",
			branch: "legacy",
			baseBranch: "main",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(narrators).values({
			id: narratorId,
			chapterId,
			title: "Preserved narrator",
			createdAt: now,
			updatedAt: now,
		});
		try {
			await fullSync(projectId);
			const pdb = await projectDbManager.getDb(projectId);
			if (!pdb) throw new Error("expected a project database");
			const existingColumns = new Set(
				(pdb.query("PRAGMA table_info(narrators)").all() as Array<{ name: string }>).map(
					(column) => column.name,
				),
			);
			for (const column of ["prune_enabled", "prune_boundary_message_id", "pruned_percent"]) {
				expect(existingColumns.has(column)).toBe(false);
			}
			const refColumns = (
				pdb.query("PRAGMA table_info(narrator_message_refs)").all() as Array<{ name: string }>
			).map((column) => column.name);
			expect(refColumns).not.toContain("pruned_percent");
			for (const definition of [
				"prune_enabled INTEGER",
				"prune_boundary_message_id TEXT",
				"pruned_percent INTEGER",
			]) {
				if (!existingColumns.has(definition.split(" ")[0])) {
					pdb.run(`ALTER TABLE narrators ADD COLUMN ${definition}`);
				}
			}
			pdb.run(
				"UPDATE narrators SET prune_enabled=1,prune_boundary_message_id='obsolete',pruned_percent=75",
			);
			projectDbManager.close(projectId);
			await db.delete(narrators).where(eq(narrators.id, narratorId));
			await db.delete(chapters).where(eq(chapters.projectId, projectId));
			await db.delete(projects).where(eq(projects.id, projectId));
			const result = await importProject(gitPath);
			expect(result.skipped).toBe(false);
			expect(result.tables.narrators).toBe(1);
			const restored = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
			expect(restored?.title).toBe("Preserved narrator");
			expect(restored).not.toHaveProperty("prunedPercent");
		} finally {
			await db.delete(narrators).where(eq(narrators.id, narratorId));
		}
	});
	test("every snapshot coordinate round-trips through a full sync", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-pdb-"));
		tempDirs.push(gitPath);
		const now = new Date().toISOString();
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: "Snapshot columns project",
			gitPath,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);

		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "merged without a commit",
			branch: "chapter/x",
			baseBranch: "main",
			status: "merged",
			role: "branch",
			// Deliberately null: a snapshot merge leaves it null on purpose, which is exactly
			// the state that used to lose all its context on import.
			mergeCommitSha: null,
			...COORDINATES,
			createdAt: now,
			updatedAt: now,
		});

		await fullSync(projectId);

		const pdb = await projectDbManager.getDb(projectId);
		if (!pdb) throw new Error("expected a project database");
		const row = pdb.prepare("SELECT * FROM chapters WHERE id = ?").get(chapterId) as Record<
			string,
			unknown
		> | null;
		if (!row) throw new Error("expected the chapter to be synced");

		expect(row.snapshot_commit_sha).toBe(COORDINATES.snapshotCommitSha);
		expect(row.snapshot_shadow_key).toBe(COORDINATES.snapshotShadowKey);
		expect(row.dormant_snapshot_commit_sha).toBe(COORDINATES.dormantSnapshotCommitSha);
		expect(row.pre_merge_target_sha).toBe(COORDINATES.preMergeTargetSha);
		expect(row.merge_snapshot_commit_sha).toBe(COORDINATES.mergeSnapshotCommitSha);
		expect(row.pre_merge_target_snapshot_sha).toBe(COORDINATES.preMergeTargetSnapshotSha);
		expect(row.merged_source_snapshot_sha).toBe(COORDINATES.mergedSourceSnapshotSha);
		// The one that was already carried; kept here so a future column reshuffle that
		// misaligns the positional bindings is caught rather than passing silently.
		expect(row.merge_commit_sha).toBeNull();
	});

	test("the parked-work coordinates stay out of the portable backup", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-pdb-parked-"));
		tempDirs.push(gitPath);
		const now = new Date().toISOString();
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: "Parked coordinates project",
			gitPath,
			createdAt: now,
			updatedAt: now,
		});
		createdProjects.push(projectId);

		const chapterId = generateId();
		await db.insert(chapters).values({
			id: chapterId,
			projectId,
			title: "mid-rebase",
			branch: "chapter/parked",
			baseBranch: "main",
			status: "active",
			role: "branch",
			...COORDINATES,
			createdAt: now,
			updatedAt: now,
		});

		await fullSync(projectId);

		const pdb = await projectDbManager.getDb(projectId);
		if (!pdb) throw new Error("expected a project database");
		const columns = (
			pdb.prepare('PRAGMA table_info("chapters")').all() as Array<{ name: string }>
		).map((c) => c.name);

		// Absent from the schema entirely, not merely left null. These name commits in this
		// machine's shadow repository for a rebase still in flight; imported elsewhere the
		// next rebase settles them, resolves nothing, and reports work lost that was never
		// there. The merge coordinates above are the ones that legitimately travel.
		expect(columns).not.toContain("parked_snapshot_commit_sha");
		expect(columns).not.toContain("parked_snapshot_base_tree");
		// And the row still synced, so removing them did not break the positional bindings.
		const row = pdb.prepare("SELECT * FROM chapters WHERE id = ?").get(chapterId) as Record<
			string,
			unknown
		> | null;
		if (!row) throw new Error("expected the chapter to be synced");
		expect(row.merged_source_snapshot_sha).toBe(COORDINATES.mergedSourceSnapshotSha);
		expect(row.snapshot_commit_sha).toBe(COORDINATES.snapshotCommitSha);
	});
});
