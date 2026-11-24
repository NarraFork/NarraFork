import { db, sqlite } from "@server/db";
import {
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narrators,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
} from "@server/db/schema";
import type { ReadQueryOptions } from "@server/db/worker-read";
import {
	EXECUTION_POLICY_RULE_LIMIT,
	type ExecutionPolicyFacts,
} from "@server/lib/db-worker/execution-policy-query";
import { runReadTask, WorkersUnavailableError } from "@server/lib/db-worker/pool";
import { MAX_POLICY_SOURCE_DEPTH, policySourceIdOf } from "@server/lib/runtime-source";
import { getSettingsRevision, settings } from "@server/lib/settings";
import { eq, inArray } from "drizzle-orm";
import { narratorProjectIdColumn } from "../narrator-project";
import { isSignedReviewBoundaryRow, markTrustedReviewBoundary } from "../narrator-review-boundary";
import {
	mergeExecutionPolicyRuleSets,
	normalizeDirectoryBlacklistRule,
	normalizeExecutionPolicyRuleSet,
} from "./normalize";
import type { ExecutionPolicyRuleSet, LegacyExecutionPolicyRuleSet } from "./types";

export interface LoadedExecutionPolicy extends ExecutionPolicyRuleSet {
	narratorId: string;
	ownerNarratorId: string;
	/** This narrator and its registered policy-source chain, never siblings. */
	inheritedNarratorIds?: string[];
	projectIds?: readonly string[];
	projectId: string | null;
	projectGitPath: string | null;
	settingsRevision: number;
}

export class ExecutionPolicyRepository {
	async load(narratorId: string, signal?: AbortSignal): Promise<LoadedExecutionPolicy>;
	async load(narratorId: string, readOptions?: ReadQueryOptions): Promise<LoadedExecutionPolicy>;
	async load(
		narratorId: string,
		readOptionsOrSignal?: ReadQueryOptions | AbortSignal,
	): Promise<LoadedExecutionPolicy> {
		const readOptions =
			readOptionsOrSignal instanceof AbortSignal
				? { signal: readOptionsOrSignal }
				: readOptionsOrSignal;
		const signal = readOptions?.signal;
		signal?.throwIfAborted();
		if (!sqlite.filename || sqlite.filename === ":memory:" || sqlite.inTransaction) {
			throw new WorkersUnavailableError("requires_committed_file");
		}
		const facts = await runReadTask<ExecutionPolicyFacts>(
			sqlite.filename,
			{ kind: "executionPolicyFacts", narratorId },
			{
				...readOptions,
				diagnosticSource: "execution-policy-facts",
				timeoutMs: Math.min(readOptions?.timeoutMs ?? 5_000, 5_000),
				signal,
			},
		);
		signal?.throwIfAborted();
		return materializeExecutionPolicy(narratorId, facts);
	}

