import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { flush, resetSessionStoreForTest } from "@frontend/lib/session-store";
import {
	CHAT_DRAFT_ATTACHMENT_TTL_MS,
	clearChatComposerDraft,
	getChatDraftStorageId,
	persistChatComposerDraft,
	readChatComposerDraft,
	type StoredChatDraftAttachment,
} from "./chat-composer-draft";

const globalObject = globalThis as typeof globalThis & { sessionStorage?: Storage };
const originalSessionStorage = globalObject.sessionStorage;
let values = new Map<string, string>();

beforeEach(() => {
	values = new Map();
	Object.defineProperty(globalObject, "sessionStorage", {
		configurable: true,
		value: {
			get length() {
				return values.size;
			},
			clear: () => values.clear(),
			getItem: (key: string) => values.get(key) ?? null,
			key: (index: number) => [...values.keys()][index] ?? null,
			removeItem: (key: string) => values.delete(key),
			setItem: (key: string, value: string) => values.set(key, value),
		} satisfies Storage,
	});
	resetSessionStoreForTest();
});

afterAll(() => {
	if (originalSessionStorage === undefined) {
		Reflect.deleteProperty(globalObject, "sessionStorage");
	} else {
		Object.defineProperty(globalObject, "sessionStorage", {
			configurable: true,
			value: originalSessionStorage,
		});
	}
});

const NOW = 1_800_000_000_000;
/**
 * Independently written, NOT imported from the module under test.
 *
 * The value there is a mirror of a server constant, and its only protection
 * against drift is that it is asserted somewhere. Importing it would make this
 * test agree with whatever the module says, including a wrong value.
 */
const SERVER_DRAFT_TTL_MS = 24 * 60 * 60 * 1000;

function attachment(overrides: Partial<StoredChatDraftAttachment> = {}): StoredChatDraftAttachment {
	return {
		id: "att-1",
		filename: "screenshot.png",
		sizeBytes: 2048,
		kind: "image",
		mediaType: "image/png",
		uploadedAtMs: NOW,
		...overrides,
	};
}

describe("chat composer draft round-trip", () => {
	test("restores the text and attachments that were stored", () => {
		persistChatComposerDraft(
			"u1",
			"room-1",
			{ text: "half typed", attachments: [attachment()] },
			NOW,
		);
		flush();
		const restored = readChatComposerDraft("u1", "room-1", NOW);
		expect(restored.text).toBe("half typed");
		expect(restored.attachments).toEqual([attachment()]);
	});

	test("an empty composer stores nothing rather than an empty entry", () => {
		persistChatComposerDraft("u1", "room-1", { text: "typed", attachments: [] }, NOW);
		flush();
		expect(values.size).toBe(1);
		// A sent message must not leave a key behind occupying the namespace cap.
		persistChatComposerDraft("u1", "room-1", { text: "", attachments: [] }, NOW);
		flush();
		expect(values.size).toBe(0);
	});

	test("clear removes the entry", () => {
		persistChatComposerDraft("u1", "room-1", { text: "typed", attachments: [] }, NOW);
		flush();
		clearChatComposerDraft("u1", "room-1");
		flush();
		expect(readChatComposerDraft("u1", "room-1", NOW).text).toBe("");
	});

	test("an absent draft reads as empty", () => {
		const restored = readChatComposerDraft("u1", "never-used", NOW);
		expect(restored).toEqual({ text: "", attachments: [] });
	});
});

