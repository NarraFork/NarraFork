/**
 * Review state machine closure (WP5).
 *
 * The publish-request lifecycle previously had three open ends. These tests pin the closures:
 *
 *  1. **withdraw** — the submitter (or an admin) closes an own open request explicitly, instead
 *     of editing the draft and relying on a side effect. Identity and status are both enforced.
 *  2. **resubmit** — `changes_requested` no longer dead-ends: a new request is created from the
 *     draft's CURRENT content, carrying `round` + `previousSubmissionId` so a reviewer sees the
 *     revision round.
 *  3. **auto-invalidation semantics** — editing (`updateDraft`) or rebasing (`rebaseDraft`) a
 *     draft closes a `pending` request as `superseded` (NOT `rejected`, which means "a reviewer
 *     refused it"), and deliberately leaves a `conflict` request open: a conflict is an
 *     unresolved divergence that must not be hidden by an edit.
 *  4. **rebase strategy=theirs** — take main verbatim, discarding local edits, as the explicit
 *     escape from a conflicting merge.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME (ACL + branch service + FTS
 * triggers all exercised), mirroring knowledge-drift-rebase / knowledge-personal-library.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { knowledgeGrants, knowledgeSubmissions, knowledgeTags, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import { knowledgeRoutes } from "../../routes/knowledge";
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
		{ id: authorId, username: `rl-author-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: adminId, username: `rl-admin-${TAG}`, passwordHash: "x", role: "admin", createdAt: now },
		{
			id: strangerId,
			username: `rl-stranger-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		},
	]);
	author.userId = authorId;
	admin.userId = adminId;
	stranger.userId = strangerId;

	const col = await knowledgeService.createCollection({ name: `review-lifecycle-${TAG}` });
	collectionId = col.id;
});

/** A standalone personal entry with an open pending publish request. */
async function makePendingSubmission(label: string) {
	const entry = await knowledgeBranchService.createStandalone(author, {
		title: `${label} ${TAG}`,
		content: `${label} body\n`,
		targetCollectionId: collectionId,
	});
	const submission = await knowledgeBranchService.submitForReview(author, entry.id, {
		changeNote: `${label} note`,
	});
	return { entry, submissionId: submission?.id as string };
}

async function statusOf(submissionId: string) {
	const row = await db.query.knowledgeSubmissions.findFirst({
		where: eq(knowledgeSubmissions.id, submissionId),
	});
	return row;
}

/** A Hono app mounting the real knowledge routes behind a fake principal (mirrors bulk-grant). */
function appFor(principal: { userId: string; role: "admin" | "user" }) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", {
			sub: principal.userId,
			role: principal.role,
			iat: 0,
			exp: Number.MAX_SAFE_INTEGER,
		});
		await next();
	});
	app.onError((error) => {
		if (error instanceof AppError) {
			return new Response(JSON.stringify({ error: error.message, code: error.code }), {
				status: error.statusCode,
				headers: { "content-type": "application/json" },
			});
		}
		throw error;
	});
	app.route("/knowledge", knowledgeRoutes);
	return app;
}

// ─── 1. withdraw ─────────────────────────────────────────────────────────

