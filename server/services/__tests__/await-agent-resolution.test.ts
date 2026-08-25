/**
 * await-agent-resolution.test.ts
 *
 * Covers the fix for: a RUNNING `Await({type:"agent"})` row offered no "open
 * session" action. The child narrator id only reaches the tool call when the tool
 * RETURNS (`metadata.subagentId` / the `<subagent_id>` tag), so for the entire
 * wait — which is exactly when the user wants to look inside the child — every
 * frontend derivation came up empty and hid the menu item.
 *
 * These tests lock the two halves that make the id available earlier:
 *   1. `collectPendingAwaitAgents` — which rows still need resolving (pure).
 *   2. `resolveAwaitAgentNarratorIds` — selector → real narrator id, against a
 *      real roster, including the ambiguity and not-found cases that must resolve
 *      to NOTHING rather than to a guess.
 */

import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	collectPendingAwaitAgents,
	resolveAwaitAgentIdsForToolCalls,
	resolveAwaitAgentNarratorIds,
} = await import("../await-agent-resolution");
const { clearAliasRegistry, registerTaskAlias } = await import("../subagent-alias");

const PARENT_ID = "parent-narrator-000";
const SUB_A = "subagent-aaaaaaaaaaa";
const SUB_B = "subagent-bbbbbbbbbbb";

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

afterEach(() => {
	cleanDb(sqlite);
	clearAliasRegistry(PARENT_ID);
});

async function seedTeam(
	subagents: Array<{ id: string; title?: string | null; traits?: string[] }>,
): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(narrators).values([
		{ id: PARENT_ID, type: "primary", variant: "primary", createdAt: now, updatedAt: now },
		...subagents.map((sub) => ({
			id: sub.id,
			type: "subagent" as const,
			variant: "subagent:general",
			parentNarratorId: PARENT_ID,
			title: sub.title ?? null,
			...(sub.traits ? { traits: sub.traits } : {}),
			createdAt: now,
			updatedAt: now,
		})),
	]);
}

describe("collectPendingAwaitAgents", () => {
	test("selects only agent awaits that carry a selector", () => {
		const pending = collectPendingAwaitAgents([
			{ toolUseId: "t1", toolName: "Await", inputJson: { type: "agent", id: "paper-extract" } },
			// bash await — no session to open
			{ toolUseId: "t2", toolName: "Await", inputJson: { type: "bash", id: "build" } },
			// agent await with no target
			{ toolUseId: "t3", toolName: "Await", inputJson: { type: "agent" } },
			// not an Await at all
			{ toolUseId: "t4", toolName: "Agent", inputJson: { type: "agent", id: "x" } },
		]);
		expect(pending).toEqual([{ toolUseId: "t1", selector: "paper-extract" }]);
	});

	/**
	 * A finished Await already carries the authoritative id, and re-deriving it
	 * could point at a DIFFERENT narrator (a later sibling reusing the same alias).
	 * So a row with persisted metadata must be left alone.
	 */
	test("skips calls whose persisted metadata already knows the id", () => {
		expect(
			collectPendingAwaitAgents([
				{
					toolUseId: "t1",
					toolName: "Await",
					inputJson: { type: "agent", id: "paper-extract" },
					outputJson: { _metadata: { subagentId: SUB_A } },
				},
				{
					toolUseId: "t2",
					toolName: "Await",
					inputJson: { type: "agent", id: "other" },
					outputJson: { _metadata: { resolvedId: SUB_B } },
				},
			]),
		).toEqual([]);
	});

	test("still resolves a completed call whose metadata lacks the id", () => {
		const pending = collectPendingAwaitAgents([
			{
				toolUseId: "t1",
				toolName: "Await",
				inputJson: { type: "agent", id: "paper-extract" },
				outputJson: { _metadata: { status: "timeout" } },
			},
		]);
		expect(pending).toEqual([{ toolUseId: "t1", selector: "paper-extract" }]);
	});

	test("deduplicates repeated toolUseIds", () => {
		const call = {
			toolUseId: "t1",
			toolName: "Await",
			inputJson: { type: "agent", id: "paper-extract" },
		};
		expect(collectPendingAwaitAgents([call, call])).toHaveLength(1);
	});
});

