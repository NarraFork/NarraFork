import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { withRuntimePolicyTrait } from "../../lib/runtime-policy-trait";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "narrafork-communication-races-"));
process.env.NARRAFORK_HOME = home;
const { db, sqlite } = await import("../../db");
const { narrators, userRecentTabs } = await import("../../db/schema");
const core = await import("../narrator-communication/index");
const { eventBus } = await import("../../lib/event-bus");
const {
	searchCommunicationCandidates,
	createCommunicationCandidateSearcher,
	getCommunicationAccessEpoch,
} = await import("../search/communication-candidates");
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
	expect(await searchCommunicationCandidates("source", actor, { targetId: "readonly" })).toEqual({
		items: [],
		hasMore: false,
	});
});
test("manual ranked and exact search let Alice connect writable sessions without granting Bob's execution account Send", async () => {
	const alice = actor;
	const bob = { userId: "other", isAdmin: false };
	seed("bob-source", null, { ownerUserId: bob.userId });
	seed("alice-private", null, { ownerUserId: alice.userId });
	sqlite.run(
		"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,created_at) VALUES ('alice-source','narrator','bob-source','user',?,'write',?)",
		[alice.userId, now],
	);
	const targetId = "alice-private";
	for (const selector of [{ query: "alice-private" }, { targetId }]) {
		expect((await searchCommunicationCandidates("bob-source", alice, selector)).items).toEqual([]);
		expect(
			(
				await searchCommunicationCandidates("bob-source", alice, {
					...selector,
					purpose: "manual-connect",
				})
			).items,
		).toMatchObject([{ id: targetId, canConnect: true }]);
	}
	await expect(
		core.mutateCommunication("bob-source", alice, { kind: "connect", targetNarratorId: targetId }),
	).resolves.toEqual({ changed: true });
	expect(core.communicationReachableTx(db, "bob-source", targetId)).toBe(true);
	expect((await searchCommunicationCandidates("bob-source", alice, { targetId })).items).toEqual(
		[],
	);
	await expect(
		core.assertCommunicationSendAuthorized("bob-source", targetId),
	).rejects.toMatchObject({ statusCode: 404 });
});

test("manual candidates require viewer write on both source and target", async () => {
	seed("source", null, { ownerUserId: "other" });
	seed("target", null, { ownerUserId: "other" });
	for (const id of ["source", "target"])
		sqlite.run(
			"INSERT INTO acl_grants(id,scope_type,scope_id,principal_type,principal_id,capability,created_at) VALUES (?, 'narrator',?,'user','writer','read',?)",
			[`manual-read-${id}`, id, now],
		);
	const options = { purpose: "manual-connect", targetId: "target" } as const;
	await expect(searchCommunicationCandidates("source", actor, options)).rejects.toMatchObject({
		statusCode: 404,
	});
	sqlite.run("UPDATE acl_grants SET capability='write' WHERE id='manual-read-source'");
	expect((await searchCommunicationCandidates("source", actor, options)).items).toEqual([]);
	expect(
		(
			await searchCommunicationCandidates("source", actor, {
				purpose: "manual-connect",
				query: "target",
			})
		).items,
	).toEqual([]);
	expect(
		(await searchCommunicationCandidates("source", actor, { targetId: "target" })).items,
	).toEqual([]);
	await expect(
		core.mutateCommunication("source", actor, { kind: "connect", targetNarratorId: "target" }),
	).rejects.toMatchObject({ statusCode: 404 });
	expect(sqlite.query("SELECT id FROM narrator_communication_peers").all()).toEqual([]);
});