describe("withdrawSubmission", () => {
	test("the submitter withdraws their own pending request → withdrawn", async () => {
		const { submissionId } = await makePendingSubmission("Withdrawable");

		const seen: InvalidatedEvent[] = [];
		const onEvent = (e: InvalidatedEvent) => seen.push(e);
		eventBus.on("knowledge:submission_invalidated", onEvent);
		let res: Awaited<ReturnType<typeof knowledgeBranchService.withdrawSubmission>>;
		try {
			res = await knowledgeBranchService.withdrawSubmission(author, submissionId, {
				reason: "found a typo",
			});
		} finally {
			eventBus.off("knowledge:submission_invalidated", onEvent);
		}
		expect(res.status).toBe("withdrawn");

		const row = await statusOf(submissionId);
		expect(row?.status).toBe("withdrawn");
		expect(row?.reviewedAt).toBeTruthy();
		// No verdict is recorded: nobody reviewed it.
		expect(row?.verdict ?? null).toBeNull();
		// The reason is appended to the change note for the audit trail.
		expect(row?.changeNote).toContain("found a typo");

		// Reviewer badges must drop it, so the invalidation event carries reason "withdrawn".
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({
			type: "knowledge:submission_invalidated",
			submissionId,
			submitterUserId: author.userId,
			reason: "withdrawn",
		});
	});

	test("a conflicted request can be withdrawn (its only author-side exit)", async () => {
		const { submissionId } = await makePendingSubmission("WithdrawConflict");
		// Force the conflict state directly: conflicts only arise from linked three-way merges,
		// and this test only needs withdraw to accept `conflict` as open.
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, submissionId));

		const res = await knowledgeBranchService.withdrawSubmission(author, submissionId);
		expect(res.status).toBe("withdrawn");
		expect((await statusOf(submissionId))?.status).toBe("withdrawn");
	});

	test("a stranger cannot withdraw someone else's request (NotFound, no existence leak)", async () => {
		const { submissionId } = await makePendingSubmission("NotYours");

		expect(knowledgeBranchService.withdrawSubmission(stranger, submissionId)).rejects.toThrow();
		// Still open and untouched.
		expect((await statusOf(submissionId))?.status).toBe("pending");
	});

	test("an admin may withdraw on the author's behalf", async () => {
		const { submissionId } = await makePendingSubmission("AdminWithdraw");
		const res = await knowledgeBranchService.withdrawSubmission(admin, submissionId);
		expect(res.status).toBe("withdrawn");
		// The event still names the SUBMITTER, not the admin who acted.
		const row = await statusOf(submissionId);
		expect(row?.submitterUserId).toBe(author.userId);
	});

	test("an already-decided request cannot be withdrawn", async () => {
		const { entry, submissionId } = await makePendingSubmission("AlreadyApproved");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "approve" });
		expect((await statusOf(submissionId))?.status).toBe("approved");

		expect(knowledgeBranchService.withdrawSubmission(author, submissionId)).rejects.toThrow();
		expect((await statusOf(submissionId))?.status).toBe("approved");
		// The publish archived the personal entry; withdraw must not have resurrected it.
		const personal = await knowledgeBranchService.getMine(author, entry.id);
		expect(personal.status).toBe("archived");
	});

	test("a changes_requested request cannot be withdrawn (resubmit is its path)", async () => {
		const { submissionId } = await makePendingSubmission("BouncedNoWithdraw");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });

		expect(knowledgeBranchService.withdrawSubmission(author, submissionId)).rejects.toThrow();
		expect((await statusOf(submissionId))?.status).toBe("changes_requested");
	});
});

// ─── 2. resubmit ─────────────────────────────────────────────────────────

describe("resubmit after changes_requested", () => {
	test("creates a new request from the draft's CURRENT content with round + link", async () => {
		const { entry, submissionId } = await makePendingSubmission("Resubmittable");
		await knowledgeBranchService.review(admin, submissionId, {
			verdict: "request_changes",
			findings: [{ severity: "minor", message: "please expand the intro" }],
		});
		expect((await statusOf(submissionId))?.status).toBe("changes_requested");

		// The author fixes the draft. This edit must NOT close the bounced request (it is
		// `changes_requested`, not `pending`).
		await knowledgeBranchService.updateDraft(author, entry.id, {
			content: "Resubmittable body\nexpanded intro after review\n",
		});
		expect((await statusOf(submissionId))?.status).toBe("changes_requested");

		const next = await knowledgeBranchService.resubmit(author, submissionId, {
			changeNote: "expanded the intro",
		});
		expect(next?.status).toBe("pending");
		expect(next?.round).toBe(2);
		expect(next?.previousSubmissionId).toBe(submissionId);
		// Content comes from the LIVE draft, never from the bounced proposal.
		expect(next?.proposedContent).toContain("expanded intro after review");
		expect(next?.changeNote).toBe("expanded the intro");
		// Same personal entry, so the reviewer sees a chain rather than an orphan.
		expect(next?.draftId).toBe(entry.id);
	});

	test("without a note, the change note records the round", async () => {
		const { submissionId } = await makePendingSubmission("ResubmitNoNote");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });

		const next = await knowledgeBranchService.resubmit(author, submissionId, {});
		expect(next?.round).toBe(2);
		expect(next?.changeNote).toContain("round 2");
	});

	test("rounds keep incrementing across repeated bounces", async () => {
		const { submissionId } = await makePendingSubmission("ResubmitTwice");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });
		const round2 = await knowledgeBranchService.resubmit(author, submissionId, {});
		await knowledgeBranchService.review(admin, round2?.id as string, {
			verdict: "request_changes",
		});
		const round3 = await knowledgeBranchService.resubmit(author, round2?.id as string, {});
		expect(round3?.round).toBe(3);
		expect(round3?.previousSubmissionId).toBe(round2?.id);
	});

	test("round metadata reaches the author-scoped list (what the UI badge reads)", async () => {
		const { entry, submissionId } = await makePendingSubmission("ResubmitListed");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });
		const next = await knowledgeBranchService.resubmit(author, submissionId, {});

		// listSubmissionsForDraft uses a fixed column projection; the round scalars must be in
		// it, otherwise the badge silently never renders.
		const history = await knowledgeBranchService.listSubmissionsForDraft(author, entry.id);
		const row = history.find((s) => s.id === next?.id);
		expect(row).toBeDefined();
		expect(row?.round).toBe(2);
		expect(row?.previousSubmissionId).toBe(submissionId);
		// The bounced attempt is still listed as round 1, so the chain is readable.
		expect(history.find((s) => s.id === submissionId)?.round).toBe(1);
	});

	test("only a changes_requested request can be re-submitted", async () => {
		const { submissionId } = await makePendingSubmission("ResubmitPending");
		// Still pending → refused (a second open request would be a duplicate anyway).
		expect(knowledgeBranchService.resubmit(author, submissionId, {})).rejects.toThrow();
	});

	test("a stranger cannot re-submit someone else's bounced request", async () => {
		const { submissionId } = await makePendingSubmission("ResubmitNotYours");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });
		expect(knowledgeBranchService.resubmit(stranger, submissionId, {})).rejects.toThrow();
	});
});

