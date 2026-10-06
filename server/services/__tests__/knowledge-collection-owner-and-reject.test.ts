/**
 * Two closures that make the knowledge lifecycle self-consistent:
 *
 * 1. **Collection management is owner-or-admin, not admin-only.** Any authenticated user may
 *    CREATE a collection and becomes its owner, but `PATCH`/`DELETE /collections/:id` used to be
 *    `requireAdmin` — so an owner could not rename or remove what they had just created. The
 *    service already had the right gate (`assertCanManageCollection`); only the routes were
 *    wrong. The ACL axes stay admin-only, since an owner must not be able to declassify.
 *
 * 2. **`reject` is a real verdict.** The `rejected` status existed in the schema but nothing
 *    could produce it: the verdict enum only had approve / request_changes / comment_only, so a
 *    reviewer who considered a proposal simply wrong had to say "please revise" instead. Reject
 *    is terminal (no resubmit), which is precisely what distinguishes it from request_changes.
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME, driving the actual Hono routes so
 * the middleware gating is exercised (not just the service layer).
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { knowledgeCollections, knowledgeSubmissions, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { knowledgeRoutes } from "../../routes/knowledge";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeService } from "../knowledge-service";

const TAG = Date.now();

const owner = { userId: "", role: "user" as const };
const other = { userId: "", role: "user" as const };
const admin = { userId: "", role: "admin" as const };

/** Hono app mounting the real routes behind a fake principal (mirrors knowledge-bulk-grant). */
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

