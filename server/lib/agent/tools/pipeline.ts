import { z } from "zod/v4";
import {
	executePreparedPipelineRule,
	MAX_PIPELINE_EXECUTION_MS,
	MAX_PIPELINE_OUTPUT_CHARS,
	MAX_PIPELINE_TOTAL_BYTES,
	MAX_PIPELINE_TOTAL_CHARS,
	MAX_PIPELINE_TOTAL_LINES,
	PipelineRuleError,
	preparePipelineRule,
} from "../pipeline-rules";
import {
	DEFAULT_PIPELINE_UNUSED_TOOL_CALL_THRESHOLD,
	getPipelineState,
	markPipelineUsed,
	readCaptureTextBounded,
	startPipelineState,
} from "../pipeline-state";
import type { ToolContext, ToolDefinition, ToolResult } from "../types";
import { looseNumber, normalizeNumber } from "./number-param";

const MAX_FINAL_CHARS = MAX_PIPELINE_OUTPUT_CHARS;
const DEFAULT_FINAL_CHARS = 12_000;
const PIPELINE_RULE_HELP =
	"Supported commands: from, cat, grep [-i] [-v] PATTERN, head [-n] N, tail [-n] N, " +
	"sort [-r], uniq, cut -d DELIM -f FIELDS.";

type PipelineQueryArgs = {
	rule?: string;
	aliases?: string[];
	format?: "sections" | "plain";
	maxChars?: number;
};

const pipelineQueryRawJsonSchema: Record<string, unknown> = {
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
};

const pipelineQueryParameters = z.object({
	rule: z
		.string()
		.optional()
		.describe("Restricted shell-like pipeline rule. If omitted, all captures are concatenated."),
	aliases: z
		.array(z.string())
		.optional()
		.describe("Default aliases to use when rule does not start with `from`."),
	format: z.enum(["sections", "plain"]).optional().describe("Output format. Default sections."),
	maxChars: looseNumber("Maximum characters in the final output. Default 12000, maximum 50000."),
});

function clampFinalChars(value: unknown): number {
	// Non-finite or non-positive → fall back to the default (not clamped to 1).
	const normalized = normalizeNumber(value, { max: MAX_FINAL_CHARS });
	if (normalized == null || normalized <= 0) return DEFAULT_FINAL_CHARS;
	return normalized;
}

function clipFinal(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const marker = "\n\n...pipeline result truncated...";
	if (maxChars <= marker.length) return marker.slice(0, maxChars);
	return `${text.slice(0, maxChars - marker.length)}${marker}`;
}

