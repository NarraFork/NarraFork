/**
 * Ownership-transfer tests for knowledge entries and collections.
 *
 * Covers: admin/owner authorization, owner cannot abandon (null) but admin can,
 * target-user-existence validation, collection-gate-first (an entry owner locked out
 * of the collection cannot transfer), the post-transfer readback regression (owner A
 * transferring to B returns cleanly instead of throwing NotFound), and the agent tool
 * (KnowledgeReview transfer_owner / transfer_collection_owner) including approval wiring
 * and danger classification.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-ownership-transfer.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../db";
import { knowledgeTags, users } from "../../db/schema";
import { knowledgeReviewTool } from "../../lib/agent/tools/knowledge-review";
import type { ToolContext } from "../../lib/agent/types";
import { generateId } from "../../lib/id";
import { knowledgeAcl, type Principal } from "../knowledge-acl";
import { knowledgeService } from "../knowledge-service";
import { classifyDanger } from "../narrator-permission";

const TAG = Date.now();

let adminId: string;
let aliceId: string; // owner A
let bobId: string; // transfer target B
let lowId: string; // unrelated baseline user
let secretTagId: string;

const P = (id: string, role: "admin" | "user" = "user"): Principal => ({ userId: id, role });

function nowIso(): string {
	return new Date().toISOString();
}

function ctxFor(
	userId: string | null,
	requestPermission: ToolContext["requestPermission"] = async () => ({ behavior: "allow" }),
): ToolContext {
	return {
		narratorId: `narr-${TAG}`,
		cwd: "/tmp",
		signal: new AbortController().signal,
		locale: "en",
		userId,
		currentToolUseId: `tu-${generateId(6)}`,
		requestPermission,
	};
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
	adminId = await makeUser("admin", "towner-admin");
	aliceId = await makeUser("user", "towner-alice");
	bobId = await makeUser("user", "towner-bob");
	lowId = await makeUser("user", "towner-low");

	// A controlled tag for restricted-collection tests, granted to alice (so she can be the
	// entry owner inside a restricted collection in the gate test we DON'T grant her — see below).
	secretTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: secretTagId,
		name: `t-secret-${TAG}`,
		controlled: true,
		createdAt: nowIso(),
	});
});

/** Create a public collection + an entry owned by `ownerId`. Returns entryId. */
async function makeOwnedEntry(ownerId: string | null): Promise<string> {
	const col = await knowledgeService.createCollection({ name: `t-col-${TAG}-${generateId(4)}` });
	const entry = await knowledgeService.createEntry({
		collectionId: col.id,
		title: `t-entry-${TAG}-${generateId(4)}`,
		content: "body",
		ownerUserId: ownerId,
	});
	return entry.id;
}

describe("transferEntryOwner (service)", () => {
	test("admin transfers an entry to B → B becomes owner", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeService.transferEntryOwner(entryId, bobId, P(adminId, "admin"));
		expect(res.ok).toBe(true);
		expect(res.ownerUserId).toBe(bobId);
		// B can now read via owner short-circuit even with no other grant.
		const got = await knowledgeService.getEntry(entryId, { principal: P(bobId) });
		expect(got.id).toBe(entryId);
	});

	test("current owner A transfers to B → succeeds and returns cleanly (no readback NotFound)", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		// This is the pinned regression: A loses the owner short-circuit after transfer; the
		// method must NOT do a principal-gated readback (which would throw NotFound).
		const res = await knowledgeService.transferEntryOwner(entryId, bobId, P(aliceId));
		expect(res.ok).toBe(true);
		expect(res.ownerUserId).toBe(bobId);
		// A is no longer owner (public collection so A can still READ it, but ownership moved).
		const row = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { ownerUserId: true },
		});
		expect(row?.ownerUserId).toBe(bobId);
	});

	test("a non-owner non-admin user cannot transfer (NotFound, no leak)", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		await expect(knowledgeService.transferEntryOwner(entryId, bobId, P(lowId))).rejects.toThrow();
	});

	test("owner cannot abandon ownership (null) — ValidationError", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		await expect(knowledgeService.transferEntryOwner(entryId, null, P(aliceId))).rejects.toThrow();
	});

	test("admin can abandon ownership (null → unowned)", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeService.transferEntryOwner(entryId, null, P(adminId, "admin"));
		expect(res.ownerUserId).toBeNull();
		const row = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { ownerUserId: true },
		});
		expect(row?.ownerUserId).toBeNull();
	});

	test("transfer to a non-existent user is rejected", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		await expect(
			knowledgeService.transferEntryOwner(entryId, "no-such-user", P(adminId, "admin")),
		).rejects.toThrow();
	});

	test("collection-gate-first: an entry owner locked out of the collection cannot transfer", async () => {
		// Restricted collection (confidential + secret tag); alice owns an entry inside but
		// holds NEITHER the clearance NOR the tag → she is locked out at the collection gate.
		const col = await knowledgeService.createCollection({
			name: `t-restr-${TAG}-${generateId(4)}`,
		});
		await knowledgeAcl.updateCollectionAcl(col.id, {
			classificationLevel: "confidential",
			controlledTags: [secretTagId],
		});
		const entry = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `t-restr-entry-${TAG}`,
			content: "b",
			ownerUserId: aliceId,
			principal: P(adminId, "admin"),
		});
		// Alice is the entry owner but cannot read the collection → transfer is NotFound.
		await expect(
			knowledgeService.transferEntryOwner(entry.id, bobId, P(aliceId)),
		).rejects.toThrow();
		// Admin can still transfer.
		const res = await knowledgeService.transferEntryOwner(entry.id, bobId, P(adminId, "admin"));
		expect(res.ownerUserId).toBe(bobId);
	});
});

