import { afterAll, afterEach, describe, expect, mock, test } from "bun:test";
import { getTestDb } from "../../../tests/setup";
import type { AgentReplyScope } from "../agent-reply-waiter";

// Use a REAL in-memory test db (not an empty stub) so importing
// agent-communication's transitive db-dependent modules works AND so this file
// does not leak broken db methods into later suites via Bun's global module
// mock registry. See tests/preload notes on mock.module cross-file leakage.
const { db, sqlite } = getTestDb();
// Snapshot real db before mocking; afterAll re-points it back (Bun mock.module is global and leaks; mock.restore() does not undo it).
const realDbModule = { ...(await import("../../db")) };
mock.module("../../db", () => ({ db, sqlite }));

const { resolveIncomingSendReplies } = await import("../agent-communication");
const {
	clearPendingAgentReplyWaits,
	getPendingAgentReplyCount,
	hasPendingAgentReply,
	registerAgentReplyWait,
} = await import("../agent-reply-waiter");

const FROM = "responder-narrator"; // the narrator sending the reply
const A = "requester-a";
const B = "requester-b";
const scopeFor = (id: string): AgentReplyScope => ({ type: "parent-child", id: `${FROM}:${id}` });

afterEach(() => {
	clearPendingAgentReplyWaits();
});

afterAll(() => {
	mock.module("../../db", () => realDbModule);
	mock.restore();
});

describe("resolveIncomingSendReplies — two-phase (detect, then settle)", () => {
	test("returns null when no target has a pending reply (ordinary Send)", () => {
		const result = resolveIncomingSendReplies(
			FROM,
			[{ id: A, scope: scopeFor(A) }],
			"just a normal message",
		);
		expect(result).toBeNull();
	});

	test("delivers a reply to a single waiting target", async () => {
		const wait = registerAgentReplyWait({
			requesterId: A,
			responderId: FROM,
			scope: scopeFor(A),
		});
		const result = resolveIncomingSendReplies(
			FROM,
			[{ id: A, scope: scopeFor(A) }],
			"here is my answer",
		);
		expect(result).not.toBeNull();
		expect(result?.targets).toHaveLength(1);
		expect(result?.targets[0]).toMatchObject({ id: A, status: "completed" });
		expect(await wait.promise).toMatchObject({ status: "replied", message: "here is my answer" });
	});

	test("does NOT settle any waiter when replies are mixed with an ordinary target", async () => {
		// A is waiting for a reply; B is not. A mixed Send must be rejected as a
		// whole WITHOUT delivering to A (the regression: A was resumed while the
		// caller was told the Send failed → duplicate delivery on resend).
		const waitA = registerAgentReplyWait({
			requesterId: A,
			responderId: FROM,
			scope: scopeFor(A),
		});

		const result = resolveIncomingSendReplies(
			FROM,
			[
				{ id: A, scope: scopeFor(A) },
				{ id: B, scope: scopeFor(B) },
			],
			"mixed message",
		);

		// The whole call is reported failed.
		expect(result).not.toBeNull();
		expect(result?.targets.every((t) => t.status === "failed")).toBe(true);
		expect(result?.output.toLowerCase()).toContain("cannot mix");

		// Critically: A's waiter is STILL pending (was not settled/delivered).
		expect(hasPendingAgentReply(A, FROM, scopeFor(A))).toBe(true);
		expect(getPendingAgentReplyCount(A, FROM, scopeFor(A))).toBe(1);
		waitA.cancel();
		expect(await waitA.promise).toEqual({ status: "cancelled" });
	});

	test("delivers to every target when ALL are waiting replies", async () => {
		const waitA = registerAgentReplyWait({ requesterId: A, responderId: FROM, scope: scopeFor(A) });
		const waitB = registerAgentReplyWait({ requesterId: B, responderId: FROM, scope: scopeFor(B) });

		const result = resolveIncomingSendReplies(
			FROM,
			[
				{ id: A, scope: scopeFor(A) },
				{ id: B, scope: scopeFor(B) },
			],
			"answer to both",
		);
		expect(result?.targets).toHaveLength(2);
		expect(result?.targets.every((t) => t.status === "completed")).toBe(true);
		expect(await waitA.promise).toMatchObject({ status: "replied", message: "answer to both" });
		expect(await waitB.promise).toMatchObject({ status: "replied", message: "answer to both" });
	});

	test("an explicit replyTo must address exactly one target", () => {
		const result = resolveIncomingSendReplies(
			FROM,
			[
				{ id: A, scope: scopeFor(A) },
				{ id: B, scope: scopeFor(B) },
			],
			"reply",
			"some-request-id",
		);
		expect(result?.targets.every((t) => t.status === "failed")).toBe(true);
		expect(result?.output).toContain("exactly one requester");
	});
});
