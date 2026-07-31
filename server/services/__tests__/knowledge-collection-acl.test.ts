/**
 * Collection-level ACL tests.
 *
 * Verifies the collection is a real access boundary (not just an org container):
 *   - canReadCollection dual-axis decision (pure-ish, DB-backed level map)
 *   - collection-as-gate on read (entry hidden when its collection is unreadable, even if
 *     the entry itself is public)
 *   - listCollections hides unreadable collections
 *   - write control (create_entry / addRevision require collection read + write)
 *   - the three "silent bypass" gaps that the plan pinned: addRevision, branch review,
 *     link-service graph traversal, pack-service pack ACL
 *   - backward compatibility (no-ACL collection stays world-readable)
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as the other
 * knowledge-*.test.ts files). Unique ids/names per run avoid collisions with seeded data.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-collection-acl.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import {
	knowledgeDrafts,
	knowledgeGrants,
	knowledgeSubmissions,
	knowledgeTags,
	users,
} from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	type AclCollection,
	canReadCollection,
	knowledgeAcl,
	type Principal,
} from "../knowledge-acl";
import { knowledgeBranchService } from "../knowledge-branch-service";
import { knowledgeLinkService } from "../knowledge-link-service";
import { knowledgeService } from "../knowledge-service";

const TAG = Date.now();

let adminId: string;
let ownerId: string; // collection owner (non-admin)
let writerId: string; // holds a global write grant + clearance for the restricted collection
let lowId: string; // baseline user: public clearance only
let secretTagId: string; // controlled tag gating the restricted collection

const P = (id: string, role: "admin" | "user" = "user"): Principal => ({ userId: id, role });

function nowIso(): string {
	return new Date().toISOString();
}

async function makeUser(role: "admin" | "user", label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(4)}`,
		passwordHash: "x",
		role,
		createdAt: nowIso(),
	});
	return id;
}

beforeAll(async () => {
	adminId = await makeUser("admin", "cadmin");
	ownerId = await makeUser("user", "cowner");
	writerId = await makeUser("user", "cwriter");
	lowId = await makeUser("user", "clow");

	// A controlled tag used both as the collection compartment and granted to the writer.
	secretTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: secretTagId,
		name: `secret-compartment-${TAG}`,
		controlled: true,
		createdAt: nowIso(),
	});

	// writer: confidential clearance + the secret tag + a global write grant.
	await db.insert(knowledgeGrants).values([
		{
			id: generateId(),
			principalType: "user",
			principalId: writerId,
			grantType: "clearance",
			clearanceLevel: "confidential",
			canWrite: true,
			createdAt: nowIso(),
		},
		{
			id: generateId(),
			principalType: "user",
			principalId: writerId,
			grantType: "tag",
			tagId: secretTagId,
			canWrite: false,
			createdAt: nowIso(),
		},
	]);
});

describe("canReadCollection (dual-axis decision)", () => {
	const baseCaps = () => ({
		userId: lowId,
		role: "user" as const,
		isAdmin: false,
		clearanceRank: 0,
		grantedTagIds: new Set<string>(),
		hasWriteGrant: false,
		reviewTagIds: new Set<string>(),
	});

	const col = (over: Partial<AclCollection> = {}): AclCollection => ({
		id: "c1",
		defaultLevel: "public",
		classificationLevel: null,
		controlledTagsJson: null,
		ownerUserId: null,
		...over,
	});

	test("public + no controlled tags = readable by everyone", async () => {
		expect(await canReadCollection(baseCaps(), col())).toBe(true);
	});

	test("admin short-circuits", async () => {
		expect(
			await canReadCollection(
				{ ...baseCaps(), isAdmin: true },
				col({ classificationLevel: "secret" }),
			),
		).toBe(true);
	});

	test("owner short-circuits", async () => {
		expect(
			await canReadCollection(
				baseCaps(),
				col({ classificationLevel: "secret", ownerUserId: lowId }),
			),
		).toBe(true);
	});

	test("insufficient clearance is denied", async () => {
		expect(await canReadCollection(baseCaps(), col({ classificationLevel: "confidential" }))).toBe(
			false,
		);
	});

	test("missing controlled tag is denied even with clearance", async () => {
		const caps = { ...baseCaps(), clearanceRank: 999 };
		expect(await canReadCollection(caps, col({ controlledTagsJson: ["t-x"] }))).toBe(false);
	});
});

/** Create a restricted collection (confidential + secret tag) and a public one. */
async function makeCollections() {
	const restricted = await knowledgeService.createCollection({
		name: `restricted-${TAG}-${generateId(4)}`,
	});
	await knowledgeAcl.updateCollectionAcl(restricted.id, {
		classificationLevel: "confidential",
		controlledTags: [secretTagId],
	});
	const pub = await knowledgeService.createCollection({ name: `public-${TAG}-${generateId(4)}` });
	return { restrictedId: restricted.id, publicId: pub.id };
}

