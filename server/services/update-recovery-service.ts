import { NotFoundError } from "../lib/errors";
import { logger } from "../lib/logger";
import { isSubagentVariant } from "../lib/narrator-utils";
import { narratorService } from "./narrator-service";
import {
	consumePlannedUpdateRecoverySnapshot,
	removePlannedUpdateRecoverySnapshot,
	writePlannedUpdateRecoverySnapshot,
} from "./update-coordinator";

/**
 * Resume narrators captured immediately before a planned update replacement was spawned.
 * The normal startup recovery must run first so stale tool calls and running statuses are
 * converted into the recoverable idle/interrupted shape expected by continue/resume paths.
 */
export async function restoreNarratorsAfterPlannedUpdate(): Promise<void> {
	const snapshot = consumePlannedUpdateRecoverySnapshot();
	if (!snapshot || snapshot.narrators.length === 0) {
		if (snapshot) removePlannedUpdateRecoverySnapshot();
		return;
	}

	logger.info("Restoring narrators after planned update", {
		targetVersion: snapshot.targetVersion,
		capturedAt: snapshot.capturedAt,
		count: snapshot.narrators.length,
	});

	const retryTargets = new Map<string, (typeof snapshot.narrators)[number]>();
	const narrators = (
		await Promise.all(
			snapshot.narrators.map(async (target) => {
				try {
					const narrator = await narratorService.getById(target.narratorId);
					return narrator ? { target, narrator } : null;
				} catch (error) {
					if (error instanceof NotFoundError) {
						logger.info("Skipping deleted narrator in planned-update recovery", {
							narratorId: target.narratorId,
						});
					} else {
						retryTargets.set(target.narratorId, target);
						logger.warn("Failed to load narrator for planned-update recovery", {
							narratorId: target.narratorId,
							error: error instanceof Error ? error.message : String(error),
						});
					}
					return null;
				}
			}),
		)
	).filter((entry): entry is NonNullable<typeof entry> => entry !== null);

	// Resume subagents first so a parent narrator that was waiting on an Agent tool
	// can observe the child result after its own continuation starts.
	for (const entry of narrators) {
		if (!isSubagentVariant(entry.narrator.variant)) continue;
		try {
			const { resumeSubagent } = await import("./subagent-resume");
			await resumeSubagent({
				subagentId: entry.target.narratorId,
				intent: "continue_tool_results",
				actor: "parent_agent",
				createdBy: entry.target.userId ?? null,
				replyInUserLanguage: entry.target.replyInUserLanguage ?? false,
				locale: entry.target.locale as "en" | "zh-CN",
			});
			logger.info("Planned-update subagent resume started", {
				narratorId: entry.target.narratorId,
			});
		} catch (error) {
			retryTargets.set(entry.target.narratorId, entry.target);
			logger.warn("Failed to resume subagent after planned update", {
				narratorId: entry.target.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	for (const entry of narrators) {
		if (isSubagentVariant(entry.narrator.variant)) continue;
		try {
			const { continueNarrator } = await import("./narrator-session");
			await continueNarrator(
				entry.target.narratorId,
				entry.target.locale as "en" | "zh-CN",
				entry.target.replyInUserLanguage ?? false,
				entry.target.userId ?? null,
			);
			logger.info("Planned-update narrator resume started", {
				narratorId: entry.target.narratorId,
			});
		} catch (error) {
			retryTargets.set(entry.target.narratorId, entry.target);
			logger.warn("Failed to resume narrator after planned update", {
				narratorId: entry.target.narratorId,
				error: error instanceof Error ? error.message : String(error),
			});
		}
	}

	if (retryTargets.size === 0) {
		removePlannedUpdateRecoverySnapshot();
		return;
	}

	writePlannedUpdateRecoverySnapshot({
		version: snapshot.version,
		targetVersion: snapshot.targetVersion,
		capturedAt: new Date().toISOString(),
		narrators: [...retryTargets.values()],
	});
	logger.warn("Retained failed planned-update recovery targets for next startup", {
		count: retryTargets.size,
		narrators: [...retryTargets.keys()],
	});
}
