import { useNarratorWS } from "@frontend/hooks/useNarratorWS";
import type { TreeMessage } from "@frontend/lib/api";
import {
	getValidReasoningTranslationParts,
	type ReasoningTranslationPatch,
} from "@shared/reasoning-translation";
import { useCallback, useEffect, useRef } from "react";
import type { LivePatch, LivePatchResult } from "./vlist-live-patch";

export function patchReasoningTranslation(
	messages: readonly TreeMessage[],
	patch: ReasoningTranslationPatch,
): LivePatchResult {
	const index = messages.findIndex(
		(row) => row.id === patch.messageId && row.narratorId === patch.ownerNarratorId,
	);
	const unchanged = { messages, changed: false };
	const message = messages[index];
	if (!message) return unchanged;
	let changed = false;
	const blocks = message.blocks.map((block) => {
		if (!block.named || block.id !== patch.blockId || block.revision < patch.blockRevision)
			return block;
		const elements = block.elements.map((element) => {
			if (
				(element.type !== "reasoning" && element.type !== "thinking") ||
				element.id !== patch.elementId ||
				element.translatedText ||
				(element.translationGeneration !== patch.translationGeneration &&
					!(element.translationGeneration === undefined && block.revision === patch.blockRevision))
			)
				return element;
			const text = element.thinking ?? element.text ?? "";
			if (
				typeof text !== "string" ||
				!getValidReasoningTranslationParts(text, patch.translationGeneration, [patch.part]).length
			)
				return element;
			const current = getValidReasoningTranslationParts(
				text,
				patch.translationGeneration,
				element.translationParts,
			);
			if (
				current.length >= 64 ||
				current.some(
					(part) =>
						part.id === patch.part.id ||
						(part.start < patch.part.end && patch.part.start < part.end),
				)
			)
				return element;
			changed = true;
			return {
				...element,
				translationGeneration: patch.translationGeneration,
				translationParts: [...current, patch.part].sort((a, b) => a.start - b.start),
			};
		});
		return elements.some((element, offset) => element !== block.elements[offset])
			? { ...block, elements }
			: block;
	});
	if (!changed) return unchanged;
	const next = [...messages];
	next[index] = {
		...message,
		blocks,
		stateRevision: Math.max(message.stateRevision ?? 0, patch.stateRevision),
	};
	return { messages: next, changed: true };
}

const MAX_PATCHES = 128;
const MAX_RETAINED_CODE_UNITS = 512 * 1024;

function patchSize(patch: ReasoningTranslationPatch) {
	return patch.part.sourceText.length + patch.part.translatedText.length;
}

/** A page or reconnect started before the patch can arrive after it. */
export class RetainedTranslationPatches {
	private patches = new Map<string, ReasoningTranslationPatch>();
	private retainedSize = 0;

	remember(patch: ReasoningTranslationPatch) {
		const key = JSON.stringify([
			patch.messageId,
			patch.blockId,
			patch.translationGeneration,
			patch.part.id,
		]);
		if (this.patches.has(key)) return;
		const size = patchSize(patch);
		while (this.patches.size >= MAX_PATCHES || this.retainedSize + size > MAX_RETAINED_CODE_UNITS) {
			const oldest = this.patches.entries().next().value;
			if (!oldest) return;
			this.patches.delete(oldest[0]);
			this.retainedSize -= patchSize(oldest[1]);
		}
		this.patches.set(key, patch);
		this.retainedSize += size;
	}

	apply: LivePatch = (messages) => {
		let next = messages;
		for (const patch of this.patches.values())
			next = patchReasoningTranslation(next, patch).messages;
		return { messages: next, changed: next !== messages };
	};
}

export function useReasoningTranslationLivePatches(
	narratorId: string | undefined,
	messages: readonly TreeMessage[],
	applyLivePatch: (patch: LivePatch) => boolean,
) {
	const current = useRef({ narratorId, store: new RetainedTranslationPatches() });
	if (current.current.narratorId !== narratorId)
		current.current = { narratorId, store: new RetainedTranslationPatches() };
	const replay = useCallback(() => {
		if (narratorId === current.current.narratorId) applyLivePatch(current.current.store.apply);
	}, [applyLivePatch, narratorId]);
	// biome-ignore lint/correctness/useExhaustiveDependencies: a newly loaded/replaced page needs replay
	useEffect(replay, [messages, replay]);
	useNarratorWS(
		narratorId,
		{
			onReasoningTranslationPatch: (patch) => {
				if (patch.narratorId !== narratorId || current.current.narratorId !== narratorId) return;
				current.current.store.remember(patch);
				replay();
			},
		},
		undefined,
		{ kind: "messages" },
	);
}