describe("collection as read gate", () => {
	test("a PUBLIC entry inside a restricted collection is hidden from a low user", async () => {
		const { restrictedId } = await makeCollections();
		// Entry itself has no classification (public), but its collection is confidential+tagged.
		const entry = await knowledgeService.createEntry({
			collectionId: restrictedId,
			title: `pub-entry-${TAG}`,
			content: "body",
		});
		// Low user: collection gate blocks even though the entry is public.
		await expect(knowledgeService.getEntry(entry.id, { principal: P(lowId) })).rejects.toThrow();
		// Writer (clearance + tag): can read.
		const ok = await knowledgeService.getEntry(entry.id, { principal: P(writerId) });
		expect(ok.id).toBe(entry.id);
		// Admin: can read.
		expect((await knowledgeService.getEntry(entry.id, { principal: P(adminId, "admin") })).id).toBe(
			entry.id,
		);
	});

	test("listCollections hides unreadable collections from a low user", async () => {
		const { restrictedId, publicId } = await makeCollections();
		const lowList = await knowledgeService.listCollections(undefined, P(lowId));
		const lowIds = lowList.map((c) => c.id);
		expect(lowIds).toContain(publicId);
		expect(lowIds).not.toContain(restrictedId);
		// Admin sees both.
		const adminList = await knowledgeService.listCollections(undefined, P(adminId, "admin"));
		const adminIds = adminList.map((c) => c.id);
		expect(adminIds).toContain(restrictedId);
		expect(adminIds).toContain(publicId);
	});
});

describe("collection-scoped grants", () => {
	test("clearance, tag and write authority do not leak into another collection", async () => {
		const scopedUserId = await makeUser("user", "collection-scoped");
		const first = await makeCollections();
		const second = await makeCollections();
		await db.insert(knowledgeGrants).values([
			{
				id: generateId(),
				principalType: "user",
				principalId: scopedUserId,
				grantType: "clearance",
				clearanceLevel: "confidential",
				canWrite: true,
				collectionId: first.restrictedId,
				createdAt: nowIso(),
			},
			{
				id: generateId(),
				principalType: "user",
				principalId: scopedUserId,
				grantType: "tag",
				tagId: secretTagId,
				canWrite: false,
				collectionId: first.restrictedId,
				createdAt: nowIso(),
			},
		]);
		const firstEntry = await knowledgeService.createEntry({
			collectionId: first.restrictedId,
			title: `scoped-first-${TAG}`,
			content: "allowed",
		});
		const secondEntry = await knowledgeService.createEntry({
			collectionId: second.restrictedId,
			title: `scoped-second-${TAG}`,
			content: "denied",
		});
		expect(
			(
				await knowledgeService.getEntry(firstEntry.id, {
					principal: P(scopedUserId),
				})
			).id,
		).toBe(firstEntry.id);
		await expect(
			knowledgeService.getEntry(secondEntry.id, { principal: P(scopedUserId) }),
		).rejects.toThrow();
		await expect(
			knowledgeService.createEntry({
				collectionId: first.restrictedId,
				title: `scoped-write-${TAG}`,
				principal: P(scopedUserId),
			}),
		).resolves.toBeDefined();
		await expect(
			knowledgeService.createEntry({
				collectionId: second.restrictedId,
				title: `scoped-write-denied-${TAG}`,
				principal: P(scopedUserId),
			}),
		).rejects.toThrow();
	});
});

