/**
 * Bulk-grant + collection-ACL-readback tests (WP3).
 *
 * Covers:
 *   - the 200-userId cap and the credential-shape refine on bulkKnowledgeGrantSchema
 *   - transactional writes: an invalid credential/collection aborts BEFORE any row lands
 *     (no half-applied batch), while an unknown user is reported per-row without killing
 *     the batch
 *   - duplicate collapsing + already-held detection (skipped, not duplicated)
 *   - admin gating on POST /grants/bulk and GET /collections/:id/acl
 *   - the end-to-end ACL consequence: a bulk-granted clearance + tag flips canRead on an
 *     entry whose COLLECTION is the gate, and editing the collection ACL flips it back
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as the other
 * knowledge-*.test.ts files). Unique ids/names per run avoid collisions with seeded data.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/knowledge-bulk-grant.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq } from "drizzle-orm";
import { Hono } from "hono";
import { db } from "../../db";
import { aclGrants, knowledgeTags, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { bulkKnowledgeGrantSchema } from "../../lib/validators";
import { knowledgeRoutes } from "../../routes/knowledge";
import { knowledgeAcl, type Principal } from "../knowledge-acl";
import { knowledgeService } from "../knowledge-service";

const TAG = Date.now();

let adminId: string;
let secretTagId: string;
let reviewTagId: string;
/** Three plain users used as bulk-grant targets. */
let targetIds: string[];

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

/** A Hono app mounting the real knowledge routes behind a fake principal of the given role. */
function appForRole(role: "admin" | "user", userId: string) {
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role, iat: 0, exp: Number.MAX_SAFE_INTEGER });
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

/** Count the user grants matching a credential, for transactional assertions. */
async function countUserGrants(
	userIds: string[],
	grantType: "clearance" | "tag" | "review",
): Promise<number> {
	// Knowledge credentials now live in acl_grants as domain rows: `domain_kind` carries
	// what used to be `grant_type`.
	const rows = await db.query.aclGrants.findMany({
		where: (g, { and: a, eq: e, inArray }) =>
			a(e(g.principalType, "user"), inArray(g.principalId, userIds), e(g.domainKind, grantType)),
	});
	return rows.length;
}

beforeAll(async () => {
	adminId = await makeUser("admin", "bgadmin");
	targetIds = [
		await makeUser("user", "bgt1"),
		await makeUser("user", "bgt2"),
		await makeUser("user", "bgt3"),
	];

	secretTagId = generateId();
	reviewTagId = generateId();
	await db.insert(knowledgeTags).values([
		{
			id: secretTagId,
			name: `bulk-compartment-${TAG}`,
			controlled: true,
			createdAt: nowIso(),
		},
		{
			id: reviewTagId,
			name: `bulk-review-${TAG}`,
			controlled: true,
			createdAt: nowIso(),
		},
	]);
});

describe("bulkKnowledgeGrantSchema bounds", () => {
	test("accepts up to 200 userIds and rejects 201 (unbounded writes are refused at the edge)", () => {
		const at200 = bulkKnowledgeGrantSchema.safeParse({
			userIds: Array.from({ length: 200 }, (_, i) => `u-${i}`),
			grantType: "clearance",
			clearanceLevel: "confidential",
		});
		expect(at200.success).toBe(true);

		const over = bulkKnowledgeGrantSchema.safeParse({
			userIds: Array.from({ length: 201 }, (_, i) => `u-${i}`),
			grantType: "clearance",
			clearanceLevel: "confidential",
		});
		expect(over.success).toBe(false);
	});

	test("rejects an empty userIds array", () => {
		const parsed = bulkKnowledgeGrantSchema.safeParse({
			userIds: [],
			grantType: "clearance",
			clearanceLevel: "confidential",
		});
		expect(parsed.success).toBe(false);
	});

	test("requires clearanceLevel for clearance and tagId for tag/review", () => {
		expect(
			bulkKnowledgeGrantSchema.safeParse({ userIds: ["u1"], grantType: "clearance" }).success,
		).toBe(false);
		expect(bulkKnowledgeGrantSchema.safeParse({ userIds: ["u1"], grantType: "tag" }).success).toBe(
			false,
		);
		expect(
			bulkKnowledgeGrantSchema.safeParse({ userIds: ["u1"], grantType: "review" }).success,
		).toBe(false);
		expect(
			bulkKnowledgeGrantSchema.safeParse({
				userIds: ["u1"],
				grantType: "tag",
				tagId: "t1",
			}).success,
		).toBe(true);
	});
});

