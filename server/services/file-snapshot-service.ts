/**
 * File snapshot service — records the original content of files before
 * a narrator modifies them for the first time.
 *
 * Used by Write/Edit tools (precise tracking) and Bash tool (best-effort
 * via git status diff).
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorFileSnapshots } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

/**
 * Ensure a file snapshot exists for the given narrator + file path.
 * If one already exists, this is a no-op.
 *
 * @param narratorId - The narrator performing the operation
 * @param filePath - Relative path (as stored in tool input)
 * @param readContent - Async function that returns the current file content,
 *                      or null if the file doesn't exist
 */
export async function ensureFileSnapshot(
	narratorId: string,
	filePath: string,
	readContent: () => Promise<string | null>,
): Promise<void> {
	try {
		// Check if snapshot already exists (fast path)
		const existing = await db.query.narratorFileSnapshots.findFirst({
			where: and(
				eq(narratorFileSnapshots.narratorId, narratorId),
				eq(narratorFileSnapshots.filePath, filePath),
			),
			columns: { id: true },
		});
		if (existing) return;

		// Read current content before the tool modifies it
		const content = await readContent();

		// Insert with conflict ignore (race condition safety)
		await db
			.insert(narratorFileSnapshots)
			.values({
				id: generateId(),
				narratorId,
				filePath,
				originalContent: content,
				createdAt: new Date().toISOString(),
			})
			.onConflictDoNothing();
	} catch (err) {
		// Non-fatal: snapshot failure should never block tool execution
		logger.debug("Failed to record file snapshot", {
			narratorId,
			filePath,
			error: String(err),
		});
	}
}

/**
 * Ensure file snapshots for multiple files at once (used by Bash tool).
 */
export async function ensureFileSnapshots(
	narratorId: string,
	files: Array<{ path: string; readContent: () => Promise<string | null> }>,
): Promise<void> {
	for (const file of files) {
		await ensureFileSnapshot(narratorId, file.path, file.readContent);
	}
}
