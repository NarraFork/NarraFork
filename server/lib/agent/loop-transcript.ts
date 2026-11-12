/**
 * loop-transcript.ts — the rows an agent loop's requests are projected from, in memory.
 *
 * A hosted loop's conversation is persisted by its host (`narrator-store.ts`) from the
 * events the loop yields, and every later request is the host's rebuild of those rows.
 * A loop without a host — a reflection, a search probe — has nobody persisting, so it
 * keeps the same rows itself, written at the same points with the same shapes:
 *   - `appendInput`: the turn's input, once the model has answered it;
 *   - `appendStep`: the assistant step, its tool_use blocks with ledger entries (once its
 *     tools have run, so a redirected input is already the one in the block);
 *   - `settleTool`: a call's result.
 * Each request is then `buildAdapterHistory` over these rows — the projection a rebuild
 * runs — so no loop has a second way of building history.
 *
 * A hosted loop keeps a transcript too: the host's rows seed it and every rebuild
 * replaces it, so a failed rebuild still has the conversation to project, and a
 * reflection starts from exactly the rows its parent's request was projected from (the
 * same bytes, the same cacheable prefix).
 *
 * Rows are never changed once written (a settled call replaces its step), so a
 * snapshot keeps describing the request it was taken for. Images have no upload store
 * here and carry their bytes (`data`), which stored rows never do.
 */

import { encodeToolOutput, type ToolOutputImageRef } from "@shared/agent-protocol/tool-output";
import {
	type MediaContentBlock,
	type MediaRef,
	mediaRefToContentBlock,
} from "@shared/media-attachments";
import type { DbMessage, DbToolCall } from "./provider";
import { markSenderProjected } from "./sender-projection";
import type { ContentBlock } from "./types";

export interface TranscriptImage {
	format: string;
	base64: string;
}

export interface TranscriptToolResult {
	output: string;
	isError?: boolean;
	images?: readonly TranscriptImage[];
	/** Images already saved by a tool worker; do not decode and upload them again. */
	imageRefs?: readonly Extract<ToolOutputImageRef, { uploadNarratorId: string }>[];
	/** Replay uses durable original assets; provider bytes never enter transcript rows. */
	mediaRefs?: readonly MediaContentBlock[];
	/** The call's input was invalid and it never ran; the model's history leaves it out. */
	broken?: boolean;
}

let rowSequence = 0;
const nextRowId = () => `loop-row-${++rowSequence}`;

function mediaType(format: string): string {
	return format.includes("/") ? format : `image/${format === "jpg" ? "jpeg" : format}`;
}

/**
 * The turn's input as a user row. Its text is already what the model reads (the loop's
 * prompt, a correction, unpersisted host text), so the projection adds no attribution.
 */
function inputRow(
	text: string,
	images: readonly TranscriptImage[] = [],
	media: readonly MediaRef[] = [],
): DbMessage {
	const id = nextRowId();
	return markSenderProjected({
		id,
		role: "user",
		contentJson: [
			...(text ? [{ type: "text", text }] : []),
			...images.map((image, index) => ({
				type: "image",
				imageId: `${id}-${index}`,
				mediaType: mediaType(image.format),
				data: image.base64,
			})),
			...media.map((ref) => mediaRefToContentBlock(ref)),
		],
		contentText: text,
		parentToolUseId: null,
		messageUuid: null,
	});
}

/** A loop content block as the store writes it into a step (`narrator-event-handler`). */
function stepBlock(block: ContentBlock): Record<string, unknown> {
	if (block.type !== "tool_use") return { ...block };
	const { toolUseId, ...rest } = block;
	return { ...rest, id: toolUseId };
}

export class LoopTranscript {
	#rows: DbMessage[];

	constructor(rows: readonly DbMessage[] = []) {
		this.#rows = [...rows];
	}

	/** A snapshot: later writes never show up in it. */
	get rows(): DbMessage[] {
		return [...this.#rows];
	}

	/** The rows plus an input the model has not answered yet: what a request with it reads. */
	withInput(
		text: string,
		images?: readonly TranscriptImage[],
		media?: readonly MediaRef[],
	): DbMessage[] {
		return text || images?.length || media?.length
			? [...this.#rows, inputRow(text, images, media)]
			: this.rows;
	}

	/** Take over a host's rebuild: its rows are the conversation from here on. */
	replace(rows: readonly DbMessage[]): void {
		this.#rows = [...rows];
	}

	appendInput(
		text: string,
		images?: readonly TranscriptImage[],
		media?: readonly MediaRef[],
	): void {
		if (text || images?.length || media?.length) this.#rows.push(inputRow(text, images, media));
	}

	/** An assistant step; its tool calls are open until settled. */
	appendStep(content: readonly ContentBlock[]): void {
		if (content.length === 0) return;
		const toolCalls: DbToolCall[] = content.flatMap((block) =>
			block.type === "tool_use"
				? [
						{
							toolUseId: block.toolUseId,
							toolName: block.name,
							inputJson: block.input,
							outputJson: null,
							status: "running",
						},
					]
				: [],
		);
		this.#rows.push({
			id: nextRowId(),
			role: "assistant",
			contentJson: content.map(stepBlock),
			contentText: null,
			parentToolUseId: null,
			messageUuid: null,
			...(toolCalls.length ? { toolCalls } : {}),
		});
	}

	/** Settle the latest open call with this id; a call nobody opened is ignored. */
	settleTool(toolUseId: string, result: TranscriptToolResult): void {
		for (let index = this.#rows.length - 1; index >= 0; index--) {
			const row = this.#rows[index];
			const call = row.toolCalls?.find((entry) => entry.toolUseId === toolUseId);
			if (!call) continue;
			const settled: DbToolCall = {
				...call,
				status: result.isError ? "fail" : "success",
				outputJson: encodeToolOutput(result.output, {
					...(result.broken ? { broken: true } : {}),
					...(!result.broken && (result.imageRefs?.length || result.images?.length)
						? {
								images: [
									...(result.imageRefs ?? []),
									...(result.images ?? []).map((image, position) => ({
										imageId: `${toolUseId}-${position}`,
										mediaType: mediaType(image.format),
										data: image.base64,
									})),
								],
							}
						: {}),
					...(!result.broken && result.mediaRefs?.length ? { media: [...result.mediaRefs] } : {}),
				}),
			};
			this.#rows[index] = {
				...row,
				toolCalls: row.toolCalls?.map((entry) => (entry === call ? settled : entry)),
			};
			return;
		}
	}
}
