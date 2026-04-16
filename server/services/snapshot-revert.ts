/**
 * Snapshot revert helpers — automatically revert file changes when messages are deleted.
 *
 * New implementation: uses narrator_file_snapshots + narrator_tool_calls to rebuild
 * file state by replaying the surviving operation chain, instead of the old shadow
 * git repo approach.
 *
 * These are "non-fatal" by design: if revert fails, we log a warning and continue
 * with the message deletion. Message history consistency always takes priority.
 */

import { mkdirSync, unlinkSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { and, eq, inArray } from "drizzle-orm";
import { db } from "../db";
import { chapters, narrators, narratorToolCalls } from "../db/schema";
import { logger } from "../lib/logger";
import { getAffectedFiles, rebuildFileStatesExcluding } from "./file-state-rebuild";

export interface RevertResult {
	reverted: boolean;
	fileCount: number;
	files: string[];
}

const EMPTY_RESULT: RevertResult = { reverted: false, fileCount: 0, files: [] };

/**
 * Resolve the working directory for a narrator (needed to write files back).
 */
export async function resolveNarratorCwd(narratorId: string): Promise<string | null> {
	const narrator = await db.query.narrators.findFirst({
		where: eq(narrators.id, narratorId),
		columns: { chapterId: true, cwd: true },
	});
	if (!narrator) return null;

	if (narrator.chapterId) {
		const chapter = await db.query.chapters.findFirst({
			where: eq(chapters.id, narrator.chapterId),
			columns: { worktreePath: true },
		});
		return chapter?.worktreePath ?? null;
	}

	return narrator.cwd ?? null;
}

/**
 * Write rebuilt file states to disk.
 */
async function writeFilesToDisk(
	cwd: string,
	fileStates: Map<string, string | null>,
): Promise<string[]> {
	const writtenFiles: string[] = [];

	for (const [filePath, content] of fileStates) {
		const absPath = resolve(cwd, filePath);
		try {
			if (content === null) {
				// File didn't exist before narrator touched it — delete it
				const file = Bun.file(absPath);
				if (await file.exists()) {
					unlinkSync(absPath);
				}
			} else {
				// Restore file content
				mkdirSync(dirname(absPath), { recursive: true });
				await Bun.write(absPath, content);
			}
			writtenFiles.push(filePath);
		} catch (err) {
			logger.warn("Failed to write reverted file", {
				filePath,
				error: String(err),
			});
		}
	}

	return writtenFiles;
}

/**
 * Revert file changes associated with the given message IDs.
 *
 * Finds all Write/Edit tool calls in those messages, determines which files
 * are affected, then rebuilds each file's state by replaying the surviving
 * (non-deleted) operation chain from the file snapshot.
 *
 * Non-fatal: returns EMPTY_RESULT on any failure instead of throwing.
 */
export async function revertPatchesForMessages(
	narratorId: string,
	messageIds: string[],
): Promise<RevertResult> {
	if (messageIds.length === 0) return EMPTY_RESULT;

	try {
		const cwd = await resolveNarratorCwd(narratorId);
		if (!cwd) return EMPTY_RESULT;

		// Find all tool calls in the deleted messages
		const deletedToolCalls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.messageId, messageIds),
				eq(narratorToolCalls.status, "success"),
			),
			columns: { toolUseId: true, toolName: true, inputJson: true },
		});

		const affectedFiles = getAffectedFiles(deletedToolCalls);
		if (affectedFiles.length === 0) return EMPTY_RESULT;

		const excludeIds = new Set(deletedToolCalls.map((tc) => tc.toolUseId));

		// Rebuild file states excluding the deleted tool calls
		const fileStates = await rebuildFileStatesExcluding(narratorId, affectedFiles, excludeIds);

		// Write to disk
		const writtenFiles = await writeFilesToDisk(cwd, fileStates);

		logger.info("Auto-reverted file changes for deleted messages", {
			narratorId,
			messageCount: messageIds.length,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		});

		return {
			reverted: writtenFiles.length > 0,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		};
	} catch (err) {
		logger.warn("Snapshot auto-revert failed, continuing with message deletion", {
			narratorId,
			messageIds,
			error: String(err),
		});
		return EMPTY_RESULT;
	}
}

