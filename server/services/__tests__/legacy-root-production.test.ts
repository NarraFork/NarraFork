import { afterEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, renameSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { chapters, legacyProjectMigrations, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { legacyProjectMigrationService } from "../legacy-project-migration";
import { assertWorkspaceHistoryRevertSupported } from "../workspace-context-service";

const fixtures: {
	folder: string;
	userId: string;
	projectId: string;
	chapterId: string;
	narratorId: string;
}[] = [];
afterEach(async () => {
	for (const f of fixtures.splice(0)) {
		await db.delete(narrators).where(eq(narrators.id, f.narratorId));
		await db.delete(chapters).where(eq(chapters.id, f.chapterId));
		await db.delete(projects).where(eq(projects.id, f.projectId));
		await db
			.delete(legacyProjectMigrations)
			.where(eq(legacyProjectMigrations.projectId, f.projectId));
		await db.delete(users).where(eq(users.id, f.userId));
		rmSync(f.folder, { recursive: true, force: true });
	}
});
async function fixture() {
	const folder = mkdtempSync(join(tmpdir(), "nf-root-production-"));
	const root = join(folder, "repo");
	execFileSync("git", ["init", "--quiet", "--initial-branch=feature", root], {
		timeout: 10000,
		maxBuffer: 32768,
	});
	const userId = generateId(),
		projectId = generateId(),
		chapterId = generateId(),
		narratorId = generateId();
	const now = new Date().toISOString();
	fixtures.push({ folder, userId, projectId, chapterId, narratorId });
	await db
		.insert(users)
		.values({ id: userId, username: userId, passwordHash: "x", createdAt: now });
	await db.insert(projects).values({
		id: projectId,
		name: "Root",
		ownerUserId: userId,
		gitPath: root,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "Root",
		role: "trunk",
		branch: "feature",
		baseBranch: "feature",
		isRoot: 1,
		worktreePath: root,
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		ownerUserId: userId,
		visibility: "private",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	});
	return {
		folder,
		root,
		userId,
		projectId,
		chapterId,
		narratorId,
		actor: { userId, isAdmin: false },
	};
}

test("production adapter converts a root and permits ordinary rollback without bypassing later workspace switches", async () => {
	const f = await fixture();
	const preview = await legacyProjectMigrationService.preview(f.projectId, f.actor);
	expect(preview.blockers).toEqual([]);
	expect(
		(await legacyProjectMigrationService.migrate(f.projectId, f.actor, preview.revision)).phase,
	).toBe("completed");
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, f.narratorId) });
	expect(row?.cwd).toBe(f.root);
	expect(row?.workspaceContext?.revision).toBe(row?.workspaceRevision);
	expect(row?.chapterId).toBeNull();
	await assertWorkspaceHistoryRevertSupported(f.narratorId);
	await db
		.update(narrators)
		.set({
			workspaceRevision: 2,
			workspaceContext: row?.workspaceContext ? { ...row.workspaceContext, revision: 2 } : null,
		})
		.where(eq(narrators.id, f.narratorId));
	await expect(assertWorkspaceHistoryRevertSupported(f.narratorId)).rejects.toThrow("unsupported");
});
test("a directory replaced at the same pathname cannot reuse a retirement rollback bridge", async () => {
	const f = await fixture();
	const preview = await legacyProjectMigrationService.preview(f.projectId, f.actor);
	expect(
		(await legacyProjectMigrationService.migrate(f.projectId, f.actor, preview.revision)).phase,
	).toBe("completed");
	const original = lstatSync(f.root).ino;
	renameSync(f.root, join(f.folder, "original"));
	mkdirSync(f.root);
	expect(lstatSync(f.root).ino).not.toBe(original);
	await expect(assertWorkspaceHistoryRevertSupported(f.narratorId)).rejects.toThrow("unsupported");
});

test("replacement of Git metadata at an unchanged checkout inode invalidates rollback compatibility", async () => {
	const f = await fixture();
	const preview = await legacyProjectMigrationService.preview(f.projectId, f.actor);
	expect(
		(await legacyProjectMigrationService.migrate(f.projectId, f.actor, preview.revision)).phase,
	).toBe("completed");
	const originalRoot = lstatSync(f.root).ino;
	renameSync(join(f.root, ".git"), join(f.folder, "original-git"));
	execFileSync("git", ["init", "--quiet", f.root], { timeout: 10000, maxBuffer: 32768 });
	expect(lstatSync(f.root).ino).toBe(originalRoot);
	await expect(assertWorkspaceHistoryRevertSupported(f.narratorId)).rejects.toThrow("unsupported");
});
