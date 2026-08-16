/**
 * The two-level AND: project gate × narrator ACL.
 *
 * This is the property the whole unification exists to make true, and the one whose
 * violation is a leak in either direction:
 *
 *  1. **A project member does NOT see a teammate's private session.** The gate is a
 *     necessary condition, never a sufficient one.
 *  2. **A non-member does NOT see a project-visible session**, even though that used
 *     to be readable by anyone signed in. This is the deliberate tightening.
 *  3. **A non-member does NOT see a session shared directly with them** if they
 *     cannot reach the project — sharing must not smuggle access past the gate.
 *  4. **Losing project membership takes away write**, even if an old narrator grant
 *     survives.
 *  5. **Standalone narrators are unaffected**: no project, no gate, and `project`
 *     visibility on one grants nothing.
 *  6. **The SQL predicate agrees with the row predicate** for every combination, or
 *     lists would offer sessions that 404 on open.
 *
 * Run: NARRAFORK_ALLOW_MULTIPLE=1 NARRAFORK_HOME=$(mktemp -d) \
 *      bun test server/services/__tests__/narrator-project-gate.test.ts
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { and, sql } from "drizzle-orm";
import { db } from "../../db";
import { aclGrants, chapters, narrators, projects, users } from "../../db/schema";
import { generateId } from "../../lib/id";
import {
	canReadNarrator,
	canWriteNarrator,
	filterReadableNarrators,
	type NarratorPrincipal,
	narratorReadableWhere,
} from "../narrator-acl";

const TAG = Date.now();

let owner: string;
let member: string;
let outsider: string;
let projectId: string;
let chapterId: string;

const asUser = (userId: string): NarratorPrincipal => ({ userId, isAdmin: false });
const asAdmin = (): NarratorPrincipal => ({ userId: "gate-admin", isAdmin: true });

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
	visibility: "private" | "project" | "public";
	chapterId?: string | null;
}): Promise<string> {
	const id = generateId();
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		chapterId: options.chapterId ?? null,
		ownerUserId: options.ownerUserId ?? null,
		visibility: options.visibility,
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

async function grantProject(pid: string, userId: string, capability: "read" | "write") {
	await db.insert(aclGrants).values({
		id: generateId(),
		scopeType: "project",
		scopeId: pid,
		principalType: "user",
		principalId: userId,
		capability,
		createdAt: new Date().toISOString(),
	});
}

async function rowOf(narratorId: string) {
	const row = await db.query.narrators.findFirst({
		where: (n, { eq }) => eq(n.id, narratorId),
	});
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

beforeAll(async () => {
	owner = await makeUser("gate-owner");
	member = await makeUser("gate-member");
	outsider = await makeUser("gate-outsider");

	const now = new Date().toISOString();
	projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: `gate-project-${TAG}`,
		gitPath: `/tmp/gate-${TAG}`,
		ownerUserId: owner,
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	});

	chapterId = generateId();
	await db.insert(chapters).values({
		id: chapterId,
		projectId,
		title: "chapter",
		branch: `chapter/gate-${TAG}`,
		baseBranch: "main",
		createdAt: now,
		updatedAt: now,
	});

	await grantProject(projectId, member, "read");
});

// ─── 1. The gate does not authorize ──────────────────────────────────────

describe("a project member and a teammate's private session", () => {
	test("cannot read it", async () => {
		// The reason this whole design uses a gate rather than inheritance: project
		// membership must not dissolve personal drafts.
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId }),
		);
		expect(await canReadNarrator(row, asUser(member))).toBe(false);
	});

	test("can read it once it is shared with them specifically", async () => {
		const id = await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId });
		await grantNarrator(id, member, "read");
		expect(await canReadNarrator(await rowOf(id), asUser(member))).toBe(true);
	});

	test("can read a project-visible session in the same project", async () => {
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "project", chapterId }),
		);
		expect(await canReadNarrator(row, asUser(member))).toBe(true);
	});
});

// ─── 2. The tightening ───────────────────────────────────────────────────

describe("a non-member", () => {
	test("cannot read a project-visible session (behaviour change)", async () => {
		// Before project membership existed, `project` was as wide as `public`.
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "project", chapterId }),
		);
		expect(await canReadNarrator(row, asUser(outsider))).toBe(false);
	});

	test("cannot read a session shared directly with them inside a project they cannot reach", async () => {
		// Sharing must not smuggle access past the gate: otherwise any member could hand
		// out entry to a project by sharing one session in it.
		const id = await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId });
		await grantNarrator(id, outsider, "read");
		expect(await canReadNarrator(await rowOf(id), asUser(outsider))).toBe(false);
	});

	test("can still read a public session inside that project", async () => {
		// `public` means "anyone signed in" and is deliberately wider than the project.
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "public", chapterId }),
		);
		expect(await canReadNarrator(row, asUser(outsider))).toBe(true);
	});
});

// ─── 3. Write follows the gate ───────────────────────────────────────────

describe("write", () => {
	test("a write grant is void without project access", async () => {
		const id = await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId });
		await grantNarrator(id, outsider, "write");
		expect(await canWriteNarrator(await rowOf(id), asUser(outsider))).toBe(false);
	});

	test("a write grant works for a project member", async () => {
		const id = await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId });
		await grantNarrator(id, member, "write");
		expect(await canWriteNarrator(await rowOf(id), asUser(member))).toBe(true);
	});

	test("project-visible does not grant write to members", async () => {
		// Seeing the team's work is not permission to drive it.
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "project", chapterId }),
		);
		expect(await canWriteNarrator(row, asUser(member))).toBe(false);
	});

	test("the owner keeps access regardless of the gate", async () => {
		// The project owner here is also the narrator owner; an owner is never locked out
		// of their own session by a project-level rule.
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId }),
		);
		expect(await canWriteNarrator(row, asUser(owner))).toBe(true);
	});

	test("an admin passes both levels", async () => {
		const row = await rowOf(
			await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId }),
		);
		expect(await canReadNarrator(row, asAdmin())).toBe(true);
		expect(await canWriteNarrator(row, asAdmin())).toBe(true);
	});
});

// ─── 4. Standalone narrators ─────────────────────────────────────────────

describe("standalone narrators have no gate", () => {
	test("a private standalone session stays owner-only", async () => {
		const row = await rowOf(await makeNarrator({ ownerUserId: owner, visibility: "private" }));
		expect(await canReadNarrator(row, asUser(owner))).toBe(true);
		expect(await canReadNarrator(row, asUser(outsider))).toBe(false);
	});

	test("a shared standalone session is reachable without any project", async () => {
		const id = await makeNarrator({ ownerUserId: owner, visibility: "private" });
		await grantNarrator(id, outsider, "read");
		expect(await canReadNarrator(await rowOf(id), asUser(outsider))).toBe(true);
	});

	test("`project` visibility on a standalone session grants nothing", async () => {
		// There is no project to constrain it, so it must not read as "everyone".
		const row = await rowOf(await makeNarrator({ ownerUserId: owner, visibility: "project" }));
		expect(await canReadNarrator(row, asUser(outsider))).toBe(false);
		expect(await canReadNarrator(row, asUser(member))).toBe(false);
	});
});

// ─── 5. SQL agreement across the whole matrix ────────────────────────────

describe("the list predicate agrees with the single-row decision", () => {
	test("for every visibility × membership combination", async () => {
		const privateInProject = await makeNarrator({
			ownerUserId: owner,
			visibility: "private",
			chapterId,
		});
		const projectInProject = await makeNarrator({
			ownerUserId: owner,
			visibility: "project",
			chapterId,
		});
		const publicInProject = await makeNarrator({
			ownerUserId: owner,
			visibility: "public",
			chapterId,
		});
		const sharedInProject = await makeNarrator({
			ownerUserId: owner,
			visibility: "private",
			chapterId,
		});
		await grantNarrator(sharedInProject, member, "read");
		const standalonePrivate = await makeNarrator({ ownerUserId: owner, visibility: "private" });
		const standaloneProject = await makeNarrator({ ownerUserId: owner, visibility: "project" });
		const ids = [
			privateInProject,
			projectInProject,
			publicInProject,
			sharedInProject,
			standalonePrivate,
			standaloneProject,
		];

		for (const principal of [asUser(member), asUser(outsider), asUser(owner)]) {
			const viaSql = await readableIdsViaSql(principal, ids);
			for (const id of ids) {
				const viaRow = await canReadNarrator(await rowOf(id), principal);
				expect({ user: principal.userId, id, sql: viaSql.has(id) }).toEqual({
					user: principal.userId,
					id,
					sql: viaRow,
				});
			}
		}

		// Sanity: the matrix is genuinely mixed for the member.
		const memberVisible = await readableIdsViaSql(asUser(member), ids);
		expect(memberVisible.has(projectInProject)).toBe(true);
		expect(memberVisible.has(privateInProject)).toBe(false);
	});

	test("filterReadableNarrators agrees with the SQL predicate", async () => {
		const projectVisible = await makeNarrator({
			ownerUserId: owner,
			visibility: "project",
			chapterId,
		});
		const hidden = await makeNarrator({ ownerUserId: owner, visibility: "private", chapterId });
		const ids = [projectVisible, hidden];

		const rows = await Promise.all(ids.map((id) => rowOf(id)));
		const kept = new Set((await filterReadableNarrators(rows, asUser(member))).map((r) => r.id));

		expect(kept).toEqual(await readableIdsViaSql(asUser(member), ids));
	});
});
