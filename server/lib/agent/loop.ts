import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { settings } from "../settings";
import { getProvider } from "./provider";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type { AgentConfig, AgentEvent, AgentToolUse, ContentBlock, ToolContext } from "./types";
import { PLAN_MODE_ALLOWED_TOOLS } from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

/** Max size of output pushed via tool_output events (UI preview only). */
const MAX_STREAM_OUTPUT_LENGTH = 30_000;

/** Minimum interval between tool_output events (ms). */
const OUTPUT_THROTTLE_MS = 100;

/** Tools that can safely run in parallel when multiple appear in the same turn. */
const PARALLEL_TOOLS = new Set(["Task"]);

/**
 * Core agent loop. Delegates all provider-specific logic to a ProviderAdapter.
 * Yields AgentEvent objects for the caller to consume.
 */
export async function* agentLoop(
	config: AgentConfig,
	userText: string,
	history: unknown[],
	initialToolResults?: unknown[],
	images?: Array<{ format: string; base64: string }>,
): AsyncGenerator<AgentEvent> {
	const provider = getProvider(config.provider);
	const maxTurns = config.maxTurns ?? settings.agent.maxTurns;
	const locale = (config.locale as Locale) ?? "en";
	let allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());

	// Apply toolFilter if provided (used by subagents to restrict available tools)
	if (config.toolFilter) {
		allTools = allTools.filter(config.toolFilter);
	}

	// In plan mode, override descriptions for forbidden tools so the model knows not to call them.
	if (config.planMode) {
		const disabledDesc = getToolMessage("planModeToolDisabled", locale);
		allTools = allTools.map((t) =>
			PLAN_MODE_ALLOWED_TOOLS.has(t.name)
				? t
				: {
						...t,
						description: disabledDesc,
					},
		);
	}

	const tools = provider.formatTools(allTools);
	let pendingToolResults: unknown[] = initialToolResults ?? [];
	let turnIndex = 0;

	// Shallow-copy to avoid mutating the caller's array
	history = [...history];

	// Inject system prompt via provider-specific mechanism
	if (config.systemPrompt) {
		provider.injectSystemPrompt(history, config.systemPrompt, config.model, config.locale);
	}

	while (turnIndex < maxTurns) {
		if (config.signal.aborted) {
			yield { type: "error", message: "Aborted" };
			return;
		}

		const isFirstTurn = turnIndex === 0;

		// Allow caller to rebuild history mid-loop (e.g. after prune boundary changes)
		if (!isFirstTurn && config.onBeforeTurn) {
			const replacement = await config.onBeforeTurn(turnIndex);
			if (replacement) {
				history = replacement.history;
				if (config.systemPrompt) {
					provider.injectSystemPrompt(history, config.systemPrompt, config.model, config.locale);
				}
				pendingToolResults = replacement.pendingToolResults;
			}
		}

		const content = isFirstTurn ? userText : "";

		// Call provider and collect the response
		let assistantText = "";
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		// Map of tool executions started during streaming (toolUseId → Promise)
		const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<
			string,
			{ name: string; inputChunks: string[]; totalChars: number; startedAt: number }
		>();

		try {
			const stream = provider.chat({
				conversationId: config.conversationId,
				content,
				model: config.model,
				cwd: config.cwd,
				history,
				tools,
				toolResults: pendingToolResults,
				signal: config.signal,
				...(isFirstTurn && images?.length ? { images } : {}),
			});

			for await (const parsed of stream) {
				if (parsed.text) {
					assistantText += parsed.text;
					yield { type: "stream_text", text: parsed.text };
				}
				if (parsed.toolUses) toolUses.push(...parsed.toolUses);

				// Handle streaming tool use chunks
				if (parsed.toolUseChunk) {
					const { toolUseId: id, name, input, stop } = parsed.toolUseChunk;
					if (id) {
						if (!toolUseAccum.has(id) && name) {
							toolUseAccum.set(id, {
								name,
								inputChunks: [],
								totalChars: 0,
								startedAt: Date.now(),
							});
							// Yield immediately so the frontend knows the tool name early
							yield {
								type: "tool_use_chunk",
								toolUseId: id,
								toolName: name,
								inputCharsTotal: 0,
							};
						}
						const acc = toolUseAccum.get(id);
						if (acc) {
							if (typeof input === "string") {
								acc.inputChunks.push(input);
								acc.totalChars += input.length;
								yield {
									type: "tool_use_chunk",
									toolUseId: id,
									toolName: acc.name,
									inputCharsTotal: acc.totalChars,
								};
							}
							if (stop) {
								const raw = acc.inputChunks.join("");
								let parsedInput: Record<string, unknown> = {};
								if (raw) {
									try {
										parsedInput = JSON.parse(raw);
									} catch {
										parsedInput = { _raw: raw };
									}
								}
								const tu: AgentToolUse = {
									toolUseId: id,
									name: acc.name,
									input: parsedInput,
									streamStartedAt: acc.startedAt,
								};
								toolUses.push(tu);
								toolUseAccum.delete(id);

								// Block is complete — yield for immediate persistence
								yield {
									type: "block_complete",
									block: {
										type: "tool_use",
										toolUseId: id,
										name: tu.name,
										input: parsedInput,
										streamStartedAt: acc.startedAt,
									} satisfies ContentBlock,
								};

								// Start tool execution eagerly (don't await — collect later).
								// Wrap with .catch() so a rejected permissionHandler doesn't
								// create an unhandled rejection; the error surfaces as isError.
								earlyExecMap.set(
									id,
									executeTool(tu, config).catch(
										(err): ToolExecResult => ({
											output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
											isError: true,
											durationMs: 0,
										}),
									),
								);

								// Notify frontend the tool has started
								yield {
									type: "tool_call",
									toolUseId: id,
									toolName: tu.name,
									input: parsedInput,
									streamStartedAt: acc.startedAt,
								};
							}
						}
					}
				}

				if (parsed.messageId) messageId = parsed.messageId;
				if (parsed.reasoning) {
					yield { type: "stream_reasoning", text: parsed.reasoning };
				}
				if (parsed.contextUsagePercentage != null) {
					yield { type: "context_usage", percentage: parsed.contextUsagePercentage };
				}
				if (parsed.metering) {
					yield {
						type: "metering",
						unit: parsed.metering.unit,
						unitPlural: parsed.metering.unitPlural,
						usage: parsed.metering.usage,
					};
				}
				if (parsed.invalidState) {
					yield {
						type: "invalid_state",
						reason: parsed.invalidState.reason,
						message: parsed.invalidState.message,
					};
				}
			}
		} catch (err) {
			// Even on error, yield block_complete for accumulated text so it can be persisted
			if (assistantText) {
				yield { type: "block_complete", block: { type: "text", text: assistantText } };
			}
			if (config.signal.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			yield { type: "error", message: msg };
			return;
		}

		// Yield block_complete for the text portion (if any) now that streaming is done
		if (assistantText) {
			yield { type: "block_complete", block: { type: "text", text: assistantText } };
		}

		// Yield the complete assistant message
		yield {
			type: "assistant_message",
			text: assistantText,
			toolUses,
			messageId,
		};

		// No tool calls → we're done
		if (toolUses.length === 0) {
			yield { type: "done" };
			return;
		}

		// Push the current user turn into history for the next turn.
		// This must happen AFTER the API call (not before), because
		// chat() references the history array directly.
		if (isFirstTurn) {
			provider.pushUserTurn(history, userText, config.model, initialToolResults ?? []);
		} else if (pendingToolResults.length > 0) {
			provider.pushUserTurn(history, "", config.model, pendingToolResults);
		}

		// Execute each tool call
		pendingToolResults = [];
		// Nudge threshold: append a wrap-up reminder when ≥80% of maxTurns used
		const nudgeThreshold = Math.floor(maxTurns * 0.8);
		const shouldNudge = turnIndex >= nudgeThreshold;
		const nudgeText = shouldNudge
			? getToolMessageWithParams("turnNudge", locale, {
					turnIndex: turnIndex + 1,
					maxTurns,
				})
			: "";

		// Group tool calls into runs: consecutive Task calls form a parallel batch,
		// everything else executes serially (one tool per group).
		const groups: AgentToolUse[][] = [];
		for (const tu of toolUses) {
			const isParallel = PARALLEL_TOOLS.has(tu.name);
			const lastGroup = groups[groups.length - 1];
			if (isParallel && lastGroup && PARALLEL_TOOLS.has(lastGroup[0].name)) {
				lastGroup.push(tu);
			} else {
				groups.push([tu]);
			}
		}

		let toolIndex = 0;
		// Tracks cumulative execution time of preceding serial tools in this turn,
		// used to subtract wait time when computing display duration for fast tools.
		let prevToolsExecMs = 0;
		for (const group of groups) {
			if (config.signal.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}

			if (group.length === 1) {
				// Serial execution (single tool)
				const tu = group[0];
				const earlyPromise = earlyExecMap.get(tu.toolUseId);

				// Only yield tool_call if not already yielded during streaming
				if (!earlyPromise) {
					yield {
						type: "tool_call",
						toolUseId: tu.toolUseId,
						toolName: tu.name,
						input: tu.input,
						streamStartedAt: tu.streamStartedAt,
					};
				}

				const result = earlyPromise ? await earlyPromise : await executeTool(tu, config);
				const isLastTool = toolIndex === toolUses.length - 1;
				const outputForModel =
					isLastTool && shouldNudge ? result.output + nudgeText : result.output;

				pendingToolResults.push(
					provider.formatToolResult(tu.toolUseId, outputForModel, result.isError ?? false),
				);
				// For tools with streamStartedAt, compute display duration as
				// total elapsed minus time spent executing preceding tools.
				let durationMs = result.durationMs;
				if (tu.streamStartedAt != null) {
					const totalElapsed = Date.now() - tu.streamStartedAt;
					const adjusted = totalElapsed - prevToolsExecMs;
					durationMs = Math.max(adjusted, result.durationMs);
				}
				prevToolsExecMs += result.durationMs;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: result.output,
					isError: result.isError ?? false,
					durationMs,
				};
				toolIndex++;

				if (result.fatal) {
					yield { type: "error", message: result.output };
					return;
				}
			} else {
				// Parallel execution (multiple Task calls)
				for (const tu of group) {
					if (!earlyExecMap.has(tu.toolUseId)) {
						yield {
							type: "tool_call",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							input: tu.input,
							streamStartedAt: tu.streamStartedAt,
						};
					}
				}

				const results = await Promise.all(
					group.map((tu) => earlyExecMap.get(tu.toolUseId) ?? executeTool(tu, config)),
				);
				let hasFatal = false;
				let maxParallelMs = 0;

				for (let j = 0; j < group.length; j++) {
					const tu = group[j];
					const result = results[j];
					const isLastTool = toolIndex === toolUses.length - 1;
					const outputForModel =
						isLastTool && shouldNudge ? result.output + nudgeText : result.output;

					pendingToolResults.push(
						provider.formatToolResult(tu.toolUseId, outputForModel, result.isError ?? false),
					);
					yield {
						type: "tool_result",
						toolUseId: tu.toolUseId,
						toolName: tu.name,
						output: result.output,
						isError: result.isError ?? false,
						durationMs: result.durationMs,
					};
					toolIndex++;
					if (result.durationMs > maxParallelMs) maxParallelMs = result.durationMs;

					if (result.fatal) hasFatal = true;
				}
				prevToolsExecMs += maxParallelMs;

				if (hasFatal) {
					const fatalMsg = results.find((r) => r.fatal)?.output ?? "Fatal tool error";
					yield { type: "error", message: fatalMsg };
					return;
				}
			}
		}

		// Append assistant message to history for next turn
		provider.pushAssistantTurn(history, assistantText, toolUses);

		yield { type: "turn_complete", turnIndex };
		turnIndex++;
	}

	yield { type: "error", message: `Max turns (${maxTurns}) exceeded` };
}

