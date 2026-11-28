import type { Database } from "bun:sqlite";
import type {
	LegacyDirectoryBlacklistEntry,
	LegacyExecutionPolicyRuleSet,
} from "../../services/execution-policy/types";
import { narratorProjectIdSql } from "../narrator-project-sql";
import {
	MAX_POLICY_SOURCE_DEPTH,
	RUNTIME_REGISTRATION_MAX_BYTES,
	readRuntimeRegistrationColumn,
} from "../validators/runtime-registration";

export const EXECUTION_POLICY_RULE_LIMIT = 2_000;
const MAX_FACTS_BYTES = 256 * 1024 * 1024;

export interface ExecutionPolicyFacts {
	inheritedNarratorIds: string[];
	projectId: string | null;
	projectIds: string[];
	projectGitPath: string | null;
	projectRuleSets: (LegacyExecutionPolicyRuleSet | null)[];
	whitelistDirs: NonNullable<LegacyExecutionPolicyRuleSet["whitelistDirs"]>;
	blacklistDirs: (LegacyDirectoryBlacklistEntry & { narratorId: string })[];
	commandWhitelist: NonNullable<LegacyExecutionPolicyRuleSet["commandWhitelist"]>;
	commandBlacklist: NonNullable<LegacyExecutionPolicyRuleSet["commandBlacklist"]>;
}

const ruleColumns = `id, enabled, narrator_id AS narratorId,
	target_kind AS targetKind, target_value AS targetValue, device_scope AS deviceScope,
	created_at AS createdAt, updated_at AS updatedAt`;
const pathColumns = "path, path_flavor AS pathFlavor, path_key AS pathKey";

export function readExecutionPolicySnapshot(
	db: Database,
	narratorId: string,
	signal: AbortSignal,
): ExecutionPolicyFacts {
	return db.transaction(() => readExecutionPolicyFacts(db, narratorId, signal))();
}

function readExecutionPolicyFacts(
	db: Database,
	narratorId: string,
	signal: AbortSignal,
): ExecutionPolicyFacts {
	if (!narratorId) throw new Error("Permission policy requires a narrator ID");
	let bytes = 0;
	function checkBytes(row: Record<string, unknown>) {
		signal.throwIfAborted();
		for (const value of Object.values(row)) {
			bytes += typeof value === "string" ? Buffer.byteLength(value) : 8;
			if (bytes > MAX_FACTS_BYTES)
				throw new Error("Permission policy snapshot byte budget exceeded");
		}
	}

	const narratorQuery = db.query<
		{ projectId: string | null; sourceId: string | null; registration: string | null },
		[string]
	>(`SELECT ${narratorProjectIdSql("narrators")} AS projectId,
		policy_source_narrator_id AS sourceId,
		CASE WHEN octet_length(runtime_registration_json) > ${RUNTIME_REGISTRATION_MAX_BYTES}
			THEN 'false' ELSE runtime_registration_json END AS registration
		FROM narrators WHERE id = ?`);
	const inheritedNarratorIds: string[] = [];
	const contextProjects = new Set<string>();
	let projectId: string | null = null;
	let next: string | null = narratorId;
	while (next) {
		signal.throwIfAborted();
		if (
			inheritedNarratorIds.includes(next) ||
			inheritedNarratorIds.length >= MAX_POLICY_SOURCE_DEPTH
		) {
			throw new Error("Invalid or excessive permission inheritance chain");
		}
		const narrator = narratorQuery.get(next);
		if (!narrator) throw new Error(`Narrator not found: ${next}`);
		if (narrator.registration !== null) {
			readRuntimeRegistrationColumn(JSON.parse(narrator.registration));
		}
		inheritedNarratorIds.push(next);
		projectId ??= narrator.projectId;
		if (narrator.projectId) contextProjects.add(narrator.projectId);
		next = narrator.sourceId;
	}

	const projectQuery = db.query<{ gitPath: string; policy: string | null }, [string]>(
		`SELECT git_path AS gitPath,
			CASE WHEN chapter_settings IS NOT NULL AND NOT json_valid(chapter_settings) THEN NULL
			ELSE (SELECT json_group_object(key,
				CASE WHEN type IN ('array', 'object') THEN json(value)
				WHEN type IN ('true', 'false') THEN json(type) ELSE value END)
				FROM (SELECT key, type, value FROM json_each(chapter_settings)
					WHERE key IN ('whitelistDirs', 'blacklistDirs', 'commandWhitelist', 'commandBlacklist')
					ORDER BY id)) END AS policy
		FROM projects WHERE id = ?`,
	);
	const projectRuleSets: LegacyExecutionPolicyRuleSet[] = [];
	let projectGitPath: string | null = null;
	for (const id of contextProjects) {
		signal.throwIfAborted();
		const row = projectQuery.get(id);
		if (!row) throw new Error("Permission project context no longer exists");
		if (row.policy === null) throw new Error("Invalid permission project settings");
		checkBytes(row);
		if (projectId === id) projectGitPath = row.gitPath;
		projectRuleSets.push(JSON.parse(row.policy));
	}

	const ids = inheritedNarratorIds.map(() => "?").join(", ");
	function rules<
		K extends "whitelistDirs" | "blacklistDirs" | "commandWhitelist" | "commandBlacklist",
	>(table: string, columns: string): ExecutionPolicyFacts[K] {
		const result: Record<string, unknown>[] = [];
		const statement = db.prepare<Record<string, unknown>, string[]>(
			`SELECT ${ruleColumns}, ${columns} FROM ${table}
			WHERE narrator_id IN (${ids}) LIMIT ${EXECUTION_POLICY_RULE_LIMIT + 1}`,
		);
		try {
			for (const row of statement.iterate(...inheritedNarratorIds)) {
				if (result.length === EXECUTION_POLICY_RULE_LIMIT)
					throw new Error("Permission rule budget exceeded");
				checkBytes(row);
				result.push({ ...row, enabled: Number(row.enabled) === 1 });
			}
		} finally {
			statement.finalize();
		}
		return result as unknown as ExecutionPolicyFacts[K];
	}

	return {
		inheritedNarratorIds,
		projectId,
		projectIds: [...contextProjects],
		projectGitPath,
		projectRuleSets,
		whitelistDirs: rules<"whitelistDirs">(
			"narrator_whitelist_dirs",
			`${pathColumns}, access_level AS accessLevel`,
		),
		blacklistDirs: rules<"blacklistDirs">(
			"narrator_blacklist_dirs",
			`${pathColumns}, deny_level AS denyLevel`,
		),
		commandWhitelist: rules<"commandWhitelist">("narrator_whitelist_cmds", "pattern"),
		commandBlacklist: rules<"commandBlacklist">(
			"narrator_blacklist_cmds",
			"pattern, deny_prompt AS denyPrompt",
		),
	};
}
