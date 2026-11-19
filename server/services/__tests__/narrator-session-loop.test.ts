import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import type { ActiveNarrator } from "../narrator-session-state";
import {
	capturePlannedUpdateRecoverySnapshot,
	resetUpdateCoordinationForTests,
} from "../update-coordinator";
import { closeRuntimeTestDb, getRuntimeTestDb } from "./agent-runtime-test-database";

const { db, sqlite, ready } = getRuntimeTestDb();
await ready;
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ ...realDbModule, db, sqlite }));
const { runAgentLoop, editAssistantMessage } = await import("../narrator-session");
const { narratorStore } = await import("../narrator-store");
const { readNarratorMessageRow } = await import("../narrator-message-reader");
const { noteRowsOnlyEnvelopes } = await import("../narrator-block-scans");
const { stopBlockSyncSweep } = await import("../narrator-block-sync");
afterAll(async () => {
	stopBlockSyncSweep();
	await closeRuntimeTestDb(sqlite, { sessionTails: true });
	mock.module("../../db", () => realDbModule);
});

beforeEach(() => {
	resetUpdateCoordinationForTests();
});

afterEach(() => {
	resetUpdateCoordinationForTests();
});

test("assistant edits preserve the reasoning body of a rows-only envelope", async () => {
	const narratorId = "worker-edit-rows-only";
	const now = new Date().toISOString();
	sqlite.run("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)", [
		narratorId,
		now,
		now,
	]);
	const step = await narratorStore.openStep(narratorId, {
		uuid: "rows-only-uuid",
		session_id: "rows-only-session",
	});
	await narratorStore.writeStepItem(step.id, narratorId, {
		type: "reasoning",
		id: "reasoning-kept",
		text: "keep this reasoning",
		completed: true,
		outputIndex: 0,
	});
	await narratorStore.writeStepItem(step.id, narratorId, {
		type: "text",
		id: "answer-edit",
		text: "original answer",
		completed: true,
		outputIndex: 1,
	});
	sqlite.run("UPDATE narrator_messages SET content_json = '[]', body_rows_only = 1 WHERE id = ?", [
		step.id,
	]);
	noteRowsOnlyEnvelopes(true);
	try {
		expect(await editAssistantMessage(narratorId, step.id, "edited answer")).toEqual({ ok: true });
		const updated = await readNarratorMessageRow(step.id, {
			includeTools: false,
			includeCreator: false,
		});
		expect(updated?.contentJson).toEqual(
			expect.arrayContaining([
				expect.objectContaining({
					type: "reasoning",
					id: "reasoning-kept",
					text: "keep this reasoning",
				}),
				expect.objectContaining({ type: "text", id: "answer-edit", text: "edited answer" }),
			]),
		);
	} finally {
		noteRowsOnlyEnvelopes(undefined);
	}
});

describe("narrator loop setup cleanup", () => {
	test("unregisters the update loop when narrator initialization fails", async () => {
		const active = {
			narratorId: "missing-loop-narrator",
			conversationId: "conversation",
			cwd: "/tmp",
			model: "test:model",
			provider: "test",
			systemPrompt: null,
			events: new EventEmitter(),
			alive: true,
			locale: "en",
			abortController: new AbortController(),
			_enabledOptionalTools: new Set<string>(),
			_disabledTools: new Set<string>(),
			_blockedSkills: { all: false, names: new Set<string>() },
			_substatus: new Set<string>(),
		} as unknown as ActiveNarrator;

		await expect(runAgentLoop(active, "start", [])).rejects.toThrow(
			"Narrator not found: missing-loop-narrator",
		);
		expect(active._loopRunning).toBe(false);
		expect(active.alive).toBe(false);
		expect(capturePlannedUpdateRecoverySnapshot().narrators).toEqual([]);
	});
});
