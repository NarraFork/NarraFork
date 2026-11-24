import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import {
	aclGrants,
	narrators,
	projects,
	projectTeams,
	userPreferences,
	userRecentTabs,
	userRecentTabsMeta,
	users,
} from "../../db/schema";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
const { db, sqlite } = fixture;
await fixture.ready;
afterAll(() => fixture.close());
const realDbModule = { ...(await import("../../db")) };
const realNarratorWsModule = { ...(await import("../../websocket/narrator-ws")) };
mock.module("../../db", () => ({ db, sqlite }));
mock.module("../../websocket/narrator-ws", () => ({
	broadcastToUser: () => {},
	getNarratorPresenceBatch: () => new Map(),
}));

const { handleAttention } = await import("../notification-service");
const NOW = "2026-07-19T00:00:00.000Z";
const originalFetch = globalThis.fetch;
const requests: Array<{ url: string; init?: RequestInit }> = [];

beforeEach(() => {
	requests.length = 0;
	globalThis.fetch = mock(async (input: string | URL | Request, init?: RequestInit) => {
		requests.push({ url: String(input), init });
		return new Response("ok", { status: 200 });
	}) as unknown as typeof fetch;
});

afterEach(() => {
	globalThis.fetch = originalFetch;
	cleanDb(sqlite);
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWsModule);
	mock.restore();
});

