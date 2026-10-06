import type { ProviderTextCitation, ReasoningProviderMetadata } from "@shared/agent-protocol/types";
import { generateId } from "../id";
import { finalizeAssistantTextWithCitations } from "./citation-stream";
import type { AgentEvent, ContentBlock } from "./types";

type ContentKind = "text" | "reasoning";
type TextualBlock = Extract<ContentBlock, { type: ContentKind }>;

/** Native identities are request-local; outputIndex is an order, not an identity. */
export interface ContentLane {
	blockId?: string;
	outputIndex?: number;
}

interface Lane {
	kind: ContentKind;
	id: string;
	nativeId?: string;
	nativeIndex?: number;
	order: number;
	text: string;
	metadata?: ReasoningProviderMetadata;
	citations: Map<string, ProviderTextCitation>;
	revision: number;
	publishedRevision: number;
}

function mergeMetadata(
	previous: ReasoningProviderMetadata | undefined,
	next: ReasoningProviderMetadata,
): ReasoningProviderMetadata {
	return {
		...previous,
		...next,
		...(next.openai ? { openai: { ...previous?.openai, ...next.openai } } : {}),
		...(next.anthropic ? { anthropic: { ...previous?.anthropic, ...next.anthropic } } : {}),
		...(next.gemini ? { gemini: { ...previous?.gemini, ...next.gemini } } : {}),
	};
}

/**
 * One provider attempt's content, shared by incremental persistence and replay.
 *
 * A checkpoint writes the current version without forgetting the raw text or its
 * native credentials. A later delta/annotation/signature updates that SAME block.
 * Only changed versions are emitted, so finalization/abort cannot append another
 * copy of content already published before a tool. No database work happens per
 * delta: callers drain at native boundaries, lane changes, tool boundaries or end.
 */
export class OutputContentAccumulator {
	private attempt = generateId();
	private nextOrder = 0;
	private readonly lanes: Lane[] = [];
	private readonly dirty = new Set<Lane>();
	private readonly globalCitations = new Map<string, ProviderTextCitation>();
	/** Adjacent deltas of one lane coalesce: spans grow per interleaving, not per token. */
	private readonly textSpans: Array<{
		lane: Lane;
		start: number;
		end: number;
		blockStart: number;
	}> = [];
	private totalTextLength = 0;
	private readonly native = new Map<string, Lane>();
	private readonly indexed = new Map<string, Lane>();
	private readonly anonymous = new Map<ContentKind, Lane>();
	private readonly latest = new Map<ContentKind, Lane>();
	private readonly externalOrder = new Map<string, { order: number; outputIndex?: number }>();
	private active: Lane | undefined;

	reset(): void {
		this.attempt = generateId();
		this.nextOrder = 0;
		this.lanes.length = 0;
		this.dirty.clear();
		this.globalCitations.clear();
		this.textSpans.length = 0;
		this.totalTextLength = 0;
		this.native.clear();
		this.indexed.clear();
		this.anonymous.clear();
		this.latest.clear();
		this.externalOrder.clear();
		this.active = undefined;
	}

	private resolve(kind: ContentKind, hint: ContentLane, metadataOnly = false): Lane {
		const nativeKey = hint.blockId ? `${kind}:${hint.blockId}` : undefined;
		const indexKey = hint.outputIndex != null ? `${kind}:${hint.outputIndex}` : undefined;
		let lane = nativeKey ? this.native.get(nativeKey) : undefined;
		if (!lane && indexKey) {
			const indexed = this.indexed.get(indexKey);
			// Two Responses content parts can share output_index but never their id.
			if (indexed && (!hint.blockId || !indexed.nativeId || indexed.nativeId === hint.blockId)) {
				lane = indexed;
			}
		}
		if (!lane && !nativeKey && !indexKey) {
			lane = metadataOnly ? this.latest.get(kind) : this.anonymous.get(kind);
		}
		// Some relays reveal a native identity only with the final credential.
		if (!lane && metadataOnly) {
			const last = this.latest.get(kind);
			if (last && last.nativeId == null && last.nativeIndex == null) lane = last;
		}
		const created = !lane;
		if (!lane) {
			const order = this.nextOrder++;
			lane = {
				kind,
				id: `${this.attempt}:${order}`,
				order,
				text: "",
				citations: new Map(),
				revision: 0,
				publishedRevision: 0,
			};
			this.lanes.push(lane);
		}
		if (hint.blockId) {
			lane.nativeId = hint.blockId;
			this.native.set(nativeKey as string, lane);
		}
		if (hint.outputIndex != null) {
			if (lane.revision > 0 && lane.nativeIndex !== hint.outputIndex) {
				lane.revision++;
				this.dirty.add(lane);
			}
			lane.nativeIndex = hint.outputIndex;
			this.nextOrder = Math.max(this.nextOrder, hint.outputIndex + 1);
			this.indexed.set(indexKey as string, lane);
		}
		if (!nativeKey && !indexKey && (!metadataOnly || created)) this.anonymous.set(kind, lane);
		this.latest.set(kind, lane);
		return lane;
	}

