/**
 * Shared bridge between prepared blocks and pretext's pure line-metric calls.
 * This module has no React or DOM dependency; the browser/server runtime only
 * supplies the prepared handles and the pretext package's measurement context.
 */

import { measureLineStats } from "@chenglou/pretext";
import { measureRichInlineStats } from "@chenglou/pretext/rich-inline";
import type {
	BlockLineMetrics,
	LineMetricsResolver,
	PreparedCodeBlock,
	PreparedInlineBlock,
} from "./prepared-block";

export const pretextLineMetrics: LineMetricsResolver = (block, contentWidth) => {
	if (block.kind === "inline") return inlineMetrics(block, contentWidth);
	return codeMetrics(block, contentWidth);
};

export function inlineMetrics(block: PreparedInlineBlock, contentWidth: number): BlockLineMetrics {
	const { lineCount, maxLineWidth } = measureRichInlineStats(block.flow, contentWidth);
	return { lineCount: Math.max(1, lineCount), maxLineWidth };
}

export function codeMetrics(block: PreparedCodeBlock, innerWidth: number): BlockLineMetrics {
	const { lineCount, maxLineWidth } = measureLineStats(block.prepared, innerWidth);
	return { lineCount: Math.max(1, lineCount), maxLineWidth };
}
