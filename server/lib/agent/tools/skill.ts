import { dirname, join } from "node:path";
import { z } from "zod/v4";
import {
	getSkillContextCacheKey,
	loadSkillByNameForContext,
	loadSkillSummariesForContext,
	type SkillContext,
	type SkillSummaryInfo,
} from "../../../services/skill-service";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

/** Escape characters that would break XML attribute values or text content. */
function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

interface SkillSummaryCacheEntry {
	name: string;
	description: string;
	source?: string;
}

// In-memory cache of skill summaries keyed by resolved skill context/scope.
const skillSummaryCache = new Map<string, SkillSummaryCacheEntry[]>();

function summarize(skills: SkillSummaryInfo[]): SkillSummaryCacheEntry[] {
	return skills
		.filter((s) => !s.disabled)
		.map((s) => ({ name: s.name, description: s.description, source: s.source }));
}

function contextFromConfig(config: AgentConfig): SkillContext {
	return {
		projectGitPath: config.projectGitPath ?? config.skillRoot ?? null,
		cwd: config.cwd ?? config.skillRoot ?? null,
	};
}

function contextFromToolContext(ctx: {
	projectGitPath?: string | null;
	skillRoot?: string | null;
	cwd?: string | null;
}): SkillContext {
	return {
		projectGitPath: ctx.projectGitPath ?? ctx.skillRoot ?? null,
		cwd: ctx.cwd ?? ctx.skillRoot ?? null,
	};
}

/**
 * Pre-populate the skill summary cache for a given narrator/workspace context.
 * Called during narrator creation so the tool description includes the skill list
 * from the very first turn.
 */
export async function warmSkillCacheForContext(
	context: SkillContext,
	options: { forceRefresh?: boolean } = {},
): Promise<string> {
	const fallbackKey = getSkillContextCacheKey(context);
	try {
		const result = await loadSkillSummariesForContext(context, options);
		skillSummaryCache.set(result.scopeKey, summarize(result.skills));
		return result.scopeKey;
	} catch {
		// Non-fatal — cache will be populated on first tool execution
		return fallbackKey;
	}
}

/** Backward-compatible wrapper for callers that still pass a single project root. */
export async function warmSkillCache(skillRoot: string): Promise<void> {
	await warmSkillCacheForContext({ projectGitPath: skillRoot, cwd: skillRoot });
}

function buildDescription(config: AgentConfig): string {
	const base =
		'Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n\nWhen users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.\n\nHow to invoke:\n- Use this tool with the skill name and optional arguments\n- Examples:\n  - `skill: "pdf"` - invoke the pdf skill\n  - `skill: "commit", args: "-m \'Fix bug\'"` - invoke with arguments\n  - `skill: "review-pr", args: "123"` - invoke with arguments\n  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name\n\nImportant:\n- Available skills are listed in system-reminder messages in the conversation\n- When a skill matches the user\'s request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- NEVER mention a skill without actually calling this tool\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again';

	const key = config.skillScopeKey ?? getSkillContextCacheKey(contextFromConfig(config));
	const summaries = skillSummaryCache.get(key);

	if (!summaries || summaries.length === 0) {
		return base;
	}

	const lines = [`${base}\n\n<available_skills>`];
	for (const s of summaries) {
		lines.push(`<skill name="${escapeXml(s.name)}">${escapeXml(s.description)}</skill>`);
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export const skillTool: ToolDefinition = {
	name: "Skill",
	description: buildDescription,
	rawJsonSchema: {
		type: "object",
		properties: {
			name: {
				description: "The name of the skill to load",
				type: "string",
			},
			skill: {
				description: "The skill name (alias for name)",
				type: "string",
			},
			args: {
				description: "Optional arguments for the skill",
				type: "string",
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		name: z.string().optional().describe("The name of the skill to load"),
		skill: z.string().optional().describe("The skill name (alias for name)"),
		args: z.string().optional().describe("Optional arguments for the skill"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			name,
			skill,
			args: skillArgs,
		} = args as {
			name?: string;
			skill?: string;
			args?: string;
		};
		const skillName = skill ?? name;

		if (!skillName) {
			return {
				output: "No skill name provided. Please specify a skill name.",
				isError: true,
			};
		}

		const context = contextFromToolContext(ctx);
		if (!context.cwd && !context.projectGitPath) {
			return {
				output: "No working directory available. Skills require a project or working directory.",
				isError: true,
			};
		}

		try {
			const summaryResult = await loadSkillSummariesForContext(context);
			skillSummaryCache.set(summaryResult.scopeKey, summarize(summaryResult.skills));

			const found = await loadSkillByNameForContext(context, skillName);

			if (!found) {
				const available = summaryResult.skills
					.filter((s) => !s.disabled)
					.map((s) => s.name)
					.join(", ");
				return {
					output: `Skill "${skillName}" not found. Available skills: ${available || "(none)"}`,
					isError: true,
				};
			}

			const skillDir = dirname(found.location);
			const lines = [`<skill_content name="${escapeXml(found.name)}">`];
			lines.push(`# Skill: ${found.name}`);
			lines.push("");
			if (found.content) {
				lines.push(found.content);
				lines.push("");
			}

			lines.push(`Base directory for this skill: ${skillDir}`);

			if (skillArgs) {
				lines.push("");
				lines.push(`<skill_args>${escapeXml(skillArgs)}</skill_args>`);
			}

			if (found.files.length > 0) {
				lines.push("");
				lines.push("<skill_files>");
				for (const f of found.files) {
					lines.push(`<file>${join(skillDir, f)}</file>`);
				}
				lines.push("</skill_files>");
			}

			lines.push("</skill_content>");

			return { output: lines.join("\n"), title: `Skill: ${found.name}` };
		} catch (err) {
			return {
				output: `Failed to load skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
