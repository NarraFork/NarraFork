/**
 * Outline spaces and access on SQLite: the shared matrix (`access-matrix.ts`, also run against
 * PostgreSQL), plus what only SQLite can show today: a session whose project comes from its
 * working directory, and the read-scope cache following access changes made through the real
 * sharing, membership and share-link services.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterEach, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../../db";
import {
	aclGrants,
	narratorProjectLinks,
	narratorPublicShares,
	narrators,
	projects,
	users,
} from "../../../db/schema";
import { eventBus } from "../../../lib/event-bus";
import { generateId } from "../../../lib/id";
import { grantNarratorAccess, setNarratorVisibility } from "../../narrator-sharing";
import { removeProjectMember, setProjectMembers } from "../../project-membership";
import { createPublicShare, revokePublicShare } from "../../public-narrator-share-service";
import {
	canSessionReadSpace,
	getSessionReadScope,
	invalidateSessionReadScopes,
	SESSION_SCOPE_TTL_MS,
} from "../session-scope";
import { ensurePersonalSpace, ensureProjectSpace, ensureSessionSpace } from "../spaces";
import {
	type AccessFixtures,
	type AccessWorld,
	accessCases,
	buildAccessWorld,
	runAccessCases,
} from "./access-matrix";

const NOW = "2026-10-26T00:00:00.000Z";

const sqliteFixtures: AccessFixtures = {
	async user(label, role = "user") {
		const id = generateId();
		await db
			.insert(users)
			.values({ id, username: `${label}-${id}`, passwordHash: "x", role, createdAt: NOW });
		return id;
	},
	async project({ owner, visibility }) {
		const id = generateId();
		await db.insert(projects).values({
			id,
			name: `outline-access-${id}`,
			ownerUserId: owner,
			visibility,
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async narrator({ owner, visibility, writeAudience, projectId, subagentOf }) {
		const id = generateId();
		await db.insert(narrators).values({
			id,
			title: "outline access",
			ownerUserId: owner,
			visibility: visibility as "private",
			writeAudience: (writeAudience ?? "owner") as "owner",
			type: subagentOf === undefined ? "primary" : "subagent",
			aclRootNarratorId: subagentOf ?? null,
			contextProjectId: projectId ?? null,
			createdAt: NOW,
			updatedAt: NOW,
		});
		return id;
	},
	async grant(scope, principal, capability) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: scope.type,
			scopeId: scope.id,
			principalType: "user" in principal ? "user" : "role",
			principalId: "user" in principal ? principal.user : principal.role,
			capability,
			createdAt: NOW,
		});
	},
	async shareLink(narratorId, { revoked, createdBy }) {
		await db.insert(narratorPublicShares).values({
			id: generateId(),
			narratorId,
			tokenHash: generateId(),
			guestName: "Guest",
			createdByUserId: createdBy,
			createdAt: NOW,
			revokedAt: revoked ? NOW : null,
		});
	},
	async deleteProject(id) {
		await db.delete(projects).where(eq(projects.id, id));
	},
	async deleteUser(id) {
		await db.delete(users).where(eq(users.id, id));
	},
};

let world: AccessWorld;
const cases = () => accessCases(world);

beforeAll(async () => {
	world = await buildAccessWorld(sqliteFixtures);
});

afterEach(() => {
	setSystemTime();
	invalidateSessionReadScopes();
});

describe("the access matrix on SQLite", () => {
	for (const group of ["spaces", "person", "session", "cap", "list"] as const) {
		test(group, async () => {
			const selected = cases().filter((testCase) => testCase.group === group);
			expect(selected.length).toBeGreaterThan(0);
			expect(await runAccessCases(selected)).toEqual([]);
		});
	}
});

describe("a project derived from the working directory", () => {
	test("is the session's main project, as resolveNarratorProjectId has it", async () => {
		const { owner, alice } = world.people;
		const linked = await sqliteFixtures.project({ owner, visibility: "private" });
		const elsewhere = await sqliteFixtures.project({ owner, visibility: "private" });
		await sqliteFixtures.grant({ type: "project", id: linked }, { user: alice }, "read");
		const session = await sqliteFixtures.narrator({ owner, visibility: "project" });
		await db.insert(narratorProjectLinks).values({
			narratorId: session,
			projectId: linked,
			role: "primary",
			source: "cwd",
			directory: "/tmp/linked",
			updatedAt: NOW,
		});
		const scope = await getSessionReadScope(session);
		expect(scope.mainProjectId).toBe(linked);
		expect(scope.audience).toEqual({ kind: "people", userIds: expect.any(Array) });
		expect(await canSessionReadSpace(session, await ensureProjectSpace(linked))).toBe(true);
		// Alice reads the session through the linked project and cannot read `elsewhere`.
		expect(await canSessionReadSpace(session, await ensureProjectSpace(elsewhere))).toBe(false);
	});
});

describe("the read-scope cache follows access changes", () => {
	const owner = () => ({ userId: world.people.owner, isAdmin: false });

	test("sharing a session with someone narrows it at once", async () => {
		const { people, projects, spaces } = world;
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: projects.main,
		});
		const personal = await ensurePersonalSpace(people.owner);
		const read = { executingUserId: people.owner };
		expect(await canSessionReadSpace(session, spaces.ownerOnly, read)).toBe(true);
		expect(await canSessionReadSpace(session, personal, read)).toBe(true);

		await grantNarratorAccess(session, [people.alice], "read", owner());
		expect(await canSessionReadSpace(session, spaces.ownerOnly, read)).toBe(false);
		expect(await canSessionReadSpace(session, personal, read)).toBe(false);

		await setNarratorVisibility(session, "public", owner());
		expect(await canSessionReadSpace(session, spaces.main, read)).toBe(false);
		expect(await canSessionReadSpace(session, spaces.open, read)).toBe(true);
	});

	test("a subagent follows its root's sharing change", async () => {
		const { people, projects, spaces } = world;
		const root = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: projects.main,
		});
		const sub = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			subagentOf: root,
		});
		expect(await canSessionReadSpace(sub, spaces.ownerOnly)).toBe(true);
		await grantNarratorAccess(root, [people.alice], "read", owner());
		expect(await canSessionReadSpace(sub, spaces.ownerOnly)).toBe(false);
	});

	test("project membership changes reach sessions of that project", async () => {
		const { people } = world;
		const main = await sqliteFixtures.project({ owner: people.owner, visibility: "private" });
		const target = await sqliteFixtures.project({ owner: people.owner, visibility: "private" });
		await setProjectMembers(main, [people.alice], "read", owner());
		await setProjectMembers(target, [people.alice], "read", owner());
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "project",
			projectId: main,
		});
		const targetSpace = await ensureProjectSpace(target);
		expect(await canSessionReadSpace(session, targetSpace)).toBe(true);

		await setProjectMembers(main, [people.bob], "read", owner());
		expect(await canSessionReadSpace(session, targetSpace)).toBe(false);

		await removeProjectMember(main, people.bob, owner());
		expect(await canSessionReadSpace(session, targetSpace)).toBe(true);

		// Opening the target to its members' members: bob joins it too.
		await setProjectMembers(main, [people.bob], "read", owner());
		await setProjectMembers(target, [people.bob], "read", owner());
		expect(await canSessionReadSpace(session, targetSpace)).toBe(true);
	});

	test("creating and revoking a public share link", async () => {
		const { people, projects, spaces } = world;
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: projects.main,
		});
		expect(await canSessionReadSpace(session, spaces.main)).toBe(true);
		const created = await createPublicShare(session, owner(), { guestName: "Visitor" });
		expect(await canSessionReadSpace(session, spaces.main)).toBe(false);
		expect(await canSessionReadSpace(session, spaces.open)).toBe(true);
		await revokePublicShare(session, created.share.id, owner());
		expect(await canSessionReadSpace(session, spaces.main)).toBe(true);
	});

	test("a role change is announced through auth:changed", async () => {
		const { people, projects, spaces } = world;
		const promoted = await sqliteFixtures.user("promoted");
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: projects.open,
		});
		await sqliteFixtures.grant({ type: "narrator", id: session }, { user: promoted }, "read");
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(false);
		await db.update(users).set({ role: "admin" }).where(eq(users.id, promoted));
		eventBus.emit({ type: "auth:changed", userId: promoted });
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(true);
	});

	test("changes nobody announces are picked up after the time limit or on request", async () => {
		const { people, projects, spaces } = world;
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: projects.main,
		});
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(true);
		// A grant written behind the services' back: the cached answer stands for a while.
		await sqliteFixtures.grant({ type: "narrator", id: session }, { user: people.alice }, "read");
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(true);
		setSystemTime(new Date(Date.now() + SESSION_SCOPE_TTL_MS + 1000));
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(false);
		setSystemTime();

		await db.delete(aclGrants).where(eq(aclGrants.scopeId, session));
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(false);
		invalidateSessionReadScopes(session);
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(true);
	});

	test("deleting the main project leaves the session with its own space only", async () => {
		const { people, spaces } = world;
		const main = await sqliteFixtures.project({ owner: people.owner, visibility: "private" });
		const session = await sqliteFixtures.narrator({
			owner: people.owner,
			visibility: "private",
			projectId: main,
		});
		const own = await ensureSessionSpace(session);
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(true);
		await sqliteFixtures.deleteProject(main);
		invalidateSessionReadScopes(session);
		expect((await getSessionReadScope(session)).mainProjectId).toBeNull();
		expect(await canSessionReadSpace(session, spaces.ownerOnly)).toBe(false);
		expect(await canSessionReadSpace(session, own)).toBe(true);
	});
});
