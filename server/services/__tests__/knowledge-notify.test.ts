/**
 * Knowledge notification bridge tests (WP1).
 *
 * Verifies that the publish/review lifecycle emits the right event-bus events and that
 * knowledge-notify routes them to the right users. The four paths the plan pinned:
 *
 *  1. submit           → `knowledge:submission_created`, pushed to candidate REVIEWERS
 *  2. approve          → `knowledge:submission_reviewed` + `knowledge:entry_published`
 *  3. request_changes  → `knowledge:submission_reviewed` (status changes_requested)
 *  4. updateDraft      → `knowledge:submission_invalidated` for the auto-voided submission
 *
 * Plus the two safety properties:
 *  - the SUBMITTER never appears in the "needs your review" target set (self-review is
 *    refused by the service, so a reviewer push to them would be wrong)
 *  - reviewer resolution is BOUNDED: above the cap it degrades to admins only rather
 *    than scanning the whole users table
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as the other
 * knowledge-*.test.ts files). Unique ids/names per run avoid collisions with seeded data.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-notify.test.ts
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { knowledgeGrantRows } from "../../../tests/fixtures/knowledge-grants";
import { db } from "../../db";
import { aclGrants, knowledgeTags, users } from "../../db/schema";
import { eventBus, type NarraForkEvent } from "../../lib/event-bus";
import { generateId } from "../../lib/id";
import {
	BATCH_CAPS_USER_LIMIT,
	knowledgeAcl,
	type Principal,
	resolveCapsForAllUsers,
} from "../knowledge-acl";
import { knowledgeBranchService } from "../knowledge-branch-service";
import {
	initKnowledgeNotify,
	resolveReviewerUserIds,
	setKnowledgeNotifyPush,
} from "../knowledge-notify";
import { knowledgeService } from "../knowledge-service";

/**
 * Seed knowledge grants into the unified `acl_grants` table.
 *
 * Knowledge authorization no longer reads `knowledge_grants`, so a fixture writing
 * there would grant nothing. Input stays in the knowledge vocabulary; the shared
 * fixture translates it (a credential row, plus a separate write row for canWrite).
 */
async function seedKnowledgeGrants(
	seeds: Parameters<typeof knowledgeGrantRows>[0] | Parameters<typeof knowledgeGrantRows>[0][],
): Promise<void> {
	const list = Array.isArray(seeds) ? seeds : [seeds];
	for (const seed of list) {
		for (const row of knowledgeGrantRows(seed)) {
			await db.insert(aclGrants).values(row as never);
		}
	}
}

const TAG = Date.now();
const P = (id: string, role: "admin" | "user" = "user"): Principal => ({ userId: id, role });

let adminId: string;
let submitterId: string;
let reviewerId: string; // holds the review grant for the entry's review tag
let outsiderId: string; // no review grant → must never be a reviewer target
let collectionId: string;
let reviewTagId: string;

// ─── Event + push capture ────────────────────────────────────────────────

type KnowledgeEvent = Extract<NarraForkEvent, { type: `knowledge:${string}` }>;

const KNOWLEDGE_EVENT_TYPES = [
	"knowledge:submission_created",
	"knowledge:submission_reviewed",
	"knowledge:submission_invalidated",
	"knowledge:entry_published",
	// Library-side signals (not tied to a submission): main moved under a personal version,
	// authorization changed, ownership moved.
	"knowledge:entry_drifted",
	"knowledge:acl_changed",
	"knowledge:owner_transferred",
] as const;

const events: KnowledgeEvent[] = [];
const pushes: Array<{ userId: string; message: Record<string, unknown> }> = [];

function eventsOfType<T extends KnowledgeEvent["type"]>(
	type: T,
): Extract<KnowledgeEvent, { type: T }>[] {
	return events.filter((e): e is Extract<KnowledgeEvent, { type: T }> => e.type === type);
}

/** Push targets for one reason, split by the recipient's role in the flow. */
function pushTargets(reason: string, role: "reviewer" | "submitter"): string[] {
	return pushes
		.filter((p) => p.message.reason === reason && p.message.role === role)
		.map((p) => p.userId);
}

