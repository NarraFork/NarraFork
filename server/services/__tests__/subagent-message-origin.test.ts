import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanDb, getTestDb } from "../../../tests/setup";
import { createAgentMessageDelivery } from "../agent-message-delivery";
import { clearAgentMessageOrigins, registerAgentMessageOrigin } from "../agent-message-origin";

const { db, sqlite } = getTestDb();
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));
const { narratorService } = await import("../narrator-service");

const now = "2026-07-28T10:00:00.000Z";
const TOOL_USE_ID = "toolu_agent_01";
const BODY = "rebase onto trunk first";
const PARENT_TEXT = `[Message from the parent narrator]\n${BODY}`;
const SENDER = {
	id: "parent",
	title: "Fix the lease path",
	label: "fix-the-lease-path",
	type: null,
	isParent: true,
};
function delivery(text = BODY) {
	return createAgentMessageDelivery("sub1", SENDER, "send-01", text);
}
function persist(envelope = delivery(), text = PARENT_TEXT) {
	return narratorService.persistSubagentUserMessage("sub1", text, TOOL_USE_ID, {
		createdBy: "u1",
		delivery: envelope,
	});
}

beforeEach(() => {
	cleanDb(sqlite);
	clearAgentMessageOrigins();
	sqlite
		.prepare("INSERT INTO narrators (id, created_at, updated_at) VALUES (?, ?, ?)")
		.run("sub1", now, now);
	sqlite
		.prepare(
			"INSERT INTO users (id, username, password_hash, role, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.run("u1", "alice", "x", "admin", now);
});
afterAll(() => {
	clearAgentMessageOrigins();
	mock.module("../../db", () => realDbModule);
});

describe("explicit agent delivery persistence", () => {
	test("reuses the exact reserved ID and keeps role, origin, audit user and model text", async () => {
		const envelope = delivery();
		const msg = await persist(envelope);
		expect(msg.id).toBe(envelope.recipientMessageId);
		expect(msg.role).toBe("user");
		expect(msg.origin).toBe("assistant");
		expect(msg.originLabel).toBe("agentMessage:Fix the lease path");
		expect(msg.createdBy).toBe("u1");
		expect(msg.creator).toBeNull();
		expect(msg.contentText).toBe(PARENT_TEXT);
		expect(msg.contentJson).toEqual([
			{ type: "text", text: PARENT_TEXT },
			{
				type: "system_injection",
				source: "subagent_message",
				body: {
					kind: "messages",
					items: [
						{
							fromId: "parent",
							fromTitle: SENDER.title,
							fromLabel: SENDER.label,
							fromType: null,
							fromToolUseId: "send-01",
							text: BODY,
						},
					],
				},
			},
		]);
	});

	test("reply-request boilerplate remains only in the model text", async () => {
		const text = `${PARENT_TEXT}\n\n[Reply requested requestId=abc] Send a reply`;
		const msg = await persist(delivery(), text);
		expect(msg.contentText).toBe(text);
		expect(JSON.stringify((msg.contentJson as unknown[])[1])).not.toContain("requestId");
	});

	test("identical deliveries keep independent recipient IDs and sender identities", async () => {
		const first = delivery("same");
		const second = createAgentMessageDelivery(
			"sub1",
			{ id: "sibling", title: null, label: "explore-1", type: "explore", isParent: false },
			"send-02",
			"same",
		);
		const b = await persist(second, "same model text");
		const a = await persist(first, "same model text");
		expect(a.id).not.toBe(b.id);
		expect(a.originLabel).toBe("agentMessage:Fix the lease path");
		expect(b.originLabel).toBe("agentMessage:explore-1");
	});

	test("an unconsumed delivery cannot attribute an identical human message", async () => {
		delivery();
		// Even stale entries from the obsolete registry cannot affect human input.
		registerAgentMessageOrigin("sub1", PARENT_TEXT, SENDER);
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
		});
		expect(msg.origin).toBe("user");
		expect(msg.creator?.username).toBe("alice");
		expect(msg.contentJson).toEqual([{ type: "text", text: PARENT_TEXT }]);
	});

	test("a later identical human input is unaffected after an agent delivery", async () => {
		await persist();
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
		});
		expect(msg.origin).toBe("user");
		expect(msg.originLabel).toBeNull();
		expect(msg.creator?.username).toBe("alice");
	});

	test("a recipient mismatch is rejected before writing", async () => {
		const envelope = { ...delivery(), recipientNarratorId: "other" };
		await expect(persist(envelope)).rejects.toThrow("recipient");
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(0);
	});

	test("the same envelope cannot persist a second copy", async () => {
		const envelope = delivery();
		await persist(envelope);
		await expect(persist(envelope)).rejects.toThrow();
		expect(sqlite.prepare("SELECT id FROM narrator_messages").all()).toHaveLength(1);
		expect(sqlite.prepare("SELECT message_id FROM narrator_message_refs").all()).toHaveLength(1);
	});

	test("explicit attribution overrides the envelope attribution", async () => {
		const msg = await narratorService.persistSubagentUserMessage("sub1", PARENT_TEXT, TOOL_USE_ID, {
			createdBy: "u1",
			delivery: delivery(),
			origin: { origin: "system", originLabel: "recovery" },
		});
		expect(msg.origin).toBe("system");
		expect(msg.originLabel).toBe("recovery");
		expect(msg.creator).toBeNull();
	});

	test("an authorless non-agent input remains a normal user turn", async () => {
		const msg = await narratorService.persistSubagentUserMessage("sub1", "continue", TOOL_USE_ID);
		expect(msg.origin).toBe("user");
		expect(msg.creator).toBeNull();
	});
});
