/**
 * First projection stage (docs/BLOCK_STORAGE-DESIGN.md §7.2): canonical envelopes →
 * provider-neutral turns.
 *
 * Everything that decides what the model sees lives here, once, for every provider:
 * which blocks are visible, how a step's items and its tool results are grouped, the
 * order of results (call order), whether a reasoning credential belongs to the target,
 * and the model text of inputs. Each provider's second stage only maps these turns to
 * its wire format.
 */

import { signatureSourcesCompatible } from "@shared/agent-protocol/reasoning-source";
import { outputToText } from "@shared/agent-protocol/tool-output";
import type { WebSearchAction } from "@shared/agent-protocol/types";
import {
	type CanonicalEnvelope,
	type ContextUpdate,
	isModelVisible,
	type ToolChange,
} from "@shared/narrator-blocks/types";

/** What the request targets; everything here can change the projected bytes. */
export interface ProjectionTarget {
	/** Whether the target model's reasoning credentials are bound to their upstream. */
	strict: boolean;
	/** Identity of the upstream the request goes to (reasoning credential source). */
	reasoningSource?: string;
}

/** An image ready for the wire. */
export interface ResolvedImage {
	/** MIME type of the bytes, e.g. `image/png`. */
	mediaType: string;
	/** Short format name, e.g. `png`. */
	format: string;
	base64: string;
}

/** Bytes the second stage needs, prefetched off the projection path. */
export interface ProjectionAssets {
	/** Image slots of an input block, index-aligned with its image parts; null = unreadable. */
	inputImages: ReadonlyMap<string, ReadonlyArray<ResolvedImage | null>>;
	/** Base64 result of a provider-executed image generation, by block id. */
	generatedImages: ReadonlyMap<string, string>;
	/** Readable images a local tool returned, by tool block id; unreadable ones are left out. */
	toolResultImages: ReadonlyMap<string, readonly ResolvedImage[]>;
}

export const NO_ASSETS: ProjectionAssets = {
	inputImages: new Map(),
	generatedImages: new Map(),
	toolResultImages: new Map(),
};

export interface NeutralInputItem {
	envelopeId: string;
	/** `sys` items are runtime context; the second stage decides where that may go. */
	role: "user" | "sys";
	text: string;
	/** Index-aligned with `[image #N]` placeholders; null keeps the slot of an unreadable image. */
	images: ReadonlyArray<ResolvedImage | null>;
	toolChange?: ToolChange;
	/** Host state replacement, not a new top-level system prompt. */
	contextUpdate?: ContextUpdate;
}

export interface NeutralInputGroup {
	kind: "input";
	items: NeutralInputItem[];
}

export type NeutralAssistantItem =
	| { kind: "text"; blockId: string; text: string }
	| {
			kind: "reasoning";
			blockId: string;
			text: string;
			/** Whether the stored credential was minted by the request's upstream. */
			sameSource: boolean;
			/** Legacy credential container (`anthropic`, `openai`, `gemini`, `plugin` keys). */
			credentials: Record<string, unknown>;
			source?: string;
	  }
	| { kind: "redacted_reasoning"; blockId: string; data: string; sameSource: boolean }
	| {
			kind: "tool_call";
			blockId: string;
			wireId: string;
			name: string;
			input: Record<string, unknown>;
			/** Gemini thought signature of the call, if any. */
			signature?: { value: string; sameSource: boolean };
	  }
	| {
			kind: "web_search";
			blockId: string;
			wireId: string;
			query?: string;
			queries?: string[];
			action?: WebSearchAction;
	  }
	| {
			kind: "image_generation";
			blockId: string;
			wireId: string;
			revisedPrompt?: string;
			savedPath?: string;
			/** Base64 bytes, when readable. */
			result?: string;
	  };

export interface NeutralAssistantTurn {
	kind: "assistant";
	envelopeId: string;
	upstreamMessageId?: string;
	items: NeutralAssistantItem[];
}

export interface NeutralToolResult {
	wireId: string;
	name: string;
	isError: boolean;
	text: string;
	images: ResolvedImage[];
}

export interface NeutralToolResults {
	kind: "tool_results";
	envelopeId: string;
	results: NeutralToolResult[];
}

export type NeutralTurn = NeutralInputGroup | NeutralAssistantTurn | NeutralToolResults;

export interface NeutralHistory {
	turns: NeutralTurn[];
	/** Input envelopes whose content is part of the projection (delivery receipts). */
	emittedInputIds: string[];
}

