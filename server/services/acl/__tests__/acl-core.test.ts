/**
 * The shared authorization kernel.
 *
 * The tests are organized around the mistakes that are easy to make and expensive
 * to discover, because every one of them fails in the direction of a leak:
 *
 *  1. **A gate is not an authorization.** Holding read on a project must not
 *     produce read on a narrator inside it. This is the rule that keeps private
 *     sessions private now that projects have members, and it is the one the first
 *     draft of the design got wrong.
 *  2. **A domain credential is not a capability.** A `clearance`/`tag` row carries
 *     `capability='read'` as an index placeholder; reading it as read access would
 *     promote anyone holding one low clearance into "can read everything".
 *  3. **manage is never inherited**, so managing a project does not confer the
 *     right to re-share a session inside it.
 *  4. **Ancestors are conjunctive**: failing any gate level fails the whole chain.
 *  5. **A broken chain is not an open door** (and not a closed one either).
 *  6. Admin short-circuits; anonymous holds nothing.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/acl/__tests__/acl-core.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { db } from "../../../db";
import { aclGrants, chapters, narrators, projects, users } from "../../../db/schema";
import { generateId } from "../../../lib/id";
import {
	type AclCapability,
	type AclPrincipal,
	anonymousCaps,
	capsCanManage,
	capsCanRead,
	capsCanWrite,
	listGrantedScopeIds,
	resolveCaps,
	resolveHoldersBatch,
	withResolvedGate,
} from "../acl-core";
import { type AclScope, resolveAncestorChain, resolveScopeChain } from "../acl-scope";

const TAG = Date.now();

let member: string;
let outsider: string;
let projectId: string;
let chapterId: string;
/** A narrator inside `chapterId`, i.e. inside `projectId`. */
let narratorInProject: string;
/** A narrator with no chapter and no project context. */
let standaloneNarrator: string;

const asUser = (userId: string): AclPrincipal => ({ userId, role: "user" });
const asAdmin = (): AclPrincipal => ({ userId: "acl-admin", role: "admin" });

async function grant(
	scope: AclScope,
	principalId: string,
	capability: AclCapability,
	principalType: "user" | "role" = "user",
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: scope.type,
		scopeId: scope.id,
		principalType,
		principalId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

async function grantDomain(
	scope: AclScope,
	principalId: string,
	domainKind: "clearance" | "tag" | "review",
	domainValue: string,
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: scope.type,
		scopeId: scope.id,
		principalType: "user",
		principalId,
		// Placeholder, exactly as the migration writes it.
		capability: "read",
		domainKind,
		domainValue,
		createdAt: new Date().toISOString(),
	});
}

