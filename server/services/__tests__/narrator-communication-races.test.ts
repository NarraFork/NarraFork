import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "narrafork-communication-races-"));
process.env.NARRAFORK_HOME = home;
const { db, sqlite } = await import("../../db");
const { narrators, userRecentTabs } = await import("../../db/schema");
const core = await import("../narrator-communication/index");
const { eventBus } = await import("../../lib/event-bus");
const { searchCommunicationCandidates, createCommunicationCandidateSearcher } = await import(
	"../search/communication-candidates"
);
const { shutdownDbWorkerPool } = await import("../../lib/db-worker/pool");
const now = "2026-11-24T00:00:00.000Z";
const actor = { userId: "writer", isAdmin: false };
function seed(
	id: string,
	parent: string | null = null,
	options: Partial<typeof narrators.$inferInsert> = {},
) {
	db.insert(narrators)
		.values({
			id,
			title: id,
			ownerUserId: "writer",
			status: "idle",
			createdAt: now,
			updatedAt: now,
			...(parent
				? {
						type: "subagent",
						aclRootNarratorId: "root",
						parentNarratorId: parent,
						runtimeRegistrationJson: {
							version: 1,
							controller: { narratorId: parent, actions: ["stop"] },
						},
					}
				: {}),
			...options,
		})
		.run();
	core.ensureCommunicationNodeTx(db, id, parent);
}
beforeEach(() => {
	sqlite.run("DELETE FROM narrator_communication_peers");
	sqlite.run("DELETE FROM narrator_communication_nodes");
	sqlite.run("DELETE FROM user_recent_tabs");
	sqlite.run("DELETE FROM narrators");
	sqlite.run("DELETE FROM acl_grants");
	for (const [id, role] of [
		["writer", "user"],
		["other", "user"],
		["admin", "admin"],
	])
		sqlite.run(
			"INSERT OR REPLACE INTO users(id,username,password_hash,role,created_at) VALUES (?,?,?, ?,?)",
			[id, id, "unused", role, now],
		);
});
afterAll(() => {
	shutdownDbWorkerPool();
	sqlite.close();
	if (previousHome === undefined) delete process.env.NARRAFORK_HOME;
	else process.env.NARRAFORK_HOME = previousHome;
	rmSync(home, { recursive: true, force: true });
});
const execute = async (text: string, params: Array<string | number | null>) =>
	sqlite.query(text).all(...params) as Record<string, unknown>[];