test("exact candidate lookup still enforces the source runtime ceiling", async () => {
	seed("source", null, { traits: withRuntimePolicyTrait([], { version: 1, tools: ["Read"] }) });
	seed("target");
	await expect(
		searchCommunicationCandidates("source", actor, { targetId: "target" }),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(
		(
			await searchCommunicationCandidates("source", actor, {
				targetId: "target",
				purpose: "manual-connect",
			})
		).items,
	).toMatchObject([{ id: "target", canConnect: true }]);
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
test("stored team bookmarks count as recent only for their owner and never override candidate ACL", async () => {
	seed("source");
	const bookmarks = [
		{ id: "own-team", userId: "writer", type: "team", lastMessageAt: "2020-01-01" },
		{ id: "other-team", userId: "other", type: "team", lastMessageAt: "2024-01-01" },
		{ id: "project", userId: "writer", type: "project", lastMessageAt: "2023-01-01" },
		{ id: "folder", userId: "writer", type: "folder", lastMessageAt: "2022-01-01" },
		{ id: "denied-team", userId: "writer", type: "team", lastMessageAt: "2025-01-01" },
	] as const;
	for (const { id, lastMessageAt } of bookmarks)
		seed(id, null, {
			title: `协调候选 ${id}`,
			lastMessageAt,
			ownerUserId: id === "denied-team" ? "other" : "writer",
		});
	db.insert(userRecentTabs)
		.values(
			bookmarks.map(({ id, userId, type }) => ({
				id: `recent-${id}`,
				userId,
				tabKey: `${type}:${id}`,
				section: "work" as const,
				type,
				entityId: id,
				title: id,
				// Team bookmarks do not occupy the session notification index.
				representedNarratorId: null,
				lastVisitedAt: 1,
				sortOrder: 999,
				createdAt: now,
				updatedAt: now,
			})),
		)
		.run();
	const query = "协调";
	const top = await searchCommunicationCandidates("source", actor, { query, limit: 1 });
	expect(top.items.map(({ id, isRecent }) => [id, isRecent])).toEqual([["own-team", true]]);
	expect(top.hasMore).toBe(true);
	const all = await searchCommunicationCandidates("source", actor, { query, limit: 4 });
	expect(all.items.map(({ id, isRecent }) => [id, isRecent])).toEqual([
		["own-team", true],
		["other-team", false],
		["project", false],
		["folder", false],
	]);
	expect(all.hasMore).toBe(false);
});
test("candidate search caps ranked results at 50 but exact lookup ignores ranking and text", async () => {
	seed("source");
	const targetId = "candidate-01";
	const query = "searchable alias";
	for (let i = 1; i <= 55; i++) {
		const sequence = String(i).padStart(2, "0");
		const title = i === 1 ? "候选会话" : `候选会话 ${targetId}`;
		seed(`candidate-${sequence}`, null, {
			title: i === 55 ? `${title} ${query}` : title,
			lastMessageAt: `2026-11-24T00:00:${sequence}Z`,
		});
	}
	seed("blocked", null, { title: targetId, ownerUserId: "other", lastMessageAt: "2030-01-01" });
	const result = await searchCommunicationCandidates("source", actor, {
		query: targetId,
		limit: 50,
	});
	expect(result).toEqual({ items: expect.any(Array), hasMore: true });
	expect(result.items.map((item) => item.id)).toEqual(
		Array.from({ length: 50 }, (_, i) => `candidate-${String(55 - i).padStart(2, "0")}`),
	);
	const text = await searchCommunicationCandidates("source", actor, { query });
	expect(text.items.map((item) => item.id)).toEqual(["candidate-55"]);
	const exact = await searchCommunicationCandidates("source", actor, {
		query,
		limit: 50,
		targetId,
	});
	expect(exact.items.map((item) => item.id)).toEqual([targetId]);
	expect(exact.hasMore).toBe(false);
});
function pauseExactCandidateSearch() {
	const pending = pausedReader((text) => text.includes("), eligible AS ("));
	const search = createCommunicationCandidateSearcher({
		execute: pending.read,
		authorize: core.communicationCandidateSearchGuard,
	});
	return { ...pending, result: search("source", actor, { targetId: "target" }) };
}

test.each([
	["archive", "source"],
	["archive", "target"],
	["delete", "source"],
	["delete", "target"],
] as const)("stale exact results are rejected after %s of the %s", async (transition, endpoint) => {
	seed("source");
	seed("target");
	const pending = pauseExactCandidateSearch();
	await pending.started; // The eligible SQL result has already been read.
	const epoch = getCommunicationAccessEpoch();
	try {
		if (transition === "archive") {
			db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, endpoint)).run();
			eventBus.emit({ type: "narrator:status_changed", narratorId: endpoint, status: "archived" });
		} else {
			db.delete(narrators).where(eq(narrators.id, endpoint)).run();
			eventBus.emit({ type: "narrator:deleted", narratorId: endpoint, title: endpoint });
		}
		expect(getCommunicationAccessEpoch()).toBe(epoch + 1);
	} finally {
		pending.release();
	}
	await expect(pending.result).rejects.toMatchObject({
		statusCode: transition === "delete" && endpoint === "source" ? 404 : 403,
	});
});

test.each([
	"source",
	"target",
] as const)("exact search rereads the %s after a committed archive cascade even before notifications", async (child) => {
	seed("parent");
	seed(child, "parent", { type: "primary", aclRootNarratorId: null });
	seed(child === "source" ? "target" : "source");
	const pending = pauseExactCandidateSearch();
	await pending.started;
	const epoch = getCommunicationAccessEpoch();
	// Model the real archive transaction's single commit for parent and child. Do not let
	// status notifications mask the gap between durable status and event publication.
	db.transaction((tx) => {
		for (const id of ["parent", child])
			tx.update(narrators).set({ status: "archived" }).where(eq(narrators.id, id)).run();
	});
	pending.release();
	await expect(pending.result).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(getCommunicationAccessEpoch()).toBe(epoch);
	for (const id of ["parent", child])
		eventBus.emit({ type: "narrator:status_changed", narratorId: id, status: "archived" });
});

test("ordinary active status changes do not invalidate pending exact lookups", async () => {
	seed("source");
	seed("target");
	const pending = pauseExactCandidateSearch();
	await pending.started;
	const epoch = getCommunicationAccessEpoch();
	db.update(narrators).set({ status: "working" }).where(eq(narrators.id, "target")).run();
	eventBus.emit({ type: "narrator:status_changed", narratorId: "target", status: "working" });
	pending.release();
	expect(getCommunicationAccessEpoch()).toBe(epoch);
	expect((await pending.result).items.map(({ id }) => id)).toEqual(["target"]);
});

test("an archive epoch rejects a stale result even if the endpoint is active again at reread", async () => {
	seed("source");
	seed("target");
	const pending = pauseExactCandidateSearch();
	await pending.started;
	for (const status of ["archived", "idle"] as const) {
		db.update(narrators).set({ status }).where(eq(narrators.id, "target")).run();
		eventBus.emit({ type: "narrator:status_changed", narratorId: "target", status });
	}
	pending.release();
	await expect(pending.result).rejects.toMatchObject({ code: "COMMUNICATION_ACCESS_CHANGED" });
});

test.each([
	["same", "source"],
	["same", "target"],
	["different", "source"],
	["different", "target"],
] as const)("manual connect rejects archived %s-group endpoints (%s) after a positive lookup", async (group, endpoint) => {
	const sameGroup = group === "same";
	seed("source");
	seed("target", sameGroup ? "source" : null, { type: "primary", aclRootNarratorId: null });
	const candidate = (await searchCommunicationCandidates("source", actor, { targetId: "target" }))
		.items[0];
	expect(candidate).toMatchObject({ id: "target", canConnect: true, sameGroup });
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, endpoint)).run();
	await expect(
		core.mutateCommunication("source", actor, { kind: "connect", targetNarratorId: "target" }),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(sqlite.query("SELECT id FROM narrator_communication_peers").all()).toEqual([]);
});

test("archiving preserves an existing peer and either endpoint's writer can still disconnect", async () => {
	seed("source");
	seed("target");
	await expect(
		core.mutateCommunication("source", actor, { kind: "connect", targetNarratorId: "target" }),
	).resolves.toEqual({ changed: true });
	const peer = sqlite
		.query<{ id: string }, []>("SELECT id FROM narrator_communication_peers")
		.get();
	if (!peer) throw new Error("Missing live peer");
	db.update(narrators).set({ status: "archived" }).where(eq(narrators.id, "target")).run();
	await expect(
		core.mutateCommunication("source", actor, { kind: "connect", targetNarratorId: "target" }),
	).rejects.toMatchObject({ code: "COMMUNICATION_DENIED" });
	expect(sqlite.query("SELECT id FROM narrator_communication_peers").all()).toEqual([peer]);
	await expect(
		core.mutateCommunication("target", actor, { kind: "disconnect", peerId: peer.id }),
	).resolves.toEqual({ changed: true });
	expect(sqlite.query("SELECT id FROM narrator_communication_peers").all()).toEqual([]);
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
