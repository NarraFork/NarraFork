/**
 * subagent-label.test.ts — the label an agent is named by, everywhere.
 *
 * The bug this closes: aliases existed but only the Agent tool used them, so
 * Await/Send/TeamStatus/background notifications printed the raw 21-char nanoid
 * and the model learned to address agents by gibberish. These tests pin the
 * resolution order and, importantly, that the fallback is never the FULL id —
 * a long nanoid in model-facing text is the defect, so even the last resort is
 * shortened.
 */

import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { eq } from "drizzle-orm";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { backgroundTasks, narrators } from "../../db/schema";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const {
	agentLabelFromNarrator,
	agentResultTag,
	clearAgentLabelMemo,
	resolveAgentLabel,
	shortAgentId,
} = await import("../subagent-label");
const { clearAliasRegistry, registerTaskAlias, SUBAGENT_ALIAS_TRAIT_PREFIX } = await import(
	"../subagent-alias"
);

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

const PARENT = "label-parent";
const OTHER_PARENT = "label-other-parent";
const AGENT_ID = "UscgG1vLFnxzyKyaUOIfR";

beforeEach(() => {
	clearAgentLabelMemo();
	clearAliasRegistry(PARENT);
	clearAliasRegistry(OTHER_PARENT);
});

afterEach(() => {
	cleanDb(sqlite);
	clearAgentLabelMemo();
	clearAliasRegistry(PARENT);
	clearAliasRegistry(OTHER_PARENT);
});

/** The subagent row's parent must exist (FK), so seed it on demand. */
async function seedParent(id: string): Promise<void> {
	const existing = await db.query.narrators.findFirst({ where: eq(narrators.id, id) });
	if (existing) return;
	const now = new Date().toISOString();
	await db
		.insert(narrators)
		.values({ id, type: "primary", variant: "primary", createdAt: now, updatedAt: now });
}

async function seedNarrator(
	id: string,
	over: { title?: string | null; traits?: unknown; parentNarratorId?: string } = {},
): Promise<void> {
	const parentNarratorId = over.parentNarratorId ?? PARENT;
	await seedParent(parentNarratorId);
	const now = new Date().toISOString();
	await db.insert(narrators).values({
		id,
		type: "subagent",
		variant: "subagent:general",
		parentNarratorId,
		title: over.title ?? null,
		...(over.traits !== undefined ? { traits: over.traits as string[] } : {}),
		createdAt: now,
		updatedAt: now,
	});
}

describe("agentLabelFromNarrator (row in hand, no I/O)", () => {
	test("prefers the in-memory registry for the scope", () => {
		registerTaskAlias(PARENT, AGENT_ID, "map the providers");
		expect(agentLabelFromNarrator({ id: AGENT_ID, title: "Other title" }, PARENT)).toBe(
			"map-the-providers",
		);
	});

	test("falls back to the persisted alias trait when the registry is cold", () => {
		// This is the post-restart case: the registry is gone, the trait is not.
		expect(
			agentLabelFromNarrator(
				{
					id: AGENT_ID,
					title: "Some title",
					traits: ["background", `${SUBAGENT_ALIAS_TRAIT_PREFIX}run-tests`],
				},
				PARENT,
			),
		).toBe("run-tests");
	});

	test("falls back to a slugified title when there is no alias anywhere", () => {
		expect(agentLabelFromNarrator({ id: AGENT_ID, title: "Inspect Lease Path" })).toBe(
			"inspect-lease-path",
		);
	});

	test("last resort is a SHORT id, never the full nanoid", () => {
		const label = agentLabelFromNarrator({ id: AGENT_ID });
		expect(label).toBe(shortAgentId(AGENT_ID));
		expect(label).not.toBe(AGENT_ID);
		expect(label.length).toBeLessThan(AGENT_ID.length);
	});

	test("does not leak another parent's alias", () => {
		registerTaskAlias(OTHER_PARENT, AGENT_ID, "someone elses worker");
		// Scoped to PARENT, so the OTHER_PARENT registration must not match.
		expect(agentLabelFromNarrator({ id: AGENT_ID }, PARENT)).toBe(shortAgentId(AGENT_ID));
	});
});

describe("resolveAgentLabel (only an id in hand)", () => {
	test("reads the alias trait from the database", async () => {
		await seedNarrator(AGENT_ID, {
			title: "ignored when an alias exists",
			traits: [`${SUBAGENT_ALIAS_TRAIT_PREFIX}build-frontend`],
		});
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("build-frontend");
	});

	test("falls back to the title when the narrator has no alias trait", async () => {
		await seedNarrator(AGENT_ID, { title: "Trace The Providers" });
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("trace-the-providers");
	});

	test("falls back to the background task alias when the narrator offers nothing", async () => {
		// An agent task row shares the subagent's id, which is why this lookup works.
		await seedNarrator(AGENT_ID);
		const now = new Date().toISOString();
		await db.insert(backgroundTasks).values({
			id: AGENT_ID,
			parentNarratorId: PARENT,
			type: "agent",
			status: "running",
			alias: "detached-worker",
			startedAt: now,
			createdAt: now,
			updatedAt: now,
		});
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("detached-worker");
	});

	test("an unknown id degrades to a short id instead of throwing", async () => {
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe(shortAgentId(AGENT_ID));
	});

	test("the registry short-circuits before any query", async () => {
		registerTaskAlias(PARENT, AGENT_ID, "already-known");
		// No narrator row exists, so a DB-only path would have returned the short id.
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("already-known");
	});

	test("memoizes an alias so a polling Await does not re-query", async () => {
		// Aliases are the cacheable case: traits are never rewritten in place.
		await seedNarrator(AGENT_ID, { traits: [`${SUBAGENT_ALIAS_TRAIT_PREFIX}run-tests`] });
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("run-tests");

		// Remove the source of truth; a memo hit still answers.
		await db.update(narrators).set({ traits: [] }).where(eq(narrators.id, AGENT_ID));
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("run-tests");

		clearAgentLabelMemo();
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe(shortAgentId(AGENT_ID));
	});

	// A title is mutable (PATCH /narrators/:id/title, chapter title sync). Caching a
	// title-derived label meant a renamed subagent kept being PRINTED under its old
	// slug — and that slug matches nothing, so the model was handed a selector that
	// fails with "No accessible subagent found".
	test("does NOT memoize a title-derived label, so a rename takes effect", async () => {
		await seedNarrator(AGENT_ID, { title: "Original Name" });
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("original-name");

		await db.update(narrators).set({ title: "Renamed Thing" }).where(eq(narrators.id, AGENT_ID));
		// No clearAgentLabelMemo() here — that is the point.
		expect(await resolveAgentLabel(PARENT, AGENT_ID)).toBe("renamed-thing");
	});

	test("an empty id resolves to an empty label rather than querying", async () => {
		expect(await resolveAgentLabel(PARENT, "")).toBe("");
	});
});

describe("agentResultTag", () => {
	test("wraps the readable label, not a nanoid", () => {
		expect(agentResultTag("run-tests")).toBe("<subagent_id>run-tests</subagent_id>\n\n");
	});
});
