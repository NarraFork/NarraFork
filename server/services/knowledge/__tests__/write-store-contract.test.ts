/**
 * The knowledge write store's contract, verified against real SQLite through the
 * production SQLite implementation.
 *
 * WHAT IS BEING PINNED
 * --------------------
 * The port (`services/knowledge/write-store.ts`) makes three promises that the
 * services rely on, and each is exercised where it can actually break:
 *
 *   - VERSION ALLOCATION: `appendRevision` / `commitMergedRevision` claim contiguous,
 *     unique versions under the entry row's allocation authority — never an
 *     unconstrained MAX+1 (see `revision-version.ts` for the frozen counter design
 *     this phase's bodies are value-for-value equivalent to).
 *   - CONFLICTS AS VOCABULARY: a uniqueness conflict arrives as `WriteConflictError`
 *     (translated structurally from the driver's `errno`, never sniffed from message
 *     text), and the conflicting operation leaves nothing behind.
 *   - ATOMIC SECTIONS: the guarded operations (submission guards, withdraw, approve,
 *     protected-task enforcement) decide INSIDE the section, and a rejected section
 *     writes nothing.
 *
 * The selection rules (`store.ts`) live in `store-wiring.test.ts`; the PostgreSQL
 * implementation runs the same business facts against a real server in
 * `tests/server/services/knowledge/pg-knowledge-write.test.ts`.
 *
 * ISOLATION: the isolated database from `tests/preload.ts` (temp NARRAFORK_HOME).
 * All rows are tagged per run, so no cleanup is needed.
 */
import { describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	aclGrants,
	knowledgeEntries,
	knowledgeInjectionEvents,
	knowledgeLevels,
	knowledgePacks,
	knowledgeRevisions,
	knowledgeSubmissions,
	narrators,
	narratorWhitelistDirs,
	projects,
	specNamespaceFiles,
	specProtectedTasks,
	users,
} from "../../../db/schema";
import { ValidationError } from "../../../lib/errors";
import { generateId } from "../../../lib/id";
import { sqliteKnowledgeWriteStore as store } from "../sqlite-write-store";
import { WriteConflictError } from "../write-store";

const TAG = generateId(8);
const NOW = () => new Date().toISOString();

let userId: string;

async function ensureUser(): Promise<string> {
	if (userId) return userId;
	userId = generateId();
	await db.insert(users).values({
		id: userId,
		username: `kw-${TAG}`,
		passwordHash: "x",
		role: "user",
		createdAt: NOW(),
	});
	return userId;
}

async function makeCollection(slug: string) {
	return store.createCollection({
		id: generateId(),
		name: `col-${slug}`,
		slug,
		description: null,
		projectId: null,
		ownerUserId: null,
		now: NOW(),
	});
}

async function makeEntry(collectionId: string, slug: string) {
	const entryId = generateId();
	const revisionId = generateId();
	await store.createEntryWithFirstRevision({
		entryId,
		revisionId,
		collectionId,
		title: `entry-${slug}`,
		slug,
		content: `body of ${slug}`,
		format: "markdown",
		contentHash: `hash-${slug}`,
		currentKeywords: null,
		tagsJson: [],
		keywordsJson: [],
		metadataJson: null,
		ownerUserId: await ensureUser(),
		changeNote: null,
		authorUserId: userId,
		now: NOW(),
	});
	return { entryId, revisionId };
}

async function versionsOf(entryId: string): Promise<number[]> {
	const rows = await db
		.select({ v: knowledgeRevisions.version })
		.from(knowledgeRevisions)
		.where(eq(knowledgeRevisions.entryId, entryId))
		.orderBy(knowledgeRevisions.version);
	return rows.map((r) => r.v);
}

