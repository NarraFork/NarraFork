import { logger } from "../logger";
import { getToolMessage, type Locale } from "../prompt-i18n";
import type { OpenAIProviderConfig } from "../settings";
import { parseModelId } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import { resolveToolJsonSchema } from "./tool-registry";
import { type AgentToolUse, ApiError, type ResolvedToolDefinition } from "./types";

export type OpenAIApiMode = "responses" | "completions" | "codex";

/** Resolve apiMode from provider config, with backward compat for the old `responsesApi` boolean. */
function resolveApiMode(config?: OpenAIProviderConfig): OpenAIApiMode {
	if (config?.apiMode) return config.apiMode;
	// Legacy: responsesApi === false → completions
	if (config?.responsesApi === false) return "completions";
	return "responses";
}

/** Whether this mode uses Responses API message format (responses & codex both do). */
function usesResponsesFormat(mode: OpenAIApiMode): boolean {
	return mode === "responses" || mode === "codex";
}

/** Whether this mode uses the /responses endpoint (responses & codex both do). */
function usesResponsesEndpoint(mode: OpenAIApiMode): boolean {
	return mode === "responses" || mode === "codex";
}

/** Default base URL per mode. */
function defaultBaseUrl(mode: OpenAIApiMode): string {
	if (mode === "codex") return "https://chatgpt.com/backend-api/codex";
	return "https://api.openai.com/v1";
}

// === OpenAI identity prompt ===
// OpenAI models need an explicit identity and tool-use instruction in the system prompt.
// OpenAI models benefit from system-level guidance to actively use their tools.

const OPENAI_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools. For example, use Read to examine files, Write/Edit to modify them, Bash to run commands, Glob/Grep to search, etc.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。例如，使用 Read 查看文件，Write/Edit 修改文件，Bash 运行命令，Glob/Grep 搜索等。`,
};

// === Codex identity prompt ===
// Codex models (gpt-5.x-codex) use a specialized prompt inspired by OpenCode's codex_header.txt.
// This prompt emphasizes concise, action-oriented behavior with minimal formatting.

const CODEX_DEFAULT_INSTRUCTIONS =
	"You are NarraFork Narrator. Follow the user's request and answer concisely.";

const CODEX_IDENTITY: Record<string, string> = {
	en: `You are NarraFork Narrator, an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more.

## Tool usage
- Prefer specialized tools over shell for file operations:
  - Use Read to view files, Edit to modify files, and Write only when needed.
  - Use Glob to find files by name and Grep to search file contents.
- Use Bash for terminal operations (git, bun, builds, tests, running scripts).
- Run tool calls in parallel when neither call needs the other's output; otherwise run sequentially.

## Git and workspace hygiene
- You may be in a dirty git worktree.
    * NEVER revert existing changes you did not make unless explicitly requested, since these changes were made by the user.
    * If asked to make a commit or code edits and there are unrelated changes to your work or changes that you didn't make in those files, don't revert those changes.
    * If the changes are in files you've touched recently, you should read carefully and understand how you can work with the changes rather than reverting them.
    * If the changes are in unrelated files, just ignore them and don't revert them.
- Do not amend commits unless explicitly requested.
- **NEVER** use destructive commands like \`git reset --hard\` or \`git checkout --\` unless specifically requested or approved by the user.

## Presenting your work
- Default: be very concise; friendly coding teammate tone.
- Default: do the work without asking questions. Treat short tasks as sufficient direction; infer missing details by reading the codebase and following existing conventions.
- Questions: only ask when you are truly blocked after checking relevant context AND you cannot safely pick a reasonable default.
- If you must ask: do all non-blocked work first, then ask exactly one targeted question, include your recommended default, and state what would change based on the answer.
- Never ask permission questions like "Should I proceed?" or "Do you want me to run tests?"; proceed with the most reasonable option and mention what you did.
- For substantial work, summarize clearly but avoid heavy formatting for simple confirmations.
- Don't dump large files you've written; reference paths only.
- The user does not see command execution outputs. When asked to show the output of a command, relay the important details in your answer or summarize the key lines.`,
	"zh-CN": `你是 NarraFork 叙述者，一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。

## 工具使用
- 文件操作优先使用专用工具而非 shell：
  - 使用 Read 查看文件，Edit 修改文件，仅在必要时使用 Write。
  - 使用 Glob 按名称查找文件，Grep 搜索文件内容。
- 使用 Bash 执行终端操作（git、bun、构建、测试、运行脚本）。
- 当工具调用之间无依赖关系时并行执行；否则顺序执行。

## Git 和工作区卫生
- 你可能处于一个脏的 git worktree 中。
    * 除非明确要求，否则永远不要还原你未做的现有更改，因为这些更改是用户做的。
    * 如果被要求提交或编辑代码，而文件中存在与你的工作无关的更改或你未做的更改，不要还原这些更改。
    * 如果更改在你最近接触过的文件中，你应该仔细阅读并理解如何与这些更改协作，而不是还原它们。
    * 如果更改在无关文件中，直接忽略它们，不要还原。
- 除非明确要求，否则不要修改提交。
- **永远不要**使用破坏性命令如 \`git reset --hard\` 或 \`git checkout --\`，除非用户明确要求或批准。

## 呈现你的工作
- 默认：非常简洁；友好的编程队友语气。
- 默认：直接完成工作，不要提问。将简短任务视为充分的指示；通过阅读代码库并遵循现有约定来推断缺失的细节。
- 提问：仅在检查相关上下文后仍然真正受阻且无法安全选择合理默认值时提问。
- 如果必须提问：先完成所有未受阻的工作，然后提出一个精确的问题，包含你推荐的默认值，并说明答案会如何改变结果。
- 永远不要问"我应该继续吗？"或"你想让我运行测试吗？"这样的许可问题；选择最合理的选项并提及你做了什么。
- 对于大量工作，清晰总结，但对于简单确认避免过度格式化。
- 不要转储你写的大文件；仅引用路径。
- 用户看不到命令执行输出。当被要求显示命令输出时，在你的回答中传达重要细节或总结关键行。`,
};

// === OpenAI message types ===

type OAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } }
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string }
	| { type: "output_text"; text: string };