describe("chat composer draft expiry", () => {
	test("drops an attachment older than the server's reclaim window", () => {
		// Past it the row AND file are gone server-side, so restoring the id could
		// only produce a send that fails.
		const stale = attachment({ uploadedAtMs: NOW - SERVER_DRAFT_TTL_MS - 1 });
		persistChatComposerDraft("u1", "room-1", { text: "still here", attachments: [stale] }, NOW);
		flush();
		const restored = readChatComposerDraft("u1", "room-1", NOW);
		// The TEXT survives: it has no server-side dependency at any age.
		expect(restored.text).toBe("still here");
		expect(restored.attachments).toEqual([]);
	});

	test("keeps an attachment comfortably inside the window", () => {
		const fresh = attachment({ uploadedAtMs: NOW - SERVER_DRAFT_TTL_MS / 2 });
		persistChatComposerDraft("u1", "room-1", { text: "", attachments: [fresh] }, NOW);
		flush();
		expect(readChatComposerDraft("u1", "room-1", NOW).attachments).toHaveLength(1);
	});

	test("expires BEFORE the server's window, not exactly at it", () => {
		// An attachment a second inside the server's window is not safe to restore: the
		// sweep can take it while the send is in flight, and the resulting failure names
		// no file and suggests no fix. So the client's window must be strictly shorter,
		// and this asserts the margin exists rather than trusting the constant.
		const almostReclaimed = attachment({ uploadedAtMs: NOW - SERVER_DRAFT_TTL_MS + 1000 });
		persistChatComposerDraft(
			"u1",
			"room-1",
			{ text: "typed", attachments: [almostReclaimed] },
			NOW,
		);
		flush();
		const restored = readChatComposerDraft("u1", "room-1", NOW);
		expect(restored.attachments).toEqual([]);
		// The text is unaffected: it has no server-side dependency at any age.
		expect(restored.text).toBe("typed");
	});

	test("the client window is shorter than the server's", () => {
		// Stated directly so a future edit that raises the client TTL past the server's
		// fails here rather than in a user's composer.
		expect(CHAT_DRAFT_ATTACHMENT_TTL_MS).toBeLessThan(SERVER_DRAFT_TTL_MS);
		expect(CHAT_DRAFT_ATTACHMENT_TTL_MS).toBeGreaterThan(0);
	});

	test("expiry is per attachment, not per draft", () => {
		// The failure this prevents: attach a file, keep typing in that room for two
		// days, and a draft-level clock would look fresh while the attachment was
		// reclaimed on day one.
		const stale = attachment({ id: "old", uploadedAtMs: NOW - SERVER_DRAFT_TTL_MS - 1 });
		const fresh = attachment({ id: "new", uploadedAtMs: NOW - 60_000 });
		persistChatComposerDraft("u1", "room-1", { text: "", attachments: [stale, fresh] }, NOW);
		flush();
		const restored = readChatComposerDraft("u1", "room-1", NOW);
		expect(restored.attachments.map((item) => item.id)).toEqual(["new"]);
	});

	test("a draft saved long ago still restores a recently uploaded attachment", () => {
		// The save timestamp is irrelevant to attachment validity; only the upload
		// time is. Asserting it here pins that the clock is not the draft's.
		const recent = attachment({ uploadedAtMs: NOW - 1000 });
		persistChatComposerDraft(
			"u1",
			"room-1",
			{ text: "old draft", attachments: [recent] },
			NOW - 10 * SERVER_DRAFT_TTL_MS,
		);
		flush();
		expect(readChatComposerDraft("u1", "room-1", NOW).attachments).toHaveLength(1);
	});
});

describe("chat composer draft validation", () => {
	test("skips attachments missing required fields", () => {
		// A chip rebuilt without an id or a kind could never be sent; dropping the
		// entry is the only honest option.
		const raw = JSON.stringify({
			version: 1,
			savedAtMs: NOW,
			text: "hi",
			attachments: [
				{
					filename: "no-id.png",
					sizeBytes: 1,
					kind: "image",
					mediaType: "image/png",
					uploadedAtMs: NOW,
				},
				{ id: "no-kind", filename: "x", sizeBytes: 1, mediaType: "image/png", uploadedAtMs: NOW },
				{ id: "no-time", filename: "x", sizeBytes: 1, kind: "file", mediaType: "text/plain" },
				attachment({ id: "good" }),
			],
		});
		values.set(`nf.s.chat-draft.${getChatDraftStorageId("u1", "room-1")}`, raw);
		const restored = readChatComposerDraft("u1", "room-1", NOW);
		expect(restored.attachments.map((item) => item.id)).toEqual(["good"]);
	});

	test("malformed JSON reads as empty instead of throwing", () => {
		values.set(`nf.s.chat-draft.${getChatDraftStorageId("u1", "room-1")}`, "{not json");
		expect(() => readChatComposerDraft("u1", "room-1", NOW)).not.toThrow();
		expect(readChatComposerDraft("u1", "room-1", NOW)).toEqual({ text: "", attachments: [] });
	});

	test("an unknown envelope version is discarded", () => {
		values.set(
			`nf.s.chat-draft.${getChatDraftStorageId("u1", "room-1")}`,
			JSON.stringify({ version: 99, savedAtMs: NOW, text: "future", attachments: [] }),
		);
		expect(readChatComposerDraft("u1", "room-1", NOW).text).toBe("");
	});
});

describe("chat composer draft isolation", () => {
	test("different users and rooms get different keys", () => {
		expect(getChatDraftStorageId("user-a", "room-1")).not.toBe(
			getChatDraftStorageId("user-b", "room-1"),
		);
		expect(getChatDraftStorageId("user-a", "room-1")).not.toBe(
			getChatDraftStorageId("user-a", "room-2"),
		);
	});

	test("ambiguous id splits cannot collide", () => {
		// Without the length prefix, ("a_b","c") and ("a","b_c") would address the
		// same entry — one account reading another's draft.
		expect(getChatDraftStorageId("a_b", "c")).not.toBe(getChatDraftStorageId("a", "b_c"));
	});

	test("one user's draft is not visible to another", () => {
		persistChatComposerDraft("u1", "room-1", { text: "mine", attachments: [] }, NOW);
		flush();
		expect(readChatComposerDraft("u2", "room-1", NOW).text).toBe("");
	});
});
