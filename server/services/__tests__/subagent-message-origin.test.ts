/**
 * subagent-message-origin.test.ts — what `persistSubagentUserMessage` writes for a
 * message that came from another AGENT rather than from a person.
 *
 * A `Send` to a subagent is delivered through the recipient's user-message pipeline
 * and lands here with a `createdBy` naming whoever's session triggered the send. The
 * row used to be written with no `origin`/`origin_label` at all, and `null` means
 * "user" by design (pre-column rows were all human) — so the subagent's page painted
 * a right-hand user bubble signed with a real person's avatar for words a machine
 * wrote. The reverse direction (subagent → parent) always rendered correctly as an
 * injection card, which is what made the asymmetry visible.
 *
 * These tests pin both halves of the fix: the attribution columns are written, and
 * `createdBy` survives as audit data WITHOUT being promoted to the rendered author.
 */

import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";

const { db, sqlite } = getTestDb();
// Captured before the mock replaces it: `mock.module` is process-wide, so leaving the
// in-memory schema installed would hand it to every later test file in the same run.
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { narratorService } = await import("../narrator-service");
const { clearAgentMessageOrigins, registerAgentMessageOrigin } = await import(
	"../agent-message-origin"
);

const now = "2026-07-28T10:00:00.000Z";
const TOOL_USE_ID = "toolu_agent_01";

function seedNarrator(id: string) {
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

/** The text as `withSenderPrefix` delivers it — the registry key is the exact string. */
const PARENT_TEXT = "[Message from the parent narrator]\nrebase onto trunk first";

const PARENT_SENDER = {
	id: "narr-parent",
	title: "Fix the lease path",
	label: "fix-the-lease-path",
	type: null,
	isParent: true,
};

beforeEach(() => {
	cleanDb(sqlite);
	clearAgentMessageOrigins();
	seedNarrator("sub1");
	seedUser();
});

afterAll(() => {
	clearAgentMessageOrigins();
	mock.module("../../db", () => realDbModule);
});

describe("a message another agent sent", () => {
	test("is attributed to the AI that wrote it, not to the user who triggered the chain", () => {
		registerAgentMessageOrigin("sub1", PARENT_TEXT, PARENT_SENDER);
		return narratorService
			.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, { createdBy: "u1" })
			.then((msg) => {
				const row = readRow(msg.id);
				// role stays "user": it IS the subagent's next turn, and the provider protocol
				// plus the continuation scheduler both depend on that.
				expect(row.role).toBe("user");
				expect(row.origin).toBe("assistant");
				expect(row.origin_label).toBe("agentMessage:Fix the lease path");
			});
	});

	test("keeps createdBy as audit data — which human's session started this", async () => {
		registerAgentMessageOrigin("sub1", PARENT_TEXT, PARENT_SENDER);
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
		});
		expect(readRow(msg.id).created_by).toBe("u1");
	});

	test("does NOT return a creator, so the bubble cannot sign it with a person's avatar", async () => {
		// This is the visible half of the bug: the header renders `creator` as the author,
		// so returning one here is what put a real user's name on a machine's message.
		registerAgentMessageOrigin("sub1", PARENT_TEXT, PARENT_SENDER);
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
		});
		expect(msg.creator).toBeNull();
	});

	test("keeps the model-facing text byte-for-byte, prefix included", async () => {
		// The sender prefix is how the model knows who spoke; attribution metadata is
		// additive and must not rewrite the content.
		registerAgentMessageOrigin("sub1", PARENT_TEXT, PARENT_SENDER);
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
		});
		expect(readRow(msg.id).content_text).toBe(PARENT_TEXT);
	});

	test("names an untitled sibling by its alias", async () => {
		const text = '[Message from sibling subagent "explore-1" (explore)]\nfound it';
		registerAgentMessageOrigin("sub1", text, {
			id: "narr-sibling",
			title: null,
			label: "explore-1",
			type: "explore",
			isParent: false,
		});
		const msg = await narratorService.persistSubagentUserMessage("sub1", text, TOOL_USE_ID);
		expect(readRow(msg.id).origin_label).toBe("agentMessage:explore-1");
	});

	test("attribution is consumed, so a later identical human message stays a user turn", async () => {
		registerAgentMessageOrigin("sub1", PARENT_TEXT, PARENT_SENDER);
		await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID);
		const second = await narratorService.persistSubagentUserMessage(
			"sub1",
			PARENT_TEXT,
			TOOL_USE_ID,
			{ createdBy: "u1" },
		);
		const row = readRow(second.id);
		expect(row.origin).toBe("user");
		expect(row.origin_label).toBeNull();
		expect(second.creator?.username).toBe("alice");
	});
});

describe("a message the user typed on the subagent page", () => {
	test("stays a human turn with its creator, unchanged by this feature", async () => {
		const msg = await narratorService.persistSubagentUserMessage("sub1", "try again", TOOL_USE_ID, {
			createdBy: "u1",
		});
		const row = readRow(msg.id);
		expect(row.role).toBe("user");
		expect(row.origin).toBe("user");
		expect(row.origin_label).toBeNull();
		expect(row.created_by).toBe("u1");
		expect(msg.creator?.username).toBe("alice");
	});

	test("an authorless message is still a user turn (no attribution invented)", async () => {
		const msg = await narratorService.persistSubagentUserMessage("sub1", "continue", TOOL_USE_ID);
		const row = readRow(msg.id);
		expect(row.origin).toBe("user");
		expect(row.created_by).toBeNull();
		expect(msg.creator).toBeNull();
	});

	test("an attribution registered for a DIFFERENT subagent does not leak in", async () => {
		seedNarrator("sub2");
		registerAgentMessageOrigin("sub2", "shared wording", PARENT_SENDER);
		const msg = await narratorService.persistSubagentUserMessage(
			"sub1",
			"shared wording",
			TOOL_USE_ID,
			{ createdBy: "u1" },
		);
		expect(readRow(msg.id).origin).toBe("user");
		expect(msg.creator?.username).toBe("alice");
	});
});

describe("an explicit origin from the caller", () => {
	test("wins over the registry, so a caller that knows better is never overridden", async () => {
		registerAgentMessageOrigin("sub1", "text", PARENT_SENDER);
		const msg = await narratorService.persistSubagentUserMessage("sub1", "text", TOOL_USE_ID, {
			createdBy: "u1",
			origin: { origin: "system", originLabel: "recovery" },
		});
		const row = readRow(msg.id);
		expect(row.origin).toBe("system");
		expect(row.origin_label).toBe("recovery");
	});

	test("a non-human explicit origin also withholds the creator", async () => {
		const msg = await narratorService.persistSubagentUserMessage("sub1", "resumed", TOOL_USE_ID, {
			createdBy: "u1",
			origin: { origin: "system", originLabel: "recovery" },
		});
		expect(msg.creator).toBeNull();
		expect(readRow(msg.id).created_by).toBe("u1");
	});
});
