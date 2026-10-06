/**
 * Locks the takeover action-slot decision table.
 *
 * Regression this guards: composer-row extraction once early-returned the
 * WHOLE row (input included) when `canTakeover && !hasInput`, so a running
 * non-taken-over subagent had no textarea and the documented "queue a message"
 * path was unreachable. The slot function only chooses the BUTTON cluster;
 * the row must always mount `NarratorComposer` beside it.
 */

import { describe, expect, test } from "bun:test";
import { resolveComposerActionSlot } from "./composer-action-slot";

function slot(overrides: Partial<Parameters<typeof resolveComposerActionSlot>[0]> = {}) {
	return resolveComposerActionSlot({
		canTakeover: false,
		isTakenOver: false,
		hasInput: false,
		hasAttachments: false,
		editing: false,
		...overrides,
	});
}

describe("resolveComposerActionSlot", () => {
	test("running subagent not taken over, empty composer → takeover button (input stays)", () => {
		expect(slot({ canTakeover: true })).toBe("takeover");
	});

	test("running subagent not taken over, user typed → primary so message can queue", () => {
		expect(slot({ canTakeover: true, hasInput: true })).toBe("primary");
	});

	test("running subagent not taken over, attachment only → primary (sendable)", () => {
		expect(slot({ canTakeover: true, hasAttachments: true })).toBe("primary");
	});

	test("editing a message wins over the takeover button", () => {
		expect(slot({ canTakeover: true, editing: true })).toBe("primary");
	});

	test("taken-over subagent → taken-over cluster even when empty", () => {
		expect(slot({ isTakenOver: true })).toBe("taken-over");
		expect(slot({ isTakenOver: true, hasInput: true })).toBe("taken-over");
	});

	test("ordinary narrator idle → primary", () => {
		expect(slot()).toBe("primary");
	});
});