interface OAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OAIContentPart[] | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
	/** Reasoning blocks from the assistant message (used for Responses API replay). */
	_reasoningBlocks?: Array<{
		text: string;
		providerMetadata?: import("./types").ReasoningProviderMetadata;
	}>;
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
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
		prompt_tokens_details?: { cached_tokens?: number };
	};
	error?: { message?: string; type?: string; code?: string | number };
	// --- Responses API fields (used by some gateways/proxies) ---
	/** Responses API: top-level argument delta string for function calls */
	delta?: string;
	/** Responses API: item object containing function call metadata */
	item?: {
		call_id?: string;
		name?: string;
		arguments?: string;
		status?: string;
		type?: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic gateway response
		[key: string]: any;
	};
	/** Responses API: response metadata (instructions, status, etc.) */
	response?: {
		status?: string;
		// biome-ignore lint/suspicious/noExplicitAny: dynamic gateway response
		[key: string]: any;
	};
}

/**
 * OpenAI-compatible API provider.
 *
 * Supports three API modes:
 *   - "responses"   — Native OpenAI Responses API (/responses endpoint)
 *   - "completions"  — Standard Chat Completions API (/chat/completions)
 *   - "codex"        — Codex gateway over the /responses endpoint, with
 *                       Codex-specific instructions, headers, reasoning config,
 *                       and response stream handling.
 */
export class OpenAIProvider implements ProviderAdapter {
	/**
	 * Which API variant to use. Resolved from config on construction.
	 * For "codex" mode, may be upgraded to "responses" if the SSE stream
	 * reveals native Responses API events.
	 */
	apiMode: OpenAIApiMode;

	/** The provider config this instance operates with. */
	private config: OpenAIProviderConfig;

	/** Optional proxy URL for all requests (used by Codex). */
	private proxy?: string;

	constructor(config: OpenAIProviderConfig, proxy?: string) {
		this.config = config;
		this.apiMode = resolveApiMode(config);
		this.proxy = proxy;
	}

	/** Convenience: does the current mode use Responses API message format? */
	private get responsesFormat(): boolean {
		return usesResponsesFormat(this.apiMode);
	}

