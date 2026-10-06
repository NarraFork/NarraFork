/**
 * Subagent access delegation — a subagent has no access state of its own.
 *
 * Subagents used to copy their parent's `visibility`/`ownerUserId` at creation and
 * never update, so sharing a session AFTERWARDS left its subagents unreachable: the
 * colleague could open the main timeline and then hit 404 on every subtask. Access is
 * now decided on the root narrator, found through `acl_root_narrator_id`.
 *
 * What has to hold:
 *
 *  1. **Changes to the root reach existing subagents immediately.** This is the whole
 *     point: there is nothing to propagate because there is no copy. A test that only
 *     checked a freshly created subagent would have passed under the old behaviour too.
 *  2. **The root's grants apply, with no grant rows on the subagent.**
 *  3. **Revoking on the root revokes on the subagent.**
 *  4. **Nesting follows the same root**, however deep.
 *  5. **Forks do NOT follow their origin.** A fork also carries a
 *     `parentNarratorId` but is an independent session (`type: "primary"`); keying
 *     delegation on "has a parent" instead of `type` would silently take control of
 *     every fork away from its owner.
 *  6. **An unresolvable root FAILS CLOSED** — a null column, a root that is gone, a
 *     cycle. Never a fallback to the subagent's own (frozen, possibly stale) columns.
 *  7. **The SQL predicate agrees with the row check** on all of the above, including
 *     the fail-closed cases. A `coalesce(acl_root_narrator_id, id)` join would judge
 *     an unresolvable subagent by its own columns and leak, and only on the rows whose
 *     backfill failed — the hardest set to notice.
 *  8. **Subagents are not shareable in place**: the panel state reports the governing
 *     session instead of pretending the subagent's own values are in effect.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/narrator-acl-delegation.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, eq, sql } from "drizzle-orm";
import { db, sqlite } from "../../db";
import { aclGrants, narrators, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	canManageNarratorAcl,
	canReadNarrator,
	canWriteNarrator,
	listNarratorAudience,
	type NarratorPrincipal,
	narratorReadableWhere,
	resolveAclRootId,
} from "../narrator-acl";
import { getNarratorAccess, setNarratorVisibility } from "../narrator-sharing";

const TAG = Date.now();

let owner: string;
let colleague: string;
let stranger: string;

const asUser = (userId: string): NarratorPrincipal => ({ userId, isAdmin: false });
const asAdmin = (): NarratorPrincipal => ({ userId: `del-admin-${TAG}`, isAdmin: true });

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

/** A primary narrator, i.e. one judged on its own columns. */
async function makeRoot(
	options: { visibility?: string; writeAudience?: string; ownerUserId?: string | null } = {},
): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `root-${TAG}`,
		type: "primary",
		ownerUserId: options.ownerUserId === undefined ? owner : options.ownerUserId,
		visibility: (options.visibility ?? "private") as "private",
		writeAudience: (options.writeAudience ?? "owner") as "owner",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/**
 * A subagent, written the way `createSubagent` writes one: delegation pointer set,
 * own audiences pinned to their strictest values.
 *
 * `aclRootNarratorId` is overridable so the fail-closed states can be constructed.
 */
