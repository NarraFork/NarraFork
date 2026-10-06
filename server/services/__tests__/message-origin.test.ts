/**
 * message-origin.test.ts — attribution of messages persisted as `role: "user"`.
 *
 * `role` cannot express authorship: providers treat the trailing `user` message
 * as the current turn and the continuation scheduler only resumes from
 * user/assistant, so system- and AI-injected turns must ALSO be stored as
 * `role: "user"`. These tests pin the `origin` column that distinguishes them,
 * and the invariant that adding it did not change what the model sees.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// Captured before the mock replaces it: `mock.module` is process-wide, so leaving
// the in-memory schema installed would hand it to every later test file in the
// same run (the knowledge suites then fail on their missing FTS tables).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

// Imported through narrator-service (which re-exports the delegated methods) to
// avoid the module-init cycle that importing narrator-persistence first triggers.
const { narratorService } = await import("../narrator-service");
const narratorPersistence = narratorService;

const now = "2026-07-28T10:00:00.000Z";

function seedNarrator(id = "n1") {
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run(id, now, now);
}

function seedUser(id = "u1", username = "alice") {
	sqlite
		.prepare(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run(id, username, "x", "admin", now);
}

function readRow(id: string) {
	return sqlite
		.prepare(
			"SELECT role, origin, origin_label, created_by, content_text FROM narrator_messages WHERE id = ?",
		)
		.get(id) as {
		role: string;
		origin: string | null;
		origin_label: string | null;
		created_by: string | null;
		content_text: string | null;
	};
}

beforeEach(() => {
	cleanDb(sqlite);
	seedNarrator();
	seedUser();
});

// Hand the real module back so subsequent test files in this run see the DB they
// set up themselves.
afterAll(() => {
	mock.module("../../db", () => realDbModule);
});

describe("persistUserMessage origin", () => {
	test("defaults to user so ordinary human turns need no extra argument", async () => {
		const msg = await narratorPersistence.persistUserMessage("n1", "hello", undefined, null, "u1");
		const row = readRow(msg.id);
		expect(row.role).toBe("user");
		expect(row.origin).toBe("user");
		expect(row.origin_label).toBeNull();
		expect(row.created_by).toBe("u1");
	});

	test("records a system-injected turn without claiming a human wrote it", async () => {
		const msg = await narratorPersistence.persistUserMessage(
			"n1",
			"continue",
			undefined,
			null,
			null,
			{ origin: "system", originLabel: "autoContinuation" },
		);
		const row = readRow(msg.id);
		// Still role=user: the provider protocol and continuation scheduler need it.
		expect(row.role).toBe("user");
		expect(row.origin).toBe("system");
		expect(row.origin_label).toBe("autoContinuation");
		expect(row.created_by).toBeNull();
	});

	test("keeps origin and createdBy independent (scheduled task run by its author)", async () => {
		const msg = await narratorPersistence.persistUserMessage(
			"n1",
			"nightly report",
			undefined,
			null,
			"u1",
			{ origin: "system", originLabel: "scheduledTask:nightly" },
		);
		const row = readRow(msg.id);
		// The task's creator is known, but they did not type this turn.
		expect(row.origin).toBe("system");
		expect(row.origin_label).toBe("scheduledTask:nightly");
		expect(row.created_by).toBe("u1");
	});

	test("marks AI-initiated sends as assistant-authored", async () => {
		const msg = await narratorPersistence.persistUserMessage(
			"n1",
			"investigate the failure",
			undefined,
			null,
			null,
			{ origin: "assistant", originLabel: "forkNarrator" },
		);
		expect(readRow(msg.id).origin).toBe("assistant");
	});

	test("returns the creator so the bubble can render an avatar", async () => {
		const msg = await narratorPersistence.persistUserMessage("n1", "hi", undefined, null, "u1");
		expect(msg.creator?.username).toBe("alice");
	});
});

describe("persistSystemMessage origin", () => {
	test("defaults to system", async () => {
		const msg = await narratorPersistence.persistSystemMessage("n1", "container stopped");
		const row = readRow(msg.id);
		expect(row.role).toBe("sys");
		expect(row.origin).toBe("system");
	});

	test("preserves contentText so model visibility is unchanged", async () => {
		// Every provider's buildHistory falls back to contentText for sys messages;
		// attribution metadata must not disturb that.
		const msg = await narratorPersistence.persistSystemMessage("n1", "review the diff");
		expect(readRow(msg.id).content_text).toBe("review the diff");
	});
});