describe("bulkGrant service semantics", () => {
	test("grants one credential to many users in a single batch", async () => {
		const ids = [await makeUser("user", "bgmany1"), await makeUser("user", "bgmany2")];
		const res = await knowledgeAcl.bulkGrant({
			userIds: ids,
			grantType: "tag",
			tagId: secretTagId,
		});
		expect(res.ok).toBe(true);
		expect(res.granted).toBe(2);
		expect(res.skipped).toBe(0);
		expect(res.failed).toBe(0);
		expect(await countUserGrants(ids, "tag")).toBe(2);
		// Every row carries a grantId so the caller can audit / revoke individually.
		expect(res.results.every((r) => r.status === "granted" && !!r.grantId)).toBe(true);
	});

	test("duplicate userIds are collapsed (no double grant)", async () => {
		const id = await makeUser("user", "bgdup");
		const res = await knowledgeAcl.bulkGrant({
			userIds: [id, id, id],
			grantType: "tag",
			tagId: secretTagId,
		});
		expect(res.granted).toBe(1);
		expect(res.results).toHaveLength(1);
		expect(await countUserGrants([id], "tag")).toBe(1);
	});

	test("an already-held identical grant is skipped, not duplicated", async () => {
		const id = await makeUser("user", "bgheld");
		await knowledgeAcl.bulkGrant({ userIds: [id], grantType: "review", tagId: reviewTagId });
		const again = await knowledgeAcl.bulkGrant({
			userIds: [id],
			grantType: "review",
			tagId: reviewTagId,
		});
		expect(again.granted).toBe(0);
		expect(again.skipped).toBe(1);
		expect(again.results[0]?.reason).toBe("already_granted");
		expect(await countUserGrants([id], "review")).toBe(1);
	});

	test("an unknown user is reported per-row while the valid users still land", async () => {
		const good = await makeUser("user", "bgmixed");
		const res = await knowledgeAcl.bulkGrant({
			userIds: [good, `ghost-${generateId(8)}`],
			grantType: "tag",
			tagId: secretTagId,
		});
		expect(res.granted).toBe(1);
		expect(res.failed).toBe(1);
		expect(res.results.find((r) => r.userId === good)?.status).toBe("granted");
		expect(res.results.find((r) => r.userId !== good)?.reason).toBe("user_not_found");
		expect(await countUserGrants([good], "tag")).toBe(1);
	});

	test("collection-scoped grants are written with the collectionId (authority stays scoped)", async () => {
		const col = await knowledgeService.createCollection({
			name: `bulk-scoped-${TAG}-${generateId(4)}`,
		});
		const id = await makeUser("user", "bgscoped");
		await knowledgeAcl.bulkGrant({
			collectionId: col.id,
			userIds: [id],
			grantType: "tag",
			tagId: secretTagId,
		});
		const row = await db.query.aclGrants.findFirst({
			where: and(eq(aclGrants.principalId, id), eq(aclGrants.domainKind, "tag")),
		});
		// The collection scope is expressed as scopeType/scopeId now.
		expect(row?.scopeType).toBe("knowledge_collection");
		expect(row?.scopeId).toBe(col.id);
	});
});

