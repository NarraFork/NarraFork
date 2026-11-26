/**
 * Team tabs and pinned project tabs in the sidebar's recent tabs.
 *
 * A team tab (`team:<teamId>`) is a bookmark of the team page: the server writes its title and
 * project from the team, refuses a team the user cannot read, keeps it out of the recipient
 * index, and drops it when the team is archived or deleted or the user loses access. Project
 * and team tabs live in the sidebar's one list (`work`); the retired `projects` section is
 * converted once.
 *
 * Real database and real ACL (like `project-tab-prune.test.ts`), so the access rules are the
 * production ones.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RECENT_TABS_STORAGE_LIMIT } from "@shared/recent-tabs";

const previousHome = process.env.NARRAFORK_HOME;
const testHome = mkdtempSync(join(tmpdir(), "narrafork-team-tabs-"));
process.env.NARRAFORK_HOME = testHome;
process.env.NARRAFORK_ALLOW_MULTIPLE = "1";

const { db } = await import("../../db");
const { and, eq } = await import("drizzle-orm");
const {
	aclGrants,
	narratorMessages,
	narrators,
	narratorToolCalls,
	projects,
	projectTeams,
	teamWorkItems,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} = await import("../../db/schema");
const { generateId } = await import("../../lib/id");
const service = await import("../recent-tabs-service");
const {
	getRecentTabUserIds,
	getRecentTabUserIdsForNarrator,
	getRecentTabUserIdsForNarratorByRecency,
	getRecentTabUserIdsForTeamTrees,
	getRuntimePatches,
	listAllRecentTabs,
	listPage,
	moveRecentTab,
	pinRecentTab,
	pruneTeamTabs,
	pruneUnreadableProjectTabs,
	removeRecentTab,
	removeTabFromAllUsers,
	restoreRecentTabs,
	syncNarratorTitleToRecentTabs,
	upsertRecentTab,
	upsertRecentTabsBatch,
	clearRecentTabs,
} = service;

afterAll(() => {
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(testHome, { recursive: true, force: true });
});

const now = () => new Date().toISOString();

async function makeUser(role: "admin" | "user" = "user"): Promise<string> {
	const id = generateId();
	await db.insert(users).values({
		id,
		username: `u-${generateId(6)}`,
		passwordHash: "x",
		role,
		createdAt: now(),
	});
	return id;
}

let ownerId: string;

/**
 * Public by default: entering the project is necessary to read its sessions, so a narrator
 * grant alone only opens a coordinator in a project the grantee can enter.
 */
