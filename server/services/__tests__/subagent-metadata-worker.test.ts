import { afterAll, afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb } from "../../../tests/setup";
import { narratorMessages, narrators } from "../../db/schema";
import * as reads from "../../db/worker-read";
import * as pool from "../../lib/db-worker/pool";
import { captureWorkerRejection, getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const aliases = await import("../subagent-alias");
const labels = await import("../subagent-label");
const { resolveSubagentModelInheritance } = await import("../subagent-model");
const { getRecentSubagentToolActivity } = await import("../subagent-activity");
const { resolveSpawningToolUseId } = await import("../subagent-takeover-broadcast");
const {
	clearTeamFileChanges,
	getPersistedTeamFileChanges,
	getTeamFileChanges,
	recordTeamFileChange,
} = await import("../subagent-team");

afterAll(async () => {
	mock.module("../../db", () => realDb);
	await fixture.close();
});
beforeEach(() => {
	cleanDb(sqlite);
	aliases.clearAliasRegistry("parent");
	labels.clearAgentLabelMemo();
	clearTeamFileChanges("parent");
	db.insert(narrators)
		.values([
			{ id: "parent", createdAt: "now", updatedAt: "now" },
			{ id: "other", createdAt: "now", updatedAt: "now" },
			{
				id: "child",
				parentNarratorId: "parent",
				traits: ["original"],
				createdAt: "now",
				updatedAt: "now",
			},
		])
		.run();
});
afterEach(() => mock.restore());

test("alias persistence preserves traits and only publishes the registry after commit", async () => {
	expect(await aliases.registerAndPersistSubagentAlias("parent", "child", "Read Files")).toEqual({
		alias: "read-files",
		conflicted: false,
	});
	expect(
		db.select({ traits: narrators.traits }).from(narrators).where(eq(narrators.id, "child")).get()
			?.traits,
	).toEqual(["original", "subagent-alias:read-files"]);
	expect(aliases.getTaskAlias("parent", "child")).toBe("read-files");
	await aliases.persistSubagentAlias("parent", "missing", "ignored");
	await aliases.persistSubagentAlias("other", "child", "ignored");
	expect(await labels.resolveAgentLabel("parent", "child")).toBe("read-files");
});

for (const mutation of ["traits", "parent", "deleted", "sibling"] as const) {
	test(`a concurrent ${mutation} change cannot be overwritten by alias persistence`, async () => {
		const original = reads.readQueryFirst;
		let injected = false;
		spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const row = await original(query, options);
			if (!injected && row && typeof row === "object" && "traits" in row) {
				injected = true;
				if (mutation === "deleted") db.delete(narrators).where(eq(narrators.id, "child")).run();
				else if (mutation === "sibling")
					db.insert(narrators)
						.values({
							id: "sibling",
							parentNarratorId: "parent",
							traits: ["subagent-alias:chosen"],
							createdAt: "now",
							updatedAt: "now",
						})
						.run();
				else
					db.update(narrators)
						.set(mutation === "traits" ? { traits: ["newer"] } : { parentNarratorId: "other" })
						.where(eq(narrators.id, "child"))
						.run();
			}
			return row;
		});
		const error = await captureWorkerRejection(
			aliases.persistSubagentAlias("parent", "child", "chosen"),
		);
		expect(injected).toBe(true);
		expect(error).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
		const current = db.select().from(narrators).where(eq(narrators.id, "child")).get();
		expect(current?.traits ?? []).not.toContain("subagent-alias:chosen");
		if (mutation === "traits") expect(current?.traits).toEqual(["newer"]);
		if (mutation === "parent") expect(current?.parentNarratorId).toBe("other");
		if (mutation === "deleted") expect(current).toBeUndefined();
	});
}

test("unified primary tasks retain render-only aliases without rewriting narrator membership", async () => {
	db.update(narrators)
		.set({ parentNarratorId: null, type: "primary" })
		.where(eq(narrators.id, "child"))
		.run();
	expect(await aliases.registerAndPersistSubagentAlias("parent", "child", "chosen")).toEqual({
		alias: "chosen",
		conflicted: false,
	});
	expect(aliases.getTaskAlias("parent", "child")).toBe("chosen");
	expect(
		db.select({ traits: narrators.traits }).from(narrators).where(eq(narrators.id, "child")).get()
			?.traits,
	).toEqual(["original"]);
});

test("a failed alias write never installs an in-memory selector", async () => {
	aliases.setSubagentAliasPersistenceAdapterForTests({
		getExistingAlias: async () => undefined,
		getTakenAliases: async () => new Set(),
		persistAlias: async () => {
			throw new Error("write failed");
		},
	});
	try {
		expect(
			await captureWorkerRejection(
				aliases.registerAndPersistSubagentAlias("parent", "child", "chosen"),
			),
		).toMatchObject({ message: "write failed" });
		expect(aliases.getTaskAlias("parent", "child")).toBeUndefined();
	} finally {
		aliases.setSubagentAliasPersistenceAdapterForTests();
	}
});