describe("collection write control", () => {
	test("low user cannot create an entry in a restricted collection (NotFound, no leak)", async () => {
		const { restrictedId } = await makeCollections();
		await expect(
			knowledgeService.createEntry({
				collectionId: restrictedId,
				title: `x-${TAG}`,
				content: "b",
				principal: P(lowId),
			}),
		).rejects.toThrow();
	});

	test("writer (clearance+tag+write grant) can create in a restricted collection", async () => {
		const { restrictedId } = await makeCollections();
		const created = await knowledgeService.createEntry({
			collectionId: restrictedId,
			title: `w-${TAG}`,
			content: "b",
			principal: P(writerId),
		});
		expect(created.id).toBeTruthy();
	});

	test("collection owner (non-admin, no write grant) can create + manage their collection", async () => {
		const col = await knowledgeService.createCollection({
			name: `owned-${TAG}-${generateId(4)}`,
			ownerUserId: ownerId,
		});
		// Owner can create an entry (owner short-circuits canWriteCollection).
		const created = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `owned-entry-${TAG}`,
			content: "b",
			principal: P(ownerId),
		});
		expect(created.id).toBeTruthy();
		// Owner can rename their collection.
		const renamed = await knowledgeService.updateCollection(
			col.id,
			{ name: `renamed-${TAG}` },
			P(ownerId),
		);
		expect(renamed?.name).toBe(`renamed-${TAG}`);
		// A different low user cannot manage it.
		await expect(
			knowledgeService.updateCollection(col.id, { name: "nope" }, P(lowId)),
		).rejects.toThrow();
	});
});

describe("addRevision / write_main collection gate (pinned gap)", () => {
	test("a global write-grant holder who CANNOT read the collection is refused write_main", async () => {
		const { restrictedId } = await makeCollections();
		// Admin seeds an entry in the restricted collection.
		const entry = await knowledgeService.createEntry({
			collectionId: restrictedId,
			title: `wm-${TAG}`,
			content: "orig",
			principal: P(adminId, "admin"),
		});
		// A user with a global write grant but NO clearance/tag for this collection.
		const blockedWriter = await makeUser("user", "cblocked");
		await db.insert(knowledgeGrants).values({
			id: generateId(),
			principalType: "user",
			principalId: blockedWriter,
			grantType: "clearance",
			clearanceLevel: "public",
			canWrite: true,
			createdAt: nowIso(),
		});
		// write_main must be refused (collection unreadable → NotFound), proving the gate is
		// in addRevision itself (which does NOT go through loadReadableEntry).
		await expect(
			knowledgeService.addRevision(entry.id, {
				content: "hijack",
				principal: P(blockedWriter),
			}),
		).rejects.toThrow();
		// Content unchanged.
		const fresh = await knowledgeService.getEntry(entry.id, {
			withContent: true,
			principal: P(adminId, "admin"),
		});
		expect((fresh as { currentContent?: string }).currentContent).toBe("orig");
	});
});

