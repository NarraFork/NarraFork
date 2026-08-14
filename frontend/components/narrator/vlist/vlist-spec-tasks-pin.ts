/**
 * vlist-spec-tasks-pin.ts — Pure "latest spec://tasks.json call" identification
 * for the exact virtual list.
 *
 * At every low render LOD the MOST RECENT tasks.json tool call keeps its full
 * expanded task-board card instead of folding into a trace row / count line /
 * header — the task board is the narrator's live working state, which is exactly
 * what a reader dropping to a low LOD still wants on screen.
 *
 * These helpers are the vlist-local mirror of `tool-display.ts`'s
 * `isSpecTasksToolUse` and `narrator-message-helpers.ts`'s
 * `findLatestSpecTasksToolUseId`. Kept local (the CONTRACT's isolation rule: the
 * shared adapter must not import app modules) and locked to the same behaviour by
 * the unit tests beside this file.
 */

const SPEC_TASKS_URI = "spec://tasks.json";
const SPEC_TASKS_TOOLS = new Set(["Read", "Write", "Edit"]);

/** Structural minimum of a tool-call record these helpers read. */
export interface SpecTasksToolCallLike {
	toolUseId?: string;
	toolName?: string;
	inputJson?: unknown;
}

/** Structural minimum of a message (contentJson tool_use blocks + toolCalls). */
export interface SpecTasksMessageLike {
	contentJson?: ReadonlyArray<{
		type?: unknown;
		id?: unknown;
		name?: unknown;
		input?: unknown;
	}> | null;
	toolCalls?: readonly SpecTasksToolCallLike[] | null;
}

/** The path a streaming tool call has extracted so far, if any. */
function streamingFilePathOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const raw = (input as Record<string, unknown>)._streamingFilePath;
	return typeof raw === "string" ? raw : "";
}

/** The `file_path` field of a file tool input, tolerating truncation wrappers. */
function filePathOf(input: unknown): string {
	if (!input || typeof input !== "object") return "";
	const raw = (input as Record<string, unknown>).file_path;
	return typeof raw === "string" ? raw : "";
}

/**
 * Whether a file tool operates on the Dynamic Spec task queue
 * (spec://tasks.json). Mirrors `isSpecTasksToolUse`: the streaming path field is
 * read too, so a still-typing call resolves to the same answer it will once
 * persisted.
 */
export function isSpecTasksToolCall(toolName: unknown, inputJson: unknown): boolean {
	if (typeof toolName !== "string" || !SPEC_TASKS_TOOLS.has(toolName)) return false;
	return (
		filePathOf(inputJson) === SPEC_TASKS_URI || streamingFilePathOf(inputJson) === SPEC_TASKS_URI
	);
}

/**
 * The tool-use id of the LAST spec://tasks.json operation across an ordered
 * message list. Mirrors `findLatestSpecTasksToolUseId`: both the assistant
 * `contentJson` tool_use blocks and the `toolCalls` records are scanned in
 * message order, and the id seen last wins. Returns null when there is none.
 */
export function findLatestSpecTasksToolUseIdInMessages(
	messages: readonly SpecTasksMessageLike[],
): string | null {
	let latest: string | null = null;
	for (const msg of messages) {
		for (const block of msg.contentJson ?? []) {
			if (block?.type !== "tool_use") continue;
			const id = typeof block.id === "string" ? block.id : null;
			if (id && isSpecTasksToolCall(block.name, block.input)) latest = id;
		}
		for (const tc of msg.toolCalls ?? []) {
			if (tc.toolUseId && isSpecTasksToolCall(tc.toolName, tc.inputJson)) {
				latest = tc.toolUseId;
			}
		}
	}
	return latest;
}
