import { createHash } from "node:crypto";
import { NARRATOR_PANEL_PAGE_SIZE } from "@shared/narrator-panel-state";
import {
	and,
	asc,
	desc,
	eq,
	getTableColumns,
	gt,
	inArray,
	lt,
	lte,
	or,
	type SQL,
	sql,
} from "drizzle-orm";
import { db } from "../db";
import {
	narratorBufferedMessages as mailbox,
	narratorMessages,
	narrators,
	narratorToolCalls,
	users,
} from "../db/schema";
import { readQuery } from "../db/worker-read";
import { AppError, ValidationError } from "../lib/errors";
import { logger } from "../lib/logger";
import { toolCallWithExecutionTargets } from "../lib/tool-execution-target-projection";
import { projectMailboxUserMessage, toBufferSummary } from "./narrator-buffer";
import { getNarratorDraftMetadata } from "./narrator-draft-service";
import { getQuestionReflectionDeadline } from "./narrator-permission";

const PANEL_BYTE_LIMIT = 4 * 1024 * 1024;
type Cursor = {
	kind: "permissions" | "buffer";
	narratorId: string;
	id: string;
	createdAt?: string;
	priority?: boolean;
	seq?: number;
	arrivalSeq?: number | null;
	fingerprint?: string;
};
function decodeCursor(
	value: string | undefined,
	narratorId: string,
	kind: Cursor["kind"],
): Cursor | undefined {
	if (!value) return undefined;
	try {
		if (value.length > 1024) throw new Error("long cursor");
		const cursor = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Cursor;
		if (
			cursor.kind !== kind ||
			cursor.narratorId !== narratorId ||
			typeof cursor.id !== "string" ||
			!cursor.id ||
			(kind === "permissions"
				? typeof cursor.createdAt !== "string"
				: typeof cursor.priority !== "boolean" ||
					!Number.isSafeInteger(cursor.seq) ||
					(cursor.arrivalSeq !== null && !Number.isSafeInteger(cursor.arrivalSeq)) ||
					typeof cursor.fingerprint !== "string")
		)
			throw new Error("invalid cursor");
		return cursor;
	} catch {
		throw new ValidationError("Invalid panel-state cursor");
	}
}
function encodeCursor(cursor: Cursor): string {
	return Buffer.from(JSON.stringify(cursor)).toString("base64url");
}
function boundedPrefix<T extends { id: string; bytes: number }>(rows: T[]): T[] {
	let bytes = 0;
	const selected: T[] = [];
	for (const row of rows.slice(0, NARRATOR_PANEL_PAGE_SIZE)) {
		if (bytes + row.bytes > PANEL_BYTE_LIMIT) {
			if (!selected.length)
				throw new AppError(
					`Panel item ${row.id} exceeds the display budget; open its detail.`,
					413,
					"PANEL_STATE_ITEM_TOO_LARGE",
				);
			break;
		}
		bytes += row.bytes;
		selected.push(row);
	}
	return selected;
}

const permissionBytes = sql<number>`coalesce(length(CAST(${narratorToolCalls.inputJson} AS BLOB)),0) + coalesce(length(CAST(${narratorToolCalls.permissionSuggestions} AS BLOB)),0) + coalesce(length(CAST(${narratorToolCalls.executionTargetsJson} AS BLOB)),0) + coalesce(length(CAST(${narratorToolCalls.permissionDecisionReason} AS BLOB)),0) + 4096`;
const bufferBytes = sql<number>`max(${mailbox.byteSize}, ${mailbox.projectedByteSize}, coalesce(length(CAST(${mailbox.text} AS BLOB)),0)) + coalesce(length(CAST(${mailbox.fileReferencesJson} AS BLOB)),0) + coalesce(length(CAST(${mailbox.metadataJson} AS BLOB)),0) + coalesce(length(CAST(${mailbox.imagesJson} AS BLOB)),0) + coalesce(length(CAST(${mailbox.textFilePathsJson} AS BLOB)),0) + coalesce(length(CAST(${mailbox.creatorJson} AS BLOB)),0) + coalesce(length(CAST(${mailbox.lastError} AS BLOB)),0) + 4096`;
function assertPageRows(
	selected: readonly { id: string }[],
	rows: readonly { id: string }[],
): void {
	if (selected.length !== rows.length)
		throw new AppError(
			"Panel state changed while reading; restart pagination.",
			409,
			"PANEL_STATE_CHANGED",
		);
}

