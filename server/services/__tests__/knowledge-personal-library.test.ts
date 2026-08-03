/**
 * Personal-library + publish tests (the retired "draft" model → personal entries).
 *
 * Covers:
 *  - Standalone personal entries (no global counterpart): create / list / update meta.
 *  - Publishing a STANDALONE entry → approve creates a NEW global entry and archives the
 *    personal entry, linking it to the created entry.
 *  - Publishing a LINKED entry → approve merges into the existing global entry and archives
 *    the personal entry.
 *  - submit guards (standalone needs target collection + title).
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { users } from "../../db/schema";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

let collectionId: string;
let authorId: string;
let adminId: string;
const author = { userId: "", role: "user" as const };
const admin = { userId: "", role: "admin" as const };

const TAG = Date.now();

beforeAll(async () => {
	const now = new Date().toISOString();
	authorId = generateId();
	adminId = generateId();
	await db.insert(users).values([
		{ id: authorId, username: `pl-author-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: adminId, username: `pl-admin-${TAG}`, passwordHash: "x", role: "admin", createdAt: now },
	]);
	author.userId = authorId;
	admin.userId = adminId;

	const col = await knowledgeService.createCollection({ name: `personal-lib-${TAG}` });
	collectionId = col.id;
});

describe("standalone personal entries", () => {
	test("create / list / get a standalone entry", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Standalone ${TAG}`,
			content: "my private note\n",
			targetCollectionId: collectionId,
		});
		expect(created.entryId).toBeNull();
		expect(created.status).toBe("active");
		expect(created.title).toBe(`Standalone ${TAG}`);

		const mine = await knowledgeBranchService.listMine(author);
		const row = mine.find((d) => d.id === created.id);
		expect(row).toBeTruthy();

		// The LIST view must not carry bodies: it reports size only, so a large personal
		// library can't pull N full documents onto the main thread. Bodies come from getMine.
		expect("content" in (row ?? {})).toBe(false);
		expect(row?.contentLength).toBe("my private note\n".length);

		const got = await knowledgeBranchService.getMine(author, created.id);
		expect(got.content).toBe("my private note\n");
	});

	test("update standalone meta (title / target collection)", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `MetaEdit ${TAG}`,
		});
		const updated = await knowledgeBranchService.updateStandaloneMeta(author, created.id, {
			title: `MetaEdit ${TAG} v2`,
			targetCollectionId: collectionId,
		});
		expect(updated?.title).toBe(`MetaEdit ${TAG} v2`);
		expect(updated?.targetCollectionId).toBe(collectionId);
	});

	test("a standalone entry is private (another non-admin user cannot read it)", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Private ${TAG}`,
			content: "secret",
		});
		// A different ordinary user cannot read it (admin is exempt by design, like the rest of ACL).
		const otherId = generateId();
		await db.insert(users).values({
			id: otherId,
			username: `pl-other-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const other = { userId: otherId, role: "user" as const };
		expect(knowledgeBranchService.getMine(other, created.id)).rejects.toThrow();
	});
});

describe("publish a standalone entry → creates a new global entry", () => {
	test("submit requires a target collection + title", async () => {
		const noTarget = await knowledgeBranchService.createStandalone(author, {
			title: `NeedsTarget ${TAG}`,
			content: "body",
		});
		// No target collection set → submit refused.
		expect(knowledgeBranchService.submitForReview(author, noTarget.id, {})).rejects.toThrow();
	});

	test("approve creates a new global entry, archives the personal entry, links it", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Publish Me ${TAG}`,
			content: "brand new global knowledge\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {
			changeNote: "first publish",
		});
		expect(submission?.entryId ?? null).toBeNull();
		expect(submission?.collectionId).toBe(collectionId);

		// Admin approves (author can't review their own).
		const res = await knowledgeBranchService.review(admin, submission?.id as string, {
			verdict: "approve",
		});
		expect(res.status).toBe("approved");
		const newEntryId = (res as { entryId?: string }).entryId;
		expect(newEntryId).toBeTruthy();

		// The new global entry exists with the proposed content.
		const entry = (await knowledgeService.getEntry(newEntryId as string, {
			withContent: true,
		})) as { title: string; currentContent?: string | null };
		expect(entry.title).toBe(`Publish Me ${TAG}`);
		expect(entry.currentContent).toBe("brand new global knowledge\n");

		// The personal entry is archived and linked to the new global entry.
		const personal = await knowledgeBranchService.getMine(author, created.id);
		expect(personal.status).toBe("archived");
		expect(personal.entryId).toBe(newEntryId as string);
	});
});

describe("publish a linked entry → merges into the existing global entry", () => {
	test("approve merges and archives the personal entry", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `Linked Publish ${TAG}`,
			content: "original body\n",
		});
		const draft = await knowledgeBranchService.createDraft(author, entry.id, {});
		await knowledgeBranchService.updateDraft(author, draft.id, {
			content: "original body\nplus my contribution\n",
		});
		const submission = await knowledgeBranchService.submitForReview(author, draft.id, {});
		expect(submission?.entryId).toBe(entry.id);

		const res = await knowledgeBranchService.review(admin, submission?.id as string, {
			verdict: "approve",
		});
		expect(res.status).toBe("approved");

		// Global entry now carries the merged content.
		const updated = (await knowledgeService.getEntry(entry.id, { withContent: true })) as {
			currentContent?: string | null;
		};
		expect(updated.currentContent).toContain("plus my contribution");

		// Personal entry archived.
		const personal = await knowledgeBranchService.getMine(author, draft.id);
		expect(personal.status).toBe("archived");
	});
});