async function makeProject(visibility: "private" | "public" = "public"): Promise<string> {
	const id = generateId();
	await db.insert(projects).values({
		id,
		name: `p-${generateId(6)}`,
		gitPath: join(testHome, `repo-${generateId(6)}`),
		ownerUserId: ownerId,
		visibility,
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}

/** A team: a private coordinator owned by `ownerId` plus its `project_teams` row. */
async function makeTeam(projectId: string, title = "Docs crew"): Promise<string> {
	const id = generateId();
	await db.insert(narrators).values({
		id,
		title,
		status: "idle",
		ownerUserId: ownerId,
		visibility: "private",
		contextProjectId: projectId,
		traits: ["team"],
		createdAt: now(),
		updatedAt: now(),
	});
	await db.insert(projectTeams).values({
		narratorId: id,
		projectId,
		baseBranch: "main",
		createdAt: now(),
		updatedAt: now(),
	});
	return id;
}

async function grantNarrator(narratorId: string, userId: string, capability: "read" | "write") {
	const id = generateId();
	await db.insert(aclGrants).values({
		id,
		scopeType: "narrator",
		scopeId: narratorId,
		principalType: "user",
		principalId: userId,
		capability,
		grantedBy: ownerId,
		createdAt: now(),
	});
	return id;
}

function teamTab(teamId: string, title = "client title") {
	return { type: "team" as const, id: teamId, title, lastVisitedAt: Date.now() };
}

async function tabsOf(userId: string) {
	return listAllRecentTabs(userId);
}

async function keysOf(userId: string): Promise<string[]> {
	return (await tabsOf(userId)).map((tab) => `${tab.type}:${tab.id}`);
}

beforeAll(async () => {
	ownerId = await makeUser();
});

describe("team tabs: what is stored", () => {
	test("the server writes the team's own title and project, in the sidebar's list", async () => {
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId, "Release crew");
		await upsertRecentTab(ownerId, { ...teamTab(teamId, "spoofed"), projectId: "elsewhere" });

		const tab = (await tabsOf(ownerId)).find((candidate) => candidate.id === teamId);
		expect(tab).toMatchObject({ type: "team", title: "Release crew", projectId });
		const row = db
			.select()
			.from(userRecentTabs)
			.where(and(eq(userRecentTabs.userId, ownerId), eq(userRecentTabs.tabKey, `team:${teamId}`)))
			.get();
		expect(row?.section).toBe("work");
		// Not the coordinator session: no represented narrator, so no recipient index entry.
		expect(row?.representedNarratorId).toBeNull();
		expect(row?.narratorId).toBeNull();
		const page = await listPage(ownerId, "work");
		expect(page.items.some((item) => item.type === "team" && item.id === teamId)).toBe(true);
	});

	test("a team the user cannot read, an archived team and a missing one are refused", async () => {
		const outsider = await makeUser();
		const projectId = await makeProject();
		const hidden = await makeTeam(projectId);
		const archived = await makeTeam(projectId);
		await grantNarrator(archived, outsider, "read");
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, archived));

		const result = await upsertRecentTabsBatch(outsider, [
			teamTab(hidden),
			teamTab(archived),
			teamTab("no-such-team"),
		]);
		expect(result.changed).toBe(false);
		expect(await keysOf(outsider)).toEqual([]);
	});

	test("pinning a team the server refuses is an error, not a silent no-op", async () => {
		const reader = await makeUser();
		const projectId = await makeProject();
		const archived = await makeTeam(projectId);
		await grantNarrator(archived, reader, "read");
		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, archived));
		const hidden = await makeTeam(projectId);

		for (const teamId of [archived, hidden, "no-such-team"]) {
			const refused = upsertRecentTab(reader, teamTab(teamId), { pin: true });
			await expect(refused).rejects.toMatchObject({
				statusCode: 409,
				code: service.RECENT_TAB_REFUSED_CODE,
			});
			// A plain team upsert is refused the same way.
			await expect(upsertRecentTab(reader, teamTab(teamId))).rejects.toMatchObject({
				statusCode: 409,
			});
		}
		expect(await keysOf(reader)).toEqual([]);
	});

	test("a reader may pin a team: read access is enough to look at it", async () => {
		const reader = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, reader, "read");
		await upsertRecentTab(reader, teamTab(teamId), { pin: true });
		expect((await tabsOf(reader)).find((tab) => tab.id === teamId)?.pinned).toBe(true);
	});

	test("a full-list restore cannot smuggle in a team the user cannot read", async () => {
		const outsider = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await restoreRecentTabs(outsider, {
			tabs: [teamTab(teamId), { type: "project", id: projectId, title: "p", lastVisitedAt: 1 }],
		});
		expect(await keysOf(outsider)).toEqual([`project:${projectId}`]);
	});
});

