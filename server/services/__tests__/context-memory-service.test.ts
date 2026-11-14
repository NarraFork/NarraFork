import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { contextMemoryService } = await import("../context-memory-service");
const human = { userId: "memory-user", isAdmin: false, kind: "user" as const };
const agent = { ...human, kind: "agent" as const };
const userScope = { kind: "user" as const };
const proposal = {
	scope: userScope,
	key: "preferred-tests",
	content: "Use isolated tests.",
	expiresAt: null,
};

beforeEach(() => {
	cleanDb(sqlite);
	for (const id of ["memory-user", "other-user"])
		sqlite.run(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, 'hash', 'user', ?)",
			[id, id, new Date().toISOString()],
		);
	sqlite.run(
		"INSERT INTO narrators (id, title, owner_user_id, visibility, write_audience, created_at, updated_at) VALUES ('memory-session', 'source', 'memory-user', 'private', 'owner', ?, ?)",
		[new Date().toISOString(), new Date().toISOString()],
	);
});
afterAll(() => {
	mock.module("../../db", () => realDbModule);
	sqlite.close();
});

describe("confirmed context memory lifecycle", () => {
	test("proposals are not recalled until the owner confirms the exact version", async () => {
		const memory = await contextMemoryService.propose(proposal, human);
		expect(memory.status).toBe("candidate");
		expect(await contextMemoryService.recall(userScope, human)).toEqual([]);
		await expect(
			contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 99 }, human),
		).rejects.toMatchObject({ code: "MEMORY_VERSION_CONFLICT" });
		const confirmed = await contextMemoryService.decide(
			memory.id,
			{ action: "confirm", expectedVersion: 1 },
			human,
		);
		expect(confirmed.status).toBe("confirmed");
		expect(confirmed.version).toBe(2);
		expect((await contextMemoryService.recall(userScope, human)).map((item) => item.id)).toEqual([
			memory.id,
		]);
		expect(
			(await contextMemoryService.events(memory.id, human)).map((event) => event.action),
		).toEqual(["confirm", "propose"]);
	});

	test("agent proposals require real accessible provenance and cannot self-confirm", async () => {
		await expect(contextMemoryService.propose(proposal, agent)).rejects.toThrow(/source/i);
		await expect(
			contextMemoryService.propose({ ...proposal, source: { narratorId: "missing" } }, agent),
		).rejects.toMatchObject({ statusCode: 404 });
		await expect(
			contextMemoryService.propose(
				{ ...proposal, source: { narratorId: "memory-session", messageId: "forged" } },
				agent,
			),
		).rejects.toThrow();
		const memory = await contextMemoryService.propose(
			{ ...proposal, source: { narratorId: "memory-session" } },
			agent,
		);
		await expect(
			contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 1 }, agent),
		).rejects.toThrow(/human|user/i);
		expect(await contextMemoryService.recall(userScope, human)).toEqual([]);
	});

	test("memories stay private even from another administrator and across scopes", async () => {
		const memory = await contextMemoryService.propose(proposal, human);
		await contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 1 }, human);
		const other = { userId: "other-user", isAdmin: true, kind: "user" as const };
		expect(await contextMemoryService.recall(userScope, other)).toEqual([]);
		await expect(contextMemoryService.get(memory.id, other)).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(
			contextMemoryService.decide(memory.id, { action: "archive", expectedVersion: 2 }, other),
		).rejects.toThrow();
		expect(
			await contextMemoryService.recall({ kind: "session", id: "memory-session" }, human),
		).toEqual([]);
	});

	test.each([
		"reject",
		"archive",
	] as const)("%s cannot return a memory body after source access is revoked", async (action) => {
		const memory = await contextMemoryService.propose(
			{ ...proposal, source: { narratorId: "memory-session" } },
			human,
		);
		sqlite.run("UPDATE narrators SET owner_user_id = 'other-user' WHERE id = 'memory-session'");
		await expect(contextMemoryService.get(memory.id, human)).rejects.toMatchObject({
			statusCode: 404,
		});
		await expect(
			contextMemoryService.decide(memory.id, { action, expectedVersion: 1 }, human),
		).rejects.toMatchObject({ statusCode: 404 });
		expect(
			sqlite.query("SELECT status, version FROM context_memories WHERE id = ?").get(memory.id),
		).toEqual({ status: "candidate", version: 1 });
		expect(await contextMemoryService.forget(memory.id, 1, human)).toEqual({ deleted: true });
	});

	test("edits revoke old confirmed content and require confirmation again", async () => {
		const memory = await contextMemoryService.propose(proposal, human);
		await contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 1 }, human);
		await expect(
			contextMemoryService.revise(
				memory.id,
				{ expectedVersion: 2, content: "Agent cannot replace this", expiresAt: null },
				agent,
			),
		).rejects.toThrow();
		const edited = await contextMemoryService.revise(
			memory.id,
			{ expectedVersion: 2, content: "Run focused tests first.", expiresAt: null },
			human,
		);
		expect(edited.status).toBe("candidate");
		expect(edited.version).toBe(3);
		expect(await contextMemoryService.recall(userScope, human)).toEqual([]);
		await contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 3 }, human);
		expect((await contextMemoryService.recall(userScope, human))[0].content).toBe(
			"Run focused tests first.",
		);
	});

	test("rejection, archival, expiry and forgetting remove recall eligibility", async () => {
		for (const action of ["reject", "archive"] as const) {
			const memory = await contextMemoryService.propose({ ...proposal, key: action }, human);
			await contextMemoryService.decide(memory.id, { action, expectedVersion: 1 }, human);
		}
		const expiring = await contextMemoryService.propose(
			{ ...proposal, key: "expiring", expiresAt: "2099-01-01T00:00:00.000Z" },
			human,
		);
		await contextMemoryService.decide(
			expiring.id,
			{ action: "confirm", expectedVersion: 1 },
			human,
		);
		sqlite.run("UPDATE context_memories SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?", [
			expiring.id,
		]);
		expect(await contextMemoryService.recall(userScope, human)).toEqual([]);
		expect((await contextMemoryService.get(expiring.id, human)).effectiveStatus).toBe("expired");
		await contextMemoryService.forget(expiring.id, 2, human);
		await expect(contextMemoryService.get(expiring.id, human)).rejects.toThrow();
	});

	test("scope ACL is rechecked and duplicate normalized keys conflict", async () => {
		const memory = await contextMemoryService.propose(
			{ ...proposal, scope: { kind: "session", id: "memory-session" } },
			human,
		);
		await contextMemoryService.decide(memory.id, { action: "confirm", expectedVersion: 1 }, human);
		sqlite.run("UPDATE narrators SET owner_user_id = 'other-user' WHERE id = 'memory-session'");
		await expect(
			contextMemoryService.recall({ kind: "session", id: "memory-session" }, human),
		).rejects.toThrow();
		await contextMemoryService.propose(proposal, human);
		await expect(
			contextMemoryService.propose({ ...proposal, key: " Preferred-Tests " }, human),
		).rejects.toMatchObject({ code: "MEMORY_KEY_CONFLICT" });
	});

	test("rejects invalid content, expiry and injected authority fields", async () => {
		for (const invalid of [
			{ ...proposal, content: " " },
			{ ...proposal, content: "x".repeat(4097) },
			{ ...proposal, expiresAt: "yesterday" },
			{ ...proposal, expiresAt: "2000-01-01T00:00:00.000Z" },
			{ ...proposal, status: "confirmed" },
			{ ...proposal, ownerUserId: "other-user" },
			{ ...proposal, scope: { kind: "session" } },
		])
			await expect(contextMemoryService.propose(invalid, human)).rejects.toThrow();
	});
});
