/**
 * subagent-injection.test.ts — `deliverInjection` when the recipient is a SUBAGENT.
 *
 * Before this, structured injection could only ever write a TOP-LEVEL row, because the
 * two persistence entry points it uses did not accept a `parentToolUseId` at all. A
 * subagent's rows live in a tool_use subtree, so "notify this subagent" had no spelling
 * that put the row where the subagent's own conversation is — the row landed as a
 * top-level row on the subagent narrator instead, and the parent's tool card never
 * learned about it.
 *
 * What the placement has to satisfy is a THREE-WAY constraint, and the value of these
 * tests is that they pin all three against the real readers rather than against the
 * write call:
 *
 *   1. the subagent's own page must LOAD the row (its loader deliberately drops the
 *      `isNull(parentToolUseId)` filter);
 *   2. the model must NOT receive it as a child row (every provider's `buildHistory`
 *      filters `!m.parentToolUseId`) — while a subagent's OWN history loader clears the
 *      field first, so the same row does reach the model there. Those two are easy to
 *      confuse and only one of them is a bug;
 *   3. both pages must be told: the parent's copy keeps the linking field, the
 *      subagent's copy has it stripped.
 *
 * The primary-narrator path is asserted in the same file on purpose: the whole claim of
 * the change is that opening this seam did not move the default.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// Captured before the mock lands: `mock.module` is process-wide, so leaving the
// in-memory schema installed would hand it to every later file in the same run.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

/**
 * Broadcasts are the assertion subject here, so they are RECORDED rather than
 * silenced. The real module is spread: a partial replacement removes every export the
 * stub omits for the rest of the process, which previously broke sibling suites that
 * import `broadcastToUser`.
 */
const realNarratorWs = { ...(await import("../../websocket/narrator-ws")) };
interface Broadcast {
	narratorId: string;
	// biome-ignore lint/suspicious/noExplicitAny: frames are dynamic JSON
	message: any;
}
const broadcasts: Broadcast[] = [];
mock.module("../../websocket/narrator-ws", () => ({
	...realNarratorWs,
	// biome-ignore lint/suspicious/noExplicitAny: frames are dynamic JSON
	broadcastToNarrator: (narratorId: string, message: any) => {
		broadcasts.push({ narratorId, message });
	},
}));

const { deliverInjection, setInjectionScheduler } = await import("../narrator-injection");
const { narratorMessageQueries } = await import("../narrator-messages");
const { AnthropicProvider } = await import("../../lib/agent/anthropic-provider");

/**
 * Build provider history the way the sibling history tests do: construct the adapter
 * directly rather than going through `buildHistory`, which resolves a CONFIGURED
 * provider from settings and throws in a test environment that has none. The filter
 * under test (`!m.parentToolUseId`) lives in the adapter either way.
 */
async function buildAnthropicHistoryForTest(rows: unknown[]) {
	const provider = new (
		AnthropicProvider as unknown as new (
			config: Record<string, unknown>,
		) => {
			buildHistory: (
				rows: unknown[],
				model: string,
			) => Promise<{
				history: unknown[];
				trailingToolResults: unknown[];
				trailingUserText?: string;
			}>;
		}
	)({
		id: "test-anthropic",
		name: "Test Anthropic",
		prefix: "anthropic",
		apiKey: "test-key",
		baseUrl: "https://example.com/v1",
		defaultModel: "claude-sonnet-4",
		officialApi: false,
	});
	return provider.buildHistory(rows, "anthropic:claude-sonnet-4");
}

// Scheduling is stubbed at the module's own seam rather than through
// `mock.module("../narrator-session")`: that mock is process-wide and resets sibling
// services' module-level lazy state (it once broke nine unrelated buffer assertions).
const wakes: string[] = [];
const previousScheduler = setInjectionScheduler({
	requestSoftStop: () => true,
	wakeIfIdle: async (narratorId: string) => {
		wakes.push(narratorId);
		return { started: true };
	},
});

const now = "2026-07-28T10:00:00.000Z";
const PARENT_ID = "parent1";
const SUB_ID = "sub1";
const TOOL_USE_ID = "toolu_agent_01";

