/**
 * registry.ts — Central dispatch catalog for the pretext vlist.
 *
 * Maps every vlist element KIND to its measure function. This is the single
 * source of truth of "which elements exist and how each is measured", used by:
 *   - PretextMessageList: iterate segments → measure heights → virtualize.
 *   - VListHarness: enumerate elements for DOM-vs-predicted calibration.
 *   - the data adapter (segment/block → measure input) that a later step fills.
 *
 * Design notes
 * - Every measure fn already shares the shape `(data, contentWidth, lod, …) →
 *   MeasuredElement` (see the batch-2 packages). The registry normalizes them
 *   behind a uniform `MeasureFn` so callers dispatch by kind without knowing the
 *   concrete signature.
 * - The registry is pure data + thin wrappers; it imports measure fns only
 *   (render fns are dispatched separately in the render layer to keep this file
 *   free of TSX and cheap to import from non-React code / tests).
 * - Zero DOM. This file adds no new measurement; it only routes to existing
 *   deterministic measure fns.
 */

import type { VListElementKind } from "@shared/pretext-layout/element-kinds";
import { measureAskInPassing } from "./measure/measure-ask-in-passing";
import { measureMarkdown } from "./measure/measure-markdown";
import { measureMedia } from "./measure/measure-media";
import { measureMessageBubble } from "./measure/measure-message-bubble";
import { measurePruneDivider } from "./measure/measure-misc";
import { measureAskUserQuestion, measureInlinePermission } from "./measure/measure-permission";
import { measurePlanCard } from "./measure/measure-plan-card";
import {
	measureReasoning,
	resolveReasoningDisplayText,
	resolveReasoningForm,
} from "./measure/measure-reasoning";
import { measureSidecar } from "./measure/measure-sidecar";
import { measureSubagentCard } from "./measure/measure-subagent";
import { measureSubagentRecovery } from "./measure/measure-subagent-recovery";
import { measureKnowledgeHint } from "./measure/measure-system-list";
import { measureSystemSimpleCard } from "./measure/measure-system-simple";
import { measureSystemTextCard } from "./measure/measure-system-text";
import { measureToolCall, measureToolCallGroup } from "./measure/measure-tool-call";
import {
	measureActivityTrace,
	measureReasoningCountLine,
	measureReasoningStepsTrace,
	measureToolRunCountLine,
	measureToolRunSummary,
} from "./measure/measure-tool-run";
import { measureTurnUsage } from "./measure/measure-turn-usage";
import { measureWebSearch } from "./measure/measure-web-search";
import { buildCacheKey, extractDataRevision, isStreamingKey, measureCache } from "./measure-cache";
import type { MeasuredElement, RenderLod } from "./prepared-block";
import { getStreamingPreparedBlocks } from "./streaming-block-cache";

export type { VListElementKind } from "@shared/pretext-layout/element-kinds";

/**
 * Uniform measure signature. `data` is the element's input payload (its concrete
 * shape depends on kind; the data adapter produces it). `opts` carries the
 * per-kind extras some measures need (viewportHeight / expand state / labels).
 */
export type MeasureFn = (
	data: unknown,
	contentWidth: number,
	lod: RenderLod,
	opts?: Record<string, unknown>,
) => MeasuredElement;

/** Metadata + measure wrapper for one element kind. */
export interface VListMeasureEntry {
	kind: VListElementKind;
	/** Human-readable label (harness / debugging). */
	label: string;
	/** True when this element's height depends on the render LOD. */
	lodSensitive: boolean;
	/** The normalized measure function. */
	measure: MeasureFn;
}

// Thin adapters normalizing each concrete measure fn to MeasureFn. Casting the
// opaque `data`/`opts` here is the single controlled boundary; concrete measures
// keep their precise types for their own callers/tests.
// biome-ignore lint/suspicious/noExplicitAny: registry boundary normalizes typed measures
type AnyData = any;

