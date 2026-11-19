import { getSettingsRevision, settings } from "@server/lib/settings";
import { isSignedReviewBoundaryRow, markTrustedReviewBoundary } from "../narrator-review-boundary";
import type { ExecutionPolicyFacts } from "./facts";
import {
	mergeExecutionPolicyRuleSets,
	normalizeDirectoryBlacklistRule,
	normalizeExecutionPolicyRuleSet,
} from "./normalize";
import type { ExecutionPolicyRuleSet } from "./types";

export interface LoadedExecutionPolicy extends ExecutionPolicyRuleSet {
	narratorId: string;
	ownerNarratorId: string;
	/** This narrator and its registered policy-source chain, never siblings. */
	inheritedNarratorIds?: string[];
	projectId: string | null;
	projectGitPath: string | null;
	settingsRevision: number;
}
export interface ExecutionPolicySettingsSnapshot {
	settingsRevision: number;
	globalRules: ExecutionPolicyRuleSet;
	trustedReviewBoundaryIds: ReadonlySet<string>;
}

/** Capture settings and verify instance signatures after the awaited facts read. */
export function captureExecutionPolicySettings(
	facts: ExecutionPolicyFacts,
): ExecutionPolicySettingsSnapshot {
	return {
		settingsRevision: getSettingsRevision(),
		globalRules: normalizeExecutionPolicyRuleSet(settings.agent, "global"),
		trustedReviewBoundaryIds: new Set(
			facts.blacklistDirs.filter(isSignedReviewBoundaryRow).map((row) => row.id),
		),
	};
}

/** Settings and signing secrets stay on the main thread; the facts carry no authority. */
export function materializeExecutionPolicy(
	facts: ExecutionPolicyFacts,
	snapshot: ExecutionPolicySettingsSnapshot = captureExecutionPolicySettings(facts),
): LoadedExecutionPolicy {
	return {
		narratorId: facts.narratorId,
		ownerNarratorId: facts.ownerNarratorId,
		inheritedNarratorIds: facts.inheritedNarratorIds,
		projectId: facts.projectId,
		projectGitPath: facts.projectGitPath,
		settingsRevision: snapshot.settingsRevision,
		...mergeExecutionPolicyRuleSets(
			snapshot.globalRules,
			...facts.projectRuleSets.map((rules) => normalizeExecutionPolicyRuleSet(rules, "project")),
			normalizeExecutionPolicyRuleSet(
				{
					whitelistDirs: facts.whitelistDirs,
					blacklistDirs: [],
					commandWhitelist: facts.commandWhitelist,
					commandBlacklist: facts.commandBlacklist,
				},
				"narrator",
			),
			{
				directoryWhitelist: [],
				directoryBlacklist: facts.blacklistDirs.map((row) => {
					const rule = normalizeDirectoryBlacklistRule(row, "narrator");
					return snapshot.trustedReviewBoundaryIds.has(row.id)
						? markTrustedReviewBoundary({ ...rule, enabled: true })
						: rule;
				}),
				commandWhitelist: [],
				commandBlacklist: [],
			},
		),
	};
}
