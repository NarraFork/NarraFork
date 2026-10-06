/**
 * Native system-injection content blocks shared by server and clients.
 *
 * The persisted wire format is self-contained: `modelText` is the exact model-facing
 * projection and `body` is the reader-facing structured projection. Legacy rows may still
 * carry a sibling text block; the view helper below maps that pair to one logical block
 * without mutating persisted data.
 */

import { coerceSideCarBody, type SideCarBody } from "./sidecar-body";

/** Canonical reader-facing block attached to a system injection message. */
export interface NativeInjectionBlock {
	type: "system_injection";
	/** The exact model-facing projection; replaces the legacy sibling text block. */
	modelText?: string;
	source: string;
	body?: SideCarBody;
}

/** Structured system blocks that can carry their own model projection. */
export const NATIVE_MODEL_CONTEXT_BLOCK_TYPES = [
	"system_injection",
	"spec_continuation",
	"spec_blocked_continuation",
	"knowledge_hint",
	"container_ready",
	"browser_session_lost",
	"merge_summary",
] as const;

export type NativeModelContextBlockType = (typeof NATIVE_MODEL_CONTEXT_BLOCK_TYPES)[number];

export type NativeModelContextBlock = {
	type: NativeModelContextBlockType;
	modelText: string;
	[key: string]: unknown;
};

export function isNativeModelContextBlock(value: unknown): value is NativeModelContextBlock {
	if (!value || typeof value !== "object") return false;
	const record = value as { type?: unknown; modelText?: unknown };
	return (
		typeof record.type === "string" &&
		NATIVE_MODEL_CONTEXT_BLOCK_TYPES.includes(record.type as NativeModelContextBlockType) &&
		typeof record.modelText === "string"
	);
}

function nonEmptyString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: undefined;
}

/**
 * Normalize a legacy injection block to the native wire shape.
 *
 * Supported historical spellings are intentionally limited to shapes that were
 * emitted by the injection/side-car migration: `sidecar`, `side_car`, `injection`,
 * and `system-injection`. Unknown blocks are rejected rather than guessed at.
 */
export function normalizeLegacyInjectionBlock(value: unknown): NativeInjectionBlock | undefined {
	const record = asRecord(value);
	if (!record) return undefined;

	const type = record.type;
	if (
		type !== "sidecar" &&
		type !== "side_car" &&
		type !== "injection" &&
		type !== "system-injection"
	) {
		return undefined;
	}

	const source = nonEmptyString(record.source);
	if (!source) return undefined;
	const bodyValue = record.body ?? record.bodyJson ?? record.sidecarBody;
	const body = bodyValue === undefined ? undefined : coerceSideCarBody(bodyValue);
	if (bodyValue !== undefined && !body) return undefined;
	const modelText = typeof record.modelText === "string" ? record.modelText : undefined;
	return {
		type: "system_injection",
		source,
		...(modelText !== undefined ? { modelText } : {}),
		...(body ? { body } : {}),
	};
}

/**
 * Read either the canonical native block or a supported legacy block.
 * Returns a fresh canonical object and never mutates the input.
 */
export function normalizeNativeInjectionBlock(value: unknown): NativeInjectionBlock | undefined {
	const record = asRecord(value);
	if (!record) return undefined;
	if (record.type === "system_injection") {
		const source = nonEmptyString(record.source);
		if (!source) return undefined;
		const bodyValue = record.body;
		const body = bodyValue === undefined ? undefined : coerceSideCarBody(bodyValue);
		if (bodyValue !== undefined && !body) return undefined;
		const modelText = typeof record.modelText === "string" ? record.modelText : undefined;
		return {
			type: "system_injection",
			source,
			...(modelText !== undefined ? { modelText } : {}),
			...(body ? { body } : {}),
		};
	}
	return normalizeLegacyInjectionBlock(value);
}