for (const failure of ["creation failure", "crash", "timeout", "disabled"])
	test(`Worker ${failure} never runs alias, team, activity or model reads locally, and cosmetic failures are not cached`, async () => {
		const message = `injected Worker ${failure}`;
		const worker = spyOn(pool, "runReadTask").mockRejectedValue(new Error(message));
		const query = spyOn(sqlite, "query");
		expect(
			await captureWorkerRejection(aliases.persistSubagentAlias("parent", "child", "chosen")),
		).toMatchObject({ message });
		expect(await captureWorkerRejection(getRecentSubagentToolActivity("child"))).toMatchObject({
			message,
		});
		expect(
			await captureWorkerRejection(
				resolveSubagentModelInheritance({ policySourceNarratorId: "parent" }),
			),
		).toMatchObject({ message });
		expect(await captureWorkerRejection(getPersistedTeamFileChanges("parent"))).toMatchObject({
			message,
		});
		expect(
			await captureWorkerRejection(recordTeamFileChange("parent", "child", "unknown.ts")),
		).toMatchObject({ message });
		expect(await labels.resolveAgentLabel("parent", "child")).toBe("child");
		expect(await resolveSpawningToolUseId("child")).toBeUndefined();
		expect(query).not.toHaveBeenCalled();
		query.mockRestore();
		worker.mockRestore();
		db.update(narrators)
			.set({ traits: ["subagent-alias:recovered"] })
			.where(eq(narrators.id, "child"))
			.run();
		expect(await labels.resolveAgentLabel("parent", "child")).toBe("recovered");
	});

test("takeover hints resolve the spawning tool without loading message payloads", async () => {
	expect(await resolveSpawningToolUseId("child")).toBeUndefined();
	db.insert(narratorMessages)
		.values({
			id: "spawn",
			narratorId: "child",
			role: "user",
			contentJson: [],
			parentToolUseId: "spawning-tool",
			createdAt: "now",
		})
		.run();
	expect(await resolveSpawningToolUseId("child")).toBe("spawning-tool");
});

test("registration cannot overwrite an alias published while sibling aliases were being read", async () => {
	const original = reads.readQuery;
	let injected = false;
	spyOn(reads, "readQuery").mockImplementation((async (query, options) => {
		const rows = await original(query as Parameters<typeof reads.readQuery>[0], options);
		if (!injected) {
			injected = true;
			db.update(narrators)
				.set({ traits: ["original", "subagent-alias:newer"] })
				.where(eq(narrators.id, "child"))
				.run();
		}
		return rows;
	}) as typeof reads.readQuery);
	expect(
		await captureWorkerRejection(
			aliases.registerAndPersistSubagentAlias("parent", "child", "chosen"),
		),
	).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
	expect(injected).toBe(true);
	expect(
		db.select({ traits: narrators.traits }).from(narrators).where(eq(narrators.id, "child")).get()
			?.traits,
	).toEqual(["original", "subagent-alias:newer"]);
	expect(aliases.getTaskAlias("parent", "child")).toBeUndefined();
});

test("team observations wait for committed membership and never treat primary forks as subagents", async () => {
	await recordTeamFileChange("parent", "child", "not-a-subagent.ts");
	expect(getTeamFileChanges("parent").size).toBe(0);
	db.update(narrators)
		.set({ type: "subagent", variant: "subagent:worker" })
		.where(eq(narrators.id, "child"))
		.run();
	await recordTeamFileChange("parent", "child", "a.ts");
	expect(getTeamFileChanges("parent").get("child")?.size).toBe(1);
	expect((await getPersistedTeamFileChanges("parent", "child")).get("child")?.size).toBe(1);
});

for (const mutation of ["parent", "identity", "deleted"] as const)
	test(`team observations cannot publish a stale ${mutation} membership`, async () => {
		db.update(narrators)
			.set({ type: "subagent", variant: "subagent:worker" })
			.where(eq(narrators.id, "child"))
			.run();
		const original = reads.readQueryFirst;
		let injected = false;
		spyOn(reads, "readQueryFirst").mockImplementation(async (query, options) => {
			const row = await original(query, options);
			if (!injected) {
				injected = true;
				if (mutation === "deleted") db.delete(narrators).where(eq(narrators.id, "child")).run();
				else
					db.update(narrators)
						.set(
							mutation === "parent"
								? { parentNarratorId: "other" }
								: { type: "primary", variant: "primary" },
						)
						.where(eq(narrators.id, "child"))
						.run();
			}
			return row;
		});
		expect(
			await captureWorkerRejection(recordTeamFileChange("parent", "child", "stale.ts")),
		).toMatchObject({ code: "RUNTIME_READ_CONFLICT", statusCode: 409 });
		expect(injected).toBe(true);
		expect(getTeamFileChanges("parent").size).toBe(0);
	});

test("empty activity and label sources stay empty, and cancellation/deadline budgets reach Worker admission", async () => {
	expect(await getRecentSubagentToolActivity("missing")).toEqual([]);
	expect(await labels.resolveAgentLabel("parent", "missing-123")).toBe("missing-");
	const controller = new AbortController();
	controller.abort();
	const query = spyOn(sqlite, "query");
	for (const options of [{ signal: controller.signal }, { deadlineAt: Date.now() - 1 }]) {
		expect(
			await captureWorkerRejection(
				aliases.persistSubagentAlias("parent", "child", "chosen", options),
			),
		).toBeInstanceOf(Error);
		expect(
			await captureWorkerRejection(getRecentSubagentToolActivity("child", 3, options)),
		).toBeInstanceOf(Error);
		expect(
			await captureWorkerRejection(
				resolveSubagentModelInheritance(
					{ policySourceNarratorId: "parent" },
					undefined,
					0,
					options,
				),
			),
		).toBeInstanceOf(Error);
		expect(
			await captureWorkerRejection(getPersistedTeamFileChanges("parent", undefined, options)),
		).toBeInstanceOf(Error);
	}
	expect(query).not.toHaveBeenCalled();
});