	/**
	 * Proxy-aware fetch. When a proxy is configured, injects it into the request.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		if (this.proxy) {
			// biome-ignore lint/suspicious/noExplicitAny: Bun-specific `proxy` extension on RequestInit
			return fetch(input, { ...init, proxy: this.proxy } as any);
		}
		return fetch(input, init);
	}
	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		if (this.responsesFormat) {
			// Responses API & Codex: flat format { type: "function", name, description, parameters, strict }
			return tools.map((tool) => ({
				type: "function",
				name: tool.name,
				description: tool.description,
				parameters: resolveToolJsonSchema(tool),
				strict: false, // Strict mode disabled by default (can be made configurable later)
			}));
		}
		// Completions: nested format { type: "function", function: { ... } }
		return tools.map(
			(tool): OAITool => ({
				type: "function",
				function: {
					name: tool.name,
					description: tool.description,
					parameters: resolveToolJsonSchema(tool),
				},
			}),
		);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		_model: string,
		_narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const result = buildOAIHistory(dbMessages);
		if (this.responsesFormat) {
			// Convert standard format to Responses API format upfront
			return {
				history: convertHistoryToResponsesApi(result.history),
				trailingToolResults: result.trailingToolResults.map((tr) => ({
					type: "function_call_output" as const,
					call_id: tr.tool_call_id,
					output: tr.content,
				})),
			};
		}
		// Chat Completions path: strip _reasoningBlocks from assistant messages
		// to avoid sending unknown fields to strict OpenAI-compatible backends.
		for (const msg of result.history) {
			// biome-ignore lint/suspicious/noExplicitAny: OAIMessage has _reasoningBlocks
			const m = msg as any;
			if (m._reasoningBlocks) {
				delete m._reasoningBlocks;
			}
		}
		return result;
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		_model: string,
		_locale?: string,
	): void {
		const h = history as OAIMessage[];
		const locale = (_locale ?? "en") as Locale;
		// Use Codex-specific identity for codex mode, otherwise use standard OpenAI identity
		const identityMap = this.apiMode === "codex" ? CODEX_IDENTITY : OPENAI_IDENTITY;
		const identity = identityMap[locale] ?? identityMap.en;
		const content = `${identity}\n\n${systemPrompt}`;
		const role = this.responsesFormat ? "developer" : "system";
		h.unshift({ role, content } as unknown as OAIMessage);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const history = params.history as OAIMessage[];
		const tools = params.tools as OAITool[];

		// Build messages: history + pending tool results + current user message
		const messages: OAIMessage[] = [...history];

		// Append tool results
		if (this.responsesFormat) {
			for (const tr of params.toolResults as Array<{
				type: string;
				call_id: string;
				output: string;
			}>) {
				logger.debug("OpenAI appending Responses API tool result", {
					type: tr.type,
					call_id: tr.call_id,
					outputLength: tr.output?.length,
				});
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				messages.push(tr as any);
			}
		} else {
			for (const tr of params.toolResults as OAIToolResult[]) {
				messages.push({
					role: "tool",
					tool_call_id: tr.tool_call_id,
					content: tr.content,
				});
			}
		}

		// Append current user message (skip "." continuation markers)
		if (params.content && params.content !== ".") {
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
			messages.push({ role: "user", content: params.content });
		}

		// ── Build request body & endpoint based on apiMode ──
		const model = parseModelId(params.model).model;
		let endpoint: string;
		let body: Record<string, unknown>;

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex: POST /responses
			endpoint = `${baseUrl}/responses`;

			// Extract instructions from developer/system messages
			let instructions = "";
			const inputMessages: OAIMessage[] = [];

			for (const msg of messages) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				const m = msg as any;
				if (m.role === "developer" || m.role === "system") {
					// Accumulate instructions from developer/system messages
					if (typeof m.content === "string") {
						instructions += (instructions ? "\n\n" : "") + m.content;
					}
				} else {
					inputMessages.push(msg);
				}
			}

			// Codex with previous_response_id: send only incremental input (tool results + user message).
			// The server already has the full conversation history from the stored response.
			const useStoredState = this.apiMode === "codex" && !!params.previousResponseId;

			let responsesInput: OAIMessage[];
			if (useStoredState) {
				// Incremental mode: only new items since the last response.
				// inputMessages at this point already excludes developer/system messages.
				// We only need the tool results and user message appended in chat().
				// These are the items added AFTER the history array (tool results + current user msg).
				const incrementalMessages: OAIMessage[] = [];
				// Tool results were appended to messages after history
				for (const tr of params.toolResults as Array<{
					type: string;
					call_id: string;
					output: string;
				}>) {
					// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
					incrementalMessages.push(tr as any);
				}
				// Current user message (if any, already appended to messages)
				if (params.content && params.content !== ".") {
					if (params.images?.length) {
						const parts: OAIContentPart[] = [{ type: "input_text", text: params.content }];
						for (const img of params.images) {
							parts.push({
								type: "input_image",
								image_url: `data:image/${img.format};base64,${img.base64}`,
							});
						}
						incrementalMessages.push({
							role: "user",
							content: parts,
						} as unknown as OAIMessage);
					} else {
						incrementalMessages.push({
							role: "user",
							content: [{ type: "input_text", text: params.content }],
						} as unknown as OAIMessage);
					}
				} else if ((params.toolResults as unknown[]).length === 0) {
					incrementalMessages.push({
						role: "user",
						content: [{ type: "input_text", text: params.content }],
					} as unknown as OAIMessage);
				}
				responsesInput = incrementalMessages;
			} else {
				const sanitizedInputMessages = inputMessages.filter((msg) => {
					if (msg.role !== "assistant") return true;
					// Responses API rejects assistant role messages with null/empty content and no tool calls.
					const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
					if (hasToolCalls) return true;
					if (typeof msg.content === "string") return msg.content.length > 0;
					if (Array.isArray(msg.content)) return msg.content.length > 0;
					return false;
				});
				responsesInput = convertHistoryToResponsesApi(sanitizedInputMessages);
			}

			// Codex uses store: true for server-side response persistence (enables
			// previous_response_id chaining and avoids 404 errors for reasoning items).
			// Non-Codex Responses API keeps store: false.
			const storeResponse = this.apiMode === "codex";
			body = { model, input: responsesInput, stream: true, store: storeResponse };

			if (useStoredState) {
				body.previous_response_id = params.previousResponseId;
			}

			// Codex: enable server-side auto-truncation to handle context window overflow.
			if (this.apiMode === "codex") {
				body.truncation = "auto";
			}
			if (instructions) {
				body.instructions = instructions;
			} else if (this.apiMode === "codex") {
				// Codex gateway requires non-empty instructions even for pure tool/result turns.
				body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
			}
			if (tools.length > 0) body.tools = tools;

			// Codex: inject native web_search tool (server-side search, not a function tool)
			if (this.apiMode === "codex") {
				const toolsArr = (body.tools ?? []) as unknown[];
				toolsArr.push({ type: "web_search" });
				body.tools = toolsArr;
			}

			// Add reasoning configuration for Codex provider requests.
			if (params.reasoningEffort && this.apiMode === "codex") {
				body.reasoning = {
					effort: params.reasoningEffort,
					summary: "auto",
				};
				body.include = ["reasoning.encrypted_content"];
			}

			// Add service_tier for Codex fast mode (priority processing).
			if (params.serviceTier && this.apiMode === "codex") {
				body.service_tier = params.serviceTier;
			}

			logger.debug("Responses API request body", {
				model,
				hasInstructions: !!instructions,
				instructionsLength: instructions.length,
				inputMessageCount: responsesInput.length,
				toolCount: tools.length,
				reasoningEffort: params.reasoningEffort,
				previousResponseId: params.previousResponseId ?? null,
				store: storeResponse,
				useStoredState,
			});
		} else {
			// Completions: POST /chat/completions
			endpoint = `${baseUrl}/chat/completions`;
			body = {
				model,
				messages,
				stream: true,
				stream_options: { include_usage: true },
			};
			if (tools.length > 0) body.tools = tools;
		}

		logger.debug("OpenAI chat request", {
			model,
			apiMode: this.apiMode,
			endpoint,
			toolCount: tools.length,
			messageCount: messages.length,
			hasToolResults: (params.toolResults as unknown[]).length > 0,
			messageStructure: messages.map((m, i) => {
				// biome-ignore lint/suspicious/noExplicitAny: debug logging
				const msg = m as any;
				const role = msg.role ?? msg.type ?? "?";
				const extra =
					msg.type === "function_call"
						? `:${msg.name}`
						: msg.type === "function_call_output"
							? `:${msg.call_id?.slice(0, 12)}`
							: msg.tool_calls
								? `:tc=${msg.tool_calls.length}`
								: "";
				return `[${i}]${role}${extra}`;
			}),
		});

		const response = await this.pfetch(endpoint, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify(body),
			signal: params.signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `OpenAI API error ${response.status}: ${errText}`);
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		if (usesResponsesEndpoint(this.apiMode)) {
			// Responses API & Codex both use the native Responses SSE format
			yield* _parseResponsesAPIStream(response.body);
		} else {
			yield* this.parseSSEStreamWithDetection(response.body);
		}
	}

	/**
	 * Wrap parseSSEStream to detect Responses API format from Codex gateways.
	 * Only relevant for "codex" mode — completions mode ignores the marker.
	 */
	private async *parseSSEStreamWithDetection(
		body: ReadableStream<Uint8Array>,
	): AsyncGenerator<ParsedStreamEvent> {
		for await (const evt of parseSSEStream(body)) {
			if (evt._responsesApi && this.apiMode === "codex") {
				logger.debug("Codex gateway confirmed Responses API format");
			}
			yield evt;
		}
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		_isError: boolean,
		_images?: Array<{ format: string; base64: string }>,
	): unknown {
		logger.debug("OpenAI formatToolResult", {
			apiMode: this.apiMode,
			toolUseId,
			outputLength: output.length,
		});
		if (this.responsesFormat) {
			return { type: "function_call_output", call_id: toolUseId, output };
		}
		return { tool_call_id: toolUseId, content: output } satisfies OAIToolResult;
	}