/**
 * Revert file changes for a single tool_use block (by toolUseId).
 * Used by deleteMessageBlock when removing a tool_use block.
 *
 * Also finds and handles subsequent tool calls on the same file(s),
 * since removing an earlier operation invalidates later ones.
 */
export async function revertPatchForToolUse(
	narratorId: string,
	toolUseId: string,
): Promise<RevertResult> {
	try {
		const cwd = await resolveNarratorCwd(narratorId);
		if (!cwd) return EMPTY_RESULT;

		// Find the tool call being deleted (only successful ones affect files)
		const toolCall = await db.query.narratorToolCalls.findFirst({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				eq(narratorToolCalls.toolUseId, toolUseId),
				eq(narratorToolCalls.status, "success"),
			),
			columns: { toolName: true, inputJson: true },
		});

		if (!toolCall) return EMPTY_RESULT;

		const affectedFiles = getAffectedFiles([toolCall]);
		if (affectedFiles.length === 0) return EMPTY_RESULT;

		// Rebuild file states excluding this tool call
		const fileStates = await rebuildFileStatesExcluding(
			narratorId,
			affectedFiles,
			new Set([toolUseId]),
		);

		// Write to disk
		const writtenFiles = await writeFilesToDisk(cwd, fileStates);

		logger.info("Auto-reverted file changes for deleted block", {
			narratorId,
			toolUseId,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		});

		return {
			reverted: writtenFiles.length > 0,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		};
	} catch (err) {
		logger.warn("Snapshot auto-revert (block) failed, continuing", {
			narratorId,
			toolUseId,
			error: String(err),
		});
		return EMPTY_RESULT;
	}
}

/**
 * Batch revert file changes for multiple tool_use blocks at once.
 * Used by deleteMessageBlocks to avoid redundant queries and disk writes.
 *
 * Resolves cwd once, queries affected tool calls once, rebuilds file states
 * once (excluding all given toolUseIds), and writes to disk once.
 */
export async function revertPatchForToolUses(
	narratorId: string,
	toolUseIds: string[],
): Promise<RevertResult> {
	if (toolUseIds.length === 0) return EMPTY_RESULT;

	try {
		const cwd = await resolveNarratorCwd(narratorId);
		if (!cwd) return EMPTY_RESULT;

		// Find all tool calls being deleted (only successful ones affect files)
		const toolCalls = await db.query.narratorToolCalls.findMany({
			where: and(
				eq(narratorToolCalls.narratorId, narratorId),
				inArray(narratorToolCalls.toolUseId, toolUseIds),
				eq(narratorToolCalls.status, "success"),
			),
			columns: { toolUseId: true, toolName: true, inputJson: true },
		});

		if (toolCalls.length === 0) return EMPTY_RESULT;

		const affectedFiles = getAffectedFiles(toolCalls);
		if (affectedFiles.length === 0) return EMPTY_RESULT;

		// Rebuild file states excluding ALL deleted tool calls at once
		const excludeIds = new Set(toolCalls.map((tc) => tc.toolUseId));
		const fileStates = await rebuildFileStatesExcluding(narratorId, affectedFiles, excludeIds);

		// Write to disk once
		const writtenFiles = await writeFilesToDisk(cwd, fileStates);

		logger.info("Auto-reverted file changes for deleted blocks (batch)", {
			narratorId,
			toolUseIdCount: toolUseIds.length,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		});

		return {
			reverted: writtenFiles.length > 0,
			fileCount: writtenFiles.length,
			files: writtenFiles,
		};
	} catch (err) {
		logger.warn("Snapshot auto-revert (batch) failed, continuing", {
			narratorId,
			toolUseIds,
			error: String(err),
		});
		return EMPTY_RESULT;
	}
}

// === Legacy compatibility ===

/**
 * @deprecated Legacy alias — resolveSnapshotContext is no longer needed for the
 * new file-snapshot-based approach. Kept for backward compatibility with routes
 * that still reference it. Returns a minimal context with just the cwd.
 */
export async function resolveSnapshotContext(
	narratorId: string,
): Promise<{ scopeId: string; worktreePath: string } | null> {
	const cwd = await resolveNarratorCwd(narratorId);
	if (!cwd) return null;
	return { scopeId: narratorId, worktreePath: cwd };
}