const permissionColumns = {
	id: narratorToolCalls.id,
	ownerNarratorId: narratorToolCalls.narratorId,
	parentToolUseId: narratorMessages.parentToolUseId,
	toolName: narratorToolCalls.toolName,
	toolUseId: narratorToolCalls.toolUseId,
	inputJson: narratorToolCalls.inputJson,
	decisionReason: narratorToolCalls.permissionDecisionReason,
	suggestions: narratorToolCalls.permissionSuggestions,
	executionDeviceId: narratorToolCalls.executionDeviceId,
	executionCwd: narratorToolCalls.executionCwd,
	executionPathFlavor: narratorToolCalls.executionPathFlavor,
	resolvedFilePath: narratorToolCalls.resolvedFilePath,
	canonicalFilePath: narratorToolCalls.canonicalFilePath,
	runtimeGeneration: narratorToolCalls.runtimeGeneration,
	executionTargetsJson: narratorToolCalls.executionTargetsJson,
	deviceSelectionSource: narratorToolCalls.deviceSelectionSource,
};
function permissionScope(narratorId: string): SQL {
	return and(
		eq(narratorToolCalls.status, "pending"),
		// Scope the leading (narrator_id,status) index before evaluating child
		// visibility; otherwise an OR across joined tables can scan every tool row.
		sql`${narratorToolCalls.narratorId} IN (
			SELECT ${narratorId} UNION ALL SELECT panel_child.id FROM narrators panel_child
			WHERE panel_child.parent_narrator_id = ${narratorId})`,
		or(
			eq(narratorToolCalls.narratorId, narratorId),
			and(
				eq(narrators.parentNarratorId, narratorId),
				sql`EXISTS (SELECT 1 FROM narrator_tool_calls panel_parent
			INNER JOIN narrator_message_refs panel_ref ON panel_ref.message_id = panel_parent.message_id
			WHERE panel_ref.narrator_id = ${narratorId}
			AND panel_parent.tool_name IN ('Agent','Task','Send')
			AND panel_parent.tool_use_id = ${narratorMessages.parentToolUseId})`,
			),
		),
		sql`COALESCE((SELECT CASE WHEN json_type(reflection.value, '$.status') = 'text'
		THEN json_extract(reflection.value, '$.status') ELSE 'running' END
		FROM json_each(CASE WHEN json_type(${narratorToolCalls.permissionSuggestions}) = 'array'
		THEN ${narratorToolCalls.permissionSuggestions} ELSE '[]' END) reflection
		WHERE json_extract(CASE WHEN reflection.type = 'object' THEN reflection.value ELSE '{}' END, '$.type') IN ('danger_reflection','plan_reflection','task_reflection','question_reflection')
		ORDER BY CAST(reflection.key AS INTEGER) LIMIT 1), 'awaiting_user') = 'awaiting_user'`,
	) as SQL;
}
async function permissionPage(narratorId: string, rawCursor?: string) {
	if (rawCursor === "end") return { items: [], hasMore: false, cursor: undefined };
	const cursor = decodeCursor(rawCursor, narratorId, "permissions");
	const scope = permissionScope(narratorId);
	const after = cursor
		? or(
				gt(narratorToolCalls.createdAt, cursor.createdAt as string),
				and(
					eq(narratorToolCalls.createdAt, cursor.createdAt as string),
					gt(narratorToolCalls.id, cursor.id),
				),
			)
		: undefined;
	const metadata = await readQuery(
		db
			.select({
				id: narratorToolCalls.id,
				createdAt: narratorToolCalls.createdAt,
				bytes: permissionBytes,
			})
			.from(narratorToolCalls)
			.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
			.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
			.where(and(scope, after))
			.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
			.limit(NARRATOR_PANEL_PAGE_SIZE + 1),
		{ site: "narrator-panel-state.permissionPage" },
	);
	const selected = boundedPrefix(metadata);
	const rows = selected.length
		? await readQuery(
				db
					.select(permissionColumns)
					.from(narratorToolCalls)
					.innerJoin(narratorMessages, eq(narratorMessages.id, narratorToolCalls.messageId))
					.innerJoin(narrators, eq(narrators.id, narratorToolCalls.narratorId))
					.where(
						and(
							scope,
							or(
								...selected.map((row) =>
									and(eq(narratorToolCalls.id, row.id), lte(permissionBytes, row.bytes)),
								),
							),
						),
					)
					.orderBy(asc(narratorToolCalls.createdAt), asc(narratorToolCalls.id))
					.limit(selected.length),
				{ site: "narrator-panel-state.permissionPage" },
			)
		: [];
	assertPageRows(selected, rows);
	const items = rows.map((row) => {
		const reflectionDeadline = getQuestionReflectionDeadline(row.id);
		return toolCallWithExecutionTargets({
			...row,
			parentToolUseId: row.ownerNarratorId === narratorId ? null : row.parentToolUseId,
			subagentNarratorId: row.ownerNarratorId === narratorId ? null : row.ownerNarratorId,
			...(reflectionDeadline !== null ? { reflectionDeadline } : {}),
		});
	});
	const hasMore = metadata.length > selected.length;
	const last = selected.at(-1);
	return {
		items,
		hasMore,
		cursor:
			hasMore && last
				? encodeCursor({ kind: "permissions", narratorId, id: last.id, createdAt: last.createdAt })
				: undefined,
	};
}
async function bufferPage(narratorId: string, rawCursor?: string) {
	if (rawCursor === "end") return { items: [], hasMore: false, cursor: undefined };
	const cursor = decodeCursor(rawCursor, narratorId, "buffer");
	const arrival = sql<number>`coalesce(${mailbox.arrivalSeq}, -1)`;
	const after = cursor
		? or(
				lt(mailbox.priority, cursor.priority as boolean),
				and(
					eq(mailbox.priority, cursor.priority as boolean),
					or(
						gt(mailbox.seq, cursor.seq as number),
						and(
							eq(mailbox.seq, cursor.seq as number),
							or(
								gt(arrival, cursor.arrivalSeq ?? -1),
								and(eq(arrival, cursor.arrivalSeq ?? -1), gt(mailbox.id, cursor.id)),
							),
						),
					),
				),
			)
		: undefined;
	const scope = and(
		eq(mailbox.narratorId, narratorId),
		eq(mailbox.kind, "user_input"),
		inArray(mailbox.state, ["queued", "failed"]),
	);
	// Normal queues hold at most 50 rows. A bounded metadata fingerprint rejects
	// reordered/edited queues between pages rather than silently skipping items.
	const identities = await readQuery(
		db
			.select({
				id: mailbox.id,
				seq: mailbox.seq,
				arrivalSeq: mailbox.arrivalSeq,
				priority: mailbox.priority,
				state: mailbox.state,
				revision: mailbox.currentRevision,
				updatedAt: mailbox.updatedAt,
			})
			.from(mailbox)
			.where(scope)
			.orderBy(asc(mailbox.id))
			.limit(1025),
		{ site: "narrator-panel-state.bufferPage" },
	);
	if (identities.length > 1024)
		throw new AppError(
			"Panel buffer metadata exceeds its budget.",
			413,
			"PANEL_STATE_ITEM_TOO_LARGE",
		);
	const fingerprint = createHash("sha256").update(JSON.stringify(identities)).digest("hex");
	if (cursor && cursor.fingerprint !== fingerprint)
		throw new AppError("Buffer queue changed; restart pagination.", 409, "PANEL_STATE_CHANGED");
	const metadata = await readQuery(
		db
			.select({
				id: mailbox.id,
				priority: mailbox.priority,
				seq: mailbox.seq,
				arrivalSeq: mailbox.arrivalSeq,
				bytes: bufferBytes,
			})
			.from(mailbox)
			.where(and(scope, after))
			.orderBy(desc(mailbox.priority), asc(mailbox.seq), asc(arrival), asc(mailbox.id))
			.limit(NARRATOR_PANEL_PAGE_SIZE + 1),
		{ site: "narrator-panel-state.bufferPage" },
	);
	const selected = boundedPrefix(metadata);
	const rows = selected.length
		? await readQuery(
				db
					.select({
						...getTableColumns(mailbox),
						commandText: sql<null>`NULL`,
						bashCommand: sql<null>`NULL`,
					})
					.from(mailbox)
					.where(
						and(
							scope,
							or(
								...selected.map((row) => and(eq(mailbox.id, row.id), lte(bufferBytes, row.bytes))),
							),
						),
					)
					.orderBy(desc(mailbox.priority), asc(mailbox.seq), asc(arrival), asc(mailbox.id))
					.limit(selected.length),
				{ site: "narrator-panel-state.bufferPage" },
			)
		: [];
	assertPageRows(selected, rows);
	const messages = rows.map(projectMailboxUserMessage);
	const authorIds = [
		...new Set(
			messages.flatMap((message) =>
				!message.creator && message.createdBy ? [message.createdBy] : [],
			),
		),
	];
	const authors = authorIds.length
		? await readQuery(
				db
					.select({
						id: users.id,
						username: users.username,
						avatarColor: users.avatarColor,
						avatarImageId: users.avatarImageId,
					})
					.from(users)
					.where(inArray(users.id, authorIds))
					.limit(authorIds.length),
				{ site: "narrator-panel-state.bufferPage" },
			)
		: [];
	const byId = new Map(authors.map((author) => [author.id, author]));
	for (const message of messages)
		if (!message.creator && message.createdBy)
			message.creator = byId.get(message.createdBy) ?? null;
	const hasMore = metadata.length > selected.length;
	const last = selected.at(-1);
	return {
		items: toBufferSummary(messages),
		hasMore,
		cursor:
			hasMore && last
				? encodeCursor({
						kind: "buffer",
						narratorId,
						id: last.id,
						priority: last.priority,
						seq: last.seq,
						arrivalSeq: last.arrivalSeq,
						fingerprint,
					})
				: undefined,
	};
}

