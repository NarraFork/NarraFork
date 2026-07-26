/**
 * vlist-edit-target.ts — Pure, DOM-free decision of WHICH vlist row may be edited
 * (and which row carries an "edited" marker).
 *
 * The chunked path hosts editing inside MessageBubble, so it can consult the
 * message directly. The vlist renders pre-measured rows, so the shell needs a
 * kind-aware predicate: only a user bubble (the whole message) and an assistant
 * markdown body (the message's text) map onto the two backend edit flows:
 *
 *   message-bubble (role=user) → POST /edit-and-regenerate  (onEditAndRegenerate)
 *   markdown (assistant text)  → POST /edit-message         (onEditAssistantMessage)
 *
 * Every other kind — tool cards, subagent cards, system cards, folded traces,
 * permission rows, reasoning — has no editable text of its own and is excluded,
 * matching the chunked path (where only MessageBubble's own user/assistant text
 * branches expose the item).
 */

import type { VListElementKind } from "@shared/pretext-layout/element-kinds";

export type VListEditRole = "user" | "assistant";

export interface VListEditTarget {
	messageId: string;
	role: VListEditRole;
}

/** Capability gates resolved by the shell from the panel handlers + message data. */
export interface VListEditCapabilities {
	/** `onEditAndRegenerate` is available (provider supports rollback/edit/regenerate). */
	canEditUser: boolean;
	/** `onEditAssistantMessage` is available. */
	canEditAssistant: boolean;
	/** The owning message has at least one text block (assistant edit needs text). */
	hasEditableText: boolean;
}

/**
 * Resolve the edit target for a rendered row, or null when the row is not
 * editable. `messageId` must be the row's owning message (the authoritative id
 * the shell already resolved for the row's menu actions).
 */
export function resolveVListEditTarget(
	kind: VListElementKind,
	role: string | undefined,
	messageId: string,
	caps: VListEditCapabilities,
): VListEditTarget | null {
	if (!messageId) return null;
	if (kind === "message-bubble") {
		// Only the USER bubble is a whole-message edit. An assistant "bubble" spec
		// (if ever produced) carries markdown that the markdown kind already covers.
		if (role !== "user") return null;
		return caps.canEditUser ? { messageId, role: "user" } : null;
	}
	if (kind === "markdown") {
		if (!caps.canEditAssistant || !caps.hasEditableText) return null;
		return { messageId, role: "assistant" };
	}
	return null;
}

export interface VListEditedMeta {
	editedAt: string;
	originalContentJson?: unknown[] | null;
}

/**
 * Extract the "edited" marker facts of a message, or undefined when it was never
 * edited. Drives the row menu's "view original" item and the shell's single
 * original-content modal.
 */
export function resolveVListEditedMeta(
	msg:
		| {
				editedAt?: string | null;
				originalContentJson?: unknown[] | null;
		  }
		| undefined
		| null,
): VListEditedMeta | undefined {
	const editedAt = msg?.editedAt;
	if (typeof editedAt !== "string" || editedAt.length === 0) return undefined;
	return { editedAt, originalContentJson: msg?.originalContentJson ?? null };
}

/** True when a message has at least one non-empty text block. */
export function hasEditableTextBlock(contentJson: unknown): boolean {
	if (!Array.isArray(contentJson)) return false;
	return contentJson.some(
		(block) =>
			!!block &&
			typeof block === "object" &&
			(block as { type?: unknown }).type === "text" &&
			typeof (block as { text?: unknown }).text === "string",
	);
}
