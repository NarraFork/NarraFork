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
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { resolveSubagentTargets } = await import("../agent-communication");
const { agentLabelFromNarrator } = await import("../subagent-label");
const { clearAgentLabelMemo } = await import("../subagent-label");
const { clearAliasRegistry, registerTaskAlias } = await import("../subagent-alias");

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
