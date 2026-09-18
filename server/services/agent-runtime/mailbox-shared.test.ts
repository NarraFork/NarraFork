/**
 * The dialect-neutral mailbox kernel: pure functions only, no database import. This
 * suite exists so the extraction from `mailbox.ts` is pinned — the PostgreSQL adapter
 * imports these DIRECTLY, so a behavioral drift here would split the two backends'
 * dedupe and bounding semantics.
 */
import { expect, test } from "bun:test";
import { MAILBOX_LIMITS } from "./limits";
import { boundedError, boundedJson, mailboxDedupeKey, pointer } from "./mailbox-shared";

test("boundedJson encodes within the byte budget and rejects overflow", () => {
	expect(boundedJson({ a: 1 }, 1024)).toBe('{"a":1}');
	// The budget counts BYTES, not UTF-16 units.
	const oversized = "中".repeat(1024);
	expect(() => boundedJson(oversized, 1024)).toThrow(/exceeds 1024 bytes/);
});

test("boundedError truncates to the error budget in bytes", () => {
	const long = "x".repeat(MAILBOX_LIMITS.errorBytes + 500);
	const bounded = boundedError(long);
	expect(Buffer.byteLength(bounded)).toBeLessThanOrEqual(MAILBOX_LIMITS.errorBytes);
	expect(boundedError("short")).toBe("short");
});

test("pointer accepts short opaque identities and rejects the rest", () => {
	expect(pointer("abc-123")).toBe("abc-123");
	expect(() => pointer("")).toThrow("Invalid identity pointer");
	expect(() => pointer("y".repeat(513))).toThrow("Invalid identity pointer");
});

test("mailboxDedupeKey is stable per kind and rejects malformed execution identity", () => {
	const agentInput = {
		kind: "agent_message" as const,
		narratorId: "recipient",
		text: "hello",
		projectedByteSize: 5,
		sourceNarratorId: "sender",
		sourceToolCallId: "call-1",
		sourceAttempt: 2,
		sourceKey: "receipt-1",
	};
	const key = mailboxDedupeKey(agentInput);
	expect(key).toBe(mailboxDedupeKey({ ...agentInput }));
	const parsed = JSON.parse(key);
	expect(parsed).toEqual(["send", "sender", "call-1", 2, "receipt-1", "recipient"]);
	// A different attempt is a different delivery.
	expect(mailboxDedupeKey({ ...agentInput, sourceAttempt: 3 })).not.toBe(key);
	expect(() => mailboxDedupeKey({ ...agentInput, sourceAttempt: 0 })).toThrow(
		"Exact execution attempt required",
	);

	const noticeKey = mailboxDedupeKey({
		kind: "task_notice",
		narratorId: "recipient",
		text: "summary",
		projectedByteSize: 7,
		noticeKind: "bash",
		sourceKey: "publication-key",
	});
	expect(noticeKey).toBe("publication-key");

	const userKey = mailboxDedupeKey({
		kind: "user_input",
		narratorId: "recipient",
		text: "hi",
		projectedByteSize: 2,
		requestKey: "request-1",
	});
	expect(userKey).toBe(JSON.stringify(["user", "request-1"]));
	// Without a caller request key each call is a fresh identity (generated id).
	const generated = mailboxDedupeKey({
		kind: "user_input",
		narratorId: "recipient",
		text: "hi",
		projectedByteSize: 2,
	});
	expect(JSON.parse(generated)[0]).toBe("user");
	expect(generated).not.toBe(
		mailboxDedupeKey({
			kind: "user_input",
			narratorId: "recipient",
			text: "hi",
			projectedByteSize: 2,
		}),
	);
});