async function executePipelineQuery(
	args: Record<string, unknown>,
	ctx: ToolContext,
): Promise<ToolResult> {
	const { rule, aliases, format = "sections", maxChars } = args as PipelineQueryArgs;
	const state = await getPipelineState(ctx.narratorId);
	if (!state) {
		return { output: "Pipeline mode is not active.", isError: true };
	}

	try {
		const captureByAlias = new Map(state.captures.map((capture) => [capture.alias, capture]));
		const plan = preparePipelineRule(
			state.captures.map((capture) => capture.alias),
			rule,
			aliases,
		);
		const deadlineAt = performance.now() + MAX_PIPELINE_EXECUTION_MS;
		const sources: Array<{ alias: string; text: string }> = [];
		let totalBytes = 0;
		let totalChars = 0;
		let totalLines = 0;
		for (const alias of plan.aliases) {
			const capture = captureByAlias.get(alias);
			if (!capture) throw new PipelineRuleError(`Unknown pipeline alias: ${alias}`);
			const source = await readCaptureTextBounded(capture, { deadlineAt });
			totalBytes += source.bytes;
			totalChars += source.chars;
			totalLines += source.lines;
			if (totalBytes > MAX_PIPELINE_TOTAL_BYTES) {
				throw new PipelineRuleError(
					`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_BYTES} total bytes`,
				);
			}
			if (totalChars > MAX_PIPELINE_TOTAL_CHARS) {
				throw new PipelineRuleError(
					`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_CHARS} total characters`,
				);
			}
			if (totalLines > MAX_PIPELINE_TOTAL_LINES) {
				throw new PipelineRuleError(
					`Pipeline input exceeds ${MAX_PIPELINE_TOTAL_LINES} total lines`,
				);
			}
			sources.push({ alias, text: source.text });
		}
		const remainingMs = Math.max(0, deadlineAt - performance.now());
		const result = executePreparedPipelineRule(sources, plan, {
			maxExecutionMs: remainingMs,
		});
		const limit = clampFinalChars(maxChars);
		let output: string;
		if (format === "plain") {
			output = clipFinal(result.text || "(empty)", limit);
		} else {
			const captureSummary = plan.aliases
				.map((alias) => {
					const capture = captureByAlias.get(alias);
					return capture ? `${capture.alias}=${capture.toolName}(${capture.bytes}B)` : alias;
				})
				.join(", ");
			const stageSummary = result.stages.length > 0 ? result.stages.join(" | ") : "cat";
			output = clipFinal(
				[
					"Pipeline result",
					`Aliases used: ${result.aliases.join(", ") || "(none)"}`,
					`Captured: ${captureSummary || "(none)"}`,
					`Rule: ${rule?.trim() || stageSummary}`,
					"",
					result.text || "(empty)",
				].join("\n"),
				limit,
			);
		}
		await markPipelineUsed(ctx.narratorId, state.id);
		return { output };
	} catch (err) {
		if (err instanceof PipelineRuleError) {
			return { output: `Pipeline rule error: ${err.message}`, isError: true };
		}
		return {
			output: `Pipeline error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
		};
	}
}

export const startPipelineTool: ToolDefinition = {
	name: "StartPipeline",
	description:
		"Enter pipeline mode. While pipeline mode is active, subsequent tool outputs that could be long are captured under short aliases (p1, p2, ...) and only a <=100 character preview is returned to the model. Use ExtractPipeline repeatedly to query the same captures without consuming them. Captures are automatically cleared after the configured number of unused tool calls.",
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
			maxUnusedToolCalls: {
				type: "number",
				description:
					"Optional per-pipeline override for automatic cleanup after unused tool calls. Use -1 to disable.",
			},
		},
		additionalProperties: false,
	},
	parameters: z.object({
		label: z
			.string()
			.optional()
			.describe("Optional human-readable label for this pipeline session."),
		maxPreviewChars: looseNumber(
			"Maximum preview characters per captured tool output. Default 100, maximum 100.",
		),
		maxUnusedToolCalls: looseNumber(
			"Automatic cleanup threshold for unused tool calls. Use -1 to disable.",
		),
	}),
	async execute(args, ctx): Promise<ToolResult> {
		const { label } = args as { label?: string };
		// Normalize numeric params leniently (float/string/out-of-range → sane int).
		const maxPreviewChars = normalizeNumber(
			(args as { maxPreviewChars?: unknown }).maxPreviewChars,
			{
				min: 1,
				max: 100,
			},
		);
		// -1 disables cleanup; otherwise clamp to [1, 1000].
		const maxUnusedToolCalls = normalizeNumber(
			(args as { maxUnusedToolCalls?: unknown }).maxUnusedToolCalls,
			{ min: 1, max: 1000, sentinel: -1 },
		);
		const state = await startPipelineState(ctx.narratorId, {
			label,
			maxPreviewChars,
			maxUnusedToolCalls:
				maxUnusedToolCalls ??
				ctx.pipelineUnusedToolCallThreshold ??
				DEFAULT_PIPELINE_UNUSED_TOOL_CALL_THRESHOLD,
		});
		const cleanupDescription =
			state.unusedToolCallThreshold === -1
				? "Automatic cleanup is disabled."
				: `Unused captures are automatically cleared after ${state.unusedToolCallThreshold} subsequent tool calls without ExtractPipeline.`;
		return {
			output:
				`Pipeline mode started${state.label ? ` (${state.label})` : ""}. ` +
				`Future tool outputs will be captured as p1, p2, ... with previews capped at ${state.maxPreviewChars} characters. ` +
				`${cleanupDescription} ` +
				'Use ExtractPipeline one or more times with a rule such as: from p1 | grep -i "error|failed" | head -n 20.',
		};
	},
};

export const extractPipelineTool: ToolDefinition = {
	name: "ExtractPipeline",
	description:
		"Produce a non-destructive result from the currently captured tool-output aliases. " +
		"Pipeline mode remains active and all captures are retained, so this tool may be called " +
		`multiple times with different rules. The rule is parsed internally and never invokes a shell. ${PIPELINE_RULE_HELP} ` +
		'Example: from p1 p2 | grep -i "error|failed" | grep -v node_modules | sort | uniq | head -n 30',
	rawJsonSchema: pipelineQueryRawJsonSchema,
	parameters: pipelineQueryParameters,
	execute(args, ctx): Promise<ToolResult> {
		return executePipelineQuery(args, ctx);
	},
};