	/** A previous lane must become real before the next lane becomes visible. */
	*begin(kind: ContentKind, hint: ContentLane = {}): Generator<AgentEvent> {
		const lane = this.resolve(kind, hint);
		if (this.active && this.active !== lane) {
			yield* this.publish(this.active);
			if (this.active.nativeId == null && this.active.nativeIndex == null) {
				this.anonymous.delete(this.active.kind);
			}
		}
		this.active = lane;
	}

	append(
		kind: ContentKind,
		text: string,
		hint: ContentLane = {},
		metadata?: ReasoningProviderMetadata,
	): { blockId: string; blockRevision: number; blockTextOffset: number; outputIndex: number } {
		const lane = this.resolve(kind, hint);
		const blockTextOffset = lane.text.length;
		if (kind === "text" && text) {
			const previous = this.textSpans.at(-1);
			if (previous?.lane === lane && previous.end === this.totalTextLength) {
				previous.end += text.length;
			} else {
				this.textSpans.push({
					lane,
					start: this.totalTextLength,
					end: this.totalTextLength + text.length,
					blockStart: blockTextOffset,
				});
			}
			this.totalTextLength += text.length;
		}
		lane.text += text;
		if (metadata) lane.metadata = mergeMetadata(lane.metadata, metadata);
		lane.revision++;
		this.dirty.add(lane);
		this.active = lane;
		return {
			blockId: lane.id,
			blockRevision: lane.revision,
			blockTextOffset,
			outputIndex: lane.nativeIndex ?? lane.order,
		};
	}

	/** Metadata is not a block-stop signal. An already-published block is patched. */
	*reasoningMetadata(
		metadata: ReasoningProviderMetadata,
		hint: ContentLane = {},
	): Generator<AgentEvent> {
		const lane = this.resolve("reasoning", hint, true);
		const merged = mergeMetadata(lane.metadata, metadata);
		if (JSON.stringify(merged) !== JSON.stringify(lane.metadata)) {
			lane.metadata = merged;
			lane.revision++;
			this.dirty.add(lane);
		}
		if (lane.publishedRevision > 0) yield* this.publish(lane);
	}

	*addCitations(
		citations: readonly ProviderTextCitation[],
		hint: ContentLane = {},
	): Generator<AgentEvent> {
		const changed = new Set<Lane>();
		for (const citation of citations) {
			const key = JSON.stringify(citation);
			const outputIndex = citation.outputIndex ?? hint.outputIndex;
			if (!hint.blockId && outputIndex == null) {
				// The legacy unindexed contract addresses the whole turn's text, not
				// whichever lane happened to stream last. Retain metadata-first sources
				// without inventing an empty lane that the real text can never reach.
				if (this.globalCitations.has(key)) continue;
				this.globalCitations.set(key, citation);
				for (const lane of this.lanes) {
					if (lane.kind !== "text" || !this.globalCitationsFor(lane).length) continue;
					lane.revision++;
					this.dirty.add(lane);
					changed.add(lane);
				}
				continue;
			}
			const lane = this.resolve("text", { ...hint, outputIndex }, true);
			if (lane.citations.has(key)) continue;
			lane.citations.set(key, citation);
			lane.revision++;
			this.dirty.add(lane);
			changed.add(lane);
		}
		for (const lane of changed) {
			if (lane.publishedRevision > 0) yield* this.publish(lane);
		}
	}

	private globalCitationsFor(lane: Lane): ProviderTextCitation[] {
		const result: ProviderTextCitation[] = [];
		for (const citation of this.globalCitations.values()) {
			const start = citation.startIndex ?? citation.endIndex;
			const end = citation.endIndex;
			for (const span of this.textSpans) {
				if (span.lane !== lane) continue;
				const from = Math.max(start, span.start);
				const to = Math.min(end, span.end);
				const point = start === end && end <= span.end && (end > span.start || end === 0);
				if (from >= to && !point) continue;
				result.push({
					...citation,
					startIndex: from - span.start + span.blockStart,
					endIndex: to - span.start + span.blockStart,
				});
			}
		}
		return result;
	}

