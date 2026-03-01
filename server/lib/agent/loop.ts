import { getToolMessage, getToolMessageWithParams, type Locale } from "../prompt-i18n";
import { getModelContextWindow, settings } from "../settings";
import { StreamStaleError } from "../stream-timeout";
import { getProvider } from "./provider";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type { AgentConfig, AgentEvent, AgentToolUse, ContentBlock, ToolContext } from "./types";
import { PLAN_MODE_ALLOWED_TOOLS } from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

/** Max size of output pushed via tool_output events (UI preview only). */
const MAX_STREAM_OUTPUT_LENGTH = 30_000;

/** Patterns that indicate a transient API error worth retrying. */
const RETRYABLE_PATTERNS = [
	"MODEL_TEMPORARILY_UNAVAILABLE",
	"overloaded",
	"too many requests",
	"rate limit",
	"throttl",
	"service unavailable",
	"temporarily unavailable",
	"capacity",
	"try again",
];

/** HTTP status codes that indicate transient server-side issues. */
const RETRYABLE_STATUS_CODES = new Set([429, 503, 529]);

function isRetryableError(err: unknown): boolean {
	if (!err || typeof err !== "object") return false;
	// Stream stale timeout is always retryable
	if (err instanceof StreamStaleError) return true;
	// Check for known retryable reason/code fields
	const obj = err as Record<string, unknown>;
	if (
		obj.reason === "MODEL_TEMPORARILY_UNAVAILABLE" ||
	) {
		return true;
	}
	// Check HTTP status codes
	if (typeof obj.status === "number" && RETRYABLE_STATUS_CODES.has(obj.status)) return true;
	if (typeof obj.statusCode === "number" && RETRYABLE_STATUS_CODES.has(obj.statusCode)) return true;
	// Check error message patterns
	const msg = (obj.message ?? obj.error ?? "").toString().toLowerCase();
	return RETRYABLE_PATTERNS.some((p) => msg.includes(p));
}

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

	// Extra content to prepend to the next turn's user message (e.g. broken-tool reminder).
	// Consumed once and reset to empty after use.
	let nextTurnContent = "";

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

		const content = isFirstTurn ? userText : nextTurnContent;
		nextTurnContent = ""; // consume once

		// Call provider and collect the response
		let assistantText = "";
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		let credentialId: string | undefined;
		// Map of tool executions started during streaming (toolUseId → Promise)
		const earlyExecMap = new Map<string, Promise<ToolExecResult>>();
		// Synchronously queryable map of settled early-exec results (populated via .then())
		const settledResults = new Map<string, ToolExecResult>();
		// Track which tool_results have already been yielded during streaming
		const yieldedToolResults = new Set<string>();
		// Track tool calls whose input was broken (output cut off mid-stream)
		const brokenToolUseIds = new Set<string>();
		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<
			string,
			{
				name: string;
				inputChunks: string[];
				totalChars: number;
				startedAt: number;
				extractedFilePath?: string;
				lastYieldedAt: number;
			}
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
								lastYieldedAt: Date.now(),
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

								// For Write/Edit tools, try to extract file_path from first chunk
								if (!acc.extractedFilePath && (acc.name === "Write" || acc.name === "Edit")) {
									const raw = acc.inputChunks.join("");
									const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
									if (filePathMatch) {
										acc.extractedFilePath = filePathMatch[1];
									}
								}

								// Throttle: yield at most once per 50ms per tool to reduce WS pressure
								const now = Date.now();
								if (now - acc.lastYieldedAt >= 50) {
									acc.lastYieldedAt = now;

									// Calculate content chars (total minus file_path JSON overhead)
									let contentChars = acc.totalChars;
									if (acc.extractedFilePath) {
										// Rough estimate: subtract the file_path field size
										const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
										contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
									}

									yield {
										type: "tool_use_chunk",
										toolUseId: id,
										toolName: acc.name,
										inputCharsTotal: acc.totalChars,
										...(acc.extractedFilePath && {
											extractedFilePath: acc.extractedFilePath,
										}),
										...(acc.extractedFilePath && {
											contentCharsReceived: contentChars,
										}),
									};
								}
							}
							if (stop) {
								// Yield final chunk with latest totals before completing
								let contentChars = acc.totalChars;
								if (acc.extractedFilePath) {
									const filePathFieldSize = `"file_path":"${acc.extractedFilePath}",`.length;
									contentChars = Math.max(0, acc.totalChars - filePathFieldSize);
								}
								yield {
									type: "tool_use_chunk",
									toolUseId: id,
									toolName: acc.name,
									inputCharsTotal: acc.totalChars,
									...(acc.extractedFilePath && {
										extractedFilePath: acc.extractedFilePath,
									}),
									...(acc.extractedFilePath && {
										contentCharsReceived: contentChars,
									}),
								};

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
								// The .then() populates settledResults synchronously so the
								// streaming loop can drain completed results without awaiting.
								const execPromise = executeTool(tu, config).catch(
									(err): ToolExecResult => ({
										output: `Tool error: ${err instanceof Error ? err.message : String(err)}`,
										isError: true,
										durationMs: 0,
									}),
								);
								execPromise.then((r) => settledResults.set(id, r));
								earlyExecMap.set(id, execPromise);

								// Notify frontend the tool has started
								yield {
									type: "tool_call",
									toolUseId: id,
									toolName: tu.name,
									input: parsedInput,
									streamStartedAt: acc.startedAt,
								};

								// Drain any tool results that settled during streaming.
								// This lets fast tools (Read, Glob, etc.) report completion
								// before the model finishes outputting subsequent tool calls.
								for (const prevTu of toolUses) {
									const sr = settledResults.get(prevTu.toolUseId);
									if (!sr || yieldedToolResults.has(prevTu.toolUseId)) continue;
									yieldedToolResults.add(prevTu.toolUseId);
									if (sr.broken) brokenToolUseIds.add(prevTu.toolUseId);
									const brokenOverride = sr.broken
										? sanitizeBrokenInput(prevTu.name, prevTu.input, locale)
										: undefined;
									yield {
										type: "tool_result",
										toolUseId: prevTu.toolUseId,
										toolName: prevTu.name,
										output: sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output,
										isError: sr.isError ?? false,
										durationMs: sr.durationMs,
										brokenInputOverride: brokenOverride,
										updatedInput: brokenOverride,
									};
									if (sr.fatal) {
										yield { type: "error", message: sr.output };
										return;
									}
								}
							}
						}
					}
				}

				if (parsed.messageId) messageId = parsed.messageId;
				if (parsed.credentialId) credentialId = parsed.credentialId;
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
						credentialId,
					};
				}
				// Convert OpenAI usage to context_usage percentage
				if (parsed.usage) {
					const contextWindow = getModelContextWindow(config.model, config.provider);
					if (contextWindow) {
						const percentage = (parsed.usage.promptTokens / contextWindow) * 100;
						yield { type: "context_usage", percentage: Math.min(percentage, 100) };
					}
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
			if (
				err &&
				typeof err === "object" &&
				"code" in err &&
				(err as { code: string }).code === "CONTEXT_LENGTH_EXCEEDED"
			) {
				yield { type: "context_length_exceeded", message: msg };
				return;
			}
			// Detect transient/retryable API errors (e.g. MODEL_TEMPORARILY_UNAVAILABLE,
			// throttling, 429/529 overloaded)
			if (isRetryableError(err)) {
				yield { type: "retryable_error", message: msg };
				return;
			}
			yield { type: "error", message: msg };
			return;
		}

		// Detect orphaned tool uses — tool calls whose streaming input was cut off
		// before receiving a stop signal (typically due to API max_tokens truncation).
		// These are silently dropped by the accumulator, so we must detect and handle them.
		const hasOrphanedToolUses = toolUseAccum.size > 0;
		if (hasOrphanedToolUses) {
			const orphanedNames = [...toolUseAccum.values()].map((a) => a.name).join(", ");
			toolUseAccum.clear();

			// Yield text block if any was accumulated before the truncation
			if (assistantText) {
				yield { type: "block_complete", block: { type: "text", text: assistantText } };
			}

			// Drain settled tool results before assistant_message so the DB
			// has correct tool call statuses when the message is broadcast.
			for (const tu of toolUses) {
				const sr = settledResults.get(tu.toolUseId);
				if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
				const brokenOverride = sr.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output,
					isError: sr.isError ?? false,
					durationMs: sr.durationMs,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride,
				};
				if (sr.fatal) {
					yield { type: "error", message: sr.output };
					return;
				}
			}

			// Persist the assistant message (only the complete tool calls survive)
			yield {
				type: "assistant_message",
				text: assistantText,
				toolUses,
				messageId,
			};

			if (toolUses.length === 0) {
				// No complete tool calls at all — push the text-only assistant turn
				// and inject a reminder so the model retries with a different strategy.
				provider.pushAssistantTurn(history, assistantText, []);
				nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
					toolNames: orphanedNames,
				});
				yield { type: "turn_complete", turnIndex };
				turnIndex++;
				continue;
			}
			// Some complete tool calls exist alongside orphaned ones — fall through
			// to execute them. The orphaned ones are already gone from toolUses.
			// Set nextTurnContent so the model gets a reminder after execution.
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: orphanedNames,
			});
		}

		if (!hasOrphanedToolUses) {
			// Yield block_complete for the text portion (if any) now that streaming is done
			if (assistantText) {
				yield { type: "block_complete", block: { type: "text", text: assistantText } };
			}

			// Drain settled tool results before assistant_message so the DB
			// has correct tool call statuses when the message is broadcast.
			for (const tu of toolUses) {
				const sr = settledResults.get(tu.toolUseId);
				if (!sr || yieldedToolResults.has(tu.toolUseId)) continue;
				yieldedToolResults.add(tu.toolUseId);
				if (sr.broken) brokenToolUseIds.add(tu.toolUseId);
				const brokenOverride = sr.broken
					? sanitizeBrokenInput(tu.name, tu.input, locale)
					: undefined;
				yield {
					type: "tool_result",
					toolUseId: tu.toolUseId,
					toolName: tu.name,
					output: sr.broken ? getToolMessage("brokenToolCallResult", locale) : sr.output,
					isError: sr.isError ?? false,
					durationMs: sr.durationMs,
					brokenInputOverride: brokenOverride,
					updatedInput: brokenOverride,
				};
				if (sr.fatal) {
					yield { type: "error", message: sr.output };
					return;
				}
			}

			// Yield the complete assistant message
			yield {
				type: "assistant_message",
				text: assistantText,
				toolUses,
				messageId,
			};
		}

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
				const result = earlyPromise ? await earlyPromise : await executeTool(tu, config);
				if (result.broken) brokenToolUseIds.add(tu.toolUseId);
				const isLastTool = toolIndex === toolUses.length - 1;
				const outputForModel =
					isLastTool && shouldNudge ? result.output + nudgeText : result.output;

				pendingToolResults.push(
					provider.formatToolResult(tu.toolUseId, outputForModel, result.isError ?? false),
				);

				if (yieldedToolResults.has(tu.toolUseId)) {
					// Already yielded during streaming — just accumulate timing
					prevToolsExecMs += result.durationMs;
					toolIndex++;
					if (result.fatal) {
						// Fatal was already yielded in the drain loop
						return;
					}
				} else {
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

					// For tools with streamStartedAt, compute display duration as
					// total elapsed minus time spent executing preceding tools.
					let durationMs = result.durationMs;
					if (tu.streamStartedAt != null) {
						const totalElapsed = Date.now() - tu.streamStartedAt;
						const adjusted = totalElapsed - prevToolsExecMs;
						durationMs = Math.max(adjusted, result.durationMs);
					}
					prevToolsExecMs += result.durationMs;

					// For broken tool calls, sanitize the persisted input and output
					// so the DB shows a clean message instead of truncated garbage.
					const brokenInputOverride = result.broken
						? sanitizeBrokenInput(tu.name, tu.input, locale)
						: undefined;
					const displayOutput = result.broken
						? getToolMessage("brokenToolCallResult", locale)
						: result.output;

					yield {
						type: "tool_result",
						toolUseId: tu.toolUseId,
						toolName: tu.name,
						output: displayOutput,
						isError: result.isError ?? false,
						durationMs,
						brokenInputOverride,
						updatedInput: brokenInputOverride,
					};
					toolIndex++;

					if (result.fatal) {
						yield { type: "error", message: result.output };
						return;
					}
				}
			} else {
				// Parallel execution (multiple Task calls)
				for (const tu of group) {
					if (!earlyExecMap.has(tu.toolUseId) && !yieldedToolResults.has(tu.toolUseId)) {
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
					if (result.broken) brokenToolUseIds.add(tu.toolUseId);
					const isLastTool = toolIndex === toolUses.length - 1;
					const outputForModel =
						isLastTool && shouldNudge ? result.output + nudgeText : result.output;

					pendingToolResults.push(
						provider.formatToolResult(tu.toolUseId, outputForModel, result.isError ?? false),
					);

					if (!yieldedToolResults.has(tu.toolUseId)) {
						const brokenInputOverride = result.broken
							? sanitizeBrokenInput(tu.name, tu.input, locale)
							: undefined;
						const displayOutput = result.broken
							? getToolMessage("brokenToolCallResult", locale)
							: result.output;

						yield {
							type: "tool_result",
							toolUseId: tu.toolUseId,
							toolName: tu.name,
							output: displayOutput,
							isError: result.isError ?? false,
							durationMs: result.durationMs,
							brokenInputOverride,
							updatedInput: brokenInputOverride,
						};
					}
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

		// Strip broken tool calls from the history sent to the model.
		// The UI already has the full picture (tool_result events were yielded above),
		// but the model should not see the broken tool_use + tool_result pair —
		// they waste context and cause retry loops.
		if (brokenToolUseIds.size > 0) {
			const cleanToolUses = toolUses.filter((tu) => !brokenToolUseIds.has(tu.toolUseId));
			pendingToolResults = pendingToolResults.filter(
				(tr) => !brokenToolUseIds.has((tr as { toolUseId: string }).toolUseId),
			);
			provider.pushAssistantTurn(history, assistantText, cleanToolUses);

			// Inject a user-side reminder so the model knows what happened and
			// switches strategy instead of blindly retrying the same large write.
			const brokenNames = toolUses
				.filter((tu) => brokenToolUseIds.has(tu.toolUseId))
				.map((tu) => tu.name);
			nextTurnContent = getToolMessageWithParams("brokenToolCallReminder", locale, {
				toolNames: brokenNames.join(", "),
			});
		} else {
			// Append assistant message to history for next turn
			provider.pushAssistantTurn(history, assistantText, toolUses);
		}

		// Allow external code (e.g. onExitPlanMode) to inject text into the next
		// user turn. This text rides alongside the pending tool results so the
		// model sees both the tool output and the injected message in one request.
		if (config.getInjectedUserText) {
			const injected = config.getInjectedUserText();
			if (injected) {
				nextTurnContent = nextTurnContent ? `${nextTurnContent}\n\n${injected}` : injected;
			}
		}

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
	/** Set when the tool call was rejected because the model's output was
	 *  cut off mid-stream (malformed JSON, suspiciously large content, etc.).
	 *  The loop will strip this tool_use + tool_result from the history sent
	 *  to the model and inject a user-side reminder instead. */
	broken?: boolean;
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

	// Check if the tool input is malformed JSON (_raw field) — a sign of output truncation
	if ("_raw" in effectiveInput) {
		const rawLen = typeof effectiveInput._raw === "string" ? effectiveInput._raw.length : 0;
		return {
			output:
				`The tool call input was truncated — received malformed JSON (${rawLen} chars of raw input). ` +
				`The ${tu.name} was NOT executed to avoid corrupting files. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use Write for the first section (end with APPEND marker comment), " +
				"then Edit with old_string targeting the APPEND marker to continue.",
			isError: true,
			durationMs: Date.now() - start,
			broken: true,
		};
	}

	// Detect empty input for file-writing tools — a sign of complete truncation
	// where the stream sent tool name/id but no input chunks at all.
	const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit"]);
	if (FILE_TOOLS.has(tu.name) && Object.keys(effectiveInput).length === 0) {
		return {
			output:
				`The ${tu.name} call received no input at all (complete truncation). ` +
				`The ${tu.name} was NOT executed. ` +
				"Each tool call's total input must be under 10,000 characters. " +
				"Use Write for the first section (end with APPEND marker comment), " +
				"then Edit with old_string targeting the APPEND marker to continue.",
			isError: true,
			durationMs: Date.now() - start,
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
		planFileId: config.planFileId,
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

/**
 * Build a sanitized version of a broken tool call's input for DB persistence.
 * Keeps structural parameters (file_path, etc.) but replaces large content
 * fields with a short placeholder so the DB record is readable.
 */
function sanitizeBrokenInput(
	toolName: string,
	input: Record<string, unknown>,
	locale: string,
): Record<string, unknown> {
	const placeholder = getToolMessage("brokenToolCallInputPlaceholder", (locale as Locale) ?? "en");
	const clean: Record<string, unknown> = {};
	const isEdit = toolName === "Edit" || toolName === "MultiEdit";

	// If input is just { _raw: "..." }, extract file_path and note the raw length
	if ("_raw" in input && Object.keys(input).length === 1) {
		const raw = input._raw as string;
		const charsNote = `${placeholder} (${raw.length} chars received)`;
		// Try to extract file_path from the incomplete JSON
		const filePathMatch = raw.match(/"file_path"\s*:\s*"([^"]+)"/);
		clean.file_path = filePathMatch ? filePathMatch[1] : "";
		// Use the correct field names so the frontend can render properly
		if (isEdit) {
			clean.old_string = charsNote;
			clean.new_string = charsNote;
		} else {
			clean.content = charsNote;
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