function pausedReader(match: (sql: string) => boolean) {
	let release: () => void = () => {};
	let reached: () => void = () => {};
	const started = new Promise<void>((resolve) => {
		reached = resolve;
	});
	const resume = new Promise<void>((resolve) => {
		release = resolve;
	});
	return {
		started,
		release,
		read: async (text: string, params: Array<string | number | null>) => {
			const rows = await execute(text, params);
			if (match(text)) {
				reached();
				await resume;
			}
			return rows;
		},
	};
}
test("real fresh projections retain an authorized restoration/undo landing without recreating a peer", async () => {
	seed("root");
	seed("child", "root");
	seed("grand", "child");
	const before = await core.getCommunicationTopology(
		{ kind: "narrator", narratorId: "child" },
		actor,
	);
	await core.mutateCommunication("child", actor, { kind: "split", version: 1 });
	const detached = await core.getCommunicationTopology(
		{ kind: "narrator", narratorId: "child" },
		actor,
	);
	const parentView = await core.getCommunicationTopology(
		{ kind: "narrator", narratorId: "root" },
		actor,
	);
	expect(detached.nodes.find((n) => n.id === "child")?.restoreParentId).toBe("root");
	expect(detached.nodes.some((n) => n.id === "root")).toBe(true);
	expect(parentView.nodes.some((n) => n.id === "child")).toBe(true);
	expect(detached.peers).toHaveLength(0);
	expect(core.communicationReachableTx(db, "root", "child")).toBe(false);
	await core.mutateCommunication("child", actor, { kind: "restore", version: 2 });
	const restored = await core.getCommunicationTopology(
		{ kind: "narrator", narratorId: "child" },
		actor,
	);
	expect(restored.nodes.map((n) => n.id).sort()).toEqual(before.nodes.map((n) => n.id).sort());
	expect(core.communicationReachableTx(db, "root", "grand")).toBe(true);
});
test("restoration landing never exposes an unreadable original parent", async () => {
	seed("root", null, { ownerUserId: "other" });
	seed("child", "root", { type: "primary", ownerUserId: "writer", aclRootNarratorId: null });
	await core.mutateCommunication("child", actor, { kind: "split", version: 1 });
	const graph = await core.getCommunicationTopology(
		{ kind: "narrator", narratorId: "child" },
		actor,
	);
	expect(graph.nodes[0]?.restoreParentId).toBeNull();
	expect(JSON.stringify(graph)).not.toContain('"root"');
});
test("candidate metadata distinguishes same-group and exact contacts without exposing an unreadable parent", async () => {
	seed("root");
	seed("child", "root");
	seed("outside");
	seed("secret-parent", null, { ownerUserId: "other", title: "HIDDEN-PARENT" });
	seed("fork", null, { parentNarratorId: "secret-parent" });
	core.insertCommunicationPeerTx(db, "root", "outside", { userId: "writer", source: "manual" });
	const result = await searchCommunicationCandidates("root", actor);
	expect(result.items.find((item) => item.id === "child")).toMatchObject({
		sameGroup: true,
		connected: false,
		parentTitle: "root",
	});
	expect(result.items.find((item) => item.id === "outside")).toMatchObject({
		sameGroup: false,
		connected: true,
	});
	expect(result.items.find((item) => item.id === "fork")?.parentTitle).toBeNull();
	expect(JSON.stringify(result)).not.toContain("HIDDEN-PARENT");
});
test("canConnect candidates require both the submitting viewer and persistent actor to write", async () => {
	seed("source", null, { ownerUserId: "admin", visibility: "public", writeAudience: "public" });
	seed("readonly", null, { ownerUserId: "admin" });
	sqlite.run(
		"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,created_at) VALUES ('readonly-grant','narrator','readonly','user','writer','read',?)",
		[now],
	);
	expect((await searchCommunicationCandidates("source", actor)).items).toEqual([]);
});
test("candidate SQL applies ACL before LIMIT and short Chinese matches beyond any recent-N preselection", async () => {
	seed("source");
	for (let i = 0; i < 320; i++) {
		seed(`blocked-${i}`, null, {
			title: "深处",
			ownerUserId: "other",
			lastMessageAt: "2030-01-01",
		});
		seed(`newer-${i}`, null, { lastMessageAt: "2030-01-01" });
	}
	seed("needle", null, { title: "深处", lastMessageAt: "2020-01-01" });
	const found = await searchCommunicationCandidates("source", actor, { query: "深", limit: 1 });
	expect(found.items.map((n) => n.id)).toEqual(["needle"]);
	expect(found.hasMore).toBe(false);
	expect(JSON.stringify(found)).not.toContain("runtimeRegistrationJson");
});
test("recent membership uses complete stored EXISTS and within-section real lastMessageAt ordering", async () => {
	seed("source");
	seed("new", null, {
		title: "通讯测试new",
		lastMessageAt: "2026-11-23T00:00:00Z",
		updatedAt: "2020-01-01",
	});
	seed("old", null, {
		title: "通讯测试old",
		lastMessageAt: "2026-11-20T00:00:00Z",
		updatedAt: "2030-01-01",
	});
	seed("notrecent", null, { title: "通讯测试other", lastMessageAt: "2031-01-01" });
	for (const id of ["new", "old"])
		db.insert(userRecentTabs)
			.values({
				id: `recent-${id}`,
				userId: "writer",
				tabKey: id,
				section: "work",
				type: "narrator",
				entityId: id,
				representedNarratorId: id,
				title: id,
				folderId: "collapsed-folder",
				sortOrder: 99,
				lastVisitedAt: 1,
				createdAt: now,
				updatedAt: now,
			})
			.run();
	const top = await searchCommunicationCandidates("source", actor, { query: "通讯测试", limit: 1 });
	expect(top.items.map(({ id, isRecent }) => [id, isRecent])).toEqual([["new", true]]);
	expect(top.hasMore).toBe(true);
	const all = await searchCommunicationCandidates("source", actor, { query: "通讯测试", limit: 3 });
	expect(all.items.map(({ id, isRecent }) => [id, isRecent])).toEqual([
		["new", true],
		["old", true],
		["notrecent", false],
	]);
	expect(all.hasMore).toBe(false);
});
test("candidate search returns only the top 50 and an overflow flag without a cursor", async () => {
	seed("source");
	for (let i = 1; i <= 55; i++) {
		const sequence = String(i).padStart(2, "0");
		seed(`candidate-${sequence}`, null, {
			title: "候选会话",
			lastMessageAt: `2026-11-24T00:00:${sequence}Z`,
		});
	}
	seed("blocked", null, { title: "候选会话", ownerUserId: "other", lastMessageAt: "2030-01-01" });
	const result = await searchCommunicationCandidates("source", actor, { query: "候选", limit: 50 });
	expect(result).toEqual({ items: expect.any(Array), hasMore: true });
	expect(result.items.map((item) => item.id)).toEqual(
		Array.from({ length: 50 }, (_, i) => `candidate-${String(55 - i).padStart(2, "0")}`),
	);
});
test.each([
	"acl",
	"role",
])("pending candidate results are discarded after %s change", async (kind) => {
	seed("source", null, { ownerUserId: kind === "role" ? "admin" : "writer" });
	seed("target", null, { ownerUserId: kind === "role" ? "other" : "writer" });
	const pending = pausedReader((sql) => sql.includes("), eligible AS ("));
	const search = createCommunicationCandidateSearcher({
		execute: pending.read,
		authorize: core.communicationCandidateSearchGuard,
	});
	const principal = kind === "role" ? { userId: "admin", isAdmin: true } : actor;
	const result = search("source", principal);
	await pending.started;
	if (kind === "role") {
		sqlite.run("UPDATE users SET role='user' WHERE id='admin'");
		eventBus.emit({ type: "auth:changed", userId: "admin" });
	} else {
		db.update(narrators).set({ ownerUserId: "other" }).where(eq(narrators.id, "target")).run();
		eventBus.emit({
			type: "narrator:access_changed",
			narratorId: "target",
			reason: "owner_changed",
		});
	}
	pending.release();
	await expect(result).rejects.toMatchObject({ code: "COMMUNICATION_ACCESS_CHANGED" });
});
test.each([
	"acl",
	"role",
])("pending Send/model-context contacts are discarded after %s change", async (kind) => {
	seed("root", null, { ownerUserId: kind === "role" ? "admin" : "writer" });
	seed("target", null, { ownerUserId: kind === "role" ? "other" : "writer" });
	core.insertCommunicationPeerTx(db, "root", "target", { userId: "admin", source: "manual" });
	const pending = pausedReader((sql) => sql.startsWith("WITH RECURSIVE ancestors"));
	const list = core.createCommunicationTargetReader(pending.read);
	const result = list("root");
	await pending.started;
	if (kind === "role") {
		sqlite.run("UPDATE users SET role='user' WHERE id='admin'");
		eventBus.emit({ type: "auth:changed", userId: "admin" });
	} else {
		db.update(narrators).set({ ownerUserId: "other" }).where(eq(narrators.id, "target")).run();
		eventBus.emit({
			type: "narrator:access_changed",
			narratorId: "target",
			reason: "owner_changed",
		});
	}
	pending.release();
	await expect(result).rejects.toMatchObject({ code: "COMMUNICATION_ACCESS_CHANGED" });
});
test("write ACL SQL matches real capability, role and domain-credential grants", async () => {
	seed("root", null, { ownerUserId: "other" });
	const { canWriteNarrator } = await import("../narrator-acl");
	for (const principalType of ["user", "role"])
		for (const capability of ["read", "write", "manage"])
			for (const domain of [null, "clearance"]) {
				sqlite.run("DELETE FROM acl_grants");
				sqlite.run(
					"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,domain_kind,domain_value,created_at) VALUES ('grant','narrator','root',?,?,?,?,?,?)",
					[
						principalType,
						principalType === "user" ? "writer" : "user",
						capability,
						domain,
						domain ? "restricted" : null,
						now,
					],
				);
				const row = db.select().from(narrators).where(eq(narrators.id, "root")).get();
				if (!row) throw new Error("Missing fixture");
				const expected = await canWriteNarrator(row, actor);
				let actual = true;
				try {
					core.assertCommunicationAccessTx(db, "root", actor, "write");
				} catch {
					actual = false;
				}
				expect(actual).toBe(expected);
			}
});
test.each([
	"creation",
	"runtime",
	"timeout",
	"disabled",
])("topology Worker %s failures never produce an inline success", async (kind) => {
	seed("root");
	const previous = process.env.NARRAFORK_DB_WORKER;
	try {
		if (kind === "disabled") {
			process.env.NARRAFORK_DB_WORKER = "off";
			await expect(
				core.getCommunicationTopology({ kind: "narrator", narratorId: "root" }, actor),
			).rejects.toMatchObject({ code: "SEARCH_QUERY_UNAVAILABLE" });
		} else {
			const { createSqliteSearchQueryExecutor } = await import("../search/sqlite-worker-runner");
			let calls = 0;
			const run = createSqliteSearchQueryExecutor("/fixture/worker-only.sqlite", {
				timeoutMs: 10,
				runTask: async () => {
					calls++;
					if (kind === "timeout") return new Promise(() => {});
					throw new Error(kind);
				},
			});
			await expect(
				core.createCommunicationReader(run)({ kind: "narrator", narratorId: "root" }, actor),
			).rejects.toMatchObject({
				code: kind === "timeout" ? "SEARCH_QUERY_TIMEOUT" : "SEARCH_QUERY_UNAVAILABLE",
			});
			expect(calls).toBe(1);
		}
	} finally {
		if (previous === undefined) delete process.env.NARRAFORK_DB_WORKER;
		else process.env.NARRAFORK_DB_WORKER = previous;
	}
});
test("pending topology is discarded when an ACL event invalidates its read snapshot", async () => {
	seed("root");
	seed("child", "root");
	const pending = pausedReader((sql) => sql.includes("SELECT s.*, a.id AS root_id"));
	const read = core.createCommunicationReader(pending.read);
	const result = read({ kind: "narrator", narratorId: "root" }, actor);
	await pending.started;
	eventBus.emit({
		type: "project:access_changed",
		projectId: "project",
		reason: "members_changed",
	});
	pending.release();
	await expect(result).rejects.toMatchObject({ code: "COMMUNICATION_ACCESS_CHANGED" });
});
