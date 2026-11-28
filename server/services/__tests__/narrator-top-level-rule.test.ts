/**
 * One "top-level message" rule for every session: a row is the session's own turn when
 * it has no placement, or when it is placed under the tool call its run delivers to
 * (`deliverTo.toolUseId`). Retry, denied-tool reexecution and the model history view
 * all use it; none of them branch on how the session was created. Each case runs for a
 * delegated session and for a session without a parent that registered the same
 * destination: both must behave the same.
 */
import { afterAll, afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { historyStrings } from "../../../tests/fixtures/model-input";
import { cleanDb } from "../../../tests/setup";
import { getWorkerTestDb } from "../../../tests/worker-test-db";
import {
	narratorMessageRefs,
	narratorMessages,
	narrators,
	narratorToolCalls,
} from "../../db/schema";

const { db, sqlite, disposeWorkerDb } = getWorkerTestDb();
const realDb = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDb, db, sqlite }));
const { narratorService } = await import("../narrator-service");
const session = await import("../narrator-session");
const { activeNarrators } = await import("../narrator-session-state");
const { buildRuntimeHistory, isTopLevelMessage } = await import("../agent-runtime/history");
const agent = await import("../../lib/agent");

const ID = "top-level-session";
const OWNER = "top-level-owner";
const ORIGIN = "origin-call";
const NOW = "2026-09-30T00:00:00.000Z";
let cwd: string;
let seq = 0;

const shapes = [
	{
		name: "delegated session",
		row: { type: "subagent", variant: "subagent:general", parentNarratorId: OWNER },
	},
	{ name: "session without a parent", row: { type: "primary", variant: "primary" } },
] as const;

function message(
	id: string,
	role: "user" | "assistant" | "sys",
	blocks: unknown[],
	parentToolUseId: string | null,
	text: string | null = null,
) {
	db.insert(narratorMessages)
		.values({
			id,
			narratorId: ID,
			role,
			contentJson: blocks,
			contentText: text,
			parentToolUseId,
			createdAt: NOW,
		})
		.run();
	db.insert(narratorMessageRefs)
		.values({ id: `ref-${id}`, narratorId: ID, messageId: id, seq: seq++ })
		.run();
}

function seed(shape: (typeof shapes)[number]) {
	db.insert(narrators)
		.values([
			{ id: OWNER, variant: "primary", createdAt: NOW, updatedAt: NOW },
			{
				id: ID,
				...shape.row,
				cwd,
				status: "idle",
				model: "test:model",
				// The one relationship that decides placement: where this session's run delivers.
				runtimeRegistrationJson: {
					version: 1,
					run: {
						logicalRunId: "registered-run",
						deliverTo: { narratorId: OWNER, toolUseId: ORIGIN },
					},
				},
				createdAt: NOW,
				updatedAt: NOW,
			},
		])
		.run();
}

function stopAtModelStart() {
	activeNarrators.set(ID, {
		narratorId: ID,
		conversationId: "test",
		cwd,
		model: "test:model",
		provider: "test",
		systemPrompt: null,
		events: new EventEmitter(),
		alive: true,
		locale: "en",
		abortController: new AbortController(),
		_enabledOptionalTools: new Set(),
		_disabledTools: new Set(),
		_blockedSkills: { all: false, names: new Set() },
		_substatus: new Set(),
	} as never);
	const reachedStart = new Error("test reached model start");
	const start = spyOn(narratorService, "updateStatus").mockImplementation(async (_id, status) => {
		expect(status).toBe("working");
		throw reachedStart;
	});
	return { start, reachedStart };
}

beforeEach(() => {
	cleanDb(sqlite);
	seq = 0;
	cwd = mkdtempSync(join(tmpdir(), "nf-top-level-"));
});
afterEach(() => {
	activeNarrators.delete(ID);
	mock.restore();
	cleanDb(sqlite);
	rmSync(cwd, { recursive: true, force: true });
});
afterAll(async () => {
	await disposeWorkerDb();
	mock.module("../../db", () => realDb);
});

test("the rule: no placement, or placement under this session's own destination", () => {
	expect(isTopLevelMessage({ parentToolUseId: null }, ORIGIN)).toBe(true);
	expect(isTopLevelMessage({ parentToolUseId: ORIGIN }, ORIGIN)).toBe(true);
	expect(isTopLevelMessage({ parentToolUseId: "nested-call" }, ORIGIN)).toBe(false);
	expect(isTopLevelMessage({ parentToolUseId: ORIGIN }, null)).toBe(false);
	expect(isTopLevelMessage({ parentToolUseId: null }, undefined)).toBe(true);
});

