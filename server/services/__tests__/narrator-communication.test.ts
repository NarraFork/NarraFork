import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";

const previousHome = process.env.NARRAFORK_HOME;
const home = mkdtempSync(join(tmpdir(), "narrafork-communication-"));
process.env.NARRAFORK_HOME = home;
const { db, sqlite } = await import("../../db");
const { narrators, narratorCommunicationNodes: nodes } = await import("../../db/schema");
const core = await import("../narrator-communication/index");
const { initializeCommunicationNodes } = await import("../narrator-communication/initialize");
const { canWriteNarrator } = await import("../narrator-acl");
const { withRuntimePolicyTrait } = await import("../../lib/runtime-policy-trait");
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
			status: "idle",
			ownerUserId: "writer",
			createdAt: now,
			updatedAt: now,
			...(parent
				? {
						type: "subagent",
						parentNarratorId: parent,
						aclRootNarratorId: "root",
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
function node(id: string) {
	return db.select().from(nodes).where(eq(nodes.narratorId, id)).get();
}
function tree() {
	seed("root");
	seed("child", "root");
	seed("grand", "child");
	seed("sibling", "root");
}
beforeEach(() => {
	sqlite.run("DELETE FROM team_work_events");
	sqlite.run("DELETE FROM team_work_items");
	sqlite.run("DELETE FROM project_teams");
	sqlite.run("DELETE FROM narrator_communication_peers");
	sqlite.run("DELETE FROM narrator_communication_nodes");
	sqlite.run("DELETE FROM narrators");
	sqlite.run("DELETE FROM acl_grants");
	sqlite.run("DELETE FROM projects");
	sqlite.run("DELETE FROM user_preferences");
	for (const [id, role] of [
		["writer", "user"],
		["other", "user"],
		["admin", "admin"],
	])
		sqlite.run(
			"INSERT OR REPLACE INTO users (id,username,password_hash,role,created_at) VALUES (?,?,?, ?,?)",
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

describe("communication forest and admission", () => {
	test("all delegation levels and sibling branches share a domain, without N squared peers", () => {
		tree();
		expect(core.communicationReachableTx(db, "grand", "sibling")).toBe(true);
		expect(core.communicationRootTx(db, "grand")).toBe("root");
		expect(sqlite.query("SELECT count(*) AS n FROM narrator_communication_peers").get()).toEqual({
			n: 0,
		});
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "sibling")).not.toThrow();
	});
	test("split moves the entire subtree but leaves controller, ACL, history and task delegation untouched", async () => {
		tree();
		const before = db.select().from(narrators).where(eq(narrators.id, "child")).get();
		expect(await core.mutateCommunication("child", actor, { kind: "split", version: 1 })).toEqual({
			changed: true,
		});
		expect(core.communicationRootTx(db, "grand")).toBe("child");
		expect(core.communicationReachableTx(db, "root", "grand")).toBe(false);
		expect(db.select().from(narrators).where(eq(narrators.id, "child")).get()).toEqual(before);
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "root")).toThrow();
		await core.mutateCommunication("child", actor, { kind: "restore", version: 2 });
		expect(core.communicationRootTx(db, "grand")).toBe("root");
	});
	test("restoration uses the persisted birth delegator, not a replacement controller", async () => {
		tree();
		seed("other-parent");
		await core.mutateCommunication("child", actor, { kind: "split", version: 1 });
		db.update(narrators)
			.set({
				runtimeRegistrationJson: {
					version: 1,
					controller: { narratorId: "other-parent", actions: ["stop"] },
				},
			})
			.where(eq(narrators.id, "child"))
			.run();
		expect(() => core.restoreCommunicationTx(db, "child", "other-parent", 2)).toThrow();
		await core.mutateCommunication("child", actor, { kind: "restore", version: 2 });
		expect(node("child")?.parentNarratorId).toBe("root");
	});
	test("precise peers are bidirectional and non-transitive; an old relation ID cannot disconnect a reconnected peer", async () => {
		for (const id of ["a", "b", "c"]) seed(id);
		const edge = sqlite.query<{ id: string }, []>(
			"SELECT id FROM narrator_communication_peers WHERE endpoint_lo='a' AND endpoint_hi='b'",
		);
		await core.mutateCommunication("a", actor, { kind: "connect", targetNarratorId: "b" });
		await core.mutateCommunication("b", actor, { kind: "connect", targetNarratorId: "c" });
		expect(core.communicationReachableTx(db, "b", "a")).toBe(true);
		expect(core.communicationReachableTx(db, "a", "c")).toBe(false);
		const old = edge.get();
		if (!old) throw new Error("Expected the original peer");
		const disconnect = { kind: "disconnect", peerId: old.id } as const;
		expect(await core.mutateCommunication("a", actor, disconnect)).toEqual({ changed: true });
		expect(core.communicationReachableTx(db, "a", "b")).toBe(false);
		await core.mutateCommunication("a", actor, { kind: "connect", targetNarratorId: "b" });
		const reconnected = edge.get();
		expect(reconnected).not.toBeNull();
		expect(reconnected?.id).not.toBe(old.id);
		await expect(core.mutateCommunication("a", actor, disconnect)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(edge.get()).toEqual(reconnected);
		expect(core.communicationReachableTx(db, "a", "b")).toBe(true);
	});
	test("only the canonical high endpoint's writer can disconnect using that endpoint after live ACL revocation", async () => {
		seed("a", null, { visibility: "public", writeAudience: "owner" });
		seed("b");
		await core.mutateCommunication("a", actor, { kind: "connect", targetNarratorId: "b" });
		db.update(narrators).set({ ownerUserId: "other" }).where(eq(narrators.id, "a")).run();
		const graph = await core.getCommunicationTopology({ kind: "narrator", narratorId: "b" }, actor);
		expect(graph.nodes.map(({ id, canManage }) => [id, canManage]).sort()).toEqual([
			["a", false],
			["b", true],
		]);
		const [peer] = graph.peers;
		if (!peer) throw new Error("Expected the visible peer");
		expect(peer).toEqual({
			id: expect.any(String),
			endpointLo: "a",
			endpointHi: "b",
			createdAt: expect.any(String),
			canDisconnect: true,
		});
		const disconnect = { kind: "disconnect", peerId: peer.id } as const;
		await expect(core.mutateCommunication("a", actor, disconnect)).rejects.toMatchObject({
			code: "NOT_FOUND",
		});
		expect(core.communicationReachableTx(db, "a", "b")).toBe(true);
		expect(await core.mutateCommunication("b", actor, disconnect)).toEqual({ changed: true });
		expect(core.communicationReachableTx(db, "a", "b")).toBe(false);
	});
	test("missing nodes, loops and over-depth forests fail closed", () => {
		seed("root");
		seed("child", "root");
		db.delete(nodes).where(eq(nodes.narratorId, "root")).run();
		expect(core.communicationReachableTx(db, "child", "root")).toBe(false);
		core.ensureCommunicationNodeTx(db, "root", "child");
		expect(() => core.communicationRootTx(db, "root")).toThrow();
		sqlite.run("DELETE FROM narrator_communication_nodes");
		for (let i = 0; i < 17; i++) {
			const id = `depth-${i}`;
			seed(id, i ? `depth-${i - 1}` : null);
		}
		expect(core.communicationRootTx(db, "depth-15")).toBe("depth-0");
		expect(() => core.communicationRootTx(db, "depth-16")).toThrow();
	});
	test("initialization never resurrects an explicit NULL and ordinary forks stay roots", async () => {
		tree();
		await core.mutateCommunication("child", actor, { kind: "split", version: 1 });
		seed("fork", null, { type: "primary", parentNarratorId: "root" });
		db.delete(nodes).where(eq(nodes.narratorId, "fork")).run();
		seed("legacy", "root");
		db.delete(nodes).where(eq(nodes.narratorId, "legacy")).run();
		await initializeCommunicationNodes();
		expect(node("child")?.parentNarratorId).toBeNull();
		expect(node("child")?.originalParentNarratorId).toBe("root");
		expect(node("fork")?.parentNarratorId).toBeNull();
		expect(node("legacy")?.parentNarratorId).toBe("root");
		expect(await initializeCommunicationNodes()).toBe(0);
	});
	test("deleting a parent safely roots direct children, retains descendants, and removes all contacts", () => {
		tree();
		seed("outside");
		core.insertCommunicationPeerTx(db, "child", "outside", { userId: "writer", source: "manual" });
		db.transaction((tx) => {
			core.detachCommunicationBeforeDeleteTx(tx, "child");
			tx.update(narrators)
				.set({ parentNarratorId: null })
				.where(eq(narrators.parentNarratorId, "child"))
				.run();
			tx.delete(narrators).where(eq(narrators.id, "child")).run();
		});
		expect(node("grand")?.parentNarratorId).toBeNull();
		expect(node("grand")?.originalParentNarratorId).toBeNull();
		expect(node("sibling")?.parentNarratorId).toBe("root");
		expect(sqlite.query("SELECT count(*) AS n FROM narrator_communication_peers").get()).toEqual({
			n: 0,
		});
	});
	test("admission rechecks permissions and rolls back all peers with its surrounding transaction", async () => {
		seed("source");
		seed("a");
		seed("b");
		const prepared = await core.prepareUserCommunicationAdmission({
			sourceNarratorId: "source",
			userId: "writer",
			targetNarratorIds: ["a", "b", "a"],
		});
		expect(prepared.targetNarratorIds).toEqual(["a", "b"]);
		db.update(narrators).set({ ownerUserId: "other" }).where(eq(narrators.id, "b")).run();
		expect(() =>
			db.transaction((tx) =>
				core.commitUserCommunicationAdmissionTx(tx, prepared, { admissionId: "receipt" }),
			),
		).toThrow();
		expect(sqlite.query("SELECT count(*) AS n FROM narrator_communication_peers").get()).toEqual({
			n: 0,
		});
	});
	test("user admission never creates redundant same-domain contacts", async () => {
		tree();
		const prepared = await core.prepareUserCommunicationAdmission({
			sourceNarratorId: "root",
			userId: "writer",
			targetNarratorIds: ["grand"],
		});
		expect(
			db.transaction((tx) =>
				core.commitUserCommunicationAdmissionTx(tx, prepared, { admissionId: "accepted" }),
			),
		).toEqual([]);
	});
	test("final gate uses persistent execution principal, current ACL, and live ceiling", () => {
		tree();
		db.update(narrators)
			.set({
				runtimeRegistrationJson: {
					version: 1,
					run: { logicalRunId: "run", principal: { userId: "other" } },
				},
			})
			.where(eq(narrators.id, "grand"))
			.run();
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "root")).toThrow();
		db.update(narrators)
			.set({ runtimeRegistrationJson: null })
			.where(eq(narrators.id, "grand"))
			.run();
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "root")).not.toThrow();
		sqlite.run(
			"INSERT INTO user_preferences(id,user_id,traits,created_at,updated_at) VALUES ('prefs','writer',?,?,?)",
			[JSON.stringify(withRuntimePolicyTrait([], { version: 1, tools: ["Read"] })), now, now],
		);
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "root")).toThrow();
	});
	test("SQL write predicate matches canWriteNarrator across project gate, owner, grants, audience and delegated ACL", async () => {
		seed("root");
		seed("child", "root");
		sqlite.run(
			"INSERT INTO projects(id,git_path,name,owner_user_id,visibility,created_at,updated_at) VALUES ('project','/fixture','private','other','private',?,?)",
			[now, now],
		);
		for (const type of ["primary", "subagent"] as const)
			for (const writeAudience of ["owner", "project", "public"] as const)
				for (const ownerUserId of ["writer", "other"])
					for (const contextProjectId of [null, "project"]) {
						const id = type === "primary" ? "root" : "child";
						db.update(narrators)
							.set({ ownerUserId, writeAudience, contextProjectId })
							.where(eq(narrators.id, "root"))
							.run();
						const row = db.select().from(narrators).where(eq(narrators.id, id)).get();
						if (!row) throw new Error("fixture missing");
						const expected = await canWriteNarrator(row, actor);
						let actual = true;
						try {
							core.assertCommunicationAccessTx(db, id, actor, "write");
						} catch {
							actual = false;
						}
						expect(actual).toBe(expected);
					}
	});
});

