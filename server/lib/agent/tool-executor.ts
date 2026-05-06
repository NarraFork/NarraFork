import { logger } from "../logger";
import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { getAnthropicProviderConfig, isAnthropicProvider, usesCodexApiMode } from "../settings";
import {
	capturePipelineOutput,
	clipText,
	getPipelineState,
	isPipelineControlTool,
} from "./pipeline-state";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type { AgentConfig, AgentToolUse, AllowPermissionResult, ToolContext } from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

/** Max size of output pushed via tool_output events (UI preview only). */
const MAX_STREAM_OUTPUT_LENGTH = 30_000;

/** Minimum interval between tool_output events (ms). */
const OUTPUT_THROTTLE_MS = 100;

export interface ToolExecResult {
	output: string;
	isError?: boolean;
	durationMs: number;
	permissionStartedAt?: number;
	executionStartedAt?: number;
	completedAt?: number;
	fatal?: boolean;
	/** Set when the tool call was rejected because the model's output was
	 *  cut off mid-stream (malformed JSON, suspiciously large content, etc.).
	 *  The loop will strip this tool_use + tool_result from the history sent
	 *  to the model and inject a user-side reminder instead. */
	broken?: boolean;
	/** Optional metadata from the tool (e.g. line numbers for Edit). */
	metadata?: Record<string, unknown>;
	/** Base64-encoded images to include in the tool result (for multimodal providers). */
	images?: Array<{ format: string; base64: string }>;
	/** When the permission handler redirected the input (e.g. plan-mode file path),
	 *  this holds the effective input that was actually executed. */
	updatedInput?: Record<string, unknown>;
}

interface ExecuteToolOptions {
	preGrantedPermission?: AllowPermissionResult;
}

/** Max serialized size of tool_input passed to hooks (bytes). */
const MAX_HOOK_INPUT_SIZE = 8_000;

/** Truncate tool_input for hook payloads to avoid sending huge content blobs. */
export function truncateToolInput(input: Record<string, unknown>): Record<string, unknown> {
	const serialized = JSON.stringify(input);
	if (serialized.length <= MAX_HOOK_INPUT_SIZE) return input;
	// Recursively truncate large string values
	const truncateValue = (val: unknown): unknown => {
		if (typeof val === "string" && val.length > 500) {
			return `${val.slice(0, 500)}… [truncated, ${val.length} chars total]`;
		}
		if (Array.isArray(val)) return val.map(truncateValue);
		if (val && typeof val === "object" && !Array.isArray(val)) {
			const obj: Record<string, unknown> = {};
			for (const [k, v] of Object.entries(val)) {
				obj[k] = truncateValue(v);
			}
			return obj;
		}
		return val;
	};
	return truncateValue(input) as Record<string, unknown>;
}

async function getPipelineCaptureText(
	result: { output: string; metadata?: Record<string, unknown> },
	finalOutput: string,
	appendNotice: string,
): Promise<string> {
	const fullOutputPath = result.metadata?.fullOutputPath;
	if (typeof fullOutputPath !== "string") return finalOutput;

	try {
		return `${await Bun.file(fullOutputPath).text()}${appendNotice}`;
	} catch (err) {
		logger.warn("Failed to read full tool output for pipeline capture", {
			fullOutputPath,
			error: err instanceof Error ? err.message : String(err),
		});
		return finalOutput;
	}
}

