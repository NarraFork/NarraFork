import { isMediaContentBlock } from "@shared/media-attachments";
import { and, eq, gt, inArray, or } from "drizzle-orm";
import { db, postgresRuntime } from "../db";
import * as pg from "../db/postgres-schema";
import { narratorMessageRefs, narratorMessages, narratorToolCalls } from "../db/schema";
import { contentJsonSql, fillBodies } from "./narrator-body-reads";

const PAGE_SIZE = 16;
const MAX_TOOLS_PER_PAGE = 64;

function referencesMedia(
	json: unknown,
	owner: string,
	mediaId: string,
	fallbackOwner: string,
	toolOutput = false,
): boolean {
	if (!json) return false;
	try {
		const value: unknown = typeof json === "string" ? JSON.parse(json) : json;
		const blocks = toolOutput
			? value && typeof value === "object" && "_media" in value
				? value._media
				: null
			: value;
		return (
			Array.isArray(blocks) &&
			blocks.some(
				(block) =>
					isMediaContentBlock(block) &&
					block.mediaId === mediaId &&
					(block.uploadNarratorId || fallbackOwner) === owner,
			)
		);
	} catch {
		return false;
	}
}

/**
 * Prove an exact owner/id reference in ONE already-authorized narrator's refs.
 * COW copies need not retain the original message owner; tool calls are joined
 * by messageId, not narratorId, because forks can share another owner's message.
 * Never searches arbitrary narrators or treats knowledge of a media id as access.
 *
 * No media-reference index exists yet. Keyset pages and cancellation allow the
 * lookup to yield between batches. A single large JSON value is still read and
 * parsed synchronously; eliminating that cost requires a streaming reader or index.
 */
export async function narratorReferencesMedia(
	referencingNarratorId: string,
	uploadNarratorId: string,
	mediaId: string,
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
				referencesMedia(row.contentJson, uploadNarratorId, mediaId, row.owner) &&
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
					referencesMedia(call.output, uploadNarratorId, mediaId, call.owner, true) &&
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