describe("review path collection gate (pinned gap)", () => {
	/** Seed a submitted draft + pending submission by `submitter` on `entryId`. */
	async function makeSubmission(entryId: string, submitterId: string): Promise<string> {
		const draftId = generateId();
		const submissionId = generateId();
		const now = nowIso();
		// Base the draft on the entry's current revision so approve hits the clean
		// fast-path merge (base === main) instead of a three-way conflict.
		const baseRevId = (
			await db.query.knowledgeEntries.findFirst({
				where: (e, { eq }) => eq(e.id, entryId),
				columns: { currentRevisionId: true },
			})
		)?.currentRevisionId;
		await db.insert(knowledgeDrafts).values({
			id: draftId,
			entryId,
			authorUserId: submitterId,
			baseRevisionId: baseRevId ?? null,
			content: "proposed body",
			contentHash: "h",
			format: "markdown",
			status: "active",
			createdAt: now,
			updatedAt: now,
		});
		await db.insert(knowledgeSubmissions).values({
			id: submissionId,
			draftId,
			entryId,
			submitterUserId: submitterId,
			baseRevisionId: baseRevId ?? null,
			proposedContent: "proposed body",
			status: "pending",
			createdAt: now,
		});
		return submissionId;
	}

	test("a reviewer who cannot read the collection sees/acts on nothing", async () => {
		const { restrictedId } = await makeCollections();
		// Entry in restricted collection with a review tag the reviewer holds.
		const reviewTagId = generateId();
		await db.insert(knowledgeTags).values({
			id: reviewTagId,
			name: `rev-${TAG}`,
			controlled: true,
			createdAt: nowIso(),
		});
		const entry = await knowledgeService.createEntry({
			collectionId: restrictedId,
			title: `rev-entry-${TAG}`,
			content: "orig",
			principal: P(adminId, "admin"),
		});
		await knowledgeService.updateEntryAcl(entry.id, { reviewTags: [reviewTagId] });
		const submissionId = await makeSubmission(entry.id, ownerId);

		// reviewerNoCollection: holds the review grant but NOT the collection's clearance/tag.
		const reviewerNoCollection = await makeUser("user", "crev");
		await db.insert(knowledgeGrants).values({
			id: generateId(),
			principalType: "user",
			principalId: reviewerNoCollection,
			grantType: "review",
			tagId: reviewTagId,
			canWrite: false,
			createdAt: nowIso(),
		});

		// listSubmissions hides it; approve + getSubmission are refused.
		const list = await knowledgeBranchService.listSubmissions(P(reviewerNoCollection), {
			entryId: entry.id,
		});
		expect(list.find((s) => s.id === submissionId)).toBeUndefined();
		await expect(
			knowledgeBranchService.getSubmission(P(reviewerNoCollection), submissionId),
		).rejects.toThrow();
		await expect(
			knowledgeBranchService.review(P(reviewerNoCollection), submissionId, { verdict: "approve" }),
		).rejects.toThrow();

		// Admin can approve (collection gate short-circuits) → merges.
		const res = await knowledgeBranchService.review(P(adminId, "admin"), submissionId, {
			verdict: "approve",
		});
		expect(res.status).toBe("approved");
	});
});

describe("link-service graph traversal collection gate (pinned gap)", () => {
	test("a link to an entry in a restricted collection is not returned to a low user", async () => {
		const { restrictedId, publicId } = await makeCollections();
		// Public anchor entry the low user can read.
		const anchor = await knowledgeService.createEntry({
			collectionId: publicId,
			title: `anchor-${TAG}`,
			content: "a",
			principal: P(adminId, "admin"),
		});
		// Target entry inside the restricted collection.
		const target = await knowledgeService.createEntry({
			collectionId: restrictedId,
			title: `target-${TAG}`,
			content: "t",
			principal: P(adminId, "admin"),
		});
		// Admin links anchor → target.
		await knowledgeLinkService.addLink(P(adminId, "admin"), {
			fromEntryId: anchor.id,
			toEntryId: target.id,
			linkType: "related",
		});
		// Low user lists links on the anchor: the link to the restricted target is filtered out
		// (both-endpoints-readable rule; the restricted collection gate hides the target).
		const links = await knowledgeLinkService.listLinks(P(lowId), anchor.id);
		expect(links.find((l) => l.toEntryId === target.id)).toBeUndefined();
		// Admin sees the link.
		const adminLinks = await knowledgeLinkService.listLinks(P(adminId, "admin"), anchor.id);
		expect(adminLinks.find((l) => l.toEntryId === target.id)).toBeDefined();
	});
});