describe("resolveAwaitAgentNarratorIds", () => {
	test("resolves a persisted alias trait", async () => {
		await seedTeam([
			{ id: SUB_A, title: "Extract papers", traits: ["subagent-alias:paper-extract"] },
		]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "paper-extract" },
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});

	test("resolves a slugified title", async () => {
		await seedTeam([{ id: SUB_A, title: "Extract Papers" }]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "extract-papers" },
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});

	test("resolves an exact id and an id prefix", async () => {
		await seedTeam([{ id: SUB_A, title: null }]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: SUB_A },
			{ toolUseId: "t2", selector: SUB_A.slice(0, 8) },
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
		expect(resolved.get("t2")).toBe(SUB_A);
	});

	test("resolves through the in-memory alias registry", async () => {
		await seedTeam([{ id: SUB_A, title: null }]);
		registerTaskAlias(PARENT_ID, SUB_A, "run-tests");
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "run-tests" },
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});

	/**
	 * A detached (background) agent's readable handle lives on `background_tasks`,
	 * which is the fallback the chunked card's own query used.
	 */
	test("resolves a background task alias", async () => {
		await seedTeam([{ id: SUB_A, title: null }]);
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: "task-1",
			parentNarratorId: PARENT_ID,
			type: "agent",
			status: "running",
			subagentNarratorId: SUB_A,
			alias: "detached-worker",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "detached-worker" },
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});

	/**
	 * Guessing one of several candidates would silently navigate the user into the
	 * WRONG session — strictly worse than the item staying hidden.
	 */
	test("resolves nothing for an ambiguous selector", async () => {
		await seedTeam([
			{ id: SUB_A, title: "Extract papers" },
			{ id: SUB_B, title: "Extract papers" },
		]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "extract-papers" },
		]);
		expect(resolved.has("t1")).toBe(false);
	});

	test("resolves nothing for an unknown selector and never throws", async () => {
		await seedTeam([{ id: SUB_A, title: "Extract papers" }]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "nobody-here" },
		]);
		expect(resolved.size).toBe(0);
	});

	test("never matches a subagent belonging to another parent", async () => {
		const now = new Date().toISOString();
		await seedTeam([{ id: SUB_A, title: "Mine" }]);
		await db.insert(narrators).values([
			{
				id: "other-parent-00000000",
				type: "primary",
				variant: "primary",
				createdAt: now,
				updatedAt: now,
			},
			{
				id: SUB_B,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: "other-parent-00000000",
				title: "Theirs",
				createdAt: now,
				updatedAt: now,
			},
		]);
		const resolved = await resolveAwaitAgentNarratorIds(PARENT_ID, [
			{ toolUseId: "t1", selector: "theirs" },
		]);
		expect(resolved.size).toBe(0);
	});

	test("returns empty without querying when there is nothing pending", async () => {
		expect((await resolveAwaitAgentNarratorIds(PARENT_ID, [])).size).toBe(0);
		expect(
			(await resolveAwaitAgentNarratorIds("", [{ toolUseId: "t1", selector: "x" }])).size,
		).toBe(0);
	});
});

describe("resolveAwaitAgentIdsForToolCalls", () => {
	test("resolves against the owning narrator's team", async () => {
		await seedTeam([{ id: SUB_A, title: "Extract papers" }]);
		const resolved = await resolveAwaitAgentIdsForToolCalls([
			{
				toolUseId: "t1",
				toolName: "Await",
				inputJson: { type: "agent", id: "extract-papers" },
				narratorId: PARENT_ID,
			},
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});

	/**
	 * A subagent's Await resolves against its PARENT's roster (its siblings), the
	 * same team scope `getCommunicationScope` defines.
	 */
	test("scopes a subagent's own Await to its parent's roster", async () => {
		await seedTeam([
			{ id: SUB_A, title: "Caller" },
			{ id: SUB_B, title: "Sibling" },
		]);
		const resolved = await resolveAwaitAgentIdsForToolCalls([
			{
				toolUseId: "t1",
				toolName: "Await",
				inputJson: { type: "agent", id: "sibling" },
				narratorId: SUB_A,
			},
		]);
		expect(resolved.get("t1")).toBe(SUB_B);
	});

	test("returns empty when no Await-agent call is present", async () => {
		await seedTeam([{ id: SUB_A, title: "Extract papers" }]);
		const resolved = await resolveAwaitAgentIdsForToolCalls([
			{ toolUseId: "t1", toolName: "Read", inputJson: { file_path: "/a" }, narratorId: PARENT_ID },
		]);
		expect(resolved.size).toBe(0);
	});

	/**
	 * ⚠️ THE SCOPE RULE: "am I a subagent" is decided by `variant`, never by the
	 * presence of `parentNarratorId`.
	 *
	 * A FORKED primary narrator carries a `parentNarratorId` (the narrator it was
	 * forked from) while its OWN subagents are parented to itself. Reading that
	 * link as "I am a subagent" sends the lookup to the fork source's roster, where
	 * the target does not exist — so a running Await on a forked narrator's own
	 * child silently loses its "open session" item.
	 *
	 * Measured on a real database this single mistake cost 131 of 2082 resolvable
	 * Await-agent calls. It has no error signal, hence this test.
	 */
	test("a forked primary resolves against its OWN roster, not the fork source's", async () => {
		const now = new Date().toISOString();
		const FORK_SOURCE = "fork-source-narrator";
		const FORKED = "forked-primary-narra";
		const DECOY = "decoy-subagent-00000";
		await db.insert(narrators).values([
			{ id: FORK_SOURCE, type: "primary", variant: "primary", createdAt: now, updatedAt: now },
			// The forked narrator is PRIMARY but has a parent link.
			{
				id: FORKED,
				type: "primary",
				variant: "primary",
				parentNarratorId: FORK_SOURCE,
				createdAt: now,
				updatedAt: now,
			},
			// Its own child, parented to it.
			{
				id: SUB_A,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: FORKED,
				title: "Compare runtime build",
				createdAt: now,
				updatedAt: now,
			},
			// A same-named child of the FORK SOURCE. If the scope were taken from
			// parentNarratorId, the lookup would land here — returning the wrong
			// session rather than none, which is worse than a hidden menu item.
			{
				id: DECOY,
				type: "subagent",
				variant: "subagent:general",
				parentNarratorId: FORK_SOURCE,
				title: "Compare runtime build",
				createdAt: now,
				updatedAt: now,
			},
		]);

		const resolved = await resolveAwaitAgentIdsForToolCalls([
			{
				toolUseId: "t1",
				toolName: "Await",
				inputJson: { type: "agent", id: "compare-runtime-build" },
				narratorId: FORKED,
			},
		]);
		expect(resolved.get("t1")).toBe(SUB_A);
	});
});
