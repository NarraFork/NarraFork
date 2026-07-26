/** vlist-edit-target.test.ts — unit tests for the row edit-target predicates. */

import { describe, expect, it } from "bun:test";
import {
	hasEditableTextBlock,
	resolveVListEditedMeta,
	resolveVListEditTarget,
	type VListEditCapabilities,
} from "./vlist-edit-target";

const MSG = "msg-1";
const ALL: VListEditCapabilities = {
	canEditUser: true,
	canEditAssistant: true,
	hasEditableText: true,
};

describe("resolveVListEditTarget", () => {
	it("maps a user bubble to the user edit flow", () => {
		expect(resolveVListEditTarget("message-bubble", "user", MSG, ALL)).toEqual({
			messageId: MSG,
			role: "user",
		});
	});

	it("maps an assistant markdown row to the assistant edit flow", () => {
		expect(resolveVListEditTarget("markdown", undefined, MSG, ALL)).toEqual({
			messageId: MSG,
			role: "assistant",
		});
	});

	it("rejects a non-user bubble (assistant markdown covers that case)", () => {
		expect(resolveVListEditTarget("message-bubble", "assistant", MSG, ALL)).toBeNull();
	});

	it("rejects every other kind", () => {
		for (const kind of [
			"tool-call",
			"subagent-card",
			"reasoning",
			"reasoning-steps",
			"system-simple",
			"system-text",
			"knowledge-hint",
			"plan-card",
			"ask-in-passing",
			"web-search",
			"media",
			"tool-run-summary",
			"tool-run-count",
			"activity-trace",
			"reasoning-count",
			"tool-call-group",
			"ask-user-question",
			"inline-permission",
			"prune-divider",
		] as const) {
			expect(resolveVListEditTarget(kind, undefined, MSG, ALL)).toBeNull();
		}
	});

	it("respects the per-flow capability gates", () => {
		expect(
			resolveVListEditTarget("message-bubble", "user", MSG, { ...ALL, canEditUser: false }),
		).toBeNull();
		expect(
			resolveVListEditTarget("markdown", undefined, MSG, { ...ALL, canEditAssistant: false }),
		).toBeNull();
	});

	it("requires an editable text block for the assistant flow only", () => {
		const noText = { ...ALL, hasEditableText: false };
		expect(resolveVListEditTarget("markdown", undefined, MSG, noText)).toBeNull();
		// A user bubble may be attachments-only, so text is not required there.
		expect(resolveVListEditTarget("message-bubble", "user", MSG, noText)).toEqual({
			messageId: MSG,
			role: "user",
		});
	});

	it("rejects an empty message id", () => {
		expect(resolveVListEditTarget("message-bubble", "user", "", ALL)).toBeNull();
		expect(resolveVListEditTarget("markdown", undefined, "", ALL)).toBeNull();
	});
});

describe("resolveVListEditedMeta", () => {
	it("returns undefined when the message was never edited", () => {
		expect(resolveVListEditedMeta(undefined)).toBeUndefined();
		expect(resolveVListEditedMeta(null)).toBeUndefined();
		expect(resolveVListEditedMeta({})).toBeUndefined();
		expect(resolveVListEditedMeta({ editedAt: null })).toBeUndefined();
		expect(resolveVListEditedMeta({ editedAt: "" })).toBeUndefined();
	});

	it("carries editedAt and the captured original content", () => {
		const original = [{ type: "text", text: "before" }];
		expect(
			resolveVListEditedMeta({ editedAt: "2026-01-01T00:00:00Z", originalContentJson: original }),
		).toEqual({ editedAt: "2026-01-01T00:00:00Z", originalContentJson: original });
	});

	it("normalizes a missing original payload to null", () => {
		expect(resolveVListEditedMeta({ editedAt: "2026-01-01T00:00:00Z" })).toEqual({
			editedAt: "2026-01-01T00:00:00Z",
			originalContentJson: null,
		});
	});
});

describe("hasEditableTextBlock", () => {
	it("detects a text block", () => {
		expect(hasEditableTextBlock([{ type: "text", text: "hi" }])).toBe(true);
		expect(hasEditableTextBlock([{ type: "tool_use" }, { type: "text", text: "" }])).toBe(true);
	});

	it("returns false without one", () => {
		expect(hasEditableTextBlock([])).toBe(false);
		expect(hasEditableTextBlock(undefined)).toBe(false);
		expect(hasEditableTextBlock("nope")).toBe(false);
		expect(hasEditableTextBlock([{ type: "tool_use" }, { type: "thinking" }])).toBe(false);
		// A text block whose text is not a string cannot be edited.
		expect(hasEditableTextBlock([{ type: "text", text: 42 }])).toBe(false);
	});
});