	pushUserTurn(history: unknown[], content: string, _model: string, toolResults: unknown[]): void {
		const h = history as OAIMessage[];
		if (this.responsesFormat) {
			for (const tr of toolResults as Array<{ type: string; call_id: string; output: string }>) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API uses different message shape
				h.push(tr as any);
			}
		} else {
			for (const tr of toolResults as OAIToolResult[]) {
				h.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
		}
		if (content && content !== ".") {
			h.push({ role: "user", content });
		}
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
		}>,
	): void {
		const h = history as OAIMessage[];
		if (this.responsesFormat) {
			// Emit reasoning items before text/tool_calls for Responses API
			if (reasoningBlocks?.length) {
				const emittedIds = new Set<string>();
				emitReasoningItems(reasoningBlocks, h, emittedIds);
			}
			if (text) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				h.push({ role: "assistant", content: text } as any);
			}
			for (const tu of toolUses) {
				logger.debug("OpenAI pushAssistantTurn function_call", {
					call_id: tu.toolUseId,
					name: tu.name,
				});
				h.push({
					type: "function_call",
					call_id: tu.toolUseId,
					name: tu.name,
					arguments: JSON.stringify(tu.input),
					// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				} as any);
			}
		} else {
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
	}

	async generate(text: string, model: string): Promise<string> {
		const result = await this.generateWithMeta(text, model);
		return result.text;
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
	): Promise<{ text: string; contextPercent?: number }> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;

		if (usesResponsesEndpoint(this.apiMode)) {
			const body: Record<string, unknown> = {
				model: bareModel,
				input: [{ role: "user", content: text }],
				store: false,
			};
			if (systemInstruction) {
				body.instructions = systemInstruction;
			} else if (this.apiMode === "codex") {
				// Codex gateway requires non-empty instructions on /responses.
				body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
			}
			if (this.apiMode === "codex") {
				// Codex gateway requires stream=true on /responses.
				body.stream = true;
			}
			const resultText = await this.requestResponsesText(baseUrl, apiKey, body);
			return { text: resultText, contextPercent: undefined };
		}

		// Completions: POST /chat/completions
		const messages: Array<{ role: "system" | "user"; content: string }> = [];
		if (systemInstruction) {
			messages.push({ role: "system", content: systemInstruction });
		}
		messages.push({ role: "user", content: text });
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages,
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `OpenAI API error ${response.status}: ${errText}`);
		}

		const raw = await response.text();
		const json = parseJsonWithPreview<{
			choices?: Array<{ message?: { content?: string } }>;
			usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
		}>(raw, "OpenAI chat/completions returned non-JSON payload");

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
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const reminder = getToolMessage("titleReminder", (locale ?? "en") as Locale);
		const bareModel = parseModelId(model).model;

		if (usesResponsesEndpoint(this.apiMode)) {
			const body: Record<string, unknown> = {
				model: bareModel,
				instructions: systemInstruction,
				input: [{ role: "user", content: `${reminder}\n\n${content}` }],
				store: false,
			};
			if (this.apiMode === "codex") {
				// Codex gateway requires stream=true on /responses.
				body.stream = true;
			}
			return this.requestResponsesText(baseUrl, apiKey, body);
		}

		// Completions
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify({
				model: bareModel,
				messages: [
					{ role: "system", content: systemInstruction },
					{ role: "user", content: `${reminder}\n\n${content}` },
				],
			}),
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `OpenAI API error ${response.status}: ${errText}`);
		}

		const raw = await response.text();
		const json = parseJsonWithPreview<{
			choices?: Array<{ message?: { content?: string } }>;
		}>(raw, "OpenAI chat/completions returned non-JSON payload");

		return json.choices?.[0]?.message?.content ?? "";
	}

	/**
	 * Request /responses and extract plain text result.
	 * Supports both JSON (non-streaming) and SSE (streaming) responses.
	 */
	private async requestResponsesText(
		baseUrl: string,
		apiKey: string,
		body: Record<string, unknown>,
	): Promise<string> {
		const response = await this.pfetch(`${baseUrl}/responses`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify(body),
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw new ApiError(response.status, `OpenAI API error ${response.status}: ${errText}`);
		}

		const isStreaming = body.stream === true;
		if (!isStreaming) {
			const raw = await response.text();
			const json = parseResponsesJson(raw);
			return extractResponsesText(json.output);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const looksJson = contentType.includes("application/json");
		if (looksJson) {
			const raw = await response.text();
			const json = parseResponsesJson(raw);
			return extractResponsesText(json.output);
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		let text = "";
		for await (const evt of _parseResponsesAPIStream(response.body)) {
			if (evt.text) text += evt.text;
			if (evt.invalidState) {
				throw new Error(
					`OpenAI Responses stream error (${evt.invalidState.reason}): ${evt.invalidState.message}`,
				);
			}
		}
		return text;
	}

	/** Build common request headers, with Codex-specific extras. */
	private buildHeaders(apiKey: string): Record<string, string> {
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: `Bearer ${apiKey}`,
		};
		if (this.apiMode === "codex") {
			headers.originator = "narrafork";
			const accountId = this.config.codexAccountId;
			// Only send ChatGPT-Account-Id to official ChatGPT domains
			if (accountId && this.isOfficialChatGPTDomain()) {
				headers["ChatGPT-Account-Id"] = accountId;
			}
		}
		return headers;
	}

	/** Check if the base URL points to an official ChatGPT domain. */
	private isOfficialChatGPTDomain(): boolean {
		const baseUrl = this.config.baseUrl;
		if (!baseUrl) return true; // default URL is official
		try {
			const host = new URL(baseUrl).hostname;
			return (
				host === "chatgpt.com" || host.endsWith(".chatgpt.com") || host.endsWith(".openai.com")
			);
		} catch {
			return false;
		}
	}

	/**
	 * Get the effective API key for requests.
	 * For standard API key auth, returns the configured API key.
	 */
	private async getEffectiveApiKey(): Promise<string> {
		return this.config.apiKey;
	}
}

/** Parse JSON with a clearer error message and body preview. */
function parseJsonWithPreview<T>(raw: string, errorPrefix: string): T {
	try {
		return JSON.parse(raw) as T;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`${errorPrefix}: ${message}. body preview=${raw.slice(0, 500)}`);
	}
}

/** Parse a /responses JSON payload with a clearer error message. */
function parseResponsesJson(raw: string): {
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
} {
	return parseJsonWithPreview<{
		output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	}>(raw, "OpenAI API returned non-JSON responses payload");
}

