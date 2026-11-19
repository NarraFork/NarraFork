import { blockAtIndex, type MessageWithBody } from "../narrator-blocks/message-blocks";
import {
	getValidReasoningTranslationParts,
	preserveReasoningTranslationWhitespace,
	type ReasoningTranslationActivity,
	type ReasoningTranslationFields,
	type ReasoningTranslationVisibilityGroup,
	type ReasoningTranslationVisibilityTarget,
} from "../reasoning-translation";
import type { ReasoningSegment } from "./reasoning-segments";
import { isLiveStreamingBlock, STREAMING_MESSAGE_ID } from "./streaming-live-blocks";

export const REASONING_VISIBILITY_MAX_SOURCE_CHARS = 256 * 1024;

export interface ReasoningTranslationSourceRange {
	start: number;
	end: number;
	target: ReasoningTranslationVisibilityTarget;
}

export type ReasoningTranslationGroup = Pick<
	ReasoningTranslationVisibilityGroup,
	"groupId" | "anchor"
>;

/** Original-source ranges prove element visibility; server-owned ranges authorize translation. */
export interface ReasoningTranslationSource {
	text: string;
	ranges: ReasoningTranslationSourceRange[];
	group?: ReasoningTranslationGroup;
}

interface SourceElement extends ReasoningTranslationFields {
	type: string;
	id?: unknown;
	thinking?: string | null;
	text?: string | null;
	translatedText?: string | null;
	revision?: unknown;
}

interface SourceMessage extends MessageWithBody<SourceElement> {
	id?: string;
	narratorId?: string | null;
	liveContentProjection?: boolean;
	liveBlockIndex?: number | null;
	reasoningTranslationActivity?: ReasoningTranslationActivity | null;
}

/** Undefined is settled history; an empty list is an entirely active source. */
function completedSourceRanges(
	message: SourceMessage | undefined,
	block: SourceElement,
	index: number,
): readonly { start: number; end: number }[] | undefined {
	const activity = message?.reasoningTranslationActivity;
	if (activity && block.id === activity.elementId) {
		// A later source revision can reopen a previously completed prefix. Until its
		// authority arrives, no cached result from the older state may cover the tail.
		if (typeof block.revision === "number" && block.revision > activity.revision) return [];
		return activity.completedRanges;
	}
	return isLiveStreamingBlock(message?.id === STREAMING_MESSAGE_ID, message, index)
		? []
		: undefined;
}

/** A translated part is indivisible: visual ownership includes its entire displayed replacement. */
export function reasoningTranslationDisplayRange(
	block: SourceElement,
	start: number,
	end: number,
): { start: number; end: number; translationRevision?: string } {
	const raw = block.thinking ?? block.text ?? "";
	const parts = getValidReasoningTranslationParts(
		raw,
		block.translationGeneration,
		block.translationParts,
	);
	if (!block.translationGeneration && !block.translationParts && block.translatedText) {
		return {
			start: start < raw.length ? 0 : block.translatedText.length,
			end: end > 0 ? block.translatedText.length : 0,
			translationRevision: JSON.stringify([block.translatedText]),
		};
	}
	let delta = 0;
	let displayStart = start;
	let displayEnd = end;
	const replacements: string[] = [];
	for (const part of parts) {
		const length = preserveReasoningTranslationWhitespace(
			part.sourceText,
			part.translatedText,
		).length;
		const outputStart = part.start + delta;
		if (part.end <= start) displayStart += length - (part.end - part.start);
		else if (part.start < start) displayStart = outputStart;
		if (part.end <= end) displayEnd += length - (part.end - part.start);
		else if (part.start < end) displayEnd = outputStart + length;
		if (part.start < end && part.end > start) replacements.push(part.id, part.translatedText);
		delta += length - (part.end - part.start);
	}
	return {
		start: displayStart,
		end: displayEnd,
		...(replacements.length ? { translationRevision: JSON.stringify(replacements) } : {}),
	};
}

