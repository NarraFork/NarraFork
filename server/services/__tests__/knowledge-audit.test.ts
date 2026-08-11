/**
 * Knowledge ACL audit trail tests.
 *
 * The knowledge base gates content on classification level + controlled tags, but every mutation of
 * that gate used to be untraceable — "who gave this account access to the confidential
 * compartment?" had no answer after the fact. These tests pin the trail:
 *
 *  1. every ACL surface writes an event (grants, bulk grants, per-user ACL, entry/collection ACL,
 *     ownership transfers), with the ACTOR recorded
 *  2. a revocation is captured even though the grant row is gone by then
 *  3. `detailJson` stays REDACTED: level names / tag ids / flags only, never entry content
 *  4. reads are admin-only and keyset-paginated (no OFFSET, no COUNT(*))
 *
 * Runs against a real isolated DB under a temp NARRAFORK_HOME, driving the real Hono routes so the
 * admin gating and the actor plumbing are both exercised.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Hono } from "hono";
import { db } from "../../db";
import { knowledgeTags, users } from "../../db/schema";
import { AppError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { knowledgeRoutes } from "../../routes/knowledge";
import { knowledgeAcl } from "../knowledge-acl";
import { listKnowledgeAclEvents } from "../knowledge-audit";
import { knowledgeService } from "../knowledge-service";

const TAG = Date.now();

let adminId: string;
let plainId: string;
let subjectId: string;
let collectionId: string;
let controlledTagId: string;

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

/** Audit writes are fire-and-forget by design; give them a tick to land. */
async function settle(): Promise<void> {
	for (let i = 0; i < 10; i++) await Promise.resolve();
	await new Promise((r) => setTimeout(r, 25));
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

/** Newest audit event for a target, or undefined. */
async function latestFor(targetId: string) {
	const { events } = await listKnowledgeAclEvents({ targetId, limit: 10 });
	return events[0];
}

beforeAll(async () => {
	adminId = await makeUser("admin", "audit-admin");
	plainId = await makeUser("user", "audit-plain");
	subjectId = await makeUser("user", "audit-subject");

	const col = await knowledgeService.createCollection({ name: `audit-${TAG}` });
	collectionId = col.id;

	controlledTagId = generateId();
	await db.insert(knowledgeTags).values({
		id: controlledTagId,
		name: `audit-tag-${TAG}`,
		collectionId: null,
		typeId: null,
		controlled: true,
		createdAt: new Date().toISOString(),
	});
});

describe("grant lifecycle is audited", () => {
	test("granting records the actor, subject and credential — but no content", async () => {
		const res = await appFor({ userId: adminId, role: "admin" }).request("/knowledge/grants", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				principalType: "user",
				principalId: subjectId,
				grantType: "clearance",
				clearanceLevel: "confidential",
			}),
		});
		expect(res.status).toBe(201);
		const grant = (await res.json()) as { id: string };
		await settle();

		const event = await latestFor(grant.id);
		expect(event?.eventType).toBe("grant_added");
		// The whole point: the acting admin is named, not just "a grant appeared".
		expect(event?.actorUserId).toBe(adminId);
		expect(event?.actorRole).toBe("admin");
		expect(event?.subjectType).toBe("user");
		expect(event?.subjectId).toBe(subjectId);
		const detail = event?.detailJson as Record<string, unknown>;
		expect(detail.grantType).toBe("clearance");
		expect(detail.clearanceLevel).toBe("confidential");
	});

	test("revoking is recorded even though the grant row is already gone", async () => {
		const created = await knowledgeAcl.createGrant(
			{
				principalType: "user",
				principalId: subjectId,
				grantType: "tag",
				tagId: controlledTagId,
			},
			{ userId: adminId, role: "admin" },
		);
		const grantId = (created as { id: string }).id;
		await settle();

		const res = await appFor({ userId: adminId, role: "admin" }).request(
			`/knowledge/grants/${grantId}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		await settle();

		// Two events for this grant id: added, then removed (newest first).
		const { events } = await listKnowledgeAclEvents({ targetId: grantId, limit: 10 });
		expect(events[0]?.eventType).toBe("grant_removed");
		expect(events[0]?.subjectId).toBe(subjectId);
		// The revoked credential is described from the pre-delete read.
		expect((events[0]?.detailJson as Record<string, unknown>).tagId).toBe(controlledTagId);
		expect(events[1]?.eventType).toBe("grant_added");
	});

	test("a bulk grant writes ONE event listing the affected users", async () => {
		const u1 = await makeUser("user", "audit-bulk1");
		const u2 = await makeUser("user", "audit-bulk2");
		const before = (await listKnowledgeAclEvents({ eventType: "grants_bulk_added", limit: 100 }))
			.events.length;

		await knowledgeAcl.bulkGrant(
			{ userIds: [u1, u2], grantType: "clearance", clearanceLevel: "internal" },
			{ userId: adminId, role: "admin" },
		);
		await settle();

		const { events } = await listKnowledgeAclEvents({ eventType: "grants_bulk_added", limit: 100 });
		// One admin action → one row, not N (N rows would bury the action in noise).
		expect(events.length).toBe(before + 1);
		const detail = events[0]?.detailJson as { grantedUserIds?: string[] };
		expect([...(detail.grantedUserIds ?? [])].sort()).toEqual([u1, u2].sort());
	});

	test("replacing a user's ACL records the resulting credential set", async () => {
		const target = await makeUser("user", "audit-replace");
		await appFor({ userId: adminId, role: "admin" }).request(`/knowledge/users/${target}/acl`, {
			method: "PUT",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ clearanceLevel: "internal", tagIds: [controlledTagId] }),
		});
		await settle();

		const { events } = await listKnowledgeAclEvents({ subjectId: target, limit: 10 });
		expect(events[0]?.eventType).toBe("user_acl_replaced");
		expect(events[0]?.actorUserId).toBe(adminId);
		const detail = events[0]?.detailJson as Record<string, unknown>;
		expect(detail.clearanceLevel).toBe("internal");
		expect(detail.tagIds).toEqual([controlledTagId]);
	});
});

describe("entry / collection ACL changes are audited", () => {
	test("changing an entry's classification records before and after — never the body", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `AuditEntry ${TAG}`,
			content: "SECRET-BODY-MARKER should never appear in an audit row\n",
		});
		await appFor({ userId: adminId, role: "admin" }).request(`/knowledge/entries/${entry.id}/acl`, {
			method: "PATCH",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				classificationLevel: "confidential",
				controlledTags: [controlledTagId],
			}),
		});
		await settle();

		const event = await latestFor(entry.id);
		expect(event?.eventType).toBe("entry_acl_updated");
		expect(event?.actorUserId).toBe(adminId);
		const detail = event?.detailJson as {
			before?: Record<string, unknown>;
			changed?: Record<string, unknown>;
		};
		expect(detail.before?.classificationLevel).toBeNull();
		expect(detail.changed?.classificationLevel).toBe("confidential");
		expect(detail.changed?.controlledTags).toEqual([controlledTagId]);
		// Redaction guarantee: the audit row must never carry entry content.
		expect(JSON.stringify(event?.detailJson)).not.toContain("SECRET-BODY-MARKER");
	});

	test("changing a collection's ACL is audited with before/after", async () => {
		const col = await knowledgeService.createCollection({ name: `audit-col-${TAG}` });
		await appFor({ userId: adminId, role: "admin" }).request(
			`/knowledge/collections/${col.id}/acl`,
			{
				method: "PATCH",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ classificationLevel: "internal" }),
			},
		);
		await settle();

		const event = await latestFor(col.id);
		expect(event?.eventType).toBe("collection_acl_updated");
		const detail = event?.detailJson as { after?: Record<string, unknown> };
		expect(detail.after?.classificationLevel).toBe("internal");
	});

	test("deleting a collection is audited, and records the gate that just disappeared", async () => {
		// Deletion cascades to every entry inside, and the route is open to a collection OWNER
		// rather than admin only — so it is the most destructive way to end an authorization and
		// the one most in need of a trail. It used to write nothing at all.
		const col = await knowledgeService.createCollection({
			name: `audit-del-col-${TAG}`,
			ownerUserId: plainId,
		});
		await knowledgeAcl.updateCollectionAcl(
			col.id,
			{ classificationLevel: "confidential", controlledTags: [controlledTagId] },
			{ userId: adminId, role: "admin" },
		);
		await knowledgeService.createEntry({
			collectionId: col.id,
			title: `AuditDel ${TAG}`,
			content: "CASCADE-BODY-MARKER must not reach the audit row\n",
		});

		// Deleted by the OWNER, not an admin: the actor recorded must be that owner.
		const res = await appFor({ userId: plainId, role: "user" }).request(
			`/knowledge/collections/${col.id}`,
			{ method: "DELETE" },
		);
		expect(res.status).toBe(200);
		await settle();

		const event = await latestFor(col.id);
		expect(event?.eventType).toBe("collection_deleted");
		expect(event?.actorUserId).toBe(plainId);
		expect(event?.targetType).toBe("collection");
		const detail = event?.detailJson as Record<string, unknown>;
		// The gate is captured from the row read BEFORE the delete; afterwards there is
		// nothing left to read it from.
		expect(detail.classificationLevel).toBe("confidential");
		expect(detail.controlledTags).toEqual([controlledTagId]);
		expect(detail.ownerUserId).toBe(plainId);
		// Same redaction guarantee as everywhere else: no cascaded entry content.
		expect(JSON.stringify(event?.detailJson)).not.toContain("CASCADE-BODY-MARKER");
	});

	test("ownership transfers are audited for both entries and collections", async () => {
		const entry = await knowledgeService.createEntry({
			collectionId,
			title: `AuditOwner ${TAG}`,
			content: "body\n",
		});
		await knowledgeService.transferEntryOwner(entry.id, subjectId, {
			userId: adminId,
			role: "admin",
		});
		await settle();
		const entryEvent = await latestFor(entry.id);
		expect(entryEvent?.eventType).toBe("entry_owner_transferred");
		expect((entryEvent?.detailJson as Record<string, unknown>).newOwnerUserId).toBe(subjectId);

		const col = await knowledgeService.createCollection({ name: `audit-owner-col-${TAG}` });
		await knowledgeService.transferCollectionOwner(col.id, subjectId, {
			userId: adminId,
			role: "admin",
		});
		await settle();
		const colEvent = await latestFor(col.id);
		expect(colEvent?.eventType).toBe("collection_owner_transferred");
		expect(colEvent?.subjectId).toBe(subjectId);
	});
});

describe("audit reads", () => {
	test("the endpoint is admin-only", async () => {
		const denied = await appFor({ userId: plainId, role: "user" }).request("/knowledge/acl-events");
		expect(denied.status).toBe(403);
		const ok = await appFor({ userId: adminId, role: "admin" }).request("/knowledge/acl-events");
		expect(ok.status).toBe(200);
	});

	test("keyset pagination walks the log without repeats or gaps", async () => {
		// Generate a known run of events on one subject.
		const target = await makeUser("user", "audit-page");
		const grantIds: string[] = [];
		for (const level of ["public", "internal", "confidential"]) {
			const g = await knowledgeAcl.createGrant(
				{
					principalType: "user",
					principalId: target,
					grantType: "clearance",
					clearanceLevel: level,
					collectionId: (await knowledgeService.createCollection({ name: `p-${level}-${TAG}` })).id,
				},
				{ userId: adminId, role: "admin" },
			);
			grantIds.push((g as { id: string }).id);
		}
		await settle();

		const page1 = await listKnowledgeAclEvents({ subjectId: target, limit: 2 });
		expect(page1.events).toHaveLength(2);
		expect(page1.hasMore).toBe(true);
		expect(page1.nextCursor).not.toBeNull();

		const page2 = await listKnowledgeAclEvents({
			subjectId: target,
			limit: 2,
			cursorCreatedAt: page1.nextCursor?.createdAt,
			cursorId: page1.nextCursor?.id,
		});
		// Third event, no overlap with page 1.
		expect(page2.events).toHaveLength(1);
		const seen = [...page1.events, ...page2.events].map((e) => e.id);
		expect(new Set(seen).size).toBe(3);
		expect(page2.hasMore).toBe(false);
		expect(page2.nextCursor).toBeNull();
	});

	test("limit is capped so a client cannot request an unbounded page", async () => {
		const res = await appFor({ userId: adminId, role: "admin" }).request(
			"/knowledge/acl-events?limit=5000",
		);
		// Zod rejects out-of-range limits before any query runs.
		expect(res.status).toBe(400);
	});

	test("filtering by actor returns only that admin's actions", async () => {
		const { events } = await listKnowledgeAclEvents({ actorUserId: adminId, limit: 100 });
		expect(events.length).toBeGreaterThan(0);
		expect(events.every((e) => e.actorUserId === adminId)).toBe(true);
	});
});
