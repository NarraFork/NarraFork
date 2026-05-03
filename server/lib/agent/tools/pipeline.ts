import { z } from "zod/v4";
import { executePipelineRule, PipelineRuleError } from "../pipeline-rules";
import {
	clearPipelineState,
	getPipelineState,
	readCaptureText,
	startPipelineState,
} from "../pipeline-state";
import type { ToolDefinition, ToolResult } from "../types";

const MAX_FINAL_CHARS = 50_000;
const DEFAULT_FINAL_CHARS = 12_000;

function clampFinalChars(value: unknown): number {
	if (!Number.isInteger(value) || (value as number) <= 0) return DEFAULT_FINAL_CHARS;
	return Math.min(value as number, MAX_FINAL_CHARS);
}

function clipFinal(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 120))}\n\n...pipeline result truncated (${text.length - maxChars} chars omitted)...`;
}

export const startPipelineTool: ToolDefinition = {
	name: "StartPipeline",
	description:
		"Enter pipeline mode. While pipeline mode is active, subsequent tool outputs that could be long are captured under short aliases (p1, p2, ...) and only a <=100 character preview is returned to the model. Use EndPipeline with a shell-like rule string to filter/reorder captured aliases and exit pipeline mode.",
	rawJsonSchema: {
		type: "object",
		properties: {
			label: {
				type: "string",
				description: "Optional human-readable label for this pipeline session.",
			},
			maxPreviewChars: {
				type: "number",
				description:
					"Maximum preview characters per captured tool output. Default 100, maximum 100.",
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		label: z
			.string()
			.optional()
			.describe("Optional human-readable label for this pipeline session."),
		maxPreviewChars: z
			.number()
			.optional()
			.describe("Maximum preview characters per captured tool output. Default 100, maximum 100."),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { label, maxPreviewChars } = args as { label?: string; maxPreviewChars?: number };
		const state = await startPipelineState(ctx.narratorId, { label, maxPreviewChars });
		return {
			output:
				`Pipeline mode started${state.label ? ` (${state.label})` : ""}. ` +
				`Future tool outputs will be captured as p1, p2, ... with previews capped at ${state.maxPreviewChars} characters. ` +
				'Use EndPipeline with a rule such as: from p1 | grep -i "error|failed" | head -n 20',
		};
	},
};

export const endPipelineTool: ToolDefinition = {
	name: "EndPipeline",
	description:
		'Exit pipeline mode and produce a final result from captured tool-output aliases using a restricted shell-like pipeline syntax. The rule is parsed and executed internally; it never invokes a shell. Supported commands: from, cat, grep [-i] [-v] PATTERN, head [-n] N, tail [-n] N, sort [-r], uniq, cut -d DELIM -f FIELDS. Example: from p1 p2 | grep -i "error|failed" | grep -v node_modules | sort | uniq | head -n 30',
	rawJsonSchema: {
		type: "object",
		properties: {
			rule: {
				type: "string",
				description:
					'Restricted shell-like pipeline rule, e.g. `from p1 | grep -i "error|failed" | head -n 20`. If omitted, all captures are concatenated.',
			},
			aliases: {
				type: "array",
				items: { type: "string" },
				description: "Default aliases to use when rule does not start with `from`.",
			},
			format: {
				type: "string",
				enum: ["sections", "plain"],
				description: "Output format. Default sections.",
			},
			maxChars: {
				type: "number",
				description: "Maximum characters in the final output. Default 12000, maximum 50000.",
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		rule: z
			.string()
			.optional()
			.describe("Restricted shell-like pipeline rule. If omitted, all captures are concatenated."),
		aliases: z
			.array(z.string())
			.optional()
			.describe("Default aliases to use when rule does not start with `from`."),
		format: z.enum(["sections", "plain"]).optional().describe("Output format. Default sections."),
		maxChars: z
			.number()
			.optional()
			.describe("Maximum characters in the final output. Default 12000, maximum 50000."),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const {
			rule,
			aliases,
			format = "sections",
			maxChars,
		} = args as {
			rule?: string;
			aliases?: string[];
			format?: "sections" | "plain";
			maxChars?: number;
		};
		const state = await getPipelineState(ctx.narratorId);
		if (!state) {
			return { output: "Pipeline mode is not active.", isError: true };
		}

		try {
			const sources = await Promise.all(
				state.captures.map(async (capture) => ({
					alias: capture.alias,
					text: await readCaptureText(capture),
				})),
			);
			const result = executePipelineRule(sources, rule, aliases);
			await clearPipelineState(ctx.narratorId);

			const body = clipFinal(result.text || "(empty)", clampFinalChars(maxChars));
			if (format === "plain") {
				return { output: body };
			}

			const captureSummary = state.captures
				.map((capture) => `${capture.alias}=${capture.toolName}(${capture.bytes}B)`)
				.join(", ");
			const stageSummary = result.stages.length > 0 ? result.stages.join(" | ") : "cat";
			return {
				output: [
					"Pipeline result",
					`Aliases used: ${result.aliases.join(", ") || "(none)"}`,
					`Captured: ${captureSummary || "(none)"}`,
					`Rule: ${rule?.trim() || stageSummary}`,
					"",
					body,
				].join("\n"),
			};
		} catch (err) {
			if (err instanceof PipelineRuleError) {
				return { output: `Pipeline rule error: ${err.message}`, isError: true };
			}
			return {
				output: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
				isError: true,
			};
		}
	},
};
