import { toolOutputImages } from "@shared/agent-protocol/tool-output";
import { isMediaContentBlock } from "@shared/media-attachments";
import { and, eq, gt, inArray, or } from "drizzle-orm";
import { db, postgresRuntime } from "../db";
import * as pg from "../db/postgres-schema";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../db/schema";
import { contentJsonSql, fillBodies } from "./narrator-body-reads";

const PAGE_SIZE = 16;
const MAX_TOOLS_PER_PAGE = 64;

/**
 * Whether one stored value references the upload being authorized. `fallbackOwner` is
 * the row's own narrator: blocks written before `uploadNarratorId` existed belong to it.
 */
interface UploadReferenceMatcher {
	content(blocks: unknown, fallbackOwner: string): boolean;
	toolOutput(output: unknown, fallbackOwner: string): boolean;
}

function parseStored(json: unknown): unknown {
	if (!json) return undefined;
	try {
		return typeof json === "string" ? JSON.parse(json) : json;
	} catch {
		return undefined;
	}
}

function mediaMatcher(owner: string, mediaId: string): UploadReferenceMatcher {
	const matches = (blocks: unknown, fallbackOwner: string) =>
		Array.isArray(blocks) &&
		blocks.some(
			(block) =>
				isMediaContentBlock(block) &&
				block.mediaId === mediaId &&
				(block.uploadNarratorId || fallbackOwner) === owner,
		);
	return {
		content: matches,
		toolOutput: (output, fallbackOwner) =>
			matches(
				output && typeof output === "object" && "_media" in output ? output._media : null,
				fallbackOwner,
			),
	};
}

function imageMatcher(owner: string, imageId: string): UploadReferenceMatcher {
	return {
		// Persisted user-message image blocks (`imageRefToContentBlock`).
		content: (blocks, fallbackOwner) =>
			Array.isArray(blocks) &&
			blocks.some((block) => {
				if (!block || typeof block !== "object") return false;
				const image = block as { type?: unknown; imageId?: unknown; uploadNarratorId?: unknown };
				const uploader =
					typeof image.uploadNarratorId === "string" && image.uploadNarratorId
						? image.uploadNarratorId
						: fallbackOwner;
				return image.type === "image" && image.imageId === imageId && uploader === owner;
			}),
		// Images a tool returned (`_images`); stored refs always name their uploader.
		toolOutput: (output) =>
			toolOutputImages(output).some(
				(image) =>
					image.imageId === imageId &&
					"uploadNarratorId" in image &&
					image.uploadNarratorId === owner,
			),
	};
}

/**
 * Prove an exact owner/id media reference in ONE already-authorized narrator's refs.
 * See {@link narratorReferencesUpload} for what is and is not searched.
 */
export function narratorReferencesMedia(
	referencingNarratorId: string,
	uploadNarratorId: string,
	mediaId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	return narratorReferencesUpload(
		referencingNarratorId,
		mediaMatcher(uploadNarratorId, mediaId),
		signal,
	);
}

/**
 * Prove an exact owner/id image reference in ONE already-authorized narrator's refs:
 * a user-message image block or a tool output's `_images`. The image route uses it for
 * a fork or COW copy whose reader cannot read the session the image was uploaded to.
 */
export function narratorReferencesImage(
	referencingNarratorId: string,
	uploadNarratorId: string,
	imageId: string,
	signal?: AbortSignal,
): Promise<boolean> {
	return narratorReferencesUpload(
		referencingNarratorId,
		imageMatcher(uploadNarratorId, imageId),
		signal,
	);
}

/**
 * Prove an exact owner/id reference in ONE already-authorized narrator's refs.
 * COW copies need not retain the original message owner; tool calls are joined
 * by messageId, not narratorId, because forks can share another owner's message.
 * Never searches arbitrary narrators or treats knowledge of an upload id as access.
 *
 * No upload-reference index covers every message yet (`narrator_block_assets` skips
 * legacy and queued envelopes and is keyed by id alone, not owner/id). Keyset pages and
 * cancellation allow the lookup to yield between batches. A single large JSON value is
 * still read and parsed synchronously; eliminating that cost requires a streaming
 * reader or index.
 */
