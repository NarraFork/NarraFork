import { randomUUID } from "node:crypto";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { zodToJsonSchema } from "./tool-registry";
import type { AgentToolUse, ToolDefinition } from "./types";

// === OpenAI message types ===

interface OAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
}

interface OAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OAITool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

// === SSE delta types ===

interface OAIDelta {
	role?: string;
	content?: string | null;
	tool_calls?: Array<{
		index: number;
		id?: string;
		type?: string;
		function?: { name?: string; arguments?: string };
	}>;
}

interface OAIStreamChunk {
	id?: string;
	choices?: Array<{ index: number; delta: OAIDelta; finish_reason?: string | null }>;
	usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

/**
 * OpenAI-compatible API provider.
 * Works with any API that follows the OpenAI chat completions spec
 * (OpenAI, Azure OpenAI, DeepSeek, Groq, Together, local vLLM/Ollama, etc.)
 */
export class OpenAIProvider implements ProviderAdapter {
	formatTools(tools: ToolDefinition[]): unknown[] {
		return tools.map(
			(tool): OAITool => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: zodToJsonSchema(tool.parameters),
				},
			}),
		);
	}

	buildHistory(
		dbMessages: DbMessage[],
		_model: string,
	): { history: unknown[]; trailingToolResults: unknown[] } {
		return buildOAIHistory(dbMessages);
	}

	injectSystemPrompt(history: unknown[], systemPrompt: string, _model: string): void {
		const h = history as OAIMessage[];
		h.unshift({ role: "system", content: systemPrompt });
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const { settings } = await import("../settings");
		const apiKey = settings.openai?.apiKey;
		const baseUrl = (settings.openai?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error("OpenAI API key not configured. Set openai.apiKey in settings.");
		}

		const history = params.history as OAIMessage[];
		const tools = params.tools as OAITool[];

		// Build messages: history + pending tool results + current user message
		const messages: OAIMessage[] = [...history];

		// Append tool results as role: "tool" messages
		for (const tr of params.toolResults as OAIToolResult[]) {
			messages.push({
				role: "tool",
				tool_call_id: tr.tool_call_id,
				content: tr.content,
			});
		}

		// Append current user message (skip "." continuation markers)
		if (params.content && params.content !== ".") {
			messages.push({ role: "user", content: params.content });
		} else if (params.toolResults.length === 0) {
			// First turn or explicit user message
			messages.push({ role: "user", content: params.content });
		}

		const body: Record<string, unknown> = {
			model: params.model,
			messages,
			stream: true,
		};
		if (tools.length > 0) {
			body.tools = tools;
		}

		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify(body),
			signal: params.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		yield* parseSSEStream(response.body);
	}

	formatToolResult(toolUseId: string, output: string, _isError: boolean): unknown {
		return { tool_call_id: toolUseId, content: output } satisfies OAIToolResult;
	}

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
		const h = history as OAIMessage[];
		// Tool results go as separate role: "tool" messages
		for (const tr of toolResults as OAIToolResult[]) {
			h.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
		}
		if (content && content !== ".") {
			h.push({ role: "user", content });
		}
	}

	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void {
		const h = history as OAIMessage[];
		const msg: OAIMessage = { role: "assistant" };
		if (text) msg.content = text;
		if (toolUses.length > 0) {
			msg.tool_calls = toolUses.map((tu) => ({
				id: tu.toolUseId,
				type: "function" as const,
				function: { name: tu.name, arguments: JSON.stringify(tu.input) },
			}));
		}
		h.push(msg);
	}
}

// === Internal types ===

interface OAIToolResult {
	tool_call_id: string;
	content: string;
}

// === SSE stream parser ===

async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	// Accumulate tool call chunks by index
	const toolAccum = new Map<number, { id: string; name: string; args: string }>();

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const parsed = parseSSELine(line, toolAccum);
				if (parsed) yield parsed;
			}
		}
		// Process any remaining data in the buffer after stream ends
		if (buffer.trim()) {
			const parsed = parseSSELine(buffer, toolAccum);
			if (parsed) yield parsed;
		}
	} finally {
		reader.releaseLock();
	}
}

