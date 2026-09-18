/**
 * Paging across the page boundary, with more rows than one page holds.
 *
 * WHY A SEPARATE FILE
 * -------------------
 * Every other test here uses a handful of rows, so they all fit in one page and would pass
 * identically against an unpaged implementation. The bounded-read claim is therefore untested by
 * them: a cursor that never advances, an off-by-one that drops the last row of each page, or a
 * `nextCursor` that repeats forever are all invisible below the page size.
 *
 * So this file writes more rows than `ARCHIVE_EXPORT_PAGE_SIZE` and checks that the export and
 * the import both see every one of them, exactly once. 501 rows over a 500-row page is the
 * cheapest input that crosses the boundary, and the extra ~1500 rows below make the second page
 * a real page rather than a single trailing row.
 *
 * ISOLATION
 * ---------
 * `tests/preload.ts` isolates the main database. The archive lives under `mkdtemp`. Every row is
 * removed afterwards.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	chapters,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { getProjectDbPath, projectDbManager } from "@server/lib/project-db";
import { fullSync } from "@server/services/project-db-sync";
import { importProject } from "@server/services/project-import";
import { eq } from "drizzle-orm";
import { ARCHIVE_EXPORT_PAGE_SIZE } from "../export-rows";
import { projectArchiveMainStore } from "../store";

/** Comfortably more than one page, so the second page is not a single trailing row. */
const MESSAGE_COUNT = ARCHIVE_EXPORT_PAGE_SIZE * 2 + 137;

const tempDirs: string[] = [];
const createdProjects: string[] = [];
const createdNarrators: string[] = [];

