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
		skillSummaryCache.set(
			skillRoot,
			skills.map((s) => ({ name: s.name, description: s.description })),
		);
	} catch {
		// Non-fatal — cache will be populated on first tool execution
	}
}

function buildDescription(config: AgentConfig): string {
	const base =
		"Load a project skill by name. Skills provide domain-specific instructions and knowledge for the current project. Use this tool when a task matches a skill's description.";

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
	parameters: z.object({
		name: z.string().describe("The name of the skill to load"),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { name } = args as { name: string };

		if (!ctx.skillRoot) {
			return {
				output: "No skill root available. Skills require a project with a git repository.",
				isError: true,
			};
		}

		try {
			const skills = await loadAllSkills(ctx.skillRoot);

			// Refresh cache
			skillSummaryCache.set(
				ctx.skillRoot,
				skills.map((s) => ({ name: s.name, description: s.description })),
			);

			const skill = skills.find((s) => s.name === name);

			if (!skill) {
				const available = skills.map((s) => s.name).join(", ");
				return {
					output: `Skill "${name}" not found. Available skills: ${available || "(none)"}`,
					isError: true,
				};
			}

			const skillDir = join(skill.location, "..");
			const lines = [`<skill_content name="${escapeXml(skill.name)}">`];
			lines.push(`# Skill: ${skill.name}`);
			lines.push("");
			if (skill.content) {
				lines.push(skill.content);
				lines.push("");
			}

			lines.push(`Base directory for this skill: ${skillDir}`);

			if (skill.files.length > 0) {
				lines.push("");
				lines.push("<skill_files>");
				for (const f of skill.files) {
					lines.push(`<file>${join(skillDir, f)}</file>`);
				}
				lines.push("</skill_files>");
			}

			lines.push("</skill_content>");

			return { output: lines.join("\n"), title: `Skill: ${skill.name}` };
		} catch (err) {
			return {
				output: `Failed to load skill "${name}": ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
