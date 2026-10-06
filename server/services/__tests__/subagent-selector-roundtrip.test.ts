/**
 * subagent-selector-roundtrip.test.ts — every label we print is a label we accept.
 *
 * The hazard this closes is asymmetry, not formatting. Now that Await/Send/
 * TeamStatus/notifications all name agents by alias, the model reads a label and
 * passes THAT back as a selector. Any path that resolves selectors by exact id
 * would then fail on the very name it just printed — and fail in the worst way,
 * as "no accessible subagent found" for an agent that plainly exists.
 *
 * So this walks the four label forms `agentLabelFromNarrator` can produce
 * (registry alias, trait alias, title slug, short id) and asserts each resolves
 * back to the same narrator through the shared resolver that Send, Await,
 * ContextAsk and TeamStatus all use.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";
import { narratorTraitsLock } from "../../lib/async-mutex";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { resolveSubagentTargets, awaitAgentResultDetailed } = await import("../agent-communication");
const { agentLabelFromNarrator } = await import("../subagent-label");
const { clearAgentLabelMemo } = await import("../subagent-label");
const { clearAliasRegistry, registerTaskAlias, registerAndPersistSubagentAlias } = await import(
	"../subagent-alias"
);

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const PARENT = "roundtrip-parent";

beforeEach(() => {
	clearAliasRegistry(PARENT);
	clearAgentLabelMemo();
});

afterEach(() => {
	cleanDb(sqlite);
	clearAliasRegistry(PARENT);
	clearAgentLabelMemo();
});

async function seed(
	id: string,
	over: { title?: string | null; traits?: string[] } = {},
): Promise<void> {
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id: PARENT, type: "primary", variant: "primary", createdAt: now, updatedAt: now })
		.onConflictDoNothing();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId: PARENT,
		title: over.title ?? null,
		...(over.traits ? { traits: over.traits } : {}),
		createdAt: now,
		updatedAt: now,
	});
}

/** The label the model would see, then what that label resolves back to. */
async function roundTrip(id: string): Promise<{ label: string; resolvedIds: string[] }> {
	const row = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	const label = agentLabelFromNarrator(row as NonNullable<typeof row>, PARENT);
	const targets = await resolveSubagentTargets({ callerNarratorId: PARENT, id: label });
	return { label, resolvedIds: targets.map((target) => target.id) };
}

const NANOID = "UscgG1vLFnxzyKyaUOIfR";

describe("a printed label is always an accepted selector", () => {
	test("registry alias (the Agent-tool case)", async () => {
		await seed(NANOID, { title: "Ignored once an alias exists" });
		registerTaskAlias(PARENT, NANOID, "map the providers");
		const { label, resolvedIds } = await roundTrip(NANOID);
		expect(label).toBe("map-the-providers");
		expect(resolvedIds).toEqual([NANOID]);
	});

	test("persisted trait alias (the post-restart case)", async () => {
		await seed(NANOID, { title: "Other", traits: ["subagent-alias:run-tests"] });
		const { label, resolvedIds } = await roundTrip(NANOID);
		expect(label).toBe("run-tests");
		expect(resolvedIds).toEqual([NANOID]);
	});

	test("title slug (no alias anywhere)", async () => {
		await seed(NANOID, { title: "Map The Providers" });
		const { label, resolvedIds } = await roundTrip(NANOID);
		expect(label).toBe("map-the-providers");
		expect(resolvedIds).toEqual([NANOID]);
	});

	// The riskiest form: it is not an alias at all, just a prefix. It resolves only
	// because `subagentMatchesSelector` accepts `id.startsWith(selector)` — which is
	// exactly why the fallback must stay a PREFIX and never a hash or a lowercased id.
	test("short-id fallback (untitled, no alias)", async () => {
		await seed(NANOID);
		const { label, resolvedIds } = await roundTrip(NANOID);
		expect(label).toBe("UscgG1vL");
		expect(NANOID.startsWith(label)).toBe(true);
		expect(resolvedIds).toEqual([NANOID]);
	});

	test("the full id keeps working, so older transcripts do not break", async () => {
		await seed(NANOID, { title: "Map The Providers" });
		const targets = await resolveSubagentTargets({ callerNarratorId: PARENT, id: NANOID });
		expect(targets.map((target) => target.id)).toEqual([NANOID]);
	});
});