/** Wait for the async notify handlers (they are fire-and-forget by design). */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 20));
}

async function makeUser(role: "admin" | "user", label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(6)}`,
		passwordHash: "x",
		role,
		createdAt: new Date().toISOString(),
	});
	return id;
}

beforeAll(async () => {
	adminId = await makeUser("admin", "kn-admin");
	submitterId = await makeUser("user", "kn-submitter");
	reviewerId = await makeUser("user", "kn-reviewer");
	outsiderId = await makeUser("user", "kn-outsider");

	const col = await knowledgeService.createCollection({ name: `notify-${TAG}` });
	collectionId = col.id;

	// A review tag + a review grant for exactly one user, so canReview discriminates.
	reviewTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: reviewTagId,
		name: `notify-review-${TAG}`,
		collectionId: null,
		typeId: null,
		controlled: false,
		createdAt: new Date().toISOString(),
	});
	await seedKnowledgeGrants({
		id: generateId(),
		collectionId: null,
		principalType: "user",
		principalId: reviewerId,
		grantType: "review",
		clearanceLevel: null,
		tagId: reviewTagId,
		canWrite: false,
		createdAt: new Date().toISOString(),
	});

	// Capture events straight off the bus, and intercept the WS push.
	for (const type of KNOWLEDGE_EVENT_TYPES) {
		eventBus.on(type, (e) => {
			events.push(e as KnowledgeEvent);
		});
	}
	setKnowledgeNotifyPush((userId, message) => {
		pushes.push({ userId, message: message as unknown as Record<string, unknown> });
	});
	initKnowledgeNotify();
});

afterEach(() => {
	events.length = 0;
	pushes.length = 0;
});

afterAll(() => {
	setKnowledgeNotifyPush(null);
});

/** A linked entry whose review tag is held only by `reviewerId`. */
async function makeReviewableEntry(label: string) {
	const entry = await knowledgeService.createEntry({
		collectionId,
		title: `${label} ${TAG} ${generateId(4)}`,
		content: "original body\n",
	});
	// Clear the owner: an owner short-circuits canReview, which would mask the tag check.
	await knowledgeService.updateEntryAcl(entry.id, {
		reviewTags: [reviewTagId],
		ownerUserId: null,
	});
	return entry;
}

// ─── 1. submit ──────────────────────────────────────────────────────────

describe("submit for review", () => {
	test("emits submission_created and pushes to reviewers, never to the submitter", async () => {
		const entry = await makeReviewableEntry("Submit");
		const draft = await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "original body\nmy addition\n",
		});
		events.length = 0;
		pushes.length = 0;

		const submission = await knowledgeBranchService.submitForReview(P(submitterId), draft.id, {});
		await settle();

		const created = eventsOfType("knowledge:submission_created");
		expect(created).toHaveLength(1);
		expect(created[0].submissionId).toBe(submission?.id as string);
		expect(created[0].entryId).toBe(entry.id);
		expect(created[0].collectionId).toBeNull();
		expect(created[0].submitterUserId).toBe(submitterId);

		const targets = pushTargets("submission_created", "reviewer");
		// The review-tag holder and the admin can review; the outsider cannot.
		expect(targets).toContain(reviewerId);
		expect(targets).toContain(adminId);
		expect(targets).not.toContain(outsiderId);
		// Self-review is refused by the service, so the submitter is never a target.
		expect(targets).not.toContain(submitterId);
		// A submitter push for `submission_created` would be meaningless noise.
		expect(pushTargets("submission_created", "submitter")).toHaveLength(0);
	});

	test("standalone publish resolves reviewers from the TARGET COLLECTION, not an entry", async () => {
		const standalone = await knowledgeBranchService.createStandalone(P(submitterId), {
			title: `Standalone ${TAG} ${generateId(4)}`,
			content: "brand new knowledge\n",
			targetCollectionId: collectionId,
		});
		events.length = 0;
		pushes.length = 0;

		const submission = await knowledgeBranchService.submitForReview(
			P(submitterId),
			standalone.id,
			{},
		);
		await settle();

		const created = eventsOfType("knowledge:submission_created");
		expect(created).toHaveLength(1);
		expect(created[0].entryId).toBeNull();
		expect(created[0].collectionId).toBe(collectionId);
		expect(created[0].submissionId).toBe(submission?.id as string);

		// Standalone publish needs collection WRITE; only the admin has it here.
		const targets = pushTargets("submission_created", "reviewer");
		expect(targets).toContain(adminId);
		expect(targets).not.toContain(submitterId);
		// A review grant does not confer collection write, so the reviewer is excluded.
		expect(targets).not.toContain(reviewerId);
		expect(targets).not.toContain(outsiderId);
	});
});

// ─── 2. approve ─────────────────────────────────────────────────────────

describe("approve", () => {
	test("emits submission_reviewed + entry_published and tells the submitter", async () => {
		const entry = await makeReviewableEntry("Approve");
		const draft = await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "original body\napproved addition\n",
		});
		const submission = await knowledgeBranchService.submitForReview(P(submitterId), draft.id, {});
		await settle();
		events.length = 0;
		pushes.length = 0;

		const res = await knowledgeBranchService.review(P(reviewerId), submission?.id as string, {
			verdict: "approve",
		});
		expect(res.status).toBe("approved");
		await settle();

		const reviewed = eventsOfType("knowledge:submission_reviewed");
		expect(reviewed).toHaveLength(1);
		expect(reviewed[0].status).toBe("approved");
		expect(reviewed[0].submitterUserId).toBe(submitterId);
		expect(reviewed[0].reviewerUserId).toBe(reviewerId);

		const published = eventsOfType("knowledge:entry_published");
		expect(published).toHaveLength(1);
		expect(published[0].entryId).toBe(entry.id);
		expect(published[0].submissionId).toBe(submission?.id as string);
		expect(published[0].submitterUserId).toBe(submitterId);

		// The submitter learns the outcome on both reasons.
		expect(pushTargets("submission_reviewed", "submitter")).toEqual([submitterId]);
		expect(pushTargets("entry_published", "submitter")).toEqual([submitterId]);
	});

	test("approving a STANDALONE publish emits entry_published with the NEW entry id", async () => {
		const standalone = await knowledgeBranchService.createStandalone(P(submitterId), {
			title: `StandalonePublish ${TAG} ${generateId(4)}`,
			content: "new global knowledge\n",
			targetCollectionId: collectionId,
		});
		const submission = await knowledgeBranchService.submitForReview(
			P(submitterId),
			standalone.id,
			{},
		);
		await settle();
		events.length = 0;
		pushes.length = 0;

		const res = await knowledgeBranchService.review(P(adminId, "admin"), submission?.id as string, {
			verdict: "approve",
		});
		await settle();

		const newEntryId = (res as { entryId?: string }).entryId;
		expect(newEntryId).toBeTruthy();
		const published = eventsOfType("knowledge:entry_published");
		expect(published).toHaveLength(1);
		// The event must carry the entry created by the publish, not null.
		expect(published[0].entryId).toBe(newEntryId as string);
		expect(pushTargets("entry_published", "submitter")).toEqual([submitterId]);
	});
});

// ─── 3. request_changes (bounce) ─────────────────────────────────────────

describe("request changes", () => {
	test("emits submission_reviewed with changes_requested and notifies the submitter", async () => {
		const entry = await makeReviewableEntry("Bounce");
		const draft = await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "original body\nneeds work\n",
		});
		const submission = await knowledgeBranchService.submitForReview(P(submitterId), draft.id, {});
		await settle();
		events.length = 0;
		pushes.length = 0;

		await knowledgeBranchService.review(P(reviewerId), submission?.id as string, {
			verdict: "request_changes",
			findings: [{ severity: "major", message: "needs a rewrite" }],
		});
		await settle();

		const reviewed = eventsOfType("knowledge:submission_reviewed");
		expect(reviewed).toHaveLength(1);
		expect(reviewed[0].status).toBe("changes_requested");
		expect(reviewed[0].reviewerUserId).toBe(reviewerId);
		// No merge happened → no publish event.
		expect(eventsOfType("knowledge:entry_published")).toHaveLength(0);

		expect(pushTargets("submission_reviewed", "submitter")).toEqual([submitterId]);
		// Reviewers get a badge refresh too (the row left their pending queue).
		const reviewerTargets = pushTargets("submission_reviewed", "reviewer");
		expect(reviewerTargets).not.toContain(submitterId);
	});
});

// ─── 4. updateDraft auto-invalidation ────────────────────────────────────

describe("draft update invalidates an open submission", () => {
	test("emits submission_invalidated for the auto-voided submission", async () => {
		const entry = await makeReviewableEntry("Invalidate");
		const draft = await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "original body\nfirst attempt\n",
		});
		const submission = await knowledgeBranchService.submitForReview(P(submitterId), draft.id, {});
		await settle();
		events.length = 0;
		pushes.length = 0;

		// Editing the draft silently voids the queued submission — the submitter must hear it.
		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "original body\nsecond attempt\n",
		});
		await settle();

		const invalidated = eventsOfType("knowledge:submission_invalidated");
		expect(invalidated).toHaveLength(1);
		expect(invalidated[0].submissionId).toBe(submission?.id as string);
		expect(invalidated[0].submitterUserId).toBe(submitterId);
		expect(invalidated[0].reason).toBe("draft_updated");

		expect(pushTargets("submission_invalidated", "submitter")).toEqual([submitterId]);
		// Reviewers' badges are cleared as well, and the submitter is not among them.
		expect(pushTargets("submission_invalidated", "reviewer")).not.toContain(submitterId);
	});

	test("editing a draft with NO open submission emits nothing", async () => {
		const entry = await makeReviewableEntry("NoOpen");
		const draft = await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		events.length = 0;
		pushes.length = 0;

		await knowledgeBranchService.updateDraft(P(submitterId), draft.id, {
			content: "just editing my copy\n",
		});
		await settle();

		expect(events).toHaveLength(0);
		expect(pushes).toHaveLength(0);
	});
});

// ─── Reviewer resolution bounds + ACL reuse ──────────────────────────────

describe("reviewer resolution is bounded and ACL-derived", () => {
	test("resolveCapsForAllUsers never exceeds the population cap", async () => {
		const { byUserId, truncated } = await resolveCapsForAllUsers();
		// The invariant that matters: the batch is bounded regardless of table size.
		expect(byUserId.size).toBeLessThanOrEqual(BATCH_CAPS_USER_LIMIT);
		// If the cap WERE hit, the population must have degraded to admins only.
		if (truncated) {
			for (const caps of byUserId.values()) expect(caps.isAdmin).toBe(true);
		}
	});

	test("an explicit low limit truncates to ADMINS ONLY instead of guessing", async () => {
		// limit=1 is below the seeded user count → the resolver must degrade, and the
		// degraded population is admins (who can review everything) rather than a
		// random slice of users.
		const { byUserId, truncated } = await resolveCapsForAllUsers(1);
		expect(truncated).toBe(true);
		expect(byUserId.size).toBeLessThanOrEqual(1);
		for (const caps of byUserId.values()) expect(caps.isAdmin).toBe(true);
	});

	test("resolveReviewerUserIds matches canReview and excludes the submitter", async () => {
		const entry = await makeReviewableEntry("Resolve");
		const reviewers = await resolveReviewerUserIds({
			entryId: entry.id,
			collectionId: null,
			submitterUserId: submitterId,
		});
		expect(reviewers).toContain(reviewerId);
		expect(reviewers).toContain(adminId);
		expect(reviewers).not.toContain(outsiderId);
		expect(reviewers).not.toContain(submitterId);

		// Cross-check against the ACL predicate the review path itself uses: every
		// resolved reviewer must independently pass canReview. The role is read from
		// the DB rather than assumed — the shared test DB may hold users seeded by
		// sibling knowledge-*.test.ts files, including other admins.
		const aclEntry = {
			id: entry.id,
			collectionId,
			ownerUserId: null,
			classificationLevel: null,
			controlledTagsJson: null,
			reviewTagsJson: [reviewTagId],
		};
		for (const userId of reviewers) {
			const row = await db.query.users.findFirst({
				where: eq(users.id, userId),
				columns: { role: true },
			});
			const caps = await knowledgeAcl.resolvePrincipalCaps(P(userId, row?.role ?? "user"));
			expect(knowledgeAcl.canReview(caps, aclEntry)).toBe(true);
		}
	});

	test("even the submitter is excluded when they would otherwise be a valid reviewer", async () => {
		// The submitter holds the review grant here, so only the self-review exclusion
		// can keep them out of the target set.
		const selfReviewerId = reviewerId;
		const entry = await makeReviewableEntry("SelfReview");
		const reviewers = await resolveReviewerUserIds({
			entryId: entry.id,
			collectionId: null,
			submitterUserId: selfReviewerId,
		});
		expect(reviewers).not.toContain(selfReviewerId);
		expect(reviewers).toContain(adminId);
	});

	test("a missing entry / collection resolves to no reviewers (no existence leak)", async () => {
		expect(
			await resolveReviewerUserIds({
				entryId: generateId(),
				collectionId: null,
				submitterUserId: submitterId,
			}),
		).toEqual([]);
		expect(
			await resolveReviewerUserIds({
				entryId: null,
				collectionId: generateId(),
				submitterUserId: submitterId,
			}),
		).toEqual([]);
		// Neither target (a standalone publish with no collection) is not reviewable.
		expect(
			await resolveReviewerUserIds({
				entryId: null,
				collectionId: null,
				submitterUserId: submitterId,
			}),
		).toEqual([]);
	});
});

// ─── 5. Library-side signals (drift / ACL / ownership) ───────────────────

/** Push targets for a `knowledge:library_changed` frame with the given reason. */
function libraryTargets(reason: string): string[] {
	return pushes
		.filter((p) => p.message.type === "knowledge:library_changed" && p.message.reason === reason)
		.map((p) => p.userId);
}

describe("entry drift notification", () => {
	test("advancing main notifies OTHER holders of a personal version, not the author", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `DriftNotify ${TAG} ${generateId(4)}`,
			content: "v1\n",
		});
		// Two users fork a personal version; a third has nothing to do with it.
		await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		await knowledgeBranchService.createDraft(P(reviewerId), entry.id, {});
		events.length = 0;
		pushes.length = 0;

		// A direct main write by the admin.
		await knowledgeService.addRevision(entry.id, { content: "v2\n", authorUserId: adminId });
		await settle();

		const drift = eventsOfType("knowledge:entry_drifted");
		expect(drift).toHaveLength(1);
		expect([...drift[0].driftedUserIds].sort()).toEqual([submitterId, reviewerId].sort());
		expect([...libraryTargets("entry_drifted")].sort()).toEqual([submitterId, reviewerId].sort());
		// The uninvolved user is never told.
		expect(libraryTargets("entry_drifted")).not.toContain(outsiderId);
	});

	test("the author of the main write is excluded from their own drift notification", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `DriftSelf ${TAG} ${generateId(4)}`,
			content: "v1\n",
		});
		await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		events.length = 0;
		pushes.length = 0;

		// submitterId both holds a personal version AND makes the main write.
		await knowledgeService.addRevision(entry.id, { content: "v2\n", authorUserId: submitterId });
		await settle();

		// Nobody else holds a copy, so there is nothing to announce at all.
		expect(eventsOfType("knowledge:entry_drifted")).toHaveLength(0);
		expect(libraryTargets("entry_drifted")).toEqual([]);
	});

	test("an entry nobody forked produces no drift event", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `DriftNone ${TAG} ${generateId(4)}`,
			content: "v1\n",
		});
		events.length = 0;
		pushes.length = 0;
		await knowledgeService.addRevision(entry.id, { content: "v2\n", authorUserId: adminId });
		await settle();
		expect(eventsOfType("knowledge:entry_drifted")).toHaveLength(0);
	});

	test("an approved publish also drifts the other holders", async () => {
		const entry = await makeReviewableEntry("DriftOnPublish");
		// The submitter proposes a change; a bystander holds their own personal version.
		await knowledgeBranchService.createDraft(P(submitterId), entry.id, {});
		const myDraft = await knowledgeBranchService.getMyDraft(P(submitterId), entry.id);
		await knowledgeBranchService.updateDraft(P(submitterId), myDraft?.id as string, {
			content: "proposed body\n",
		});
		await knowledgeBranchService.createDraft(P(outsiderId), entry.id, {});
		const submission = await knowledgeBranchService.submitForReview(
			P(submitterId),
			myDraft?.id as string,
			{},
		);
		events.length = 0;
		pushes.length = 0;

		await knowledgeBranchService.review(P(reviewerId), submission?.id as string, {
			verdict: "approve",
		});
		await settle();

		// The bystander's copy is now behind; the submitter's was archived by the publish.
		expect(libraryTargets("entry_drifted")).toEqual([outsiderId]);
	});
});

describe("ACL change notification", () => {
	test("granting and revoking notify the affected user, carrying no credential detail", async () => {
		const target = await makeUser("user", "kn-aclnotify");
		events.length = 0;
		pushes.length = 0;

		const grant = await knowledgeAcl.createGrant({
			principalType: "user",
			principalId: target,
			grantType: "clearance",
			clearanceLevel: "internal",
		});
		await settle();
		expect(libraryTargets("acl_changed")).toEqual([target]);
		// The push must not name the level/tag — that would leak the compartment layout.
		const frame = pushes.find((p) => p.message.reason === "acl_changed");
		expect(frame?.message.clearanceLevel).toBeUndefined();
		expect(frame?.message.tagId).toBeUndefined();

		pushes.length = 0;
		await knowledgeAcl.deleteGrant((grant as { id: string }).id);
		await settle();
		// Revocation reaches the user too — resolved BEFORE the row is deleted.
		expect(libraryTargets("acl_changed")).toEqual([target]);
	});

	test("replacing a user's ACL notifies them once", async () => {
		const target = await makeUser("user", "kn-aclreplace");
		events.length = 0;
		pushes.length = 0;
		await knowledgeAcl.setUserAcl(target, { clearanceLevel: "internal", tagIds: [] });
		await settle();
		expect(eventsOfType("knowledge:acl_changed")).toHaveLength(1);
		expect(libraryTargets("acl_changed")).toEqual([target]);
	});
});

describe("ownership transfer notification", () => {
	test("transferring an entry notifies both the old and the new owner", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `OwnerXfer ${TAG} ${generateId(4)}`,
			content: "body\n",
			authorUserId: submitterId,
		});
		await knowledgeService.updateEntryAcl(entry.id, { ownerUserId: submitterId });
		events.length = 0;
		pushes.length = 0;

		await knowledgeService.transferEntryOwner(entry.id, reviewerId, P(adminId, "admin"));
		await settle();

		// Ownership is an ACL short-circuit: one side gained access, the other may have lost it.
		expect([...libraryTargets("owner_transferred")].sort()).toEqual(
			[submitterId, reviewerId].sort(),
		);
	});

	test("transferring a collection notifies both parties with the collection id", async () => {
		const col = await knowledgeService.createCollection({
			name: `xfer-${TAG}-${generateId(4)}`,
			ownerUserId: submitterId,
		});
		events.length = 0;
		pushes.length = 0;

		await knowledgeService.transferCollectionOwner(col.id, reviewerId, P(adminId, "admin"));
		await settle();

		expect([...libraryTargets("owner_transferred")].sort()).toEqual(
			[submitterId, reviewerId].sort(),
		);
		const frame = pushes.find((p) => p.message.reason === "owner_transferred");
		expect(frame?.message.collectionId).toBe(col.id);
	});
});