/** The same per-range translation eligibility is used for rendering and measurement. */
export function reasoningTranslationDisplayBlock<T extends SourceElement>(
	message: SourceMessage | undefined,
	block: T,
	index: number,
): T {
	const completed = completedSourceRanges(message, block, index);
	if (completed === undefined) return block;
	const raw = block.thinking ?? block.text ?? "";
	const contains = (start: number, end: number) =>
		completed.some((range) => range.start <= start && range.end >= end);
	return {
		...block,
		translatedText: contains(0, raw.length) ? block.translatedText : undefined,
		// Never split a translated part: there is no valid mapping from translated
		// characters back to a partially completed original source interval.
		translationParts:
			block.translationGeneration || block.translationParts
				? getValidReasoningTranslationParts(
						raw,
						block.translationGeneration,
						block.translationParts,
					).filter((part) => contains(part.start, part.end))
				: undefined,
	};
}

function sourceTarget(
	message: SourceMessage,
	block: SourceElement,
	index: number,
): ReasoningTranslationVisibilityTarget | undefined {
	const held = blockAtIndex(message, index);
	if (!message.id || !message.narratorId || !held?.named) return;
	return {
		ownerNarratorId: message.narratorId,
		messageId: message.id,
		blockId: held.id,
		...(typeof block.id === "string" && block.id
			? { elementId: block.id }
			: { legacyIndex: index, legacyVersion: held.revision }),
	};
}

function sourceGroup(anchor: ReasoningTranslationVisibilityTarget): ReasoningTranslationGroup {
	// Revision is a cache/CAS coordinate, not the identity of the visual run.
	const identity = JSON.stringify([
		anchor.ownerNarratorId,
		anchor.messageId,
		anchor.blockId,
		anchor.elementId ?? anchor.legacyIndex,
	]);
	let hash = 0xcbf29ce484222325n;
	for (let index = 0; index < identity.length; index++) {
		hash ^= BigInt(identity.charCodeAt(index));
		hash = BigInt.asUintN(64, hash * 0x100000001b3n);
	}
	return { groupId: `reasoning-${hash.toString(16).padStart(16, "0")}`, anchor };
}

/** Keep original element positions through adjacent-run merging and step splitting. */
export function reasoningTranslationSource(
	message: SourceMessage | undefined,
	entries: readonly { block: SourceElement; index: number }[],
	original = false,
): ReasoningTranslationSource | undefined {
	if (!message?.id || message.id === "__streaming__" || entries.length > 256) return;
	let sourceChars = 0;
	for (const { block } of entries) {
		sourceChars +=
			(block.thinking ?? block.text ?? "").length + (block.translatedText?.length ?? 0) + 2;
		const parts = Array.isArray(block.translationParts) ? block.translationParts : [];
		if (sourceChars > REASONING_VISIBILITY_MAX_SOURCE_CHARS || parts.length > 1024) return;
		for (const part of parts) {
			sourceChars += typeof part?.translatedText === "string" ? part.translatedText.length : 0;
			if (sourceChars > REASONING_VISIBILITY_MAX_SOURCE_CHARS) return;
		}
	}
	const first = entries[0];
	const anchor = first && sourceTarget(message, first.block, first.index);
	const group = anchor ? sourceGroup(anchor) : undefined;
	const ranges: ReasoningTranslationSourceRange[] = [];
	let text = "";
	for (const { block: sourceBlock, index } of entries) {
		const block = reasoningTranslationDisplayBlock(message, sourceBlock, index);
		const raw = block.thinking ?? block.text ?? "";
		const addVisibleSource = (start: number, end: number, outputStart: number) => {
			// An active original fragment can prove this persisted element is visible.
			// That is not permission to translate it: the server still limits work to
			// its completed ranges, while display parts above obey the same boundary.
			if (target && start < end)
				ranges.push({ start: outputStart, end: outputStart + end - start, target });
		};
		if (!raw) continue;
		if (text) text += "\n\n";
		const target = raw.trim() ? sourceTarget(message, block, index) : undefined;
		if (!block.translationGeneration && !block.translationParts && block.translatedText) {
			text += original ? raw : block.translatedText;
			continue;
		}
		const parts = getValidReasoningTranslationParts(
			raw,
			block.translationGeneration,
			block.translationParts,
		);
		let cursor = 0;
		for (const part of parts) {
			if (part.start > cursor) {
				const from = text.length;
				text += raw.slice(cursor, part.start);
				addVisibleSource(cursor, part.start, from);
			}
			text += original
				? part.sourceText
				: preserveReasoningTranslationWhitespace(part.sourceText, part.translatedText);
			cursor = part.end;
		}
		if (cursor < raw.length) {
			const from = text.length;
			text += raw.slice(cursor);
			addVisibleSource(cursor, raw.length, from);
		}
	}
	return ranges.length || group ? { text, ranges, ...(group ? { group } : {}) } : undefined;
}