describe("recovered subagents retain their original selectors", () => {
	test("re-registering with the title after cleanup preserves the original alias", async () => {
		const title = "核实法线实际调用阶段";
		await seed(NANOID, { title, traits: ["background"] });
		await registerAndPersistSubagentAlias(PARENT, NANOID, "normal-stage-audit");

		// A failed parent turn clears the registry before recovery registers by title.
		clearAliasRegistry(PARENT);
		const restored = await registerAndPersistSubagentAlias(PARENT, NANOID, title);
		expect(restored).toEqual({ alias: "normal-stage-audit", conflicted: false });

		await db
			.update(narrators)
			.set({ isBackground: true, backgroundStatus: "completed", backgroundResult: "audit result" })
			.where(eq(narrators.id, NANOID));
		// Exercise the resolver used by Await/Send with both warm and cold registries.
		for (const cold of [false, true]) {
			if (cold) clearAliasRegistry(PARENT);
			const targets = await resolveSubagentTargets({
				callerNarratorId: PARENT,
				id: "normal-stage-audit",
			});
			expect(targets.map((target) => target.id)).toEqual([NANOID]);
			const result = await awaitAgentResultDetailed({
				callerNarratorId: PARENT,
				id: "normal-stage-audit",
				signal: new AbortController().signal,
			});
			expect(result).toMatchObject({
				id: NANOID,
				label: "normal-stage-audit",
				status: "completed",
				output: "audit result",
			});
			expect(await roundTrip(NANOID)).toEqual({
				label: "normal-stage-audit",
				resolvedIds: [NANOID],
			});
		}
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, NANOID) });
		expect(row?.traits).toEqual(["background", "subagent-alias:normal-stage-audit"]);
	});

	test.each([NANOID, null])("recovers a task-only alias (child reference: %s)", async (childId) => {
		await seed(NANOID, { title: "核实法线实际调用阶段" });
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: NANOID,
			parentNarratorId: PARENT,
			type: "agent",
			status: "failed",
			subagentNarratorId: childId,
			alias: "normal-stage-audit",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		expect(await registerAndPersistSubagentAlias(PARENT, NANOID, "恢复时的标题")).toEqual({
			alias: "normal-stage-audit",
			conflicted: false,
		});
		clearAliasRegistry(PARENT);
		expect(await roundTrip(NANOID)).toEqual({
			label: "normal-stage-audit",
			resolvedIds: [NANOID],
		});
	});

	test("persisted aliases still participate in collision checks", async () => {
		await seed(NANOID, { traits: ["subagent-alias:worker"] });
		await seed("other-worker", { traits: ["subagent-alias:worker"] });
		expect(await registerAndPersistSubagentAlias(PARENT, NANOID, "new title")).toEqual({
			alias: "worker-2",
			conflicted: true,
		});
		clearAliasRegistry(PARENT);
		expect((await roundTrip(NANOID)).resolvedIds).toEqual([NANOID]);
	});

	test("recovery does not make the original alias accessible to another team", async () => {
		await seed(NANOID, { traits: ["subagent-alias:normal-stage-audit"] });
		await registerAndPersistSubagentAlias(PARENT, NANOID, "恢复时的标题");
		clearAliasRegistry(PARENT);
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: "other-parent",
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		});
		await expect(
			resolveSubagentTargets({ callerNarratorId: "other-parent", id: "normal-stage-audit" }),
		).rejects.toThrow(/No accessible subagent found/);
	});

	test("alias persistence waits for concurrent trait edits without losing them", async () => {
		await seed(NANOID);
		const { persistSubagentAlias } = await import("../subagent-alias");
		let persistence: Promise<void> | undefined;
		let completed = false;
		await narratorTraitsLock.acquire(NANOID, async () => {
			persistence = persistSubagentAlias(PARENT, NANOID, "normal-stage-audit").then(() => {
				completed = true;
			});
			// Let the asynchronous DB import settle while another trait writer owns the lock.
			await new Promise((resolve) => setTimeout(resolve, 10));
			expect(completed).toBe(false);
			await db
				.update(narrators)
				.set({ traits: ["background"] })
				.where(eq(narrators.id, NANOID));
		});
		await persistence;
		const row = await db.query.narrators.findFirst({ where: eq(narrators.id, NANOID) });
		expect(row?.traits).toEqual(["background", "subagent-alias:normal-stage-audit"]);
	});
});

describe("ambiguity is reported, not silently mis-resolved", () => {
	test("two subagents sharing a short-id prefix raise an ambiguous-target error", async () => {
		// Prefix matching is what makes the short-id fallback work, so its failure mode
		// has to be a clear error rather than an arbitrary pick.
		await seed("SamePrefix0000000001", { title: null });
		await seed("SamePrefix0000000002", { title: null });
		await expect(
			resolveSubagentTargets({ callerNarratorId: PARENT, id: "SamePref" }),
		).rejects.toThrow(/Ambiguous subagent target/);
	});

	test("the ambiguity message leads with labels and shortened ids", async () => {
		await seed("SamePrefix0000000001", { title: "First Worker" });
		await seed("SamePrefix0000000002", { title: "Second Worker" });
		const error = await resolveSubagentTargets({
			callerNarratorId: PARENT,
			id: "SamePref",
		}).catch((err: Error) => err);
		const message = (error as Error).message;
		expect(message).toContain("first-worker");
		expect(message).toContain("second-worker");
		// Full nanoids must not reappear in the disambiguation prompt.
		expect(message).not.toContain("SamePrefix0000000001");
	});
});
