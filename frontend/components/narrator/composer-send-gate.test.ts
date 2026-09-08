/**
 * The composer send gate: an attachment alone is enough to send.
 *
 * A pasted screenshot with an empty textarea used to be silently unsendable — the
 * send handler returned early on `!input.trim()`. These tests pin the three states
 * the UI must distinguish: nothing to send, text-only, attachment-only.
 */

import { describe, expect, test } from "bun:test";
import {
	type ComposerContentState,
	hasComposerAttachments,
	hasComposerText,
	hasSendableComposerContent,
} from "./composer-send-gate";

function state(overrides: Partial<ComposerContentState> = {}): ComposerContentState {
	return { text: "", imageCount: 0, textFileCount: 0, ...overrides };
}

describe("hasSendableComposerContent", () => {
	test("an empty composer has nothing to send", () => {
		expect(hasSendableComposerContent(state())).toBe(false);
	});

	test("whitespace-only text is not content", () => {
		expect(hasSendableComposerContent(state({ text: "   \n\t" }))).toBe(false);
	});

	test("an image alone is sendable", () => {
		expect(hasSendableComposerContent(state({ imageCount: 1 }))).toBe(true);
	});

	test("a text file alone is sendable", () => {
		expect(hasSendableComposerContent(state({ textFileCount: 1 }))).toBe(true);
	});

	test("a structured file reference alone is sendable without claiming typed text", () => {
		const draft = state({ fileReferenceCount: 1 });
		expect(hasSendableComposerContent(draft)).toBe(true);
		expect(hasComposerAttachments(draft)).toBe(true);
		expect(hasComposerText(draft)).toBe(false);
	});

	test("an image with a blank textarea is sendable", () => {
		expect(hasSendableComposerContent(state({ text: "  ", imageCount: 2 }))).toBe(true);
	});

	test("typed text alone is sendable", () => {
		expect(hasSendableComposerContent(state({ text: "看看这个" }))).toBe(true);
	});
});

describe("content predicates stay independent", () => {
	test("attachments do not make the composer count as having text", () => {
		const composer = state({ imageCount: 1 });
		expect(hasComposerText(composer)).toBe(false);
		expect(hasComposerAttachments(composer)).toBe(true);
	});

	test("text does not make the composer count as having attachments", () => {
		const composer = state({ text: "hi" });
		expect(hasComposerText(composer)).toBe(true);
		expect(hasComposerAttachments(composer)).toBe(false);
	});
});

/**
 * The Enter key is shared: with an empty composer it approves a pending permission,
 * otherwise it sends. An attachment-only draft must keep Enter bound to sending,
 * otherwise pressing Enter would approve a tool call the user never looked at.
 */
describe("permission Enter-hint gating", () => {
	function permHintActive(
		composer: ComposerContentState,
		pendingPermission: { toolName: string } | null,
	): boolean {
		return (
			!hasSendableComposerContent(composer) &&
			!!pendingPermission &&
			pendingPermission.toolName !== "AskUserQuestion"
		);
	}

	test("Enter approves the permission when the composer is empty", () => {
		expect(permHintActive(state(), { toolName: "Bash" })).toBe(true);
	});

	test("a staged image takes Enter back for sending", () => {
		expect(permHintActive(state({ imageCount: 1 }), { toolName: "Bash" })).toBe(false);
	});

	test("a staged text file takes Enter back for sending", () => {
		expect(permHintActive(state({ textFileCount: 1 }), { toolName: "Bash" })).toBe(false);
	});

	test("typed text takes Enter back for sending", () => {
		expect(permHintActive(state({ text: "no" }), { toolName: "Bash" })).toBe(false);
	});

	test("AskUserQuestion owns its own answer UI, so Enter is never rebound", () => {
		expect(permHintActive(state(), { toolName: "AskUserQuestion" })).toBe(false);
	});
});