/** Project parser-normalized paragraphs without inventing source coordinates. */
function projectText(
	source: ReasoningTranslationSource,
	text: string,
	cursor: number,
): { source: ReasoningTranslationSource; cursor: number } {
	const ranges: ReasoningTranslationSourceRange[] = [];
	let outputOffset = 0;
	for (const paragraph of text.split("\n\n")) {
		const found = paragraph ? source.text.indexOf(paragraph, cursor) : -1;
		if (found >= 0) {
			for (const range of source.ranges) {
				const start = Math.max(found, range.start);
				const end = Math.min(found + paragraph.length, range.end);
				if (start < end)
					ranges.push({
						start: outputOffset + start - found,
						end: outputOffset + end - found,
						target: range.target,
					});
			}
			cursor = found + paragraph.length;
		}
		outputOffset += paragraph.length + 2;
	}
	return { source: { text, ranges, ...(source.group ? { group: source.group } : {}) }, cursor };
}

export interface ReasoningTranslationStepSource {
	group?: ReasoningTranslationGroup;
	title?: ReasoningTranslationSource;
	body?: ReasoningTranslationSource;
}

export function reasoningTranslationStepSources(
	segments: readonly ReasoningSegment[],
	source: ReasoningTranslationSource | undefined,
): ReasoningTranslationStepSource[] | undefined {
	if (!source) return;
	let cursor = 0;
	return segments.map((segment) => {
		const titleText =
			segment.title ??
			segment.body
				.split("\n")
				.find((line) => line.trim())
				?.trim() ??
			"";
		const title = projectText(source, titleText, cursor);
		const body = projectText(source, segment.body, segment.title ? title.cursor : cursor);
		cursor = Math.max(title.cursor, body.cursor);
		return {
			...(source.group ? { group: source.group } : {}),
			...(title.source.ranges.length ? { title: title.source } : {}),
			...(body.source.ranges.length && !segment.isEmpty ? { body: body.source } : {}),
		};
	});
}

const matchingTexts = new WeakMap<ReasoningTranslationSource, string>();

/**
 * Rendered markdown omits syntax. Accept exact text matches only; if repeated text
 * could belong to another source, keep only coordinates common to every match.
 * This deliberately fails closed for ambiguous/custom-rendered content.
 */
export function matchReasoningTranslationText(
	source: ReasoningTranslationSource,
	text: string,
): ReasoningTranslationSourceRange[] {
	if (!text.trim() || source.text.length > REASONING_VISIBILITY_MAX_SOURCE_CHARS) return [];
	const needle = (text.endsWith("…") ? text.slice(0, -1) : text).replace(/\s/g, " ");
	if (!needle.trim()) return [];
	let matchingText = matchingTexts.get(source);
	if (matchingText === undefined) {
		// One UTF-16 unit remains one unit, preserving exact source/DOM offsets.
		matchingText = source.text.replace(/\s/g, " ");
		matchingTexts.set(source, matchingText);
	}
	let found = matchingText.indexOf(needle);
	let common: ReasoningTranslationSourceRange[] | undefined;
	let attempts = 0;
	while (found >= 0) {
		if (++attempts > 64) return [];
		const ranges = source.ranges.flatMap((range) => {
			const start = Math.max(found, range.start) - found;
			const end = Math.min(found + needle.length, range.end) - found;
			return start < end && needle.slice(start, end).trim()
				? [{ start, end, target: range.target }]
				: [];
		});
		common =
			common === undefined
				? ranges
				: common.flatMap((range) =>
						ranges.flatMap((other) => {
							if (JSON.stringify(range.target) !== JSON.stringify(other.target)) return [];
							const start = Math.max(range.start, other.start);
							const end = Math.min(range.end, other.end);
							return start < end && needle.slice(start, end).trim()
								? [{ start, end, target: range.target }]
								: [];
						}),
					);
		if (!common.length) return [];
		found = matchingText.indexOf(needle, found + 1);
	}
	return common ?? [];
}