describe("the pin state of one tab", () => {
	test("reads a pinned tab outside the first page, an unpinned one and a missing one", async () => {
		const user = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, user, "read");
		await upsertRecentTab(user, { type: "project", id: projectId, title: "p", lastVisitedAt: 1 });
		// More pinned sessions than a page holds, then the team: it is pinned at the end of the
		// pinned block, past the first page of the list.
		const sessions = Array.from({ length: 55 }, (_, index) => ({
			type: "narrator" as const,
			id: `state-${index}`,
			title: `s${index}`,
			lastVisitedAt: index + 2,
			pin: true,
		}));
		await db.insert(narrators).values(
			sessions.map(({ id, title }) => ({
				id,
				title,
				ownerUserId: user,
				createdAt: now(),
				updatedAt: now(),
			})),
		);
		for (let start = 0; start < sessions.length; start += 50) {
			await upsertRecentTabsBatch(user, sessions.slice(start, start + 50));
		}
		await upsertRecentTab(user, teamTab(teamId), { pin: true });
		const firstPage = await listPage(user, "work");
		expect(firstPage.hasMore).toBe(true);
		expect(firstPage.items).toHaveLength(50);
		expect(firstPage.items.some((item) => item.id === teamId)).toBe(false);

		expect(service.getRecentTabState(user, "team", teamId)).toEqual({
			present: true,
			pinned: true,
		});
		expect(service.getRecentTabState(user, "project", projectId)).toEqual({
			present: true,
			pinned: false,
		});
		expect(service.getRecentTabState(user, "project", "elsewhere")).toEqual({
			present: false,
			pinned: false,
		});
		// Another user's tab is not this user's.
		expect(service.getRecentTabState(ownerId, "team", teamId)).toEqual({
			present: false,
			pinned: false,
		});
	});

	test("an old unpinned project visit reads as gone before its conversion runs", async () => {
		const user = await makeUser();
		const old = await makeProject();
		const kept = await makeProject();
		await db.insert(userRecentTabs).values(
			[kept, old].map((projectId, index) => ({
				id: generateId(),
				userId: user,
				tabKey: `project:${projectId}`,
				section: "projects" as const,
				type: "project" as const,
				entityId: projectId,
				title: `p-${index}`,
				lastVisitedAt: 1,
				pinned: index === 0,
				sortOrder: index,
				createdAt: now(),
				updatedAt: now(),
			})),
		);
		expect(service.getRecentTabState(user, "project", old)).toEqual({
			present: false,
			pinned: false,
		});
		expect(service.getRecentTabState(user, "project", kept)).toEqual({
			present: true,
			pinned: true,
		});
	});
});

