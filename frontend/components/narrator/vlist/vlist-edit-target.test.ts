/** vlist-edit-target.test.ts — unit tests for the row edit-target predicates. */

import { describe, expect, it } from "bun:test";
import {
	hasEditableTextBlock,
	resolveVListEditedMeta,
	resolveVListEditorWidth,
	resolveVListEditTarget,
	VLIST_USER_EDITOR_MIN_WIDTH,
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
			"tool-run-count",
			"activity-trace",
			"reasoning-count",
			"tool-call-group",
			"ask-user-question",
			"inline-permission",
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

/**
 * The editor's width while it replaces a row.
 *
 * A user bubble is right-aligned and shrink-wrapped, so its editor has to stay on
 * that side — expanding to the full column moved every control (caret, attach,
 * submit) a whole column away from the bubble the reader was hovering. Assistant
 * rows are already full-width, so they opt out with null.
 */
describe("resolveVListEditorWidth", () => {
	const COLUMN = 860;

	it("keeps a wide user bubble at its own width", () => {
		expect(resolveVListEditorWidth("message-bubble", "user", 600, COLUMN)).toBe(600);
	});

	it("floors a shrink-wrapped short bubble at a usable editing width", () => {
		// "ok" measures ~140px (the header floor). Editing it in a 140px box is not
		// usable, so the floor wins.
		expect(resolveVListEditorWidth("message-bubble", "user", 140, COLUMN)).toBe(
			VLIST_USER_EDITOR_MIN_WIDTH,
		);
	});

	it("never exceeds the row's column width", () => {
		// Narrow viewport: the floor must not push the editor past the column and
		// cause horizontal overflow.
		expect(resolveVListEditorWidth("message-bubble", "user", 140, 320)).toBe(320);
		expect(resolveVListEditorWidth("message-bubble", "user", 900, COLUMN)).toBe(COLUMN);
	});

	it("leaves non-user rows at full width", () => {
		expect(resolveVListEditorWidth("message-bubble", "assistant", 600, COLUMN)).toBeNull();
		expect(resolveVListEditorWidth("markdown", undefined, 600, COLUMN)).toBeNull();
	});

	it("declines to constrain against an unmeasured column", () => {
		expect(resolveVListEditorWidth("message-bubble", "user", 600, 0)).toBeNull();
		expect(resolveVListEditorWidth("message-bubble", "user", 600, Number.NaN)).toBeNull();
	});

	it("tolerates a missing bubble width", () => {
		// A row whose measured usedWidth is unavailable still gets the floor rather
		// than a zero-width editor.
		expect(resolveVListEditorWidth("message-bubble", "user", Number.NaN, COLUMN)).toBe(
			VLIST_USER_EDITOR_MIN_WIDTH,
		);
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
