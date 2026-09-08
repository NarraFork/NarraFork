import type {
	PublicSharedMessage,
	PublicSharedMessagePage,
	PublicSharedToolDetail,
} from "@shared/public-narrator-share";
import { and, desc, eq, inArray, isNull, lt, type SQL, sql } from "drizzle-orm";
import { db } from "../db";
import {
	narratorMessages as messages,
	narratorMessageRefs as refs,
	narratorToolCalls as tools,
} from "../db/schema";
import { AppError } from "../lib/errors";
import { logger } from "../lib/logger";
import { publicSharePageSchema } from "../lib/validators/public-narrator-shares";
import { PUBLIC_SHARE_LIMITS as L } from "./public-narrator-share-limits";
import {
	assertPublicLineageVersions as assertVersions,
	publicReadLineage as lineage,
	publicLineageVersion,
	type PublicReadScope as Scope,
	publicTranscriptChanged as versionChanged,
} from "./public-narrator-share-lineage";
import {
	isPublicToolName,
	projectPublicMessage,
	projectPublicToolDetail,
	publicToolSummary,
} from "./public-narrator-share-projection";
import {
	revalidatePublicShare,
	unavailablePublicShare,
	type VerifiedPublicShare,
} from "./public-narrator-share-service";

/** Hidden or copy-on-written local refs ALSO shadow inherited refs at that seq/id. */
function scopePredicate(scopes: Scope[], index: number, beforeSeq?: number): SQL | undefined {
	const scope = scopes[index];
	return and(
		eq(refs.narratorId, scope.narratorId),
		lt(refs.seq, Math.min(scope.upper, beforeSeq ?? Number.MAX_SAFE_INTEGER)),
		...scopes
			.slice(0, index)
			.flatMap((nearer) => [
				sql`NOT EXISTS (SELECT 1 FROM narrator_message_refs shadow WHERE shadow.narrator_id = ${nearer.narratorId} AND shadow.seq < ${nearer.upper} AND shadow.seq = ${refs.seq})`,
				sql`NOT EXISTS (SELECT 1 FROM narrator_message_refs shadow WHERE shadow.narrator_id = ${nearer.narratorId} AND shadow.seq < ${nearer.upper} AND shadow.message_id = ${refs.messageId})`,
			]),
	);
}

function contentGuard(column: SQL): SQL<string | null> {
	// octet_length reads the SQLite record's size without pulling the entire body;
	// oversized structures never enter JS or json_each/json_extract.
	return sql<
		string | null
	>`CASE WHEN octet_length(${column}) <= ${L.messageJsonBytes} THEN ${column} ELSE NULL END`;
}

function publicMessageMetadata(row: {
	role: string;
	origin: string | null;
	parentToolUseId: string | null;
}): boolean {
	return (
		row.parentToolUseId === null &&
		(row.role === "assistant" ||
			(row.role === "user" && (row.origin === null || row.origin === "user")))
	);
}