export const VLIST_REGISTRY: Record<VListElementKind, VListMeasureEntry> = {
	"message-bubble": {
		kind: "message-bubble",
		label: "Message bubble (assistant/user)",
		lodSensitive: false,
		// `opts` carries the slash-command bubble's expand state + toggle labels;
		// plain bubbles pass no opts and are unaffected.
		measure: (d, w, l, o) => measureMessageBubble(d as AnyData, w, l, o as AnyData),
	},
	markdown: {
		kind: "markdown",
		label: "Markdown body",
		lodSensitive: false,
		measure: (d, w) => measureMarkdown(d as AnyData, w),
	},
	reasoning: {
		kind: "reasoning",
		label: "Reasoning / thinking",
		lodSensitive: true,
		measure: (d, w, l, o) => measureReasoning(d as AnyData, w, l, o as AnyData),
	},
	media: {
		kind: "media",
		label: "Image / generated image / text file",
		lodSensitive: false,
		measure: (d, w, l) => measureMedia(d as AnyData, w, l),
	},
	"web-search": {
		kind: "web-search",
		label: "Web search",
		lodSensitive: false,
		measure: (d, w, l) => measureWebSearch(d as AnyData, w, l),
	},
	"system-simple": {
		kind: "system-simple",
		label: "System card (single-line)",
		lodSensitive: false,
		measure: (d, w, l) => measureSystemSimpleCard((d as AnyData).kind, d as AnyData, w, l),
	},
	"system-text": {
		kind: "system-text",
		label: "System card (multi-line text)",
		lodSensitive: false,
		measure: (d, w, l) => measureSystemTextCard((d as AnyData).kind, d as AnyData, w, l),
	},
	sidecar: {
		kind: "sidecar",
		label: "System injection (sidecar) card",
		lodSensitive: false,
		measure: (d, w, l, o) => measureSidecar(d as AnyData, w, l, o as AnyData),
	},
	"knowledge-hint": {
		kind: "knowledge-hint",
		label: "Knowledge hint list",
		lodSensitive: false,
		measure: (d, w, l) => measureKnowledgeHint(d as AnyData, w, l),
	},
	"plan-card": {
		kind: "plan-card",
		label: "Plan card",
		lodSensitive: false,
		measure: (d, w, l) => measurePlanCard(d as AnyData, w, l),
	},
	"ask-in-passing": {
		kind: "ask-in-passing",
		label: "Ask in passing",
		lodSensitive: false,
		measure: (d, w, l) => measureAskInPassing((d as AnyData).kind, d as AnyData, w, l),
	},
	"subagent-recovery": {
		kind: "subagent-recovery",
		label: "Subagent recovery card",
		lodSensitive: false,
		measure: (d, w, l, o) => measureSubagentRecovery(d as AnyData, w, l, o as AnyData),
	},
	"tool-call": {
		kind: "tool-call",
		label: "Tool call card",
		lodSensitive: true,
		measure: (d, w, l, o) => measureToolCall(d as AnyData, w, l, o as AnyData),
	},
	"tool-call-group": {
		kind: "tool-call-group",
		label: "Tool call group",
		lodSensitive: true,
		measure: (d, w, l, o) => measureToolCallGroup((d as AnyData).toolCalls, w, l, o as AnyData),
	},
	"tool-run-summary": {
		kind: "tool-run-summary",
		label: "Tool run summary (L3)",
		lodSensitive: true,
		// `lod` reaches the trace so a drilled-in row's nested tool card measures its
		// detail at the same level a standalone card would.
		measure: (d, w, l, o) =>
			measureToolRunSummary(
				(d as AnyData).items,
				w,
				o as AnyData,
				{
					label: (d as AnyData).headerLabel,
					count: (d as AnyData).headerCount,
				},
				l,
			),
	},
	"tool-run-count": {
		kind: "tool-run-count",
		label: "Tool run count line (L2)",
		lodSensitive: true,
		measure: (d, w) => measureToolRunCountLine((d as AnyData).count, w),
	},
	"activity-trace": {
		kind: "activity-trace",
		label: "Activity trace (L1/L2)",
		lodSensitive: true,
		// See tool-run-summary: `lod` is forwarded for the drilled-in card's detail.
		measure: (d, w, l, o) =>
			measureActivityTrace(
				(d as AnyData).items,
				w,
				o as AnyData,
				{
					label: (d as AnyData).headerLabel,
					count: (d as AnyData).headerCount,
				},
				l,
			),
	},
	"reasoning-steps": {
		kind: "reasoning-steps",
		label: "Reasoning steps trace",
		lodSensitive: true,
		measure: (d, w, _l, o) =>
			measureReasoningStepsTrace((d as AnyData).steps, w, o as AnyData, {
				label: (d as AnyData).headerLabel,
				count: (d as AnyData).headerCount,
			}),
	},
	"reasoning-count": {
		kind: "reasoning-count",
		label: "Reasoning count line (L1/L2)",
		lodSensitive: true,
		measure: (d, w) => measureReasoningCountLine((d as AnyData).count, w),
	},
	"ask-user-question": {
		kind: "ask-user-question",
		label: "Ask user question banner",
		lodSensitive: false,
		measure: (d, w, l) => measureAskUserQuestion(d as AnyData, w, l),
	},
	"inline-permission": {
		kind: "inline-permission",
		label: "Inline permission",
		lodSensitive: false,
		measure: (d, w, l) => measureInlinePermission(d as AnyData, w, l),
	},
	"subagent-card": {
		kind: "subagent-card",
		label: "Subagent card",
		lodSensitive: true,
		measure: (d, w, l, o) => measureSubagentCard(d as AnyData, w, l, o as AnyData),
	},
	"prune-divider": {
		kind: "prune-divider",
		label: "Prune divider",
		lodSensitive: false,
		measure: (_d, w) => measurePruneDivider(w),
	},
	"turn-usage": {
		kind: "turn-usage",
		label: "Turn token/cost usage line",
		lodSensitive: false,
		measure: (d, w, l) => measureTurnUsage(d as AnyData, w, l),
	},
};

/** All registered element kinds. */
export const VLIST_ELEMENT_KINDS = Object.keys(VLIST_REGISTRY) as VListElementKind[];

/** Look up a measure entry by kind. */
export function getMeasureEntry(kind: VListElementKind): VListMeasureEntry {
	return VLIST_REGISTRY[kind];
}