/** Return the exact model-facing projection from native or legacy blocks. */
export function modelTextFromContentBlocks(blocks: readonly unknown[]): string {
	const projections: string[] = [];
	for (const block of blocks) {
		if (isTextBlock(block)) {
			projections.push(block.text);
			continue;
		}
		if (isNativeModelContextBlock(block)) projections.push(block.modelText);
	}
	return projections.join("\n");
}

export interface InjectionBlockView {
	block: NativeInjectionBlock;
	/** Physical contentJson indexes owned by this logical injection. */
	sourceIndices: number[];
	/** Physical index of the structured injection block. */
	blockIndex: number;
}

function isTextBlock(value: unknown): value is { type: "text"; text: string } {
	if (!value || typeof value !== "object") return false;
	const record = value as { type?: unknown; text?: unknown };
	return record.type === "text" && typeof record.text === "string";
}

function isCompanionForSource(value: unknown, source: string): boolean {
	if (!value || typeof value !== "object") return false;
	const type = (value as { type?: unknown }).type;
	return (
		(source === "bg_agent" && type === "background_agents_completed") ||
		(source === "subagent_message" && type === "subagent_messages")
	);
}

/**
 * Map physical contentJson blocks to logical injection blocks without changing indexes.
 *
 * Only the two historical shapes that the producer explicitly emitted are paired:
 * a leading text block with a legacy injection, plus its known producer companion.
 * Arbitrary adjacent text is never swallowed. Native blocks own their modelText and
 * therefore own only their own physical index.
 */
export function injectionBlockViews(blocks: readonly unknown[]): InjectionBlockView[] {
	const views: InjectionBlockView[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const block = normalizeNativeInjectionBlock(blocks[index]);
		if (!block) continue;
		const sourceIndices = [index];
		if (block.modelText === undefined && index > 0 && isTextBlock(blocks[index - 1])) {
			sourceIndices.unshift(index - 1);
		}
		for (let next = index + 1; next < blocks.length; next++) {
			if (isCompanionForSource(blocks[next], block.source)) sourceIndices.push(next);
		}
		const modelText =
			block.modelText ??
			(sourceIndices.includes(index - 1) && isTextBlock(blocks[index - 1])
				? (blocks[index - 1] as { type: "text"; text: string }).text
				: undefined);
		views.push({
			block: modelText === undefined ? block : { ...block, modelText },
			sourceIndices,
			blockIndex: index,
		});
	}
	return views;
}

export interface ContextBlockView {
	block: NativeModelContextBlock;
	/** Physical contentJson indexes owned by this logical context block. */
	sourceIndices: number[];
	blockIndex: number;
}

/**
 * Map first-party structured system cards to logical blocks. Native cards own one
 * physical index. Legacy cards are paired only with their immediately preceding
 * model text, never with arbitrary text elsewhere in the message.
 */
export function contextBlockViews(blocks: readonly unknown[]): ContextBlockView[] {
	const views: ContextBlockView[] = [];
	for (let index = 0; index < blocks.length; index++) {
		const raw = blocks[index];
		if (!raw || typeof raw !== "object") continue;
		const record = raw as Record<string, unknown>;
		const type = record.type;
		if (
			type !== "spec_continuation" &&
			type !== "spec_blocked_continuation" &&
			type !== "knowledge_hint" &&
			type !== "container_ready" &&
			type !== "browser_session_lost" &&
			type !== "merge_summary"
		) {
			continue;
		}
		const sourceIndices = [index];
		if (typeof record.modelText !== "string" && index > 0 && isTextBlock(blocks[index - 1])) {
			sourceIndices.unshift(index - 1);
		}
		const block = {
			...record,
			modelText:
				typeof record.modelText === "string"
					? record.modelText
					: sourceIndices.includes(index - 1) && isTextBlock(blocks[index - 1])
						? (blocks[index - 1] as { type: "text"; text: string }).text
						: "",
		} as NativeModelContextBlock;
		views.push({ block, sourceIndices, blockIndex: index });
	}
	return views;
}

/** Alias emphasizing that this is a coercion of untrusted persisted JSON. */
export const coerceNativeInjectionBlock = normalizeNativeInjectionBlock;