/** Extract text from a Responses API output array. */
function extractResponsesText(
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>,
): string {
	return (
		output
			?.filter((o) => o.type === "message")
			.flatMap((o) => o.content ?? [])
			.filter((c) => c.type === "output_text")
			.map((c) => c.text ?? "")
			.join("") ?? ""
	);
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

// === Responses API SSE stream parser ===

/**
 * Parse native OpenAI Responses API SSE stream.
 *
 * Event types we handle:
 *   response.output_text.delta      → text streaming
 *   response.output_text.done       → (ignored, text already accumulated)
 *   response.output_item.added      → detect function_call items (tool call start)
 *   response.function_call_arguments.delta → tool call argument streaming
 *   response.function_call_arguments.done  → tool call complete
 *   response.output_item.done       → finalize tool call if not yet emitted
 *   response.completed              → flush remaining
 *   response.failed / response.incomplete → error states
 *   response.reasoning_summary_text.delta → reasoning content
 */
async function* _parseResponsesAPIStream(
	body: ReadableStream<Uint8Array>,
): AsyncGenerator<ParsedStreamEvent> {
	const decoder = new TextDecoder();
	let buffer = "";
	let lineCount = 0;

	// Tool call accumulators keyed by output_index (matches OpenAI SSE structure)
	const toolAccum = new Map<number, ResponsesToolAccum>();
	// Reasoning item accumulators keyed by output_index
	const reasoningAccum = new Map<number, ResponsesReasoningAccum>();

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed || trimmed.startsWith("event:")) continue;
				if (!trimmed.startsWith("data: ")) continue;

				if (lineCount < 5) {
					logger.debug("Responses API SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				let chunk: ResponsesAPIChunk;
				try {
					chunk = JSON.parse(trimmed.slice(6));
				} catch {
					continue;
				}

				const events = parseResponsesAPIEvent(chunk, toolAccum, reasoningAccum);
				for (const evt of events) {
					yield evt;
				}
			}
		}
		// Process remaining buffer
		if (buffer.trim()?.startsWith("data: ")) {
			try {
				const chunk = JSON.parse(buffer.trim().slice(6));
				const events = parseResponsesAPIEvent(chunk, toolAccum, reasoningAccum);
				for (const evt of events) {
					yield evt;
				}
			} catch (err) {
				logger.debug("Responses API: failed to parse remaining buffer", {
					bufferLength: buffer.length,
					error: String(err),
				});
			}
		}
		// Flush any un-emitted tool calls
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				acc.emitted = true;
				yield { toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } };
			}
		}
	} finally {
		reader.releaseLock();
	}
}

interface ResponsesAPIChunk {
	type?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	item?: any;
	/** Present on delta/done events to identify the item */
	item_id?: string;
	delta?: string;
	output_index?: number;
	content_index?: number;
	/** Present on reasoning_summary_text.delta / reasoning_summary_part.added */
	summary_index?: number;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	response?: any;
}

/** Accumulator for a single Responses API tool call, keyed by output_index. */
interface ResponsesToolAccum {
	callId: string;
	name: string;
	args: string;
	emitted: boolean;
}

/** Accumulator for a Responses API reasoning item, keyed by output_index. */
interface ResponsesReasoningAccum {
	/** The canonical item ID from the API (e.g. "rs_...") */
	itemId: string;
	/** Encrypted reasoning content for continuation */
	encryptedContent?: string | null;
}

