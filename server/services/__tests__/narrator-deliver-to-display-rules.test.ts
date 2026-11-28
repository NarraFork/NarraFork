/**
 * Display/statistics adapters follow the run registration, not how a session was
 * created: a session whose run delivers to a tool call (with or without a parent)
 * gets its retry warning shown on that call's card, and its own turns placed under
 * that call count as top level in the history token estimate. A session with a
 * delegated shape but no destination gets neither.
 */
import { afterAll, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { cleanDb } from "../../../tests/setup";
import { narratorMessageRefs, narratorMessages, narrators } from "../../db/schema";
import { getNarratorWorkerTestDb } from "./narrator-worker-fixture";

const fixture = getNarratorWorkerTestDb();
await fixture.ready;
const { db, sqlite } = fixture;
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const ws = await import("../../websocket/narrator-ws");
const agent = await import("../../lib/agent");
const { handleTransientError } = await import("../narrator-recovery");
const { estimateNarratorBuildHistoryTokens } = await import("../narrator-history-token-estimate");

const ID = "display-rule-session";
const CALLER = "display-rule-caller";
const DEST = "display-rule-dest-call";
const NOW = "2026-10-01T00:00:00.000Z";
const registration = {
	version: 1,
	run: { logicalRunId: "r", deliverTo: { narratorId: CALLER, toolUseId: DEST } },
};
const shapes = [
	{
		name: "delegated session",
		row: { type: "subagent", variant: "subagent:general", parentNarratorId: CALLER },
		registration,
		delivers: true,
	},
	{
		name: "session without a parent",
		row: { type: "primary", variant: "primary" },
		registration,
		delivers: true,
	},
	{
		name: "delegated shape without a destination",
		row: { type: "subagent", variant: "subagent:general", parentNarratorId: CALLER },
		registration: { version: 1 },
		delivers: false,
	},
] as const;

afterAll(async () => {
	mock.module("../../db", () => realDb);
	mock.restore();
	await fixture.close();
});

beforeEach(() => {
	cleanDb(sqlite);
	db.insert(narrators).values({ id: CALLER, createdAt: NOW, updatedAt: NOW }).run();
});

function seed(shape: (typeof shapes)[number]): void {
	db.insert(narrators)
		.values({
			id: ID,
			...shape.row,
			model: "anthropic:claude-sonnet-4-20250514",
			runtimeRegistrationJson: shape.registration as never,
			createdAt: NOW,
			updatedAt: NOW,
		})
		.run();
	let seq = 0;
	for (const [id, placement] of [
		["display-own", null],
		["display-under-dest", DEST],
		["display-nested", "some-other-call"],
	] as const) {
		db.insert(narratorMessages)
			.values({
				id,
				narratorId: ID,
				role: "user",
				contentJson: [{ type: "text", text: id }],
				contentText: id,
				parentToolUseId: placement,
				createdAt: NOW,
			})
			.run();
		db.insert(narratorMessageRefs)
			.values({ id: `ref-${id}`, narratorId: ID, messageId: id, seq: seq++ })
			.run();
	}
}

describe.each(shapes)("$name", (shape) => {
	test("retry warning goes to the run's destination session only when it has one", async () => {
		seed(shape);
		const broadcast = spyOn(ws, "broadcastToNarrator").mockImplementation(() => {});
		try {
			await handleTransientError({
				narratorId: ID,
				error: "overloaded",
				retryCount: 1,
				maxRetries: 3,
				signal: AbortSignal.abort(),
			});
			const toCaller = broadcast.mock.calls.filter(([target]) => target === CALLER);
			expect(toCaller.map(([, event]) => (event as { type: string }).type)).toEqual(
				shape.delivers ? ["subagent_warning"] : [],
			);
		} finally {
			broadcast.mockRestore();
		}
	});

	test("history estimate treats rows under the destination as own turns, nothing else", async () => {
		seed(shape);
		const seen: Array<{ id: string; parentToolUseId: string | null }> = [];
		const build = spyOn(agent, "buildHistory").mockImplementation(async (messages) => {
			for (const message of messages)
				seen.push({ id: message.id, parentToolUseId: message.parentToolUseId ?? null });
			return { history: [] } as never;
		});
		const resolve = spyOn(agent, "resolveProviderAndModel").mockImplementation(
			() =>
				({
					model: "claude-sonnet-4-20250514",
					provider: "anthropic",
					adapter: { injectSystemPrompt: () => {} },
				}) as never,
		);
		try {
			await estimateNarratorBuildHistoryTokens(ID, "en");
		} finally {
			build.mockRestore();
			resolve.mockRestore();
		}
		expect(seen).toEqual([
			{ id: "display-own", parentToolUseId: null },
			{ id: "display-under-dest", parentToolUseId: shape.delivers ? null : DEST },
			{ id: "display-nested", parentToolUseId: "some-other-call" },
		]);
	});
});

test("history estimate is the same for a delegated and a parentless session with the same deliverTo", async () => {
	// The history mirrors the placement it is given, so any divergence in how the two
	// sessions' rows are treated shows up in the token count.
	const build = spyOn(agent, "buildHistory").mockImplementation(
		async (messages) =>
			({
				history: messages.map((message) => ({
					role: "user",
					content: `${message.id}:${message.parentToolUseId ?? "top"}`,
				})),
			}) as never,
	);
	const resolve = spyOn(agent, "resolveProviderAndModel").mockImplementation(
		() =>
			({
				model: "claude-sonnet-4-20250514",
				provider: "anthropic",
				adapter: { injectSystemPrompt: () => {} },
			}) as never,
	);
	try {
		const estimates = [];
		for (const shape of shapes.filter((candidate) => candidate.delivers)) {
			cleanDb(sqlite);
			db.insert(narrators).values({ id: CALLER, createdAt: NOW, updatedAt: NOW }).run();
			seed(shape);
			estimates.push((await estimateNarratorBuildHistoryTokens(ID, "en"))?.promptTokens);
		}
		expect(estimates).toHaveLength(2);
		expect(estimates[0]).toBeGreaterThan(0);
		expect(estimates[1]).toBe(estimates[0]);
	} finally {
		build.mockRestore();
		resolve.mockRestore();
	}
});
