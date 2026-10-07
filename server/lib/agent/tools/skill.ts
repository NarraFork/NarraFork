import type { WorkspaceContext } from "@shared/workspace-context";
import { z } from "zod/v4";
import { isRuntimeToolAllowed } from "../../../services/agent-runtime/policy";
import {
	createConfiguredGlobalSkillAccess,
	getSkillContextCacheKey,
	loadSkillByNameForContext,
	loadSkillSummariesForContext,
	materializeGlobalSkillResources,
	SKILL_MATERIALIZE_DIR_REL,
	type SkillContext,
	type SkillSummaryInfo,
} from "../../../services/skill-service";
import { createApprovedWorkspaceArtifactAccess } from "../../../services/workspace-artifact-access";
import type { WorkspaceFileAccess } from "../../plan-file-path";
import { localPathSemantics, targetPathSemantics } from "../execution/path-semantics";
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

function cacheSummaries(key: string, skills: SkillSummaryInfo[]): void {
	if (!skillSummaryCache.has(key) && skillSummaryCache.size >= 200) {
		const oldest = skillSummaryCache.keys().next().value;
		if (oldest !== undefined) skillSummaryCache.delete(oldest);
	}
	skillSummaryCache.set(key, summarize(skills));
}

function summarize(skills: SkillSummaryInfo[]): SkillSummaryCacheEntry[] {
	return (
		skills
			.filter((s) => !s.disabled)
			// Codex-compatible: skills with `policy.allow_implicit_invocation: false`
			// stay out of the auto-injected list but remain explicitly invocable.
			.filter((s) => s.allowImplicitInvocation !== false)
			.map((s) => ({
				name: s.name,
				// Prefer the shorter Codex `short_description` for the injected list.
				description: s.shortDescription || s.description,
				source: s.source,
			}))
	);
}

function contextFromConfig(config: AgentConfig): SkillContext {
	return {
		deviceId:
			config.workspaceContext?.deviceId ??
			config.executionBackend?.deviceId ??
			config.defaultDeviceId,
		projectGitPath: config.projectGitPath ?? config.skillRoot ?? null,
		cwd: config.workspaceContext?.cwd ?? config.cwd ?? config.skillRoot ?? null,
		workspaceContext: config.workspaceContext,
		fileAccess: config.workspaceFileAccess,
	};
}