// ─── 3. auto-invalidation semantics ──────────────────────────────────────

describe("updateDraft / rebaseDraft auto-invalidation", () => {
	test("updateDraft closes a PENDING request as superseded, not rejected", async () => {
		const { entry, submissionId } = await makePendingSubmission("SupersededByEdit");

		const seen: InvalidatedEvent[] = [];
		const onEvent = (e: InvalidatedEvent) => seen.push(e);
		eventBus.on("knowledge:submission_invalidated", onEvent);
		try {
			await knowledgeBranchService.updateDraft(author, entry.id, { content: "rewritten body\n" });
		} finally {
			eventBus.off("knowledge:submission_invalidated", onEvent);
		}

		const row = await statusOf(submissionId);
		// `superseded` distinguishes "the author replaced the content" from a reviewer's
		// `rejected` verdict — the whole point of the new status.
		expect(row?.status).toBe("superseded");
		expect(row?.verdict ?? null).toBeNull();
		expect(seen).toHaveLength(1);
		expect(seen[0]).toMatchObject({ submissionId, reason: "draft_updated" });
	});

	test("updateDraft does NOT close a CONFLICT request (divergence must stay visible)", async () => {
		const { entry, submissionId } = await makePendingSubmission("ConflictSurvivesEdit");
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, submissionId));

		const seen: InvalidatedEvent[] = [];
		const onEvent = (e: InvalidatedEvent) => seen.push(e);
		eventBus.on("knowledge:submission_invalidated", onEvent);
		try {
			await knowledgeBranchService.updateDraft(author, entry.id, { content: "edited anyway\n" });
		} finally {
			eventBus.off("knowledge:submission_invalidated", onEvent);
		}

		// Still in conflict: an edit must not silently bury an unresolved divergence.
		expect((await statusOf(submissionId))?.status).toBe("conflict");
		expect(seen).toHaveLength(0);
	});

	test("rebaseDraft closes a PENDING request as superseded and spares a CONFLICT one", async () => {
		// Linked entry so there is a main to drift from and rebase onto.
		const base = [
			"# Title",
			"",
			"intro one",
			"intro two",
			"",
			"## Section",
			"detail a",
			"detail b",
			"",
			"## Footer",
			"closing",
			"",
		].join("\n");
		const globalEntry = await knowledgeService.createEntry({
			collectionId,
			title: `RebaseSupersede ${TAG}`,
			content: base,
		});
		const draft = await knowledgeBranchService.createDraft(author, globalEntry.id, {});
		// Edit the footer only, so the three-way merge stays clean.
		await knowledgeBranchService.updateDraft(author, draft.id, {
			content: base.replace("closing", "closing\nmy footer line"),
		});
		const pending = await knowledgeBranchService.submitForReview(author, draft.id, {});
		const pendingId = pending?.id as string;
		// Main advances in a different region → the draft drifts without conflicting.
		await knowledgeService.addRevision(globalEntry.id, {
			content: base.replace("intro one", "intro one (revised)"),
		});

		const res = await knowledgeBranchService.rebaseDraft(author, draft.id);
		expect(res.ok).toBe(true);
		expect((await statusOf(pendingId))?.status).toBe("superseded");

		// Now the conflict case: a fresh open request forced into `conflict`, then another
		// rebase. The rebase itself is a no-op (already on latest main), so assert on a second
		// drift cycle to keep the rebase meaningful.
		const second = await knowledgeBranchService.submitForReview(author, draft.id, {});
		const secondId = second?.id as string;
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, secondId));
		await knowledgeService.addRevision(globalEntry.id, {
			content: base.replace("intro one", "intro one (revised twice)"),
		});
		const res2 = await knowledgeBranchService.rebaseDraft(author, draft.id);
		expect(res2.ok).toBe(true);
		// Untouched by the rebase, exactly like updateDraft.
		expect((await statusOf(secondId))?.status).toBe("conflict");
	});
});