describe("knowledge write store (SQLite)", () => {
	test("createCollection conflict crosses as WriteConflictError, not driver text", async () => {
		// The slug unique index is (project_id, slug), so the race exists under a
		// shared project (SQLite treats NULLs as distinct — a global-collection slug
		// race is caught by the service's pre-check instead).
		const projectId = generateId();
		await db.insert(projects).values({
			id: projectId,
			name: `proj-${TAG}`,
			createdAt: NOW(),
			updatedAt: NOW(),
		});
		const input = {
			name: "dup",
			slug: "dup",
			description: null,
			projectId,
			ownerUserId: null,
			now: NOW(),
		};
		await store.createCollection({ id: generateId(), ...input });
		const error = await store
			.createCollection({ id: generateId(), ...input })
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WriteConflictError);
		// The SQLite backend has no constraint NAME to report; it carries the
		// "table.column" detail instead — never null, never a raw driver message.
		expect((error as WriteConflictError).constraint).toContain("knowledge_collections");
	});

	test("createEntryWithFirstRevision conflict leaves no entry and no revision", async () => {
		const col = await makeCollection(`ce-${TAG}`);
		const first = await makeEntry(col.id, "taken");
		const doomedRevisionId = generateId();
		const error = await store
			.createEntryWithFirstRevision({
				entryId: generateId(),
				revisionId: doomedRevisionId,
				collectionId: col.id,
				title: "second",
				slug: "taken",
				content: "x",
				format: "markdown",
				contentHash: "x",
				currentKeywords: null,
				tagsJson: [],
				keywordsJson: [],
				metadataJson: null,
				ownerUserId: null,
				changeNote: null,
				authorUserId: null,
				now: NOW(),
			})
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WriteConflictError);
		// The first revision insert never happened: the entry still owns exactly v1.
		expect(await versionsOf(first.entryId)).toEqual([1]);
		const orphan = await db
			.select({ id: knowledgeRevisions.id })
			.from(knowledgeRevisions)
			.where(eq(knowledgeRevisions.id, doomedRevisionId));
		expect(orphan).toEqual([]);
	});

	test("appendRevision claims contiguous versions under the entry's authority", async () => {
		const col = await makeCollection(`ver-${TAG}`);
		const { entryId } = await makeEntry(col.id, "v");
		const claims: number[] = [];
		for (let i = 0; i < 3; i++) {
			const { version } = await store.appendRevision({
				entryId,
				revisionId: generateId(),
				content: `rev ${i}`,
				format: "markdown",
				contentHash: `h${i}`,
				changeNote: null,
				authorUserId: null,
				now: NOW(),
			});
			claims.push(version);
		}
		expect(claims).toEqual([2, 3, 4]);
		expect(await versionsOf(entryId)).toEqual([1, 2, 3, 4]);
	});

	test("the claim against an entry with no revisions starts at the base", async () => {
		const col = await makeCollection(`base-${TAG}`);
		// An entry row WITHOUT any revision (the allocation floor case).
		const entryId = generateId();
		await db.insert(knowledgeEntries).values({
			id: entryId,
			collectionId: col.id,
			title: "bare",
			slug: "bare",
			status: "active",
			createdAt: NOW(),
			updatedAt: NOW(),
		});
		const { version } = await store.appendRevision({
			entryId,
			revisionId: generateId(),
			content: "first",
			format: "markdown",
			contentHash: "h",
			changeNote: null,
			authorUserId: null,
			now: NOW(),
		});
		expect(version).toBe(1);
	});

	test("injection events dedupe on (narrator, compactSeq, entry) via ON CONFLICT", async () => {
		const narratorId = `n-${TAG}`;
		await db.insert(narrators).values({ id: narratorId, createdAt: NOW(), updatedAt: NOW() }).run();
		const col = await makeCollection(`inj-${TAG}`);
		const { entryId } = await makeEntry(col.id, "e");
		const hit = { id: generateId(), entryId, entryRevisionId: null, summary: null };
		const input = {
			narratorId,
			compactSeq: 0,
			source: "tool_output",
			triggerMessageId: null,
			triggerToolCallId: null,
			now: NOW(),
		};
		await store.recordInjectionEvents({ ...input, hits: [hit] });
		// Same identity again (a different row id, same dedupe key): still one row.
		await store.recordInjectionEvents({ ...input, hits: [{ ...hit, id: generateId() }] });
		const rows = await db
			.select({ id: knowledgeInjectionEvents.id })
			.from(knowledgeInjectionEvents)
			.where(eq(knowledgeInjectionEvents.narratorId, narratorId));
		expect(rows).toHaveLength(1);
	});

	test("getOrCreateActiveDraft returns the existing active draft", async () => {
		const col = await makeCollection(`gd-${TAG}`);
		const { entryId, revisionId } = await makeEntry(col.id, "d");
		const author = await ensureUser();
		const first = await store.getOrCreateActiveDraft({
			draftId: generateId(),
			entryId,
			authorUserId: author,
			name: null,
			baseRevisionId: revisionId,
			content: "fork",
			contentHash: "h",
			now: NOW(),
		});
		const second = await store.getOrCreateActiveDraft({
			draftId: generateId(),
			entryId,
			authorUserId: author,
			name: null,
			baseRevisionId: revisionId,
			content: "fork",
			contentHash: "h",
			now: NOW(),
		});
		expect(second.id).toBe(first.id);
	});

	test("submission guard, withdraw guard and edit-supersede compose", async () => {
		const col = await makeCollection(`sub-${TAG}`);
		const { entryId, revisionId } = await makeEntry(col.id, "s");
		const author = await ensureUser();
		const draft = await store.getOrCreateActiveDraft({
			draftId: generateId(),
			entryId,
			authorUserId: author,
			name: null,
			baseRevisionId: revisionId,
			content: "draft body",
			contentHash: "h",
			now: NOW(),
		});
		const submission = await store.createSubmissionGuarded({
			submissionId: generateId(),
			draftId: draft.id,
			entryId,
			collectionId: null,
			title: null,
			submitterUserId: author,
			baseRevisionId: revisionId,
			proposedContent: "draft body",
			keywordsJson: null,
			changeNote: null,
			previousSubmissionId: null,
			round: 1,
			now: NOW(),
		});
		expect(submission.status).toBe("pending");

		// A second open request is refused inside the section.
		const dup = await store
			.createSubmissionGuarded({
				submissionId: generateId(),
				draftId: draft.id,
				entryId,
				collectionId: null,
				title: null,
				submitterUserId: author,
				baseRevisionId: revisionId,
				proposedContent: "draft body",
				keywordsJson: null,
				changeNote: null,
				previousSubmissionId: null,
				round: 1,
				now: NOW(),
			})
			.catch((e: unknown) => e);
		expect(dup).toBeInstanceOf(ValidationError);

		// Editing the draft supersedes the pending request and reports it.
		const invalidated = await store.updateDraftContent({
			draftId: draft.id,
			content: "rewritten",
			contentHash: "h2",
			now: NOW(),
		});
		expect(invalidated.map((s) => s.id)).toEqual([submission.id]);
		const closed = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submission.id),
		});
		expect(closed?.status).toBe("superseded");

		// A fresh request can be withdrawn; a second withdraw reports not-changed.
		const again = await store.createSubmissionGuarded({
			submissionId: generateId(),
			draftId: draft.id,
			entryId,
			collectionId: null,
			title: null,
			submitterUserId: author,
			baseRevisionId: revisionId,
			proposedContent: "rewritten",
			keywordsJson: null,
			changeNote: null,
			previousSubmissionId: null,
			round: 1,
			now: NOW(),
		});
		expect(await store.withdrawSubmissionGuarded({ submissionId: again.id, now: NOW() })).toBe(
			true,
		);
		expect(await store.withdrawSubmissionGuarded({ submissionId: again.id, now: NOW() })).toBe(
			false,
		);
	});

	test("commitMergedRevision moves main, claims the version and closes the draft", async () => {
		const col = await makeCollection(`mg-${TAG}`);
		const { entryId, revisionId } = await makeEntry(col.id, "m");
		const author = await ensureUser();
		const draft = await store.getOrCreateActiveDraft({
			draftId: generateId(),
			entryId,
			authorUserId: author,
			name: null,
			baseRevisionId: revisionId,
			content: "merged body",
			contentHash: "h",
			now: NOW(),
		});
		const submission = await store.createSubmissionGuarded({
			submissionId: generateId(),
			draftId: draft.id,
			entryId,
			collectionId: null,
			title: null,
			submitterUserId: author,
			baseRevisionId: revisionId,
			proposedContent: "merged body",
			keywordsJson: null,
			changeNote: null,
			previousSubmissionId: null,
			round: 1,
			now: NOW(),
		});
		const mergedRevisionId = generateId();
		const { version } = await store.commitMergedRevision({
			submissionId: submission.id,
			draftId: draft.id,
			entryId,
			revisionId: mergedRevisionId,
			content: "merged body",
			contentHash: "h",
			changeNote: null,
			baseRevisionId: revisionId,
			submitterUserId: author,
			reviewerUserId: author,
			now: NOW(),
		});
		expect(version).toBe(2);
		expect(await versionsOf(entryId)).toEqual([1, 2]);
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
		});
		expect(entry?.currentRevisionId).toBe(mergedRevisionId);
		expect(entry?.currentContent).toBe("merged body");

		// A second reviewer is refused by the in-section status re-check.
		const second = await store
			.commitMergedRevision({
				submissionId: submission.id,
				draftId: draft.id,
				entryId,
				revisionId: generateId(),
				content: "other",
				contentHash: "h3",
				changeNote: null,
				baseRevisionId: revisionId,
				submitterUserId: author,
				reviewerUserId: author,
				now: NOW(),
			})
			.catch((e: unknown) => e);
		expect(second).toBeInstanceOf(ValidationError);
		expect(await versionsOf(entryId)).toEqual([1, 2]);
	});

	test("replaceUserKnowledgeGrants replaces the knowledge scope only", async () => {
		const principal = await ensureUser();
		// A project-scope membership of the same principal: must survive.
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: `proj-${TAG}`,
			principalType: "user",
			principalId: principal,
			capability: "write",
			createdAt: NOW(),
		});
		const grantRow = (id: string, domainValue: string) => ({
			id,
			scopeType: "global",
			scopeId: null,
			principalType: "user",
			principalId: principal,
			capability: "read",
			domainKind: "clearance",
			domainValue,
			grantedBy: null,
			createdAt: NOW(),
		});
		await store.replaceUserKnowledgeGrants({
			principalType: "user",
			principalId: principal,
			rows: [grantRow(generateId(), "internal")],
		});
		await store.replaceUserKnowledgeGrants({
			principalType: "user",
			principalId: principal,
			rows: [grantRow(generateId(), "secret")],
		});
		const rows = await db
			.select({
				scopeType: aclGrants.scopeType,
				domainValue: aclGrants.domainValue,
			})
			.from(aclGrants)
			.where(and(eq(aclGrants.principalType, "user"), eq(aclGrants.principalId, principal)));
		// The replacement took effect ("internal" is gone), and the project row survived.
		expect(rows).toContainEqual({ scopeType: "global", domainValue: "secret" });
		expect(rows).not.toContainEqual({ scopeType: "global", domainValue: "internal" });
		expect(rows).toContainEqual({ scopeType: "project", domainValue: null });
	});

	test("insertAclGrantRows duplicate crosses as WriteConflictError", async () => {
		const principal = await ensureUser();
		const row = {
			id: generateId(),
			scopeType: "global",
			scopeId: null,
			principalType: "user",
			principalId: principal,
			capability: "read",
			domainKind: "clearance",
			domainValue: `lvl-${TAG}`,
			grantedBy: null,
			createdAt: NOW(),
		};
		await store.insertAclGrantRows([row]);
		const error = await store
			.insertAclGrantRows([{ ...row, id: generateId() }])
			.catch((e: unknown) => e);
		expect(error).toBeInstanceOf(WriteConflictError);
	});

	test("renameKnowledgeLevel rewrites entries and clearance credentials atomically", async () => {
		const levelId = generateId();
		await db.insert(knowledgeLevels).values({
			id: levelId,
			name: `old-${TAG}`,
			rank: 7,
			createdAt: NOW(),
		});
		const col = await makeCollection(`lvl-${TAG}`);
		const { entryId } = await makeEntry(col.id, "leveled");
		await db
			.update(knowledgeEntries)
			.set({ classificationLevel: `old-${TAG}` })
			.where(eq(knowledgeEntries.id, entryId));
		const principal = await ensureUser();
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "global",
			scopeId: null,
			principalType: "user",
			principalId: principal,
			capability: "read",
			domainKind: "clearance",
			domainValue: `old-${TAG}`,
			createdAt: NOW(),
		});
		await store.renameKnowledgeLevel({
			levelId,
			updates: { name: `new-${TAG}` },
			rename: { from: `old-${TAG}`, to: `new-${TAG}` },
		});
		const entry = await db.query.knowledgeEntries.findFirst({
			where: eq(knowledgeEntries.id, entryId),
			columns: { classificationLevel: true },
		});
		expect(entry?.classificationLevel).toBe(`new-${TAG}`);
		const grants = await db
			.select({ domainValue: aclGrants.domainValue })
			.from(aclGrants)
			.where(and(eq(aclGrants.principalId, principal), eq(aclGrants.domainKind, "clearance")));
		expect(grants.map((g) => g.domainValue)).toContain(`new-${TAG}`);
	});

	test("spec namespace: get-or-create, protected-task enforcement, fork, reset", async () => {
		const parentNarrator = `spec-p-${TAG}`;
		await db
			.insert(narrators)
			.values({ id: parentNarrator, createdAt: NOW(), updatedAt: NOW() })
			.run();
		const ns = await store.ensureSpecNamespace({
			namespaceId: generateId(),
			narratorId: parentNarrator,
			now: NOW(),
		});
		const again = await store.ensureSpecNamespace({
			namespaceId: generateId(),
			narratorId: parentNarrator,
			now: NOW(),
		});
		expect(again.id).toBe(ns.id);

		// Write tasks.json with a protected task (allowed) → the lock is created.
		const tasksJson = JSON.stringify({
			tasks: [{ text: "keep me", status: "todo", protected: true }],
		});
		const textHash = (text: string) => `hash:${text}`;
		const hooks = (tasks: { text: string; status: string; protected: boolean }[]) => ({
			tasks: tasks.map((task) => ({ ...task, textHash: textHash(task.text) })),
			// Minimal detector mirroring the production rule: an open lock whose text is
			// gone from the document is a "delete" mutation.
			detectProtectedMutations: (
				locks: { text: string; status: string }[],
			): { kind: string; text: string; details: string }[] =>
				locks
					.filter(
						(lock) =>
							lock.status !== "done" &&
							lock.status !== "deleted" &&
							!tasks.some((task) => task.text === lock.text),
					)
					.map((lock) => ({ kind: "delete", text: lock.text, details: "removed" })),
			allowProtectedTaskMutation: false,
		});
		const firstWrite = await store.writeSpecFileRevision({
			namespaceId: ns.id,
			path: "tasks.json",
			content: tasksJson,
			contentHash: "c1",
			revisionId: generateId(),
			fileIdForCreate: generateId(),
			sourceToolUseId: null,
			sourceMessageId: null,
			createdBy: "assistant",
			now: NOW(),
			specTasks: {
				...hooks([{ text: "keep me", status: "todo", protected: true }]),
				allowProtectedTaskMutation: true,
			},
		});
		expect(firstWrite.ok).toBe(true);

		// Removing the protected task without the grant: refused, and NOTHING written.
		const rejected = await store.writeSpecFileRevision({
			namespaceId: ns.id,
			path: "tasks.json",
			content: JSON.stringify({ tasks: [] }),
			contentHash: "c2",
			revisionId: generateId(),
			fileIdForCreate: generateId(),
			sourceToolUseId: null,
			sourceMessageId: null,
			createdBy: "assistant",
			now: NOW(),
			specTasks: hooks([]),
		});
		expect(rejected.ok).toBe(false);
		if (!rejected.ok) expect(rejected.protectedMutations[0]?.kind).toBe("delete");
		const fileAfter = await db.query.specNamespaceFiles.findFirst({
			where: and(
				eq(specNamespaceFiles.namespaceId, ns.id),
				eq(specNamespaceFiles.path, "tasks.json"),
			),
		});
		expect(fileAfter?.deleted).toBe(false);

		// Fork copies the file pointer + the lock; a second fork is a no-op.
		const childNarrator = `spec-c-${TAG}`;
		await db
			.insert(narrators)
			.values({ id: childNarrator, createdAt: NOW(), updatedAt: NOW() })
			.run();
		const fork = await store.forkSpecNamespace({
			parentNamespaceId: ns.id,
			childNamespaceId: generateId(),
			childNarratorId: childNarrator,
			now: NOW(),
		});
		expect(fork.created).toBe(true);
		const forkAgain = await store.forkSpecNamespace({
			parentNamespaceId: ns.id,
			childNamespaceId: generateId(),
			childNarratorId: childNarrator,
			now: NOW(),
		});
		expect(forkAgain.created).toBe(false);
		const childNs = await store.ensureSpecNamespace({
			namespaceId: generateId(),
			narratorId: childNarrator,
			now: NOW(),
		});
		const childLocks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, childNs.id),
		});
		expect(childLocks).toHaveLength(1);

		// Reset releases the lock and drops the file rows.
		await store.resetSpecNamespace({ namespaceId: ns.id, now: NOW() });
		const parentLocks = await db.query.specProtectedTasks.findMany({
			where: eq(specProtectedTasks.namespaceId, ns.id),
		});
		expect(parentLocks.every((lock) => lock.status === "deleted")).toBe(true);
		const parentFiles = await db.query.specNamespaceFiles.findMany({
			where: eq(specNamespaceFiles.namespaceId, ns.id),
		});
		expect(parentFiles).toEqual([]);
	});

	test("pack activation: record then release, atomically paired", async () => {
		const narratorId = `pack-n-${TAG}`;
		await db.insert(narrators).values({ id: narratorId, createdAt: NOW(), updatedAt: NOW() }).run();
		const packId = generateId();
		await db.insert(knowledgePacks).values({
			id: packId,
			name: `pack-${TAG}`,
			slug: `pack-${TAG}`,
			archiveFormat: "zip",
			archiveSize: 1,
			archiveHash: "hash",
			status: "active",
			createdAt: NOW(),
			updatedAt: NOW(),
		});
		const activationId = generateId();
		const whitelistDirId = generateId();
		await store.recordPackActivation({
			activationId,
			whitelistDirId,
			packId,
			narratorId,
			extractDir: `/tmp/extract-${TAG}`,
			archiveHash: "hash",
			now: NOW(),
		});
		const whitelist = await db.query.narratorWhitelistDirs.findFirst({
			where: eq(narratorWhitelistDirs.id, whitelistDirId),
		});
		expect(whitelist?.path).toBe(`/tmp/extract-${TAG}`);

		await store.releasePackActivation({ activationId, whitelistDirId, now: NOW() });
		const released = await db.query.narratorWhitelistDirs.findFirst({
			where: eq(narratorWhitelistDirs.id, whitelistDirId),
		});
		expect(released).toBeUndefined();
	});
});
