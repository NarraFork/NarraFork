import { db } from "@server/db";
import {
	chapters,
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narrators,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
} from "@server/db/schema";
import { getSettingsRevision, settings } from "@server/lib/settings";
import { eq } from "drizzle-orm";
import { mergeExecutionPolicyRuleSets, normalizeExecutionPolicyRuleSet } from "./normalize";
import type { ExecutionPolicyRuleSet, LegacyExecutionPolicyRuleSet } from "./types";

export interface LoadedExecutionPolicy extends ExecutionPolicyRuleSet {
	narratorId: string;
	ownerNarratorId: string;
	projectId: string | null;
	projectGitPath: string | null;
	settingsRevision: number;
}

export class ExecutionPolicyRepository {
	async load(narratorId: string): Promise<LoadedExecutionPolicy> {
		const [narrator] = await db
			.select({
				id: narrators.id,
				chapterId: narrators.chapterId,
				type: narrators.type,
				parentNarratorId: narrators.parentNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, narratorId))
			.limit(1);
		if (!narrator) throw new Error(`Narrator not found: ${narratorId}`);

		const ownerNarratorId =
			narrator.type === "subagent" && narrator.parentNarratorId
				? narrator.parentNarratorId
				: narrator.id;
		let projectId: string | null = null;
		let projectGitPath: string | null = null;
		let projectRules: LegacyExecutionPolicyRuleSet | undefined;
		if (narrator.chapterId) {
			const [chapter] = await db
				.select({ projectId: chapters.projectId })
				.from(chapters)
				.where(eq(chapters.id, narrator.chapterId))
				.limit(1);
			projectId = chapter?.projectId ?? null;
			if (projectId) {
				const [project] = await db
					.select({ chapterSettings: projects.chapterSettings, gitPath: projects.gitPath })
					.from(projects)
					.where(eq(projects.id, projectId))
					.limit(1);
				projectGitPath = project?.gitPath ?? null;
				projectRules = (project?.chapterSettings ?? undefined) as
					| LegacyExecutionPolicyRuleSet
					| undefined;
			}
		}

		const [whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist] = await Promise.all([
			db
				.select()
				.from(narratorWhitelistDirs)
				.where(eq(narratorWhitelistDirs.narratorId, ownerNarratorId)),
			db
				.select()
				.from(narratorBlacklistDirs)
				.where(eq(narratorBlacklistDirs.narratorId, ownerNarratorId)),
			db
				.select()
				.from(narratorWhitelistCmds)
				.where(eq(narratorWhitelistCmds.narratorId, ownerNarratorId)),
			db
				.select()
				.from(narratorBlacklistCmds)
				.where(eq(narratorBlacklistCmds.narratorId, ownerNarratorId)),
		]);

		const globalRules = normalizeExecutionPolicyRuleSet(settings.agent, "global");
		const normalizedProjectRules = normalizeExecutionPolicyRuleSet(projectRules, "project");
		const narratorRules = normalizeExecutionPolicyRuleSet(
			{ whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist },
			"narrator",
		);
		return {
			narratorId,
			ownerNarratorId,
			projectId,
			projectGitPath,
			settingsRevision: getSettingsRevision(),
			...mergeExecutionPolicyRuleSets(globalRules, normalizedProjectRules, narratorRules),
		};
	}
}

export const executionPolicyRepository = new ExecutionPolicyRepository();
