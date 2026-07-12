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

export type SnapshotFailureMode = "best-effort" | "required";
export type EnsureFileSnapshotResult = "existing" | "created" | "failed";

/**
 * Ensure a file snapshot exists for one narrator + device + normalized absolute path.
 * Existing callers remain best-effort by default; mutation tools opt into required mode.
 */
export async function ensureFileSnapshot(
	narratorId: string,
	deviceId: string,
	filePath: string,
	readContent: () => Promise<string | null>,
	failureMode: SnapshotFailureMode = "best-effort",
): Promise<EnsureFileSnapshotResult> {
	try {
		const existing = await db.query.narratorFileSnapshots.findFirst({
			where: and(
				eq(narratorFileSnapshots.narratorId, narratorId),
				eq(narratorFileSnapshots.deviceId, deviceId),
				eq(narratorFileSnapshots.filePath, filePath),
			),
			columns: { id: true },
		});
		if (existing) return "existing";

		const content = await readContent();
		const inserted = await db
			.insert(narratorFileSnapshots)
			.values({
				id: generateId(),
				narratorId,
				deviceId,
				filePath,
				originalContent: content,
				createdAt: new Date().toISOString(),
			})
			.onConflictDoNothing()
			.returning({ id: narratorFileSnapshots.id });
		return inserted.length > 0 ? "created" : "existing";
	} catch (err) {
		if (failureMode === "required") throw err;
		logger.debug("Failed to record file snapshot", {
			narratorId,
			deviceId,
			filePath,
			error: String(err),
		});
		return "failed";
	}
}

/** Ensure file snapshots for multiple files on the same device. */
export async function ensureFileSnapshots(
	narratorId: string,
	deviceId: string,
	files: Array<{ path: string; readContent: () => Promise<string | null> }>,
): Promise<void> {
	for (const file of files) {
		await ensureFileSnapshot(narratorId, deviceId, file.path, file.readContent);
	}
}
