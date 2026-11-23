import { isFileHistoryEnabledForDevice } from "@shared/file-change-protocol";
import { eq } from "drizzle-orm";
import { db } from "../db";
import { narrators } from "../db/schema";
import { readQueryFirst } from "../db/worker-read";
import { AppError, NotFoundError } from "../lib/errors";

/** Call only with server-selected execution identities, never a request device hint. */
export function assertFileHistoryEnabledForDevice(deviceId: string | null | undefined): void {
	if (!isFileHistoryEnabledForDevice(deviceId))
		throw new AppError(
			"Local file history and file restoration are disabled; messages can be changed without restoring files",
			409,
			"FILE_HISTORY_DISABLED",
		);
}

/** The persisted execution device is maintained by the authorized workspace transition. */
export async function isNarratorFileHistoryEnabled(narratorId: string): Promise<boolean> {
	const narrator = await readQueryFirst(
		db
			.select({ defaultDeviceId: narrators.defaultDeviceId })
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.limit(1),
		{ executionPolicy: "worker-required", maxRows: 1 },
	);
	if (!narrator) throw new NotFoundError("Narrator", narratorId);
	return isFileHistoryEnabledForDevice(narrator.defaultDeviceId);
}

export async function resolveNarratorMessageOnlyRevert(
	narratorId: string,
	skipRevert: boolean | undefined,
	explicitFileRestore = false,
): Promise<boolean> {
	const enabled = await isNarratorFileHistoryEnabled(narratorId);
	if (!enabled && (skipRevert === false || explicitFileRestore))
		assertFileHistoryEnabledForDevice("local");
	return skipRevert === true || !enabled;
}
