import { randomUUID } from "node:crypto";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { zodToJsonSchema } from "./tool-registry";
import type { AgentToolUse, ToolDefinition } from "./types";

// === OpenAI message types ===

type OAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

interface OAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OAIContentPart[] | null;
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
	error?: { message?: string; type?: string; code?: string | number };
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

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		return buildOAIHistory(dbMessages);
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
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
			// Build user message with optional images
			if (params.images?.length) {
				const parts: OAIContentPart[] = [{ type: "text", text: params.content }];
				for (const img of params.images) {
					parts.push({
						type: "image_url",
						image_url: { url: `data:image/${img.format};base64,${img.base64}` },
					});
				}
				messages.push({ role: "user", content: parts });
			} else {
				messages.push({ role: "user", content: params.content });
			}
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
		const msg: OAIMessage = { role: "assistant", content: text || null };
		if (toolUses.length > 0) {
			msg.tool_calls = toolUses.map((tu) => ({
				id: tu.toolUseId,
				type: "function" as const,
				function: { name: tu.name, arguments: JSON.stringify(tu.input) },
			}));
		}
		h.push(msg);
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.generateWithMeta(text, model);
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
	): Promise<{ text: string; contextPercent?: number }> {
		const { settings } = await import("../settings");
		const apiKey = settings.openai?.apiKey;
		const baseUrl = (settings.openai?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error("OpenAI API key not configured. Set openai.apiKey in settings.");
		}

		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [{ role: "user", content: text }],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
		};

		return {
			text: json.choices?.[0]?.message?.content ?? "",
			contextPercent: undefined,
		};
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
		const { settings } = await import("../settings");
		const apiKey = settings.openai?.apiKey;
		const baseUrl = (settings.openai?.baseUrl || "https://api.openai.com/v1").replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error("OpenAI API key not configured. Set openai.apiKey in settings.");
		}

		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);

		const response = await fetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Authorization: `Bearer ${apiKey}`,
			},
			body: JSON.stringify({
				model,
				messages: [
					{ role: "system", content: systemInstruction },
					{ role: "user", content: `${reminder}\n\n${content}` },
				],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new Error(`OpenAI API error ${response.status}: ${errText}`);
		}

		const json = (await response.json()) as {
			choices?: Array<{ message?: { content?: string } }>;
		};

		return json.choices?.[0]?.message?.content ?? "";
	}
}

// === Internal types ===

interface OAIToolResult {
	tool_call_id: string;
	content: string;
}

// === Helpers ===

/** Try to parse a string as JSON. Returns true if valid. */
function isParsableJson(s: string): boolean {
	try {
		JSON.parse(s);
		return true;
	} catch {
		return false;
	}
}

// === SSE stream parser ===

/**
 * Tool call accumulator entry.
 * `emitted` tracks whether a toolUseChunk with stop=true has already been
 * yielded for this tool call (via the isParsableJson early-emit path).
 */
interface ToolAccumEntry {
	id: string;
	name: string;
	args: string;
	emitted: boolean;
}

async function* parseSSEStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	// Accumulate tool call chunks by index
	const toolAccum = new Map<number, ToolAccumEntry>();

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const events = parseSSELine(line, toolAccum);
				for (const evt of events) {
					yield evt;
				}
			}
		}
		// Process any remaining data in the buffer after stream ends
		if (buffer.trim()) {
			const events = parseSSELine(buffer, toolAccum);
			for (const evt of events) {
				yield evt;
			}
		}
		// Flush any remaining accumulated tool calls that weren't emitted
		// (e.g. stream ended without a finish_reason chunk)
		const remaining = flushToolAccum(toolAccum);
		if (remaining) yield remaining;
	} finally {
		reader.releaseLock();
	}
}

