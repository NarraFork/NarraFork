/**
 * agent-runtime/mailbox-shared.ts — the dialect-neutral kernel of the runtime mailbox.
 *
 * Everything here is a pure function over plain values: no database handle, no drizzle
 * table, no SQLite schema import. Both queue adapters consume this module:
 *
 *   - `mailbox.ts` (SQLite, synchronous) re-exports the public helpers so existing
 *     call sites keep their import paths;
 *   - `postgres-runtime-queue.ts` (PostgreSQL, async) imports them DIRECTLY, so the
 *     PostgreSQL production path never runtime-imports the SQLite mailbox module.
 *
 * Adding a database import to this file breaks that second guarantee — keep it clean.
 */
import { generateId } from "../../lib/id";
import { MAILBOX_LIMITS as L } from "./limits";
import type { MailboxInput } from "./mailbox-types";

/** JSON-encode with a hard byte ceiling; oversized metadata is rejected, never truncated. */
export function boundedJson(value: unknown, limit: number): string {
	const json = JSON.stringify(value);
	if (Buffer.byteLength(json) > limit) throw new Error(`Metadata exceeds ${limit} bytes`);
	return json;
}

/** Bound a stored error string to the diagnostic budget (byte-precise, encoding-safe). */
export function boundedError(error: string): string {
	return Buffer.from(error.slice(0, L.errorBytes)).subarray(0, L.errorBytes).toString("utf8");
}

/** Identity pointers are short opaque strings; reject anything else before it reaches SQL. */
export function pointer(value: string): string {
	if (typeof value !== "string" || !value || Buffer.byteLength(value) > 512)
		throw new Error("Invalid identity pointer");
	return value;
}

/**
 * The delivery dedupe identity. Both backends compute the SAME key for the same input —
 * the unique index on (narrator_id, dedupe_key) is the no-duplicate authority on either
 * engine, so a key computed differently per dialect would split the dedupe domain.
 */
export function mailboxDedupeKey(input: MailboxInput): string {
	pointer(input.narratorId);
	if (input.kind === "agent_message") {
		if (input.recipientMessageId !== undefined) pointer(input.recipientMessageId);
		if (!Number.isSafeInteger(input.sourceAttempt) || input.sourceAttempt < 1)
			throw new Error("Exact execution attempt required");
		return JSON.stringify([
			"send",
			pointer(input.sourceNarratorId),
			pointer(input.sourceToolCallId),
			input.sourceAttempt,
			pointer(input.sourceKey),
			pointer(input.narratorId),
		]);
	}
	if (input.kind === "task_notice") {
		if (input.noticeKind !== "agent" && input.noticeKind !== "bash")
			throw new Error("Invalid notice producer identity");
		return pointer(input.sourceKey);
	}
	if (input.kind !== "user_input") throw new Error("Invalid mailbox input kind");
	return JSON.stringify(["user", pointer(input.requestKey ?? generateId())]);
}
