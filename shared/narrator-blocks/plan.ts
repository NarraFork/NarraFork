/**
 * plan.ts — the block rows an envelope's stored content and ledger call for
 * (docs/BLOCK_STORAGE-DESIGN.md §4.1, §4.6).
 *
 * The store's sync and the backfill job both turn an envelope into the same rows: the
 * store on the main thread for the one envelope it just wrote, the backfill in a
 * read-only worker for a slice of old envelopes. Planning is pure, so both run this one
 * function and only differ in how they write the result.
 */

import { isBrokenToolOutput, outputToText, toolOutputImages } from "../agent-protocol/tool-output";
import { type DecodableMessage, INTERNAL_READ_TOOL_USE_PREFIX } from "./decode";
import { type BlockDraft, splitEnvelope } from "./storage";
import type { CanonicalBlock } from "./types";

/** A stored ledger attempt, as read from `narrator_tool_calls`. */
export interface PlanLedgerRow {
	toolUseId: string;
	toolName: string;
	inputJson: string | null;
	outputJson: string | null;
	status: string;
}

/** An envelope's stored columns, with its content already parsed. */
export type PlanEnvelope = Omit<DecodableMessage, "contentJson" | "toolCalls"> & {
	contentJson: unknown[];
};

export interface PlannedBlock {
	draft: BlockDraft;
	/** `payload` and `state` as stored. */
	payload: string;
	state: string | null;
	/** Characters this block puts in front of the model. */
	modelChars: number;
	byteSize: number;
	/** The adopted ledger output of a tool block, when it has one. */
	output: unknown;
}

export function parseStored(value: string | null): unknown {
	if (value === null) return null;
	try {
		return JSON.parse(value);
	} catch {
		return value;
	}
}

/**
 * The attempt the model sees per tool use: the newest one. `rows` are a message's
 * non-internal ledger rows in (tool_use_id, execution_attempt, created_at, id) order.
 */
export function adoptedLedger<T extends Pick<PlanLedgerRow, "toolUseId">>(rows: readonly T[]): T[] {
	const latest = new Map<string, T>();
	for (const row of rows) {
		if (row.toolUseId.startsWith(INTERNAL_READ_TOOL_USE_PREFIX)) continue;
		latest.set(row.toolUseId, row);
	}
	return [...latest.values()];
}

function modelChars(block: CanonicalBlock | null): number {
	if (!block) return 0;
	switch (block.kind) {
		case "input":
		case "context":
			return block.modelText?.length ?? 0;
		case "output":
		case "reasoning":
			return block.payload.parts.reduce(
				(sum, part) => sum + (part.type === "text" ? part.text.length : 0),
				0,
			);
		case "tool":
			return JSON.stringify(block.payload.input ?? null).length;
	}
}

const INDEX_RESULT_CHARS = 64 * 1024;

/**
 * The text a block is found by (§4.6). The reindex job only fills entries the index lacks,
 * trusting the ones the store wrote, so changing this text needs the block index cleared
 * (`narrator_blocks_fts`) and the job started over for existing blocks to follow.
 */
export function blockIndexText(block: CanonicalBlock | null, adoptedOutput?: unknown): string {
	if (!block) return "";
	switch (block.kind) {
		case "input":
		case "context":
			if (block.modelText) return block.modelText;
			if (block.kind === "context") {
				const body = block.payload.body;
				return [body?.title, body?.text, body?.message, body?.summary]
					.filter((value): value is string => typeof value === "string")
					.join("\n");
			}
			return block.payload.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
		case "output":
		case "reasoning":
			return block.payload.parts.map((part) => (part.type === "text" ? part.text : "")).join("");
		case "tool": {
			const result =
				adoptedOutput === undefined ? "" : outputToText(adoptedOutput).slice(0, INDEX_RESULT_CHARS);
			return [block.subtype, JSON.stringify(block.payload.input ?? null), result]
				.filter(Boolean)
				.join("\n");
		}
	}
}

/** Uploads and images a block references, by role (§4.1). */
export function blockAssets(
	draft: BlockDraft,
	adoptedOutput: unknown,
): Array<[assetId: string, role: string]> {
	const assets: Array<[string, string]> = [];
	for (const element of draft.payload.raw) {
		if (!element || typeof element !== "object") continue;
		const raw = element as Record<string, unknown>;
		if (raw.type === "image" && typeof raw.imageId === "string")
			assets.push([raw.imageId, "input_image"]);
		else if (raw.type === "text_file" && typeof raw.fileId === "string")
			assets.push([raw.fileId, "input_file"]);
		else if (raw.type === "image_generation" && typeof raw.savedPath === "string")
			assets.push([raw.savedPath, "output_image"]);
	}
	if (draft.kind === "tool" && !isBrokenToolOutput(adoptedOutput))
		for (const image of toolOutputImages(adoptedOutput)) assets.push([image.imageId, "tool_image"]);
	return [...new Map(assets.map((asset) => [asset[0], asset])).values()];
}

/**
 * The rows an envelope's content and adopted ledger call for, in ordinal order, with the
 * envelope's `body_bytes` (the sum of their stored sizes).
 */
export function planEnvelopeBlocks(
	envelope: PlanEnvelope,
	ledger: readonly PlanLedgerRow[],
	options: { streaming?: boolean } = {},
): { blocks: PlannedBlock[]; bodyBytes: number } {
	const outputs = new Map(ledger.map((call) => [call.toolUseId, parseStored(call.outputJson)]));
	const drafts = splitEnvelope(
		{
			...envelope,
			toolCalls: ledger.map((call) => ({
				toolUseId: call.toolUseId,
				toolName: call.toolName,
				inputJson: parseStored(call.inputJson),
				outputJson: parseStored(call.outputJson),
				status: call.status,
			})),
		},
		{ streaming: options.streaming },
	).blocks;
	let bodyBytes = 0;
	const blocks = drafts.map((draft) => {
		const payload = JSON.stringify(draft.payload);
		const state = draft.state === null ? null : JSON.stringify(draft.state);
		const byteSize = utf8Bytes(payload) + utf8Bytes(state ?? "") + utf8Bytes(draft.modelText ?? "");
		bodyBytes += byteSize;
		return {
			draft,
			payload,
			state,
			modelChars: modelChars(draft.canonical),
			byteSize,
			output: draft.wireId ? outputs.get(draft.wireId) : undefined,
		};
	});
	return { blocks, bodyBytes };
}

function utf8Bytes(text: string): number {
	return text ? Buffer.byteLength(text) : 0;
}
