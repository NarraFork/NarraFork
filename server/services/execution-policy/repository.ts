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
import { eq, inArray } from "drizzle-orm";
import { mergeExecutionPolicyRuleSets, normalizeExecutionPolicyRuleSet } from "./normalize";
import type { ExecutionPolicyRuleSet, LegacyExecutionPolicyRuleSet } from "./types";

export interface LoadedExecutionPolicy extends ExecutionPolicyRuleSet {
	narratorId: string;
	ownerNarratorId: string;
	/** Includes this narrator and its subagent ancestors, never siblings. */
	inheritedNarratorIds?: string[];
	projectId: string | null;
	projectGitPath: string | null;
	settingsRevision: number;
}

export class ExecutionPolicyRepository {
	async load(narratorId: string): Promise<LoadedExecutionPolicy> {
		return this.loadNow(narratorId);
	}

	/** Bounded synchronous snapshot, also usable inside the final request transaction. */
	loadNow(narratorId: string, store: Pick<typeof db, "select"> = db): LoadedExecutionPolicy {
		const inheritedNarratorIds: string[] = [];
		let next: string | null = narratorId;
		let projectId: string | null = null;
		const contextProjects = new Set<string>();
		while (next) {
			if (inheritedNarratorIds.includes(next) || inheritedNarratorIds.length >= 16) {
				throw new Error("Invalid or excessive permission inheritance chain");
			}
			const narrator = store
				.select({
					id: narrators.id,
					chapterId: narrators.chapterId,
					contextProjectId: narrators.contextProjectId,
					variant: narrators.variant,
					parentNarratorId: narrators.parentNarratorId,
				})
				.from(narrators)
				.where(eq(narrators.id, next))
				.get();
			if (!narrator) throw new Error(`Narrator not found: ${next}`);
			inheritedNarratorIds.push(narrator.id);
			// The chapter owns project context. contextProjectId is an explicit
			// standalone fallback, not a replacement and never inferred from cwd.
			let effectiveProjectId = narrator.contextProjectId;
			if (narrator.chapterId) {
				const chapter = store
					.select({ projectId: chapters.projectId })
					.from(chapters)
					.where(eq(chapters.id, narrator.chapterId))
					.get();
				if (!chapter) throw new Error("Permission chapter context no longer exists");
				effectiveProjectId = chapter.projectId;
			}
			projectId ??= effectiveProjectId;
			if (effectiveProjectId) contextProjects.add(effectiveProjectId);
			next = narrator.variant.startsWith("subagent:") ? narrator.parentNarratorId : null;
		}
		const ownerNarratorId = inheritedNarratorIds.at(-1) ?? narratorId;
		let projectGitPath: string | null = null;
		const projectRuleSets: ExecutionPolicyRuleSet[] = [];
		for (const contextProjectId of contextProjects) {
			const project = store
				.select({ chapterSettings: projects.chapterSettings, gitPath: projects.gitPath })
				.from(projects)
				.where(eq(projects.id, contextProjectId))
				.get();
			if (!project) throw new Error("Permission project context no longer exists");
			if (contextProjectId === projectId) projectGitPath = project.gitPath;
			// Switching a child's context cannot erase the parent's project deny layer.
			projectRuleSets.push(
				normalizeExecutionPolicyRuleSet(
					project.chapterSettings as LegacyExecutionPolicyRuleSet,
					"project",
				),
			);
		}
		const [whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist] = [
			store
				.select()
				.from(narratorWhitelistDirs)
				.where(inArray(narratorWhitelistDirs.narratorId, inheritedNarratorIds))
				.limit(2001)
				.all(),
			store
				.select()
				.from(narratorBlacklistDirs)
				.where(inArray(narratorBlacklistDirs.narratorId, inheritedNarratorIds))
				.limit(2001)
				.all(),
			store
				.select()
				.from(narratorWhitelistCmds)
				.where(inArray(narratorWhitelistCmds.narratorId, inheritedNarratorIds))
				.limit(2001)
				.all(),
			store
				.select()
				.from(narratorBlacklistCmds)
				.where(inArray(narratorBlacklistCmds.narratorId, inheritedNarratorIds))
				.limit(2001)
				.all(),
		] as const;
		if (
			[whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist].some(
				(rows) => rows.length > 2000,
			)
		) {
			throw new Error("Permission rule budget exceeded");
		}
		return {
			narratorId,
			ownerNarratorId,
			inheritedNarratorIds,
			projectId,
			projectGitPath,
			settingsRevision: getSettingsRevision(),
			...mergeExecutionPolicyRuleSets(
				normalizeExecutionPolicyRuleSet(settings.agent, "global"),
				...projectRuleSets,
				normalizeExecutionPolicyRuleSet(
					{ whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist },
					"narrator",
				),
			),
		};
	}
}
export const executionPolicyRepository = new ExecutionPolicyRepository();