// ─── 4. rebase strategy=theirs ───────────────────────────────────────────

describe("rebaseDraft strategy=theirs", () => {
	test("replaces the draft with current main and advances the base", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `TakeMain ${TAG}`,
			content: "original line\n",
		});
		const draft = await knowledgeBranchService.createDraft(author, entry.id, {});
		await knowledgeBranchService.updateDraft(author, draft.id, {
			content: "my local edit of the same line\n",
		});
		// Main edits the SAME line → the default merge strategy would conflict.
		await knowledgeService.addRevision(entry.id, { content: "main edit of the same line\n" });

		// Baseline: the merge strategy really does conflict here (so "theirs" is the escape).
		const asMerge = await knowledgeBranchService.rebaseDraft(author, draft.id);
		expect(asMerge.ok).toBe(false);

		const res = await knowledgeBranchService.rebaseDraft(author, draft.id, { strategy: "theirs" });
		expect(res.ok).toBe(true);
		if (res.ok) {
			expect(res.rebased).toBe(true);
			expect(res.strategy).toBe("theirs");
		}

		// The draft now IS main, and it is no longer drifted.
		const drift = await knowledgeBranchService.getDraftDrift(author, entry.id);
		expect(drift.hasDraft).toBe(true);
		if (drift.hasDraft) {
			expect(drift.drifted).toBe(false);
			expect(drift.draft).toBe("main edit of the same line\n");
			expect(drift.baseRevisionId).toBe(drift.currentRevisionId);
		}
		// The author's local edit is gone — that is the documented trade-off.
		const saved = await knowledgeBranchService.getMine(author, draft.id);
		expect(saved.content).not.toContain("my local edit");
	});

	test("default strategy still three-way merges (unchanged behaviour)", async () => {
		const base = [
			"# Doc",
			"",
			"paragraph one",
			"paragraph two",
			"",
			"## Tail",
			"tail line",
			"",
		].join("\n");
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `DefaultMerge ${TAG}`,
			content: base,
		});
		const draft = await knowledgeBranchService.createDraft(author, entry.id, {});
		await knowledgeBranchService.updateDraft(author, draft.id, {
			content: base.replace("tail line", "tail line\nmy tail addition"),
		});
		await knowledgeService.addRevision(entry.id, {
			content: base.replace("paragraph one", "paragraph one (edited)"),
		});

		const res = await knowledgeBranchService.rebaseDraft(author, draft.id);
		expect(res.ok).toBe(true);
		if (res.ok) expect(res.strategy).toBe("merge");
		// BOTH sides survive a clean merge — "theirs" is opt-in, never the default.
		const drift = await knowledgeBranchService.getDraftDrift(author, entry.id);
		if (drift.hasDraft) {
			expect(drift.draft).toContain("paragraph one (edited)");
			expect(drift.draft).toContain("my tail addition");
		}
	});

	test("strategy=theirs on a standalone entry is refused (no main to take)", async () => {
		const standalone = await knowledgeBranchService.createStandalone(author, {
			title: `TakeMainStandalone ${TAG}`,
			content: "body\n",
		});
		expect(
			knowledgeBranchService.rebaseDraft(author, standalone.id, { strategy: "theirs" }),
		).rejects.toThrow();
	});
});

// ─── 5. my review scope ──────────────────────────────────────────────────

