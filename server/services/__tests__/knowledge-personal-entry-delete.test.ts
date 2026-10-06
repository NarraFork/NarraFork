/**
 * Personal-entry delete (WP2) — soft-delete semantics for a user's own personal entry.
 *
 * Covers:
 *  - Authorization: only the author (or an admin) may delete; anyone else gets NotFound
 *    (existence is not leaked) and the entry stays active.
 *  - Open publish requests (pending / conflict) are closed as `withdrawn` alongside the
 *    delete, in the same transaction, so reviewers can't act on a retired entry's proposal.
 *    `withdrawn` (not `rejected`) because the author retired it themselves — no reviewer
 *    passed judgement, so no verdict is written either.
 *  - A soft-deleted entry is archived, disappears from listMine({ status: "active" }), and
 *    is no longer editable / publishable.
 *  - Author-scoped publish history (listSubmissionsForDraft) is visible to the author, whose
 *    own submissions the reviewer-facing listSubmissions deliberately never returns.
 *  - The invalidation emits `knowledge:submission_invalidated` with reason "entry_deleted"
 *    AFTER the transaction commits, so the submitter is notified.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { knowledgeSubmissions, users } from "../../db/schema";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

type InvalidatedEvent = Extract<NarraForkEvent, { type: "knowledge:submission_invalidated" }>;

let collectionId: string;
const author = { userId: "", role: "user" as const };
const admin = { userId: "", role: "admin" as const };
const stranger = { userId: "", role: "user" as const };

const TAG = Date.now();

beforeAll(async () => {
	const now = new Date().toISOString();
	const authorId = generateId();
	const adminId = generateId();
	const strangerId = generateId();
	await db.insert(users).values([
		{ id: authorId, username: `pd-author-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: adminId, username: `pd-admin-${TAG}`, passwordHash: "x", role: "admin", createdAt: now },
		{
			id: strangerId,
			username: `pd-stranger-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		},
	]);
	author.userId = authorId;
	admin.userId = adminId;
	stranger.userId = strangerId;

	const col = await knowledgeService.createCollection({ name: `personal-delete-${TAG}` });
	collectionId = col.id;
});

describe("deletePersonalEntry authorization", () => {
	test("a non-author non-admin cannot delete (NotFound) and the entry stays active", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Guarded ${TAG}`,
			content: "mine only",
		});

		expect(knowledgeBranchService.deletePersonalEntry(stranger, created.id)).rejects.toThrow();

		// Still active from the author's point of view — the failed delete changed nothing.
		const after = await knowledgeBranchService.getMine(author, created.id);
		expect(after.status).toBe("active");
	});

	test("the author can delete their own entry", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `AuthorDelete ${TAG}`,
			content: "body",
		});
		const res = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		expect(res.ok).toBe(true);
		expect(res.alreadyArchived).toBe(false);

		const after = await knowledgeBranchService.getMine(author, created.id);
		expect(after.status).toBe("archived");
	});

	test("an admin can delete someone else's entry", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `AdminDelete ${TAG}`,
			content: "body",
		});
		const res = await knowledgeBranchService.deletePersonalEntry(admin, created.id);
		expect(res.ok).toBe(true);

		const after = await knowledgeBranchService.getMine(author, created.id);
		expect(after.status).toBe("archived");
	});

	test("deleting an already-archived entry is an idempotent no-op", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Idempotent ${TAG}`,
			content: "body",
		});
		await knowledgeBranchService.deletePersonalEntry(author, created.id);
		const again = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		expect(again.ok).toBe(true);
		expect(again.alreadyArchived).toBe(true);
	});
});

describe("deletePersonalEntry invalidates open publish requests", () => {
	test("a pending submission is withdrawn alongside the delete, and the submitter is notified", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `WithPending ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {
			changeNote: "please publish",
		});
		const submissionId = submission?.id as string;
		expect(submission?.status).toBe("pending");

		// Capture the invalidation event (emitted after the transaction commits).
		const seen: InvalidatedEvent[] = [];
		const onEvent = (e: InvalidatedEvent) => seen.push(e);
		eventBus.on("knowledge:submission_invalidated", onEvent);
		let res: Awaited<ReturnType<typeof knowledgeBranchService.deletePersonalEntry>>;
		try {
			res = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		} finally {
			eventBus.off("knowledge:submission_invalidated", onEvent);
		}
		expect(res.invalidatedSubmissionIds).toEqual([submissionId]);

		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("withdrawn");
		expect(row?.reviewedAt).toBeTruthy();
		// No reviewer judged this — the author retired their own entry. A verdict here would
		// render as "a reviewer rejected you" in the author's publish history.
		expect(row?.verdict).toBeNull();
		expect(row?.reviewerUserId).toBeNull();

		// The submitter is told their publish request was closed, with the delete reason.
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			type: "knowledge:submission_invalidated",
			submissionId,
			submitterUserId: author.userId,
			reason: "entry_deleted",
		});
	});

	test("a conflicted submission is withdrawn too", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `WithConflict ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {});
		const submissionId = submission?.id as string;
		// Force the conflict state directly: conflicts only arise from linked three-way merges,
		// and this test only needs the delete path to treat `conflict` as open.
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, submissionId));

		const res = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		expect(res.invalidatedSubmissionIds).toEqual([submissionId]);

		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("withdrawn");
		expect(row?.verdict).toBeNull();
	});

	test("a bounced (changes_requested) submission is withdrawn too — its path is now impossible", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `AlreadyReviewed ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {});
		const submissionId = submission?.id as string;
		// Reviewer bounces it back: the ball is in the AUTHOR's court, and the only way forward
		// is `resubmit` from this personal entry.
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });

		const res = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		// Retiring the entry makes the requested changes impossible to deliver, so leaving the
		// request open would strand it forever as an orphan pointing at an archived draft.
		expect(res.invalidatedSubmissionIds).toEqual([submissionId]);

		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("withdrawn");
		// Unlike the pending/conflict cases, the reviewer's verdict is KEPT: they really did ask
		// for changes, and "changes were requested, then the author retired the entry" is the
		// accurate history. Only the status reflects who closed it.
		expect(row?.verdict).toBe("request_changes");
		expect(row?.reviewerUserId).toBe(admin.userId);
	});

	test("a terminally-decided submission is left untouched", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `AlreadyApproved ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {});
		const submissionId = submission?.id as string;
		// Approved = merged into the global base; nothing about it is retractable any more.
		await knowledgeBranchService.review(admin, submissionId, { verdict: "approve" });

		// The publish already archived the personal entry, so this delete is a no-op…
		const res = await knowledgeBranchService.deletePersonalEntry(author, created.id);
		expect(res.alreadyArchived).toBe(true);

		// …and must not rewrite the merged request's terminal state.
		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("approved");
	});
});

describe("a soft-deleted entry leaves the active library", () => {
	test("it disappears from listMine({ status: 'active' }) but stays under archived", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Vanishing ${TAG}`,
			content: "body",
		});
		const before = await knowledgeBranchService.listMine(author, { status: "active" });
		expect(before.some((d) => d.id === created.id)).toBe(true);

		await knowledgeBranchService.deletePersonalEntry(author, created.id);

		const after = await knowledgeBranchService.listMine(author, { status: "active" });
		expect(after.some((d) => d.id === created.id)).toBe(false);

		const archived = await knowledgeBranchService.listMine(author, { status: "archived" });
		expect(archived.some((d) => d.id === created.id)).toBe(true);
	});

	test("it can no longer be edited or published", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `Frozen ${TAG}`,
			content: "body",
			targetCollectionId: collectionId,
		});
		await knowledgeBranchService.deletePersonalEntry(author, created.id);

		expect(
			knowledgeBranchService.updateDraft(author, created.id, { content: "changed" }),
		).rejects.toThrow();
		expect(knowledgeBranchService.submitForReview(author, created.id, {})).rejects.toThrow();
		expect(
			knowledgeBranchService.updateStandaloneMeta(author, created.id, { title: "new" }),
		).rejects.toThrow();
	});
});

describe("author-scoped publish history", () => {
	test("the author sees their own submissions (which the reviewer list hides from them)", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `History ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {
			changeNote: "round 1",
		});
		const submissionId = submission?.id as string;

		const own = await knowledgeBranchService.listSubmissionsForDraft(author, created.id);
		expect(own.map((s) => s.id)).toContain(submissionId);
		// The list view must not carry the large proposed-content blob.
		expect("proposedContent" in (own[0] ?? {})).toBe(false);

		// The reviewer-facing list never surfaces your own submission to you.
		const asReviewer = await knowledgeBranchService.listSubmissions(author, {});
		expect(asReviewer.some((s) => s.id === submissionId)).toBe(false);

		// A stranger cannot read the author's publish history.
		expect(knowledgeBranchService.listSubmissionsForDraft(stranger, created.id)).rejects.toThrow();
	});

	test("listMyOpenSubmissions returns only in-flight requests, keyed by draft", async () => {
		const created = await knowledgeBranchService.createStandalone(author, {
			title: `OpenBadge ${TAG}`,
			content: "proposed body\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(author, created.id, {});
		const submissionId = submission?.id as string;

		const open = await knowledgeBranchService.listMyOpenSubmissions(author);
		const mine = open.find((s) => s.draftId === created.id);
		expect(mine?.id).toBe(submissionId);
		expect(mine?.status).toBe("pending");

		// Approve it → no longer in flight.
		await knowledgeBranchService.review(admin, submissionId, { verdict: "approve" });
		const afterApprove = await knowledgeBranchService.listMyOpenSubmissions(author);
		expect(afterApprove.some((s) => s.id === submissionId)).toBe(false);
	});
});
