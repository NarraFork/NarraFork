/**
 * nested-rows.ts — rows nested under another row.
 *
 * The server nests one kind of message under another: a legacy inline tool's reply
 * goes under the row holding the tool call (`buildMessageTree`; subagent sessions are
 * never nested, their parent row carries only an activity summary). Rows reach the
 * document flat, in order: each row, then the rows nested under it. A nested row names
 * its parent (`parentMessageId`).
 *
 * The conversation is the rows that are not nested. A nested row is read only through
 * its parent's tool call (`nestedRowsByParent`), and leaves the document with its parent.
 */

/** The fields this module reads. */
export interface NestableRow {
	id?: unknown;
	parentMessageId?: unknown;
}

/** Whether `row` is nested under another row. */
export function isNestedRow(row: { parentMessageId?: unknown }): boolean {
	return typeof row.parentMessageId === "string" && row.parentMessageId.length > 0;
}

/**
 * Whether a realtime row belongs to a SUBAGENT's own document, seen from the page
 * that received it.
 *
 * The server dual-broadcasts a subagent's row to both pages
 * (`server/websocket/narrator-dual-broadcast`): the subagent keeps it as one of its
 * own top-level rows, while the parent receives the SAME row tagged with
 * `parentToolUseId` so its card can attach it. The tag is the only thing marking it
 * as foreign: a subagent's rows are never nested under the parent's row
 * (`isNestedRow` stays false for them) and their `seq` belongs to the subagent's own
 * numbering, so nothing on the parent page can place them in its document.
 *
 * A page must therefore read the tag as "not a message of this conversation": the
 * parent still learns about its subagents from the live channels (tool
 * started/chunk/completed, activity summaries) and from its own card's
 * `parentToolUseId`, never by treating a subagent row as one of its own. A
 * subagent's own page receives the same row with the pointer stripped, so it keeps
 * working unchanged.
 */
export function isForeignSubagentRow(
	message: { parentToolUseId?: unknown } | undefined,
	isSubagent: boolean,
): boolean {
	if (isSubagent) return false;
	const parentToolUseId = message?.parentToolUseId;
	return typeof parentToolUseId === "string" && parentToolUseId.length > 0;
}

/** The rows directly under each row, in document order. */
export function nestedRowsByParent<T extends NestableRow>(rows: readonly T[]): Map<string, T[]> {
	const byParent = new Map<string, T[]>();
	for (const row of rows) {
		if (!isNestedRow(row)) continue;
		const parentId = row.parentMessageId as string;
		const nested = byParent.get(parentId);
		if (nested) nested.push(row);
		else byParent.set(parentId, [row]);
	}
	return byParent;
}

/** `ids` and the ids of every row nested under one of them, at any depth. */
export function withNestedRowIds(
	rows: readonly NestableRow[],
	ids: ReadonlySet<string>,
): Set<string> {
	const all = new Set(ids);
	// A nested row follows its parent, so one forward pass reaches every depth.
	for (const row of rows) {
		if (isNestedRow(row) && all.has(row.parentMessageId as string) && typeof row.id === "string")
			all.add(row.id);
	}
	return all;
}

/** The index just past `rows[index]` and the rows nested under it. */
export function endOfNestedRows(rows: readonly NestableRow[], index: number): number {
	const ids = new Set<string>();
	const id = rows[index]?.id;
	if (typeof id === "string") ids.add(id);
	let end = index + 1;
	while (end < rows.length) {
		const row = rows[end];
		if (!isNestedRow(row) || !ids.has(row.parentMessageId as string)) break;
		if (typeof row.id === "string") ids.add(row.id);
		end++;
	}
	return end;
}