describe("collection ACL panel edits change canRead", () => {
	/**
	 * The admin UI (CollectionAclPanel) writes through updateCollectionAcl. This pins the
	 * behaviour the panel depends on: every field it can edit — level, compartment tags,
	 * owner — must take effect on the very next canRead, in both directions. A stale or
	 * one-way-only effect would make the panel silently lie about who can see what.
	 */
	test("level / controlled tags / owner each flip readability immediately", async () => {
		const col = await knowledgeService.createCollection({
			name: `panel-${TAG}-${generateId(4)}`,
		});
		const entry = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `panel-entry-${TAG}`,
			content: "body",
		});
		const viewer = await makeUser("user", "cpanel");

		// No ACL → readable (backward-compatible default).
		expect((await knowledgeService.getEntry(entry.id, { principal: P(viewer) })).id).toBe(entry.id);

		// Raise the level → hidden (entry itself is still public: collection gate wins).
		await knowledgeAcl.updateCollectionAcl(col.id, { classificationLevel: "confidential" });
		await expect(knowledgeService.getEntry(entry.id, { principal: P(viewer) })).rejects.toThrow();

		// Lower it back to public → visible again (the panel's "clear level" action).
		await knowledgeAcl.updateCollectionAcl(col.id, { classificationLevel: null });
		expect((await knowledgeService.getEntry(entry.id, { principal: P(viewer) })).id).toBe(entry.id);

		// Add a compartment the viewer lacks → hidden on the tag axis alone.
		await knowledgeAcl.updateCollectionAcl(col.id, { controlledTags: [secretTagId] });
		await expect(knowledgeService.getEntry(entry.id, { principal: P(viewer) })).rejects.toThrow();

		// Naming the viewer as owner short-circuits the gate, even with the tag still set.
		await knowledgeAcl.updateCollectionAcl(col.id, { ownerUserId: viewer });
		expect((await knowledgeService.getEntry(entry.id, { principal: P(viewer) })).id).toBe(entry.id);

		// Removing the owner restores the compartment denial (no lingering grant).
		await knowledgeAcl.updateCollectionAcl(col.id, { ownerUserId: null });
		await expect(knowledgeService.getEntry(entry.id, { principal: P(viewer) })).rejects.toThrow();

		// Clearing the compartment list reopens it.
		await knowledgeAcl.updateCollectionAcl(col.id, { controlledTags: [] });
		expect((await knowledgeService.getEntry(entry.id, { principal: P(viewer) })).id).toBe(entry.id);
	});

	test("getCollectionAcl echoes exactly what updateCollectionAcl stored", async () => {
		const owner = await makeUser("user", "cecho");
		const col = await knowledgeService.createCollection({
			name: `echo-${TAG}-${generateId(4)}`,
		});
		await knowledgeAcl.updateCollectionAcl(col.id, {
			classificationLevel: "confidential",
			controlledTags: [secretTagId],
			ownerUserId: owner,
		});
		const acl = await knowledgeAcl.getCollectionAcl(col.id);
		expect(acl.classificationLevel).toBe("confidential");
		expect(acl.controlledTags).toEqual([secretTagId]);
		expect(acl.ownerUserId).toBe(owner);
		expect(acl.ownerUsername).toBeTruthy();
	});
});

describe("backward compatibility", () => {
	test("a collection with no ACL fields stays readable by a baseline user", async () => {
		const col = await knowledgeService.createCollection({ name: `compat-${TAG}-${generateId(4)}` });
		const entry = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `compat-entry-${TAG}`,
			content: "b",
		});
		const got = await knowledgeService.getEntry(entry.id, { principal: P(lowId) });
		expect(got.id).toBe(entry.id);
		const list = await knowledgeService.listCollections(undefined, P(lowId));
		expect(list.map((c) => c.id)).toContain(col.id);
	});
});