describe("team and project tabs behave like other tabs", () => {
	test("pin in the same revision as the upsert, then unpin, move and close with undo", async () => {
		const user = await makeUser();
		const projectId = await makeProject("public");
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, user, "write");
		await upsertRecentTab(user, { type: "narrator", id: "n-1", title: "n1", lastVisitedAt: 1 });
		await upsertRecentTab(user, { type: "narrator", id: "n-2", title: "n2", lastVisitedAt: 2 });

		const pinnedTeam = await upsertRecentTab(user, teamTab(teamId), { pin: true });
		expect(pinnedTeam.revision).toBe(pinnedTeam.baseRevision + 1);
		const pinnedProject = await upsertRecentTab(
			user,
			{ type: "project", id: projectId, title: "Project", lastVisitedAt: 3 },
			{ pin: true },
		);
		expect(pinnedProject.operations.some((op) => op.key === `project:${projectId}`)).toBe(true);
		// The pinned block leads, in pin order.
		expect((await keysOf(user)).slice(0, 2)).toEqual([`team:${teamId}`, `project:${projectId}`]);

		// A revisit (no `pin`) keeps the stored pin.
		await upsertRecentTab(user, { type: "project", id: projectId, title: "P", lastVisitedAt: 4 });
		expect((await tabsOf(user)).find((tab) => tab.id === projectId)?.pinned).toBe(true);

		await pinRecentTab(user, `team:${teamId}`, false);
		const afterUnpin = await tabsOf(user);
		expect(afterUnpin[0]).toMatchObject({ type: "project", pinned: true });
		// Unpinning lands first among the rest and keeps the tab.
		expect(afterUnpin[1]).toMatchObject({ type: "team", id: teamId });
		expect(afterUnpin[1].pinned).toBeUndefined();

		await moveRecentTab(user, { key: `team:${teamId}`, afterKey: "narrator:n-1" });
		const order = await keysOf(user);
		expect(order.indexOf(`team:${teamId}`)).toBe(order.indexOf("narrator:n-1") + 1);

		const closed = await removeRecentTab(user, "team", teamId, { storeUndo: true });
		expect(closed.undoToken).toBeString();
		expect(await keysOf(user)).not.toContain(`team:${teamId}`);
		await restoreRecentTabs(user, { token: closed.undoToken as string });
		expect(await keysOf(user)).toContain(`team:${teamId}`);
		expect((await tabsOf(user)).find((tab) => tab.id === teamId)?.projectId).toBe(projectId);
	});

	test("projects and teams never join folders", async () => {
		const user = await makeUser();
		const projectId = await makeProject("public");
		await upsertRecentTab(user, { type: "narrator", id: "f-1", title: "a", lastVisitedAt: 1 });
		await upsertRecentTab(user, { type: "narrator", id: "f-2", title: "b", lastVisitedAt: 2 });
		await upsertRecentTab(user, { type: "project", id: projectId, title: "p", lastVisitedAt: 3 });
		const folder = await service.createRecentTabFolder(user, {
			targetKey: "narrator:f-1",
			sourceKey: "narrator:f-2",
			title: "Folder",
		});
		await moveRecentTab(user, { key: `project:${projectId}`, folderId: folder.folderId as string });
		expect((await tabsOf(user)).find((tab) => tab.id === projectId)?.folderId).toBeUndefined();
	});

	test("clearing inactive sessions keeps project and team tabs", async () => {
		const user = await makeUser();
		const projectId = await makeProject("public");
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, user, "read");
		await upsertRecentTab(user, { type: "narrator", id: "idle-1", title: "x", lastVisitedAt: 1 });
		await upsertRecentTab(user, teamTab(teamId));
		await upsertRecentTab(user, { type: "project", id: projectId, title: "p", lastVisitedAt: 2 });
		await clearRecentTabs(user, "inactive_narrators");
		expect(new Set(await keysOf(user))).toEqual(
			new Set([`team:${teamId}`, `project:${projectId}`]),
		);
	});

	test("trim: an unpinned team tab ages out like any tab, a pinned one stays", async () => {
		const user = await makeUser();
		const projectId = await makeProject("public");
		const oldTeam = await makeTeam(projectId);
		const pinnedTeam = await makeTeam(projectId);
		await grantNarrator(oldTeam, user, "read");
		await grantNarrator(pinnedTeam, user, "read");
		await upsertRecentTab(user, teamTab(pinnedTeam), { pin: true });
		await upsertRecentTab(user, teamTab(oldTeam));
		// Fill the list: every new tab goes in above the old team tab, which sinks to the bottom.
		for (let start = 0; start < RECENT_TABS_STORAGE_LIMIT; start += 100) {
			await upsertRecentTabsBatch(
				user,
				Array.from({ length: 100 }, (_, index) => ({
					type: "narrator" as const,
					id: `fill-${start + index}`,
					title: "fill",
					lastVisitedAt: start + index,
				})),
			);
		}
		const keys = await keysOf(user);
		expect(keys.length).toBe(RECENT_TABS_STORAGE_LIMIT);
		expect(keys[0]).toBe(`team:${pinnedTeam}`);
		expect(keys).not.toContain(`team:${oldTeam}`);
	});
});

