/**
 * narrator-acl tests — the properties access control has to keep.
 *
 * 1. **Private is private.** A narrator nobody shared is invisible to everyone but
 *    its owner (and admins). This is the whole point of the feature.
 * 2. **Read never implies write.** Making a narrator public shares a view of the
 *    work; it must not let strangers issue commands or approve tool calls.
 * 3. **Re-sharing stays with the owner.** A write grant is permission to work in
 *    the session, not to hand it to more people.
 * 4. **Legacy narrators (null owner) are manageable by admins only** — the direct
 *    consequence of not inventing an owner during the backfill.
 * 5. **Denial reports "not found"**, so no endpoint becomes an id oracle.
 * 6. **The SQL predicate and the row predicate agree.** They are separate code
 *    paths (list vs single), and a divergence would leak in exactly the case that
 *    is hardest to notice: rows appearing in a list that then 404 on open.
 * 7. **Unknown visibility values fail closed.**
 *
 * Runs against an isolated DB under a temp NARRAFORK_HOME (same convention as
 * chat-service.test.ts).
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/narrator-acl.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, narrators, users } from "../../db/schema";
import { NotFoundError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import {
	assertNarratorAccess,
	canManageNarratorAcl,
	canReadNarrator,
	canWriteNarrator,
	defaultVisibilityForNarrator,
	filterReadableNarrators,
	listNarratorAudience,
	type NarratorPrincipal,
	narratorReadableWhere,
} from "../narrator-acl";

const TAG = Date.now();

let ownerId: string;
let strangerId: string;
let friendId: string;

const admin = (): NarratorPrincipal => ({ userId: "admin-user", isAdmin: true });
const asUser = (userId: string): NarratorPrincipal => ({ userId, isAdmin: false });

async function makeUser(label: string): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `${label}-${TAG}-${generateId(6)}`,
		passwordHash: "x",
		role: "user",
		createdAt: new Date().toISOString(),
	});
	return id;
}

async function makeNarrator(options: {
	ownerUserId?: string | null;
	visibility?: string;
	chapterId?: string | null;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `acl-${TAG}`,
		ownerUserId: options.ownerUserId ?? null,
		// Cast: the tests deliberately cover an out-of-enum value to prove the
		// predicate fails closed, which the column's TS enum would otherwise forbid.
		visibility: (options.visibility ?? "private") as "private",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/**
 * Share a narrator with a user.
 *
 * Writes to the unified `acl_grants` table, which is what the ACL layer reads now.
 * The legacy `narrator_grants` table still exists for rollback but is no longer
 * consulted, so a fixture writing there would silently grant nothing.
 */
async function grant(narratorId: string, userId: string, access: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability: access,
		grantedBy: ownerId,
		createdAt: new Date().toISOString(),
	});
}

/** The narrator row shape the ACL functions consume. */
async function rowOf(narratorId: string) {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!row) throw new Error(`missing narrator ${narratorId}`);
	return row;
}

/** Ids this principal can see according to the SQL predicate, restricted to `ids`. */
async function readableIdsViaSql(
	principal: NarratorPrincipal,
	ids: string[],
): Promise<Set<string>> {
	const predicate = narratorReadableWhere(principal);
	const rows = await db
		.select({ id: narrators.id })
		.from(narrators)
		.where(and(sql`${narrators.id} IN ${ids}`, predicate));
	return new Set(rows.map((row) => row.id));
}

beforeAll(async () => {
	ownerId = await makeUser("acl-owner");
	strangerId = await makeUser("acl-stranger");
	friendId = await makeUser("acl-friend");
});

// ─── 1. Private stays private ────────────────────────────────────────────

describe("private narrators", () => {
	test("the owner can read and write their own", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		expect(await canReadNarrator(row, asUser(ownerId))).toBe(true);
		expect(await canWriteNarrator(row, asUser(ownerId))).toBe(true);
	});

	test("a stranger can neither read nor write", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		expect(await canReadNarrator(row, asUser(strangerId))).toBe(false);
		expect(await canWriteNarrator(row, asUser(strangerId))).toBe(false);
	});

	test("an admin can read and write anyone's", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		expect(await canReadNarrator(row, admin())).toBe(true);
		expect(await canWriteNarrator(row, admin())).toBe(true);
	});

	test("standalone narrators default to private, chapter-bound to project", () => {
		expect(defaultVisibilityForNarrator(null)).toBe("private");
		expect(defaultVisibilityForNarrator(undefined)).toBe("private");
		expect(defaultVisibilityForNarrator("chapter-1")).toBe("project");
	});
});