	/**
	 * Bounded synchronous snapshot, also usable inside the final request transaction.
	 * Rules merge along the registered policy-source chain (same source rule and depth
	 * bound as capability resolution), so any two related narrators share rules the
	 * same way, whatever created them.
	 */
	loadNow(narratorId: string, store: Pick<typeof db, "select"> = db): LoadedExecutionPolicy {
		const inheritedNarratorIds: string[] = [];
		let next: string | null = narratorId;
		let projectId: string | null = null;
		const contextProjects = new Set<string>();
		while (next) {
			if (
				inheritedNarratorIds.includes(next) ||
				inheritedNarratorIds.length >= MAX_POLICY_SOURCE_DEPTH
			) {
				throw new Error("Invalid or excessive permission inheritance chain");
			}
			const narrator = store
				.select({
					id: narrators.id,
					// The narrator's primary project (explicit, else its indexed directory's):
					// the same single answer as resolveNarratorProjectId.
					projectId: narratorProjectIdColumn,
					policySourceNarratorId: narrators.policySourceNarratorId,
					runtimeRegistrationJson: narrators.runtimeRegistrationJson,
					type: narrators.type,
					variant: narrators.variant,
					parentNarratorId: narrators.parentNarratorId,
				})
				.from(narrators)
				.where(eq(narrators.id, next))
				.get();
			if (!narrator) throw new Error(`Narrator not found: ${next}`);
			inheritedNarratorIds.push(narrator.id);
			const effectiveProjectId = narrator.projectId;
			projectId ??= effectiveProjectId;
			if (effectiveProjectId) contextProjects.add(effectiveProjectId);
			next = policySourceIdOf(narrator);
		}
		let projectGitPath: string | null = null;
		const projectRuleSets: (LegacyExecutionPolicyRuleSet | null)[] = [];
		for (const contextProjectId of contextProjects) {
			const project = store
				.select({ chapterSettings: projects.chapterSettings, gitPath: projects.gitPath })
				.from(projects)
				.where(eq(projects.id, contextProjectId))
				.get();
			if (!project) throw new Error("Permission project context no longer exists");
			if (contextProjectId === projectId) projectGitPath = project.gitPath;
			// Switching a child's context cannot erase the parent's project deny layer.
			projectRuleSets.push(project.chapterSettings as LegacyExecutionPolicyRuleSet | null);
		}
		const [whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist] = [
			store
				.select()
				.from(narratorWhitelistDirs)
				.where(inArray(narratorWhitelistDirs.narratorId, inheritedNarratorIds))
				.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
				.all(),
			store
				.select()
				.from(narratorBlacklistDirs)
				.where(inArray(narratorBlacklistDirs.narratorId, inheritedNarratorIds))
				.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
				.all(),
			store
				.select()
				.from(narratorWhitelistCmds)
				.where(inArray(narratorWhitelistCmds.narratorId, inheritedNarratorIds))
				.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
				.all(),
			store
				.select()
				.from(narratorBlacklistCmds)
				.where(inArray(narratorBlacklistCmds.narratorId, inheritedNarratorIds))
				.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
				.all(),
		] as const;
		if (
			[whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist].some(
				(rows) => rows.length > EXECUTION_POLICY_RULE_LIMIT,
			)
		) {
			throw new Error("Permission rule budget exceeded");
		}
		return materializeExecutionPolicy(narratorId, {
			inheritedNarratorIds,
			projectId,
			projectIds: [...contextProjects],
			projectGitPath,
			projectRuleSets,
			whitelistDirs,
			blacklistDirs,
			commandWhitelist,
			commandBlacklist,
		});
	}
}

function materializeExecutionPolicy(
	narratorId: string,
	facts: ExecutionPolicyFacts,
): LoadedExecutionPolicy {
	const {
		inheritedNarratorIds,
		projectId,
		projectIds,
		projectGitPath,
		projectRuleSets,
		whitelistDirs,
		blacklistDirs,
		commandWhitelist,
		commandBlacklist,
	} = facts;
	const narratorRules = normalizeExecutionPolicyRuleSet(
		{ whitelistDirs, commandWhitelist, commandBlacklist },
		"narrator",
	);
	// Verify instance signatures in-process; the read Worker does not have the secret.
	narratorRules.directoryBlacklist = blacklistDirs.map((row) => {
		const normalized = normalizeDirectoryBlacklistRule(row, "narrator");
		return isSignedReviewBoundaryRow(row)
			? markTrustedReviewBoundary({ ...normalized, enabled: true })
			: normalized;
	});
	return {
		narratorId,
		ownerNarratorId: inheritedNarratorIds.at(-1) ?? narratorId,
		inheritedNarratorIds,
		projectId,
		projectIds,
		projectGitPath,
		settingsRevision: getSettingsRevision(),
		...mergeExecutionPolicyRuleSets(
			normalizeExecutionPolicyRuleSet(settings.agent, "global"),
			...projectRuleSets.map((rules) => normalizeExecutionPolicyRuleSet(rules, "project")),
			narratorRules,
		),
	};
}
export const executionPolicyRepository = new ExecutionPolicyRepository();