describe("getMyReviewScope", () => {
	test("an admin is reported as unconditional, without enumerating grants", async () => {
		const scope = await knowledgeBranchService.getMyReviewScope(admin);
		expect(scope.isAdmin).toBe(true);
	});

	test("a plain user with no grants has an empty scope", async () => {
		const scope = await knowledgeBranchService.getMyReviewScope(stranger);
		expect(scope.isAdmin).toBe(false);
		expect(scope.reviewTags).toEqual([]);
		// No write grant and owns nothing → cannot publish into any collection.
		expect(scope.collections).toEqual([]);
	});

	test("a held review grant surfaces with its tag name", async () => {
		const tagId = generateId();
		await db.insert(knowledgeTags).values({
			id: tagId,
			name: `rl-review-tag-${TAG}`,
			collectionId: null,
			typeId: null,
			controlled: true,
			createdAt: new Date().toISOString(),
		});
		const reviewerId = generateId();
		await db.insert(users).values({
			id: reviewerId,
			username: `rl-reviewer-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await db.insert(knowledgeGrants).values({
			id: generateId(),
			collectionId: null,
			principalType: "user",
			principalId: reviewerId,
			grantType: "review",
			clearanceLevel: null,
			tagId,
			canWrite: false,
			createdAt: new Date().toISOString(),
		});

		const scope = await knowledgeBranchService.getMyReviewScope({
			userId: reviewerId,
			role: "user",
		});
		expect(scope.reviewTags.map((tg) => tg.id)).toContain(tagId);
		expect(scope.reviewTags.find((tg) => tg.id === tagId)?.name).toBe(`rl-review-tag-${TAG}`);
		// A review grant alone is not a write grant.
		expect(scope.collections).toEqual([]);
	});

	test("a collection write grant surfaces as a publishable collection", async () => {
		const writerId = generateId();
		await db.insert(users).values({
			id: writerId,
			username: `rl-writer-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await db.insert(knowledgeGrants).values({
			id: generateId(),
			collectionId,
			principalType: "user",
			principalId: writerId,
			grantType: "clearance",
			clearanceLevel: "public",
			tagId: null,
			canWrite: true,
			createdAt: new Date().toISOString(),
		});

		const scope = await knowledgeBranchService.getMyReviewScope({
			userId: writerId,
			role: "user",
		});
		expect(scope.collections.map((c) => c.id)).toContain(collectionId);
	});
});

// ─── 6. HTTP surface ─────────────────────────────────────────────────────

describe("HTTP endpoints", () => {
	test("POST /submissions/:id/withdraw closes an own request; a stranger gets 404", async () => {
		const { submissionId } = await makePendingSubmission("HttpWithdraw");

		// A non-submitter must not even learn it exists.
		const denied = await appFor(stranger).request(
			`/knowledge/submissions/${submissionId}/withdraw`,
			{ method: "POST", body: JSON.stringify({}), headers: { "content-type": "application/json" } },
		);
		expect(denied.status).toBe(404);
		expect((await statusOf(submissionId))?.status).toBe("pending");

		const res = await appFor(author).request(`/knowledge/submissions/${submissionId}/withdraw`, {
			method: "POST",
			body: JSON.stringify({ reason: "via http" }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(200);
		expect((await res.json()).status).toBe("withdrawn");
	});

	test("POST /submissions/:id/withdraw accepts an empty body", async () => {
		const { submissionId } = await makePendingSubmission("HttpWithdrawNoBody");
		const res = await appFor(author).request(`/knowledge/submissions/${submissionId}/withdraw`, {
			method: "POST",
		});
		expect(res.status).toBe(200);
	});

	test("POST /submissions/:id/resubmit returns 201 with the new round", async () => {
		const { submissionId } = await makePendingSubmission("HttpResubmit");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "request_changes" });

		const res = await appFor(author).request(`/knowledge/submissions/${submissionId}/resubmit`, {
			method: "POST",
			body: JSON.stringify({ changeNote: "fixed" }),
			headers: { "content-type": "application/json" },
		});
		expect(res.status).toBe(201);
		const body = await res.json();
		expect(body.round).toBe(2);
		expect(body.previousSubmissionId).toBe(submissionId);
		expect(body.status).toBe("pending");
	});

	test("POST /drafts/:id/rebase?strategy=theirs takes main; an unknown strategy is 400", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `HttpTakeMain ${TAG}`,
			content: "http original\n",
		});
		const draft = await knowledgeBranchService.createDraft(author, entry.id, {});
		await knowledgeBranchService.updateDraft(author, draft.id, { content: "http mine\n" });
		await knowledgeService.addRevision(entry.id, { content: "http main moved\n" });

		const bad = await appFor(author).request(
			`/knowledge/drafts/${draft.id}/rebase?strategy=nonsense`,
			{ method: "POST" },
		);
		expect(bad.status).toBe(400);

		const res = await appFor(author).request(
			`/knowledge/drafts/${draft.id}/rebase?strategy=theirs`,
			{
				method: "POST",
			},
		);
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.ok).toBe(true);
		expect(body.strategy).toBe("theirs");
		expect((await knowledgeBranchService.getMine(author, draft.id)).content).toBe(
			"http main moved\n",
		);
	});

	test("GET /my-review-scope is per-caller (no admin leak to a plain user)", async () => {
		const asAdmin = await appFor(admin).request("/knowledge/my-review-scope");
		expect(asAdmin.status).toBe(200);
		expect((await asAdmin.json()).isAdmin).toBe(true);

		const asUser = await appFor(stranger).request("/knowledge/my-review-scope");
		expect(asUser.status).toBe(200);
		const body = await asUser.json();
		expect(body.isAdmin).toBe(false);
		expect(body.reviewTags).toEqual([]);
	});
});