async function makeSubagent(options: {
	parentNarratorId: string;
	aclRootNarratorId?: string | null;
	/** Only for the "stale snapshot must not be consulted" case. */
	visibility?: string;
	writeAudience?: string;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `sub-${TAG}`,
		type: "subagent",
		subagentType: "general",
		parentNarratorId: options.parentNarratorId,
		aclRootNarratorId:
			options.aclRootNarratorId === undefined
				? options.parentNarratorId
				: options.aclRootNarratorId,
		ownerUserId: owner,
		visibility: (options.visibility ?? "private") as "private",
		writeAudience: (options.writeAudience ?? "owner") as "owner",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

/** A fork: carries a parent link but is an independent primary session. */
async function makeFork(parentNarratorId: string, visibility: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		title: `fork-${TAG}`,
		type: "primary",
		parentNarratorId,
		ownerUserId: owner,
		visibility: visibility as "private",
		writeAudience: "owner",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function grantNarrator(narratorId: string, userId: string, capability: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

async function rowOf(narratorId: string) {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, narratorId) });
	if (!row) throw new Error(`missing narrator ${narratorId}`);
	return row;
}

async function readableIdsViaSql(
	principal: NarratorPrincipal,
	ids: string[],
): Promise<Set<string>> {
	const rows = await db
		.select({ id: narrators.id })
		.from(narrators)
		.where(and(sql`${narrators.id} IN ${ids}`, narratorReadableWhere(principal)));
	return new Set(rows.map((row) => row.id));
}

/** Assert both decision paths agree, and report which one dissented when they do not. */
async function expectAgreement(narratorId: string, principal: NarratorPrincipal) {
	const viaRow = await canReadNarrator(await rowOf(narratorId), principal);
	const viaSql = (await readableIdsViaSql(principal, [narratorId])).has(narratorId);
	expect({ path: "sql", value: viaSql }).toEqual({ path: "sql", value: viaRow });
	return viaRow;
}

beforeAll(async () => {
	owner = await makeUser("del-owner");
	colleague = await makeUser("del-colleague");
	stranger = await makeUser("del-stranger");
});

// ─── 1. Changes to the root reach existing subagents ─────────────────────

describe("a later change on the root reaches existing subagents", () => {
	test("making the root public makes its already-created subagent readable", async () => {
		const root = await makeRoot({ visibility: "private" });
		const sub = await makeSubagent({ parentNarratorId: root });

		// Before: private, so a stranger sees neither.
		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(false);

		await setNarratorVisibility(root, "public", asUser(owner));

		// After: the subagent follows, with nothing written to the subagent row.
		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(true);
		expect(await expectAgreement(sub, asUser(stranger))).toBe(true);
	});

	test("opening the root's write audience lets others drive its subagent", async () => {
		const root = await makeRoot({ visibility: "public", writeAudience: "owner" });
		const sub = await makeSubagent({ parentNarratorId: root });
		expect(await canWriteNarrator(await rowOf(sub), asUser(stranger))).toBe(false);

		await db.update(narrators).set({ writeAudience: "public" }).where(eq(narrators.id, root));

		expect(await canWriteNarrator(await rowOf(sub), asUser(stranger))).toBe(true);
	});

	test("narrowing the root back to private revokes the subagent again", async () => {
		const root = await makeRoot({ visibility: "public" });
		const sub = await makeSubagent({ parentNarratorId: root });
		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(true);

		await setNarratorVisibility(root, "private", asUser(owner));

		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(false);
		expect(await expectAgreement(sub, asUser(stranger))).toBe(false);
	});
});

// ─── 2 & 3. The root's grants apply, and revoking them revokes ───────────

describe("grants live on the root", () => {
	test("a write grant on the root confers read+write on the subagent", async () => {
		const root = await makeRoot();
		const sub = await makeSubagent({ parentNarratorId: root });
		await grantNarrator(root, colleague, "write");

		expect(await canReadNarrator(await rowOf(sub), asUser(colleague))).toBe(true);
		expect(await canWriteNarrator(await rowOf(sub), asUser(colleague))).toBe(true);

		// And no grant row was needed on the subagent itself.
		const own = await db
			.select({ id: aclGrants.id })
			.from(aclGrants)
			.where(and(eq(aclGrants.scopeType, "narrator"), eq(aclGrants.scopeId, sub)));
		expect(own).toEqual([]);
	});

	test("a read grant on the root does not confer write on the subagent", async () => {
		const root = await makeRoot();
		const sub = await makeSubagent({ parentNarratorId: root });
		await grantNarrator(root, colleague, "read");

		expect(await canReadNarrator(await rowOf(sub), asUser(colleague))).toBe(true);
		expect(await canWriteNarrator(await rowOf(sub), asUser(colleague))).toBe(false);
	});

	test("revoking the root's grant revokes the subagent", async () => {
		const root = await makeRoot();
		const sub = await makeSubagent({ parentNarratorId: root });
		await grantNarrator(root, colleague, "read");
		expect(await canReadNarrator(await rowOf(sub), asUser(colleague))).toBe(true);

		await db
			.delete(aclGrants)
			.where(and(eq(aclGrants.scopeType, "narrator"), eq(aclGrants.scopeId, root)));

		expect(await canReadNarrator(await rowOf(sub), asUser(colleague))).toBe(false);
		expect(await expectAgreement(sub, asUser(colleague))).toBe(false);
	});
});

// ─── 4. Nesting ──────────────────────────────────────────────────────────

describe("nested subagents", () => {
	test("a subagent of a subagent follows the same root", async () => {
		const root = await makeRoot({ visibility: "public" });
		const sub = await makeSubagent({ parentNarratorId: root });
		// createSubagent copies the parent's root pointer rather than pointing at the
		// parent, so the chain is never walked on a decision path.
		const nested = await makeSubagent({ parentNarratorId: sub, aclRootNarratorId: root });

		expect(await resolveAclRootId(await rowOf(nested))).toBe(root);
		expect(await canReadNarrator(await rowOf(nested), asUser(stranger))).toBe(true);
		expect(await expectAgreement(nested, asUser(stranger))).toBe(true);
	});
});

// ─── 5. Forks are independent ────────────────────────────────────────────

describe("forks do not delegate", () => {
	test("a fork keeps its own audience even though it has a parent", async () => {
		const root = await makeRoot({ visibility: "public" });
		// The fork was narrowed after being created; it must not be dragged back to
		// public by its origin.
		const fork = await makeFork(root, "private");

		expect(await resolveAclRootId(await rowOf(fork))).toBe(fork);
		expect(await canReadNarrator(await rowOf(fork), asUser(stranger))).toBe(false);
		expect(await expectAgreement(fork, asUser(stranger))).toBe(false);
	});

	test("a fork's owner can still manage it", async () => {
		const root = await makeRoot({ visibility: "public" });
		const fork = await makeFork(root, "private");
		expect(await canManageNarratorAcl(await rowOf(fork), asUser(owner))).toBe(true);
	});
});

// ─── 6 & 7. Unresolvable roots fail closed, in both paths ────────────────

describe("unresolvable delegation fails closed", () => {
	test("a null root denies, even with a stale wide-open snapshot on the row", async () => {
		const root = await makeRoot({ visibility: "public" });
		// Exactly the shape a failed migration backfill leaves: no pointer, plus the
		// legacy copy of the parent's public visibility still sitting on the row. A
		// `coalesce(acl_root_narrator_id, id)` join would read that copy and leak.
		const orphan = await makeSubagent({
			parentNarratorId: root,
			aclRootNarratorId: null,
			visibility: "public",
			writeAudience: "public",
		});

		expect(await canReadNarrator(await rowOf(orphan), asUser(stranger))).toBe(false);
		expect(await canWriteNarrator(await rowOf(orphan), asUser(stranger))).toBe(false);
		expect(await expectAgreement(orphan, asUser(stranger))).toBe(false);
	});

	test("even the recorded owner loses access when the root is unresolvable", async () => {
		// Fail-closed means fail closed: ownership is read from the judged row, and there
		// is no judged row. Admins remain the recovery path.
		const root = await makeRoot();
		const orphan = await makeSubagent({ parentNarratorId: root, aclRootNarratorId: null });
		expect(await canReadNarrator(await rowOf(orphan), asUser(owner))).toBe(false);
		expect(await canReadNarrator(await rowOf(orphan), asAdmin())).toBe(true);
	});

	test("a root pointing at a row that no longer exists denies", async () => {
		const root = await makeRoot({ visibility: "public" });
		const sub = await makeSubagent({ parentNarratorId: root });
		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(true);

		// The column is a foreign key with `set null` on delete, so the database prevents
		// this state from arising normally — which is good, and also why producing it here
		// needs keys suspended. The check must still refuse rather than trust the pointer,
		// because a restored backup or a manual repair could leave one behind.
		sqlite.exec("PRAGMA foreign_keys = OFF");
		try {
			await db
				.update(narrators)
				.set({ aclRootNarratorId: `gone-${generateId()}` })
				.where(eq(narrators.id, sub));
		} finally {
			sqlite.exec("PRAGMA foreign_keys = ON");
		}

		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(false);
		expect(await expectAgreement(sub, asUser(stranger))).toBe(false);
	});

	test("the fan-out audience reports nobody, matching what the read check decides", async () => {
		// listNarratorAudience is the third consumer of the delegation, and it used to be
		// the only one that fell back to the subagent's own row. On exactly the shape above
		// — backfill failed, stale `public` snapshot left behind — it answered
		// `{ everyone: true }` while canReadNarrator denied every one of those people.
		// notification-service reads `everyone` as "notify all candidates", so the
		// disagreement pushed a session title to users who get a 404 on opening it.
		const root = await makeRoot({ visibility: "public" });
		const orphan = await makeSubagent({
			parentNarratorId: root,
			aclRootNarratorId: null,
			visibility: "public",
			writeAudience: "public",
		});

		expect(await listNarratorAudience(await rowOf(orphan))).toEqual({
			everyone: false,
			userIds: [],
		});
		// The resolvable sibling still reports the root's audience, so this is a fail-closed
		// branch rather than the audience being broken for subagents in general.
		const healthy = await makeSubagent({ parentNarratorId: root });
		expect(await listNarratorAudience(await rowOf(healthy))).toEqual({ everyone: true });
	});

	test("a self-referential pointer does not loop or grant", async () => {
		const root = await makeRoot({ visibility: "public" });
		const sub = await makeSubagent({ parentNarratorId: root });
		// A cycle cannot arise from the write paths, but the resolution must terminate
		// regardless: it reads the pointer once and never walks.
		await db.update(narrators).set({ aclRootNarratorId: sub }).where(eq(narrators.id, sub));

		// Resolves to itself — a subagent row whose own audiences are the strict defaults,
		// so a stranger is refused.
		expect(await canReadNarrator(await rowOf(sub), asUser(stranger))).toBe(false);
		expect(await expectAgreement(sub, asUser(stranger))).toBe(false);
	});
});

// ─── 8. Subagents are not shareable in place ─────────────────────────────

describe("the sharing surface", () => {
	test("reports the governing session's state, not the subagent's frozen columns", async () => {
		const root = await makeRoot({ visibility: "public", writeAudience: "project" });
		const sub = await makeSubagent({ parentNarratorId: root });

		const view = await getNarratorAccess(sub, asUser(owner));
		expect(view.isDelegated).toBe(true);
		expect(view.delegatesToNarratorId).toBe(root);
		// The root's values, not the pinned private/owner on the subagent row.
		expect(view.visibility).toBe("public");
		expect(view.writeAudience).toBe("project");
		// Never editable in place, not even by the owner.
		expect(view.canManage).toBe(false);
	});

	test("a primary narrator reports itself as not delegated", async () => {
		const root = await makeRoot({ visibility: "public" });
		const view = await getNarratorAccess(root, asUser(owner));
		expect(view.isDelegated).toBe(false);
		expect(view.delegatesToNarratorId).toBe(null);
		expect(view.canManage).toBe(true);
	});

	test("changing a subagent's sharing is refused with an explanation", async () => {
		const root = await makeRoot();
		const sub = await makeSubagent({ parentNarratorId: root });
		// Not a 404: the caller can see it, so hiding the reason would only confuse.
		// Silently accepting the change would be worse — it would take no effect.
		await expect(setNarratorVisibility(sub, "public", asUser(owner))).rejects.toThrow(
			/main session/i,
		);
	});

	test("admins cannot edit a subagent's sharing in place either", async () => {
		const root = await makeRoot();
		const sub = await makeSubagent({ parentNarratorId: root });
		await expect(setNarratorVisibility(sub, "public", asAdmin())).rejects.toThrow(/main session/i);
	});
});
