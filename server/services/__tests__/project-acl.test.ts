/**
 * Project access control.
 *
 * The properties that matter, in the order they are easiest to get wrong:
 *
 *  1. **The gate is not an authorization.** `resolveProjectGate` reports whether
 *     the door is open, and a resource inside still needs its own ACL. Tested here
 *     against the kernel so the two halves cannot drift apart.
 *  2. **Public grants read, never write.** Sharing a view of a project must not let
 *     any signed-in user merge into its trunk or delete a chapter.
 *  3. **write ≠ manage.** A write member works in the project; deciding who else
 *     may (and deleting the project) is a separate tier.
 *  4. **Chapters inherit wholesale**, because chapter-level isolation would be
 *     fiction on a shared git repository.
 *  5. **No project means no gate, not "unrestricted"** — and a dangling project
 *     reference fails closed.
 *  6. **The SQL predicate agrees with the row predicate**, or lists would show
 *     projects that 404 on open.
 *  7. **Knowledge credentials in the shared grant table never read as project
 *     access.**
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/project-acl.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, chapters, projects, users } from "../../db/schema";
import { NotFoundError } from "../../lib/errors";
import { generateId } from "../../lib/id";
import { capsCanRead, resolveCaps, withResolvedGate } from "../acl/acl-core";
import {
	assertChapterProjectAccess,
	assertProjectAccess,
	canManageProject,
	canReadProject,
	canWriteProject,
	filterReadableProjects,
	type ProjectPrincipal,
	projectReadableWhere,
	resolveProjectGate,
} from "../project-acl";

const TAG = Date.now();

let owner: string;
let member: string;
let outsider: string;

const asUser = (userId: string): ProjectPrincipal => ({ userId, isAdmin: false });
const asAdmin = (): ProjectPrincipal => ({ userId: "proj-admin", isAdmin: true });

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

async function makeProject(options: {
	ownerUserId?: string | null;
	visibility?: "private" | "public";
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(projects).values({
		id,
		name: `proj-${TAG}-${generateId(6)}`,
		gitPath: `/tmp/proj-${id}`,
		ownerUserId: options.ownerUserId ?? null,
		visibility: options.visibility ?? "private",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function makeChapter(projectId: string): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(chapters).values({
		id,
		projectId,
		title: "chapter",
		branch: `chapter/${generateId(6)}`,
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});
	return id;
}

async function grantProject(
	projectId: string,
	userId: string,
	capability: "read" | "write" | "manage",
) {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: projectId,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

async function rowOf(projectId: string) {
	const row = await db.query.projects.findFirst({
		where: (p, { eq }) => eq(p.id, projectId),
	});
	if (!row) throw new Error(`missing project ${projectId}`);
	return row;
}

async function readableIdsViaSql(principal: ProjectPrincipal, ids: string[]): Promise<Set<string>> {
	const rows = await db
		.select({ id: projects.id })
		.from(projects)
		.where(and(sql`${projects.id} IN ${ids}`, projectReadableWhere(principal)));
	return new Set(rows.map((row) => row.id));
}

beforeAll(async () => {
	owner = await makeUser("proj-owner");
	member = await makeUser("proj-member");
	outsider = await makeUser("proj-outsider");
});

// ─── 1. Basic tiers ──────────────────────────────────────────────────────

describe("read", () => {
	test("the owner can read their private project", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		expect(await canReadProject(row, asUser(owner))).toBe(true);
	});

	test("an outsider cannot read a private project", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		expect(await canReadProject(row, asUser(outsider))).toBe(false);
	});

	test("a read grant opens it", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "read");
		expect(await canReadProject(await rowOf(id), asUser(member))).toBe(true);
	});

	test("public opens read to anyone signed in", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner, visibility: "public" }));
		expect(await canReadProject(row, asUser(outsider))).toBe(true);
	});

	test("an admin reads anything", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		expect(await canReadProject(row, asAdmin())).toBe(true);
	});

	test("a write grant implies read without a second row", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "write");
		expect(await canReadProject(await rowOf(id), asUser(member))).toBe(true);
	});
});

describe("write", () => {
	test("public does NOT grant write", async () => {
		// Otherwise publishing a project would let any account merge into its trunk.
		const row = await rowOf(await makeProject({ ownerUserId: owner, visibility: "public" }));
		expect(await canWriteProject(row, asUser(outsider))).toBe(false);
	});

	test("a read grant does not grant write", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "read");
		expect(await canWriteProject(await rowOf(id), asUser(member))).toBe(false);
	});

	test("a write grant does", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "write");
		expect(await canWriteProject(await rowOf(id), asUser(member))).toBe(true);
	});
});

describe("manage", () => {
	test("a write member cannot manage membership", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "write");
		expect(await canManageProject(await rowOf(id), asUser(member))).toBe(false);
	});

	test("a manage grant can, and implies read", async () => {
		const id = await makeProject({ ownerUserId: owner });
		await grantProject(id, member, "manage");
		const row = await rowOf(id);
		expect(await canManageProject(row, asUser(member))).toBe(true);
		expect(await canReadProject(row, asUser(member))).toBe(true);
	});

	test("the owner always can", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		expect(await canManageProject(row, asUser(owner))).toBe(true);
	});

	test("projects with no owner are admin-managed only", async () => {
		// Every project that predates project ACLs looks like this.
		const row = await rowOf(await makeProject({ ownerUserId: null, visibility: "public" }));
		expect(await canManageProject(row, asAdmin())).toBe(true);
		expect(await canManageProject(row, asUser(outsider))).toBe(false);
	});
});

// ─── 2. Denial shape ─────────────────────────────────────────────────────

describe("assertProjectAccess", () => {
	test("denial is NotFoundError so ids cannot be probed", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		await expect(assertProjectAccess(row, asUser(outsider), "read")).rejects.toBeInstanceOf(
			NotFoundError,
		);
	});

	test("passing is silent", async () => {
		const row = await rowOf(await makeProject({ ownerUserId: owner }));
		expect(await assertProjectAccess(row, asUser(owner), "manage")).toBeUndefined();
	});
});

// ─── 3. Chapters inherit ─────────────────────────────────────────────────

describe("chapters inherit the project verdict", () => {
	test("a project member reaches its chapters", async () => {
		const projectId = await makeProject({ ownerUserId: owner });
		const chapterId = await makeChapter(projectId);
		await grantProject(projectId, member, "read");

		const result = await assertChapterProjectAccess(chapterId, asUser(member), "read");

		expect(result.projectId).toBe(projectId);
	});

	test("an outsider does not", async () => {
		const projectId = await makeProject({ ownerUserId: owner });
		const chapterId = await makeChapter(projectId);

		await expect(
			assertChapterProjectAccess(chapterId, asUser(outsider), "read"),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("a read member cannot perform chapter write operations", async () => {
		// dormant/delete/merge are project-write, not project-read.
		const projectId = await makeProject({ ownerUserId: owner });
		const chapterId = await makeChapter(projectId);
		await grantProject(projectId, member, "read");

		await expect(
			assertChapterProjectAccess(chapterId, asUser(member), "write"),
		).rejects.toBeInstanceOf(NotFoundError);
	});

	test("an unknown chapter is not found", async () => {
		await expect(
			assertChapterProjectAccess("no-such-chapter", asAdmin(), "read"),
		).rejects.toBeInstanceOf(NotFoundError);
	});
});

// ─── 4. The gate ─────────────────────────────────────────────────────────

describe("resolveProjectGate", () => {
	test("a member passes read but not write", async () => {
		const projectId = await makeProject({ ownerUserId: owner });
		await grantProject(projectId, member, "read");

		expect(await resolveProjectGate(projectId, asUser(member))).toEqual({
			read: true,
			write: false,
		});
	});

	test("an outsider passes nothing", async () => {
		const projectId = await makeProject({ ownerUserId: owner });
		expect(await resolveProjectGate(projectId, asUser(outsider))).toEqual({
			read: false,
			write: false,
		});
	});

	test("no project means no gate to pass", async () => {
		// A standalone narrator belongs to no project. That is "no gate here", not
		// "unrestricted": the resource's own ACL still decides.
		expect(await resolveProjectGate(null, asUser(outsider))).toEqual({
			read: true,
			write: true,
		});
	});

	test("a dangling project reference fails closed", async () => {
		expect(await resolveProjectGate("no-such-project", asUser(member))).toEqual({
			read: false,
			write: false,
		});
	});

	test("an open gate still does not authorize a resource inside", async () => {
		// The whole point of the gate/own split, checked end-to-end against the kernel.
		const projectId = await makeProject({ ownerUserId: owner });
		await grantProject(projectId, member, "read");

		const gate = await resolveProjectGate(projectId, asUser(member));
		const caps = withResolvedGate(
			await resolveCaps({ userId: member, role: "user" }, { type: "project", id: projectId }),
			gate,
		);
		// The member holds read on the project itself, so this specific scope is readable…
		expect(capsCanRead(caps)).toBe(true);

		// …but a scope they hold nothing on is not, even with the gate open.
		const untouched = withResolvedGate(
			await resolveCaps(
				{ userId: member, role: "user" },
				{ type: "narrator", id: "some-private-narrator" },
			),
			gate,
		);
		expect(capsCanRead(untouched)).toBe(false);
	});
});

// ─── 5. SQL agreement ────────────────────────────────────────────────────

describe("list predicate matches single-row decisions", () => {
	test("every combination decides the same way in SQL and in memory", async () => {
		const mine = await makeProject({ ownerUserId: member });
		const shared = await makeProject({ ownerUserId: owner });
		await grantProject(shared, member, "read");
		const sharedWrite = await makeProject({ ownerUserId: owner });
		await grantProject(sharedWrite, member, "write");
		const hidden = await makeProject({ ownerUserId: owner });
		const publicOne = await makeProject({ ownerUserId: owner, visibility: "public" });
		const orphan = await makeProject({ ownerUserId: null, visibility: "public" });
		const ids = [mine, shared, sharedWrite, hidden, publicOne, orphan];

		const principal = asUser(member);
		const viaSql = await readableIdsViaSql(principal, ids);
		for (const id of ids) {
			expect(viaSql.has(id)).toBe(await canReadProject(await rowOf(id), principal));
		}
		// Sanity: the fixture really is mixed.
		expect(viaSql.has(mine)).toBe(true);
		expect(viaSql.has(hidden)).toBe(false);
	});

	test("admins get no restriction rather than an empty result", () => {
		expect(projectReadableWhere(asAdmin())).toBeUndefined();
	});

	test("filterReadableProjects agrees with the SQL predicate", async () => {
		const shared = await makeProject({ ownerUserId: owner });
		await grantProject(shared, member, "read");
		const hidden = await makeProject({ ownerUserId: owner });
		const ids = [shared, hidden];

		const rows = await Promise.all(ids.map((id) => rowOf(id)));
		const kept = new Set((await filterReadableProjects(rows, asUser(member))).map((r) => r.id));

		expect(kept).toEqual(await readableIdsViaSql(asUser(member), ids));
	});

	test("the predicate works inside a relational query callback", async () => {
		// Regression guard: Drizzle rewrites embedded column references to the outer
		// alias in relational-query callbacks, which is why the subquery uses literal
		// column names.
		const shared = await makeProject({ ownerUserId: owner });
		await grantProject(shared, member, "read");
		const hidden = await makeProject({ ownerUserId: owner });

		const rows = await db.query.projects.findMany({
			where: (p, { and: andFn, inArray }) =>
				andFn(inArray(p.id, [shared, hidden]), projectReadableWhere(asUser(member))),
			columns: { id: true },
		});

		expect(rows.map((r) => r.id)).toEqual([shared]);
	});
});

// ─── 6. Cross-domain safety ──────────────────────────────────────────────

describe("shared grant table isolation", () => {
	test("a knowledge credential never reads as project access", async () => {
		// `acl_grants` holds knowledge credentials whose `capability` column is a
		// placeholder 'read'. If project access consulted them, holding one clearance
		// would open every project.
		const projectId = await makeProject({ ownerUserId: owner });
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: outsider,
			capability: "read",
			domainKind: "clearance",
			domainValue: "internal",
			createdAt: new Date().toISOString(),
		});

		expect(await canReadProject(await rowOf(projectId), asUser(outsider))).toBe(false);
		expect((await readableIdsViaSql(asUser(outsider), [projectId])).has(projectId)).toBe(false);
	});

	test("a role grant applies to every user with that role", async () => {
		const projectId = await makeProject({ ownerUserId: owner });
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "role",
			principalId: "user",
			capability: "read",
			createdAt: new Date().toISOString(),
		});

		expect(await canReadProject(await rowOf(projectId), asUser(outsider))).toBe(true);
	});
});