function parseResponsesAPIEvent(
	chunk: ResponsesAPIChunk,
	toolAccum: Map<number, ResponsesToolAccum>,
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
): ParsedStreamEvent[] {
	const type = chunk.type;
	if (!type) return [];

	// ── Extract usage from any event (bob_cx and similar gateways may include it anywhere) ──
	const results: ParsedStreamEvent[] = [];
	// biome-ignore lint/suspicious/noExplicitAny: dynamic gateway response may have usage at top level
	const usage = chunk.response?.usage || (chunk as any).usage;
	if (usage?.input_tokens != null) {
		logger.debug("OpenAI Responses API usage found", {
			type,
			inputTokens: usage.input_tokens,
			outputTokens: usage.output_tokens,
			reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
			cachedInputTokens: usage.input_tokens_details?.cached_tokens,
		});
		results.push({
			usage: {
				promptTokens: usage.input_tokens,
				completionTokens: usage.output_tokens,
				reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? undefined,
				cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? undefined,
			},
		});
	}

	// ── Response created: capture response ID for previous_response_id chaining ──
	if (type === "response.created" && chunk.response?.id) {
		logger.debug("Responses API response created", { responseId: chunk.response.id });
		results.push({ responseId: chunk.response.id });
		return results;
	}

	// ── Text streaming ──
	if (type === "response.output_text.delta" && typeof chunk.delta === "string") {
		results.push({ text: chunk.delta });
		return results;
	}

	// ── Web search: output_item.added (type=web_search_call) ──
	if (type === "response.output_item.added" && chunk.item?.type === "web_search_call") {
		const id = chunk.item.id ?? "";
		logger.debug("Responses API web search started", { id });
		results.push({ webSearch: { id, status: "in_progress" } });
		return results;
	}

	// ── Web search: lifecycle events ──
	if (type === "response.web_search_call.in_progress") {
		results.push({ webSearch: { id: chunk.item_id ?? "", status: "in_progress" } });
		return results;
	}
	if (type === "response.web_search_call.searching") {
		results.push({ webSearch: { id: chunk.item_id ?? "", status: "searching" } });
		return results;
	}
	if (type === "response.web_search_call.completed") {
		results.push({ webSearch: { id: chunk.item_id ?? "", status: "completed" } });
		return results;
	}

	// ── Web search: output_item.done (type=web_search_call) — final result with query ──
	if (type === "response.output_item.done" && chunk.item?.type === "web_search_call") {
		const action = chunk.item.action;
		results.push({
			webSearch: {
				id: chunk.item.id ?? "",
				status: "completed",
				query: action?.query,
				queries: action?.queries,
			},
		});
		return results;
	}

	// ── Reasoning: output_item.added (type=reasoning) ──
	// Track the reasoning item's id and encrypted_content for continuation.
	if (type === "response.output_item.added" && chunk.item?.type === "reasoning") {
		const idx = chunk.output_index;
		if (idx != null) {
			reasoningAccum.set(idx, {
				itemId: chunk.item.id ?? "",
				encryptedContent: chunk.item.encrypted_content ?? null,
			});
			logger.debug("Responses API reasoning item started", {
				outputIndex: idx,
				itemId: chunk.item.id,
				hasEncryptedContent: !!chunk.item.encrypted_content,
			});
		}
		return results;
	}

	// ── Reasoning: output_item.done (type=reasoning) ──
	// Update encrypted_content with the final value from the done event and
	// emit a metadata-only event so the loop can persist the final value.
	if (type === "response.output_item.done" && chunk.item?.type === "reasoning") {
		const idx = chunk.output_index;
		if (idx != null) {
			const acc = reasoningAccum.get(idx);
			if (acc) {
				const finalEncrypted = chunk.item.encrypted_content ?? acc.encryptedContent;
				acc.encryptedContent = finalEncrypted;
				// Emit a metadata-only event (no reasoning text) so the loop captures
				// the final encrypted_content for persistence / continuation.
				results.push({
					reasoningMetadata: {
						openai: {
							itemId: acc.itemId,
							reasoningEncryptedContent: finalEncrypted,
						},
					},
				});
			}
		}
		return results;
	}

	// ── Reasoning content (summary text delta) ──
	if (type === "response.reasoning_summary_text.delta" && typeof chunk.delta === "string") {
		// Look up the active reasoning item to attach metadata
		const idx = chunk.output_index;
		const acc = idx != null ? reasoningAccum.get(idx) : findActiveReasoningAccum(reasoningAccum);
		if (acc) {
			results.push({
				reasoning: chunk.delta,
				reasoningMetadata: {
					openai: {
						itemId: acc.itemId,
						reasoningEncryptedContent: acc.encryptedContent,
					},
				},
			});
		} else {
			results.push({ reasoning: chunk.delta });
		}
		return results;
	}

	// ── Function call: output_item.added ──
	// { type, output_index, item: { type: "function_call", id, call_id, name, arguments } }
	if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
		const idx = chunk.output_index;
		const callId = chunk.item.call_id;
		const name = chunk.item.name;
		if (idx != null && callId && name) {
			toolAccum.set(idx, { callId, name, args: "", emitted: false });
			logger.debug("Responses API tool call started", { outputIndex: idx, callId, toolName: name });
			results.push({
				toolUseChunk: { toolUseId: callId, name, input: undefined, stop: false },
				_responsesApi: true,
			});
			return results;
		}
	}

	// ── Function call: arguments delta ──
	// { type, item_id, output_index, delta: "..." }
	// NOTE: This event does NOT have item.call_id — use output_index to find the accumulator.
	if (type === "response.function_call_arguments.delta" && typeof chunk.delta === "string") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			acc.args += chunk.delta;
			results.push({
				toolUseChunk: {
					toolUseId: acc.callId,
					name: acc.name,
					input: chunk.delta,
					stop: false,
				},
			});
			// Early completion if args form valid JSON
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true },
				});
				acc.emitted = true;
			}
			return results;
		}
	}

	// ── Function call: arguments done ──
	// Some API versions send this; use output_index to find accumulator.
	if (type === "response.function_call_arguments.done") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			if (typeof chunk.item?.arguments === "string") {
				acc.args = chunk.item.arguments;
			}
			acc.emitted = true;
			results.push({ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } });
			return results;
		}
	}

	// ── Output item done (finalizes function_call) ──
	// { type, output_index, item: { type: "function_call", id, call_id, name, arguments, status: "completed" } }
	if (type === "response.output_item.done" && chunk.item?.type === "function_call") {
		const idx = chunk.output_index;
		const acc = idx != null ? toolAccum.get(idx) : undefined;
		if (acc && !acc.emitted) {
			if (typeof chunk.item.arguments === "string") {
				acc.args = chunk.item.arguments;
			}
			acc.emitted = true;
			results.push({ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } });
			return results;
		}
	}

	// ── Response completed ──
	if (type === "response.completed") {
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({ toolUseChunk: { toolUseId: acc.callId, name: acc.name, stop: true } });
				acc.emitted = true;
			}
		}
		// Note: usage is already extracted at the top of this function
		return results;
	}

	// ── Error states ──
	if (type === "response.failed") {
		const errMsg = chunk.response?.error?.message ?? "Response failed";
		const reason =
			String(chunk.response?.error?.code ?? chunk.response?.error?.type ?? "api_error") ||
			"api_error";
		results.push({ invalidState: { reason, message: errMsg } });
		return results;
	}
	if (type === "response.incomplete") {
		const reason = chunk.response?.incomplete_details?.reason ?? "unknown";
		results.push({ invalidState: { reason, message: `Response incomplete: ${reason}` } });
		return results;
	}

	return results;
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
	let lineCount = 0;

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				// Log first few SSE lines for debugging
				if (lineCount < 5 && line.trim() && line.startsWith("data: ")) {
					logger.debug("OpenAI SSE line", {
						lineIndex: lineCount,
						preview: line.slice(0, 300),
					});
				}
				lineCount++;
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
		if (!acc.id) {
			logger.error("OpenAI tool call missing ID from stream", { toolName: acc.name });
			continue;
		}
		let input: Record<string, unknown> = {};
		try {
			input = JSON.parse(acc.args);
		} catch {
			logger.warn("Failed to parse OpenAI tool arguments", {
				toolName: acc.name,
				argsLength: acc.args.length,
			});
			input = { _raw: acc.args };
		}
		toolUses.push({
			toolUseId: acc.id,
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
	// This arrives as a separate chunk with no choices.
	// Convert to usage event for context window tracking.
	if (chunk.usage && (!chunk.choices || chunk.choices.length === 0)) {
		const promptTokens = chunk.usage.prompt_tokens;
		logger.debug("OpenAI usage-only chunk", {
			hasPromptTokens: promptTokens != null,
			usage: chunk.usage,
		});
		if (promptTokens != null) {
			return [
				{
					usage: {
						promptTokens,
						completionTokens: chunk.usage.completion_tokens,
						reasoningTokens: chunk.usage.completion_tokens_details?.reasoning_tokens ?? undefined,
						cachedInputTokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? undefined,
					},
				},
			];
		}
		return [];
	}

	// ── Responses API: function call start (item with call_id + name) ──
	// Some gateways (e.g. Codex-compatible proxies) wrap the OpenAI Responses API
	// in a Chat Completions–like SSE envelope. Tool calls arrive as:
	//   { item: { call_id, name, status: "in_progress" }, ... }
	// followed by argument deltas as:
	//   { delta: "<json-fragment>", id: "fc_..." }
	// and completion as:
	//   { item: { call_id, status: "completed" } }
	if (chunk.item?.call_id && chunk.item?.name && chunk.item?.status === "in_progress") {
		const id = chunk.item.call_id;
		const name = chunk.item.name;
		// Use a fixed index slot (keyed by call_id hash) since Responses API doesn't use index
		const idx = responsesApiSlot(id, toolAccum);
		if (!toolAccum.has(idx)) {
			toolAccum.set(idx, { id, name, args: chunk.item.arguments ?? "", emitted: false });
			logger.debug("OpenAI Responses API tool call started", { callId: id, toolName: name });
			return [
				{
					toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
					_responsesApi: true,
				},
			];
		}
		return [];
	}

	// ── Responses API: function call argument delta ──
	// Identified by: top-level `delta` string + `id` starting with "fc_"
	if (typeof chunk.delta === "string" && chunk.id?.startsWith("fc_")) {
		// Find the active (non-emitted) tool call accumulator
		const acc = findActiveResponsesAcc(toolAccum);
		if (acc && !acc.emitted) {
			acc.args += chunk.delta;
			const results: ParsedStreamEvent[] = [
				{
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						input: chunk.delta,
						stop: false,
					},
				},
			];
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
				});
				acc.emitted = true;
			}
			return results;
		}
		return [];
	}

	// ── Responses API: function call completed ──
	if (chunk.item?.call_id && chunk.item?.status === "completed") {
		const acc = findAccByCallId(toolAccum, chunk.item.call_id);
		if (acc && !acc.emitted) {
			acc.emitted = true;
			return [{ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } }];
		}
		return [];
	}

	// ── Responses API: response completed ──
	if (chunk.response?.status === "completed") {
		// Flush any remaining un-emitted tool calls
		const results: ParsedStreamEvent[] = [];
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({ toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true } });
				acc.emitted = true;
			}
		}
		return results;
	}

	// ── Standard Chat Completions format below ──

	const choice = chunk.choices?.[0];
	if (!choice) return [];

	const delta = choice.delta;
	const results: ParsedStreamEvent[] = [];
	const result: ParsedStreamEvent = {};

	// Text content
	if (delta.content) {
		result.text = delta.content;
	}

	// Reasoning content (extended thinking / reasoning_content)
	// biome-ignore lint/suspicious/noExplicitAny: gateway-specific field
	const reasoning = (delta as any).reasoning_content;
	if (typeof reasoning === "string" && reasoning) {
		result.reasoning = reasoning;
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
				logger.debug("OpenAI tool call started", { toolCallId: id, toolName: name, index: idx });
				// Emit initial chunk so the loop knows the tool name early
				results.push({
					toolUseChunk: { toolUseId: id, name, input: undefined, stop: false },
				});
			}

			const acc = toolAccum.get(idx);
			if (acc && !acc.emitted) {
				if (tc.function?.arguments) {
					acc.args += tc.function.arguments;
					// Emit argument delta (include name for consumer convenience)
					results.push({
						toolUseChunk: {
							toolUseId: acc.id,
							name: acc.name,
							input: tc.function.arguments,
							stop: false,
						},
					});

					// Early completion: if accumulated args form valid JSON, emit stop
					// immediately so the agent loop can start executing the tool while
					// the rest of the stream (other tool calls / text) is still arriving.
					if (isParsableJson(acc.args)) {
						results.push({
							toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
						});
						acc.emitted = true;
					}
				}
			}
		}
	}

	// On any finish_reason, finalize
	if (choice.finish_reason) {
		logger.debug("OpenAI stream finish", {
			finishReason: choice.finish_reason,
			accumulatedToolCalls: toolAccum.size,
		});
		// Emit stop for any tool calls that haven't been early-emitted yet
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: { toolUseId: acc.id, name: acc.name, stop: true },
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
		switch (choice.finish_reason) {
			case "stop":
			case "tool_calls":
				// Normal completion — no action needed
				break;
			case "length":
				result.invalidState = {
					reason: "max_tokens",
					message: "Response truncated: model reached maximum token limit.",
				};
				break;
			case "content_filter":
				result.invalidState = {
					reason: "content_filter",
					message: "Response blocked by content filter.",
				};
				break;
			default:
				logger.warn("Unknown OpenAI finish reason", { finishReason: choice.finish_reason });
		}
	}

	if (result.text || result.toolUses || result.invalidState || result.reasoning) {
		results.push(result);
	}
	return results;
}