for (const shape of shapes) {
	describe(shape.name, () => {
		test("retry targets the last own user turn placed under the destination", async () => {
			seed(shape);
			message("task", "user", [{ type: "text", text: "do the task" }], ORIGIN, "do the task");
			// A transcript nested under some OTHER call is not this session's turn.
			message("nested", "assistant", [{ type: "text", text: "nested" }], "nested-call");
			const { start, reachedStart } = stopAtModelStart();
			await expect(session.retryLastMessage(ID)).rejects.toBe(reachedStart);
			expect(start).toHaveBeenCalledTimes(1);
		});

		test("retry of a reference-only turn projects the accepted bytes into the current input", async () => {
			seed(shape);
			const accepted = {
				type: "file_reference",
				reference: { id: "r", path: "/gone.ts", deviceId: "remote-X", label: "file" },
				snapshotText: "the exact accepted bytes",
				snapshotHash: "hash-fixed",
				capturedAt: "2026-09-01T00:00:00Z",
			};
			message("task", "user", [accepted], ORIGIN, "");
			const runModule = await import("../agent-runtime/run");
			const started: string[] = [];
			const idle = Promise.resolve({
				started: true,
				output: "",
				finalText: "",
				hasError: false,
				interrupted: false,
				timedOut: false,
			});
			spyOn(runModule, "startNarratorRun").mockImplementation(async (request) => {
				started.push(request.text);
				return { started: true, foreground: idle, terminal: idle, completion: idle };
			});
			stopAtModelStart().start.mockImplementation(async () => {});
			expect((await session.retryLastMessage(ID)).ok).toBe(true);
			for (let i = 0; i < 100 && started.length === 0; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect(started).toHaveLength(1);
			expect(started[0]).toContain("the exact accepted bytes");
			// Nothing is persisted again: the saved message is reused.
			expect(db.select().from(narratorMessages).all()).toHaveLength(1);
		});

		test("official provider: the retried snapshot reaches history once; trailing sys kept", async () => {
			seed(shape);
			const snapshotText = "the exact accepted bytes for the official provider";
			const accepted = {
				type: "file_reference",
				reference: { id: "r", path: "/gone.ts", deviceId: "remote-X", label: "file" },
				snapshotText,
				snapshotHash: "hash-fixed",
				capturedAt: "2026-09-01T00:00:00Z",
			};
			message("task", "user", [accepted], ORIGIN, "");
			const runModule = await import("../agent-runtime/run");
			const started: string[] = [];
			const idle = Promise.resolve({
				started: true,
				output: "",
				finalText: "",
				hasError: false,
				interrupted: false,
				timedOut: false,
			});
			spyOn(runModule, "startNarratorRun").mockImplementation(async (request) => {
				started.push(request.text);
				return { started: true, foreground: idle, terminal: idle, completion: idle };
			});
			stopAtModelStart().start.mockImplementation(async () => {});
			expect((await session.retryLastMessage(ID)).ok).toBe(true);
			for (let i = 0; i < 100 && started.length === 0; i++)
				await new Promise((resolve) => setTimeout(resolve, 5));
			expect(started).toHaveLength(1);
			// A system injection lands after the retried turn, before its pass is built.
			message(
				"hint",
				"sys",
				[{ type: "text", text: "trailing system hint" }],
				ORIGIN,
				"trailing system hint",
			);
			const { MODEL_HISTORY_REVISION_CONTRACT } = await import(
				"../agent-runtime/model-history-revision-sql"
			);
			sqlite
				.query(
					"INSERT INTO model_history_revision_contracts (id, installed_version) VALUES ('model-history', ?)",
				)
				.run(MODEL_HISTORY_REVISION_CONTRACT);
			const { settings } = await import("../../lib/settings");
			const original = settings.anthropicProviders;
			settings.anthropicProviders = [
				{
					id: "top-level-official",
					name: "Official",
					prefix: "top-level-official",
					apiKey: "isolated-test-no-network",
					baseUrl: "https://example.invalid/v1",
					defaultModel: "claude-sonnet-4",
					officialApi: true,
				},
			];
			try {
				const prepared = await buildRuntimeHistory({
					narratorId: ID,
					model: "claude-sonnet-4",
					provider: "top-level-official",
					currentInput: started[0],
				});
				// The retried row carries the snapshot into the history exactly once.
				expect(prepared.currentInputPersisted).toBe(true);
				expect(prepared.currentText).toBe("");
				expect(prepared.currentInputText.split(snapshotText).length).toBe(2);
				expect(historyStrings(prepared.history).split(snapshotText).length).toBe(2);
				// Official semantics: the trailing sys row stays a system message in history.
				expect(prepared.history).toEqual(
					expect.arrayContaining([
						expect.objectContaining({
							role: "system",
							content: expect.stringContaining("trailing system hint"),
						}),
					]),
				);
			} finally {
				settings.anthropicProviders = original;
			}
		});

		test("retry refuses when an own assistant reply placed under the destination is last", async () => {
			seed(shape);
			message("task", "user", [{ type: "text", text: "do the task" }], ORIGIN, "do the task");
			message("reply", "assistant", [{ type: "text", text: "done" }], ORIGIN, "done");
			await expect(session.retryLastMessage(ID)).rejects.toThrow(
				"Last message is not a user message",
			);
		});

		test("a denied tool in the last own turn under the destination can be re-executed", async () => {
			seed(shape);
			message("task", "user", [{ type: "text", text: "do the task" }], ORIGIN, "do the task");
			message(
				"turn",
				"assistant",
				[{ type: "tool_use", id: "denied-use", name: "Bash", input: { command: "true" } }],
				ORIGIN,
			);
			db.insert(narratorToolCalls)
				.values({
					id: "denied-call",
					narratorId: ID,
					messageId: "turn",
					toolUseId: "denied-use",
					toolName: "Bash",
					inputJson: { command: "true" },
					status: "fail",
					permissionDecidedBy: "user",
					executionIdentityVersion: 1,
					executionAttempt: 1,
					createdAt: NOW,
				})
				.run();
			// Admission is the decision under test; stop right after it.
			const admitted = new Error("re-execution admitted");
			const result = await session
				.reExecuteDeniedToolCall(ID, "denied-use", "en", false, null, {
					onAdmitted: async () => {
						throw admitted;
					},
				})
				.catch((error: unknown) => error);
			expect(result).toBe(admitted);
		});

		test("a denied tool under a nested call is not the latest own turn", async () => {
			seed(shape);
			message("task", "user", [{ type: "text", text: "do the task" }], ORIGIN, "do the task");
			message(
				"nested-turn",
				"assistant",
				[{ type: "tool_use", id: "nested-use", name: "Bash", input: {} }],
				"nested-call",
			);
			db.insert(narratorToolCalls)
				.values({
					id: "nested-call-row",
					narratorId: ID,
					messageId: "nested-turn",
					toolUseId: "nested-use",
					toolName: "Bash",
					inputJson: {},
					status: "fail",
					permissionDecidedBy: "user",
					executionIdentityVersion: 1,
					executionAttempt: 1,
					createdAt: NOW,
				})
				.run();
			expect(await session.reExecuteDeniedToolCall(ID, "nested-use")).toEqual({
				ok: false,
				reason: "not_latest_turn",
			});
		});

		test("model history clears only the destination placement, from the registration", async () => {
			seed(shape);
			// Real rows through the real loader: the revision contract signs them.
			const { MODEL_HISTORY_REVISION_CONTRACT } = await import(
				"../agent-runtime/model-history-revision-sql"
			);
			sqlite
				.query(
					"INSERT INTO model_history_revision_contracts (id, installed_version) VALUES ('model-history', ?)",
				)
				.run(MODEL_HISTORY_REVISION_CONTRACT);
			message("own", "user", [{ type: "text", text: "own" }], ORIGIN, "own");
			message("nested", "user", [{ type: "text", text: "nested" }], "nested-call", "nested");
			message("plain", "user", [{ type: "text", text: "plain" }], null, "plain");
			const seen: Array<{ id: string; parentToolUseId?: string | null }> = [];
			const builder = spyOn(agent, "buildHistory").mockImplementation(async (messages) => {
				for (const row of messages) seen.push({ id: row.id, parentToolUseId: row.parentToolUseId });
				return { history: [] };
			});
			try {
				// No destination passed: it is read from the session's run registration.
				await buildRuntimeHistory({ narratorId: ID, model: "test:model", provider: "test" });
			} finally {
				builder.mockRestore();
			}
			expect(seen).toEqual([
				{ id: "own", parentToolUseId: null },
				{ id: "nested", parentToolUseId: "nested-call" },
				{ id: "plain", parentToolUseId: null },
			]);
		});
	});
}

test("a session that delivers nowhere treats only unplaced rows as its own", async () => {
	db.insert(narrators)
		.values({ id: ID, variant: "primary", cwd, status: "idle", createdAt: NOW, updatedAt: NOW })
		.run();
	message("task", "user", [{ type: "text", text: "do the task" }], null, "do the task");
	message("nested", "user", [{ type: "text", text: "nested" }], ORIGIN, "nested");
	const { start, reachedStart } = stopAtModelStart();
	await expect(session.retryLastMessage(ID)).rejects.toBe(reachedStart);
	expect(start).toHaveBeenCalledTimes(1);
});