	*boundary(event: {
		kind: ContentKind;
		phase: "start" | "checkpoint" | "complete";
		blockId?: string;
		outputIndex?: number;
	}): Generator<AgentEvent> {
		if (event.phase === "start") {
			yield* this.begin(event.kind, event);
			return;
		}
		const lane = this.resolve(event.kind, event, true);
		yield* this.publish(lane);
		if (event.phase === "complete") {
			if (this.active === lane) this.active = undefined;
			if (this.anonymous.get(event.kind) === lane) this.anonymous.delete(event.kind);
		}
	}

	/** Checkpoint before even the first tool UI chunk, not merely before execution. */
	*beforeExternal(id: string, outputIndex?: number): Generator<AgentEvent> {
		yield* this.flush();
		this.observeExternal(id, outputIndex);
		this.active = undefined;
		// No native id means a later text→tool→text run is a NEW content block.
		this.anonymous.clear();
	}

	observeExternal(id: string, outputIndex?: number): number {
		if (outputIndex != null) this.nextOrder = Math.max(this.nextOrder, outputIndex + 1);
		const existing = this.externalOrder.get(id);
		if (existing) {
			if (outputIndex != null) existing.outputIndex = outputIndex;
			return existing.outputIndex ?? existing.order;
		}
		const entry = { order: this.nextOrder++, outputIndex };
		this.externalOrder.set(id, entry);
		return outputIndex ?? entry.order;
	}

	private snapshot(lane: Lane): TextualBlock {
		const identity = {
			id: lane.id,
			revision: lane.revision,
			rawTextLength: lane.text.length,
			outputIndex: lane.nativeIndex ?? lane.order,
		};
		if (lane.kind === "reasoning") {
			return { type: "reasoning", text: lane.text, providerMetadata: lane.metadata, ...identity };
		}
		const finalized = finalizeAssistantTextWithCitations(lane.text, [
			...lane.citations.values(),
			...this.globalCitationsFor(lane),
		]);
		return {
			type: "text",
			text: finalized.text,
			...(finalized.citations.length ? { citations: finalized.citations } : {}),
			...identity,
		};
	}

	private *publish(lane: Lane): Generator<AgentEvent> {
		if (lane.revision <= lane.publishedRevision || (!lane.text && !lane.metadata)) return;
		const block = this.snapshot(lane);
		yield { type: "block_complete", block };
		// Only reached when the event consumer has finished the awaited write.
		lane.publishedRevision = block.revision as number;
		if (lane.revision === lane.publishedRevision) this.dirty.delete(lane);
	}

	*flush(): Generator<AgentEvent> {
		// Tool arguments can produce thousands of chunks. A clean checkpoint must
		// not repeatedly walk/serialize every block already published this turn.
		for (const lane of [...this.dirty].sort((a, b) => a.order - b.order)) {
			yield* this.publish(lane);
		}
	}

	/** Compatibility protocols have one text field; derive it from the SAME lanes. */
	finalizeText() {
		const raw = this.textSpans
			.map((span) => span.lane.text.slice(span.blockStart, span.blockStart + span.end - span.start))
			.join("");
		const citations = [...this.globalCitations.values()];
		for (const span of this.textSpans) {
			for (const citation of span.lane.citations.values()) {
				const start = citation.startIndex ?? citation.endIndex;
				const end = citation.endIndex;
				const spanEnd = span.blockStart + span.end - span.start;
				const from = Math.max(start, span.blockStart);
				const to = Math.min(end, spanEnd);
				const point = start === end && end <= spanEnd && (end > span.blockStart || end === 0);
				if (from >= to && !point) continue;
				citations.push({
					...citation,
					startIndex: from - span.blockStart + span.start,
					endIndex: to - span.blockStart + span.start,
				});
			}
		}
		return finalizeAssistantTextWithCitations(raw, citations);
	}
	/** Includes native credentials and block-local citation coordinates for replay. */
	orderedContent(external: readonly ContentBlock[] = []): ContentBlock[] {
		const entries = this.lanes
			.filter((lane) => lane.text || lane.metadata)
			.map((lane) => ({ block: this.snapshot(lane) as ContentBlock, order: lane.order }));
		let redactedIndex = 0;
		for (const [index, block] of external.entries()) {
			const id =
				block.type === "tool_use"
					? block.toolUseId
					: block.type === "redacted_thinking"
						? `redacted:${redactedIndex++}`
						: "id" in block
							? block.id
							: undefined;
			const observed = id ? this.externalOrder.get(id) : undefined;
			entries.push({ block, order: observed?.order ?? this.nextOrder + index });
		}
		entries.sort(
			(a, b) =>
				(a.block.outputIndex ?? a.order) - (b.block.outputIndex ?? b.order) || a.order - b.order,
		);
		return entries.map(({ block }) => block);
	}
}