// ─── 2. Read never implies write ─────────────────────────────────────────

describe("visibility grants read only", () => {
	test("public lets any signed-in user read but not write", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId, visibility: "public" }));
		expect(await canReadNarrator(row, asUser(strangerId))).toBe(true);
		expect(await canWriteNarrator(row, asUser(strangerId))).toBe(false);
	});

	test("project visibility no longer means 'anyone', it means project members", async () => {
		// Behaviour change: `project` used to resolve the same as `public` because every
		// signed-in user could reach every project. Now it is gated on membership, and a
		// standalone narrator (no chapter, hence no project) grants nothing at all — it
		// must not become a backdoor to "visible to everybody with nothing constraining
		// it".
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId, visibility: "project" }));
		expect(await canReadNarrator(row, asUser(strangerId))).toBe(false);
		expect(await canWriteNarrator(row, asUser(strangerId))).toBe(false);
	});

	test("a read grant does not confer write", async () => {
		const id = await makeNarrator({ ownerUserId: ownerId });
		await grant(id, friendId, "read");
		const row = await rowOf(id);
		expect(await canReadNarrator(row, asUser(friendId))).toBe(true);
		expect(await canWriteNarrator(row, asUser(friendId))).toBe(false);
	});

	test("a write grant confers both", async () => {
		const id = await makeNarrator({ ownerUserId: ownerId });
		await grant(id, friendId, "write");
		const row = await rowOf(id);
		expect(await canReadNarrator(row, asUser(friendId))).toBe(true);
		expect(await canWriteNarrator(row, asUser(friendId))).toBe(true);
	});
});

// ─── 3. Re-sharing stays with the owner ──────────────────────────────────

describe("who may change sharing", () => {
	test("the owner may", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		expect(canManageNarratorAcl(row, asUser(ownerId))).toBe(true);
	});

	test("a write-granted user may not", async () => {
		const id = await makeNarrator({ ownerUserId: ownerId });
		await grant(id, friendId, "write");
		const row = await rowOf(id);
		expect(canManageNarratorAcl(row, asUser(friendId))).toBe(false);
	});

	test("a stranger may not, even on a public narrator", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId, visibility: "public" }));
		expect(canManageNarratorAcl(row, asUser(strangerId))).toBe(false);
	});
});

// ─── 4. Legacy narrators (null owner) ────────────────────────────────────

describe("narrators with no owner", () => {
	test("only admins may manage them", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: null, visibility: "public" }));
		expect(canManageNarratorAcl(row, admin())).toBe(true);
		expect(canManageNarratorAcl(row, asUser(strangerId))).toBe(false);
	});

	test("a null owner is not matched by a null-ish user id", async () => {
		// Guards against `row.ownerUserId === principal.userId` ever being reached
		// with both sides empty, which would make every ownerless narrator writable.
		const row = await rowOf(await makeNarrator({ ownerUserId: null }));
		expect(await canReadNarrator(row, asUser(""))).toBe(false);
		expect(await canWriteNarrator(row, asUser(""))).toBe(false);
	});
});

// ─── 5. Denial reports "not found" ───────────────────────────────────────

describe("denial shape", () => {
	test("assertNarratorAccess throws NotFoundError, never a forbidden error", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		await expect(assertNarratorAccess(row, asUser(strangerId), "read")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("assertNarratorAccess passes silently when allowed", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId }));
		expect(await assertNarratorAccess(row, asUser(ownerId), "write")).toBeUndefined();
	});

	test("a public narrator still denies write with NotFoundError", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId, visibility: "public" }));
		await expect(assertNarratorAccess(row, asUser(strangerId), "write")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});
});

// ─── 6. SQL predicate agrees with the row predicate ──────────────────────

