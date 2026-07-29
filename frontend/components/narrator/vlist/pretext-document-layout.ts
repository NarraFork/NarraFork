import type { PretextLayoutIndex, PretextLayoutManifest } from "@shared/pretext-layout";
import { segmentMessages } from "../message-segments";
import type { NarratorMsg } from "../narrator-panel-types";
import { groupRenderUnits, type RenderUnit } from "../render-units";
import type { RenderLod } from "./prepared-block";
import { buildPretextLayoutManifest } from "./pretext-layout-manifest";
import type {
	AdapterActivityInput,
	AdapterMessage,
	AdapterRenderUnit,
	AdapterSegment,
	ElementSpec,
} from "./segment-adapter";
import type { VListItem } from "./vlist-pipeline";

export interface BuildPretextDocumentLayoutOptions {
	layoutRevision: string;
	documentRevision: string | number;
	lod: RenderLod;
	widthBucket: string | number;
	contentWidth: number;
	viewportHeight?: number;
	gap?: number;
	/** Wider gap between top-level render units (see manifest builder segmentGap). */
	segmentGap?: number;
	topPadding?: number;
	bottomPadding?: number;
	pruneBoundaryMessageId?: string | null;
	pruneDividerLabel?: string;
	isExpanded?: (key: string) => boolean | undefined;
	isLodUserOverride?: (key: string) => boolean;
	showEarlier?: (key: string) => boolean;
	expandedRows?: (key: string) => readonly number[];
	/** Resolve whether a translated reasoning body shows its ORIGINAL text. */
	showOriginal?: (key: string) => boolean;
	/** Resolve whether a subagent card's prompt body is open. */
	isPromptOpen?: (key: string) => boolean;
	recentMessageIds?: ReadonlySet<string>;
	resolveRecentMessageIds?: (messages: readonly NarratorMsg[]) => ReadonlySet<string>;
	labels?: Record<string, string>;
	/**
	 * Revision of the injected `labels` (the active UI language). The adapter
	 * composes localized text INTO the measured card/trace content, so a language
	 * switch changes both the text and potentially its wrapped height while every
	 * spec.key and the document version stay identical. Folding it into the
	 * measurement cache key makes a language switch invalidate cached heights and
	 * text instead of repainting the previous language from cache.
	 */
	labelsRevision?: string;
	resolveToolCategory?: (toolName: string, input?: unknown) => string;
	resolveToolColor?: (toolName: string, input?: unknown) => string;
	/** Authoritative header summary (tool-display.getSummary). Without it a tool
	 * whose input was truncated server-side renders a header with no target. */
	resolveToolSummary?: (tc: unknown) => string;
	resolveHasPendingPermission?: (toolUseId: string | undefined) => boolean;
	resolvePendingPlan?: (toolUseId: string | undefined) => string | undefined;
	/** Full (un-truncated) tool payloads once the shell has fetched them. */
	resolveFullToolInput?: (toolUseId: string | undefined) => unknown;
	resolveFullToolOutput?: (toolUseId: string | undefined) => unknown;
	/** A live pending permission's suggestions (reflection-gate precedence). */
	resolvePendingPermissionSuggestions?: (toolUseId: string | undefined) => unknown[] | undefined;
}

export interface BuiltPretextDocumentLayout {
	manifest: PretextLayoutManifest;
	index: PretextLayoutIndex;
	/** Prepared render items paired with the manifest/index geometry. */
	items: readonly VListItem[];
	renderUnits: readonly AdapterRenderUnit[];
}

type SourceMessage = AdapterMessage & { seq?: number };

function sourceMessagesForUnit(unit: RenderUnit): SourceMessage[] {
	if (unit.kind === "activity") return unit.sourceMessages as SourceMessage[];
	if (unit.seg.kind === "message") return [unit.seg.msg as SourceMessage];
	if (unit.seg.kind === "tool-run") return unit.seg.sourceMessages as SourceMessage[];
	return [];
}

function sourceSeq(message: Pick<SourceMessage, "seq"> | undefined, fallback: number): number {
	return typeof message?.seq === "number" && Number.isInteger(message.seq) ? message.seq : fallback;
}

function sourceForMessages(messages: readonly SourceMessage[], fallbackSeq: number) {
	const valid = messages.filter(
		(message) => typeof message.id === "string" && message.id.length > 0,
	);
	const seqs = valid.map((message, index) => sourceSeq(message, fallbackSeq + index));
	return {
		firstSeq: seqs.length > 0 ? Math.min(...seqs) : fallbackSeq,
		lastSeq: seqs.length > 0 ? Math.max(...seqs) : fallbackSeq,
		sourceMessageIds:
			valid.length > 0 ? valid.map((message) => message.id as string) : [`layout:${fallbackSeq}`],
	};
}