function contextFromToolContext(ctx: {
	projectGitPath?: string | null;
	skillRoot?: string | null;
	cwd?: string | null;
	workspaceContext?: WorkspaceContext;
	workspaceFileAccess?: WorkspaceFileAccess;
	defaultDeviceId?: string | null;
	executionTarget?: { deviceId: string };
}): SkillContext {
	return {
		deviceId:
			ctx.workspaceContext?.deviceId ??
			ctx.executionTarget?.deviceId ??
			ctx.workspaceFileAccess?.backend.deviceId ??
			ctx.defaultDeviceId,
		projectGitPath: ctx.projectGitPath ?? ctx.skillRoot ?? null,
		cwd: ctx.workspaceContext?.cwd ?? ctx.cwd ?? ctx.skillRoot ?? null,
		workspaceContext: ctx.workspaceContext,
		fileAccess: ctx.workspaceFileAccess,
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
		cacheSummaries(result.scopeKey, result.skills);
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

	const context = contextFromConfig(config);
	const key =
		context.workspaceContext ||
		context.fileAccess ||
		(context.deviceId && context.deviceId !== "local")
			? getSkillContextCacheKey(context)
			: (config.skillScopeKey ?? getSkillContextCacheKey(context));
	const summaries = skillSummaryCache.get(key);

	const blocked = config.blockedSkills;
	if (blocked?.all) {
		return `${base}\n\n<available_skills>\n(No skills are available — skills are disabled for this narrator by a custom trait.)\n</available_skills>`;
	}

	const blockedNames = blocked?.names?.length ? new Set(blocked.names) : null;
	const visibleSummaries = blockedNames
		? (summaries ?? []).filter((s) => !blockedNames.has(s.name))
		: summaries;

	if (!visibleSummaries || visibleSummaries.length === 0) {
		return base;
	}

	const lines = [`${base}\n\n<available_skills>`];
	for (const s of visibleSummaries) {
		lines.push(`<skill name="${escapeXml(s.name)}">${escapeXml(s.description)}</skill>`);
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

export const skillTool: ToolDefinition = {
	name: "Skill",
	executionRouting: {
		kind: "single",
		resolve(input, config) {
			if (
				input.materialize !== true ||
				(config.runtimePolicy &&
					(config.runtimePolicy.tools.readOnly ||
						!isRuntimeToolAllowed(config.runtimePolicy, "Write")))
			)
				return {
					key: "primary",
					operation: "control",
					deviceId: config.workspaceContext?.deviceId ?? config.defaultDeviceId ?? "local",
				};
			return {
				key: "primary",
				operation: "write",
				deviceId: config.workspaceContext?.deviceId ?? config.defaultDeviceId ?? "local",
				path: SKILL_MATERIALIZE_DIR_REL,
			};
		},
	},
	description: (config) =>
		`${buildDescription(config)}\n\nOptional materialize:true explicitly installs a published server-global skill's files into the current workspace (21 files / 1 MiB maximum, Write authorization required). It never runs scripts or project commands on the server. Without it, server-global resource paths remain explicitly device=local.`,
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
			materialize: {
				type: "boolean",
				description:
					"Explicitly copy server-global skill resources into the current workspace, without executing them; requires Write authority.",
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		name: z.string().optional().describe("The name of the skill to load"),
		skill: z.string().optional().describe("The skill name (alias for name)"),
		args: z.string().optional().describe("Optional arguments for the skill"),
		materialize: z
			.boolean()
			.optional()
			.describe(
				"Explicitly install server-global skill resources into this workspace; Write authorization required.",
			),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			name,
			skill,
			args: skillArgs,
			materialize,
		} = args as {
			name?: string;
			skill?: string;
			args?: string;
			materialize?: boolean;
		};
		const skillName = skill ?? name;

		if (!skillName) {
			return {
				output: "No skill name provided. Please specify a skill name.",
				isError: true,
			};
		}

		const blocked = ctx.blockedSkills;
		if (blocked?.all) {
			return {
				output: "Skills are disabled for this narrator by a custom trait.",
				isError: true,
			};
		}
		if (blocked?.names?.includes(skillName)) {
			return {
				output: `Skill "${skillName}" is blocked for this narrator by a custom trait.`,
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
			cacheSummaries(summaryResult.scopeKey, summaryResult.skills);

			let found = await loadSkillByNameForContext(context, skillName);

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

			const materializeBlocked =
				materialize &&
				ctx.runtimePolicy &&
				(ctx.runtimePolicy.tools.readOnly || !isRuntimeToolAllowed(ctx.runtimePolicy, "Write"));
			if (materialize && !materializeBlocked) {
				if (found.source !== "global")
					throw new Error(
						"Workspace skill resources already reside on their own device; materialize is for published server-global skills only.",
					);
				const sourceAccess = await createConfiguredGlobalSkillAccess(found, ctx);
				const artifactAccess = ctx.workspaceArtifactAccess
					? await ctx.workspaceArtifactAccess(sourceAccess)
					: createApprovedWorkspaceArtifactAccess(ctx, sourceAccess);
				found = await materializeGlobalSkillResources(found, sourceAccess, artifactAccess);
			}
			const paths = found.pathFlavor ? targetPathSemantics(found.pathFlavor) : localPathSemantics;
			const skillDir = paths.dirname(found.location);
			const deviceId = found.deviceId ?? "local";
			const lines = [`<skill_content name="${escapeXml(found.name)}">`];
			lines.push(`# Skill: ${found.name}`);
			lines.push("");
			if (found.content) {
				lines.push(found.content);
				lines.push("");
			}

			// Codex-compatible: surface the sidecar `interface.default_prompt` when the
			// caller did not provide explicit args, as a suggested starting point.
			if (found.defaultPrompt && !skillArgs) {
				lines.push(
					`<skill_default_prompt>${escapeXml(found.defaultPrompt)}</skill_default_prompt>`,
				);
				lines.push("");
			}

			lines.push(`Base directory for this skill: ${skillDir}`);
			if (materializeBlocked)
				lines.push(
					"Materialization was not performed: this runtime is read-only or lacks Write capability. Only skill text was loaded; resource paths remain on their original device.",
				);
			lines.push(
				`Resource device: ${deviceId} (${found.materializedFrom ? "explicit workspace copy of server-global configuration" : found.source === "global" ? "NarraFork server global configuration" : "workspace"}). Read auxiliary files with explicit device: "${deviceId}"; paths belong to that device, not the current default. Do not run server-global scripts on the host implicitly or reinterpret them as remote paths.`,
			);

			if (skillArgs) {
				lines.push("");
				lines.push(`<skill_args>${escapeXml(skillArgs)}</skill_args>`);
			}

			if (found.files.length > 0) {
				lines.push("");
				lines.push("<skill_files>");
				for (const f of found.files) {
					lines.push(
						`<file device="${escapeXml(deviceId)}">${escapeXml(paths.resolve(skillDir, f))}</file>`,
					);
				}
				lines.push("</skill_files>");
			}

			lines.push("</skill_content>");

			return {
				output: lines.join("\n"),
				title: `Skill: ${found.name}`,
				...(found.materializedFrom
					? {
							metadata: {
								materialized: true,
								deviceId: found.deviceId,
								contextKey: found.workspaceContextKey,
								location: found.location,
								source: found.materializedFrom,
							},
						}
					: materializeBlocked
						? { metadata: { materialized: false, reason: "runtime_write_unavailable" } }
						: {}),
			};
		} catch (err) {
			return {
				output: `Failed to load skill "${skillName}": ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