export function listPublicSharedMessages(
	auth: VerifiedPublicShare,
	input: unknown,
): PublicSharedMessagePage {
	const started = performance.now();
	const current = revalidatePublicShare(auth);
	const parsed = publicSharePageSchema.safeParse(input);
	if (!parsed.success)
		throw new AppError("Invalid page parameters", 400, "PUBLIC_SHARE_INVALID_INPUT");
	const { limit, beforeSeq, messageVersion } = parsed.data;
	const scopes = lineage(current.narratorId);
	const version = publicLineageVersion(scopes);
	if (messageVersion !== undefined && messageVersion !== version) throw versionChanged();
	// Read finite ref windows BEFORE content/visibility filters; a page can be empty
	// but still advance its cursor through a large run of hidden system messages.
	const window = Math.min(L.refsPerRead, limit * 2);
	const candidates = scopes
		.flatMap((_, index) =>
			db
				.select({
					messageId: refs.messageId,
					seq: refs.seq,
					isCompact: refs.isCompact,
					segmentCompactId: refs.segmentCompactId,
				})
				.from(refs)
				.where(scopePredicate(scopes, index, beforeSeq))
				.orderBy(desc(refs.seq))
				.limit(window + 1)
				.all(),
		)
		.sort((a, b) => b.seq - a.seq);
	const scanned = candidates.slice(0, window);
	const metadata = scanned.length
		? db
				.select({
					id: messages.id,
					role: messages.role,
					origin: messages.origin,
					parentToolUseId: messages.parentToolUseId,
					createdAt: messages.createdAt,
				})
				.from(messages)
				.where(
					inArray(
						messages.id,
						scanned.map((row) => row.messageId),
					),
				)
				.limit(window)
				.all()
		: [];
	const metadataById = new Map(metadata.map((row) => [row.id, row]));
	const visible = scanned
		.filter((ref) => {
			const row = metadataById.get(ref.messageId);
			return (
				ref.isCompact === 0 && ref.segmentCompactId === null && row && publicMessageMetadata(row)
			);
		})
		.slice(0, limit);
	const contentRows = visible.length
		? db
				.select({ id: messages.id, json: contentGuard(sql`${messages.contentJson}`) })
				.from(messages)
				.where(
					inArray(
						messages.id,
						visible.map((row) => row.messageId),
					),
				)
				.limit(limit)
				.all()
		: [];
	const contentById = new Map(contentRows.map((row) => [row.id, row.json]));
	const result: PublicSharedMessage[] = [];
	let bytes = 256;
	let cursor: number | null = null;
	let inspected = 0;
	let hasMore = candidates.length > scanned.length;
	for (const ref of scanned) {
		const row = metadataById.get(ref.messageId);
		if (
			!row ||
			ref.isCompact !== 0 ||
			ref.segmentCompactId !== null ||
			!publicMessageMetadata(row)
		) {
			cursor = ref.seq;
			inspected++;
			continue;
		}
		if (result.length >= limit) {
			hasMore = true;
			break;
		}
		const toolRows = db
			.select({ toolUseId: tools.toolUseId, toolName: tools.toolName, status: tools.status })
			.from(tools)
			.where(eq(tools.messageId, row.id))
			.orderBy(tools.createdAt, tools.id)
			.limit(L.toolsPerMessage + 1)
			.all();
		const item = projectPublicMessage(
			{
				id: row.id,
				seq: ref.seq,
				role: row.role as "user" | "assistant",
				createdAt: row.createdAt,
				json: contentById.get(row.id) ?? null,
			},
			toolRows
				.slice(0, L.toolsPerMessage)
				.filter((tool) => isPublicToolName(tool.toolName))
				.map(publicToolSummary),
			toolRows.length > L.toolsPerMessage,
		);
		const itemBytes = Buffer.byteLength(JSON.stringify(item));
		if (bytes + itemBytes > L.responseBytes) {
			hasMore = true;
			break;
		}
		bytes += itemBytes;
		result.push(item);
		cursor = ref.seq;
		inspected++;
	}
	hasMore ||= inspected < scanned.length;
	assertVersions(scopes);
	revalidatePublicShare(current);
	const elapsed = performance.now() - started;
	if (elapsed > L.slowReadMs)
		logger.warn("Slow public transcript read", {
			durationMs: Math.round(elapsed),
			rows: scanned.length,
		});
	return {
		messages: result.reverse(),
		hasMore,
		nextBeforeSeq: hasMore ? cursor : null,
		messageVersion: version,
	};
}

export function getPublicSharedTool(
	auth: VerifiedPublicShare,
	toolUseId: string,
): PublicSharedToolDetail {
	const current = revalidatePublicShare(auth);
	if (!/^[A-Za-z0-9_:.-]{1,128}$/.test(toolUseId)) throw unavailablePublicShare();
	const scopes = lineage(current.narratorId);
	for (let index = 0; index < scopes.length; index++) {
		// The tool lookup is joined to the EXACT visible ref window, not narrator_id
		// on the shared message row (forks intentionally share rows).
		const membership = db
			.select({
				id: tools.id,
				toolUseId: tools.toolUseId,
				toolName: tools.toolName,
				status: tools.status,
				role: messages.role,
				origin: messages.origin,
				parentToolUseId: messages.parentToolUseId,
			})
			.from(tools)
			.innerJoin(refs, eq(refs.messageId, tools.messageId))
			.innerJoin(messages, eq(messages.id, tools.messageId))
			.where(
				and(
					eq(tools.toolUseId, toolUseId),
					scopePredicate(scopes, index),
					eq(refs.isCompact, 0),
					isNull(refs.segmentCompactId),
				),
			)
			.limit(1)
			.get();
		if (!membership || !publicMessageMetadata(membership) || !isPublicToolName(membership.toolName))
			continue;
		const payload = db
			.select({
				input: sql<
					string | null
				>`CASE WHEN octet_length(${tools.inputJson}) <= ${L.toolJsonBytes} THEN ${tools.inputJson} ELSE NULL END`,
				output: sql<
					string | null
				>`CASE WHEN octet_length(${tools.outputJson}) <= ${L.toolJsonBytes} THEN ${tools.outputJson} ELSE NULL END`,
				inputOmitted: sql<number>`coalesce(octet_length(${tools.inputJson}), 0) > ${L.toolJsonBytes}`,
				outputOmitted: sql<number>`coalesce(octet_length(${tools.outputJson}), 0) > ${L.toolJsonBytes}`,
			})
			.from(tools)
			.where(eq(tools.id, membership.id))
			.limit(1)
			.get();
		if (!payload) throw unavailablePublicShare();
		assertVersions(scopes);
		revalidatePublicShare(current);
		return projectPublicToolDetail({
			...membership,
			...payload,
			inputOmitted: Boolean(payload.inputOmitted),
			outputOmitted: Boolean(payload.outputOmitted),
		});
	}
	throw unavailablePublicShare();
}