function record(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function strings(value: unknown): string[] | undefined {
	return Array.isArray(value) && value.every((item) => typeof item === "string")
		? (value as string[])
		: undefined;
}

function assistantItems(
	envelope: CanonicalEnvelope,
	target: ProjectionTarget,
	assets: ProjectionAssets,
): NeutralAssistantItem[] {
	const items: NeutralAssistantItem[] = [];
	for (const block of envelope.blocks) {
		if (!isModelVisible(block)) continue;
		switch (block.kind) {
			case "output": {
				const text = block.payload.parts
					.map((part) => (part.type === "text" ? part.text : ""))
					.join("");
				if (text) items.push({ kind: "text", blockId: block.id, text });
				break;
			}
			case "reasoning": {
				const source = block.providerMeta?.source;
				const sameSource = signatureSourcesCompatible(source, target.reasoningSource);
				const wire = record(block.providerMeta?.wire);
				if (block.payload.redacted) {
					const data = typeof wire.data === "string" ? wire.data : "";
					if (data) items.push({ kind: "redacted_reasoning", blockId: block.id, data, sameSource });
					break;
				}
				const text = block.payload.parts.map((part) => part.text).join("");
				items.push({
					kind: "reasoning",
					blockId: block.id,
					text,
					sameSource,
					credentials: wire,
					...(source ? { source } : {}),
				});
				break;
			}
			case "tool": {
				if (block.payload.executor === "provider") {
					const input = record(block.payload.input);
					if (block.subtype === "web_search") {
						items.push({
							kind: "web_search",
							blockId: block.id,
							wireId: block.wireId,
							...(typeof input.query === "string" ? { query: input.query } : {}),
							...(strings(input.queries) ? { queries: strings(input.queries) } : {}),
							...(input.action ? { action: input.action as WebSearchAction } : {}),
						});
					} else if (block.subtype === "image_generation") {
						const result = record(block.providerMeta?.result);
						const bytes =
							assets.generatedImages.get(block.id) ??
							(typeof result.result === "string" && result.result ? result.result : undefined);
						items.push({
							kind: "image_generation",
							blockId: block.id,
							wireId: block.wireId,
							...(typeof result.revisedPrompt === "string"
								? { revisedPrompt: result.revisedPrompt }
								: {}),
							...(typeof result.savedPath === "string" ? { savedPath: result.savedPath } : {}),
							...(bytes ? { result: bytes } : {}),
						});
					}
					break;
				}
				// A local call is only part of the conversation together with its result.
				if (!envelope.toolOutputs?.[block.wireId]) break;
				const wire = record(block.providerMeta?.wire);
				const signature = typeof wire.thoughtSignature === "string" ? wire.thoughtSignature : "";
				items.push({
					kind: "tool_call",
					blockId: block.id,
					wireId: block.wireId,
					name: block.subtype,
					input: record(block.payload.input),
					...(signature
						? {
								signature: {
									value: signature,
									sameSource: signatureSourcesCompatible(
										block.providerMeta?.source,
										target.reasoningSource,
									),
								},
							}
						: {}),
				});
				break;
			}
			default:
				break;
		}
	}
	return items;
}

function toolResults(envelope: CanonicalEnvelope, assets: ProjectionAssets): NeutralToolResult[] {
	const results: NeutralToolResult[] = [];
	for (const block of envelope.blocks) {
		if (block.kind !== "tool" || block.payload.executor !== "local" || !isModelVisible(block))
			continue;
		const output = envelope.toolOutputs?.[block.wireId];
		if (!output) continue;
		const appendix = block.payload.result?.appendix;
		const text = outputToText(output.output);
		results.push({
			wireId: block.wireId,
			name: block.subtype,
			isError: output.status === "fail",
			text: appendix ? `${text}${appendix}` : text,
			images: [...(assets.toolResultImages.get(block.id) ?? [])],
		});
	}
	return results;
}

/**
 * Project canonical envelopes, in history order, into neutral turns.
 *
 * Envelopes placed under another call (`parentToolUseId`) belong to a nested
 * conversation and are skipped; the caller re-mounts a session's own turns first.
 */
export function toTurns(
	envelopes: readonly CanonicalEnvelope[],
	target: ProjectionTarget,
	assets: ProjectionAssets = NO_ASSETS,
): NeutralHistory {
	const turns: NeutralTurn[] = [];
	const emittedInputIds: string[] = [];
	let group: NeutralInputGroup | undefined;
	for (const envelope of envelopes) {
		if (envelope.parentToolUseId) continue;
		if (envelope.role === "assistant") {
			group = undefined;
			const items = assistantItems(envelope, target, assets);
			if (items.length === 0) continue;
			turns.push({
				kind: "assistant",
				envelopeId: envelope.id,
				...(envelope.upstreamMessageId ? { upstreamMessageId: envelope.upstreamMessageId } : {}),
				items,
			});
			const results = toolResults(envelope, assets);
			if (results.length) turns.push({ kind: "tool_results", envelopeId: envelope.id, results });
			continue;
		}
		if (envelope.role !== "user" && envelope.role !== "sys") continue;
		const block = envelope.blocks[0];
		if (!block || !isModelVisible(block)) continue;
		if (block.kind !== "input" && block.kind !== "context") continue;
		const item: NeutralInputItem = {
			envelopeId: envelope.id,
			role: envelope.role,
			text: block.modelText ?? "",
			images: block.kind === "input" ? (assets.inputImages.get(block.id) ?? []) : [],
			...(block.kind === "context" && block.toolChange ? { toolChange: block.toolChange } : {}),
			...(block.kind === "context" && block.contextUpdate
				? { contextUpdate: block.contextUpdate }
				: {}),
		};
		if (!group) {
			group = { kind: "input", items: [] };
			turns.push(group);
		}
		group.items.push(item);
		emittedInputIds.push(envelope.id);
	}
	return { turns, emittedInputIds };
}

/** `[Web search: …]` summary for protocols without a native search item. */
export function webSearchSummary(
	item: Extract<NeutralAssistantItem, { kind: "web_search" }>,
): string {
	const action = item.action;
	if (action?.type === "open_page" && action.url) return `[Web search: opened ${action.url}]`;
	if (action?.type === "find_in_page") {
		const parts = [action.pattern ? `'${action.pattern}'` : null, action.url].filter(Boolean);
		return `[Web search: find ${parts.join(" in ")}]`;
	}
	const query =
		item.query ||
		action?.query ||
		item.queries?.join(", ") ||
		action?.queries?.join(", ") ||
		"unknown";
	return `[Web search: ${query}]`;
}
