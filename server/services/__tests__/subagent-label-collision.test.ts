/**
 * subagent-label-collision.test.ts — a label must never route to the WRONG agent.
 *
 * The round-trip suite proves each label resolves back to its own subagent when it
 * is unique. This one attacks the opposite case: two subagents whose labels could
 * coincide. The acceptable outcomes are "resolves to the right one" or "raises an
 * ambiguity error"; silently delivering to the other agent is not, because the
 * caller would be told the Send succeeded while another agent got the work.
 *
 * The collision is reachable in practice: `agentLabelFromNarrator`'s title-slug
 * tier does NOT consult the taken-alias set (only `registerAndPersistSubagentAlias`
 * does), so two subagents launched with the same `description` are labelled alike.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { resolveSubagentTargets } = await import("../agent-communication");
const { agentLabelFromNarrator, clearAgentLabelMemo } = await import("../subagent-label");
const { clearAliasRegistry, registerTaskAlias } = await import("../subagent-alias");

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const PARENT = "collision-parent";
const A = "AaaaAaaaAaaaAaaaAaaa1";
const B = "BbbbBbbbBbbbBbbbBbbb2";

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

async function resolve(selector: string): Promise<string[] | Error> {
	return resolveSubagentTargets({ callerNarratorId: PARENT, id: selector })
		.then((targets) => targets.map((target) => target.id))
		.catch((err: Error) => err);
}

describe("two subagents that would share a label", () => {
	test("identical titles collide into one label, and resolution refuses to guess", async () => {
		// Same `description` twice is an ordinary thing for a model to do when it
		// fans out, so this is the realistic collision.
		await seed(A, { title: "Trace Providers" });
		await seed(B, { title: "Trace Providers" });

		const rowA = { id: A, title: "Trace Providers", traits: [] };
		const rowB = { id: B, title: "Trace Providers", traits: [] };
		expect(agentLabelFromNarrator(rowA, PARENT)).toBe(agentLabelFromNarrator(rowB, PARENT));

		// The ambiguity must surface as an error rather than an arbitrary pick.
		const outcome = await resolve("trace-providers");
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toMatch(/Ambiguous subagent target/);
	});

	test("a registered alias disambiguates and wins over a colliding title slug", async () => {
		// Once one of them has a real alias, its label differs and BOTH stay reachable:
		// the aliased one by its alias, the other by its (now unique) title slug.
		await seed(A, { title: "Trace Providers", traits: ["subagent-alias:trace-a"] });
		await seed(B, { title: "Other Work" });

		expect(
			agentLabelFromNarrator(
				{ id: A, title: "Trace Providers", traits: ["subagent-alias:trace-a"] },
				PARENT,
			),
		).toBe("trace-a");
		await expect(resolve("trace-a")).resolves.toEqual([A]);
		await expect(resolve("other-work")).resolves.toEqual([B]);
	});

	test("the in-memory registry wins over another agent's title slug, not silently mis-routing", async () => {
		// A's registry alias is literally B's title slug. This is the nastiest shape:
		// one string that two agents both have a claim to.
		await seed(A, { title: null });
		await seed(B, { title: "Shared Name" });
		registerTaskAlias(PARENT, A, "shared name");

		expect(agentLabelFromNarrator({ id: A, title: null }, PARENT)).toBe("shared-name");

		// Whatever it resolves to, it must be ONE of the two claimants and must be
		// deterministic — never a third party, and never a silent success against an
		// agent that has no claim to the name.
		const outcome = await resolve("shared-name");
		if (outcome instanceof Error) {
			expect(outcome.message).toMatch(/Ambiguous subagent target/);
		} else {
			expect(outcome).toHaveLength(1);
			expect([A, B]).toContain(outcome[0]);
			// The registry is the more specific claim, so it is the expected winner.
			expect(outcome).toEqual([A]);
		}
	});

	test("a label never reaches an agent under a different parent", async () => {
		// Cross-team leakage would be the worst misroute: work delivered outside the
		// caller's own team.
		const now = new Date().toISOString();
		await db.insert(narrators).values({
			id: "other-parent",
			type: "primary",
			variant: "primary",
			createdAt: now,
			updatedAt: now,
		});
		await seed(A, { title: "Mine" });
		await db.insert(narrators).values({
			id: B,
			type: "subagent",
			variant: "subagent:general",
			parentNarratorId: "other-parent",
			title: "Theirs",
			createdAt: now,
			updatedAt: now,
		});

		await expect(resolve("mine")).resolves.toEqual([A]);
		const outcome = await resolve("theirs");
		expect(outcome).toBeInstanceOf(Error);
		expect((outcome as Error).message).toMatch(/No accessible subagent found/);
	});
});