export async function executeTool(
	tu: AgentToolUse,
	config: AgentConfig,
	options: ExecuteToolOptions = {},
): Promise<ToolExecResult> {
	const tool = toolRegistry.get(tu.name);
	const locale = (config.locale as Locale) ?? "en";

	// Defense-in-depth: Codex and official Anthropic use native server-side web_search.
	// The WebSearch function tool is filtered from the API request (line ~407), but the
	// non-official codex endpoint may not validate tool names strictly — the model could
	// still invoke "WebSearch" based on training data / tool descriptions. Block execution
	const isOfficialAnthropic =
		isAnthropicProvider(config.provider) &&
		!!getAnthropicProviderConfig(config.provider)?.officialApi;
	if (tu.name === "WebSearch" && (usesCodexApiMode(config.provider) || isOfficialAnthropic)) {
		logger.warn("Blocked WebSearch function tool for native-search provider", {
			provider: config.provider,
			model: config.model,
			narratorId: config.narratorId,
		});
		return {
			output:
				"This provider uses native server-side web search. The WebSearch function tool is not available.",
			isError: true,
			durationMs: 0,
		};
	}

	if (!tool) {
		return {
			output: `Unknown tool: ${tu.name}`,
			isError: true,
			durationMs: 0,
		};
	}

	// Permission check
	const permissionStartedAt = Date.now();
	const permission =
		options.preGrantedPermission ??
		(await config.permissionHandler(tu.name, tu.input, tu.toolUseId));
	if (permission.behavior === "deny") {
		const userMessage =
			permission.rawMessage && permission.message
				? permission.message
				: permission.message
					? getToolMessageWithParams("permissionDeniedWithMessage", locale, {
							message: permission.message,
						})
					: getToolMessage("permissionDeniedByUser", locale);
		return {
			output: userMessage,
			isError: true,
			durationMs: 0,
			permissionStartedAt,
			completedAt: Date.now(),
			fatal: permission.fatal,
		};
	}
	if (permission.behavior === "dangerReflection") {
		return {
			output:
				"Internal permission error: tool executor received an unresolved dangerReflection result. " +
				"The tool was not executed.",
			isError: true,
			durationMs: 0,
			permissionStartedAt,
			completedAt: Date.now(),
			fatal: false,
		};
	}

	// PreToolUse hook check — fail-open: if the hook itself errors (timeout,
	// crash, network failure), we log a warning and let the tool execute.
	// Only an explicit "blocked" outcome prevents execution.
	if (config.hookHandler) {
		try {
			const hookResult = await config.hookHandler("PreToolUse", {
				tool_name: tu.name,
				tool_input: truncateToolInput(tu.input),
				tool_use_id: tu.toolUseId,
			});
			if (hookResult.outcome === "blocked") {
				return {
					output: hookResult.reason ?? "Blocked by hook",
					isError: true,
					durationMs: 0,
				};
			}
		} catch (err) {
			logger.warn("PreToolUse hook error (non-blocking)", {
				error: err instanceof Error ? err.message : String(err),
				toolName: tu.name,
			});
		}
	}

	// Start timing after permission is granted
	const start = Date.now();
	const executionStartedAt = start;

	const effectiveInput = permission.updatedInput ?? tu.input;
	const permissionNotice = permission.notice;
	// Track whether the permission handler redirected the input (e.g. plan-mode file path)
	const redirectedInput =
		permission.updatedInput && permission.updatedInput !== tu.input
			? permission.updatedInput
			: undefined;

	// Check if the tool input is malformed JSON (_raw field) — a sign of output truncation
	if ("_raw" in effectiveInput) {
		const rawLen = typeof effectiveInput._raw === "string" ? effectiveInput._raw.length : 0;
		return {
			output:
				`The tool call input was truncated — received malformed JSON (${rawLen} chars of raw input). ` +
				`The ${tu.name} was NOT executed to avoid corrupting files. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
				"then Edit to fill each marker with real content.",
			isError: true,
			durationMs: Date.now() - start,
			permissionStartedAt,
			executionStartedAt,
			completedAt: Date.now(),
			broken: true,
		};
	}

	// Detect empty input for file-writing tools — a sign of complete truncation
	// where the stream sent tool name/id but no input chunks at all.
	const FILE_TOOLS = new Set(["Write", "Edit"]);
	if (FILE_TOOLS.has(tu.name) && Object.keys(effectiveInput).length === 0) {
		return {
			output:
				`The ${tu.name} call received no input at all (complete truncation). ` +
				`The ${tu.name} was NOT executed. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use skeleton-first approach: Write a skeleton with SPLICE markers, " +
				"then Edit to fill each marker with real content.",
			isError: true,
			durationMs: Date.now() - start,
			permissionStartedAt,
			executionStartedAt,
			completedAt: Date.now(),
			broken: true,
		};
	}

	// Validate parameters
	const parsed = tool.parameters.safeParse(effectiveInput);
	if (!parsed.success) {
		return {
			output: `Invalid parameters: ${parsed.error.message}`,
			isError: true,
			durationMs: Date.now() - start,
			permissionStartedAt,
			executionStartedAt,
			completedAt: Date.now(),
		};
	}

	// Progress timer
	let progressTimer: ReturnType<typeof setInterval> | undefined;
	if (config.onEvent) {
		const onEvent = config.onEvent;
		let elapsed = 0;
		progressTimer = setInterval(() => {
			elapsed += PROGRESS_INTERVAL_MS / 1000;
			onEvent({ type: "tool_progress", toolUseId: tu.toolUseId, elapsed });
		}, PROGRESS_INTERVAL_MS);
	}

	const pipelineState = !isPipelineControlTool(tu.name)
		? await getPipelineState(config.narratorId)
		: null;
	const pipelinePreviewChars = pipelineState?.maxPreviewChars ?? 100;

	const ctx: ToolContext = {
		narratorId: config.narratorId,
		cwd: config.cwd,
		signal: config.signal,
		locale: config.locale ?? "en",
		chapterId: config.chapterId,
		planFileId: config.planFileId,
		skillRoot: config.skillRoot,
		parentNarratorId: config.parentNarratorId,
		requestPermission: config.permissionHandler,
		currentToolUseId: tu.toolUseId,
		reflectionLoop: config.reflectionLoop?.context,
	};

	// Wire up emitLongRunning: notify UI when a process exceeds 60s
	if (config.onEvent) {
		const onEvent = config.onEvent;
		ctx.emitLongRunning = (toolUseId: string, elapsed: number) => {
			onEvent({ type: "tool_long_running", toolUseId, elapsed });
		};
	}

	// Wire up emitOutput: throttled streaming of tool output to the UI
	let pendingOutputTimer: ReturnType<typeof setTimeout> | undefined;
	if (config.onEvent) {
		const onEvent = config.onEvent;
		let lastEmitTime = 0;
		let latestOutput = "";

		const flush = () => {
			lastEmitTime = Date.now();
			onEvent({ type: "tool_output", toolUseId: tu.toolUseId, output: latestOutput });
		};

		ctx.emitOutput = (output: string) => {
			if (pipelineState) {
				latestOutput = `Pipeline live output preview (${tu.name}):\n${clipText(output, pipelinePreviewChars)}`;
			} else {
				latestOutput =
					output.length > MAX_STREAM_OUTPUT_LENGTH
						? `...\n\n${output.slice(-MAX_STREAM_OUTPUT_LENGTH)}`
						: output;
			}

			const elapsed = Date.now() - lastEmitTime;
			if (elapsed >= OUTPUT_THROTTLE_MS) {
				if (pendingOutputTimer) {
					clearTimeout(pendingOutputTimer);
					pendingOutputTimer = undefined;
				}
				flush();
			} else if (!pendingOutputTimer) {
				pendingOutputTimer = setTimeout(() => {
					pendingOutputTimer = undefined;
					flush();
				}, OUTPUT_THROTTLE_MS - elapsed);
			}
		};
	}

	try {
		const result = await tool.execute(effectiveInput, ctx);
		// Append permission notice (e.g. plan-mode file redirect) to non-error output
		const appendNotice = permissionNotice && !result.isError ? `\n\n${permissionNotice}` : "";

		// PostToolUse hook (fire-and-forget, non-blocking)
		if (config.hookHandler) {
			config
				.hookHandler("PostToolUse", {
					tool_name: tu.name,
					tool_input: truncateToolInput(tu.input),
					tool_use_id: tu.toolUseId,
					tool_output: result.output.slice(0, 2000),
					tool_is_error: result.isError ?? false,
				})
				.catch((err) => {
					logger.warn("PostToolUse hook error", {
						error: err instanceof Error ? err.message : String(err),
						toolName: tu.name,
					});
				});
		}

		const finalOutput = result.output + appendNotice;
		if (pipelineState && !isPipelineControlTool(tu.name)) {
			const pipelineOutput = await getPipelineCaptureText(result, finalOutput, appendNotice);
			const captured = await capturePipelineOutput({
				narratorId: config.narratorId,
				toolUseId: tu.toolUseId,
				toolName: tu.name,
				input: effectiveInput,
				output: pipelineOutput,
				isError: result.isError,
				metadata: result.metadata,
			});
			if (captured) {
				return {
					output: captured.previewOutput,
					isError: result.isError,
					fatal: result.fatal,
					durationMs: Date.now() - start,
					permissionStartedAt,
					executionStartedAt,
					completedAt: Date.now(),
					metadata: {
						...result.metadata,
						pipelineAlias: captured.capture.alias,
						pipelineOutputPath: captured.capture.outputPath,
						pipelineCapturedBytes: captured.capture.bytes,
					},
					images: result.images,
					updatedInput: redirectedInput,
				};
			}
		}

		// If the tool already truncated its output, pass through as-is.
		if (result.truncated) {
			return {
				output: finalOutput,
				isError: result.isError,
				fatal: result.fatal,
				durationMs: Date.now() - start,
				permissionStartedAt,
				executionStartedAt,
				completedAt: Date.now(),
				metadata: result.metadata,
				images: result.images,
				updatedInput: redirectedInput,
			};
		}
		const truncated = truncateOutput(result.output);
		return {
			output: truncated.content + appendNotice,
			isError: result.isError,
			fatal: result.fatal,
			durationMs: Date.now() - start,
			permissionStartedAt,
			executionStartedAt,
			completedAt: Date.now(),
			metadata: result.metadata,
			images: result.images,
			updatedInput: redirectedInput,
		};
	} catch (err) {
		return {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			durationMs: Date.now() - start,
			permissionStartedAt,
			executionStartedAt,
			completedAt: Date.now(),
			updatedInput: redirectedInput,
		};
	} finally {
		if (progressTimer) clearInterval(progressTimer);
		if (pendingOutputTimer) {
			clearTimeout(pendingOutputTimer);
			pendingOutputTimer = undefined;
		}
	}
}

