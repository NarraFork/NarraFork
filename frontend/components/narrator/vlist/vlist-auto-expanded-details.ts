/**
 * vlist-auto-expanded-details.ts — Which tool payloads must be fetched BEFORE the
 * first layout is built.
 *
 * THE PROBLEM
 *
 * Large tool inputs/outputs reach the client as `{_truncated:true, preview, …}`
 * wrappers. The card's measured height comes from the body text it actually has,
 * so a card showing a 2000-char preview is measured short and then — once the full
 * payload arrives — measured tall. When the card was expanded because the USER
 * clicked it, that growth is fine: the user acted.
 *
 * But many cards are expanded by DEFAULT (`computeDefaultOpen`: file / plan /
 * tasks / knowledge / recall / send / share / pipeline categories, failed calls,
 * and everything at LOD 6). Those rows grew on their own, seconds after scrolling
 * into view, dragging the whole list with them — the exact "height must not change
 * without a user action" violation this module exists to prevent.
 *
 * THE FIX
 *
 * Auto-expanded truncated cards are resolved from the loaded messages BEFORE the
 * layout is built (this module), fetched on the coordinator's async boundary, and
 * folded into the first build. The first painted height is therefore the final
 * height. Cards the user expands later keep the on-demand path — a click is a user
 * action, so growth there is legitimate.
 *
 * This module is PURE: messages + LOD in, tool-use ids out. It deliberately does
 * NOT measure or build anything — it only has to answer "would this card be open,
 * and is its body still a preview?", which is the same pair of pure predicates the
 * adapter/measure layers use (`computeDefaultOpen` + `resolveToolCallOpened`).
 */

import { isTruncated } from "@shared/pretext-layout/tool-detail";
import type { ContentBlock, NarratorMsg } from "../narrator-panel-types";
import type { RenderLod } from "./prepared-block";

/**
 * Tool categories `computeDefaultOpen` expands without any user input. Mirrors
 * measure-tool-call's `autoOpen` list; kept as a local set so this module stays
 * free of the measure layer (which pulls in pretext).
 */
const AUTO_OPEN_CATEGORIES: ReadonlySet<string> = new Set([
	"tasks",
	"share",
	"recall",
	"send",
	"pipeline",
	"plan",
	"knowledge",
	"file",
]);

/** Categories that auto-open only when the call carries a detail body. */
const AUTO_OPEN_WITH_DETAIL: ReadonlySet<string> = new Set(["await", "bash"]);

/** Statuses that mean the tool is still in flight (body still changing). */
const RUNNING_STATUSES: ReadonlySet<string> = new Set(["pending", "running", "initializing"]);

export interface AutoExpandedDetailInput {
	/** Loaded message tree (top level; children are walked). */
	messages: readonly NarratorMsg[];
	/** Active render LOD — decides whether cards are expanded at all. */
	lod: RenderLod;
	/** Resolve a tool's category (the shell injects the authoritative resolver). */
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	/** Hard cap on how many payloads one build may prefetch. */
	limit?: number;
}

/**
 * Default prefetch cap. The first screen is already bounded
 * (`firstScreenPageSizeForLod` → 40 messages at LOD 4-6), and in practice only a
 * handful of those carry a truncated auto-expanded body. The cap exists so a
 * pathological page cannot fan out into dozens of requests before first paint.
 */
export const AUTO_EXPANDED_DETAIL_LIMIT = 12;

/**
 * True when a card at this LOD would be expanded without the user touching it.
 *
 * Mirrors `resolveToolCallOpened`: LOD 6 expands everything, LOD 5 expands recent
 * cards that default open, LOD 4 and below collapse. `isRecent` is deliberately
 * NOT modelled here — treating every card as potentially recent errs toward
 * prefetching one payload too many, which costs a request but never lets a height
 * change slip through.
 */
export function autoExpandsAtLod(lod: RenderLod, defaultOpen: boolean): boolean {
	if (lod >= 6) return true;
	if (lod === 5) return defaultOpen;
	return false;
}

/**
 * Whether `computeDefaultOpen` would open this card. Mirrors the measure layer's
 * decision, minus the streaming branch (a streaming card's body is still arriving,
 * so prefetching it is pointless — see `isRunning` filtering in the walk).
 */
export function defaultOpensCard(
	category: string,
	status: string | undefined,
	hasDetail: boolean,
): boolean {
	if (status === "pending") return true;
	if (AUTO_OPEN_CATEGORIES.has(category)) return true;
	if (AUTO_OPEN_WITH_DETAIL.has(category) && hasDetail) return true;
	if (status === "fail") return true;
	return false;
}

/** A tool_use block enriched by the backend, as the walk sees it. */
interface ToolUseLike {
	id?: string;
	name?: string;
	inputJson?: unknown;
	outputJson?: unknown;
	status?: string;
	input?: unknown;
}

function isToolUseBlock(block: ContentBlock | undefined): block is ContentBlock & ToolUseLike {
	return !!block && typeof block === "object" && block.type === "tool_use";
}

/**
 * Collect the tool-use ids whose payload is truncated AND whose card will be
 * expanded without user input, so the caller can fetch them before building.
 *
 * Returns ids in document order, capped at `limit`. Skips:
 *  - in-flight calls (their body is still changing; a live card's growth is
 *    expected and the full payload does not exist yet), and
 *  - cards that would be collapsed at this LOD (no body painted → no height to
 *    get wrong).
 */
export function collectAutoExpandedTruncatedToolUses(input: AutoExpandedDetailInput): string[] {
	const { messages, lod, resolveToolCategory } = input;
	const limit = Math.max(0, input.limit ?? AUTO_EXPANDED_DETAIL_LIMIT);
	if (limit === 0 || !Array.isArray(messages)) return [];
	const ids: string[] = [];
	const seen = new Set<string>();

	const visitMessage = (msg: NarratorMsg | undefined): boolean => {
		if (!msg) return true;
		const blocks = Array.isArray(msg.contentJson) ? (msg.contentJson as ContentBlock[]) : [];
		for (const block of blocks) {
			if (!isToolUseBlock(block)) continue;
			const toolUseId = typeof block.id === "string" ? block.id : undefined;
			if (!toolUseId || seen.has(toolUseId)) continue;
			// Only a still-truncated payload is worth fetching.
			if (!isTruncated(block.inputJson) && !isTruncated(block.outputJson)) continue;
			// A running/streaming call's body is not final yet.
			if (block.status && RUNNING_STATUSES.has(block.status)) continue;
			const toolName = typeof block.name === "string" ? block.name : "";
			const category = resolveToolCategory?.(toolName, block.inputJson ?? block.input) ?? "generic";
			// `hasDetail` stands in for "the classifier will produce a body": a
			// truncated payload always yields one, which is precisely this branch.
			//
			// The LOD check must come LAST and receive the default-open verdict: LOD 6
			// expands every card regardless of it, so testing `defaultOpensCard` as a
			// gate first would wrongly skip a truncated search/generic card that LOD 6
			// does paint expanded.
			const defaultOpen = defaultOpensCard(category, block.status, true);
			if (!autoExpandsAtLod(lod, defaultOpen)) continue;
			seen.add(toolUseId);
			ids.push(toolUseId);
			if (ids.length >= limit) return false;
		}
		if (Array.isArray(msg.children)) {
			for (const child of msg.children) {
				if (!visitMessage(child)) return false;
			}
		}
		return true;
	};

	for (const msg of messages) {
		if (!visitMessage(msg)) break;
	}
	return ids;
}
