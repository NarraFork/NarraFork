import type { Database } from "bun:sqlite";
import { projects } from "@server/db/schema";
import { checkDomainBudget } from "@server/lib/db-worker/domain-protocol";
import { DbReadError, readAborted } from "@server/lib/db-worker/errors";
import { eq, sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/bun-sqlite";
import {
	EXECUTION_POLICY_FACTS_MAX_BYTES,
	type ExecutionPolicyFacts,
	readExecutionPolicyFactsNow,
} from "./facts";
import type { LegacyExecutionPolicyRuleSet } from "./types";

export interface ExecutionPolicyFactsInput {
	narratorId: string;
}
export function validateExecutionPolicyFactsInput(
	input: unknown,
): input is ExecutionPolicyFactsInput {
	if (!input || typeof input !== "object" || Array.isArray(input)) return false;
	const row = input as Record<string, unknown>;
	return (
		Object.keys(row).length === 1 &&
		Object.hasOwn(row, "narratorId") &&
		typeof row.narratorId === "string" &&
		row.narratorId.trim().length > 0 &&
		Buffer.byteLength(row.narratorId) <= 256
	);
}

/** Caller owns the read transaction; this handler never opens a global DB or settings. */
export function readExecutionPolicyFacts(
	sqlite: Database,
	input: ExecutionPolicyFactsInput,
	signal: AbortSignal,
): ExecutionPolicyFacts {
	if (signal.aborted) throw readAborted();
	if (!validateExecutionPolicyFactsInput(input))
		throw new DbReadError("DB_READ_INVALID", "Invalid policy facts input");
	if (!sqlite.inTransaction)
		throw new DbReadError(
			"DB_READ_INVALID",
			"Policy facts require an existing snapshot transaction",
		);
	const store = drizzle(sqlite);
	const facts = readExecutionPolicyFactsNow(input.narratorId, store, (id) =>
		store
			.select({
				gitPath: projects.gitPath,
				// Duplicate keys preserve JSON.parse's last-key precedence. Only policy
				// arrays cross the worker boundary, never unrelated prompts or routines.
				chapterSettings: sql<string>`(SELECT json_group_object(key,
					CASE WHEN type IN ('array', 'object') THEN json(value)
					WHEN type IN ('true', 'false') THEN json(type) ELSE value END)
					FROM (SELECT key, type, value FROM json_each(${projects.chapterSettings})
					WHERE key IN ('whitelistDirs', 'blacklistDirs', 'commandWhitelist', 'commandBlacklist')
					ORDER BY id))`.mapWith(
					(value: string) => JSON.parse(value) as LegacyExecutionPolicyRuleSet,
				),
			})
			.from(projects)
			.where(eq(projects.id, id))
			.get(),
	);
	if (signal.aborted) throw readAborted();
	checkDomainBudget(facts, EXECUTION_POLICY_FACTS_MAX_BYTES, 10_000);
	return facts;
}
