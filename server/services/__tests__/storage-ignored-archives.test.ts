/**
 * Sweeping ignored-file archives whose chapter is gone.
 *
 * `~/.narrafork/dormant-ignored/<chapterId>` holds the files git refuses to track —
 * `.env`, local credential files — copied aside so going dormant does not destroy them.
 * A wake consumes the archive, and the chapter's terminal transitions now discard it,
 * but neither reaches a directory whose chapter row vanished before those paths existed.
 * What is left is the user's plaintext secrets under `~/.narrafork` with no owner and no
 * expiry, invisible in every UI.
 *
 * The sweep keys on the chapter row existing at all rather than on its status: a dormant
 * chapter still needs its archive, and any surviving status can still be woken or
 * deleted, so only the row disappearing proves nothing will read it again. That
 * distinction is the thing worth pinning down, since getting it wrong deletes files a
 * live chapter is waiting to have restored.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../db";
import { chapters, projects } from "../../db/schema";
import { generateId } from "../../lib/id";
import { getNarraforkPath } from "../../lib/narrafork-home";
import { cleanupOrphanedIgnoredArchives, scanStorage } from "../storage-service";

const SECRET = "API_TOKEN=super-secret\n";

let projectId: string;
let liveChapterId: string;
let dormantChapterId: string;
let orphanChapterId: string;

function archiveDir(chapterId: string): string {
	return getNarraforkPath("dormant-ignored", chapterId);
}

function seedArchive(chapterId: string): string {
	const dir = archiveDir(chapterId);
	mkdirSync(dir, { recursive: true });
	const file = join(dir, ".env");
	writeFileSync(file, SECRET);
	return file;
}

beforeEach(async () => {
	const now = new Date().toISOString();
	projectId = generateId();
	liveChapterId = generateId();
	dormantChapterId = generateId();
	orphanChapterId = generateId();

	await db.insert(projects).values({
		id: projectId,
		name: "Ignored archive sweep",
		createdAt: now,
		updatedAt: now,
	});
	for (const [id, status] of [
		[liveChapterId, "active"],
		[dormantChapterId, "dormant"],
	] as const) {
		await db.insert(chapters).values({
			id,
			projectId,
			title: `Chapter ${status}`,
			branch: `chapter/${id.slice(0, 8)}`,
			baseBranch: "main",
			status,
			createdAt: now,
			updatedAt: now,
		});
	}
});

afterEach(async () => {
	for (const id of [liveChapterId, dormantChapterId, orphanChapterId]) {
		rmSync(archiveDir(id), { recursive: true, force: true });
	}
	await db
		.delete(chapters)
		.where(inArray(chapters.id, [liveChapterId, dormantChapterId, orphanChapterId]));
	await db.delete(projects).where(eq(projects.id, projectId));
});

describe("cleanupOrphanedIgnoredArchives", () => {
	test("removes an archive with no chapter and leaves the ones still owned", async () => {
		const orphanFile = seedArchive(orphanChapterId);
		const dormantFile = seedArchive(dormantChapterId);
		const liveFile = seedArchive(liveChapterId);

		const result = await cleanupOrphanedIgnoredArchives();

		expect(existsSync(orphanFile)).toBe(false);
		expect(existsSync(archiveDir(orphanChapterId))).toBe(false);
		expect(result.removed).toBeGreaterThanOrEqual(1);
		expect(result.freedBytes).toBeGreaterThan(0);

		// A dormant chapter is exactly the case that must survive: its archive is what a
		// wake restores, so deleting it here would lose the files for good.
		expect(readFileSync(dormantFile, "utf8")).toBe(SECRET);
		expect(readFileSync(liveFile, "utf8")).toBe(SECRET);
	});

	test("is a no-op when every archive still has its chapter", async () => {
		seedArchive(dormantChapterId);
		const before = await cleanupOrphanedIgnoredArchives();
		const dormantOnly = before.removed;

		seedArchive(liveChapterId);
		const result = await cleanupOrphanedIgnoredArchives();

		// Counted against the first run rather than asserted as zero: other suites share
		// this data directory, so only the delta attributable to these fixtures is ours.
		expect(result.removed).toBeLessThanOrEqual(dormantOnly);
		expect(existsSync(archiveDir(dormantChapterId))).toBe(true);
		expect(existsSync(archiveDir(liveChapterId))).toBe(true);
	});

	test("runs again cleanly after the archive is already gone", async () => {
		seedArchive(orphanChapterId);
		await cleanupOrphanedIgnoredArchives();
		// Clean-up is reachable from a UI button and from the worktree sweep, so a second
		// pass over an already-collected directory must not throw.
		await cleanupOrphanedIgnoredArchives();
		expect(existsSync(archiveDir(orphanChapterId))).toBe(false);
	});
});

describe("storage scan", () => {
	test("reports the archives as their own category, counting the orphaned ones", async () => {
		seedArchive(orphanChapterId);
		seedArchive(dormantChapterId);

		// `scanStorage` streams progress and yields the result as the generator's return
		// value, so it has to be driven to completion rather than awaited.
		const scan = scanStorage();
		let next = await scan.next();
		while (!next.done) next = await scan.next();
		const category = next.value.categories.find((c) => c.key === "dormantIgnored");

		// Without a category of its own this directory's bytes were in no total at all,
		// which is how it grew unnoticed.
		expect(category).toBeDefined();
		expect(category?.sizeBytes).toBeGreaterThan(0);
		const details = category?.details as { archiveCount?: number; orphanCount?: number };
		expect(details.archiveCount).toBeGreaterThanOrEqual(2);
		expect(details.orphanCount).toBeGreaterThanOrEqual(1);
	});
});
