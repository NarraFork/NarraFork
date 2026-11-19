import { eq, getTableColumns, inArray } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { narratorMessages, narratorToolCalls } from "../db/schema";
import { readDomainTask, readQuery } from "../db/worker-read";
import { DbReadError } from "../lib/db-worker/errors";
import type { NarratorBodyTextsParams, NarratorRawRow } from "./narrator-message-snapshot-reader";

type MessageRow = typeof narratorMessages.$inferSelect;
type ToolRow = typeof narratorToolCalls.$inferSelect;
export type NarratorMessageSnapshot = MessageRow & {
	toolCalls: ToolRow[];
	creator: {
		id: string;
		username: string;
		avatarColor: string | null;
		avatarImageId: string | null;
	} | null;
	narrator: { title: string | null } | null;
};
function decode<T>(raw: NarratorRawRow, columns: ReturnType<typeof getTableColumns>): T {
	return Object.fromEntries(
		Object.entries(columns).map(([key, column]) => {
			const value = raw[column.name];
			return [key, value == null ? null : column.mapFromDriverValue(value)];
		}),
	) as T;
}
const optionsFor = (deadlineAt: number, signal?: AbortSignal) => {
	signal?.throwIfAborted();
	const timeoutMs = deadlineAt - Date.now();
	if (timeoutMs <= 0)
		throw new DbReadError("DB_READ_TASK_TIMEOUT", "Narrator read deadline expired");
	return { executionPolicy: "worker-required" as const, timeoutMs, signal };
};