/**
 * Build a sanitized version of a broken tool call's input for DB persistence.
 * Keeps structural parameters (file_path, etc.) but replaces large content
 * fields with a short placeholder so the DB record is readable.
 */
export function sanitizeBrokenInput(
	toolName: string,
	input: Record<string, unknown>,
	locale: string,
): Record<string, unknown> {
	const placeholder = getToolMessage("brokenToolCallInputPlaceholder", (locale as Locale) ?? "en");
	const clean: Record<string, unknown> = {};
	const isEdit = toolName === "Edit";

	// If input is just { _raw: "..." }, extract file_path from the incomplete JSON
	if ("_raw" in input && Object.keys(input).length === 1) {
		const raw = input._raw as string;
		const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
		clean.file_path = filePathMatch ? filePathMatch[1] : "";
		// Use the correct field names so the frontend can render properly
		if (isEdit) {
			clean.old_string = placeholder;
			clean.new_string = placeholder;
		} else {
			clean.content = placeholder;
		}
	} else {
		// Normal case: copy non-content fields, replace content fields
		for (const [key, value] of Object.entries(input)) {
			if (key === "_raw") continue;
			if (key === "content" || key === "old_string" || key === "new_string") {
				clean[key] = placeholder;
			} else {
				clean[key] = value;
			}
		}
		// Ensure file_path is always present
		if (!("file_path" in clean)) {
			clean.file_path = "";
		}
		// Ensure content fields exist with correct names for the tool type
		if (isEdit) {
			if (!("old_string" in clean)) clean.old_string = placeholder;
			if (!("new_string" in clean)) clean.new_string = placeholder;
		} else if (!("content" in clean)) {
			clean.content = placeholder;
		}
	}

	return clean;
}