/** Measure an element by kind (uniform entry point for PretextMessageList). */
export function measureElement(
	kind: VListElementKind,
	data: unknown,
	contentWidth: number,
	lod: RenderLod,
	opts?: Record<string, unknown>,
): MeasuredElement {
	return VLIST_REGISTRY[kind].measure(data, contentWidth, lod, opts);
}

/**
 * Cached measure entry point. When a stable `specKey` is provided and the item
 * is not a streaming/transient element, the result is cached by
 * (specKey, kind, contentWidth, lod, opts, dataRevision, documentRevision) and
 * reused on subsequent builds.
 *
 * `documentRevision` (the narrator messageVersion) is folded into the key so an
 * in-place message edit — which keeps the same spec.key but changes the text and
 * therefore the measured height/blocks — invalidates the stale entry. Without it
 * an edited message would render its pre-edit height and content until an
 * unrelated width/LOD change happened to re-key it. Upward pagination (loadOlder)
 * does NOT change the version, so growing the window still reuses the cache.
 *
 * This is the function injected into the layout pipeline to avoid re-measuring
 * items that have not changed between layout rebuilds.
 */
export function measureElementCached(
	kind: VListElementKind,
	data: unknown,
	contentWidth: number,
	lod: RenderLod,
	opts?: Record<string, unknown>,
	specKey?: string,
	documentRevision?: string | number,
): MeasuredElement {
	// Skip cache for streaming items or when no stable key is available.
	//
	// A streaming row cannot be cached (its content changes every frame), but it
	// must not pay a full re-parse of the whole accumulated body either — that is
	// O(len)/frame, i.e. O(len²) per turn. Text-bearing streaming rows therefore go
	// through the incremental prepared-block path, which freezes completed markdown
	// blocks and only re-parses the still-open trailing one.
	if (!specKey || isStreamingKey(specKey)) {
		const streamed = measureStreamingElement(kind, data, contentWidth, lod, opts, specKey);
		if (streamed !== undefined) return streamed;
		return VLIST_REGISTRY[kind].measure(data, contentWidth, lod, opts);
	}

	// Fold the document version into the data-revision component so a content edit
	// (which bumps the version) can never return a stale height for a stable key.
	const dataRevision = combineDataRevision(documentRevision, extractDataRevision(data));
	const cacheKey = buildCacheKey(specKey, kind, contentWidth, lod, opts, dataRevision);
	const cached = measureCache.get(cacheKey);
	if (cached !== undefined) return cached;

	const result = VLIST_REGISTRY[kind].measure(data, contentWidth, lod, opts);
	measureCache.set(cacheKey, result);
	return result;
}

/**
 * Measure a STREAMING text-bearing element using incrementally prepared blocks.
 *
 * Returns undefined when the element is not one of the incremental kinds (or has
 * no usable text), leaving the caller to run the ordinary measure.
 *
 * Only `markdown` and an EXPANDED `reasoning` body are handled: those are the two
 * kinds whose height is dominated by a long, monotonically growing markdown body.
 * Every other streaming element is small and bounded (a tool card header, a
 * web-search line), so a plain measure is already cheap.
 */
function measureStreamingElement(
	kind: VListElementKind,
	data: unknown,
	contentWidth: number,
	lod: RenderLod,
	opts: Record<string, unknown> | undefined,
	specKey: string | undefined,
): MeasuredElement | undefined {
	if (!specKey) return undefined;
	if (kind === "markdown") {
		if (typeof data !== "string" || data.length === 0) return undefined;
		// Exact preparation of exactly this text — the incremental path reuses per-block
		// work but never approximates, so no text substitution is needed here.
		return measureMarkdown(data, contentWidth, {
			preparedBlocks: getStreamingPreparedBlocks(specKey, data),
		});
	}
	if (kind === "reasoning") {
		const expandState = (opts ?? {}) as AnyData;
		// Only the EXPANDED form measures the body as markdown; the collapsed / count
		// / empty-streaming forms are fixed-height rows that never touch the text.
		if (resolveReasoningForm(data as AnyData, lod, expandState) !== "expanded") return undefined;
		// Prepare exactly the text this measure will resolve — the translation toggle
		// picks between two different bodies, so deriving it independently here would
		// risk preparing one and measuring the other.
		const text = resolveReasoningDisplayText(data as AnyData, expandState);
		if (text.length === 0) return undefined;
		return measureReasoning(data as AnyData, contentWidth, lod, {
			...expandState,
			// Scope the cache per body: the translation toggle flips between two
			// independently growing texts, which must not share an entry.
			preparedBlocks: getStreamingPreparedBlocks(
				`${specKey}|${expandState.showOriginal ? "orig" : "shown"}`,
				text,
			),
		});
	}
	return undefined;
}

/** Merge the document version and the data-derived revision into one key part. */
function combineDataRevision(
	documentRevision: string | number | undefined,
	dataRevision: string | undefined,
): string | undefined {
	const versionPart = documentRevision != null ? `v:${documentRevision}` : undefined;
	if (versionPart && dataRevision) return `${versionPart}|${dataRevision}`;
	return versionPart ?? dataRevision;
}
