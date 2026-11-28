/**
 * Several people speaking in one coordinator conversation (docs/PROJECT_TEAMS-PLAN.md §二.12,
 * decision T5; M1): while the session is busy, messages from different people queue in arrival
 * order; each one becomes its own user row with its own author, and each reaches the model with
 * its own `<sender kind="human" id name>` marker. None is lost or merged into another person's.
 *
 * Runs the real admission, mailbox and loop with a fake provider (the same harness as
 * `narrator-session-mailbox-send.test.ts`).
 */
import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { asc, eq } from "drizzle-orm";
import { rowsAsHistory } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import { narratorBufferedMessages, narratorMessages, narrators, users } from "../../db/schema";
import type { ChatParams, ProviderAdapter } from "../../lib/agent/provider";

const { db, sqlite } = await import("../../db");
const { closePrefixSnapshotStore } = await import("../narrator-prefix-snapshots");
const realProviderModule = { ...(await import("../../lib/agent/provider")) };

/** What each model request carried as its new input (the history's latest non-assistant text). */
const providerInputs: string[] = [];
let beforeResponse: ((params: ChatParams) => Promise<void>) | undefined;

function latestInput(params: ChatParams): string {
	if (params.content) return params.content;
	const history = params.history as Array<{ role?: string; content?: unknown }>;
	const inputs: string[] = [];
	for (let index = history.length - 1; index >= 0; index--) {
		const entry = history[index];
		if (entry?.role === "assistant") break;
		if (typeof entry?.content === "string") inputs.unshift(entry.content);
	}
	return inputs.join("\n---\n");
}

const provider: ProviderAdapter = {
	formatTools: () => [],
	buildHistory: rowsAsHistory,
	injectSystemPrompt: () => {},
	async *chat(params) {
		providerInputs.push(latestInput(params));
		params.onRequestStart?.();
		await beforeResponse?.(params);
		yield { text: "noted" };
	},
	generate: async () => "",
	generateWithMeta: async () => ({ text: "" }),
	generateWithHistory: async () => "",
};

mock.module("../../lib/agent/provider", () => ({
	getProvider: () => provider,
	resolveProviderAndModel: (model = "openai:test-model") => ({
		requestedProvider: "openai",
		requestedModel: model,
		provider: "openai",
		adapter: provider,
		model: model.replace(/^openai:/, ""),
	}),
}));

const { acceptUserMessage, closeNarrator, hasPendingBufferedWork } = await import(
	"../narrator-session"
);
const { getBufferedMessagesAsync } = await import("../narrator-buffer");
const { getExecutionOwner } = await import("../agent-runtime/ownership");
const { backgroundOccupancyStore } = await import("../background-occupancy-store");

const now = new Date().toISOString();
const ALICE = { id: "speaker-alice", username: "alice" };
const BOB = { id: "speaker-bob", username: "bob" };

function seed(narratorId: string) {
	for (const person of [ALICE, BOB])
		db.insert(users)
			.values({ ...person, passwordHash: "x", role: "user", createdAt: now })
			.onConflictDoNothing()
			.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			type: "primary",
			variant: "primary",
			traits: ["standalone"],
			model: "openai:test-model",
			ownerUserId: ALICE.id,
			runtimeRegistrationJson: {
				version: 1,
				run: { logicalRunId: `fixture-${narratorId}`, principal: { userId: ALICE.id } },
			},
			permissionMode: "bypassPermissions",
			autoContinuationOverride: "off",
			status: "idle",
			cwd: process.cwd(),
			createdAt: now,
			updatedAt: now,
		})
		.run();
	backgroundOccupancyStore.refreshNarrator(narratorId);
}

async function waitFor(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
	const deadline = Date.now() + 5_000;
	while (Date.now() < deadline) {
		if (await check()) return;
		await Bun.sleep(10);
	}
	throw new Error(`Timed out waiting for ${label}`);
}

beforeEach(async () => {
	backgroundOccupancyStore.resetForTests();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
	await backgroundOccupancyStore.start();
	providerInputs.length = 0;
	beforeResponse = undefined;
});

afterAll(async () => {
	backgroundOccupancyStore.resetForTests();
	mock.module("../../lib/agent/provider", () => realProviderModule);
	mock.restore();
	await closePrefixSnapshotStore();
	cleanDb(sqlite);
});

const marker = (person: { id: string; username: string }) =>
	`<sender kind="human" id="${person.id}" name="${person.username}" />`;

test("two people speaking in turn while the session is busy: arrival order, one row and one sender each", async () => {
	const narratorId = "team-speakers-queue";
	seed(narratorId);
	const gate = Promise.withResolvers<void>();
	beforeResponse = async () => {
		if (providerInputs.length === 1) await gate.promise;
	};

	const first = await acceptUserMessage(narratorId, "Alice: build the parser", {
		userId: ALICE.id,
	});
	expect(first.buffered).toBe(false);
	await waitFor(() => providerInputs.length === 1, "the first turn to start");

	// The session is busy: everything below queues, in the order it arrives.
	const sent = [
		[BOB, "Bob: run the tests first"],
		[ALICE, "Alice: no, the parser first"],
		[BOB, "Bob: fine, parser first"],
	] as const;
	for (const [person, text] of sent) {
		const result = await acceptUserMessage(narratorId, text, { userId: person.id });
		expect(result.buffered).toBe(true);
	}
	const queued = await getBufferedMessagesAsync(narratorId);
	expect(
		queued.map((message) => [message.text, message.createdBy, message.creator?.username]),
	).toEqual(sent.map(([person, text]) => [text, person.id, person.username]));

	gate.resolve();
	await waitFor(
		async () =>
			!(await hasPendingBufferedWork(narratorId)) &&
			!getExecutionOwner(narratorId) &&
			db
				.select({ status: narrators.status })
				.from(narrators)
				.where(eq(narrators.id, narratorId))
				.get()?.status === "idle",
		"the queue to drain",
	);

	// Every message is its own user row, in arrival order, with its own author.
	const rows = db
		.select({
			text: narratorMessages.contentText,
			createdBy: narratorMessages.createdBy,
			role: narratorMessages.role,
		})
		.from(narratorMessages)
		.where(eq(narratorMessages.narratorId, narratorId))
		.orderBy(asc(narratorMessages.createdAt))
		.all()
		.filter((row) => row.role === "user");
	expect(rows.map((row) => [row.text, row.createdBy])).toEqual([
		["Alice: build the parser", ALICE.id],
		...sent.map(([person, text]) => [text, person.id]),
	]);
	const mailbox = db
		.select({
			state: narratorBufferedMessages.state,
			createdBy: narratorBufferedMessages.createdBy,
		})
		.from(narratorBufferedMessages)
		.where(eq(narratorBufferedMessages.narratorId, narratorId))
		.orderBy(asc(narratorBufferedMessages.arrivalSeq))
		.all();
	expect(mailbox.every((row) => row.state === "materialized")).toBe(true);
	expect(mailbox.map((row) => row.createdBy)).toEqual([
		ALICE.id,
		...sent.map(([person]) => person.id),
	]);

	// The model saw each message once, in order, each under its own sender marker.
	const seen = providerInputs.join("\n");
	const positions = [
		`${marker(ALICE)}\nAlice: build the parser`,
		...sent.map(([person, text]) => `${marker(person)}\n${text}`),
	].map((expected) => {
		const at = seen.indexOf(expected);
		expect(at).toBeGreaterThanOrEqual(0);
		expect(seen.indexOf(expected, at + 1)).toBe(-1);
		return at;
	});
	expect([...positions].sort((a, b) => a - b)).toEqual(positions);
	closeNarrator(narratorId);
});
