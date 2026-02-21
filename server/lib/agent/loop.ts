import { settings } from "../settings";
import { getProvider } from "./provider";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type { AgentConfig, AgentEvent, AgentToolUse, ToolContext } from "./types";

const PROGRESS_INTERVAL_MS = 5_000;

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
	const allTools = toolRegistry.all().filter((t) => !t.isAvailable || t.isAvailable());
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
		const content = isFirstTurn ? userText : "";

		// Call provider and collect the response
		let assistantText = "";
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;
		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<string, { name: string; inputChunks: string[] }>();

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
							toolUseAccum.set(id, { name, inputChunks: [] });
						}
						const acc = toolUseAccum.get(id);
						if (acc) {
							if (typeof input === "string") {
								acc.inputChunks.push(input);
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
								toolUses.push({ toolUseId: id, name: acc.name, input: parsedInput });
								toolUseAccum.delete(id);
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
			if (config.signal.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}
			const msg = err instanceof Error ? err.message : String(err);
			yield { type: "error", message: msg };
			return;
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
		for (const tu of toolUses) {
			if (config.signal.aborted) {
				yield { type: "error", message: "Aborted" };
				return;
			}

			yield {
				type: "tool_call",
				toolUseId: tu.toolUseId,
				toolName: tu.name,
				input: tu.input,
			};

			const result = await executeTool(tu, config);

			pendingToolResults.push(
				provider.formatToolResult(tu.toolUseId, result.output, result.isError ?? false),
			);

			yield {
				type: "tool_result",
				toolUseId: tu.toolUseId,
				toolName: tu.name,
				output: result.output,
				isError: result.isError ?? false,
				durationMs: result.durationMs,
			};
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
}

async function executeTool(tu: AgentToolUse, config: AgentConfig): Promise<ToolExecResult> {
	const tool = toolRegistry.get(tu.name);
	const start = Date.now();

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
			? `The user rejected this tool call with the following message: ${permission.message}`
			: "The user rejected this tool call.";
		return {
			output: userMessage,
			isError: true,
			durationMs: Date.now() - start,
		};
	}

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
		requestPermission: config.permissionHandler,
	};

	try {
		const result = await tool.execute(effectiveInput, ctx);
		return {
			output: truncateOutput(result.output),
			isError: result.isError,
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
	}
}