describe("team tabs are not a recipient index", () => {
	test("holding only a team tab makes nobody a recipient of the coordinator", async () => {
		const holder = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, holder, "write");
		await upsertRecentTab(holder, teamTab(teamId), { pin: true });

		expect(await getRecentTabUserIdsForNarrator(teamId)).not.toContain(holder);
		expect(await getRecentTabUserIdsForNarratorByRecency(teamId, 10)).not.toContain(holder);
		expect(await getRecentTabUserIdsForTeamTrees({ coordinatorId: teamId }, 10)).not.toContain(
			holder,
		);
		expect(await getRecentTabUserIdsForTeamTrees({ projectId }, 10)).not.toContain(holder);
		expect(await getRecentTabUserIds("narrator", teamId)).not.toContain(holder);
		expect(await getRecentTabUserIds("team", teamId)).toEqual([holder]);
	});
});

describe("team tabs follow the team", () => {
	test("a coordinator rename renames the team tab", async () => {
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId, "Before");
		await upsertRecentTab(ownerId, teamTab(teamId));
		await syncNarratorTitleToRecentTabs(teamId, "After");
		expect((await tabsOf(ownerId)).find((tab) => tab.id === teamId)?.title).toBe("After");
	});

	test("runtime: the coordinator's state, pending approvals for members, none for others", async () => {
		const member = await makeUser();
		const onlooker = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, member, "write");
		const onlookerGrant = await grantNarrator(teamId, onlooker, "read");
		await db
			.update(narrators)
			.set({ status: "waiting", substatus: JSON.stringify(["unread"]) })
			.where(eq(narrators.id, teamId));
		const messageId = generateId();
		await db.insert(narratorMessages).values({
			id: messageId,
			narratorId: teamId,
			role: "assistant",
			contentJson: [],
			createdAt: now(),
		});
		await db.insert(narratorToolCalls).values({
			id: generateId(),
			narratorId: teamId,
			messageId,
			toolUseId: generateId(),
			toolName: "Bash",
			status: "pending",
			createdAt: now(),
		});
		// R2: an item ready to accept counts beside the calls (the tab's badge sums both).
		await db.insert(teamWorkItems).values({
			id: generateId(),
			teamId,
			projectId,
			title: "Ready",
			state: "ready",
			createdAt: now(),
			updatedAt: now(),
		});
		await upsertRecentTab(member, teamTab(teamId));
		await upsertRecentTab(onlooker, teamTab(teamId));

		const [memberPatch] = (await getRuntimePatches(member, [`team:${teamId}`])).patches;
		expect(memberPatch.patch).toMatchObject({
			status: "waiting",
			substatus: ["unread"],
			teamOnlooker: false,
			pendingApprovalCount: 1,
			readyItemCount: 1,
		});
		const [onlookerPatch] = (await getRuntimePatches(onlooker, [`team:${teamId}`])).patches;
		expect(onlookerPatch.patch).toMatchObject({
			status: "waiting",
			teamOnlooker: true,
			pendingApprovalCount: null,
			readyItemCount: null,
		});

		// Lost access: the tab still exists until the prune, but it reads no state.
		await db.delete(aclGrants).where(eq(aclGrants.id, onlookerGrant));
		const { patches } = await getRuntimePatches(onlooker, [`team:${teamId}`]);
		expect(patches).toEqual([]);
	});

	test("access loss on the coordinator drops the tab for that holder only", async () => {
		const kept = await makeUser();
		const lost = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, kept, "read");
		const grant = await grantNarrator(teamId, lost, "read");
		await upsertRecentTab(kept, teamTab(teamId));
		await upsertRecentTab(lost, teamTab(teamId));

		await db.delete(aclGrants).where(eq(aclGrants.id, grant));
		await pruneTeamTabs(teamId);
		expect(await keysOf(kept)).toContain(`team:${teamId}`);
		expect(await keysOf(lost)).not.toContain(`team:${teamId}`);
	});

	test("undo does not restore a team after its coordinator grant was revoked", async () => {
		const holder = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		const grant = await grantNarrator(teamId, holder, "read");
		await upsertRecentTab(holder, teamTab(teamId), { pin: true });
		const closed = await removeRecentTab(holder, "team", teamId, { storeUndo: true });
		expect(closed.undoToken).toBeString();
		await db.delete(aclGrants).where(eq(aclGrants.id, grant));
		expect(await restoreRecentTabs(holder, { token: closed.undoToken })).toMatchObject({
			changed: false,
			operations: [],
		});
		expect(await keysOf(holder)).not.toContain(`team:${teamId}`);
	});

	test("archiving the team drops every holder's tab", async () => {
		const holder = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, holder, "read");
		await upsertRecentTab(holder, teamTab(teamId), { pin: true });
		await upsertRecentTab(ownerId, teamTab(teamId));

		await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, teamId));
		await pruneTeamTabs(teamId);
		expect(await keysOf(holder)).not.toContain(`team:${teamId}`);
		expect(await keysOf(ownerId)).not.toContain(`team:${teamId}`);
	});

	test("the archive listener drops the tabs whatever path archived the coordinator", async () => {
		const { startTeamStatusSync } = await import("../teams/team-service");
		const { eventBus } = await import("../../lib/event-bus");
		const holder = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, holder, "read");
		await upsertRecentTab(holder, teamTab(teamId));
		const stop = startTeamStatusSync();
		try {
			await db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, teamId));
			eventBus.emit({ type: "narrator:status_changed", narratorId: teamId, status: "archived" });
			for (let attempt = 0; attempt < 50; attempt++) {
				if (!(await keysOf(holder)).includes(`team:${teamId}`)) break;
				await new Promise((resolve) => setTimeout(resolve, 20));
			}
			expect(await keysOf(holder)).not.toContain(`team:${teamId}`);
		} finally {
			stop();
		}
	});

	test("deleting the team removes the tab from everyone", async () => {
		const holder = await makeUser();
		const projectId = await makeProject();
		const teamId = await makeTeam(projectId);
		await grantNarrator(teamId, holder, "read");
		await upsertRecentTab(holder, teamTab(teamId));
		await removeTabFromAllUsers("team", teamId);
		expect(await keysOf(holder)).not.toContain(`team:${teamId}`);
	});

	test("losing the project drops its team tabs the coordinator no longer lets you read", async () => {
		const member = await makeUser();
		const projectId = await makeProject("private");
		const otherProject = await makeProject();
		const teamId = await makeTeam(projectId);
		const otherTeam = await makeTeam(otherProject);
		// Project-wide audience: readable through the project grant only.
		await db.update(narrators).set({ visibility: "project" }).where(eq(narrators.id, teamId));
		const grant = generateId();
		await db.insert(aclGrants).values({
			id: grant,
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: member,
			capability: "read",
			grantedBy: ownerId,
			createdAt: now(),
		});
		await grantNarrator(otherTeam, member, "read");
		await upsertRecentTab(member, teamTab(teamId));
		await upsertRecentTab(member, teamTab(otherTeam));
		expect(await keysOf(member)).toContain(`team:${teamId}`);

		await db.delete(aclGrants).where(eq(aclGrants.id, grant));
		await pruneUnreadableProjectTabs(member, projectId);
		const keys = await keysOf(member);
		expect(keys).not.toContain(`team:${teamId}`);
		expect(keys).toContain(`team:${otherTeam}`);
	});
});