describe("bulkGrant transactionality (no half-applied batch)", () => {
	test("an unknown clearance level aborts before ANY row is written", async () => {
		const ids = [await makeUser("user", "bgtx1"), await makeUser("user", "bgtx2")];
		await expect(
			knowledgeAcl.bulkGrant({
				userIds: ids,
				grantType: "clearance",
				clearanceLevel: `no-such-level-${TAG}`,
			}),
		).rejects.toThrow();
		// Critical assertion: not one grant for either user.
		expect(await countUserGrants(ids, "clearance")).toBe(0);
	});

	test("an unknown tag aborts before ANY row is written", async () => {
		const ids = [await makeUser("user", "bgtx3"), await makeUser("user", "bgtx4")];
		await expect(
			knowledgeAcl.bulkGrant({
				userIds: ids,
				grantType: "tag",
				tagId: `ghost-tag-${generateId(8)}`,
			}),
		).rejects.toThrow();
		expect(await countUserGrants(ids, "tag")).toBe(0);
	});

	test("an unknown collection aborts before ANY row is written", async () => {
		const ids = [await makeUser("user", "bgtx5"), await makeUser("user", "bgtx6")];
		await expect(
			knowledgeAcl.bulkGrant({
				collectionId: `ghost-col-${generateId(8)}`,
				userIds: ids,
				grantType: "tag",
				tagId: secretTagId,
			}),
		).rejects.toThrow();
		expect(await countUserGrants(ids, "tag")).toBe(0);
	});
});

describe("admin gating", () => {
	test("POST /grants/bulk rejects a non-admin without writing anything", async () => {
		const ids = [await makeUser("user", "bggate1")];
		const nonAdmin = await makeUser("user", "bggatecaller");
		const res = await appForRole("user", nonAdmin).request("/knowledge/grants/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ userIds: ids, grantType: "tag", tagId: secretTagId }),
		});
		expect(res.status).toBe(403);
		expect(await countUserGrants(ids, "tag")).toBe(0);
	});

	test("POST /grants/bulk succeeds for an admin", async () => {
		const ids = [await makeUser("user", "bggate2")];
		const res = await appForRole("admin", adminId).request("/knowledge/grants/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ userIds: ids, grantType: "tag", tagId: secretTagId }),
		});
		expect(res.status).toBe(201);
		const body = (await res.json()) as { granted: number };
		expect(body.granted).toBe(1);
		expect(await countUserGrants(ids, "tag")).toBe(1);
	});

	test("POST /grants/bulk rejects an over-limit request with 400 (Zod, before any write)", async () => {
		const res = await appForRole("admin", adminId).request("/knowledge/grants/bulk", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				userIds: Array.from({ length: 201 }, () => generateId()),
				grantType: "tag",
				tagId: secretTagId,
			}),
		});
		expect(res.status).toBe(400);
	});

	test("GET /collections/:id/acl is admin-only and echoes the stored ACL", async () => {
		const col = await knowledgeService.createCollection({
			name: `bulk-aclread-${TAG}-${generateId(4)}`,
			ownerUserId: targetIds[0],
		});
		await knowledgeAcl.updateCollectionAcl(col.id, {
			classificationLevel: "confidential",
			controlledTags: [secretTagId],
		});

		const denied = await appForRole("user", targetIds[1] as string).request(
			`/knowledge/collections/${col.id}/acl`,
		);
		expect(denied.status).toBe(403);

		const allowed = await appForRole("admin", adminId).request(
			`/knowledge/collections/${col.id}/acl`,
		);
		expect(allowed.status).toBe(200);
		const body = (await allowed.json()) as {
			classificationLevel: string | null;
			controlledTags: string[];
			ownerUserId: string | null;
			ownerUsername: string | null;
		};
		expect(body.classificationLevel).toBe("confidential");
		expect(body.controlledTags).toEqual([secretTagId]);
		expect(body.ownerUserId).toBe(targetIds[0]);
		// The owner's display name is resolved server-side so the UI needn't fetch users.
		expect(typeof body.ownerUsername).toBe("string");
	});

	test("GET /collections/:id/acl 404s an unknown collection", async () => {
		const res = await appForRole("admin", adminId).request(
			`/knowledge/collections/ghost-${generateId(8)}/acl`,
		);
		expect(res.status).toBe(404);
	});
});