describe("transferCollectionOwner (service)", () => {
	async function makeOwnedCollection(ownerId: string | null): Promise<string> {
		const col = await knowledgeService.createCollection({
			name: `t-ocol-${TAG}-${generateId(4)}`,
			ownerUserId: ownerId,
		});
		return col.id;
	}

	test("admin transfers a collection to B", async () => {
		const id = await makeOwnedCollection(aliceId);
		const res = await knowledgeService.transferCollectionOwner(id, bobId, P(adminId, "admin"));
		expect(res.ownerUserId).toBe(bobId);
	});

	test("current owner A transfers to B", async () => {
		const id = await makeOwnedCollection(aliceId);
		const res = await knowledgeService.transferCollectionOwner(id, bobId, P(aliceId));
		expect(res.ownerUserId).toBe(bobId);
	});

	test("non-owner non-admin cannot transfer (NotFound)", async () => {
		const id = await makeOwnedCollection(aliceId);
		await expect(knowledgeService.transferCollectionOwner(id, bobId, P(lowId))).rejects.toThrow();
	});

	test("owner cannot abandon; admin can", async () => {
		const id = await makeOwnedCollection(aliceId);
		await expect(knowledgeService.transferCollectionOwner(id, null, P(aliceId))).rejects.toThrow();
		const res = await knowledgeService.transferCollectionOwner(id, null, P(adminId, "admin"));
		expect(res.ownerUserId).toBeNull();
	});

	test("transfer to a non-existent user is rejected", async () => {
		const id = await makeOwnedCollection(aliceId);
		await expect(
			knowledgeService.transferCollectionOwner(id, "no-such-user", P(adminId, "admin")),
		).rejects.toThrow();
	});
});

describe("KnowledgeReview transfer agent actions", () => {
	test("owner transfers an entry via the tool (approval allowed)", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeReviewTool.execute(
			{ action: "transfer_owner", entryId, newOwnerUserId: bobId },
			ctxFor(aliceId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain(bobId);
	});

	test("denied approval blocks the transfer", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeReviewTool.execute(
			{ action: "transfer_owner", entryId, newOwnerUserId: bobId },
			ctxFor(aliceId, async () => ({ behavior: "deny" })),
		);
		expect(res.isError).toBe(true);
		const row = await db.query.knowledgeEntries.findFirst({
			where: (e, { eq }) => eq(e.id, entryId),
			columns: { ownerUserId: true },
		});
		expect(row?.ownerUserId).toBe(aliceId); // unchanged
	});

	test("anonymous user is refused", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeReviewTool.execute(
			{ action: "transfer_owner", entryId, newOwnerUserId: bobId },
			ctxFor(null),
		);
		expect(res.isError).toBe(true);
	});

	test("non-owner via the tool is refused", async () => {
		const entryId = await makeOwnedEntry(aliceId);
		const res = await knowledgeReviewTool.execute(
			{ action: "transfer_owner", entryId, newOwnerUserId: bobId },
			ctxFor(lowId),
		);
		expect(res.isError).toBe(true);
	});

	test("transfer_collection_owner via the tool", async () => {
		const col = await knowledgeService.createCollection({
			name: `t-tcol-${TAG}-${generateId(4)}`,
			ownerUserId: aliceId,
		});
		const res = await knowledgeReviewTool.execute(
			{ action: "transfer_collection_owner", collectionTargetId: col.id, newOwnerUserId: bobId },
			ctxFor(aliceId),
		);
		expect(res.isError).toBeUndefined();
		expect(res.output).toContain(bobId);
	});
});

describe("classifyDanger for transfer actions", () => {
	const cwd = "/tmp";
	test("transfer actions are medium severity (write, not merge)", () => {
		expect(classifyDanger("KnowledgeReview", { action: "transfer_owner" }, cwd)?.severity).toBe(
			"medium",
		);
		expect(
			classifyDanger("KnowledgeReview", { action: "transfer_collection_owner" }, cwd)?.severity,
		).toBe("medium");
	});
});