// ─── 7. resolveConflict self-review guard ─────────────────────────────────

describe("resolveConflict self-review guard", () => {
	let reviewTagId: string;

	/** Grant the author a review tag so canReview passes, letting the self-review guard fire. */
	beforeAll(async () => {
		reviewTagId = generateId();
		await db.insert(knowledgeTags).values({
			id: reviewTagId,
			name: `rl-self-resolve-tag-${TAG}`,
			collectionId: null,
			typeId: null,
			controlled: true,
			createdAt: new Date().toISOString(),
		});
		await db.insert(knowledgeGrants).values({
			id: generateId(),
			collectionId: null,
			principalType: "user",
			principalId: author.userId,
			grantType: "review",
			clearanceLevel: null,
			tagId: reviewTagId,
			canWrite: false,
			createdAt: new Date().toISOString(),
		});
	});

	/** Create a linked submission in `conflict` state so resolveConflict is callable. */
	async function makeConflictSubmission() {
		// A linked entry with the review tag so canReview passes for the author.
		const globalEntry = await knowledgeService.createEntry({
			collectionId,
			title: `SelfResolve ${TAG} ${Date.now()}`,
			content: "base content\n",
		});
		// Assign the review tag so the author (who holds a review grant for it) passes canReview.
		await knowledgeService.updateEntryAcl(globalEntry.id, { reviewTags: [reviewTagId] });
		const draft = await knowledgeBranchService.createDraft(author, globalEntry.id, {});
		await knowledgeBranchService.updateDraft(author, draft.id, {
			content: "author edit\n",
		});
		const submission = await knowledgeBranchService.submitForReview(author, draft.id, {
			changeNote: "self-resolve test",
		});
		const submissionId = submission?.id as string;
		// Force to conflict state (normally arises from three-way merge divergence).
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, submissionId));
		return { submissionId, globalEntry };
	}

	test("the submitter cannot resolve their own conflicted submission", async () => {
		const { submissionId } = await makeConflictSubmission();

		await expect(
			knowledgeBranchService.resolveConflict(author, submissionId, {
				resolvedContent: "sneaky self-approved content\n",
			}),
		).rejects.toThrow("You cannot resolve your own submission");

		// The submission must remain in conflict — nothing was merged.
		expect((await statusOf(submissionId))?.status).toBe("conflict");
	});

	test("an admin can resolve even their own submission (admin exemption)", async () => {
		// Create a submission where the admin is the submitter.
		const globalEntry = await knowledgeService.createEntry({
			collectionId,
			title: `AdminSelfResolve ${TAG} ${Date.now()}`,
			content: "admin base\n",
		});
		const draft = await knowledgeBranchService.createDraft(admin, globalEntry.id, {});
		await knowledgeBranchService.updateDraft(admin, draft.id, {
			content: "admin edit\n",
		});
		const submission = await knowledgeBranchService.submitForReview(admin, draft.id, {
			changeNote: "admin self-resolve",
		});
		const submissionId = submission?.id as string;
		await db
			.update(knowledgeSubmissions)
			.set({ status: "conflict" })
			.where(eq(knowledgeSubmissions.id, submissionId));

		const res = await knowledgeBranchService.resolveConflict(admin, submissionId, {
			resolvedContent: "admin resolved content\n",
		});
		expect(res.status).toBe("approved");
		expect(res.mergedRevisionId).toBeTruthy();
	});
});
