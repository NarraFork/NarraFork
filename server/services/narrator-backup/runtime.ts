import { join } from "node:path";
import { activeDatabaseBackend } from "@server/db";
import { getDbPath } from "@server/db/connection";
import { requireApplicationDataDirectory } from "@server/lib/data-directory-security";
import { hotSafe } from "@server/lib/hot-safe";
import { getNarraforkHome } from "@server/lib/narrafork-home";
import { getUploadsDir } from "@server/lib/uploads";
import { readOrInitializeFileChangeSourceInstanceId } from "../file-change-runtime";
import { NarratorBackupJobs } from "./jobs";
import type { BackupWorkerConfig } from "./worker";

export async function runtimeNarratorBackupConfig(): Promise<BackupWorkerConfig> {
	const home = getNarraforkHome();
	await requireApplicationDataDirectory(home);
	return {
		backend: activeDatabaseBackend === "postgres" ? "postgres" : "sqlite",
		databasePath: getDbPath(),
		settingsPath: join(home, "settings.json"),
		dataDirectory: home,
		postgresUrl:
			activeDatabaseBackend === "postgres"
				? (process.env.NF_DATABASE_URL ?? process.env.DATABASE_URL)
				: undefined,
		sourceInstanceId: await readOrInitializeFileChangeSourceInstanceId(),
		proofDirectory: join(home, "narrator-backup-proof"),
		objectSource: {
			shadowRoot: join(home, "tree-snapshots"),
			uploadsRoot: getUploadsDir(),
			blobRoot: join(home, "file-change-blobs"),
			journalRoot: join(home, "worktree-requests"),
		},
	};
}
/** No startup schema/migrations, no public shares, no executor or lease activation. */
export function createRuntimeNarratorBackupJobs() {
	return new NarratorBackupJobs({
		root: join(getNarraforkHome(), "narrator-backups"),
		config: runtimeNarratorBackupConfig,
	});
}
export const narratorBackupJobs = hotSafe(
	"narrafork.narrator-backup-jobs.v1",
	createRuntimeNarratorBackupJobs,
);
export const planNarratorBackup = narratorBackupJobs.planNarratorBackup.bind(narratorBackupJobs);
export const exportNarratorBackup =
	narratorBackupJobs.exportNarratorBackup.bind(narratorBackupJobs);
export const previewNarratorRestore =
	narratorBackupJobs.previewNarratorRestore.bind(narratorBackupJobs);
export const restoreNarratorState =
	narratorBackupJobs.restoreNarratorState.bind(narratorBackupJobs);
