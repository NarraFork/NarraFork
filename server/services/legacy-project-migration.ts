import { eq } from "drizzle-orm";
import { activeDatabaseBackend, db, sqlite } from "../db";
import { getDbPath } from "../db/connection";
import { narrators } from "../db/schema";
import { AppError, NotFoundError } from "../lib/errors";
import { hotSafe } from "../lib/hot-safe";
import { logger } from "../lib/logger";
import { broadcastToNarrator } from "../websocket/narrator-ws";
import { prepareLegacyRootAdoption } from "./legacy-main-checkout-adoption";
import {
	getLegacyMigrationRuntimeWorkspace,
	isLegacyMigrationRuntimeBusy,
	withLegacyMigrationRuntimeAdmission,
} from "./legacy-migration-runtime";
import {
	createLegacyProjectMigrationService,
	type MigrationPrincipal,
	type MigrationResult,
} from "./legacy-project-migration-core";
import { canReadNarrator, NARRATOR_ACL_COLUMNS } from "./narrator-acl";
import { disableLegacyProjectSync, legacySyncInFlight } from "./project-db-sync-coordinator";

export type { MigrationPrincipal } from "./legacy-project-migration-core";

const service = createLegacyProjectMigrationService({
	sqlite,
	jobs: hotSafe<Map<string, Promise<MigrationResult>>>(
		"narrafork.legacyProjectMigrationJobs",
		() => new Map(),
	),
	mainDatabasePath: activeDatabaseBackend === "sqlite" ? getDbPath() : undefined,
	disableSync: disableLegacyProjectSync,
	syncInFlight: legacySyncInFlight,
	runtimeBusy: isLegacyMigrationRuntimeBusy,
	runtimeWorkspace: getLegacyMigrationRuntimeWorkspace,
	withRuntimeAdmission: withLegacyMigrationRuntimeAdmission,
	prepareRootAdoption: prepareLegacyRootAdoption,
	// Enable after both empty/unborn and real-history Root0 production acceptance pass.
	retainedHistoryConsumersReady: true,
	// Enable the proven local/private/owner-only retained linked worktree subset.
	linkedWorktreeConsumersReady: true,
	onConverted: (updates) => {
		for (const update of updates) {
			try {
				broadcastToNarrator(update.id, {
					type: "workspace_context_changed",
					narratorId: update.id,
					previous: update.previous,
					current: update.current,
				});
			} catch (error) {
				logger.warn("Could not publish adopted workspace context", {
					narratorId: update.id,
					error: String(error),
				});
			}
		}
	},
});
function requireSqlite() {
	if (activeDatabaseBackend !== "sqlite")
		throw new AppError(
			"Legacy migration is not supported on PostgreSQL",
			503,
			"POSTGRES_UNSUPPORTED",
		);
}
async function readableNarratorTargets(ids: readonly string[], actor: MigrationPrincipal) {
	if (ids.length > 199)
		throw new AppError(
			"Migration target inventory exceeds its budget",
			503,
			"MIGRATION_TARGET_BUDGET",
		);
	const visible: { id: string; type: string; variant: string }[] = [];
	for (const id of ids) {
		const row = await db.query.narrators.findFirst({
			where: eq(narrators.id, id),
			columns: { ...NARRATOR_ACL_COLUMNS, variant: true },
		});
		if (row && (await canReadNarrator(row, actor)))
			visible.push({ id: row.id, type: row.type, variant: row.variant });
	}
	return visible;
}

export const legacyProjectMigrationService = {
	chapterTarget: async (chapterId: string, actor: MigrationPrincipal) => {
		requireSqlite();
		const candidate = service.chapterTargetCandidate(chapterId);
		const visible = await readableNarratorTargets(candidate.narratorIds, actor);
		if (
			!visible.length &&
			(!actor.userId || (!actor.isAdmin && candidate.actorUserId !== actor.userId))
		)
			throw new NotFoundError("Chapter", chapterId);
		const target =
			visible.find((row) => row.type === "primary" && row.variant === "primary") ??
			visible.find((row) => row.type === "primary") ??
			visible.at(0);
		return { projectId: candidate.projectId, narratorId: target?.id ?? null };
	},
	preview: async (...args: Parameters<typeof service.preview>) => {
		requireSqlite();
		const preview = await service.preview(...args);
		if (preview.phase !== "completed") return preview;
		const ids = sqlite
			.query<{ narrator_ids: string }, [string]>(
				"SELECT narrator_ids FROM legacy_project_migrations WHERE project_id=? LIMIT 1",
			)
			.get(args[0]);
		const targets = await readableNarratorTargets(
			ids ? (JSON.parse(ids.narrator_ids) as string[]) : [],
			args[1],
		);
		return { ...preview, narratorIds: targets.map((row) => row.id) };
	},
	migrate: (...args: Parameters<typeof service.migrate>) => {
		requireSqlite();
		return service.migrate(...args);
	},
};
