/**
 * File snapshot service — records the original content of files before
 * a narrator modifies them for the first time.
 *
 * Used by Write/Edit tools (precise tracking) and Bash tool (best-effort
 * via git status diff).
 *
 * Snapshots store decoded text, so the charset used to decode must be recorded
 * alongside it: restoring a legacy-encoded file with a hardcoded UTF-8 encoder
 * would silently rewrite the file's charset. Content that is not representable
 * as text at all is marked binary and excluded from text-based rebuilds.
 */
import { and, eq } from "drizzle-orm";
import { db } from "../db";
import { narratorFileSnapshots } from "../db/schema";
import { generateId } from "../lib/id";
import { logger } from "../lib/logger";

export type SnapshotFailureMode = "best-effort" | "required";
export type EnsureFileSnapshotResult = "existing" | "created" | "failed";

/** Original file state captured for a snapshot. */
export interface SnapshotContent {
	/** Decoded text, or null when the file did not exist. */
	content: string | null;
	/** Charset the bytes were decoded with. Defaults to utf-8 when omitted. */
	encoding?: string | null;
	/** True when the bytes are not losslessly representable as text. */
	isBinary?: boolean;
}

/** Normalize the two accepted reader return shapes into a SnapshotContent. */
function toSnapshotContent(value: string | null | SnapshotContent): SnapshotContent {
	if (value === null || typeof value === "string") return { content: value };
	return value;
}

/**
 * Ensure a file snapshot exists for one narrator + device + normalized absolute path.
 * Existing callers remain best-effort by default; mutation tools opt into required mode.
 *
 * `readContent` may return plain text (assumed UTF-8) or a {@link SnapshotContent}
 * carrying the charset and binary flag. Prefer the latter wherever the caller has
 * already decoded the bytes.
 */
export async function ensureFileSnapshot(
	narratorId: string,
	deviceId: string,
	filePath: string,
	readContent: () => Promise<string | null | SnapshotContent>,
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

		const captured = toSnapshotContent(await readContent());
		const inserted = await db
			.insert(narratorFileSnapshots)
			.values({
				id: generateId(),
				narratorId,
				deviceId,
				filePath,
				originalContent: captured.content,
				originalEncoding: captured.encoding ?? null,
				isBinary: captured.isBinary ?? false,
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
	files: Array<{ path: string; readContent: () => Promise<string | null | SnapshotContent> }>,
): Promise<void> {
	for (const file of files) {
		await ensureFileSnapshot(narratorId, deviceId, file.path, file.readContent);
	}
}