// ── Responses API helpers ──

/** Allocate a stable numeric slot for a Responses API call_id. */
function responsesApiSlot(callId: string, toolAccum: Map<number, ToolAccumEntry>): number {
	// Check if this call_id already has a slot
	for (const [idx, acc] of toolAccum) {
		if (acc.id === callId) return idx;
	}
	// Assign next available slot starting from 10000 to avoid collision with standard indices
	let slot = 10000;
	while (toolAccum.has(slot)) slot++;
	return slot;
}

/** Find the most recently added non-emitted accumulator (for Responses API argument deltas). */
function findActiveResponsesAcc(
	toolAccum: Map<number, ToolAccumEntry>,
): ToolAccumEntry | undefined {
	let latest: ToolAccumEntry | undefined;
	for (const [, acc] of toolAccum) {
		if (!acc.emitted) latest = acc;
	}
	return latest;
}

/** Find accumulator by call_id. */
function findAccByCallId(
	toolAccum: Map<number, ToolAccumEntry>,
	callId: string,
): ToolAccumEntry | undefined {
	for (const [, acc] of toolAccum) {
		if (acc.id === callId) return acc;
	}
	return undefined;
}

/** Find the active reasoning accumulator (fallback when output_index is missing from delta). */
function findActiveReasoningAccum(
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
): ResponsesReasoningAccum | undefined {
	// Return the last entry (most recently added)
	let latest: ResponsesReasoningAccum | undefined;
	for (const [, acc] of reasoningAccum) {
		latest = acc;
	}
	return latest;
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

			// Extract reasoning blocks with their provider metadata for Responses API replay
			const reasoningBlocks = content
				.filter((b: { type: string }) => b.type === "reasoning")
				.map(
					(b: {
						text: string;
						providerMetadata?: import("./types").ReasoningProviderMetadata;
					}) => ({
						text: b.text,
						providerMetadata: b.providerMetadata,
					}),
				);

			// Extract web_search blocks — these are Codex native searches persisted as content blocks.
			// Replay them as user context so the model knows it searched previously.
			const webSearchBlocks = content.filter(
				(b: { type: string }) => b.type === "web_search",
			) as Array<{ type: "web_search"; id: string; query?: string; queries?: string[] }>;
			if (webSearchBlocks.length > 0) {
				const searchSummary = webSearchBlocks
					.map((ws) => {
						const q = ws.query || ws.queries?.join(", ") || "unknown";
						return `[Web search: ${q}]`;
					})
					.join("\n");
				history.push({ role: "user", content: searchSummary });
			}

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

			const hasText = text.length > 0;
			if (!hasText && toolCalls.length === 0) {
				// Skip empty assistant stubs (can happen after interrupted streaming).
				// Keeping them would become `content: null` in Responses API input and
				// trigger validation errors.
				continue;
			}

			// OpenAI requires assistant messages to have content (string|null) or tool_calls.
			// Always set content explicitly to avoid sending {role:"assistant"} with no fields.
			const assistantMsg: OAIMessage = { role: "assistant", content: hasText ? text : null };
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			// Attach reasoning blocks for Responses API replay (stripped in buildHistory for Chat Completions)
			if (reasoningBlocks.length > 0) {
				assistantMsg._reasoningBlocks = reasoningBlocks;
			}
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

/**
 * Emit Responses API reasoning items from stored reasoning blocks.
 * Groups blocks by itemId — multiple summary parts with the same itemId
 * are merged into a single reasoning item with multiple summary entries.
 * Blocks without provider metadata (e.g. from non-Codex providers) are skipped.
 */
function emitReasoningItems(
	reasoningBlocks:
		| Array<{
				text: string;
				providerMetadata?: import("./types").ReasoningProviderMetadata;
		  }>
		| undefined,
	// biome-ignore lint/suspicious/noExplicitAny: Responses API uses different message shapes
	result: any[],
	emittedIds: Set<string>,
): void {
	if (!reasoningBlocks?.length) return;

	// Group by itemId for deduplication
	const grouped = new Map<
		string,
		{
			itemId: string;
			encryptedContent?: string | null;
			summaryTexts: string[];
		}
	>();

	for (const block of reasoningBlocks) {
		const itemId = block.providerMetadata?.openai?.itemId;
		if (!itemId) continue; // Skip blocks without provider metadata
		if (emittedIds.has(itemId)) continue; // Already emitted in a previous message

		let group = grouped.get(itemId);
		if (!group) {
			group = {
				itemId,
				encryptedContent: block.providerMetadata?.openai?.reasoningEncryptedContent,
				summaryTexts: [],
			};
			grouped.set(itemId, group);
		}
		if (block.text) {
			group.summaryTexts.push(block.text);
		}
		// Update encrypted content if this block has a newer value
		if (block.providerMetadata?.openai?.reasoningEncryptedContent != null) {
			group.encryptedContent = block.providerMetadata.openai.reasoningEncryptedContent;
		}
	}

	for (const [itemId, group] of grouped) {
		emittedIds.add(itemId);
		result.push({
			type: "reasoning",
			id: group.itemId,
			encrypted_content: group.encryptedContent ?? null,
			summary: group.summaryTexts.map((text) => ({
				type: "summary_text",
				text,
			})),
		});
	}
}

// === Responses API history converter ===

/**
 * Convert standard Chat Completions history to Responses API format.
 * Transforms:
 *   - { role: "system" }  → { role: "developer" }
 *   - { role: "tool" }    → { type: "function_call_output", call_id, output }
 *   - { role: "assistant", tool_calls } → separate { type: "function_call" } items + text
 */
function convertHistoryToResponsesApi(messages: OAIMessage[]): OAIMessage[] {
	const result: OAIMessage[] = [];
	// Track emitted reasoning item IDs to deduplicate (same itemId across multiple blocks)
	const emittedReasoningIds = new Set<string>();
	for (const msg of messages) {
		// biome-ignore lint/suspicious/noExplicitAny: Responses API uses different message shapes
		const m = msg as any;

		if (m.role === "system") {
			result.push({ role: "developer", content: m.content } as unknown as OAIMessage);
		} else if (m.role === "user") {
			// Convert user message content to Responses API format
			const content =
				typeof m.content === "string"
					? [{ type: "input_text", text: m.content }]
					: Array.isArray(m.content)
						? m.content.map((part: OAIContentPart) => {
								if (part.type === "text") {
									return { type: "input_text", text: part.text };
								}
								if (part.type === "image_url") {
									return { type: "input_image", image_url: part.image_url.url };
								}
								return part;
							})
						: [{ type: "input_text", text: String(m.content ?? "") }];
			result.push({ role: "user", content } as unknown as OAIMessage);
		} else if (m.role === "tool") {
			result.push({
				type: "function_call_output",
				call_id: m.tool_call_id,
				output: typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? ""),
			} as unknown as OAIMessage);
		} else if (m.role === "assistant" && m.tool_calls?.length) {
			// Split assistant message with tool_calls into reasoning + text + separate function_call items
			// Emit reasoning items first (before text/tool_calls)
			emitReasoningItems(m._reasoningBlocks, result, emittedReasoningIds);
			if (m.content) {
				const content =
					typeof m.content === "string" ? [{ type: "output_text", text: m.content }] : m.content;
				result.push({ role: "assistant", content } as unknown as OAIMessage);
			}
			for (const tc of m.tool_calls as OAIToolCall[]) {
				result.push({
					type: "function_call",
					call_id: tc.id,
					name: tc.function.name,
					arguments: tc.function.arguments,
				} as unknown as OAIMessage);
			}
		} else if (m.role === "assistant") {
			// Assistant message without tool calls — convert content to array format.
			// Skip null/empty content because Responses API rejects role messages
			// whose content is null.
			// Emit reasoning items first
			emitReasoningItems(m._reasoningBlocks, result, emittedReasoningIds);
			if (typeof m.content === "string") {
				if (!m.content) continue;
				result.push({
					role: "assistant",
					content: [{ type: "output_text", text: m.content }],
				} as unknown as OAIMessage);
				continue;
			}
			if (Array.isArray(m.content) && m.content.length > 0) {
				result.push({ role: "assistant", content: m.content } as unknown as OAIMessage);
			}
		} else if (m.type === "function_call_output" || m.type === "function_call") {
			// Already in Responses API format — pass through
			result.push(msg);
		} else {
			result.push(msg);
		}
	}
	return result;
}