/** Drain un-emitted tool calls from the accumulator into a ParsedStreamEvent. */
function flushToolAccum(toolAccum: Map<number, ToolAccumEntry>): ParsedStreamEvent | null {
	const toolUses: AgentToolUse[] = [];
	for (const [, acc] of toolAccum) {
		if (acc.emitted) continue; // already yielded via toolUseChunk
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
	toolAccum.clear();
	return toolUses.length > 0 ? { toolUses } : null;
}

function parseSSELine(line: string, toolAccum: Map<number, ToolAccumEntry>): ParsedStreamEvent[] {
	const trimmed = line.trim();
	if (!trimmed || trimmed === "data: [DONE]") return [];
	if (!trimmed.startsWith("data: ")) return [];

	let chunk: OAIStreamChunk;
	try {
		chunk = JSON.parse(trimmed.slice(6));
	} catch {
		return [];
	}

	// Handle error objects embedded in stream chunks
	// (some providers send errors as {error: {message, type, code}} inside the SSE stream)
	if (chunk.error) {
		const msg = chunk.error.message || "Unknown OpenAI API error";
		return [
			{
				invalidState: {
					reason: String(chunk.error.code ?? chunk.error.type ?? "api_error"),
					message: msg,
				},
			},
		];
	}

	// Usage-only chunk (sent when stream_options.include_usage is true).
	// This arrives as a separate chunk with no choices — skip silently.
	if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
		return [];
	}

	const choice = chunk.choices?.[0];
	if (!choice) return [];

	const delta = choice.delta;
	const results: ParsedStreamEvent[] = [];
	const result: ParsedStreamEvent = {};

	// Text content
	if (delta.content) {
		result.text = delta.content;
	}

	// Tool call deltas — emit as toolUseChunk for early execution support
	if (delta.tool_calls) {
		for (const tc of delta.tool_calls) {
			const idx = tc.index;

			// First chunk for this tool call — initialize accumulator
			if (tc.id && !toolAccum.has(idx)) {
				const id = tc.id;
				const name = tc.function?.name ?? "";
				toolAccum.set(idx, { id, name, args: "", emitted: false });
				// Emit initial chunk so the loop knows the tool name early
				results.push({
					toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
				});
			}

			const acc = toolAccum.get(idx);
			if (acc && !acc.emitted) {
				if (tc.function?.arguments) {
					acc.args += tc.function.arguments;
					// Emit argument delta
					results.push({
						toolUseChunk: {
							toolUseId: acc.id,
							input: tc.function.arguments,
							stop: false,
						},
					});

					// Early completion: if accumulated args form valid JSON, emit stop
					// immediately so the agent loop can start executing the tool while
					// the rest of the stream (other tool calls / text) is still arriving.
					if (isParsableJson(acc.args)) {
						results.push({
							toolUseChunk: { toolUseId: acc.id, stop: true },
						});
						acc.emitted = true;
					}
				}
			}
		}
	}

	// On any finish_reason, finalize
	if (choice.finish_reason) {
		// Emit stop for any tool calls that haven't been early-emitted yet
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: { toolUseId: acc.id, stop: true },
				});
				acc.emitted = true;
			}
		}

		// Also emit as flat toolUses for consumers that don't handle toolUseChunk
		const flushed = flushToolAccum(toolAccum);
		if (flushed) {
			Object.assign(result, flushed);
		}

		// Map non-normal finish reasons to invalidState
		if (choice.finish_reason === "length") {
			result.invalidState = {
				reason: "max_tokens",
				message: "Response truncated: model reached maximum token limit.",
			};
		} else if (choice.finish_reason === "content_filter") {
			result.invalidState = {
				reason: "content_filter",
				message: "Response blocked by content filter.",
			};
		}
	}

	if (result.text || result.toolUses || result.invalidState) {
		results.push(result);
	}
	return results;
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

			// OpenAI requires assistant messages to have content (string|null) or tool_calls.
			// Always set content explicitly to avoid sending {role:"assistant"} with no fields.
			const assistantMsg: OAIMessage = { role: "assistant", content: text || null };
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