function seedNarrator(id: string, variant = "primary", parentNarratorId?: string) {
	sqlite
		.prepare(
			"INSERT INTO narrators (id, variant, parent_narrator_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(id, variant, parentNarratorId ?? null, now, now);
}

/**
 * The Agent tool call that owns the subagent. Real, not faked: the parent's
 * messageVersion bump resolves the owning narrator THROUGH this row, so a test without
 * it would pass while the production lookup found nothing.
 */
function seedOwningToolCall() {
	sqlite
		.prepare(
			`INSERT INTO narrator_messages (id, narrator_id, role, content_json, created_at)
			 VALUES ('pm1', ?, 'assistant', '[]', ?)`,
		)
		.run(PARENT_ID, now);
	sqlite
		.prepare(
			`INSERT INTO narrator_message_refs (id, narrator_id, message_id, seq, is_compact)
			 VALUES ('pr1', ?, 'pm1', 0, 0)`,
		)
		.run(PARENT_ID);
	sqlite
		.prepare(
			`INSERT INTO narrator_tool_calls (id, narrator_id, message_id, tool_use_id, tool_name, status, created_at)
			 VALUES ('tc1', ?, 'pm1', ?, 'Task', 'success', ?)`,
		)
		.run(PARENT_ID, TOOL_USE_ID, now);
}

function readRow(id: string) {
	return sqlite
		.prepare(
			"SELECT role, parent_tool_use_id, origin, content_text FROM narrator_messages WHERE id = ?",
		)
		.get(id) as {
		role: string;
		parent_tool_use_id: string | null;
		origin: string | null;
		content_text: string | null;
	};
}

function messageVersion(narratorId: string): number {
	return (
		sqlite.prepare("SELECT message_version AS v FROM narrators WHERE id = ?").get(narratorId) as {
			v: number;
		}
	).v;
}

function messageFrames(narratorId: string): Broadcast[] {
	return broadcasts.filter((b) => b.narratorId === narratorId && b.message.type === "message");
}

beforeEach(() => {
	cleanDb(sqlite);
	seedNarrator(PARENT_ID);
	seedNarrator(SUB_ID, "subagent:general", PARENT_ID);
	seedOwningToolCall();
	broadcasts.length = 0;
	wakes.length = 0;
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.module("../../websocket/narrator-ws", () => realNarratorWs);
	setInjectionScheduler(previousScheduler);
});

// ─────────────────────────────────────────────────────────────────────────────
// The row lands in the subtree
// ─────────────────────────────────────────────────────────────────────────────

describe("deliverInjection with a subagent recipient", () => {
	test("writes the row under the owning tool_use, on the subagent narrator", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "your teammate finished the migration",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});

		const row = readRow(result.messageId as string);
		// Both halves matter: the subtree link AND the fact that the row belongs to the
		// subagent, not to the parent. Writing it on the parent would put a subagent's
		// notification into the parent's conversation.
		expect(row.parent_tool_use_id).toBe(TOOL_USE_ID);
		expect(
			sqlite
				.prepare("SELECT narrator_id AS n FROM narrator_messages WHERE id = ?")
				.get(result.messageId as string),
		).toEqual({ n: SUB_ID });
	});

	test("registers the ref on the subagent, so the row has a position in ITS history", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const refs = sqlite
			.prepare("SELECT narrator_id AS n FROM narrator_message_refs WHERE message_id = ?")
			.all(result.messageId as string);
		// A row without a ref is invisible no matter what its parentToolUseId says.
		expect(refs).toEqual([{ n: SUB_ID }]);
	});

	test("works for role=user too, so the axes stay independent of placement", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "the user changed the plan",
			source: "spec_update",
			role: "user",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const row = readRow(result.messageId as string);
		expect(row.role).toBe("user");
		expect(row.parent_tool_use_id).toBe(TOOL_USE_ID);
	});

	test("bumps the PARENT's message version, because its tool card changed too", async () => {
		const before = messageVersion(PARENT_ID);
		await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		// The sync protocol treats an unchanged version as "nothing to replay", so
		// without this the parent's open panel keeps the stale card until a focus check.
		expect(messageVersion(PARENT_ID)).toBeGreaterThan(before);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Who can read it
// ─────────────────────────────────────────────────────────────────────────────

describe("who reads a subtree injection", () => {
	test("the subagent's own page loads it", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "your teammate finished the migration",
			source: "team_message",
			body: { kind: "prose", text: "your teammate finished the migration" },
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});

		expect(result.messageId).not.toBeNull();
		const page = await narratorMessageQueries.getPretextDocumentPage(SUB_ID);
		const ids = page.messages.map((m: { id: string }) => m.id);
		expect(ids).toContain(result.messageId as string);
	});

	test("the loaded copy reports parentToolUseId null, so the page draws it top-level", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const page = await narratorMessageQueries.getPretextDocumentPage(SUB_ID);
		const loaded = page.messages.find((m: { id: string }) => m.id === result.messageId);
		// The subagent page has no tool card to nest it under; the loader nulls the field
		// for exactly this reason.
		expect(loaded?.parentToolUseId).toBeNull();
	});

	test("a PRIMARY narrator's page would not show it — the filter is what makes placement meaningful", async () => {
		// Same row, read as if the parent were asking: this is the query shape that keeps
		// a subagent's chatter out of the parent's transcript.
		const result = await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const visibleToPrimaryLoader = sqlite
			.prepare(
				`SELECT m.id FROM narrator_message_refs r
				 JOIN narrator_messages m ON m.id = r.message_id
				 WHERE r.narrator_id = ? AND m.parent_tool_use_id IS NULL`,
			)
			.all(SUB_ID) as Array<{ id: string }>;
		expect(visibleToPrimaryLoader.map((r) => r.id)).not.toContain(result.messageId);
	});

	test("does NOT enter the model history while the row still carries the link", async () => {
		const result = await deliverInjection(SUB_ID, {
			content: "SUBTREE_MARKER text the model must not see as a child row",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		expect(result.messageId).not.toBeNull();

		const rows = await narratorMessageQueries.getModelHistorySinceLastCompact(SUB_ID);
		const built = await buildAnthropicHistoryForTest(rows);
		expect(JSON.stringify(built.history)).not.toContain("SUBTREE_MARKER");
		expect(built.trailingUserText ?? "").not.toContain("SUBTREE_MARKER");
	});

	test("DOES reach the model once the subagent's own loader clears the link", async () => {
		// The counterpart to the test above, and the reason the row is usable at all:
		// `loadSubagentHistory` nulls parentToolUseId before building, so the subagent
		// itself reads its injections. Asserting only the negative would leave "the row is
		// simply invisible everywhere" passing.
		await deliverInjection(SUB_ID, {
			content: "SUBTREE_MARKER text the subagent itself must read",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const rows = await narratorMessageQueries.getModelHistorySinceLastCompact(SUB_ID);
		const built = await buildAnthropicHistoryForTest(
			rows.map((m) => ({ ...m, parentToolUseId: null })),
		);
		const seen = `${JSON.stringify(built.history)}${built.trailingUserText ?? ""}`;
		expect(seen).toContain("SUBTREE_MARKER");
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// Broadcast: both pages, each with the shape it can render
// ─────────────────────────────────────────────────────────────────────────────

describe("broadcast for a subagent recipient", () => {
	test("goes to BOTH the parent and the subagent", async () => {
		await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		expect(messageFrames(PARENT_ID)).toHaveLength(1);
		expect(messageFrames(SUB_ID)).toHaveLength(1);
	});

	test("the parent copy keeps the link, so it attaches to the right tool card", async () => {
		await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		expect(messageFrames(PARENT_ID)[0].message.message.parentToolUseId).toBe(TOOL_USE_ID);
	});

	test("the subagent copy is stripped, so its page treats the row as top-level", async () => {
		await deliverInjection(SUB_ID, {
			content: "note",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const selfFrame = messageFrames(SUB_ID)[0];
		// Both fields: an un-rewritten `narratorId` would address the frame to the parent
		// while sending it to the subagent's subscribers.
		expect(selfFrame.message.narratorId).toBe(SUB_ID);
		expect(selfFrame.message.message.parentToolUseId).toBeNull();
	});

	test("both copies carry the same content, so the two pages cannot disagree", async () => {
		await deliverInjection(SUB_ID, {
			content: "one and the same notice",
			source: "team_message",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		const parent = messageFrames(PARENT_ID)[0].message.message;
		const self = messageFrames(SUB_ID)[0].message.message;
		expect(self.id).toBe(parent.id);
		expect(self.contentText).toBe(parent.contentText);
		expect(self.contentJson).toEqual(parent.contentJson);
	});
});

// ─────────────────────────────────────────────────────────────────────────────
// The primary path did not move
// ─────────────────────────────────────────────────────────────────────────────

describe("a primary narrator recipient is unchanged", () => {
	test("writes a top-level row when no placement is given", async () => {
		const result = await deliverInjection(PARENT_ID, {
			content: "container is up",
			source: "container_ready",
		});
		expect(readRow(result.messageId as string).parent_tool_use_id).toBeNull();
	});

	test("broadcasts exactly once, to itself", async () => {
		await deliverInjection(PARENT_ID, { content: "container is up", source: "container_ready" });
		expect(messageFrames(PARENT_ID)).toHaveLength(1);
		expect(broadcasts.filter((b) => b.message.type === "message")).toHaveLength(1);
	});

	test("still reaches the model, which is the whole point of a top-level row", async () => {
		await deliverInjection(PARENT_ID, {
			content: "TOPLEVEL_MARKER the model must read this",
			source: "container_ready",
		});
		const rows = await narratorMessageQueries.getModelHistorySinceLastCompact(PARENT_ID);
		const built = await buildAnthropicHistoryForTest(rows);
		const seen = `${JSON.stringify(built.history)}${built.trailingUserText ?? ""}`;
		expect(seen).toContain("TOPLEVEL_MARKER");
	});

	test("bumps only its own message version (no parent to notify)", async () => {
		const subBefore = messageVersion(SUB_ID);
		await deliverInjection(PARENT_ID, { content: "x", source: "s" });
		expect(messageVersion(SUB_ID)).toBe(subBefore);
	});

	test("scheduling is still requested for the recipient itself", async () => {
		await deliverInjection(PARENT_ID, {
			content: "background agent finished",
			source: "bg_agent",
			schedule: "wakeIfIdle",
		});
		expect(wakes).toEqual([PARENT_ID]);
	});

	test("a subagent recipient asks to wake the SUBAGENT, not its parent", async () => {
		// The scheduler resolves the recipient kind and routes to `resumeSubagent`; what
		// must be true here is only that the id handed over is the recipient's.
		await deliverInjection(SUB_ID, {
			content: "your teammate finished",
			source: "team_message",
			schedule: "wakeIfIdle",
			subagent: { parentToolUseId: TOOL_USE_ID, parentNarratorId: PARENT_ID },
		});
		expect(wakes).toEqual([SUB_ID]);
	});
});