async function narratorReferencesUpload(
	referencingNarratorId: string,
	matcher: UploadReferenceMatcher,
	signal?: AbortSignal,
): Promise<boolean> {
	let cursor: { seq: number; refId: string } | undefined;
	const pgDb = postgresRuntime?.client.db;
	const readRows = async () => {
		if (pgDb) {
			return pgDb
				.select({
					id: pg.narratorMessages.id,
					owner: pg.narratorMessages.narratorId,
					seq: pg.narratorMessageRefs.seq,
					refId: pg.narratorMessageRefs.id,
					contentJson: contentJsonSql(pg.narratorMessages),
				})
				.from(pg.narratorMessageRefs)
				.innerJoin(
					pg.narratorMessages,
					eq(pg.narratorMessages.id, pg.narratorMessageRefs.messageId),
				)
				.where(
					and(
						eq(pg.narratorMessageRefs.narratorId, referencingNarratorId),
						cursor === undefined
							? undefined
							: or(
									gt(pg.narratorMessageRefs.seq, cursor.seq),
									and(
										eq(pg.narratorMessageRefs.seq, cursor.seq),
										gt(pg.narratorMessageRefs.id, cursor.refId),
									),
								),
					),
				)
				.orderBy(pg.narratorMessageRefs.seq, pg.narratorMessageRefs.id)
				.limit(PAGE_SIZE);
		}
		const rows = await db
			.select({
				id: narratorMessages.id,
				owner: narratorMessages.narratorId,
				seq: narratorMessageRefs.seq,
				refId: narratorMessageRefs.id,
				contentJson: contentJsonSql(),
			})
			.from(narratorMessageRefs)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorMessageRefs.messageId))
			.where(
				and(
					eq(narratorMessageRefs.narratorId, referencingNarratorId),
					cursor === undefined
						? undefined
						: or(
								gt(narratorMessageRefs.seq, cursor.seq),
								and(
									eq(narratorMessageRefs.seq, cursor.seq),
									gt(narratorMessageRefs.id, cursor.refId),
								),
							),
				),
			)
			.orderBy(narratorMessageRefs.seq, narratorMessageRefs.id)
			.limit(PAGE_SIZE);
		return fillBodies(rows);
	};
	const readCalls = (ids: string[], toolCursor: string | undefined) => {
		if (pgDb)
			return pgDb
				.select({
					id: pg.narratorToolCalls.id,
					messageId: pg.narratorToolCalls.messageId,
					owner: pg.narratorToolCalls.narratorId,
					output: pg.narratorToolCalls.outputJson,
				})
				.from(pg.narratorToolCalls)
				.where(
					and(
						inArray(pg.narratorToolCalls.messageId, ids),
						toolCursor === undefined ? undefined : gt(pg.narratorToolCalls.id, toolCursor),
					),
				)
				.orderBy(pg.narratorToolCalls.id)
				.limit(MAX_TOOLS_PER_PAGE);
		return db
			.select({
				id: narratorToolCalls.id,
				messageId: narratorToolCalls.messageId,
				owner: narratorToolCalls.narratorId,
				output: narratorToolCalls.outputJson,
			})
			.from(narratorToolCalls)
			.where(
				and(
					inArray(narratorToolCalls.messageId, ids),
					toolCursor === undefined ? undefined : gt(narratorToolCalls.id, toolCursor),
				),
			)
			.orderBy(narratorToolCalls.id)
			.limit(MAX_TOOLS_PER_PAGE);
	};

	const refStillExists = async (refId: string, messageId: string) => {
		signal?.throwIfAborted();
		const rows = pgDb
			? await pgDb
					.select({ id: pg.narratorMessageRefs.id })
					.from(pg.narratorMessageRefs)
					.where(
						and(
							eq(pg.narratorMessageRefs.id, refId),
							eq(pg.narratorMessageRefs.narratorId, referencingNarratorId),
							eq(pg.narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1)
			: await db
					.select({ id: narratorMessageRefs.id })
					.from(narratorMessageRefs)
					.where(
						and(
							eq(narratorMessageRefs.id, refId),
							eq(narratorMessageRefs.narratorId, referencingNarratorId),
							eq(narratorMessageRefs.messageId, messageId),
						),
					)
					.limit(1);
		signal?.throwIfAborted();
		return rows.length > 0;
	};

	while (true) {
		signal?.throwIfAborted();
		const rows = await readRows();
		signal?.throwIfAborted();
		if (!rows.length) return false;
		for (const row of rows) {
			signal?.throwIfAborted();
			if (
				matcher.content(parseStored(row.contentJson), row.owner) &&
				(await refStillExists(row.refId, row.id))
			)
				return true;
		}

		let toolCursor: string | undefined;
		while (true) {
			signal?.throwIfAborted();
			const calls = await readCalls(
				rows.map((row) => row.id),
				toolCursor,
			);
			signal?.throwIfAborted();
			for (const call of calls) {
				signal?.throwIfAborted();
				const ref = rows.find((row) => row.id === call.messageId);
				if (
					ref &&
					matcher.toolOutput(parseStored(call.output), call.owner) &&
					(await refStillExists(ref.refId, call.messageId))
				)
					return true;
			}
			if (calls.length < MAX_TOOLS_PER_PAGE) break;
			toolCursor = calls[calls.length - 1].id;
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
		}
		if (rows.length < PAGE_SIZE) return false;
		const last = rows[rows.length - 1];
		cursor = { seq: last.seq, refId: last.refId };
		// Yield between synchronous SQLite/JSON batches so HTTP/WS/Agent work can run.
		await new Promise<void>((resolve) => setTimeout(resolve, 0));
	}
}