describe("the retired projects section", () => {
	test("pinned project tabs join the list once; unpinned ones are dropped", async () => {
		const user = await makeUser();
		await db.insert(userPreferences).values({
			id: generateId(),
			userId: user,
			recentTabs: "[]",
			createdAt: now(),
			updatedAt: now(),
		});
		// A first read migrates the (empty) legacy list and creates the meta row.
		await listAllRecentTabs(user);
		const kept = await makeProject();
		const old = await makeProject();
		const session = generateId();
		await db.insert(narrators).values({
			id: session,
			ownerUserId: user,
			createdAt: now(),
			updatedAt: now(),
		});
		const row = (key: string, type: "project" | "narrator", pinned: boolean, order: number) => ({
			id: generateId(),
			userId: user,
			tabKey: key,
			section: type === "project" ? ("projects" as const) : ("work" as const),
			type,
			entityId: key.split(":")[1],
			representedNarratorId: type === "narrator" ? key.split(":")[1] : null,
			title: key,
			lastVisitedAt: order,
			pinned,
			sortOrder: order,
			createdAt: now(),
			updatedAt: now(),
		});
		await db
			.insert(userRecentTabs)
			.values([
				row(`project:${kept}`, "project", true, 1),
				row(`project:${old}`, "project", false, 2),
				row(`narrator:${session}`, "narrator", false, 3),
			]);

		const page = await listPage(user, "work");
		expect(page.items.map((item) => `${item.type}:${item.id}`)).toEqual([
			`project:${kept}`,
			`narrator:${session}`,
		]);
		expect((await listPage(user, "projects")).items).toEqual([]);
		const sections = db
			.select({ section: userRecentTabs.section })
			.from(userRecentTabs)
			.where(eq(userRecentTabs.userId, user))
			.all();
		expect(sections.every((entry) => entry.section === "work")).toBe(true);
	});

	test("before the folder conversion too: old project visits never reach the list", async () => {
		const user = await makeUser();
		await db.insert(userPreferences).values({
			id: generateId(),
			userId: user,
			recentTabs: "[]",
			createdAt: now(),
			updatedAt: now(),
		});
		await listAllRecentTabs(user);
		// A user from before folders: the workspace-group conversion has not run yet.
		await db
			.update(userRecentTabsMeta)
			.set({ foldersMigrated: false })
			.where(eq(userRecentTabsMeta.userId, user));
		const base = (key: string, order: number) => ({
			id: generateId(),
			userId: user,
			tabKey: key,
			entityId: key.split(":")[1],
			title: key,
			lastVisitedAt: order,
			sortOrder: order,
			createdAt: now(),
			updatedAt: now(),
		});
		await db.insert(userRecentTabs).values([
			{ ...base("workspace:ws", 1), section: "work", type: "workspace", title: "Old group" },
			{
				...base("narrator:inside", 2),
				section: "work",
				type: "narrator",
				representedNarratorId: "inside",
				workspaceId: "ws",
			},
			{ ...base("project:kept", 3), section: "projects", type: "project", pinned: true },
			{ ...base("project:old", 4), section: "projects", type: "project", pinned: false },
		]);

		const tabs = await listAllRecentTabs(user);
		expect(tabs.map((tab) => `${tab.type}:${tab.id}`)).toEqual([
			"project:kept",
			"folder:ws",
			"narrator:inside",
		]);
		expect(tabs.find((tab) => tab.id === "ws")).toMatchObject({
			type: "folder",
			title: "Old group",
		});
		expect(tabs.find((tab) => tab.id === "inside")?.folderId).toBe("ws");
		const rows = db
			.select({ key: userRecentTabs.tabKey, section: userRecentTabs.section })
			.from(userRecentTabs)
			.where(eq(userRecentTabs.userId, user))
			.all();
		// The workspace header became a folder row with the same id.
		expect(rows.map((row) => row.key).sort()).toEqual([
			"folder:ws",
			"narrator:inside",
			"project:kept",
		]);
		expect(rows.every((row) => row.section === "work")).toBe(true);
		const meta = db
			.select({ foldersMigrated: userRecentTabsMeta.foldersMigrated })
			.from(userRecentTabsMeta)
			.where(eq(userRecentTabsMeta.userId, user))
			.get();
		expect(meta?.foldersMigrated).toBe(true);
		// Idempotent: a second read changes nothing.
		const revision = (await listPage(user, "work")).revision;
		expect(await keysOf(user)).toEqual(["project:kept", "folder:ws", "narrator:inside"]);
		expect((await listPage(user, "work")).revision).toBe(revision);
	});
});
