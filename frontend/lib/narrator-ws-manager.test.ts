import { describe, expect, test } from "bun:test";
import { matchesListenerFilter, shouldDeliverToListener } from "./narrator-ws-manager";

describe("matchesListenerFilter", () => {
	test("matches a narrator-scoped listener by narratorId", () => {
		expect(matchesListenerFilter({ narratorIds: ["n1"] }, "status_change", "n1")).toBe(true);
		expect(matchesListenerFilter({ narratorIds: ["n1"] }, "status_change", "n2")).toBe(false);
	});

	test("wildcard listeners match any narrator", () => {
		expect(matchesListenerFilter({ narratorIds: "*" }, "status_change", "n9")).toBe(true);
	});

	test("type filters gate delivery", () => {
		expect(
			matchesListenerFilter({ narratorIds: ["n1"], types: ["status_change"] }, "message", "n1"),
		).toBe(false);
		expect(
			matchesListenerFilter(
				{ narratorIds: ["n1"], types: ["status_change"] },
				"status_change",
				"n1",
			),
		).toBe(true);
	});
});

describe("shouldDeliverToListener", () => {
	const listListener = { narratorIds: ["n1"], subscriptionId: 1 };
	const messagesListener = { narratorIds: ["n1"], subscriptionId: 2 };

	test("realtime frames (no requestId) reach every matching listener", () => {
		expect(shouldDeliverToListener(listListener, "status_change", "n1", undefined, undefined)).toBe(
			true,
		);
		expect(
			shouldDeliverToListener(messagesListener, "status_change", "n1", undefined, undefined),
		).toBe(true);
	});

	test("request-scoped frames only reach the requesting subscription", () => {
		// A streaming_snapshot requested by the messages subscription (handle 2).
		expect(shouldDeliverToListener(messagesListener, "streaming_snapshot", "n1", "req-2", 2)).toBe(
			true,
		);
		// The sibling list subscription (handle 1) must NOT receive it.
		expect(shouldDeliverToListener(listListener, "streaming_snapshot", "n1", "req-2", 2)).toBe(
			false,
		);
	});

	test("subscription-scoped frames with an unknown target are dropped", () => {
		expect(
			shouldDeliverToListener(messagesListener, "catch_up", "n1", "req-stale", undefined),
		).toBe(false);
	});

	test("business requestId frames are realtime frames when no subscriptionRequestId is present", () => {
		expect(
			shouldDeliverToListener(messagesListener, "permission_resolved", "n1", undefined, undefined),
		).toBe(true);
	});

	test("request-scoped delivery still applies the type/narrator filter", () => {
		// Correct subscription, but the narrator does not match.
		expect(
			shouldDeliverToListener(
				{ narratorIds: ["other"], subscriptionId: 2 },
				"streaming_snapshot",
				"n1",
				"req-2",
				2,
			),
		).toBe(false);
	});
});
