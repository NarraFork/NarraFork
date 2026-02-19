import { resolveModel } from "./resolve-model";
import { toolRegistry } from "./tool-registry";
import { truncateOutput } from "./truncate";
import type { AgentConfig, AgentEvent, AgentToolUse, ToolContext } from "./types";

const DEFAULT_MAX_TURNS = 50;
const PROGRESS_INTERVAL_MS = 5_000;

/**
 * Yields AgentEvent objects for the caller to consume.
 */
export async function* agentLoop(
	config: AgentConfig,
	userText: string,
): AsyncGenerator<AgentEvent> {

	const maxTurns = config.maxTurns ?? DEFAULT_MAX_TURNS;
	let turnIndex = 0;

	// Shallow-copy to avoid mutating the caller's array
	history = [...history];

	if (config.systemPrompt) {
		const modelId = resolveModel(config.model);
		history.unshift(
			{
					content: config.systemPrompt,
					modelId,
				},
			},
			{
					content: "I will follow these instructions.",
				},
			},
		);
	}

	while (turnIndex < maxTurns) {
		if (config.signal.aborted) {
			yield { type: "error", message: "Aborted" };
			return;
		}

		// Build the request for this turn
		const isFirstTurn = turnIndex === 0;
		const content = isFirstTurn ? userText : ".";
		const request = buildRequest(config, content, history, tools, pendingToolResults);

		let assistantText = "";
		const toolUses: AgentToolUse[] = [];
		let messageId: string | undefined;

		// Accumulator for streaming tool use events (input arrives in chunks)
		const toolUseAccum = new Map<string, { name: string; inputChunks: string[] }>();

		try {
				const parsed = parseStreamEvent(evt);
				if (parsed.text) {
					assistantText += parsed.text;
					yield { type: "stream_text", text: parsed.text };
				}
				if (parsed.toolUses) toolUses.push(...parsed.toolUses);

					const id = evt.data.toolUseId as string | undefined;
					const name = evt.data.name as string | undefined;
					if (id) {
						if (!toolUseAccum.has(id) && name) {
							toolUseAccum.set(id, { name, inputChunks: [] });
						}
						const acc = toolUseAccum.get(id);
						if (acc) {
							if (typeof evt.data.input === "string") {
								acc.inputChunks.push(evt.data.input);
							}
							if (evt.data.stop) {
								const raw = acc.inputChunks.join("");
								let input: Record<string, unknown> = {};
								if (raw) {
									try {
										input = JSON.parse(raw);
									} catch {
										input = { _raw: raw };
									}
								}
								toolUses.push({ toolUseId: id, name: acc.name, input });
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
				if (parsed.invalidState) {
					yield {
						type: "invalid_state",
						reason: parsed.invalidState.reason,
						message: parsed.invalidState.message,
					};
				}
			}
		} catch (err) {
			// Abort signal → clean exit, not an error
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

		// Push the currentMessage into history for the next turn.
		// This must happen AFTER the API call (not before), because
		// buildRequest references the history array directly.
		if (isFirstTurn) {
			history.push({
					content: userText,
					modelId: resolveModel(config.model),
				},
			});
		} else if (pendingToolResults.length > 0) {
			history.push({
					content: ".",
					modelId: resolveModel(config.model),
				},
			});
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

			pendingToolResults.push({
				toolUseId: tu.toolUseId,
				content: [{ text: result.output }],
				status: result.isError ? "error" : "success",
				isError: result.isError,
			});

			yield {
				type: "tool_result",
				toolUseId: tu.toolUseId,
				toolName: tu.name,
				output: result.output,
				isError: result.isError ?? false,
				durationMs: result.durationMs,
			};
		}

		// Append assistant message to history for next turn.
		// Tool results stay in pendingToolResults and are sent via
		// (history ends with assistant; currentMessage is the next user turn)
		const historyToolUses =
			toolUses.length > 0
				? toolUses.map((tu) => ({
						toolUseId: tu.toolUseId,
						name: tu.name,
						input: tu.input,
					}))
				: undefined;

		history.push({
				content: assistantText || ".",
				...(historyToolUses ? { toolUses: historyToolUses } : {}),
			},
		});

		yield { type: "turn_complete", turnIndex };
		turnIndex++;
	}

	yield { type: "error", message: `Max turns (${maxTurns}) exceeded` };
}

// === Internal helpers ===

function buildRequest(
	config: AgentConfig,
	content: string,
	return {
			conversationId: config.conversationId,
			history: history.length > 0 ? history : undefined,
			currentMessage: {
					content,
					modelId: resolveModel(config.model),
						tools,
						...(toolResults.length > 0 ? { toolResults } : {}),
					},
				},
			},
			envState: {
				operatingSystem:
					process.platform === "win32"
						? "WINDOWS"
						: process.platform === "darwin"
							? "MAC"
							: "LINUX",
				currentWorkingDirectory: config.cwd,
			},
			shellState: {
				shellName: process.env.SHELL?.split("/").pop() ?? "bash",
			},
		},
	};
}

interface ParsedEvent {
	text?: string;
	toolUses?: AgentToolUse[];
	messageId?: string;
	reasoning?: string;
	contextUsagePercentage?: number;
	invalidState?: { reason: string; message: string };
}

function parseStreamEvent(evt: StreamEvent): ParsedEvent {
	const result: ParsedEvent = {};

		if (evt.data.content != null) {
			result.text = String(evt.data.content);
		}
		if (evt.data.messageId) {
			result.messageId = String(evt.data.messageId);
		}
	}

		const toolUse = evt.data.toolUse as
			| { toolUseId: string; name: string; input: Record<string, unknown> }
			| undefined;
		if (toolUse?.toolUseId) {
			result.toolUses = [
				{
					toolUseId: toolUse.toolUseId,
					name: toolUse.name,
					input: toolUse.input ?? {},
				},
			];
		}

		// Array of tool uses
		const toolUses = evt.data.toolUses as
			| Array<{ toolUseId: string; name: string; input: Record<string, unknown> }>
			| undefined;
		if (Array.isArray(toolUses) && toolUses.length > 0) {
			result.toolUses = toolUses.map((tu) => ({
				toolUseId: tu.toolUseId,
				name: tu.name,
				input: tu.input ?? {},
			}));
		}
	}

	if (evt.eventType === "reasoningContentEvent") {
		const content = evt.data.content ?? evt.data.text;
		if (content != null) {
			result.reasoning = String(content);
		}
	}

	if (evt.eventType === "contextUsageEvent") {
		const pct = evt.data.contextUsagePercentage ?? evt.data.context_usage_percentage;
		if (pct != null) {
			result.contextUsagePercentage = Number(pct);
		}
	}

		result.invalidState = {
			reason: String(evt.data.reason ?? "unknown"),
			message: String(evt.data.message ?? evt.data.content ?? "Invalid state"),
		};
	}

	return result;
}

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
		return {
			output: permission.message ?? "Permission denied",
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