// === Internal helpers ===

interface ToolExecResult {
	output: string;
	isError?: boolean;
	durationMs: number;
	fatal?: boolean;
}

async function executeTool(tu: AgentToolUse, config: AgentConfig): Promise<ToolExecResult> {
	const tool = toolRegistry.get(tu.name);
	const locale = (config.locale as Locale) ?? "en";

	if (!tool) {
		return {
			output: `Unknown tool: ${tu.name}`,
			isError: true,
			durationMs: 0,
		};
	}

	// Permission check
	const permission = await config.permissionHandler(tu.name, tu.input, tu.toolUseId);
	if (permission.behavior === "deny") {
		const userMessage = permission.message
			? getToolMessageWithParams("permissionDeniedWithMessage", locale, {
					message: permission.message,
				})
			: getToolMessage("permissionDeniedByUser", locale);
		return {
			output: userMessage,
			isError: true,
			durationMs: 0,
			fatal: permission.fatal,
		};
	}

	// Start timing after permission is granted
	const start = Date.now();

	const effectiveInput = permission.updatedInput ?? tu.input;

	// Validate parameters
	const parsed = tool.parameters.safeParse(effectiveInput);
	if (!parsed.success) {
		return {
			output: `Invalid parameters: ${parsed.error.message}`,
			isError: true,
			durationMs: Date.now() - start,
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

	const ctx: ToolContext = {
		narratorId: config.narratorId,
		cwd: config.cwd,
		signal: config.signal,
		locale: config.locale ?? "en",
		requestPermission: config.permissionHandler,
		currentToolUseId: tu.toolUseId,
	};

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
			latestOutput =
				output.length > MAX_STREAM_OUTPUT_LENGTH
					? `${output.slice(0, MAX_STREAM_OUTPUT_LENGTH)}\n\n...`
					: output;

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
		// If the tool already truncated its output, pass through as-is.
		if (result.truncated) {
			return {
				output: result.output,
				isError: result.isError,
				fatal: result.fatal,
				durationMs: Date.now() - start,
			};
		}
		const truncated = truncateOutput(result.output);
		return {
			output: truncated.content,
			isError: result.isError,
			fatal: result.fatal,
			durationMs: Date.now() - start,
		};
	} catch (err) {
		return {
			output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
			isError: true,
			durationMs: Date.now() - start,
		};
	} finally {
		if (progressTimer) clearInterval(progressTimer);
		if (pendingOutputTimer) clearTimeout(pendingOutputTimer);
	}
}