beforeAll(async () => {
	const now = new Date().toISOString();
	member = generateId();
	outsider = generateId();
	for (const id of [member, outsider]) {
		await db.insert(users).values({
			id,
			username: `${id}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: now,
		});
	}

	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `acl-core-${TAG}`,
		gitPath: `/tmp/acl-core-${TAG}`,
		createdAt: now,
		updatedAt: now,
	});

	chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "chapter",
		branch: `chapter/${TAG}`,
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});

	narratorInProject = generateId();
	standaloneNarrator = generateId();
	await db.insert(narrators).values([
		{ id: narratorInProject, chapterId, createdAt: now, updatedAt: now },
		{ id: standaloneNarrator, createdAt: now, updatedAt: now },
	]);
});

// ─── 1. Ancestor chains ──────────────────────────────────────────────────

describe("ancestor chains", () => {
	test("a narrator in a chapter chains through chapter and project to global", async () => {
		const chain = await resolveAncestorChain({ type: "narrator", id: narratorInProject });
		expect(chain.map((s) => s.type)).toEqual(["chapter", "project", "global"]);
		expect(chain[1].id).toBe(projectId);
	});

	test("a standalone narrator chains straight to global", async () => {
		const chain = await resolveAncestorChain({ type: "narrator", id: standaloneNarrator });
		expect(chain.map((s) => s.type)).toEqual(["global"]);
	});

	test("a dangling narrator reference does not throw", async () => {
		const chain = await resolveAncestorChain({ type: "narrator", id: "no-such-narrator" });
		expect(chain.map((s) => s.type)).toEqual(["global"]);
	});

	test("global has no ancestors, and its own chain is just itself", async () => {
		expect(await resolveAncestorChain({ type: "global", id: null })).toEqual([]);
		expect(await resolveScopeChain({ type: "global", id: null })).toEqual([
			{ type: "global", id: null },
		]);
	});

	test("a scope chain leads with the scope itself", async () => {
		const chain = await resolveScopeChain({ type: "narrator", id: narratorInProject });
		expect(chain[0]).toEqual({ type: "narrator", id: narratorInProject });
	});
});

// ─── 2. A gate is not an authorization ───────────────────────────────────

describe("ancestor grants are gates, not authorizations", () => {
	test("project read does not confer read on a narrator inside it", async () => {
		await grant({ type: "project", id: projectId }, member, "read");

		const caps = await resolveCaps(asUser(member), { type: "narrator", id: narratorInProject });

		expect(caps.gate.read).toBe(true); // the door is open …
		expect(caps.own.read).toBe(false); // … but nothing inside was granted
		expect(capsCanRead(caps)).toBe(false);
	});

	test("project read plus a narrator grant does confer read", async () => {
		await grant({ type: "narrator", id: narratorInProject }, member, "read");

		const caps = await resolveCaps(asUser(member), { type: "narrator", id: narratorInProject });

		expect(capsCanRead(caps)).toBe(true);
	});

	test("a narrator grant without the project gate is not enough", async () => {
		// The outsider holds read on the narrator but is not a project member. The
		// project gate must still refuse — otherwise sharing a session would smuggle
		// access into a project.
		await grant({ type: "narrator", id: narratorInProject }, outsider, "read");

		const caps = await resolveCaps(asUser(outsider), { type: "narrator", id: narratorInProject });

		expect(caps.own.read).toBe(true);
		expect(caps.gate.read).toBe(false);
		expect(capsCanRead(caps)).toBe(false);
	});

	test("write follows the same conjunction", async () => {
		const other = generateId();
		await db.insert(users).values({
			id: other,
			username: `${other}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grant({ type: "project", id: projectId }, other, "read");
		await grant({ type: "narrator", id: narratorInProject }, other, "read");

		const caps = await resolveCaps(asUser(other), { type: "narrator", id: narratorInProject });

		// read passes, write does not: no write grant anywhere.
		expect(capsCanRead(caps)).toBe(true);
		expect(capsCanWrite(caps)).toBe(false);
	});
});

// ─── 3. manage is never inherited ────────────────────────────────────────

describe("manage", () => {
	test("project manage does not confer manage on a narrator inside it", async () => {
		const boss = generateId();
		await db.insert(users).values({
			id: boss,
			username: `${boss}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grant({ type: "project", id: projectId }, boss, "read");
		await grant({ type: "project", id: projectId }, boss, "manage");
		await grant({ type: "narrator", id: narratorInProject }, boss, "read");

		const caps = await resolveCaps(asUser(boss), { type: "narrator", id: narratorInProject });

		expect(caps.own.manage).toBe(false);
		expect(capsCanManage(caps)).toBe(false);
	});

	test("manage on the scope itself works, and needs the gate", async () => {
		const sharer = generateId();
		await db.insert(users).values({
			id: sharer,
			username: `${sharer}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grant({ type: "narrator", id: narratorInProject }, sharer, "manage");

		// No project grant yet → gate closed → cannot manage.
		let caps = await resolveCaps(asUser(sharer), { type: "narrator", id: narratorInProject });
		expect(capsCanManage(caps)).toBe(false);

		await grant({ type: "project", id: projectId }, sharer, "read");
		caps = await resolveCaps(asUser(sharer), { type: "narrator", id: narratorInProject });
		expect(capsCanManage(caps)).toBe(true);
	});
});

// ─── 4. Domain credentials are not capabilities ──────────────────────────

describe("domain credentials", () => {
	test("a clearance row does not grant read, it only carries the credential", async () => {
		const analyst = generateId();
		await db.insert(users).values({
			id: analyst,
			username: `${analyst}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grantDomain({ type: "global", id: null }, analyst, "clearance", "internal");

		const caps = await resolveCaps(asUser(analyst), { type: "global", id: null });

		// The row's capability column says 'read', but it must not be read that way.
		expect(caps.own.read).toBe(false);
		expect(capsCanRead(caps)).toBe(false);
		expect([...caps.domain.clearance]).toEqual(["internal"]);
	});

	test("tag and review credentials land in their own sets", async () => {
		const reviewer = generateId();
		await db.insert(users).values({
			id: reviewer,
			username: `${reviewer}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grantDomain({ type: "global", id: null }, reviewer, "tag", "tag-alpha");
		await grantDomain({ type: "global", id: null }, reviewer, "review", "tag-beta");

		const caps = await resolveCaps(asUser(reviewer), { type: "global", id: null });

		expect([...caps.domain.tags]).toEqual(["tag-alpha"]);
		expect([...caps.domain.review]).toEqual(["tag-beta"]);
		expect(caps.own.read).toBe(false);
	});

	test("credentials granted on an ancestor are still collected", async () => {
		// A clearance held at project level is still a clearance when judging something
		// inside the project — credentials union along the chain even though gates do not
		// grant.
		const holder = generateId();
		await db.insert(users).values({
			id: holder,
			username: `${holder}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		await grantDomain({ type: "project", id: projectId }, holder, "clearance", "secret");

		const caps = await resolveCaps(asUser(holder), { type: "narrator", id: narratorInProject });

		expect([...caps.domain.clearance]).toEqual(["secret"]);
	});
});

// ─── 5. Role grants, admin, anonymous ────────────────────────────────────

describe("principals", () => {
	test("a role grant applies to every user with that role", async () => {
		const anyone = generateId();
		await db.insert(users).values({
			id: anyone,
			username: `${anyone}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const roleScopedNarrator = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: roleScopedNarrator, createdAt: now, updatedAt: now });
		await grant({ type: "narrator", id: roleScopedNarrator }, "user", "read", "role");

		const caps = await resolveCaps(asUser(anyone), { type: "narrator", id: roleScopedNarrator });

		expect(capsCanRead(caps)).toBe(true);
	});

	test("an admin short-circuits gate and own alike", async () => {
		const caps = await resolveCaps(asAdmin(), { type: "narrator", id: narratorInProject });
		expect(caps.isAdmin).toBe(true);
		expect(capsCanRead(caps)).toBe(true);
		expect(capsCanWrite(caps)).toBe(true);
		expect(capsCanManage(caps)).toBe(true);
	});

	test("an anonymous or empty principal holds nothing", async () => {
		expect(capsCanRead(anonymousCaps())).toBe(false);
		const caps = await resolveCaps(null, { type: "narrator", id: narratorInProject });
		expect(capsCanRead(caps)).toBe(false);
		expect(capsCanWrite(caps)).toBe(false);
	});
});

// ─── 6. Externally supplied gate ─────────────────────────────────────────

describe("withResolvedGate", () => {
	test("lets a domain adapter open the gate it owns", async () => {
		// Project membership is not purely grant-driven (public visibility and ownership
		// also open it), so the project adapter supplies the verdict.
		//
		// `outsider` already holds narrator read from an earlier test and is deliberately
		// NOT re-granted here: the unique index would reject the duplicate, which is
		// itself the behaviour we want (one row per principal/scope/capability).
		const raw = await resolveCaps(asUser(outsider), { type: "narrator", id: narratorInProject });
		expect(raw.own.read).toBe(true);
		expect(capsCanRead(raw)).toBe(false);

		const opened = withResolvedGate(raw, { read: true, write: false });

		expect(capsCanRead(opened)).toBe(true);
		expect(capsCanWrite(opened)).toBe(false);
	});

	test("cannot be used to fabricate own-scope access", async () => {
		const nobody = generateId();
		await db.insert(users).values({
			id: nobody,
			username: `${nobody}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const raw = await resolveCaps(asUser(nobody), { type: "narrator", id: narratorInProject });

		const opened = withResolvedGate(raw, { read: true, write: true });

		// The gate is open but nothing was granted on the narrator itself.
		expect(capsCanRead(opened)).toBe(false);
		expect(capsCanWrite(opened)).toBe(false);
	});
});

// ─── 7. Push-down helpers ────────────────────────────────────────────────

describe("listGrantedScopeIds", () => {
	test("returns only capability rows, never domain credentials", async () => {
		const mixed = generateId();
		await db.insert(users).values({
			id: mixed,
			username: `${mixed}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const n1 = generateId();
		const n2 = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values([
			{ id: n1, createdAt: now, updatedAt: now },
			{ id: n2, createdAt: now, updatedAt: now },
		]);
		await grant({ type: "narrator", id: n1 }, mixed, "read");
		await grantDomain({ type: "narrator", id: n2 }, mixed, "tag", "tag-x");

		const { ids, truncated } = await listGrantedScopeIds(asUser(mixed), "narrator", "read");

		expect(ids.has(n1)).toBe(true);
		// n2 only has a domain credential; it must not appear as readable.
		expect(ids.has(n2)).toBe(false);
		expect(truncated).toBe(false);
	});

	test("reports truncated when the result exceeds the limit", async () => {
		// Create a user with more grants than the requested limit to verify
		// the truncation flag and that exactly `limit` ids are returned.
		const heavy = generateId();
		await db.insert(users).values({
			id: heavy,
			username: `${heavy}-${TAG}`,
			passwordHash: "x",
			role: "user",
			createdAt: new Date().toISOString(),
		});
		const now = new Date().toISOString();
		const limit = 3;
		const narratorIds: string[] = [];
		for (let i = 0; i < limit + 2; i++) {
			const nId = generateId();
			narratorIds.push(nId);
			await db.insert(narrators).values({ id: nId, createdAt: now, updatedAt: now });
			await grant({ type: "narrator", id: nId }, heavy, "read");
		}

		const { ids, truncated } = await listGrantedScopeIds(asUser(heavy), "narrator", "read", limit);

		expect(truncated).toBe(true);
		expect(ids.size).toBe(limit);
	});
});

describe("resolveHoldersBatch", () => {
	test("reports who holds a capability on one scope", async () => {
		const holder = generateId();
		const nonHolder = generateId();
		const now = new Date().toISOString();
		for (const id of [holder, nonHolder]) {
			await db.insert(users).values({
				id,
				username: `${id}-${TAG}`,
				passwordHash: "x",
				role: "user",
				createdAt: now,
			});
		}
		const target = generateId();
		await db.insert(narrators).values({ id: target, createdAt: now, updatedAt: now });
		await grant({ type: "narrator", id: target }, holder, "read");

		const { holders, truncated } = await resolveHoldersBatch(
			[asUser(holder), asUser(nonHolder)],
			{ type: "narrator", id: target },
			"read",
		);

		expect(holders.has(holder)).toBe(true);
		expect(holders.has(nonHolder)).toBe(false);
		expect(truncated).toBe(false);
	});

	test("always includes admins", async () => {
		const target = generateId();
		const now = new Date().toISOString();
		await db.insert(narrators).values({ id: target, createdAt: now, updatedAt: now });

		const { holders } = await resolveHoldersBatch(
			[asAdmin()],
			{ type: "narrator", id: target },
			"read",
		);

		expect(holders.has("acl-admin")).toBe(true);
	});

	test("degrades to admins only past the population cap, and says so", async () => {
		const many = Array.from({ length: 201 }, (_, i) => asUser(`bulk-${i}`));
		many.push(asAdmin());

		const { holders, truncated } = await resolveHoldersBatch(
			many,
			{ type: "narrator", id: narratorInProject },
			"read",
		);

		expect(truncated).toBe(true);
		expect(holders.has("acl-admin")).toBe(true);
		expect(holders.has("bulk-0")).toBe(false);
	});
});