/** SQLite narrator surfaces are gated by their router before reaching this service. */
export async function getNarratorPanelState(
	narratorId: string,
	userId: string,
	cursors: { permissionsCursor?: string; bufferCursor?: string } = {},
) {
	const started = performance.now();
	const phases: Record<string, number> = {};
	const timed = async <T>(name: string, read: Promise<T>) => {
		try {
			return await read;
		} finally {
			phases[name] = Math.round(performance.now() - started);
		}
	};
	const [permissions, buffer, draft] = await Promise.all([
		timed("permissionsMs", permissionPage(narratorId, cursors.permissionsCursor)),
		timed("bufferMs", bufferPage(narratorId, cursors.bufferCursor)),
		timed("draftMs", getNarratorDraftMetadata(userId, narratorId)),
	]);
	const elapsedMs = Math.round(performance.now() - started);
	if (elapsedMs >= 250)
		logger.warn("Slow narrator panel-state hydration", {
			narratorId,
			elapsedMs,
			...phases,
			permissionRows: permissions.items.length,
			bufferRows: buffer.items.length,
		});
	return {
		permissions: permissions.items,
		buffer: buffer.items,
		draft,
		hasMore: { permissions: permissions.hasMore, buffer: buffer.hasMore },
		...(permissions.cursor || buffer.cursor
			? {
					nextCursor: {
						...(permissions.cursor ? { permissions: permissions.cursor } : {}),
						...(buffer.cursor ? { buffer: buffer.cursor } : {}),
					},
				}
			: {}),
	};
}