beforeAll(async () => {
	const now = new Date().toISOString();
	const ids = [generateId(), generateId(), generateId()];
	await db.insert(users).values([
		{ id: ids[0], username: `co-owner-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: ids[1], username: `co-other-${TAG}`, passwordHash: "x", role: "user", createdAt: now },
		{ id: ids[2], username: `co-admin-${TAG}`, passwordHash: "x", role: "admin", createdAt: now },
	]);
	owner.userId = ids[0];
	other.userId = ids[1];
	admin.userId = ids[2];
});

// ─── 1. Collection management: owner-or-admin ────────────────────────────

describe("collection management is owner-or-admin", () => {
	async function ownedCollection(label: string) {
		return knowledgeService.createCollection({
			name: `${label} ${TAG}`,
			ownerUserId: owner.userId,
		});
	}

	test("the owner can rename their own collection (no admin role needed)", async () => {
		const col = await ownedCollection("OwnerRename");
		const res = await appFor(owner).request(`/knowledge/collections/${col.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: `Renamed ${TAG}`, description: "by owner" }),
		});
		expect(res.status).toBe(200);
		const fresh = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, col.id),
		});
		expect(fresh?.name).toBe(`Renamed ${TAG}`);
		expect(fresh?.description).toBe("by owner");
	});

	test("a non-owner plain user cannot rename it, and the collection is unchanged", async () => {
		const col = await ownedCollection("StrangerRename");
		const res = await appFor(other).request(`/knowledge/collections/${col.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: `Hijacked ${TAG}` }),
		});
		// Readable (public) but not manageable → 400, not 404.
		expect(res.status).toBe(400);
		const fresh = await db.query.knowledgeCollections.findFirst({
			where: eq(knowledgeCollections.id, col.id),
		});
		expect(fresh?.name).toBe(`StrangerRename ${TAG}`);
	});

	test("an admin can still manage a collection they do not own", async () => {
		const col = await ownedCollection("AdminRename");
		const res = await appFor(admin).request(`/knowledge/collections/${col.id}`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ name: `AdminTouched ${TAG}` }),
		});
		expect(res.status).toBe(200);
	});

	test("the owner can delete their own collection; a stranger cannot", async () => {
		const victim = await ownedCollection("StrangerDelete");
		const denied = await appFor(other).request(`/knowledge/collections/${victim.id}`, {
			method: "DELETE",
		});
		expect(denied.status).toBe(400);
		expect(
			await db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.id, victim.id),
			}),
		).toBeTruthy();

		const mine = await ownedCollection("OwnerDelete");
		const ok = await appFor(owner).request(`/knowledge/collections/${mine.id}`, {
			method: "DELETE",
		});
		expect(ok.status).toBe(200);
		expect(
			await db.query.knowledgeCollections.findFirst({
				where: eq(knowledgeCollections.id, mine.id),
			}),
		).toBeUndefined();
	});

	test("the ACL axes stay admin-only — an owner cannot declassify their collection", async () => {
		const col = await ownedCollection("OwnerAcl");
		const res = await appFor(owner).request(`/knowledge/collections/${col.id}/acl`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ classificationLevel: "public" }),
		});
		// requireAdmin rejects before the handler runs.
		expect(res.status).toBe(403);
	});
});

// ─── 2. reject verdict ───────────────────────────────────────────────────

describe("reject verdict", () => {
	let collectionId: string;

	beforeAll(async () => {
		const col = await knowledgeService.createCollection({ name: `reject-${TAG}` });
		collectionId = col.id;
	});

	/** A standalone personal entry with an open pending publish request, authored by `owner`. */
	async function pendingSubmission(label: string) {
		const created = await knowledgeBranchService.createStandalone(owner, {
			title: `${label} ${TAG}`,
			content: `${label} body\n`,
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(owner, created.id, {});
		return { personalEntryId: created.id, submissionId: submission?.id as string };
	}

	test("rejecting moves the request to `rejected` and records the verdict", async () => {
		const { submissionId } = await pendingSubmission("Rejected");
		const res = await knowledgeBranchService.review(admin, submissionId, {
			verdict: "reject",
			findings: [{ severity: "major", message: "duplicates an existing entry" }],
		});
		expect(res).toMatchObject({ status: "rejected", verdict: "reject" });

		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("rejected");
		expect(row?.verdict).toBe("reject");
		expect(row?.reviewerUserId).toBe(admin.userId);
		expect(row?.reviewedAt).toBeTruthy();
	});

	test("a rejection keeps the author's personal entry, so a fresh proposal is still possible", async () => {
		const { personalEntryId, submissionId } = await pendingSubmission("RejectKeepsEntry");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "reject" });

		const mine = await knowledgeBranchService.getMine(owner, personalEntryId);
		expect(mine.status).toBe("active");
		// Rejection closes the REQUEST, not the work: publishing again is allowed because the
		// rejected row is no longer "open".
		const again = await knowledgeBranchService.submitForReview(owner, personalEntryId, {});
		expect(again?.status).toBe("pending");
		expect(again?.id).not.toBe(submissionId);
	});

	test("a rejected request is terminal: no resubmit, no withdraw", async () => {
		const { submissionId } = await pendingSubmission("RejectTerminal");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "reject" });

		// This is the whole point of reject vs request_changes.
		expect(knowledgeBranchService.resubmit(owner, submissionId, {})).rejects.toThrow();
		expect(knowledgeBranchService.withdrawSubmission(owner, submissionId)).rejects.toThrow();

		const row = await db.query.knowledgeSubmissions.findFirst({
			where: eq(knowledgeSubmissions.id, submissionId),
		});
		expect(row?.status).toBe("rejected");
	});

	test("a rejected request cannot be reviewed a second time", async () => {
		const { submissionId } = await pendingSubmission("RejectOnce");
		await knowledgeBranchService.review(admin, submissionId, { verdict: "reject" });
		expect(
			knowledgeBranchService.review(admin, submissionId, { verdict: "approve" }),
		).rejects.toThrow();
	});

	test("HTTP: POST /submissions/:id/review accepts verdict=reject", async () => {
		const { submissionId } = await pendingSubmission("RejectHttp");
		const res = await appFor(admin).request(`/knowledge/submissions/${submissionId}/review`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ verdict: "reject" }),
		});
		expect(res.status).toBe(200);
		expect((await res.json()) as { status?: string }).toMatchObject({ status: "rejected" });
	});

	test("HTTP: an unknown verdict is still rejected by Zod", async () => {
		const { submissionId } = await pendingSubmission("BadVerdict");
		const res = await appFor(admin).request(`/knowledge/submissions/${submissionId}/review`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ verdict: "nuke" }),
		});
		expect(res.status).toBe(400);
	});

	test("request_changes still bounces back (reject did not replace it)", async () => {
		const { submissionId } = await pendingSubmission("StillBounces");
		const res = await knowledgeBranchService.review(admin, submissionId, {
			verdict: "request_changes",
		});
		expect(res).toMatchObject({ status: "changes_requested" });
		// …and that path remains resubmittable, unlike reject.
		const next = await knowledgeBranchService.resubmit(owner, submissionId, {});
		expect(next?.status).toBe("pending");
	});
});