function seedUser(userId: string, notifyEnabled: boolean): void {
	db.insert(users)
		.values({
			id: userId,
			username: userId,
			passwordHash: "test-password-hash",
			role: "user",
			createdAt: NOW,
		})
		.run();
	db.insert(userPreferences)
		.values({
			id: `pref-${userId}`,
			userId,
			recentTabs: "[]",
			notifyDingtalkEnabled: notifyEnabled,
			notifyDingtalkWebhook: notifyEnabled
				? `https://example.test/hook?access=1&user=${userId}`
				: "",
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
}

describe("notification recent-tabs consumer", () => {
	it("notifies users indexed by normalized rows when legacy JSON is empty", async () => {
		seedUser("relevant-user", true);
		seedUser("unrelated-user", true);
		db.insert(narrators)
			.values({
				id: "narrator-notify",
				title: "Indexed narrator",
				status: "idle",
				// This test is about which users the recent-tab index yields, not about who
				// may see the narrator. Notification fan-out now also drops recipients who
				// cannot read it (see filterUsersWhoCanRead), so a default-private fixture
				// would make the assertion fail for an unrelated reason.
				visibility: "public",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabsMeta)
			.values({
				userId: "relevant-user",
				revision: 1,
				migratedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabs)
			.values({
				id: "recent-notify",
				userId: "relevant-user",
				tabKey: "narrator:narrator-notify",
				section: "work",
				type: "narrator",
				entityId: "narrator-notify",
				representedNarratorId: "narrator-notify",
				title: "Indexed narrator",
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		await handleAttention("narrator-notify", "done");

		expect(requests).toHaveLength(1);
		expect(requests[0]?.url).toContain("https://example.test/hook?access=1");
		expect(String(requests[0]?.init?.body)).toContain("Indexed narrator");
		expect(
			db
				.select({ recentTabs: userPreferences.recentTabs })
				.from(userPreferences)
				.where(eq(userPreferences.userId, "relevant-user"))
				.get()?.recentTabs,
		).toBe("[]");
	});

	it("does not notify a user who can no longer read the narrator", async () => {
		// A recent tab records that someone opened the narrator once. Access can be
		// revoked afterwards, and a webhook carrying its title and status would keep
		// delivering to them — a notification must not outlive the permission.
		seedUser("evicted-user", true);
		db.insert(narrators)
			.values({
				id: "narrator-private",
				title: "Private narrator",
				status: "idle",
				ownerUserId: null,
				visibility: "private",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabsMeta)
			.values({
				userId: "evicted-user",
				revision: 1,
				migratedAt: NOW,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(userRecentTabs)
			.values({
				id: "recent-private",
				userId: "evicted-user",
				tabKey: "narrator:narrator-private",
				section: "work",
				type: "narrator",
				entityId: "narrator-private",
				representedNarratorId: "narrator-private",
				title: "Private narrator",
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();

		await handleAttention("narrator-private", "done");

		expect(requests).toHaveLength(0);
	});

	it("a team session waiting for a person alerts its members, not its onlookers (M1)", async () => {
		seedUser("team-owner", true);
		seedUser("team-member", true);
		seedUser("team-onlooker", true);
		db.insert(projects)
			.values({
				id: "team-project",
				name: "Team project",
				gitPath: "/tmp/team-project",
				ownerUserId: "team-owner",
				visibility: "public",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(narrators)
			.values({
				id: "team-lead",
				title: "Team lead",
				status: "waiting",
				ownerUserId: "team-owner",
				// Anyone may look on; only the owner and explicit writers drive it.
				visibility: "public",
				writeAudience: "owner",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(projectTeams)
			.values({
				narratorId: "team-lead",
				projectId: "team-project",
				baseBranch: "main",
				brief: "",
				settingsJson: {},
				status: "active",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		db.insert(aclGrants)
			.values({
				id: "team-member-write",
				scopeType: "narrator",
				scopeId: "team-lead",
				principalType: "user",
				principalId: "team-member",
				capability: "write",
				createdAt: NOW,
			})
			.run();
		for (const userId of ["team-member", "team-onlooker"]) {
			db.insert(userRecentTabsMeta)
				.values({ userId, revision: 1, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
				.run();
			db.insert(userRecentTabs)
				.values({
					id: `recent-${userId}`,
					userId,
					tabKey: "narrator:team-lead",
					section: "work",
					type: "narrator",
					entityId: "team-lead",
					representedNarratorId: "team-lead",
					title: "Team lead",
					lastVisitedAt: 1,
					sortOrder: 0,
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}

		// Members are alerted (the owner too, as in the notification center), the onlooker is not.
		await handleAttention("team-lead", "waiting_permission");
		expect(requests.map((request) => new URL(request.url).searchParams.get("user")).sort()).toEqual(
			["team-member", "team-owner"],
		);

		// More than 200 onlooker tab holders, all sorting before the member: the member is still
		// alerted (the candidates start from the team's members, not from the first holders).
		for (let i = 0; i < 205; i++) {
			const userId = `a-onlooker-${String(i).padStart(3, "0")}`;
			seedUser(userId, true);
			db.insert(userRecentTabsMeta)
				.values({ userId, revision: 1, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
				.run();
			db.insert(userRecentTabs)
				.values({
					id: `recent-${userId}`,
					userId,
					tabKey: "narrator:team-lead",
					section: "work",
					type: "narrator",
					entityId: "team-lead",
					representedNarratorId: "team-lead",
					title: "Team lead",
					lastVisitedAt: 1,
					sortOrder: 0,
					createdAt: NOW,
					updatedAt: NOW,
				})
				.run();
		}
		requests.length = 0;
		await handleAttention("team-lead", "waiting_permission");
		expect(requests.map((request) => new URL(request.url).searchParams.get("user")).sort()).toEqual(
			["team-member", "team-owner"],
		);

		// An admin (a writer outside the member sources) who looked at the session most recently
		// is among the at most 200 holders read, although 205 onlookers sort before them by id.
		seedUser("zz-admin", true);
		db.update(users).set({ role: "admin" }).where(eq(users.id, "zz-admin")).run();
		db.insert(userRecentTabsMeta)
			.values({ userId: "zz-admin", revision: 1, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
			.run();
		db.insert(userRecentTabs)
			.values({
				id: "recent-zz-admin",
				userId: "zz-admin",
				tabKey: "narrator:team-lead",
				section: "work",
				type: "narrator",
				entityId: "team-lead",
				representedNarratorId: "team-lead",
				title: "Team lead",
				lastVisitedAt: 99,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		requests.length = 0;
		await handleAttention("team-lead", "waiting_permission");
		expect(requests.map((request) => new URL(request.url).searchParams.get("user")).sort()).toEqual(
			["team-member", "team-owner", "zz-admin"],
		);

		// The "waiting" alert is a team session's only IM signal: no "done" alert to anyone.
		requests.length = 0;
		await handleAttention("team-lead", "done");
		expect(requests).toHaveLength(0);
	});

	function teamTab(userId: string, narratorId: string): void {
		db.insert(userRecentTabsMeta)
			.values({ userId, revision: 1, migratedAt: NOW, createdAt: NOW, updatedAt: NOW })
			.onConflictDoNothing()
			.run();
		db.insert(userRecentTabs)
			.values({
				id: `recent-${userId}-${narratorId}`,
				userId,
				tabKey: `narrator:${narratorId}`,
				section: "work",
				type: "narrator",
				entityId: narratorId,
				representedNarratorId: narratorId,
				title: narratorId,
				lastVisitedAt: 1,
				sortOrder: 0,
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}

	function seedTeam(narratorId: string, values: Record<string, unknown>): void {
		db.insert(narrators)
			.values({
				id: narratorId,
				title: narratorId,
				status: "waiting",
				ownerUserId: "writers-owner",
				createdAt: NOW,
				updatedAt: NOW,
				...values,
			})
			.run();
		db.insert(projectTeams)
			.values({
				narratorId,
				projectId: "writers-project",
				baseBranch: "main",
				brief: "",
				settingsJson: {},
				status: "active",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
	}

	const alerted = () => requests.map((request) => new URL(request.url).searchParams.get("user"));

	it("a team's waiting alert reaches writers outside the member sources: an admin, a public-audience writer, members past the per-source cut (M1)", async () => {
		seedUser("writers-owner", false);
		seedUser("admin-x", true);
		db.update(users).set({ role: "admin" }).where(eq(users.id, "admin-x")).run();
		seedUser("public-writer", true);
		db.insert(projects)
			.values({
				id: "writers-project",
				name: "Writers project",
				gitPath: "/tmp/writers-project",
				ownerUserId: "writers-owner",
				visibility: "public",
				createdAt: NOW,
				updatedAt: NOW,
			})
			.run();
		// Anyone signed in may write: the public writer has no grant and never spoke.
		seedTeam("public-lead", {
			contextProjectId: "writers-project",
			visibility: "public",
			writeAudience: "public",
		});
		teamTab("admin-x", "public-lead");
		teamTab("public-writer", "public-lead");
		await handleAttention("public-lead", "waiting_permission");
		expect(alerted().sort()).toEqual(["admin-x", "public-writer"]);
		expect(String(requests[0]?.init?.body)).toContain("Decide in NarraFork");

		// 55 members by explicit grant (more than the 50 a source gives), each with the tab open,
		// and an onlooker with the tab open.
		requests.length = 0;
		seedTeam("many-lead", { visibility: "public", writeAudience: "owner" });
		const members: string[] = [];
		for (let i = 0; i < 55; i++) {
			const userId = `m-${String(i).padStart(3, "0")}`;
			members.push(userId);
			seedUser(userId, true);
			db.insert(aclGrants)
				.values({
					id: `grant-${userId}`,
					scopeType: "narrator",
					scopeId: "many-lead",
					principalType: "user",
					principalId: userId,
					capability: "write",
					createdAt: NOW,
				})
				.run();
			teamTab(userId, "many-lead");
		}
		seedUser("z-onlooker", true);
		teamTab("z-onlooker", "many-lead");
		await handleAttention("many-lead", "waiting_permission");
		expect(alerted().sort()).toEqual(members);
	});
});
