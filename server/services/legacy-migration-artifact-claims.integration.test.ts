import { afterEach, expect, test } from "bun:test";
import { existsSync, lstatSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db";
import {
	legacyMigrationArtifactClaims as claims,
	legacyProjectMigrations,
	legacyRetainedChapterMetadata,
	narrators,
	users,
} from "../db/schema";
import { generateId } from "../lib/id";
import { getNarraforkPath } from "../lib/narrafork-home";
import {
	advanceLegacyArtifactSnapshotPointer,
	getAuthorizedLegacyArtifactDescriptor,
	hasLegacyMigrationArtifactClaim,
} from "./legacy-migration-artifact-claims";
import { cleanupOrphanedIgnoredArchives } from "./storage-service";
import { treeSnapshotKey, treeSnapshotPhysicalDir } from "./tree-snapshot-paths";
import { inspect as inspectLifecycleProtection } from "./worktree-lifecycle-guard";
import { worktreeTreeSnapshot } from "./worktree-tree-snapshot";

const paths: string[] = [];
afterEach(() => {
	for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true });
});
async function fixture(kind: "shadow" | "ignored_archive" = "shadow") {
	const id = generateId();
	const ownerId = generateId();
	const narratorId = generateId();
	const workspacePath = getNarraforkPath("artifact-test-workspaces", id);
	const artifactPath =
		kind === "shadow"
			? treeSnapshotPhysicalDir("local", workspacePath)
			: getNarraforkPath("dormant-ignored", id);
	mkdirSync(workspacePath, { recursive: true });
	mkdirSync(artifactPath, { recursive: true });
	paths.push(workspacePath, artifactPath);
	writeFileSync(join(artifactPath, "precious"), "original bytes");
	const stat = lstatSync(artifactPath);
	const now = new Date().toISOString();
	await db
		.insert(users)
		.values({ id: ownerId, username: ownerId, passwordHash: "fixture", createdAt: now });
	await db.insert(narrators).values({
		id: narratorId,
		ownerUserId: ownerId,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(legacyProjectMigrations).values({
		projectId: id,
		projectName: "retired",
		actorUserId: ownerId,
		phase: "completed",
		revision: "fixture",
		narratorIds: [narratorId],
		chapterTargets: {},
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(legacyRetainedChapterMetadata).values({
		sourceChapterId: id,
		migrationProjectId: id,
		metadataJson: { snapshotCommitSha: "original-pointer" },
		manifestDigest: "fixture",
		createdAt: now,
	});
	await db.insert(claims).values({
		id,
		migrationProjectId: id,
		sourceChapterId: id,
		narratorId,
		ownerUserId: ownerId,
		kind,
		deviceId: "local",
		workspacePath,
		artifactPath,
		shadowKey: kind === "shadow" ? treeSnapshotKey("local", workspacePath) : null,
		identityJson: { dev: String(stat.dev), ino: String(stat.ino) },
		manifestDigest: "fixture",
		state: "claimed",
		createdAt: now,
	});
	return { id, ownerId, narratorId, workspacePath, artifactPath };
}
test("persisted claim protects forced shadow destroy, missing HEAD repair and owner-deleted lifecycle", async () => {
	const f = await fixture();
	expect(await worktreeTreeSnapshot.destroy(f.workspacePath, "local", { force: true })).toBe(false);
	await worktreeTreeSnapshot.gcAll();
	expect(existsSync(join(f.artifactPath, "HEAD"))).toBe(false);
	expect(readFileSync(join(f.artifactPath, "precious"), "utf8")).toBe("original bytes");
	await db.delete(narrators).where(eq(narrators.id, f.narratorId));
	await db.delete(users).where(eq(users.id, f.ownerId));
	expect(await hasLegacyMigrationArtifactClaim({ sourceChapterId: f.id })).toBe(true);
	expect(
		(await inspectLifecycleProtection([{ path: f.workspacePath }], "delete repository")).status,
	).toBe("protected");
});
test("ignored archive sweep retains original directory after chapter retirement and narrator deletion", async () => {
	const f = await fixture("ignored_archive");
	await db.delete(narrators).where(eq(narrators.id, f.narratorId));
	await cleanupOrphanedIgnoredArchives();
	expect(readFileSync(join(f.artifactPath, "precious"), "utf8")).toBe("original bytes");
});
test("live snapshot pointer moves without rewriting retained original chapter metadata", async () => {
	const f = await fixture();
	const next = "a".repeat(40);
	await advanceLegacyArtifactSnapshotPointer("local", f.workspacePath, next);
	const [claim] = await db
		.select({ latest: claims.latestSnapshotCommitSha })
		.from(claims)
		.where(eq(claims.id, f.id));
	const [archive] = await db
		.select({ metadata: legacyRetainedChapterMetadata.metadataJson })
		.from(legacyRetainedChapterMetadata)
		.where(eq(legacyRetainedChapterMetadata.sourceChapterId, f.id));
	expect(claim?.latest).toBe(next);
	expect(archive?.metadata).toEqual({ snapshotCommitSha: "original-pointer" });
});
test("artifact descriptor uses current narrator ACL, then owner/admin fallback only after narrator deletion", async () => {
	const f = await fixture();
	const owner = { userId: f.ownerId, isAdmin: false };
	expect((await getAuthorizedLegacyArtifactDescriptor(f.id, owner))?.id).toBe(f.id);
	await expect(
		getAuthorizedLegacyArtifactDescriptor(f.id, { userId: "outsider", isAdmin: false }),
	).rejects.toThrow();
	await db.update(narrators).set({ ownerUserId: null }).where(eq(narrators.id, f.narratorId));
	await expect(getAuthorizedLegacyArtifactDescriptor(f.id, owner)).rejects.toThrow();
	await db.delete(narrators).where(eq(narrators.id, f.narratorId));
	expect((await getAuthorizedLegacyArtifactDescriptor(f.id, owner))?.id).toBe(f.id);
	expect(
		await getAuthorizedLegacyArtifactDescriptor(f.id, { userId: "outsider", isAdmin: false }),
	).toBeNull();
	await db.delete(users).where(eq(users.id, f.ownerId));
	expect(await getAuthorizedLegacyArtifactDescriptor(f.id, owner)).toBeNull();
	expect(
		(await getAuthorizedLegacyArtifactDescriptor(f.id, { userId: "admin", isAdmin: true }))?.id,
	).toBe(f.id);
});