afterEach(async () => {
	for (const narratorId of createdNarrators.splice(0)) {
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.narratorId, narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, narratorId));
		await db.delete(narrators).where(eq(narrators.id, narratorId));
	}
	for (const projectId of createdProjects.splice(0)) {
		projectDbManager.close(projectId);
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface BigFixture {
	gitPath: string;
	projectId: string;
	chapterId: string;
	narratorId: string;
	messageIds: string[];
}

async function createBigFixture(): Promise<BigFixture> {
	const gitPath = mkdtempSync(join(tmpdir(), "nf-arc-paging-"));
	tempDirs.push(gitPath);
	const now = new Date().toISOString();
	const projectId = generateId();
	const chapterId = generateId();
	const narratorId = generateId();
	createdProjects.push(projectId);
	createdNarrators.push(narratorId);

	await db
		.insert(projects)
		.values({ id: projectId, name: "Paging", gitPath, createdAt: now, updatedAt: now });
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "long conversation",
		branch: "chapter/paging",
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
	await db.insert(narrators).values({
		id: narratorId,
		chapterId,
		title: "Chatty narrator",
		createdAt: now,
		updatedAt: now,
	});

	const messageIds = Array.from({ length: MESSAGE_COUNT }, () => generateId());
	// Inserted in chunks: a single multi-thousand-row insert is exactly the unbounded shape this
	// port exists to avoid, and the fixture should not model what the code refuses to do.
	const CHUNK = 200;
	for (let i = 0; i < messageIds.length; i += CHUNK) {
		const slice = messageIds.slice(i, i + CHUNK);
		await db.insert(narratorMessages).values(
			slice.map((id, offset) => ({
				id,
				narratorId,
				role: "assistant" as const,
				contentJson: [{ type: "text", text: `message ${i + offset}` }],
				createdAt: now,
			})),
		);
		await db.insert(narratorMessageRefs).values(
			slice.map((id, offset) => ({
				id: generateId(),
				narratorId,
				messageId: id,
				// seq starts at 0, which a truthiness-based filter would drop.
				seq: i + offset,
				isCompact: 0,
			})),
		);
	}

	return { gitPath, projectId, chapterId, narratorId, messageIds };
}

describe("the store pages rather than reading a table whole", () => {
	test("walking the cursor visits every row exactly once", async () => {
		const fixture = await createBigFixture();

		const seen: string[] = [];
		let after: string | null = null;
		let pages = 0;
		for (;;) {
			const page = await projectArchiveMainStore.readRows({
				table: "narrator_messages",
				filter: { column: "narrator_id", values: [fixture.narratorId] },
				limit: ARCHIVE_EXPORT_PAGE_SIZE,
				after,
			});
			pages += 1;
			for (const row of page.rows) seen.push(String(row.id));
			// No page may exceed the requested limit — that is the bound the whole design rests on.
			expect(page.rows.length).toBeLessThanOrEqual(ARCHIVE_EXPORT_PAGE_SIZE);
			if (page.nextCursor === null) break;
			// A cursor that fails to advance is an infinite loop, so it is checked rather than
			// trusted.
			expect(page.nextCursor).not.toBe(after);
			after = page.nextCursor;
			expect(pages).toBeLessThan(50);
		}

		// More than one page actually happened, or this test would prove nothing.
		expect(pages).toBeGreaterThan(1);
		expect(seen).toHaveLength(MESSAGE_COUNT);
		// Exactly once each: an off-by-one on the cursor duplicates or skips a boundary row.
		expect(new Set(seen).size).toBe(MESSAGE_COUNT);
		expect(new Set(seen)).toEqual(new Set(fixture.messageIds));
	});

	test("pages are ordered by primary key, so the cursor is monotonic", async () => {
		const fixture = await createBigFixture();
		const collected: string[] = [];
		let after: string | null = null;
		for (let page = 0; page < 50; page += 1) {
			const result = await projectArchiveMainStore.readRows({
				table: "narrator_messages",
				filter: { column: "narrator_id", values: [fixture.narratorId] },
				limit: ARCHIVE_EXPORT_PAGE_SIZE,
				after,
			});
			for (const row of result.rows) collected.push(String(row.id));
			if (result.nextCursor === null) break;
			after = result.nextCursor;
		}
		// Ascending overall, not merely within each page: paging by an unordered key silently
		// skips and repeats rows as the table changes.
		const sorted = [...collected].sort();
		expect(collected).toEqual(sorted);
	});
});

describe("a multi-page export and import keeps every row", () => {
	test("the archive receives all rows, and the import restores all of them", async () => {
		const fixture = await createBigFixture();
		const result = await fullSync(fixture.projectId);
		expect(result.tables.narrators).toBe(1);

		const archive = new Database(getProjectDbPath(fixture.gitPath), { readonly: true });
		try {
			const messageCount = (
				archive
					.prepare("SELECT COUNT(*) AS c FROM narrator_messages WHERE narrator_id = ?")
					.get(fixture.narratorId) as { c: number }
			).c;
			// Every row across every page — an export that stopped at the first page would report
			// 500 here and look plausible.
			expect(messageCount).toBe(MESSAGE_COUNT);

			const refCount = (
				archive
					.prepare("SELECT COUNT(*) AS c FROM narrator_message_refs WHERE narrator_id = ?")
					.get(fixture.narratorId) as { c: number }
			).c;
			expect(refCount).toBe(MESSAGE_COUNT);

			// seq 0 and the last seq both present: the two positions a paging bug lands on.
			const seqs = archive
				.prepare(
					"SELECT MIN(seq) AS lo, MAX(seq) AS hi FROM narrator_message_refs WHERE narrator_id = ?",
				)
				.get(fixture.narratorId) as { lo: number; hi: number };
			expect(seqs.lo).toBe(0);
			expect(seqs.hi).toBe(MESSAGE_COUNT - 1);
		} finally {
			archive.close();
		}

		// Forget the project, then restore it from the file alone.
		projectDbManager.close(fixture.projectId);
		await db
			.delete(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, fixture.narratorId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, fixture.narratorId));
		await db.delete(narrators).where(eq(narrators.id, fixture.narratorId));
		await db.delete(chapters).where(eq(chapters.projectId, fixture.projectId));
		await db.delete(projects).where(eq(projects.id, fixture.projectId));

		const imported = await importProject(fixture.gitPath);
		expect(imported.skipped).toBe(false);
		expect(imported.tables.narrator_messages).toBe(MESSAGE_COUNT);
		expect(imported.tables.narrator_message_refs).toBe(MESSAGE_COUNT);

		const restoredRefs = await db
			.select({ seq: narratorMessageRefs.seq })
			.from(narratorMessageRefs)
			.where(eq(narratorMessageRefs.narratorId, fixture.narratorId));
		expect(restoredRefs).toHaveLength(MESSAGE_COUNT);
		const restoredSeqs = restoredRefs.map((r) => r.seq).sort((a, b) => a - b);
		expect(restoredSeqs[0]).toBe(0);
		expect(restoredSeqs.at(-1)).toBe(MESSAGE_COUNT - 1);
		// No gaps: the whole ordered conversation, not a subset that happens to include the ends.
		expect(new Set(restoredSeqs).size).toBe(MESSAGE_COUNT);
	});

	test("a second full sync is idempotent rather than duplicating rows", async () => {
		const fixture = await createBigFixture();
		await fullSync(fixture.projectId);
		await fullSync(fixture.projectId);

		const archive = new Database(getProjectDbPath(fixture.gitPath), { readonly: true });
		try {
			// `INSERT OR REPLACE` plus delete-then-insert must leave the archive with exactly one
			// copy. A duplicate here would grow a user's backup on every sync.
			const messageCount = (
				archive.prepare("SELECT COUNT(*) AS c FROM narrator_messages").get() as { c: number }
			).c;
			expect(messageCount).toBe(MESSAGE_COUNT);
			const refCount = (
				archive.prepare("SELECT COUNT(*) AS c FROM narrator_message_refs").get() as { c: number }
			).c;
			expect(refCount).toBe(MESSAGE_COUNT);
		} finally {
			archive.close();
		}
	});
});
