import { join } from "node:path";
import { z } from "zod/v4";
import { loadAllSkills } from "../../../services/skill-service";
import type { AgentConfig, ToolDefinition, ToolResult } from "../types";

/** Escape characters that would break XML attribute values or text content. */
function escapeXml(s: string): string {
	return s
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;");
}

// In-memory cache of skill summaries keyed by skillRoot
const skillSummaryCache = new Map<string, Array<{ name: string; description: string }>>();

/**
 * Pre-populate the skill summary cache for a given skillRoot.
 * Called during narrator creation so the tool description includes the skill list
 * from the very first turn.
 */
export async function warmSkillCache(skillRoot: string): Promise<void> {
	try {
		const skills = await loadAllSkills(skillRoot);
		const enabled = skills.filter((s) => !s.disabled);
		skillSummaryCache.set(
			skillRoot,
			enabled.map((s) => ({ name: s.name, description: s.description })),
		);
	} catch {
		// Non-fatal — cache will be populated on first tool execution
	}
}

function buildDescription(config: AgentConfig): string {
	const base =
		'Execute a skill within the main conversation\n\nWhen users ask you to perform tasks, check if any of the available skills match. Skills provide specialized capabilities and domain knowledge.\n\nWhen users reference a "slash command" or "/<something>" (e.g., "/commit", "/review-pr"), they are referring to a skill. Use this tool to invoke it.\n\nHow to invoke:\n- Use this tool with the skill name and optional arguments\n- Examples:\n  - `skill: "pdf"` - invoke the pdf skill\n  - `skill: "commit", args: "-m \'Fix bug\'"` - invoke with arguments\n  - `skill: "review-pr", args: "123"` - invoke with arguments\n  - `skill: "ms-office-suite:pdf"` - invoke using fully qualified name\n\nImportant:\n- Available skills are listed in system-reminder messages in the conversation\n- When a skill matches the user\'s request, this is a BLOCKING REQUIREMENT: invoke the relevant Skill tool BEFORE generating any other response about the task\n- NEVER mention a skill without actually calling this tool\n- Do not invoke a skill that is already running\n- Do not use this tool for built-in CLI commands (like /help, /clear, etc.)\n- If you see a <command-name> tag in the current conversation turn, the skill has ALREADY been loaded - follow the instructions directly instead of calling this tool again';

	const summaries = config.skillRoot ? skillSummaryCache.get(config.skillRoot) : undefined;

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
			skill: {
				description: 'The skill name. E.g., "commit", "review-pr", or "pdf"',
				type: "string",
			},
			args: {
				description: "Optional arguments for the skill",
				type: "string",
			},
		},
		required: ["skill"],
		additionalProperties: false,
	},
	parameters: z.object({
		name: z.string().optional().describe("The name of the skill to load"),
		skill: z.string().optional().describe("The skill name (alias for name)"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { name, skill } = args as { name?: string; skill?: string };
		const skillName = skill ?? name;

		if (!skillName) {
			return {
				output: "No skill name provided. Please specify a skill name.",
				isError: true,
			};
		}

		if (!ctx.skillRoot) {
			return {
				output: "No skill root available. Skills require a project with a git repository.",
				isError: true,
			};
		}

		try {
			const allSkills = await loadAllSkills(ctx.skillRoot);
			const skills = allSkills.filter((s) => !s.disabled);

			// Refresh cache
			skillSummaryCache.set(
				ctx.skillRoot,
				skills.map((s) => ({ name: s.name, description: s.description })),
			);

			const found = skills.find((s) => s.name === skillName);

			if (!found) {
				const available = skills.map((s) => s.name).join(", ");
				return {
					output: `Skill "${skillName}" not found. Available skills: ${available || "(none)"}`,
					isError: true,
				};
			}

			const skillDir = join(found.location, "..");
			const lines = [`<skill_content name="${escapeXml(found.name)}">`];
			lines.push(`# Skill: ${found.name}`);
			lines.push("");
			if (found.content) {
				lines.push(found.content);
				lines.push("");
			}

			lines.push(`Base directory for this skill: ${skillDir}`);

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
