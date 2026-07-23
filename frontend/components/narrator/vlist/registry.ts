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
import { measureReasoning } from "./measure/measure-reasoning";
import { measureSubagentCard } from "./measure/measure-subagent";
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
import { measureWebSearch } from "./measure/measure-web-search";
import type { MeasuredElement, RenderLod } from "./prepared-block";

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
		measure: (d, w, l) => measureMessageBubble(d as AnyData, w, l),
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
		measure: (d, w, _l, o) =>
			measureToolRunSummary((d as AnyData).items, w, o as AnyData, {
				label: (d as AnyData).headerLabel,
				count: (d as AnyData).headerCount,
			}),
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
		measure: (d, w, _l, o) =>
			measureActivityTrace((d as AnyData).items, w, o as AnyData, {
				label: (d as AnyData).headerLabel,
				count: (d as AnyData).headerCount,
			}),
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