function parseSSELine(
	line: string,
	toolAccum: Map<number, { id: string; name: string; args: string }>,
): ParsedStreamEvent | null {
	const trimmed = line.trim();
	if (!trimmed || trimmed === "data: [DONE]") return null;
	if (!trimmed.startsWith("data: ")) return null;

	let chunk: OAIStreamChunk;
	try {
		chunk = JSON.parse(trimmed.slice(6));
	} catch {
		return null;
	}

	const choice = chunk.choices?.[0];
	if (!choice) return null;

	const delta = choice.delta;
	const result: ParsedStreamEvent = {};

	// Text content
	if (delta.content) {
		result.text = delta.content;
	}

	// Tool call deltas
	if (delta.tool_calls) {
		for (const tc of delta.tool_calls) {
			const idx = tc.index;
			if (tc.id) {
				toolAccum.set(idx, { id: tc.id, name: tc.function?.name ?? "", args: "" });
			}
			const acc = toolAccum.get(idx);
			if (acc && tc.function?.arguments) {
				acc.args += tc.function.arguments;
			}
		}
	}

	// On finish, emit accumulated tool uses
	if (choice.finish_reason === "tool_calls" || choice.finish_reason === "stop") {
		if (toolAccum.size > 0) {
			const toolUses: AgentToolUse[] = [];
			for (const [, acc] of toolAccum) {
				let input: Record<string, unknown> = {};
				try {
					input = JSON.parse(acc.args);
				} catch {
					input = { _raw: acc.args };
				}
				toolUses.push({
					toolUseId: acc.id || randomUUID(),
					name: acc.name,
					input,
				});
			}
			result.toolUses = toolUses;
			toolAccum.clear();
		}
	}

	if (result.text || result.toolUses) {
		return result;
	}
	return null;
}

// === History builder ===

function buildOAIHistory(dbMessages: DbMessage[]): {
	history: OAIMessage[];
	trailingToolResults: OAIToolResult[];
} {
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant"),
	);

	// Drop the last user message — it's sent as the current message
	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: OAIMessage[] = [];
	let pendingToolResults: OAIToolResult[] = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			// Flush pending tool results as role: "tool" messages
			for (const tr of pendingToolResults) {
				history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
			pendingToolResults = [];

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const textParts = content
				.filter((b: { type: string }) => b.type === "text")
				.map((b: { text: string }) => b.text);
			const text = textParts.join("\n") || msg.contentText || "";

			const completedToolUseIds = new Set(
				msg.toolCalls
					?.filter((tc) => tc.status === "success" || tc.status === "fail")
					.map((tc) => tc.toolUseId) ?? [],
			);

			const toolCalls: OAIToolCall[] =
				msg.toolCalls
					?.filter((tc) => tc.toolName && tc.toolUseId && completedToolUseIds.has(tc.toolUseId))
					.map((tc) => ({
						id: tc.toolUseId,
						type: "function" as const,
						function: {
							name: tc.toolName,
							arguments: JSON.stringify(tc.inputJson ?? {}),
						},
					})) ?? [];

			const assistantMsg: OAIMessage = { role: "assistant" };
			if (text) assistantMsg.content = text;
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			history.push(assistantMsg);

			// Collect tool results
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						const outputText =
							typeof tc.outputJson === "string"
								? tc.outputJson
								: tc.outputJson != null
									? JSON.stringify(tc.outputJson)
									: "";
						pendingToolResults.push({
							tool_call_id: tc.toolUseId,
							content: outputText,
						});
					}
				}
			}
		} else if (msg.role === "user") {
			// Flush pending tool results before user message
			for (const tr of pendingToolResults) {
				history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
			pendingToolResults = [];

			const text = msg.contentText || "";
			if (text) {
				history.push({ role: "user", content: text });
			}
		}
	}

	return { history, trailingToolResults: pendingToolResults };
}
