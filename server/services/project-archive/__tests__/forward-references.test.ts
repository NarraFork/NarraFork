/**
 * The import's forward-reference handling, verified through a real archive file.
 *
 * WHY THIS TEST EXISTS
 * --------------------
 * The archive pages rows by primary key — a random nanoid — so WITHIN a table a
 * child routinely sorts before its parent, and some references point at tables that
 * arrive LATER in the parent-first table order (`deferred-references.ts` states the
 * graph). Before the import became two-phase, those shapes failed with a bare
 * foreign-key abort: an unexercised latent hazard, because no test ever exported a
 * project with forked chapters or narrators and imported it back.
 *
 * Every fixture here forces the hostile order on purpose: ids chosen so the child
 * sorts BEFORE the parent, an exploration group (imported before `chapters`)
 * pointing at a chapter, and a narrator whose `fork_message_id` points at
 * `narrator_messages` (imported after `narrators`). The round trip must restore all
 * of them, because the alternative is that real users' archives do not import.
 *
 * ISOLATION: same as `archive-roundtrip.test.ts` — the isolated database from
 * `tests/preload.ts`, every row deleted in `afterEach`, temp directories removed.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { db } from "@server/db";
import {
	chapters,
	explorationGroups,
	narratorMessageRefs,
	narratorMessages,
	narrators,
	projects,
} from "@server/db/schema";
import { generateId } from "@server/lib/id";
import { projectDbManager } from "@server/lib/project-db";
import { fullSync } from "@server/services/project-db-sync";
import { importProject } from "@server/services/project-import";
import { eq, inArray } from "drizzle-orm";

const tempDirs: string[] = [];
const createdProjects: string[] = [];
const createdNarrators: string[] = [];
const createdMessages: string[] = [];

afterEach(async () => {
	// FK-safe order, and deliberately redundant with the test bodies' own forgetting:
	// a successful import RE-CREATES every row, so cleanup always has something to do.
	// The NO ACTION references drive the order: narrators.fork_message_id must be
	// cleared BEFORE messages go (it points at one), narrator_message_refs.message_id
	// goes before the messages it names, and narrator_messages.narrator_id means
	// messages go before the narrators they belong to.
	if (createdNarrators.length > 0) {
		await db
			.update(narrators)
			.set({ parentNarratorId: null, refsInheritedFrom: null, forkMessageId: null })
			.where(inArray(narrators.id, createdNarrators));
	}
	if (createdMessages.length > 0) {
		await db
			.delete(narratorMessageRefs)
			.where(inArray(narratorMessageRefs.messageId, createdMessages));
		await db.delete(narratorMessages).where(inArray(narratorMessages.id, createdMessages));
		createdMessages.length = 0;
	}
	if (createdNarrators.length > 0) {
		await db.delete(narrators).where(inArray(narrators.id, createdNarrators));
		createdNarrators.length = 0;
	}
	for (const projectId of createdProjects.splice(0)) {
		projectDbManager.close(projectId);
		// exploration_groups' chapter references are ON DELETE SET NULL, as are the
		// chapters' self-references — no ordering constraint left here.
		await db.delete(explorationGroups).where(eq(explorationGroups.projectId, projectId));
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

const NOW = () => new Date().toISOString();

describe("import restores forward references whatever the row order", () => {
	test("child-before-parent chapters, exploration groups and narrator lineage round-trip", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-arc-fwdref-"));
		tempDirs.push(gitPath);
		const projectId = generateId();
		createdProjects.push(projectId);

		// Ids chosen so the CHILD sorts before the PARENT in primary-key order — the
		// hostile case the two-phase import exists for.
		const parentChapterId = "zz-parent-chapter";
		const childChapterId = "00-child-chapter";
		const reviewSourceId = "zz-review-source";
		const reviewChapterId = "00-review-chapter";
		const parentNarratorId = "zz-parent-narrator";
		const childNarratorId = "00-child-narrator";
		const forkMessageId = generateId();
		createdNarrators.push(parentNarratorId, childNarratorId);
		createdMessages.push(forkMessageId);

		await db.insert(projects).values({
			id: projectId,
			name: "Forward references",
			gitPath,
			defaultBranch: "main",
			createdAt: NOW(),
			updatedAt: NOW(),
		});

		await db.insert(chapters).values([
			{
				id: parentChapterId,
				projectId,
				title: "parent",
				branch: "chapter/parent",
				baseBranch: "main",
				status: "active",
				role: "branch",
				createdAt: NOW(),
				updatedAt: NOW(),
			},
			{
				id: childChapterId,
				projectId,
				title: "child",
				branch: "chapter/child",
				baseBranch: "main",
				status: "merged",
				role: "branch",
				parentChapterId,
				mergedIntoChapterId: parentChapterId,
				mergeCommitSha: "a".repeat(40),
				mergeStrategy: "merge",
				createdAt: NOW(),
				updatedAt: NOW(),
			},
			{
				id: reviewSourceId,
				projectId,
				title: "reviewed",
				branch: "chapter/reviewed",
				baseBranch: "main",
				status: "active",
				role: "branch",
				createdAt: NOW(),
				updatedAt: NOW(),
			},
			{
				id: reviewChapterId,
				projectId,
				title: "review",
				branch: "chapter/review",
				baseBranch: "main",
				status: "active",
				role: "review",
				reviewSourceChapterId: reviewSourceId,
				createdAt: NOW(),
				updatedAt: NOW(),
			},
		]);

		// exploration_groups is imported BEFORE chapters; its base/decided references
		// can therefore never be satisfied at row-insert time.
		const groupId = generateId();
		await db.insert(explorationGroups).values({
			id: groupId,
			projectId,
			title: "group",
			baseChapterId: parentChapterId,
			decidedChapterId: childChapterId,
			status: "decided",
			createdAt: NOW(),
			updatedAt: NOW(),
		});

		await db.insert(narrators).values([
			{
				id: parentNarratorId,
				chapterId: parentChapterId,
				title: "parent narrator",
				createdAt: NOW(),
				updatedAt: NOW(),
			},
		]);
		await db.insert(narratorMessages).values({
			id: forkMessageId,
			narratorId: parentNarratorId,
			role: "assistant",
			contentJson: [{ type: "text", text: "the fork point" }],
			createdAt: NOW(),
		});
		// The export carries messages reachable through narrator_message_refs (see
		// `project-db-sync.ts`), so the fork-point message needs its ref — as every
		// production message has one.
		await db.insert(narratorMessageRefs).values({
			id: generateId(),
			narratorId: parentNarratorId,
			messageId: forkMessageId,
			seq: 0,
			isCompact: 0,
		});
		await db.insert(narrators).values({
			id: childNarratorId,
			chapterId: childChapterId,
			title: "child narrator",
			parentNarratorId,
			// narrators is imported BEFORE narrator_messages: this reference is the
			// second shape the two-phase import exists for.
			forkMessageId,
			createdAt: NOW(),
			updatedAt: NOW(),
		});

		await fullSync(projectId);

		// Forget in FK-safe order: the child narrator's fork_message_id and the refs'
		// message_id are NO ACTION references, so they go before the messages they name.
		projectDbManager.close(projectId);
		await db.delete(narrators).where(eq(narrators.id, childNarratorId));
		await db.delete(narratorMessageRefs).where(eq(narratorMessageRefs.messageId, forkMessageId));
		await db.delete(narratorMessages).where(eq(narratorMessages.narratorId, parentNarratorId));
		await db.delete(narrators).where(eq(narrators.id, parentNarratorId));
		await db.delete(explorationGroups).where(eq(explorationGroups.projectId, projectId));
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
		).toBeUndefined();

		const result = await importProject(gitPath);
		expect(result.skipped).toBe(false);

		// Every forward reference restored, whatever order the rows arrived in.
		const child = await db.query.chapters.findFirst({ where: eq(chapters.id, childChapterId) });
		expect(child?.parentChapterId).toBe(parentChapterId);
		expect(child?.mergedIntoChapterId).toBe(parentChapterId);
		expect(child?.mergeCommitSha).toBe("a".repeat(40));
		const review = await db.query.chapters.findFirst({ where: eq(chapters.id, reviewChapterId) });
		// review_source_chapter_id is NOT part of the archive format (manifest.ts), so
		// the review chapter imports with the reference absent rather than restored.
		// Pinned here so a future format extension is a deliberate edit to both places.
		expect(review?.reviewSourceChapterId).toBeNull();

		const group = await db.query.explorationGroups.findFirst({
			where: eq(explorationGroups.id, groupId),
		});
		expect(group?.baseChapterId).toBe(parentChapterId);
		expect(group?.decidedChapterId).toBe(childChapterId);

		const narrator = await db.query.narrators.findFirst({
			where: eq(narrators.id, childNarratorId),
		});
		expect(narrator?.parentNarratorId).toBe(parentNarratorId);
		expect(narrator?.forkMessageId).toBe(forkMessageId);
	});

	test("a genuinely dangling forward reference aborts the whole import", async () => {
		const gitPath = mkdtempSync(join(tmpdir(), "nf-arc-dangle-"));
		tempDirs.push(gitPath);
		const projectId = generateId();
		createdProjects.push(projectId);

		await db.insert(projects).values({
			id: projectId,
			name: "Dangling",
			gitPath,
			defaultBranch: "main",
			createdAt: NOW(),
			updatedAt: NOW(),
		});
		const parentId = "zz-dangle-parent";
		const childId = "00-dangle-child";
		await db.insert(chapters).values([
			{
				id: parentId,
				projectId,
				title: "parent",
				branch: "chapter/dangle-parent",
				baseBranch: "main",
				status: "active",
				role: "branch",
				createdAt: NOW(),
				updatedAt: NOW(),
			},
			{
				id: childId,
				projectId,
				title: "child",
				branch: "chapter/dangle-child",
				baseBranch: "main",
				status: "active",
				role: "branch",
				parentChapterId: parentId,
				createdAt: NOW(),
				updatedAt: NOW(),
			},
		]);
		await fullSync(projectId);

		// Corrupt the archive: the parent the child references is no longer in the
		// file. The archive itself has no foreign keys, so it accepts this happily —
		// the MAIN database must refuse, and refuse EVERYTHING (the project row is
		// applied before chapters, so only a real transaction leaves nothing behind).
		const { Database } = await import("bun:sqlite");
		const { getProjectDbPath } = await import("@server/lib/project-db");
		const writable = new Database(getProjectDbPath(gitPath));
		writable.run("DELETE FROM chapters WHERE id = ?", [parentId]);
		writable.close();

		projectDbManager.close(projectId);
		await db.delete(chapters).where(eq(chapters.projectId, projectId));
		await db.delete(projects).where(eq(projects.id, projectId));

		await expect(importProject(gitPath)).rejects.toThrow();
		expect(
			await db.query.projects.findFirst({ where: eq(projects.id, projectId) }),
		).toBeUndefined();
		expect(await db.query.chapters.findFirst({ where: eq(chapters.id, childId) })).toBeUndefined();
	});
});
