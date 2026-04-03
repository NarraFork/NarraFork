import type { BaseContentBlock } from "../../lib/api";
import type { NarratorMsg } from "./narrator-panel-types";

export function getUserMessageBlurAnimationId(messageId?: string | null) {
	return messageId ? `user-msg:${messageId}` : null;
}

export function getToolCallBlurAnimationId({
	toolUseId,
	messageId,
	fallbackKey,
}: {
	toolUseId?: string | null;
	messageId?: string | null;
	fallbackKey?: string | number | null;
}) {
	if (toolUseId) return `tool:${toolUseId}`;
	if (messageId) {
		return fallbackKey != null ? `tool:${messageId}:${fallbackKey}` : `tool:${messageId}`;
	}
	return fallbackKey != null ? `tool:ephemeral:${fallbackKey}` : null;
}

function collectToolCallIds(msg: NarratorMsg, acc: Set<string>) {
	const blockIds = new Set<string>();
	for (const [idx, block] of (
		(msg.contentJson as BaseContentBlock[] | undefined) ?? []
	).entries()) {
		if (block.type !== "tool_use") continue;
		const animationId = getToolCallBlurAnimationId({
			toolUseId: typeof block.id === "string" ? block.id : undefined,
			messageId: msg.id,
			fallbackKey: idx,
		});
		if (animationId) {
			acc.add(animationId);
			if (typeof block.id === "string") blockIds.add(block.id);
		}
	}

	for (const [idx, tc] of (
		((msg.toolCalls ?? []) as Array<{ toolUseId?: string | null; id?: string | null }>) ?? []
	).entries()) {
		if (tc.toolUseId && blockIds.has(tc.toolUseId)) continue;
		const animationId = getToolCallBlurAnimationId({
			toolUseId: tc.toolUseId,
			messageId: msg.id,
			fallbackKey: tc.id ?? idx,
		});
		if (animationId) acc.add(animationId);
	}
}

export function collectBlurInAnimationIdsFromMessage(msg: NarratorMsg, acc = new Set<string>()) {
	if (msg.role === "user") {
		const animationId = getUserMessageBlurAnimationId(msg.id);
		if (animationId) acc.add(animationId);
	}

	collectToolCallIds(msg, acc);

	for (const child of msg.children ?? []) {
		collectBlurInAnimationIdsFromMessage(child as NarratorMsg, acc);
	}

	return acc;
}

export function collectBlurInAnimationIdsFromMessages(messages: NarratorMsg[]) {
	const acc = new Set<string>();
	for (const msg of messages) {
		collectBlurInAnimationIdsFromMessage(msg, acc);
	}
	return [...acc];
}
