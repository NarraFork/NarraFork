/**
 * File state rebuild service — reconstructs file contents by replaying
 * Write/Edit tool call chains from narrator_file_snapshots + narrator_tool_calls.
 *
 * Core primitive for:
 * - Message/block deletion (revert files to pre-deletion state)
 * - Fork (restore file state at a specific message)
 * - Diff generation (compute before/after content for a tool call)
 */
import { and, asc, eq, inArray, lte, sql } from "drizzle-orm";
import { db } from "../db";
import { narratorFileSnapshots, narratorMessageRefs, narratorToolCalls } from "../db/schema";
import { replace } from "../lib/agent/tools/edit";

// Tool call with ordering info
interface OrderedToolCall {
	toolUseId: string;
	toolName: string;
	inputJson: unknown;
	status: string;
	messageId: string;
	seq: number;
	createdAt: string;
}

/**
 * Query all Write/Edit tool calls for a narrator, ordered by message seq then createdAt.
 * Optionally limited to tool calls whose message seq <= maxSeq.
 */
async function queryOrderedToolCalls(
	narratorId: string,
	maxSeq?: number,
): Promise<OrderedToolCall[]> {
	const conditions = [
		eq(narratorToolCalls.narratorId, narratorId),
		eq(narratorToolCalls.status, "success"),
		sql`${narratorToolCalls.toolName} IN ('Write', 'Edit')`,
	];
	if (maxSeq !== undefined) {
		conditions.push(lte(narratorMessageRefs.seq, maxSeq));
	}

	return db
		.select({
			toolUseId: narratorToolCalls.toolUseId,
			toolName: narratorToolCalls.toolName,
			inputJson: narratorToolCalls.inputJson,
			status: narratorToolCalls.status,
			messageId: narratorToolCalls.messageId,
			seq: narratorMessageRefs.seq,
			createdAt: narratorToolCalls.createdAt,
		})
		.from(narratorToolCalls)
		.innerJoin(
			narratorMessageRefs,
			and(
				eq(narratorMessageRefs.narratorId, narratorId),
				eq(narratorMessageRefs.messageId, narratorToolCalls.messageId),
			),
		)
		.where(and(...conditions))
		.orderBy(asc(narratorMessageRefs.seq), asc(narratorToolCalls.createdAt)) as Promise<
		OrderedToolCall[]
	>;
}

/**
 * Apply a single tool call operation to file content.
 * Returns the new content, or null if the operation doesn't affect this file.
 */
function applyToolCall(currentContent: string | null, toolCall: OrderedToolCall): string | null {
	const input = toolCall.inputJson as Record<string, unknown> | null;
	if (!input) return currentContent;

	if (toolCall.toolName === "Write") {
		return (input.content as string) ?? currentContent;
	}

	if (toolCall.toolName === "Edit") {
		const oldString = input.old_string as string | undefined;
		const newString = input.new_string as string | undefined;
		const replaceAll = input.replace_all as boolean | undefined;

		if (newString === undefined) return currentContent;

		// Create-new-file mode: old_string is empty
		if (!oldString || oldString === "") {
			return newString;
		}

		// Apply edit to current content
		if (currentContent === null) return currentContent;

		try {
			const normalizeLineEndings = (t: string) => t.replaceAll("\r\n", "\n");
			const content = normalizeLineEndings(currentContent);
			const normalizedOld = normalizeLineEndings(oldString);
			const normalizedNew = normalizeLineEndings(newString);
			const result = replace(content, normalizedOld, normalizedNew, replaceAll);
			return result.content;
		} catch {
			// Edit failed to apply (content changed externally, etc.)
			// Return current content unchanged — best effort
			return currentContent;
		}
	}

	return currentContent;
}

/**
 * Group tool calls by file path.
 */
function groupByFile(toolCalls: OrderedToolCall[]): Map<string, OrderedToolCall[]> {
	const groups = new Map<string, OrderedToolCall[]>();
	for (const tc of toolCalls) {
		const input = tc.inputJson as Record<string, unknown> | null;
		if (!input) continue;
		const filePath = input.file_path as string | undefined;
		if (!filePath) continue;

		let list = groups.get(filePath);
		if (!list) {
			list = [];
			groups.set(filePath, list);
		}
		list.push(tc);
	}
	return groups;
}

/**
 * Rebuild the state of a single file by replaying tool calls up to (and including)
 * the given maxSeq. Returns the file content after all operations, or null if the
 * file should not exist (was never created by the narrator).
 */
