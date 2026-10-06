/**
 * Strip provider-internal citation markers from the model-facing history.
 *
 * Historical assistant rows were persisted before citations became structured,
 * so their `contentJson` text blocks and `contentText` may still contain
 * `citeturn…` markers. Replaying those verbatim teaches the model that the
 * markers are part of its own output format, and it keeps emitting them — the
 * leak becomes self-sustaining even after the ingress path is fixed.
 *
 * Cleaning happens in `buildHistory`, one boundary shared by every provider
 * adapter, and only on in-memory copies: the persisted rows are left intact so
 * the UI can keep rendering them (it applies the same shared projection).
 *
 * Only `role === "assistant"` text is touched. User messages are excluded
 * deliberately — a user may be quoting the marker to ask about it, and silently
 * rewriting their words would be worse than the leak.
 */

import { cleanAssistantText, hasLegacyCitationMarkers } from "@shared/citations";
import type { DbMessage } from "./provider";

export function stripCitationMarkersForModel(dbMessages: DbMessage[]): DbMessage[] {
	let changedAny = false;
	const out = dbMessages.map((msg) => {
		if (msg.role !== "assistant") return msg;
		const cleaned = cleanAssistantMessage(msg);
		if (cleaned !== msg) changedAny = true;
		return cleaned;
	});
	return changedAny ? out : dbMessages;
}

function cleanAssistantMessage(msg: DbMessage): DbMessage {
	let contentJson = msg.contentJson;
	let contentChanged = false;

	if (Array.isArray(msg.contentJson)) {
		const blocks = msg.contentJson as Array<Record<string, unknown>>;
		const next = blocks.map((block) => {
			if (!block || block.type !== "text" || typeof block.text !== "string") return block;
			if (!hasLegacyCitationMarkers(block.text)) return block;
			const cleaned = cleanAssistantText(block.text);
			if (!cleaned.changed) return block;
			contentChanged = true;
			return { ...block, text: cleaned.text };
		});
		if (contentChanged) contentJson = next;
	}

	let contentText = msg.contentText;
	if (typeof contentText === "string" && hasLegacyCitationMarkers(contentText)) {
		const cleaned = cleanAssistantText(contentText);
		if (cleaned.changed) {
			contentText = cleaned.text;
			contentChanged = true;
		}
	}

	if (!contentChanged) return msg;
	return { ...msg, contentJson, contentText };
}