/**
 * Longest-registered-prefix lookup over a set of owner keys.
 *
 * A derived spec key always EXTENDS its owner's key (`<msgId>-b3`,
 * `tool-<id>#dup1`, `toolrun-summary-tool-<id>`), so the owner is the longest
 * registered key that prefixes it.
 *
 * The obvious implementation — scan every registered key for each item — was the
 * document rebuild's hidden O(items x keys): at ~1600 items it cost ~38ms of a
 * ~49ms rebuild, which is the entire budget a live streaming rebuild needs.
 * Probing only the DISTINCT REGISTERED LENGTHS (longest first) returns the same
 * answer while doing a bounded number of map lookups per item: the number of
 * distinct key lengths is a property of the key SHAPES, not of the document size
 * (measured: 11 lengths at both 200 and 800 messages).
 *
 * Exported for `pretext-document-layout.test.ts`, which asserts both the
 * equivalence and the bounded probe count — a timing assertion cannot separate
 * the two implementations reliably enough to be a regression guard.
 */
export function createLongestPrefixLookup<T>(registry: ReadonlyMap<string, T>): {
	resolve: (key: string) => T | undefined;
	/** Distinct registered key lengths; the per-item probe bound. */
	probeLengths: readonly number[];
} {
	const probeLengths = [
		...new Set([...registry.keys()].map((key) => key.length).filter((length) => length > 0)),
	].sort((left, right) => right - left);
	return {
		probeLengths,
		resolve: (key: string) => {
			for (const length of probeLengths) {
				if (length > key.length) continue;
				const found = registry.get(key.slice(0, length));
				if (found !== undefined) return found;
			}
			return undefined;
		},
	};
}

function buildSourceResolver(
	renderUnits: readonly RenderUnit[],
	messages: readonly SourceMessage[],
): (spec: ElementSpec, itemIndex: number) => ReturnType<typeof sourceForMessages> {
	const exact = new Map<string, SourceMessage[]>();
	const all = renderUnits.flatMap((unit, unitIndex) => {
		const sources = sourceMessagesForUnit(unit);
		if (unit.kind === "activity") {
			exact.set(`activity-${sources[0]?.id ?? "unknown"}-${unitIndex}`, sources);
		}
		if (unit.kind === "segment" && unit.seg.kind === "message" && unit.seg.msg.id)
			exact.set(unit.seg.msg.id, sources);
		if (unit.kind === "segment" && unit.seg.kind === "tool-run") {
			for (const item of unit.seg.items) {
				if (!item.tc.toolUseId) continue;
				const toolKey = `tool-${item.tc.toolUseId}`;
				exact.set(toolKey, sources);
				exact.set(`toolrun-summary-${toolKey}`, sources);
				exact.set(`toolrun-count-${toolKey}`, sources);
			}
		}
		return sources;
	});
	const fallback = all.length > 0 ? all : [...messages];
	let lastResolvedSeq = sourceSeq(fallback[0], 0);
	// Owner attribution for derived spec keys (see createLongestPrefixLookup for
	// why this is not a per-item scan over every registered key).
	const owners = createLongestPrefixLookup(exact);
	return (spec, itemIndex) => {
		let sources = exact.get(spec.key) ?? owners.resolve(spec.key);
		if (!sources || sources.length === 0) {
			const fallbackMessage = fallback[Math.min(itemIndex, Math.max(0, fallback.length - 1))];
			sources = fallbackMessage ? [fallbackMessage] : [];
		}
		const result = sourceForMessages(sources, lastResolvedSeq);
		lastResolvedSeq = result.lastSeq;
		return result;
	};
}

export function buildPretextDocumentLayout(
	messages: readonly NarratorMsg[],
	options: BuildPretextDocumentLayoutOptions,
): BuiltPretextDocumentLayout {
	const sourceMessages = messages as readonly SourceMessage[];
	const segments = segmentMessages(messages as NarratorMsg[], {
		pruneBoundaryMessageId: options.pruneBoundaryMessageId,
		pruneDividerLabel: options.pruneDividerLabel,
	});
	const renderUnits = groupRenderUnits(segments, options.lod <= 2);
	const adapterUnits: AdapterRenderUnit[] = renderUnits.map((unit, index) =>
		unit.kind === "activity"
			? {
					kind: "activity",
					key: `activity-${unit.sourceMessages[0]?.id ?? "unknown"}-${index}`,
					items: unit.items as unknown as AdapterActivityInput[],
					sourceMessages: unit.sourceMessages as unknown as AdapterMessage[],
				}
			: { kind: "segment", seg: unit.seg as unknown as AdapterSegment },
	);
	const resolveSource = buildSourceResolver(renderUnits, sourceMessages);
	const recentMessageIds =
		options.recentMessageIds ??
		options.resolveRecentMessageIds?.(messages as readonly NarratorMsg[]);
	// The label revision joins the document revision so the measurement cache (and
	// the manifest identity) treat a language switch as new content: the adapter
	// bakes localized strings into measured card/trace text, which the spec.key and
	// message version alone cannot distinguish.
	const documentRevision = options.labelsRevision
		? `${options.documentRevision}~l:${options.labelsRevision}`
		: options.documentRevision;
	return {
		...buildPretextLayoutManifest({
			...options,
			documentRevision,
			recentMessageIds,
			renderUnits: adapterUnits,
			resolveSource,
		}),
		renderUnits: adapterUnits,
	};
}