export async function rebuildFileState(
	narratorId: string,
	filePath: string,
	maxSeq?: number,
): Promise<string | null> {
	// Get original content from file snapshot
	const snapshot = await db.query.narratorFileSnapshots.findFirst({
		where: and(
			eq(narratorFileSnapshots.narratorId, narratorId),
			eq(narratorFileSnapshots.filePath, filePath),
		),
		columns: { originalContent: true },
	});

	let content = snapshot?.originalContent ?? null;

	// Get all tool calls for this file
	const allToolCalls = await queryOrderedToolCalls(narratorId, maxSeq);
	const fileToolCalls = allToolCalls.filter((tc) => {
		const input = tc.inputJson as Record<string, unknown> | null;
		return input?.file_path === filePath;
	});

	// Replay operations
	for (const tc of fileToolCalls) {
		content = applyToolCall(content, tc);
	}

	return content;
}

/**
 * Rebuild the state of all files touched by a narrator, up to a specific message.
 * Returns a Map of filePath → content (null means file didn't exist before narrator touched it).
 *
 * Used by fork to restore file state at the fork point.
 */
export async function rebuildFileStatesAtMessage(
	narratorId: string,
	messageId: string,
): Promise<Map<string, string | null>> {
	// Find the seq of the target message
	const ref = await db.query.narratorMessageRefs.findFirst({
		where: and(
			eq(narratorMessageRefs.narratorId, narratorId),
			eq(narratorMessageRefs.messageId, messageId),
		),
		columns: { seq: true },
	});
	if (!ref) return new Map();

	return rebuildFileStatesUpToSeq(narratorId, ref.seq);
}

/**
 * Rebuild file states up to a given seq number.
 */
export async function rebuildFileStatesUpToSeq(
	narratorId: string,
	maxSeq: number,
): Promise<Map<string, string | null>> {
	const toolCalls = await queryOrderedToolCalls(narratorId, maxSeq);
	const grouped = groupByFile(toolCalls);
	const result = new Map<string, string | null>();

	// Get all file snapshots for this narrator
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: eq(narratorFileSnapshots.narratorId, narratorId),
		columns: { filePath: true, originalContent: true },
	});
	const snapshotMap = new Map(snapshots.map((s) => [s.filePath, s.originalContent]));

	for (const [filePath, calls] of grouped) {
		let content = snapshotMap.get(filePath) ?? null;
		for (const tc of calls) {
			content = applyToolCall(content, tc);
		}
		result.set(filePath, content);
	}

	return result;
}

/**
 * Rebuild file states for specific files, considering only tool calls
 * that are NOT in the excluded set (by toolUseId).
 *
 * Used by message deletion: excludes tool calls from deleted messages,
 * then rebuilds to get the target file state.
 */
export async function rebuildFileStatesExcluding(
	narratorId: string,
	filePaths: string[],
	excludeToolUseIds: Set<string>,
): Promise<Map<string, string | null>> {
	if (filePaths.length === 0) return new Map();

	const allToolCalls = await queryOrderedToolCalls(narratorId);
	const result = new Map<string, string | null>();

	// Get file snapshots
	const snapshots = await db.query.narratorFileSnapshots.findMany({
		where: and(
			eq(narratorFileSnapshots.narratorId, narratorId),
			inArray(narratorFileSnapshots.filePath, filePaths),
		),
		columns: { filePath: true, originalContent: true },
	});
	const snapshotMap = new Map(snapshots.map((s) => [s.filePath, s.originalContent]));

	const filePathSet = new Set(filePaths);

	for (const filePath of filePathSet) {
		let content = snapshotMap.get(filePath) ?? null;

		// Replay only non-excluded tool calls for this file
		for (const tc of allToolCalls) {
			if (excludeToolUseIds.has(tc.toolUseId)) continue;
			const input = tc.inputJson as Record<string, unknown> | null;
			if (input?.file_path !== filePath) continue;
			content = applyToolCall(content, tc);
		}

		result.set(filePath, content);
	}

	return result;
}

/**
 * Get the list of file paths affected by specific tool calls.
 */
export function getAffectedFiles(
	toolCalls: Array<{ toolName: string; inputJson: unknown }>,
): string[] {
	const files = new Set<string>();
	for (const tc of toolCalls) {
		if (tc.toolName !== "Write" && tc.toolName !== "Edit") continue;
		const input = tc.inputJson as Record<string, unknown> | null;
		if (!input?.file_path) continue;
		files.add(input.file_path as string);
	}
	return [...files];
}
