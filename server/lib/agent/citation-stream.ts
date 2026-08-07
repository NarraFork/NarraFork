/**
 * Per-turn citation state for a single assistant text output.
 *
 * Providers report source citations in two independent ways, sometimes both at
 * once for the same source:
 *
 *  - structurally, as streamed annotations (`response.output_text.annotation.added`)
 *    plus a final authoritative list on `output_item.done`;
 *  - inline, as private-use-area control markers embedded in the visible text.
 *
 * This accumulator collapses both into the single shared contract and is the
 * only place that decides what the visible text becomes. Everything downstream
 * (persistence, model history, three renderers) consumes its output, so the
 * `citeturn…` marker leak cannot reappear on one path but not another.
 */

import {
	normalizeTextCitations,
	parseLegacyCitationMarkers,
	remapIndexThroughRemovals,
	type TextCitation,
} from "@shared/citations";
import { logger } from "../logger";

export interface FinalizedAssistantText {
	/** Visible text with all provider-internal markers removed. */
	text: string;
	/** Normalized citations indexed against `text`. */
	citations: TextCitation[];
	/** True when the raw text contained internal markers that were stripped. */
	strippedMarkers: boolean;
}

export class TextCitationAccumulator {
	private provider: ProviderTextCitation[] = [];

	/** Record provider-reported citations. Duplicates are resolved at finalize. */
	add(citations: readonly ProviderTextCitation[] | undefined): void {
		if (!citations || citations.length === 0) return;
		for (const citation of citations) this.provider.push(citation);
	}

	/** Clear state between turns; the accumulator is reused across a session. */
	reset(): void {
		if (this.provider.length > 0) this.provider = [];
	}

	get hasProviderCitations(): boolean {
		return this.provider.length > 0;
	}

	/**
	 * Produce the final `{ text, citations }` pair for an assistant text block.
	 *
	 * Provider annotation indices address the raw provider text, which may still
	 * contain inline markers. Stripping those shifts every index after them, so
	 * annotations are remapped through the removed ranges before merging.
	 */
	finalize(rawText: string): FinalizedAssistantText {
		const parsed = parseLegacyCitationMarkers(rawText);
		if (this.provider.length === 0) {
			if (!parsed.changed) return { text: rawText, citations: [], strippedMarkers: false };
			return { text: parsed.text, citations: parsed.citations, strippedMarkers: true };
		}

		const remapped: TextCitation[] = [];
		for (const citation of this.provider) {
			const endIndex = parsed.changed
				? remapIndexThroughRemovals(citation.endIndex, parsed.removals)
				: citation.endIndex;
			const startRaw = citation.startIndex ?? citation.endIndex;
			const startIndex = parsed.changed
				? remapIndexThroughRemovals(startRaw, parsed.removals)
				: startRaw;
			remapped.push({
				startIndex,
				endIndex,
				sources: [
					{
						...(citation.url ? { url: citation.url } : {}),
						...(citation.title ? { title: citation.title } : {}),
						...(citation.sourceRef ? { sourceRef: citation.sourceRef } : {}),
					},
				],
			});
		}

		const citations = normalizeTextCitations(
			[...remapped, ...parsed.citations],
			parsed.text.length,
		);
		if (citations.length < remapped.length + parsed.citations.length) {
			logger.debug("Citation normalization dropped or merged entries", {
				provider: remapped.length,
				legacy: parsed.citations.length,
				kept: citations.length,
			});
		}
		return { text: parsed.text, citations, strippedMarkers: parsed.changed };
	}
}

/**
 * Stateless finalize for callers without an accumulator (partial flush paths and
 * read-side compatibility). Strips inline markers and returns their citations.
 */
export function finalizeAssistantTextWithCitations(
	rawText: string,
	providerCitations?: readonly ProviderTextCitation[],
): FinalizedAssistantText {
	const accumulator = new TextCitationAccumulator();
	accumulator.add(providerCitations);
	return accumulator.finalize(rawText);
}