/** Preserve the 128MiB model-history allowance; page size is not a history truncation. */
export async function readNarratorMessageRows(
	messageIds: readonly string[],
	options: { includeTools?: boolean; includeCreator?: boolean; signal?: AbortSignal } = {},
): Promise<NarratorMessageSnapshot[]> {
	const ids = [...new Set(messageIds)];
	const deadlineAt = Date.now() + 30_000;
	const result: NarratorMessageSnapshot[] = [];
	for (let offset = 0; offset < ids.length; offset += 128) {
		const pageIds = ids.slice(offset, offset + 128);
		if (activeDatabaseBackend === "postgres") {
			const rows = await readQuery(
				db.query.narratorMessages.findMany({
					where: inArray(narratorMessages.id, pageIds),
					with: {
						toolCalls: options.includeTools === false ? undefined : true,
						creator: options.includeCreator === false ? undefined : true,
						narrator: { columns: { title: true } },
					},
				}),
				optionsFor(deadlineAt, options.signal),
			);
			const byId = new Map(rows.map((row) => [row.id, row]));
			for (const id of pageIds) {
				const row = byId.get(id);
				if (row)
					result.push({ ...row, toolCalls: row.toolCalls ?? [], creator: row.creator ?? null });
			}
			continue;
		}
		const snapshot = await readPayloadPage(
			pageIds,
			(messageIds) =>
				readDomainTask(
					sqlite,
					"narratorMessageRows",
					{
						messageIds,
						includeTools: options.includeTools ?? true,
						includeCreator: options.includeCreator ?? true,
					},
					optionsFor(deadlineAt, options.signal),
				),
			(left, right) => ({
				messages: [...left.messages, ...right.messages],
				tools: [...left.tools, ...right.tools],
				creators: [...left.creators, ...right.creators],
				authors: [...left.authors, ...right.authors],
			}),
		);
		const tools = new Map<string, ToolRow[]>();
		for (const raw of snapshot.tools) {
			const tool = decode<ToolRow>(raw, getTableColumns(narratorToolCalls));
			const list = tools.get(tool.messageId) ?? [];
			list.push(tool);
			tools.set(tool.messageId, list);
		}
		const creators = new Map(snapshot.creators.map((row) => [row.id, row]));
		const authors = new Map(snapshot.authors.map((row) => [row.id, { title: row.title }]));
		const rows = new Map(
			snapshot.messages.map((raw) => {
				const message = decode<MessageRow>(raw, getTableColumns(narratorMessages));
				return [
					message.id,
					{
						...message,
						toolCalls: tools.get(message.id) ?? [],
						creator: message.createdBy ? (creators.get(message.createdBy) ?? null) : null,
						narrator: authors.get(message.narratorId) ?? null,
					},
				];
			}),
		);
		for (const id of pageIds) {
			const row = rows.get(id);
			if (row) result.push(row);
		}
	}
	options.signal?.throwIfAborted();
	return result;
}
export async function readNarratorMessageRow(
	messageId: string,
	options?: Parameters<typeof readNarratorMessageRows>[1],
): Promise<NarratorMessageSnapshot | undefined> {
	return (await readNarratorMessageRows([messageId], options))[0];
}
export async function readNarratorToolRows(
	toolCallIds: readonly string[],
	signal?: AbortSignal,
): Promise<ToolRow[]> {
	const ids = [...new Set(toolCallIds)];
	const deadlineAt = Date.now() + 30_000;
	const result: ToolRow[] = [];
	for (let offset = 0; offset < ids.length; offset += 128) {
		const pageIds = ids.slice(offset, offset + 128);
		if (activeDatabaseBackend === "postgres") {
			const rows = await readQuery(
				db.query.narratorToolCalls.findMany({
					where: inArray(narratorToolCalls.id, pageIds),
				}),
				optionsFor(deadlineAt, signal),
			);
			const byId = new Map(rows.map((row) => [row.id, row]));
			for (const id of pageIds) {
				const row = byId.get(id);
				if (row) result.push(row);
			}
			continue;
		}
		const rows = await readPayloadPage(
			pageIds,
			(toolCallIds) =>
				readDomainTask(sqlite, "narratorToolRows", { toolCallIds }, optionsFor(deadlineAt, signal)),
			(left, right) => [...left, ...right],
		);
		const mapped = new Map(
			rows.map((raw) => {
				const row = decode<ToolRow>(raw, getTableColumns(narratorToolCalls));
				return [row.id, row];
			}),
		);
		for (const id of pageIds) {
			const row = mapped.get(id);
			if (row) result.push(row);
		}
	}
	signal?.throwIfAborted();
	return result;
}
export async function readNarratorBodyTexts(
	entries: NarratorBodyTextsParams["entries"],
	signal?: AbortSignal,
): Promise<Map<string, string | null>> {
	const result = new Map<string, string | null>();
	const deadlineAt = Date.now() + 30_000;
	for (const entry of entries) {
		signal?.throwIfAborted();
		if (activeDatabaseBackend === "postgres") {
			const row = await readQuery(
				db.query.narratorMessages.findFirst({
					where: eq(narratorMessages.id, entry.id),
					columns: { contentJson: true },
				}),
				optionsFor(deadlineAt, signal),
			);
			const body = row ? JSON.stringify(row.contentJson) : null;
			const bytes = body === null ? -1 : Buffer.byteLength(body);
			result.set(
				entry.id,
				body !== null &&
					bytes <= entry.maxBytes &&
					(entry.exactBytes === undefined || bytes === entry.exactBytes)
					? body
					: null,
			);
		} else {
			const rows = await readDomainTask(
				sqlite,
				"narratorBodyTexts",
				{ entries: [entry] },
				optionsFor(deadlineAt, signal),
			);
			for (const row of rows) result.set(row.id, row.body);
		}
	}
	signal?.throwIfAborted();
	return result;
}

async function readPayloadPage<T>(
	ids: string[],
	dispatch: (ids: string[]) => Promise<T>,
	combine: (left: T, right: T) => T,
): Promise<T> {
	try {
		return await dispatch(ids);
	} catch (error) {
		if (
			!(error && typeof error === "object" && "code" in error && error.code === "DB_READ_BUDGET") ||
			ids.length <= 1
		)
			throw error;
		const split = Math.floor(ids.length / 2);
		const left = await readPayloadPage(ids.slice(0, split), dispatch, combine);
		const right = await readPayloadPage(ids.slice(split), dispatch, combine);
		return combine(left, right);
	}
}