describe("collection ACL changes drive canRead (end-to-end)", () => {
	test("bulk-granting clearance+tag opens a gated collection; tightening the ACL closes it again", async () => {
		const reader = await makeUser("user", "bgreader");
		const col = await knowledgeService.createCollection({
			name: `bulk-gate-${TAG}-${generateId(4)}`,
		});
		const entry = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `bulk-gate-entry-${TAG}`,
			content: "body",
		});

		// Baseline: no ACL on the collection → world-readable.
		expect((await knowledgeService.getEntry(entry.id, { principal: P(reader) })).id).toBe(entry.id);

		// Tighten the collection: confidential + a controlled compartment. The entry itself is
		// still public, so this proves the COLLECTION is the first gate.
		await knowledgeAcl.updateCollectionAcl(col.id, {
			classificationLevel: "confidential",
			controlledTags: [secretTagId],
		});
		await expect(knowledgeService.getEntry(entry.id, { principal: P(reader) })).rejects.toThrow();
		expect(
			(await knowledgeService.listCollections(undefined, P(reader))).map((c) => c.id),
		).not.toContain(col.id);

		// Bulk-grant the two credentials the gate demands → the entry becomes readable.
		const granted = await knowledgeAcl.bulkGrant({
			userIds: [reader],
			grantType: "clearance",
			clearanceLevel: "confidential",
		});
		expect(granted.granted).toBe(1);
		await knowledgeAcl.bulkGrant({
			userIds: [reader],
			grantType: "tag",
			tagId: secretTagId,
		});
		expect((await knowledgeService.getEntry(entry.id, { principal: P(reader) })).id).toBe(entry.id);
		expect(
			(await knowledgeService.listCollections(undefined, P(reader))).map((c) => c.id),
		).toContain(col.id);

		// Add a SECOND compartment the reader does not hold → closed again, dual-axis AND.
		const extraTagId = generateId();
		await db.insert(knowledgeTags).values({
			id: extraTagId,
			name: `bulk-extra-${TAG}-${generateId(4)}`,
			controlled: true,
			createdAt: nowIso(),
		});
		await knowledgeAcl.updateCollectionAcl(col.id, {
			controlledTags: [secretTagId, extraTagId],
		});
		await expect(knowledgeService.getEntry(entry.id, { principal: P(reader) })).rejects.toThrow();
	});

	test("transferring collection ownership hands the owner short-circuit to the new owner", async () => {
		const oldOwner = await makeUser("user", "bgowner-old");
		const newOwner = await makeUser("user", "bgowner-new");
		const col = await knowledgeService.createCollection({
			name: `bulk-owner-${TAG}-${generateId(4)}`,
			ownerUserId: oldOwner,
		});
		await knowledgeAcl.updateCollectionAcl(col.id, { classificationLevel: "confidential" });
		const entry = await knowledgeService.createEntry({
			collectionId: col.id,
			title: `bulk-owner-entry-${TAG}`,
			content: "b",
		});

		// Owner reads through the gate; the future owner does not.
		expect((await knowledgeService.getEntry(entry.id, { principal: P(oldOwner) })).id).toBe(
			entry.id,
		);
		await expect(knowledgeService.getEntry(entry.id, { principal: P(newOwner) })).rejects.toThrow();

		// The current owner may transfer (admin OR owner — not admin-only).
		await knowledgeService.transferCollectionOwner(col.id, newOwner, P(oldOwner));
		const acl = await knowledgeAcl.getCollectionAcl(col.id);
		expect(acl.ownerUserId).toBe(newOwner);

		// Access follows ownership in both directions.
		expect((await knowledgeService.getEntry(entry.id, { principal: P(newOwner) })).id).toBe(
			entry.id,
		);
		await expect(knowledgeService.getEntry(entry.id, { principal: P(oldOwner) })).rejects.toThrow();
	});
});