describe("list predicate matches single-row decisions", () => {
	test("every combination decides the same way in SQL and in memory", async () => {
		const privateOwned = await makeNarrator({ ownerUserId: ownerId });
		const privateOther = await makeNarrator({ ownerUserId: strangerId });
		const sharedRead = await makeNarrator({ ownerUserId: strangerId });
		await grant(sharedRead, ownerId, "read");
		const publicOther = await makeNarrator({ ownerUserId: strangerId, visibility: "public" });
		const projectOther = await makeNarrator({ ownerUserId: strangerId, visibility: "project" });
		const orphan = await makeNarrator({ ownerUserId: null, visibility: "public" });
		const ids = [privateOwned, privateOther, sharedRead, publicOther, projectOther, orphan];

		const principal = asUser(ownerId);
		const viaSql = await readableIdsViaSql(principal, ids);
		for (const id of ids) {
			const viaRow = await canReadNarrator(await rowOf(id), principal);
			expect(viaSql.has(id)).toBe(viaRow);
		}
		// Sanity: the fixture is actually mixed, so the agreement above means something.
		expect(viaSql.has(privateOwned)).toBe(true);
		expect(viaSql.has(privateOther)).toBe(false);
		expect(viaSql.has(sharedRead)).toBe(true);
	});

	test("admins get no restriction rather than an empty result", async () => {
		expect(narratorReadableWhere(admin())).toBeUndefined();
	});

	test("the predicate also works inside a relational query callback", async () => {
		// Regression: Drizzle rewrites embedded column references in a relational-query
		// `where` callback to the OUTER table's alias, which turned the grant subquery's
		// `narrator_grants.narrator_id` into `narrators.narrator_id` and made every
		// query using this path (the story graph, chapter listings) fail to prepare.
		const mine = await makeNarrator({ ownerUserId: ownerId });
		const shared = await makeNarrator({ ownerUserId: strangerId });
		await grant(shared, ownerId, "read");
		const hidden = await makeNarrator({ ownerUserId: strangerId });

		const rows = await db.query.narrators.findMany({
			where: (n, { and: andFn, inArray }) =>
				andFn(inArray(n.id, [mine, shared, hidden]), narratorReadableWhere(asUser(ownerId))),
			columns: { id: true },
		});

		expect(new Set(rows.map((row) => row.id))).toEqual(new Set([mine, shared]));
	});

	test("filterReadableNarrators matches the SQL predicate", async () => {
		const mine = await makeNarrator({ ownerUserId: ownerId });
		const hidden = await makeNarrator({ ownerUserId: strangerId });
		const shared = await makeNarrator({ ownerUserId: strangerId });
		await grant(shared, ownerId, "read");
		const ids = [mine, hidden, shared];

		const rows = await Promise.all(ids.map((id) => rowOf(id)));
		const kept = new Set(
			(await filterReadableNarrators(rows, asUser(ownerId))).map((row) => row.id),
		);

		expect(kept).toEqual(await readableIdsViaSql(asUser(ownerId), ids));
	});

	test("filterReadableNarrators keeps everything for an admin", async () => {
		const rows = await Promise.all([
			rowOf(await makeNarrator({ ownerUserId: ownerId })),
			rowOf(await makeNarrator({ ownerUserId: strangerId })),
		]);
		expect((await filterReadableNarrators(rows, admin())).length).toBe(2);
	});
});

// ─── 7. Fail closed ─────────────────────────────────────────────────────

describe("unknown visibility values", () => {
	test("an unrecognized visibility grants nothing", async () => {
		const row = await rowOf(
			await makeNarrator({ ownerUserId: ownerId, visibility: "everyone-lol" }),
		);
		expect(await canReadNarrator(row, asUser(strangerId))).toBe(false);
		expect(await canWriteNarrator(row, asUser(strangerId))).toBe(false);
	});

	test("an unrecognized visibility is excluded by the SQL predicate too", async () => {
		const id = await makeNarrator({ ownerUserId: ownerId, visibility: "everyone-lol" });
		expect((await readableIdsViaSql(asUser(strangerId), [id])).has(id)).toBe(false);
	});
});

// ─── Audience resolution (fan-out safety) ───────────────────────────────

describe("listNarratorAudience", () => {
	test("reports 'everyone' for public rather than enumerating users", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: ownerId, visibility: "public" }));
		expect(await listNarratorAudience(row)).toEqual({ everyone: true });
	});

	test("lists the owner plus granted users for a private narrator", async () => {
		const id = await makeNarrator({ ownerUserId: ownerId });
		await grant(id, friendId, "read");
		const audience = await listNarratorAudience(await rowOf(id));
		expect(audience.everyone).toBe(false);
		if (audience.everyone) throw new Error("unreachable");
		expect(new Set(audience.userIds)).toEqual(new Set([ownerId, friendId]));
	});

	test("omits a null owner instead of emitting a null user id", async () => {
		const id = await makeNarrator({ ownerUserId: null });
		await grant(id, friendId, "read");
		const audience = await listNarratorAudience(await rowOf(id));
		if (audience.everyone) throw new Error("unreachable");
		expect(audience.userIds).toEqual([friendId]);
	});
});
