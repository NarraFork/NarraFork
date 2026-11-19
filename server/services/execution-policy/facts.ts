import {
	narratorBlacklistCmds,
	narratorBlacklistDirs,
	narrators,
	narratorWhitelistCmds,
	narratorWhitelistDirs,
	projects,
} from "@server/db/schema";
import { DbReadError } from "@server/lib/db-worker/errors";
import { MAX_POLICY_SOURCE_DEPTH, policySourceIdOf } from "@server/lib/runtime-source";
import { eq, inArray, sql } from "drizzle-orm";
import type { BunSQLiteDatabase } from "drizzle-orm/bun-sqlite";
import { narratorProjectIdText } from "../read/acl-sql";
import type { LegacyExecutionPolicyRuleSet } from "./types";

export const EXECUTION_POLICY_RULE_LIMIT = 2000;
/** Domain transport observation, independent of generic SELECT observations. */
export const EXECUTION_POLICY_FACTS_MAX_BYTES = 256 * 1024 * 1024;
export type ExecutionPolicyFactsStore = Pick<BunSQLiteDatabase, "select">;
type ProjectFact = { chapterSettings: unknown; gitPath: string | null };

export interface ExecutionPolicyFacts {
	narratorId: string;
	ownerNarratorId: string;
	inheritedNarratorIds: string[];
	projectId: string | null;
	projectGitPath: string | null;
	projectRuleSets: LegacyExecutionPolicyRuleSet[];
	whitelistDirs: (typeof narratorWhitelistDirs.$inferSelect)[];
	blacklistDirs: (typeof narratorBlacklistDirs.$inferSelect)[];
	commandWhitelist: (typeof narratorWhitelistCmds.$inferSelect)[];
	commandBlacklist: (typeof narratorBlacklistCmds.$inferSelect)[];
}

/**
 * Facts only, using the caller's connection and snapshot. The SQL project scalar
 * shares the upstream explicit-project/primary-link rule without importing DB wiring.
 * Final authorization calls this synchronously inside its own write transaction.
 */
export function readExecutionPolicyFactsNow(
	narratorId: string,
	store: ExecutionPolicyFactsStore,
	projectReader: (id: string) => ProjectFact | undefined = (id) =>
		store
			.select({ chapterSettings: projects.chapterSettings, gitPath: projects.gitPath })
			.from(projects)
			.where(eq(projects.id, id))
			.get(),
): ExecutionPolicyFacts {
	const inheritedNarratorIds: string[] = [];
	let next: string | null = narratorId;
	let projectId: string | null = null;
	const contextProjects = new Set<string>();
	while (next) {
		if (
			inheritedNarratorIds.includes(next) ||
			inheritedNarratorIds.length >= MAX_POLICY_SOURCE_DEPTH
		) {
			throw new DbReadError("DB_READ_FAILED", "Invalid or excessive permission inheritance chain");
		}
		const narrator = store
			.select({
				id: narrators.id,
				projectId: sql<string | null>`${sql.raw(narratorProjectIdText("narrators"))}`,
				policySourceNarratorId: narrators.policySourceNarratorId,
				runtimeRegistrationJson: narrators.runtimeRegistrationJson,
				type: narrators.type,
				variant: narrators.variant,
				parentNarratorId: narrators.parentNarratorId,
			})
			.from(narrators)
			.where(eq(narrators.id, next))
			.get();
		if (!narrator) throw new DbReadError("DB_READ_FAILED", `Narrator not found: ${next}`);
		inheritedNarratorIds.push(narrator.id);
		projectId ??= narrator.projectId;
		if (narrator.projectId) contextProjects.add(narrator.projectId);
		next = policySourceIdOf(narrator);
	}
	let projectGitPath: string | null = null;
	const projectRuleSets: LegacyExecutionPolicyRuleSet[] = [];
	for (const id of contextProjects) {
		const project = projectReader(id);
		if (!project)
			throw new DbReadError("DB_READ_FAILED", "Permission project context no longer exists");
		if (id === projectId) projectGitPath = project.gitPath;
		const rules = project.chapterSettings as LegacyExecutionPolicyRuleSet | null;
		projectRuleSets.push({
			whitelistDirs: rules?.whitelistDirs,
			blacklistDirs: rules?.blacklistDirs,
			commandWhitelist: rules?.commandWhitelist,
			commandBlacklist: rules?.commandBlacklist,
		});
	}
	// Retain upstream query/index order and its exact per-table overflow sentinel.
	const whitelistDirs = store
		.select()
		.from(narratorWhitelistDirs)
		.where(inArray(narratorWhitelistDirs.narratorId, inheritedNarratorIds))
		.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
		.all();
	const blacklistDirs = store
		.select()
		.from(narratorBlacklistDirs)
		.where(inArray(narratorBlacklistDirs.narratorId, inheritedNarratorIds))
		.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
		.all();
	const commandWhitelist = store
		.select()
		.from(narratorWhitelistCmds)
		.where(inArray(narratorWhitelistCmds.narratorId, inheritedNarratorIds))
		.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
		.all();
	const commandBlacklist = store
		.select()
		.from(narratorBlacklistCmds)
		.where(inArray(narratorBlacklistCmds.narratorId, inheritedNarratorIds))
		.limit(EXECUTION_POLICY_RULE_LIMIT + 1)
		.all();
	if (
		[whitelistDirs, blacklistDirs, commandWhitelist, commandBlacklist].some(
			(rows) => rows.length > EXECUTION_POLICY_RULE_LIMIT,
		)
	) {
		throw new DbReadError("DB_READ_BUDGET", "Permission rule budget exceeded");
	}
	return {
		narratorId,
		ownerNarratorId: inheritedNarratorIds.at(-1) ?? narratorId,
		inheritedNarratorIds,
		projectId,
		projectGitPath,
		projectRuleSets,
		whitelistDirs,
		blacklistDirs,
		commandWhitelist,
		commandBlacklist,
	};
}