describe("authorized real-schema topology projection", () => {
	test("hidden root and parent identities are replaced by a visible representative", async () => {
		seed("secret", null, { ownerUserId: "other", visibility: "private" });
		seed("visible", "secret", { type: "primary", ownerUserId: "writer", aclRootNarratorId: null });
		seed("visible-child", "visible", {
			type: "primary",
			ownerUserId: "writer",
			aclRootNarratorId: null,
		});
		const graph = await core.getCommunicationTopology(
			{ kind: "narrator", narratorId: "visible" },
			actor,
		);
		const json = JSON.stringify(graph);
		expect(json).not.toContain("secret");
		expect(graph.nodes).toHaveLength(2);
		expect(new Set(graph.nodes.map((n) => n.groupId)).size).toBe(1);
	});
	test("one-hop peers do not leak unreadable nodes or turn into transitive neighbors", async () => {
		seed("a");
		seed("b");
		seed("c");
		seed("private", null, { ownerUserId: "other" });
		core.insertCommunicationPeerTx(db, "a", "b", { userId: "writer", source: "manual" });
		core.insertCommunicationPeerTx(db, "b", "c", { userId: "writer", source: "manual" });
		core.insertCommunicationPeerTx(db, "a", "private", { userId: "admin", source: "manual" });
		const graph = await core.getCommunicationTopology({ kind: "narrator", narratorId: "a" }, actor);
		expect(graph.nodes.map((n) => n.id).sort()).toEqual(["a", "b"]);
		expect(graph.peers).toHaveLength(1);
		expect(JSON.stringify(graph)).not.toContain("private");
	});
	test("team name and work item title stay visible after splitting the communication group", async () => {
		tree();
		db.update(narrators).set({ title: "Release team" }).where(eq(narrators.id, "root")).run();
		sqlite.run(
			"INSERT INTO projects(id,git_path,name,visibility,created_at,updated_at) VALUES ('project','/team','Team','public',?,?)",
			[now, now],
		);
		sqlite.run(
			"INSERT INTO project_teams(narrator_id,project_id,base_branch,created_at,updated_at) VALUES ('root','project','main',?,?)",
			[now, now],
		);
		sqlite.run(
			"INSERT INTO team_work_items(id,team_id,project_id,title,state,worker_narrator_id,created_at,updated_at) VALUES ('work','root','project','Implement','in_progress','child',?,?)",
			[now, now],
		);
		await core.mutateCommunication("child", actor, { kind: "split", version: 1 });
		const graph = await core.getCommunicationTopology(
			{ kind: "team", teamId: "root", projectId: "project" },
			actor,
		);
		const team = { id: "root", name: "Release team" };
		expect(graph.nodes.find((n) => n.id === "root")?.team).toEqual(team);
		expect(graph.nodes.find((n) => n.id === "child")?.team).toEqual({
			...team,
			workItem: { title: "Implement" },
		});
		expect(graph.nodes.find((n) => n.id === "grand")?.team).toEqual(team);
		expect(graph.nodes.find((n) => n.id === "child")?.groupId).toBe("child");
	});
	test("a cross-team peer cannot disclose a hidden team's metadata", async () => {
		seed("local");
		seed("hidden-team", null, { ownerUserId: "other" });
		seed("guest", null, {
			ownerUserId: "writer",
			aclRootNarratorId: "hidden-team",
			type: "primary",
		});
		sqlite.run(
			"INSERT INTO projects(id,git_path,name,visibility,created_at,updated_at) VALUES ('private-project','/hidden','Secret project','private',?,?)",
			[now, now],
		);
		sqlite.run(
			"INSERT INTO project_teams(narrator_id,project_id,base_branch,created_at,updated_at) VALUES ('hidden-team','private-project','main',?,?)",
			[now, now],
		);
		core.insertCommunicationPeerTx(db, "local", "guest", { userId: "writer", source: "manual" });
		const graph = await core.getCommunicationTopology(
			{ kind: "narrator", narratorId: "local" },
			actor,
		);
		expect(graph.nodes.find((n) => n.id === "guest")?.team).toBeUndefined();
		expect(JSON.stringify(graph)).not.toContain("hidden-team");
	});
	test("bounded projection does not bound exact send permission; persistent aliases are narrow", async () => {
		tree();
		db.update(narrators)
			.set({ traits: ["subagent-alias:grand-helper", "private-extra"] })
			.where(eq(narrators.id, "grand"))
			.run();
		const graph = await core.getCommunicationTopology(
			{ kind: "narrator", narratorId: "root" },
			actor,
			{ maxNodes: 1 },
		);
		expect(graph.nodes).toHaveLength(1);
		expect(graph.truncated).toBe(true);
		expect(() => core.assertCommunicationSendAuthorizedTx(db, "grand", "sibling")).not.toThrow();
		const targets = await core.listCommunicationTargets("root");
		expect(targets.find((n) => n.id === "grand")?.aliases).toEqual(["grand-helper"]);
		expect(JSON.stringify(targets)).not.toContain("private-extra");
	});
});
