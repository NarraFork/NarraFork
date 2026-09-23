import { readFileSync } from "node:fs";
import { normalizePolicyViolationCode } from "@shared/agent-protocol/policy-violation";
import { signatureSourcesCompatible } from "@shared/agent-protocol/reasoning-source";
import { outputToText } from "@shared/agent-protocol/tool-output";
import { modelTextFromContentBlocks } from "@shared/native-injection";
import { hasCredentialBoundReasoning } from "@shared/reasoning-credentials";
import { mapGenericReasoningEffort } from "@shared/reasoning-effort-support";
import { getInstallationId } from "../installation-id";
import { logger } from "../logger";
import { applyProxyExemptions, resolveProxyForUrl } from "../net/proxy";
import { getToolMessage, type Locale } from "../prompt-i18n";
import { isNativeSearchChannelFirstEnabled } from "../search/native";
import type { OpenAIProviderConfig } from "../settings";
import { getReasoningEffortBlocklist, parseModelId, settings } from "../settings";
import { readWithTimeout } from "../stream-timeout";
import { getImagePath, imageToBase64 } from "../uploads";
import { extractOpenAIUsage } from "../usage-tracking";
import { getHttpCodexUserAgent, getHttpUserAgent, resolveClientFingerprint } from "../user-agent";
import { applyCodexStableRequestFields, createCodexRequestIdentity } from "./codex-request";
import {
	type CodexResponsesRequestBody,
	CodexWebSocketFallbackError,
	streamCodexResponsesWebSocket,
} from "./codex-websocket";
import { fetchWithNetworkDiagnostics } from "./diagnostic-fetch";
import { parseErrorDiagnostics, parseUpstreamErrorEnvelope } from "./error-diagnostics";
import {
	classifyInvalidState,
	isCompletionLimitReason,
	ProviderInvalidStateError,
} from "./error-handling";
import { isGatewayEventType, parseGatewayDataEvent, parseGatewaySSEEvent } from "./gateway-events";
import { buildImageGenerationSavedPathInstruction } from "./image-generation";
import { buildOpencodeSessionHeader } from "./opencode-session";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
	ProviderTextCitation,
} from "./provider";
import {
	assertModelInputModalities,
	effectiveProviderMetadata,
	resolveMetadataReasoning,
	resolveOutputTokenLimit,
} from "./provider-model-metadata";
import { BoundedUtf8Capture, captureResponseStream, sanitizeHeaders } from "./request-dump";
import { parseJsonTextWithBody } from "./response-body";
import { resolveToolJsonSchema } from "./tool-registry";
import {
	type AgentToolUse,
	ApiError,
	isDeepSeekModel,
	mapDeepSeekEffort,
	type ResolvedToolDefinition,
} from "./types";
import {
	omitUnsupportedParameters,
	parseUnsupportedParameter,
	stripUnsupportedParameter,
	withUnsupportedParameterFallback,
} from "./unsupported-parameter-fallback";

export type OpenAIApiMode = "responses" | "completions" | "codex";

export function applyOpenAIModelMetadata(
	body: Record<string, unknown>,
	model: string,
	apiMode: OpenAIApiMode,
	requested?: number,
): void {
	const metadata = effectiveProviderMetadata(model);
	const limit = resolveOutputTokenLimit(metadata, requested);
	if (limit !== undefined)
		body[apiMode === "completions" ? "max_tokens" : "max_output_tokens"] = limit;
	if (metadata.reasoning?.supported === false) {
		delete body.reasoning;
		delete body.reasoning_effort;
		delete body.thinking;
	}
	omitUnsupportedParameters(body, model);
	if (
		metadata.reasoning?.mode === "fixed" &&
		body.reasoning &&
		typeof body.reasoning === "object" &&
		(body.reasoning as { effort?: string }).effort !== "none"
	) {
		delete (body.reasoning as Record<string, unknown>).effort;
	} else if (
		metadata.reasoning?.canDisable === false &&
		(body.reasoning as { effort?: string } | undefined)?.effort === "none"
	) {
		delete (body.reasoning as Record<string, unknown>).effort;
	}
	assertModelInputModalities(model, body, metadata);
}

function parsedUsageToUsageData(usage: unknown): GenerateMetaResult["usage"] {
	if (typeof usage !== "object" || usage === null) return null;
	const data = usage as Record<string, unknown>;
	const details =
		typeof data.output_tokens_details === "object" && data.output_tokens_details !== null
			? (data.output_tokens_details as Record<string, unknown>)
			: undefined;
	const inputDetails =
		typeof data.input_tokens_details === "object" && data.input_tokens_details !== null
			? (data.input_tokens_details as Record<string, unknown>)
			: undefined;
	const numberValue = (...keys: string[]) => {
		for (const key of keys) {
			const value = data[key];
			if (typeof value === "number") return value;
		}
		return undefined;
	};
	return {
		inputTokens: numberValue("inputTokens", "promptTokens", "input_tokens", "prompt_tokens") ?? 0,
		outputTokens:
			numberValue("completionTokens", "outputTokens", "completion_tokens", "output_tokens") ?? 0,
		cachedInputTokens:
			numberValue("cachedInputTokens", "cached_input_tokens") ??
			(typeof inputDetails?.cached_tokens === "number" ? inputDetails.cached_tokens : 0),
		cacheCreationInputTokens:
			numberValue("cacheCreationInputTokens", "cache_creation_input_tokens") ?? 0,
		cacheCreation5mInputTokens:
			numberValue("cacheCreation5mTokens", "cache_creation_5m_tokens") ?? 0,
		cacheCreation1hInputTokens:
			numberValue("cacheCreation1hTokens", "cache_creation_1h_tokens") ?? 0,
		reasoningTokens:
			numberValue("reasoningTokens", "reasoning_tokens") ??
			(typeof details?.reasoning_tokens === "number" ? details.reasoning_tokens : 0),
	};
}

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

export const CODEX_IMAGE_GENERATION_PARTIAL_IMAGES = 2;
// Existing Codex server-tool compatibility, NOT model input/output modalities.
// The image_generation tool delegates generation; text-only model output does
// not mean that tool is unavailable, and image input does not prove it exists.
const CODEX_MODELS_WITHOUT_IMAGE_GENERATION_TOOL = new Set(["gpt-5.3-codex-spark"]);

function hasNativeTool(tools: unknown[], type: string): boolean {
	return tools.some((tool) => {
		if (!tool || typeof tool !== "object") return false;
		return (tool as { type?: unknown }).type === type;
	});
}

function removeNativeTool(tools: unknown[], type: string): void {
	for (let i = tools.length - 1; i >= 0; i--) {
		const tool = tools[i];
		if (tool && typeof tool === "object" && (tool as { type?: unknown }).type === type) {
			tools.splice(i, 1);
		}
	}
}

function applyCodexImageGenerationDefaults(tools: unknown[]): void {
	for (const tool of tools) {
		if (!tool || typeof tool !== "object") continue;
		const record = tool as Record<string, unknown>;
		if (record.type !== "image_generation") continue;
		if (record.output_format === undefined) record.output_format = "png";
		if (record.partial_images === undefined) {
			record.partial_images = CODEX_IMAGE_GENERATION_PARTIAL_IMAGES;
		}
	}
}

export function supportsCodexImageGeneration(model: string): boolean {
	return !CODEX_MODELS_WITHOUT_IMAGE_GENERATION_TOOL.has(parseModelId(model).model);
}

export function appendCodexNativeTools(
	tools: unknown[],
	model: string,
	options?: { webSearch?: boolean; imageGeneration?: boolean },
): void {
	if (
		options?.webSearch === false ||
		effectiveProviderMetadata(model).nativeSearch?.supported === false
	) {
		removeNativeTool(tools, "web_search");
	} else if (!hasNativeTool(tools, "web_search")) {
		tools.push({ type: "web_search" });
	}
	if (options?.imageGeneration === false) {
		removeNativeTool(tools, "image_generation");
		return;
	}
	if (!supportsCodexImageGeneration(model)) return;
	if (!hasNativeTool(tools, "image_generation")) {
		tools.push({
			type: "image_generation",
			output_format: "png",
			partial_images: CODEX_IMAGE_GENERATION_PARTIAL_IMAGES,
		});
		return;
	}
	applyCodexImageGenerationDefaults(tools);
}

/** Declared catalog tiers constrain requests; unknown models keep the selected effort. */
export function normalizeCodexReasoningEffort(
	model: string,
	reasoningEffort: string | undefined,
): string | undefined {
	return resolveMetadataReasoning(effectiveProviderMetadata(model), reasoningEffort);
}

/**
 * Resolve the effort value sent on a Codex Responses request, falling back to
 * the configured default. Shared with CodexProvider so both entry points send
 * the same value for the same settings.
 */
export function resolveCodexRequestReasoningEffort(
	model: string,
	reasoningEffort?: string,
): string {
	return (
		normalizeCodexReasoningEffort(
			model,
			reasoningEffort ??
				effectiveProviderMetadata(model).reasoning?.defaultLevel ??
				settings.agent.defaultReasoningEffort ??
				"max",
		) ?? "none"
	);
}

/**
 * Apply a reasoning-effort hint on the two generic (non-Codex) wire formats.
 *
 * Blacklist policy: every model gets a hint unless it is excluded. Previously
 * `completions` only spoke to DeepSeek and plain `responses` sent nothing at
 * all, which hid the tier menu for every other third-party model.
 *
 * Three shapes, because the field names are not interchangeable:
 *   - DeepSeek (completions): `thinking` block + `reasoning_effort`, and only
 *     high/max are accepted upstream.
 *   - Responses-compatible: `reasoning.effort`, matching the OpenAI Responses
 *     schema that these relays emulate. `encrypted_content` is NOT requested —
 *     that is a Codex-specific include handled on the Codex path.
 *   - Completions-compatible: the de-facto `reasoning_effort` top-level field.
 */
function applyGenericReasoningEffort(
	body: Record<string, unknown>,
	apiMode: OpenAIApiMode,
	model: string,
	reasoningEffort: string | undefined,
): void {
	const metadata = effectiveProviderMetadata(model);
	reasoningEffort = resolveMetadataReasoning(metadata, reasoningEffort);
	if (!reasoningEffort) return;
	const bareModel = parseModelId(model).model;

	// DeepSeek keeps its own wire shape (thinking block + two effective tiers).
	if (!usesResponsesEndpoint(apiMode) && isDeepSeekModel(bareModel)) {
		if (reasoningEffort === "none") {
			body.thinking = { type: "disabled" };
			return;
		}
		body.thinking = { type: "enabled" };
		const effort = mapDeepSeekEffort(reasoningEffort);
		if (effort) body.reasoning_effort = effort;
		return;
	}

	const effort = metadata.reasoning?.levels?.length
		? reasoningEffort
		: mapGenericReasoningEffort(bareModel, reasoningEffort, getReasoningEffortBlocklist());
	if (!effort) return;
	if (usesResponsesEndpoint(apiMode)) {
		body.reasoning = { effort, summary: "auto" };
		return;
	}
	body.reasoning_effort = effort;
}

/**
 * Reasoning options for the non-Codex one-shot generate paths.
 *
 * Codex never reaches here: its utility requests go through
 * applyCodexStableRequestFields so the HTTP, WebSocket and utility transports
 * all share one body contract.
 */
function applyGenerateReasoningOptions(
	body: Record<string, unknown>,
	apiMode: OpenAIApiMode,
	model: string,
	options?: GenerateOptions,
): void {
	applyGenericReasoningEffort(body, apiMode, model, options?.reasoningEffort);
}

// === OpenAI identity prompt ===
// OpenAI models need an explicit identity and tool-use instruction in the system prompt.
// Unlike Claude which receives tool definitions via protocol-level fields,
// OpenAI models benefit from system-level guidance to actively use their tools.

const OPENAI_IDENTITY: Record<string, string> = {
	en: `You are an AI coding assistant with access to tools for reading, writing, and editing files, running shell commands, searching codebases, and more. You MUST use your tools to accomplish tasks — do not just describe what you would do. When the user asks you to do something, take action by calling the appropriate tools. For example, use Read to examine files, Write/Edit to modify them, Bash to run commands, Glob/Grep to search, etc.`,
	"zh-CN": `你是一个 AI 编程助手，拥有读取、写入和编辑文件、运行 shell 命令、搜索代码库等工具。你必须使用工具来完成任务——不要只是描述你会做什么。当用户要求你做某事时，请通过调用相应的工具来采取行动。例如，使用 Read 查看文件，Write/Edit 修改文件，Bash 运行命令，Glob/Grep 搜索等。`,
};

// === Codex identity prompt ===
// Codex models (gpt-5.x-codex) use a specialized prompt inspired by OpenCode's codex_header.txt.
// This prompt emphasizes concise, action-oriented behavior with minimal formatting.

export const CODEX_DEFAULT_INSTRUCTIONS =
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

export type OAIContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string }; imageRef?: string }
	| { type: "input_text"; text: string }
	| { type: "input_image"; image_url: string; imageRef?: string }
	| { type: "output_text"; text: string };

interface ResponsesToolImage {
	format: string;
	base64: string;
}

interface ResponsesFunctionCallOutputMessage {
	type: "function_call_output";
	call_id: string;
	output: string;
	_images?: ResponsesToolImage[];
}

export interface OAIMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OAIContentPart[] | null;
	tool_calls?: OAIToolCall[];
	tool_call_id?: string;
	/**
	 * reasoning_content field for Chat Completions API.
	 * Some models (e.g. DeepSeek, QwQ) return reasoning_content in their responses
	 * and require it to be passed back in subsequent requests.
	 */
	reasoning_content?: string | null;
	/** Reasoning blocks from the assistant message (used for Responses API replay/fallback). */
	_reasoningBlocks?: Array<{
		text: string;
		providerMetadata?: import("./types").ReasoningProviderMetadata;
	}>;
	/** Plain-text reasoning summary fallback when Responses API reasoning items cannot be replayed. */
	_reasoningTextFallback?: string;
}

export interface OAIToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

interface OAITool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

type ResponsesReasoningBlock = {
	text: string;
	providerMetadata?: import("./types").ReasoningProviderMetadata;
	outputIndex?: number;
};

type ResponsesWebSearchBlock = {
	id: string;
	query?: string;
	queries?: string[];
	outputIndex?: number;
	action?: import("./provider").WebSearchAction;
};

type ResponsesImageGenerationBlock = {
	id: string;
	revisedPrompt?: string;
	result?: string;
	outputIndex?: number;
};

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
	/** Native Responses output position when a gateway uses the legacy envelope. */
	output_index?: number;
	choices?: Array<{ index: number; delta: OAIDelta; finish_reason?: string | null }>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
		prompt_tokens_details?: { cached_tokens?: number };
	};
	error?: {
		message?: string;
		type?: string;
		code?: string | number;
		statusCode?: number;
		status_code?: number;
	};
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

	/** Whether to use Responses WebSocket for codex mode (experimental). */
	private useWebSocket: boolean;

	/**
	 * The model the current chat() run targets. Remembered so the synchronous
	 * pushAssistantTurn — which has no model parameter — can classify reasoning
	 * blocks the same way (strict credential handling vs plain-text relay).
	 */
	private activeModel?: string;

	/** Reasoning-source identity override (NUG injects its channel identity). */
	private reasoningSourceOverride?: string;

	constructor(config: OpenAIProviderConfig, proxy?: string) {
		this.config = config;
		this.apiMode = resolveApiMode(config);
		this.proxy = proxy;
		this.useWebSocket = !!(config.codexWebSocket && this.apiMode === "codex");
		this.activeModel = config.defaultModel;
	}

	/** Remember the model a chat() run targets (see {@link activeModel}). */
	noteActiveModel(model: string): void {
		this.activeModel = model;
	}

	/**
	 * The upstream identity reasoning credentials should be attributed to. A
	 * direct provider is its own prefix; a NUG delegate overrides it with the
	 * NUG channel identity so encrypted content minted by one channel is never
	 * replayed to another.
	 */
	getActiveReasoningSource(): string | undefined {
		return this.reasoningSourceOverride ?? this.config.prefix;
	}

	setReasoningSourceOverride(source: string | undefined): void {
		this.reasoningSourceOverride = source;
	}

	/** Convenience: does the current mode use Responses API message format? */
	private get responsesFormat(): boolean {
		return usesResponsesFormat(this.apiMode);
	}

	private get codexWebSearchEnabled(): boolean {
		return this.config.codexWebSearch ?? true;
	}

	private get codexImageGenerationEnabled(): boolean {
		return this.config.codexImageGeneration ?? true;
	}

	/**
	 * Proxy-aware fetch. Precedence:
	 *   1. `this.proxy` — an already-resolved fixed proxy string passed by the
	 *      constructor (only Codex does this; reused for HTTP + WebSocket).
	 *   2. otherwise `this.config.proxy` — this provider's own ProxyOverride
	 *      (absent/"default" → global policy).
	 * Both paths apply loopback/NO_PROXY exemptions per target URL.
	 */
	private pfetch(input: string | URL | Request, init?: RequestInit): Promise<Response> {
		const target = input instanceof Request ? input.url : input;
		const proxy = this.proxy
			? applyProxyExemptions(this.proxy, target)
			: resolveProxyForUrl(target, this.config.proxy);
		return fetchWithNetworkDiagnostics(input, init, { proxy });
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
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		if (this.responsesFormat) {
			return await buildResponsesHistory(dbMessages, narratorId, {
				strict: hasCredentialBoundReasoning(model),
				currentSource: this.getActiveReasoningSource(),
			});
		}
		const result = buildOAIHistory(dbMessages);
		// Chat Completions path: reasoning replay policy is inverted from a
		// DeepSeek exemption to a credential-strictness split:
		//   - Non-strict relay models (GLM, Kimi, MiniMax, QwQ, DeepSeek…) treat
		//     reasoning as plain text: merge `_reasoningBlocks` back into
		//     `reasoning_content` so the model sees its own prior thoughts.
		//   - Credential-strict models (Claude-family ids, official OpenAI ids)
		//     never send `reasoning_content`: the official API rejects the field,
		//     and without valid encrypted credentials the reasoning is dropped.
		const strict = hasCredentialBoundReasoning(model);
		for (const msg of result.history) {
			// biome-ignore lint/suspicious/noExplicitAny: OAIMessage has _reasoningBlocks
			const m = msg as any;
			if (m._reasoningBlocks) {
				if (!strict && !m.reasoning_content) {
					const reasoningText = m._reasoningBlocks
						.map((b: { text: string }) => b.text)
						.join("\n\n");
					if (reasoningText) {
						m.reasoning_content = reasoningText;
					}
				}
				delete m._reasoningBlocks;
			}
			if (m._reasoningTextFallback !== undefined) {
				delete m._reasoningTextFallback;
			}
			// Relay thinking models require reasoning_content on ALL assistant
			// messages (not just those with tool_calls). When switching from a
			// non-thinking model, historical messages lack this field — patch
			// with empty string so the API doesn't reject the request.
			if (!strict && m.role === "assistant" && m.reasoning_content == null) {
				m.reasoning_content = "";
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
		// Use WebSocket mode for codex if enabled
		if (this.useWebSocket) {
			yield* this.chatCodexWebSocket(params);
			return;
		}

		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey && !this.config.authorizationHeader?.trim()) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const history = params.history as OAIMessage[];
		const tools = params.tools as OAITool[];

		// Build messages: history + pending tool results + current user message
		const messages: OAIMessage[] = [...history];

		// Append tool results
		if (this.responsesFormat) {
			for (const tr of params.toolResults as ResponsesFunctionCallOutputMessage[]) {
				logger.debug("OpenAI appending Responses API tool result", {
					type: tr.type,
					call_id: tr.call_id,
					outputLength: tr.output?.length,
					hasImages: Array.isArray(tr._images) && tr._images.length > 0,
				});
				messages.push(...expandResponsesToolResultMessage(tr));
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

		// Append current user message (skip "." continuation markers unless images are attached)
		const currentUserMessage = buildOAIUserMessage(params.content, params.images);
		if (currentUserMessage) {
			messages.push(currentUserMessage);
		} else if (params.toolResults.length === 0 && params.content) {
			// 仅当确有非空文本时才发送用户消息：空 content 在 Responses API 下会生成
			// text 为空字符串的 input_text 项，部分 responses 兼容上游会以
			// "missing input.content.text" 拒绝（见续跑/重试场景的批量 400）。
			messages.push({ role: "user", content: params.content });
		}

		// ── Build request body & endpoint based on apiMode ──
		const model = parseModelId(params.model).model;
		this.noteActiveModel(model);
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

			const sanitizedInputMessages = inputMessages.filter((msg) => {
				if (msg.role !== "assistant") return true;
				// Responses API rejects assistant role messages with null/empty content and no tool calls.
				const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
				if (hasToolCalls) return true;
				if (typeof msg.content === "string") return msg.content.length > 0;
				if (Array.isArray(msg.content)) return msg.content.length > 0;
				return false;
			});
			const responsesInput = convertHistoryToResponsesApi(sanitizedInputMessages, {
				strict: hasCredentialBoundReasoning(model),
				currentSource: this.getActiveReasoningSource(),
			});

			// Codex CLI sets store based on endpoint: false for standard OpenAI/ChatGPT
			// endpoints, true only for Azure OpenAI. Since we use the ChatGPT backend
			// (chatgpt.com/backend-api/codex), store must be false.
			// With store: false the server does not persist responses, so
			// previous_response_id is unsupported — always send full history.
			body = { model, input: responsesInput, stream: true, store: false };

			if (instructions) {
				body.instructions = instructions;
			} else if (this.apiMode === "codex") {
				// Codex gateway requires non-empty instructions even for pure tool/result turns.
				body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
			}
			if (tools.length > 0) body.tools = tools;

			// Codex: inject native server-side tools only when the selected model supports them.
			if (this.apiMode === "codex") {
				const toolsArr = (body.tools ?? []) as unknown[];
				appendCodexNativeTools(toolsArr, params.model, {
					webSearch: this.codexWebSearchEnabled && isNativeSearchChannelFirstEnabled(),
					imageGeneration: this.codexImageGenerationEnabled,
				});
				body.tools = toolsArr;
			}

			const normalizedCodexReasoningEffort =
				this.apiMode === "codex"
					? resolveCodexRequestReasoningEffort(params.model, params.reasoningEffort)
					: params.reasoningEffort;
			if (this.apiMode === "codex") {
				applyCodexStableRequestFields(body, {
					identity: createCodexRequestIdentity(params.conversationId),
					reasoningEffort: normalizedCodexReasoningEffort as string,
				});
			} else {
				// Plain responses-compatible relays: send the effort hint too. These
				// used to get nothing at all, so their tier menu was dead weight.
				applyGenericReasoningEffort(body, this.apiMode, params.model, params.reasoningEffort);
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
				reasoningEffort: normalizedCodexReasoningEffort,
				originalReasoningEffort: params.reasoningEffort,
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

			// Reasoning effort: DeepSeek keeps its `thinking` block shape, every
			// other model gets the plain `reasoning_effort` field. Previously only
			// DeepSeek was handled here, so GLM/Kimi/MiniMax and friends behind a
			// completions-compatible relay never received the tier the user picked.
			applyGenericReasoningEffort(body, this.apiMode, params.model, params.reasoningEffort);
		}

		applyOpenAIModelMetadata(body, params.model, this.apiMode, params.maxOutputTokens);
		const requestHeaders = this.buildHeaders(apiKey, params.conversationId);

		// One strip-and-retry for endpoints that reject an optional request field
		// (observed: NUG Responses relays refusing `max_output_tokens`). Only safe
		// before any stream event has been yielded — after that the consumer has
		// already seen partial output and a silent re-send would duplicate it.
		for (let attempt = 0; ; attempt++) {
			params.requestDump?.beginResponseAttempt(
				{
					transport: "http",
					url: endpoint,
					headers: sanitizeHeaders(requestHeaders),
					body,
				},
				settings.agent?.requestDumpMaxSize,
			);

			const bodyText = JSON.stringify(body);
			params.onRequestStart?.();
			const response = await this.pfetch(endpoint, {
				method: "POST",
				headers: requestHeaders,
				body: bodyText,
				signal: params.signal,
			}).catch((error) => {
				params.requestDump?.setResponseError(error);
				params.requestDump?.finishResponseCapture(false);
				if (attempt === 0 && stripUnsupportedParameter(body, params.model, error)) return null;
				throw error;
			});
			if (!response) continue;

			params.requestDump?.setResponseMeta({
				status: response.status,
				headers: sanitizeHeaders(response.headers),
			});

			if (!response.body) {
				const error = response.ok
					? new Error("OpenAI API returned no body")
					: createOpenAIApiError(response, "");
				params.requestDump?.setResponseError(error);
				params.requestDump?.finishResponseCapture(false);
				if (attempt === 0 && stripUnsupportedParameter(body, params.model, error)) continue;
				throw error;
			}
			const capture = captureResponseStream(response.body, params.requestDump);
			let yieldedEvent = false;
			try {
				if (!response.ok) {
					const errorCapture = new BoundedUtf8Capture();
					const reader = capture.stream.getReader();
					try {
						while (errorCapture.received < errorCapture.limit) {
							const { done, value } = await readWithTimeout(reader);
							if (done) break;
							errorCapture.append(value);
						}
					} finally {
						void reader.cancel().catch(() => {});
					}
					const error = createOpenAIApiError(response, errorCapture.text());
					if (attempt === 0 && stripUnsupportedParameter(body, params.model, error)) continue;
					throw error;
				}
				if (usesResponsesEndpoint(this.apiMode)) {
					for await (const evt of _parseResponsesAPIStream(capture.stream)) {
						// A field-rejection can arrive as HTTP 200 + SSE error. Throw before
						// any consumer-visible event so the outer strip-and-retry can run;
						// after content starts, a silent re-send would duplicate output.
						if (
							!yieldedEvent &&
							evt.invalidState &&
							parseUnsupportedParameter(evt.invalidState.message)
						) {
							throw new ProviderInvalidStateError(
								evt.invalidState.reason,
								evt.invalidState.message,
								{ diagnostics: evt.invalidState.diagnostics },
							);
						}
						yieldedEvent = true;
						yield stampReasoningSource(evt, this.getActiveReasoningSource());
					}
				} else {
					for await (const evt of this.parseSSEStreamWithDetection(capture.stream)) {
						yieldedEvent = true;
						yield evt;
					}
				}
				return;
			} catch (error) {
				params.requestDump?.setResponseError(error);
				if (
					attempt === 0 &&
					!yieldedEvent &&
					stripUnsupportedParameter(body, params.model, error)
				) {
					continue;
				}
				throw error;
			} finally {
				capture.finish();
			}
		}
	}

	/**
	 * Whether the model a chat() run targets (falling back to the configured
	 * default) treats reasoning as credential-bound. Drives the retention
	 * split: strict models drop uncredentialed reasoning, relay models echo
	 * the plain text back.
	 */
	private isCredentialStrict(): boolean {
		return hasCredentialBoundReasoning(this.activeModel ?? this.config.defaultModel ?? "");
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
		images?: Array<{ format: string; base64: string }>,
	): unknown {
		// Removed debug log to prevent log spam in high-frequency scenarios
		if (this.responsesFormat) {
			return buildResponsesToolResultMessage(toolUseId, output, images);
		}
		return { tool_call_id: toolUseId, content: output } satisfies OAIToolResult;
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		_model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		const h = history as OAIMessage[];
		if (this.responsesFormat) {
			for (const tr of toolResults as ResponsesFunctionCallOutputMessage[]) {
				h.push(...expandResponsesToolResultMessage(tr));
			}
			const userMessage = buildOAIUserMessage(content, images);
			if (userMessage) h.push(userMessage);
			return;
		}
		for (const tr of toolResults as OAIToolResult[]) {
			h.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
		}
		const userMessage = buildOAIUserMessage(content, images);
		if (userMessage) h.push(userMessage);
	}

	pushAssistantTurn(
		history: unknown[],
		text: string,
		toolUses: AgentToolUse[],
		reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
			outputIndex?: number;
		}>,
		webSearches?: Array<{
			id: string;
			query?: string;
			queries?: string[];
			outputIndex?: number;
			action?: import("./provider").WebSearchAction;
		}>,
		messageId?: string,
		imageGenerations?: Array<{
			id: string;
			revisedPrompt?: string;
			result?: string;
			outputIndex?: number;
		}>,
		textOutputIndex?: number,
		_redactedThinkingBlocks?: Parameters<ProviderAdapter["pushAssistantTurn"]>[8],
		orderedContent?: readonly import("./types").ContentBlock[],
	): void {
		const h = history as OAIMessage[];
		if (orderedContent && this.responsesFormat) {
			// Reuse history replay's source validation and native-item serialization,
			// but never sort the accumulator's encounter order or split a reasoning item.
			const orderedTools = orderedContent.filter((block) => block.type === "tool_use");
			h.push(
				...buildResponsesAssistantItemsFromStoredContent(
					{
						id: "",
						role: "assistant",
						contentText: null,
						parentToolUseId: null,
						messageUuid: messageId ?? null,
						contentJson: orderedContent.map((block) =>
							block.type === "tool_use" ? { ...block, id: block.toolUseId } : block,
						),
						toolCalls: orderedTools.map((tool) => ({
							toolUseId: tool.toolUseId,
							toolName: tool.name,
							inputJson: tool.input,
							outputJson: null,
							status: "success",
						})),
					},
					{ strict: this.isCredentialStrict(), currentSource: this.getActiveReasoningSource() },
					true,
				),
			);
			return;
		}
		if (orderedContent) {
			// Chat Completions has no interleaved-content wire representation. Keep
			// every text/reasoning fragment in encounter order inside its native lane.
			text = orderedContent
				.filter((block) => block.type === "text")
				.map((block) => block.text)
				.join("");
			reasoningBlocks = orderedContent.filter((block) => block.type === "reasoning");
			toolUses = orderedContent.filter((block) => block.type === "tool_use");
		}
		if (this.responsesFormat) {
			const items = buildResponsesAssistantTurnItems(
				text,
				toolUses,
				reasoningBlocks,
				webSearches,
				messageId,
				imageGenerations,
				textOutputIndex,
				this.isCredentialStrict(),
			);
			for (const item of items) {
				// biome-ignore lint/suspicious/noExplicitAny: Responses API message shape
				h.push(item as any);
			}
		} else {
			// Use empty string instead of null: although the official OpenAI spec
			// allows content:null when tool_calls is present, many OpenAI-compatible
			// endpoints (local inference servers, translating proxies/gateways) reject
			// null content outright. An empty string is accepted everywhere.
			const msg: OAIMessage = { role: "assistant", content: text || "" };
			if (toolUses.length > 0) {
				msg.tool_calls = toolUses.map((tu) => ({
					id: tu.toolUseId,
					type: "function" as const,
					function: { name: tu.name, arguments: JSON.stringify(tu.input) },
				}));
			}
			// Pass reasoning_content back for relay models that replay reasoning as
			// plain text (DeepSeek, QwQ, GLM, Kimi…). Credential-strict models must
			// not receive the field at all — the official API rejects it.
			if (!this.isCredentialStrict() && reasoningBlocks?.length) {
				const reasoningText = reasoningBlocks.map((b) => b.text).join("\n\n");
				if (reasoningText) {
					msg.reasoning_content = reasoningText;
				}
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
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey && !this.config.authorizationHeader?.trim()) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const bareModel = parseModelId(model).model;

		if (usesResponsesEndpoint(this.apiMode)) {
			const body: Record<string, unknown> = {
				model: bareModel,
				input: [{ role: "user", content: text }],
				store: false,
			};
			const codexIdentity = this.apiMode === "codex" ? createCodexRequestIdentity() : undefined;
			if (systemInstruction) {
				body.instructions = systemInstruction;
			} else if (this.apiMode === "codex") {
				// Codex gateway requires non-empty instructions on /responses.
				body.instructions = CODEX_DEFAULT_INSTRUCTIONS;
			}
			// Responses and Codex lightweight generation always use the streaming API.
			body.stream = true;
			if (codexIdentity) {
				applyCodexStableRequestFields(body, {
					identity: codexIdentity,
					reasoningEffort: resolveCodexRequestReasoningEffort(model, options?.reasoningEffort),
				});
			} else {
				applyGenerateReasoningOptions(body, this.apiMode, model, options);
			}
			applyOpenAIModelMetadata(body, model, this.apiMode, options?.maxOutputTokens);
			const conversationId = codexIdentity?.conversationId;
			return withUnsupportedParameterFallback(model, body, (retryBody) =>
				this.requestResponsesTextWithMeta(
					baseUrl,
					apiKey,
					retryBody,
					options?.signal,
					options,
					conversationId,
				),
			);
		}

		// Completions: POST /chat/completions
		const messages: Array<{ role: "system" | "user"; content: string }> = [];
		if (systemInstruction) {
			messages.push({ role: "system", content: systemInstruction });
		}
		messages.push({ role: "user", content: text });
		const body: Record<string, unknown> = {
			model: bareModel,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		applyGenerateReasoningOptions(body, this.apiMode, model, options);
		applyOpenAIModelMetadata(body, model, this.apiMode, options?.maxOutputTokens);
		return withUnsupportedParameterFallback(model, body, (retryBody) =>
			this.requestChatCompletionsTextWithMeta(baseUrl, apiKey, retryBody, options?.signal, options),
		);
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<string> {
		const result = await this.generateWithHistoryWithMeta(
			systemInstruction,
			content,
			model,
			locale,
			options,
		);
		return result.text;
	}

	async generateWithHistoryWithMeta(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey && !this.config.authorizationHeader?.trim()) {
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
			const codexIdentity = this.apiMode === "codex" ? createCodexRequestIdentity() : undefined;
			// Responses and Codex lightweight generation always use the streaming API.
			body.stream = true;
			if (codexIdentity) {
				applyCodexStableRequestFields(body, {
					identity: codexIdentity,
					reasoningEffort: resolveCodexRequestReasoningEffort(model, options?.reasoningEffort),
				});
			} else {
				applyGenerateReasoningOptions(body, this.apiMode, model, options);
			}
			applyOpenAIModelMetadata(body, model, this.apiMode, options?.maxOutputTokens);
			const conversationId = codexIdentity?.conversationId;
			return withUnsupportedParameterFallback(model, body, (retryBody) =>
				this.requestResponsesTextWithMeta(
					baseUrl,
					apiKey,
					retryBody,
					options?.signal,
					options,
					conversationId,
				),
			);
		}

		// Completions
		const body: Record<string, unknown> = {
			model: bareModel,
			messages: [
				{ role: "system", content: systemInstruction },
				{ role: "user", content: `${reminder}\n\n${content}` },
			],
			stream: true,
			stream_options: { include_usage: true },
		};
		applyGenerateReasoningOptions(body, this.apiMode, model, options);
		applyOpenAIModelMetadata(body, model, this.apiMode, options?.maxOutputTokens);
		return withUnsupportedParameterFallback(model, body, (retryBody) =>
			this.requestChatCompletionsTextWithMeta(baseUrl, apiKey, retryBody, options?.signal, options),
		);
	}

	private async requestResponsesTextWithMeta(
		baseUrl: string,
		apiKey: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
		options?: GenerateOptions,
		conversationId?: string,
	): Promise<GenerateMetaResult> {
		if (body.stream !== true) {
			throw new Error("OpenAI lightweight Responses generation requires stream=true");
		}
		const response = await this.pfetch(`${baseUrl}/responses`, {
			method: "POST",
			headers: this.buildHeaders(apiKey, conversationId),
			body: JSON.stringify(body),
			signal,
		});
		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw createOpenAIApiError(response, errText);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		const looksJson = contentType.includes("application/json");
		if (looksJson) {
			const raw = await response.text();
			const json = parseResponsesJson(raw);
			const text = extractResponsesText(json.output);
			// Reuse stream error precedence: a policy/API failure is not a truncation.
			const invalid = parseResponsesAPIEvent({ response: json }, new Map(), new Map()).find(
				(event) => event.invalidState,
			)?.invalidState;
			const outputTruncated = !!text && !!invalid && isCompletionLimitReason(invalid.reason);
			if (invalid && !outputTruncated) {
				throw new ProviderInvalidStateError(invalid.reason, invalid.message, {
					diagnostics: invalid.diagnostics,
				});
			}
			if (text) await options?.onTextDelta?.(text);
			return {
				text,
				...(outputTruncated && { outputTruncated }),
				usage: parsedUsageToUsageData(json.usage),
			};
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		let text = "";
		let usage: GenerateMetaResult["usage"] = null;
		let outputTruncated = false;
		for await (const evt of _parseResponsesAPIStream(response.body)) {
			if (evt.text) {
				text += evt.text;
				await options?.onTextDelta?.(evt.text);
			}
			if (evt.reasoning) await options?.onReasoningDelta?.(evt.reasoning);
			if (evt.usage) usage = parsedUsageToUsageData(evt.usage);
			if (evt.invalidState) {
				if (text && isCompletionLimitReason(evt.invalidState.reason)) {
					outputTruncated = true;
					continue;
				}
				throw new ProviderInvalidStateError(
					evt.invalidState.reason,
					`OpenAI Responses stream error (${evt.invalidState.reason}): ${evt.invalidState.message}`,
					{ diagnostics: evt.invalidState.diagnostics },
				);
			}
		}
		return { text, usage, ...(outputTruncated && { outputTruncated }) };
	}

	private async requestChatCompletionsTextWithMeta(
		baseUrl: string,
		apiKey: string,
		body: Record<string, unknown>,
		signal?: AbortSignal,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		if (body.stream !== true) {
			throw new Error("OpenAI lightweight Chat Completions generation requires stream=true");
		}
		const response = await this.pfetch(`${baseUrl}/chat/completions`, {
			method: "POST",
			headers: this.buildHeaders(apiKey),
			body: JSON.stringify(body),
			signal,
		});

		if (!response.ok) {
			const errText = await response.text().catch(() => "");
			throw createOpenAIApiError(response, errText);
		}

		const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
		if (contentType.includes("application/json")) {
			const raw = await response.text();
			const json = parseJsonWithPreview<{
				choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
				error?: unknown;
				usage?: {
					prompt_tokens?: number;
					completion_tokens?: number;
					prompt_tokens_details?: { cached_tokens?: number };
					completion_tokens_details?: { reasoning_tokens?: number };
				};
			}>(raw, "OpenAI chat/completions returned non-JSON payload");
			const text = json.choices?.[0]?.message?.content ?? "";
			const finishReason = json.choices?.[0]?.finish_reason;
			const error = parseUpstreamErrorEnvelope(json);
			if (error) {
				throw new ProviderInvalidStateError(error.code ?? "api_error", error.message);
			}
			const outputTruncated = !!finishReason && isCompletionLimitReason(finishReason);
			if (
				(outputTruncated && !text) ||
				finishReason === "content_filter" ||
				finishReason === "model_context_window_exceeded"
			) {
				throw new ProviderInvalidStateError(
					finishReason ?? "api_error",
					`OpenAI Chat Completions stopped: ${finishReason}`,
				);
			}
			if (text) await options?.onTextDelta?.(text);
			return {
				text,
				...(outputTruncated && { outputTruncated }),
				contextPercent: undefined,
				usage: json.usage ? extractOpenAIUsage(json.usage) : null,
			};
		}

		if (!response.body) {
			throw new Error("OpenAI API returned no body");
		}

		let text = "";
		let usage: GenerateMetaResult["usage"] = null;
		let outputTruncated = false;
		for await (const evt of parseSSEStream(response.body)) {
			if (evt.text) {
				text += evt.text;
				await options?.onTextDelta?.(evt.text);
			}
			if (evt.reasoning) await options?.onReasoningDelta?.(evt.reasoning);
			if (evt.usage) usage = parsedUsageToUsageData(evt.usage);
			if (evt.invalidState) {
				if (text && isCompletionLimitReason(evt.invalidState.reason)) {
					outputTruncated = true;
					continue;
				}
				throw new ProviderInvalidStateError(
					evt.invalidState.reason,
					`OpenAI Chat Completions stream error (${evt.invalidState.reason}): ${evt.invalidState.message}`,
					{ diagnostics: evt.invalidState.diagnostics },
				);
			}
		}
		return { text, contextPercent: undefined, usage, ...(outputTruncated && { outputTruncated }) };
	}

	/**
	 * Resolve the client fingerprint (User-Agent + Codex/extra headers) for this
	 * provider.
	 *
	 * The Codex header set follows apiMode rather than a separate toggle: the
	 * codex transport already sends a codex UA, codex instructions, native codex
	 * tools and the stable codex body contract, so suppressing only these headers
	 * produced a shape no real client emits (body carrying an installation id
	 * while the matching header was absent). Operators who need a different
	 * identity use userAgentMode/extraHeaders, which still override everything here.
	 */
	private resolveFingerprint(conversationId?: string): {
		userAgent: string;
		headers: Record<string, string>;
	} {
		return resolveClientFingerprint({
			mode: this.config.userAgentMode,
			custom: this.config.customUserAgent,
			// Codex 中转 defaults to the Codex CLI identity; other OpenAI-shaped
			// protocols present as NarraFork unless the operator chose otherwise.
			fallback: this.apiMode === "codex" ? getHttpCodexUserAgent() : getHttpUserAgent(),
			extraHeaders: this.config.extraHeaders,
			installationId: this.apiMode === "codex" ? getInstallationId() : undefined,
			conversationId,
		});
	}

	/** Build common request headers, with Codex-specific extras. */
	private buildHeaders(apiKey: string, conversationId?: string): Record<string, string> {
		const fingerprint = this.resolveFingerprint(conversationId);
		const headers: Record<string, string> = {
			"Content-Type": "application/json",
			Authorization: this.config.authorizationHeader?.trim() || `Bearer ${apiKey}`,
			"User-Agent": fingerprint.userAgent,
		};
		if (this.apiMode === "codex") {
			// The Codex Responses transport is always streamed; the real CLI
			// explicitly advertises the expected SSE response media type.
			headers.Accept = "text/event-stream";
			const accountId = this.config.codexAccountId;
			// Only send ChatGPT-Account-Id to official ChatGPT domains
			if (accountId && this.isOfficialChatGPTDomain()) {
				headers["ChatGPT-Account-Id"] = accountId;
			}
		}
		// OpenCode Go serves both OpenAI shapes (/zen/go/v1/responses and
		// /chat/completions) and reads session identity only from its own header,
		// so it has to be added here rather than carried by the request body.
		Object.assign(
			headers,
			buildOpencodeSessionHeader({
				baseUrl: this.config.baseUrl,
				conversationId,
				extraHeaders: this.config.extraHeaders,
			}),
		);
		// Emulated codex headers + user-configured extra headers (user wins).
		Object.assign(headers, fingerprint.headers);
		// Runtime-dynamic headers last (e.g. the NUG client-relay channel id,
		// which rotates on every relay reconnect and must be read per request).
		Object.assign(headers, this.config.dynamicHeaders?.() ?? {});
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
	 * WebSocket-based chat for codex apiMode.
	 * Falls back to HTTP if WebSocket is unavailable.
	 */
	private async *chatCodexWebSocket(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const apiKey = await this.getEffectiveApiKey();
		const baseUrl = (this.config.baseUrl || defaultBaseUrl(this.apiMode)).replace(/\/+$/, "");

		if (!apiKey && !this.config.authorizationHeader?.trim()) {
			throw new Error(`OpenAI API key not configured for provider "${this.config.name}".`);
		}

		const request = this.buildCodexWebSocketRequest(params);
		const sessionKey = params.stickySessionKey ?? params.conversationId;
		const fingerprint = this.resolveFingerprint(params.conversationId);

		try {
			params.onRequestStart?.({ credentialId: this.config.id });
			for await (const event of streamCodexResponsesWebSocket({
				baseUrl,
				apiKey,
				authorization: this.config.authorizationHeader,
				accountId: this.config.codexAccountId,
				proxy: this.proxy,
				sessionKey,
				conversationId: params.conversationId,
				narratorId: params.stickySessionKey,
				credentialId: this.config.id,
				model: params.model,
				request,
				signal: params.signal,
				resetSessionBeforeRequest: params.resetUpstreamSession,
				userAgent: fingerprint.userAgent,
				extraHeaders: fingerprint.headers,
				requestDump: params.requestDump,
				requestDumpMaxBytes: settings.agent?.requestDumpMaxSize,
			})) {
				yield stampReasoningSource(event, this.getActiveReasoningSource());
			}
		} catch (err) {
			if (params.signal.aborted) throw err;
			if (err instanceof CodexWebSocketFallbackError) {
				logger.warn("OpenAI codex WebSocket unavailable, falling back to HTTP", {
					provider: this.config.name,
					status: err.status,
					error: err.message,
				});
				// Disable WebSocket for subsequent calls on this instance
				this.useWebSocket = false;
				yield* this.chat(params);
				return;
			}
			throw err;
		}
	}

	/** Build a Responses WebSocket request body from chat params (codex mode). */
	private buildCodexWebSocketRequest(params: ChatParams): CodexResponsesRequestBody {
		const model = parseModelId(params.model).model;
		const messages: OAIMessage[] = [...(params.history as OAIMessage[])];
		for (const tr of params.toolResults as Array<{
			type: string;
			call_id: string;
			output: string;
			_images?: Array<{ format: string; base64: string }>;
		}>) {
			messages.push({
				type: "function_call_output",
				call_id: tr.call_id,
				output: tr.output,
			} as unknown as OAIMessage);
			if (tr._images?.length) {
				messages.push({
					role: "user",
					content: tr._images.map((img) => ({
						type: "input_image",
						image_url: `data:image/${img.format};base64,${img.base64}`,
					})),
				} as unknown as OAIMessage);
			}
		}
		const currentUserMessage = buildOAIUserMessage(params.content, params.images);
		if (currentUserMessage) {
			messages.push(currentUserMessage);
		} else if (params.toolResults.length === 0 && params.content) {
			messages.push({ role: "user", content: params.content });
		}

		let instructions = "";
		const inputMessages: OAIMessage[] = [];
		for (const msg of messages) {
			// biome-ignore lint/suspicious/noExplicitAny: Responses API uses "developer" role
			const role = (msg as any).role;
			if (role === "system" || role === "developer") {
				if (typeof msg.content === "string") {
					instructions += (instructions ? "\n\n" : "") + msg.content;
				}
				continue;
			}
			inputMessages.push(msg);
		}

		const sanitizedInputMessages = inputMessages.filter((msg) => {
			if (msg.role !== "assistant") return true;
			const hasToolCalls = Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0;
			if (hasToolCalls) return true;
			if (typeof msg.content === "string") return msg.content.length > 0;
			if (Array.isArray(msg.content)) return msg.content.length > 0;
			return false;
		});

		const request: CodexResponsesRequestBody = {
			model,
			input: convertHistoryToResponsesApi(sanitizedInputMessages, {
				strict: hasCredentialBoundReasoning(model),
				currentSource: this.getActiveReasoningSource(),
			}),
			stream: true,
			store: false,
		};
		request.instructions = instructions || CODEX_DEFAULT_INSTRUCTIONS;
		const tools = Array.isArray(params.tools) ? [...params.tools] : [];
		appendCodexNativeTools(tools, params.model, {
			webSearch: this.codexWebSearchEnabled && isNativeSearchChannelFirstEnabled(),
			imageGeneration: this.codexImageGenerationEnabled,
		});
		request.tools = tools;

		applyCodexStableRequestFields(request, {
			identity: createCodexRequestIdentity(params.conversationId),
			reasoningEffort: resolveCodexRequestReasoningEffort(params.model, params.reasoningEffort),
		});
		if (params.serviceTier) {
			request.service_tier = params.serviceTier;
		}

		applyOpenAIModelMetadata(request, params.model, "codex", params.maxOutputTokens);
		return request;
	}

	/**
	 * Get the effective API key for requests.
	 * For standard API key auth, returns the configured API key.
	 */
	private async getEffectiveApiKey(): Promise<string> {
		return this.config.apiKey;
	}
}

/**
 * Parse JSON, keeping the raw body when it is not JSON.
 *
 * `errorPrefix` names the upstream. Throwing NonJsonResponseError (rather than a
 * bare Error with the preview only in the message) puts the body into the
 * structured diagnostics as well, so the model-test panel can show it instead of
 * only the parser's wording.
 */
function parseJsonWithPreview<T>(raw: string, errorPrefix: string): T {
	return parseJsonTextWithBody<T>(raw, {
		label: errorPrefix,
		status: 200,
		contentType: "application/json",
	});
}

/**
 * Extract a human-readable error message from an OpenAI API error response body.
 * Attempts to parse JSON and extract the nested error.message field;
 * falls back to the raw text if parsing fails or the field is missing.
 */
function extractApiErrorMessage(rawBody: string): string {
	if (!rawBody) return "(empty response body)";
	try {
		const json = JSON.parse(rawBody);
		// Standard OpenAI error format: { error: { message, type, code } }
		if (json?.error?.message) return json.error.message;
		// FastAPI-style gateways: { detail: "Unsupported parameter: ..." }
		if (typeof json?.detail === "string" && json.detail) return json.detail;
		if (json?.detail != null && typeof json.detail === "object") {
			return JSON.stringify(json.detail);
		}
		// Some providers use a flat format: { message, type, code }
		if (json?.message) return json.message;
	} catch {
		// Not JSON — return raw text (truncated for readability)
	}
	// Return raw body, truncated if very long
	return rawBody.length > 500 ? `${rawBody.slice(0, 500)}...` : rawBody;
}

function createOpenAIApiError(response: Response, rawBody: string): ApiError {
	let payload: Record<string, unknown> = {};
	try {
		const parsed = JSON.parse(rawBody);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			payload = parsed as Record<string, unknown>;
		}
	} catch {
		// Keep the bounded raw message below when the provider did not return JSON.
	}
	const message = extractApiErrorMessage(rawBody);
	const diagnostics = parseErrorDiagnostics(
		{
			...payload,
			statusCode: response.status,
			message,
			responseHeaders: Object.fromEntries(response.headers.entries()),
		},
		{
			source: "provider",
			phase: "http_error",
			statusCode: response.status,
			message,
		},
	);
	return new ApiError(
		response.status,
		`OpenAI API error ${response.status}: ${message}`,
		diagnostics,
	);
}

/** Parse a /responses JSON payload with a clearer error message. */
function parseResponsesJson(raw: string): {
	output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
	usage?: unknown;
} {
	return parseJsonWithPreview<{
		output?: Array<{ type?: string; content?: Array<{ type?: string; text?: string }> }>;
		usage?: unknown;
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

/**
 * Tag a reasoning event that carries OpenAI-shaped metadata (item id +
 * encrypted_content) with the upstream identity that minted it, so later
 * replay can verify ownership before echoing the credential back (see
 * `signatureSourcesCompatible`). Applied at chat() yield boundaries —
 * `parseResponsesAPIEvent` stays a pure function, keeping its exported tests
 * independent of provider state. Exported for CodexProvider, whose WebSocket
 * path parses the same events without going through OpenAIProvider.chat().
 */
export function stampReasoningSource(
	evt: ParsedStreamEvent,
	source: string | undefined,
): ParsedStreamEvent {
	const meta = evt.reasoningMetadata;
	if (meta?.openai && source) {
		meta.signatureSource = source;
	}
	return evt;
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
	let sawResponsesEvent = false;
	let completed = false;
	let completionLimited = false;
	let terminalError = false;
	let lastParseError: { error: string; preview: string } | undefined;

	// Tool call accumulators keyed by output_index (matches OpenAI SSE structure)
	const toolAccum = new Map<number, ResponsesToolAccum>();
	// Reasoning item accumulators keyed by output_index
	const reasoningAccum = new Map<number, ResponsesReasoningAccum>();
	// Track SSE event: type for gateway-injected events
	let currentEventType = "";

	const parsePayload = (payload: string, eventType: string): ParsedStreamEvent[] => {
		if (!payload || payload === "[DONE]") return [];

		let data: Record<string, unknown>;
		try {
			const parsed = JSON.parse(payload);
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				lastParseError = {
					error: "SSE data was not a JSON object",
					preview: payload.slice(0, 300),
				};
				return [];
			}
			data = parsed as Record<string, unknown>;
		} catch (err) {
			lastParseError = {
				error: err instanceof Error ? err.message : String(err),
				preview: payload.slice(0, 300),
			};
			return [];
		}

		// Gateway-injected events: check SSE event: type first, then data-embedded type.
		if (eventType && isGatewayEventType(eventType)) {
			const gwEvt = parseGatewaySSEEvent(eventType, data);
			if (gwEvt) return [gwEvt];
		}
		const gwEvt = parseGatewayDataEvent(data);
		if (gwEvt) return [gwEvt];

		// Some SSE implementations carry the Responses event name in `event:` and omit
		// `type` in `data`. Preserve that signal instead of falling through to the
		// empty-response guard, which masks the real upstream state.
		if (
			eventType &&
			typeof data.type !== "string" &&
			(eventType.startsWith("response.") || eventType === "error")
		) {
			data.type = eventType;
		}

		const chunk = data as ResponsesAPIChunk;
		const type = chunk.type;
		if (typeof type === "string" && (type.startsWith("response.") || type === "error")) {
			sawResponsesEvent = true;
		}
		const events = parseResponsesAPIEvent(chunk, toolAccum, reasoningAccum);
		for (const evt of events) {
			if (!evt.invalidState) continue;
			// Output limits end generation, not accounting: relays can still send usage.
			if (isCompletionLimitReason(evt.invalidState.reason)) completionLimited = true;
			else terminalError = true;
		}
		if (type === "response.completed") completed = true;
		return events;
	};

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
				if (!trimmed) {
					currentEventType = "";
					continue;
				}
				// Track SSE event: lines for gateway-injected events
				if (trimmed.startsWith("event:")) {
					currentEventType = trimmed.slice(6).trim();
					continue;
				}
				if (!trimmed.startsWith("data:")) continue;

				if (lineCount < 5) {
					logger.debug("Responses API SSE line", {
						lineIndex: lineCount,
						preview: trimmed.slice(0, 300),
					});
				}
				lineCount++;

				const payload = trimmed.slice(5).trimStart();
				const eventType = currentEventType;
				currentEventType = "";
				const events = parsePayload(payload, eventType);
				for (const evt of events) {
					yield evt;
				}
				if (terminalError) return;
			}
		}
		// Process remaining buffer
		if (buffer.trim()?.startsWith("data:")) {
			const trimmed = buffer.trim();
			const payload = trimmed.slice(5).trimStart();
			const events = parsePayload(payload, currentEventType);
			for (const evt of events) {
				yield evt;
			}
		}
		if (terminalError || completionLimited) return;
		if (!completed) {
			const parseDetail = lastParseError
				? ` Last malformed SSE data: ${lastParseError.error}; preview=${lastParseError.preview}`
				: sawResponsesEvent
					? ""
					: " No Responses API events were parsed from the stream.";
			yield {
				invalidState: {
					reason: "stream_closed_before_response_completed",
					message: `Responses API stream closed before response.completed.${parseDetail}`,
				},
			};
			return;
		}
		// Flush any un-emitted tool calls only after a completed response. Otherwise
		// a truncated stream could execute a half-written tool call and hide the real failure.
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				acc.emitted = true;
				yield {
					toolUseChunk: {
						toolUseId: acc.callId,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				};
			}
		}
	} finally {
		reader.releaseLock();
	}
}

export interface ResponsesAPIChunk {
	type?: string;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	item?: any;
	// biome-ignore lint/suspicious/noExplicitAny: provider-native content part
	part?: any;
	/** Present on delta/done events to identify the item */
	item_id?: string;
	delta?: string;
	/** Present on *.done events that carry the full accumulated text. */
	text?: string;
	output_index?: number;
	content_index?: number;
	/** Internal alias resolved from item_id/output_index for this stream. */
	_contentItemKey?: string | number;
	/** Present on reasoning_summary_text.delta / reasoning_summary_part.added */
	summary_index?: number;
	/** Present on response.image_generation_call.partial_image events. */
	partial_image_index?: number;
	partial_image_b64?: string;
	/** Present on response.output_text.annotation.added events. */
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	annotation?: any;
	annotation_index?: number;
	sequence_number?: number;
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	response?: any;
}

/**
 * Map a Responses API annotation object to the shared provider citation shape.
 *
 * Only `url_citation` carries a resolvable source today; other annotation types
 * (file_citation, container_file_citation, …) are kept as internal refs so the
 * reference number still renders without exposing the raw id.
 */
function parseResponsesAnnotation(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	annotation: any,
	outputIndex?: number,
): ProviderTextCitation | null {
	if (!annotation || typeof annotation !== "object") return null;
	const endIndex = annotation.end_index ?? annotation.endIndex;
	if (typeof endIndex !== "number" || !Number.isFinite(endIndex)) return null;
	const startIndexRaw = annotation.start_index ?? annotation.startIndex;
	const url = typeof annotation.url === "string" ? annotation.url : undefined;
	const title = typeof annotation.title === "string" ? annotation.title : undefined;
	const sourceRef =
		typeof annotation.file_id === "string"
			? annotation.file_id
			: typeof annotation.id === "string"
				? annotation.id
				: undefined;
	if (!url && !title && !sourceRef) return null;
	return {
		startIndex: typeof startIndexRaw === "number" ? startIndexRaw : undefined,
		endIndex,
		url,
		title,
		sourceRef,
		outputIndex,
	};
}

/** Collect annotations from a finalized assistant message output item. */
function collectAssistantItemCitations(
	// biome-ignore lint/suspicious/noExplicitAny: dynamic API response
	item: any,
	outputIndex?: number,
): ProviderTextCitation[] {
	const parts = Array.isArray(item?.content) ? item.content : [];
	const out: ProviderTextCitation[] = [];
	for (const part of parts) {
		if (part?.type !== "output_text") continue;
		const annotations = Array.isArray(part.annotations) ? part.annotations : [];
		for (const annotation of annotations) {
			const citation = parseResponsesAnnotation(annotation, outputIndex);
			if (citation) out.push(citation);
		}
	}
	return out;
}

/** Accumulator for a single Responses API tool call, keyed by output_index. */
export interface ResponsesToolAccum {
	outputIndex?: number;
	callId: string;
	name: string;
	args: string;
	emitted: boolean;
}

/** Accumulator for a Responses API reasoning item, keyed by output_index. */
export interface ResponsesReasoningAccum {
	/** The canonical item ID from the API (e.g. "rs_...") */
	itemId: string;
	/** Encrypted reasoning content for continuation */
	encryptedContent?: string | null;
	/** Text already emitted from delta events; used to avoid duplicating *.done fallbacks. */
	emittedText?: string;
	/**
	 * The `summary_index` of the summary part most recently emitted. A single
	 * reasoning item can stream several summary parts, each a distinct segment.
	 * When the index advances we insert a blank-line boundary so downstream
	 * rendering can treat each part as its own block (avoids re-parsing the
	 * whole reasoning every frame while streaming).
	 */
	lastSummaryIndex?: number;
	/** Track each summary separately: a later done-only part must not be dropped. */
	emittedParts?: Set<string>;
	/** Exact bytes seen per native content part, including partial delta recovery. */
	nativeParts?: Map<number, string>;
	textFormat?: "reasoning_text" | "summary_text" | "mixed";
	completed?: boolean;
}

interface ResponsesTextLane {
	outputIndex?: number;
	length: number;
	completed?: boolean;
}

// Keyed by the caller-owned, per-response accumulator (also used by Codex WS).
// Weak ownership keeps legacy parser callers compatible without leaking streams.
const responsesContentState = new WeakMap<
	Map<number, ResponsesToolAccum>,
	{
		textLanes: Map<string, ResponsesTextLane>;
		items: Map<string, { key: string | number; outputIndex?: number }>;
	}
>();

function responsesBlockId(chunk: ResponsesAPIChunk, kind: "text" | "reasoning"): string {
	const item =
		chunk._contentItemKey ?? chunk.output_index ?? chunk.item_id ?? chunk.item?.id ?? "unknown";
	return `responses:${item}:${kind}${kind === "text" ? `:${chunk.content_index ?? 0}` : ""}`;
}

function resolveReasoningAccum(
	chunk: ResponsesAPIChunk,
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
): ResponsesReasoningAccum | undefined {
	const idx = chunk.output_index;
	if (idx != null && reasoningAccum.has(idx)) return reasoningAccum.get(idx);
	if (chunk.item_id) return findReasoningAccumByItemId(reasoningAccum, chunk.item_id);
	return findActiveReasoningAccum(reasoningAccum);
}

function pushReasoningTextEvent(
	results: ParsedStreamEvent[],
	chunk: ResponsesAPIChunk,
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
	text: string,
	options: { appendToAccumulator?: boolean; emitOnlyIfAccumulatorEmpty?: boolean } = {},
): void {
	let acc = resolveReasoningAccum(chunk, reasoningAccum);
	if (!acc) {
		acc = { itemId: chunk.item_id ?? "", emittedText: "" };
		reasoningAccum.set(chunk.output_index ?? -(reasoningAccum.size + 1), acc);
	}
	const native =
		chunk.type === "response.reasoning_text.delta" || chunk.type === "response.reasoning_text.done";
	const format = native ? "reasoning_text" : "summary_text";
	acc.textFormat = acc.textFormat && acc.textFormat !== format ? "mixed" : format;
	const partKey = `${native ? "content" : "summary"}:${chunk.summary_index ?? chunk.content_index ?? 0}`;
	if (native) {
		acc.nativeParts ??= new Map();
		const index = chunk.content_index ?? 0;
		const previous = acc.nativeParts.get(index) ?? "";
		if (options.emitOnlyIfAccumulatorEmpty) {
			if (!text.startsWith(previous)) return;
			acc.nativeParts.set(index, text);
			text = text.slice(previous.length);
			if (!text) return;
		} else {
			acc.nativeParts.set(index, previous + text);
		}
	} else if (options.emitOnlyIfAccumulatorEmpty && acc.emittedParts?.has(partKey)) return;
	acc.emittedParts ??= new Set();
	acc.emittedParts.add(partKey);

	// Summary-part boundary: a single reasoning item streams several summary
	// parts (each carries a `summary_index`). When the index advances we prepend
	// a blank line so each part becomes its own top-level block downstream —
	// this lets the frontend seal completed parts and re-parse only the active
	// tail, instead of re-parsing the whole (unbounded) reasoning every frame.
	let emitText = text;
	if (!native && typeof chunk.summary_index === "number") {
		if (
			acc.lastSummaryIndex != null &&
			chunk.summary_index > acc.lastSummaryIndex &&
			(acc.emittedText?.length ?? 0) > 0
		) {
			emitText = `\n\n${text}`;
		}
		acc.lastSummaryIndex = chunk.summary_index;
	}

	if (options.appendToAccumulator || options.emitOnlyIfAccumulatorEmpty) {
		acc.emittedText = `${acc.emittedText ?? ""}${emitText}`;
	}
	if (acc) {
		results.push({
			reasoning: emitText,
			reasoningBlockId: responsesBlockId(chunk, "reasoning"),
			reasoningMetadata: {
				openai: {
					itemId: acc.itemId,
					reasoningEncryptedContent: acc.encryptedContent,
					textFormat: acc.textFormat,
				},
			},
			reasoningOutputIndex: chunk.output_index,
		});
		return;
	}
	results.push({
		reasoning: emitText,
		reasoningOutputIndex: chunk.output_index,
	});
}

export function parseResponsesAPIEvent(
	chunk: ResponsesAPIChunk,
	toolAccum: Map<number, ResponsesToolAccum>,
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
): ParsedStreamEvent[] {
	const type = chunk.type;
	const payload = chunk as unknown as Record<string, unknown>;

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
				inputTokens: usage.input_tokens,
				completionTokens: usage.output_tokens,
				reasoningTokens: usage.output_tokens_details?.reasoning_tokens ?? undefined,
				cachedInputTokens: usage.input_tokens_details?.cached_tokens ?? undefined,
			},
		});
	}

	// ── Actual response failure takes precedence over an outer "completed" label ──
	// Only inspect the response envelope itself, never error fields in output items.
	const response =
		chunk.response && typeof chunk.response === "object" && !Array.isArray(chunk.response)
			? (chunk.response as Record<string, unknown>)
			: undefined;
	const responseError = parseUpstreamErrorEnvelope(response);
	const envelope = parseUpstreamErrorEnvelope(payload);
	const failureState =
		response?.status === "failed" || response?.status === "incomplete"
			? response.status
			: type === "response.failed"
				? "failed"
				: type === "response.incomplete"
					? "incomplete"
					: responseError
						? "failed"
						: undefined;
	if (failureState || envelope || type === "error") {
		const incompleteReason =
			failureState === "incomplete" &&
			typeof chunk.response?.incomplete_details?.reason === "string"
				? chunk.response.incomplete_details.reason.trim() || undefined
				: undefined;
		const code = responseError?.code ?? envelope?.code;
		const statusCode = responseError?.statusCode ?? envelope?.statusCode;
		const flatError =
			payload.error && typeof payload.error === "object" && !Array.isArray(payload.error)
				? (payload.error as Record<string, unknown>)
				: undefined;
		const policyCode = [
			responseError?.code,
			envelope?.code,
			chunk.response?.error?.code,
			chunk.response?.error?.type,
			flatError?.code,
			flatError?.type,
			incompleteReason,
		]
			.map((candidate) =>
				typeof candidate === "string" ? normalizePolicyViolationCode(candidate) : null,
			)
			.find((candidate) => candidate != null);
		// Policy blocks and other non-transient codes must not become completion-limit
		// continuations. Incomplete reasons may override only transient codes/statuses;
		// classification here uses neither prose nor user-configured retry overrides.
		const preferIncompleteReason =
			!code || classifyInvalidState(code, undefined, { statusCode }, []).category === "transient";
		const reason =
			policyCode ??
			(preferIncompleteReason ? (incompleteReason ?? code) : code) ??
			(failureState === "incomplete" ? "unknown" : "api_error");
		const message =
			responseError?.message ??
			envelope?.message ??
			(failureState === "incomplete"
				? `Response incomplete: ${reason}`
				: failureState === "failed"
					? "Response failed"
					: "Unknown API error");
		results.push({
			invalidState: {
				reason,
				message,
				diagnostics: parseErrorDiagnostics(
					{
						...payload,
						...response,
						error: response?.error ?? payload.error,
						statusCode,
						code,
						reason,
						message,
					},
					{
						source: response?.diagnostics || payload.diagnostics ? "gateway" : "provider",
						phase: failureState ? `response_${failureState}` : "sse_error",
						reason,
						message,
					},
				),
			},
		});
		// Usage is retained, but never finalize pending tools or a successful chain.
		return results;
	}

	// ── Response created: capture response ID for previous_response_id chaining ──
	if (type === "response.created" && chunk.response?.id) {
		logger.debug("Responses API response created", { responseId: chunk.response.id });
		results.push({ responseId: chunk.response.id });
		return results;
	}

	let contentState = responsesContentState.get(toolAccum);
	if (!contentState) {
		contentState = { textLanes: new Map(), items: new Map() };
		responsesContentState.set(toolAccum, contentState);
	}
	const { textLanes, items } = contentState;
	const itemId = chunk.item_id ?? chunk.item?.id;
	const indexAlias = chunk.output_index == null ? undefined : `index:${chunk.output_index}`;
	const idAlias = typeof itemId === "string" ? `id:${itemId}` : undefined;
	const identity = (idAlias ? items.get(idAlias) : undefined) ??
		(indexAlias ? items.get(indexAlias) : undefined) ?? {
			key: chunk.output_index ?? itemId ?? "unknown",
			outputIndex: chunk.output_index,
		};
	if (chunk.output_index != null) identity.outputIndex = chunk.output_index;
	if (indexAlias) items.set(indexAlias, identity);
	if (idAlias) items.set(idAlias, identity);
	chunk = {
		...chunk,
		_contentItemKey: identity.key,
		output_index: chunk.output_index ?? identity.outputIndex,
	};
	const emitText = (partChunk: ResponsesAPIChunk, text: string, delta: boolean) => {
		const blockId = responsesBlockId(partChunk, "text");
		const lane = textLanes.get(blockId) ?? { outputIndex: partChunk.output_index, length: 0 };
		textLanes.set(blockId, lane);
		const suffix = delta ? text : text.slice(lane.length);
		if (suffix && !lane.completed) {
			lane.length += suffix.length;
			results.push({ text: suffix, textOutputIndex: partChunk.output_index, textBlockId: blockId });
		}
	};
	const textBoundary = (partChunk: ResponsesAPIChunk, phase: "checkpoint" | "complete") => {
		const blockId = responsesBlockId(partChunk, "text");
		const lane = textLanes.get(blockId) ?? { outputIndex: partChunk.output_index, length: 0 };
		if (lane.completed) return;
		textLanes.set(blockId, lane);
		if (phase === "complete") lane.completed = true;
		results.push({
			contentBoundary: { kind: "text", phase, blockId, outputIndex: partChunk.output_index },
		});
	};

	// ── Text streaming ──
	if (type === "response.output_text.delta" && typeof chunk.delta === "string") {
		emitText(chunk, chunk.delta, true);
		return results;
	}
	if (type === "response.output_text.done" || type === "response.content_part.done") {
		if (type === "response.content_part.done" && chunk.part?.type !== "output_text") return results;
		const text = chunk.text ?? chunk.part?.text;
		if (typeof text === "string") emitText(chunk, text, false);
		const citations = collectAssistantItemCitations({ content: [chunk.part] }, chunk.output_index);
		if (citations.length)
			results.push({
				textCitations: citations,
				textBlockId: responsesBlockId(chunk, "text"),
				textOutputIndex: chunk.output_index,
			});
		// output_item.done carries the final annotations: keep the native item open until then.
		textBoundary(chunk, "checkpoint");
		return results;
	}

	// ── Text citations: streamed annotations ──
	// Native web search reports sources out-of-band instead of (only) as inline
	// markers. Surfacing them structurally is what keeps `citeturn…` control
	// markers out of the visible text.
	if (type === "response.output_text.annotation.added") {
		const citation = parseResponsesAnnotation(chunk.annotation, chunk.output_index);
		if (citation)
			results.push({
				textCitations: [citation],
				textBlockId: responsesBlockId(chunk, "text"),
				textOutputIndex: chunk.output_index,
			});
		return results;
	}

	// ── Assistant message items ──
	// Responses API surfaces assistant messages as output items with stable item ids.
	// Capture the id so higher layers can persist and replay it as the official
	// message item id instead of synthesizing a local UUID.
	if (
		(type === "response.output_item.added" || type === "response.output_item.done") &&
		((chunk.item?.type === "message" && chunk.item.role === "assistant") ||
			chunk.item?.type === "output_text" ||
			chunk.item?.type === "text")
	) {
		if (chunk.item.type === "message" && chunk.item.id) results.push({ messageId: chunk.item.id });
		if (type === "response.output_item.done") {
			const parts = chunk.item.type === "message" ? (chunk.item.content ?? []) : [chunk.item];
			for (const [contentIndex, part] of parts.entries()) {
				if (part?.type !== "output_text" && part?.type !== "text") continue;
				const partChunk = { ...chunk, content_index: contentIndex };
				if (textLanes.get(responsesBlockId(partChunk, "text"))?.completed) continue;
				if (typeof part.text === "string") emitText(partChunk, part.text, false);
				const citations = collectAssistantItemCitations({ content: [part] }, chunk.output_index);
				if (citations.length)
					results.push({
						textCitations: citations,
						textBlockId: responsesBlockId(partChunk, "text"),
						textOutputIndex: chunk.output_index,
					});
				textBoundary(partChunk, "complete");
			}
			// Some relays omit content on item.done; finalize already-observed lanes too.
			for (const [blockId, lane] of textLanes) {
				if (
					!lane.completed &&
					chunk.output_index != null &&
					lane.outputIndex === chunk.output_index
				) {
					lane.completed = true;
					results.push({
						contentBoundary: {
							kind: "text",
							phase: "complete",
							blockId,
							outputIndex: lane.outputIndex,
						},
					});
				}
			}
		}
		return results;
	}

	// ── Web search: output_item.added (type=web_search_call) ──
	if (type === "response.output_item.added" && chunk.item?.type === "web_search_call") {
		const id = chunk.item.id ?? "";
		logger.debug("Responses API web search started", { id, outputIndex: chunk.output_index });
		results.push({
			webSearch: {
				id,
				status: "in_progress",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Web search: lifecycle events ──
	if (type === "response.web_search_call.in_progress") {
		results.push({
			webSearch: {
				id: chunk.item_id ?? "",
				status: "in_progress",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}
	if (type === "response.web_search_call.searching") {
		results.push({
			webSearch: {
				id: chunk.item_id ?? "",
				status: "searching",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}
	if (type === "response.web_search_call.completed") {
		results.push({
			webSearch: {
				id: chunk.item_id ?? "",
				status: "completed",
				outputIndex: chunk.output_index,
			},
		});
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
				outputIndex: chunk.output_index,
				final: true,
				action: action ?? undefined,
			},
		});
		return results;
	}

	// ── Image generation: output_item.added (type=image_generation_call) ──
	if (type === "response.output_item.added" && chunk.item?.type === "image_generation_call") {
		const id = chunk.item.id ?? "";
		logger.debug("Responses API image generation started", { id, outputIndex: chunk.output_index });
		results.push({
			imageGeneration: {
				id,
				status: "in_progress",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Image generation: lifecycle events ──
	if (type === "response.image_generation_call.generating") {
		results.push({
			imageGeneration: {
				id: chunk.item_id ?? "",
				status: "generating",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}
	if (type === "response.image_generation_call.partial_image") {
		results.push({
			imageGeneration: {
				id: chunk.item_id ?? "",
				status: "generating",
				outputIndex: chunk.output_index,
				partialImageIndex: chunk.partial_image_index,
				partialImageB64: chunk.partial_image_b64,
			},
		});
		return results;
	}
	if (type === "response.image_generation_call.completed") {
		results.push({
			imageGeneration: {
				id: chunk.item_id ?? "",
				status: "completed",
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Image generation: output_item.done (type=image_generation_call) — final result ──
	if (type === "response.output_item.done" && chunk.item?.type === "image_generation_call") {
		results.push({
			imageGeneration: {
				id: chunk.item.id ?? "",
				status: chunk.item.status ?? "completed",
				revisedPrompt: chunk.item.revised_prompt ?? undefined,
				result: chunk.item.result ?? "",
				outputIndex: chunk.output_index,
				final: true,
			},
		});
		return results;
	}

	// ── Reasoning: output_item.added (type=reasoning) ──
	// Track the reasoning item's id and encrypted_content for continuation.
	if (type === "response.output_item.added" && chunk.item?.type === "reasoning") {
		const idx = chunk.output_index ?? -(reasoningAccum.size + 1);
		reasoningAccum.set(idx, {
			itemId: chunk.item.id ?? "",
			encryptedContent: chunk.item.encrypted_content ?? null,
			emittedText: "",
		});
		results.push({
			contentBoundary: {
				kind: "reasoning",
				phase: "start",
				blockId: responsesBlockId(chunk, "reasoning"),
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Reasoning: output_item.done (type=reasoning) ──
	// Update encrypted_content with the final value from the done event and
	// emit a metadata-only event so the loop can persist the final value.
	if (type === "response.output_item.done" && chunk.item?.type === "reasoning") {
		const itemChunk = { ...chunk, item_id: chunk.item.id ?? chunk.item_id };
		let acc = resolveReasoningAccum(itemChunk, reasoningAccum);
		if (acc?.completed) return results;
		if (!acc) {
			acc = { itemId: chunk.item.id ?? "", emittedText: "" };
			reasoningAccum.set(chunk.output_index ?? -(reasoningAccum.size + 1), acc);
		}
		// A done-only item is legal on relays. Recover each summary independently.
		for (const [summaryIndex, part] of (chunk.item.summary ?? []).entries()) {
			if (typeof part?.text === "string" && part.text) {
				pushReasoningTextEvent(
					results,
					{ ...itemChunk, summary_index: summaryIndex },
					reasoningAccum,
					part.text,
					{ emitOnlyIfAccumulatorEmpty: true },
				);
			}
		}
		for (const [contentIndex, part] of (chunk.item.content ?? []).entries()) {
			if (part?.type === "reasoning_text" && typeof part.text === "string") {
				pushReasoningTextEvent(
					results,
					{
						...itemChunk,
						type: "response.reasoning_text.done",
						content_index: contentIndex,
					},
					reasoningAccum,
					part.text,
					{ emitOnlyIfAccumulatorEmpty: true },
				);
			}
		}
		const finalEncrypted = chunk.item.encrypted_content ?? acc.encryptedContent;
		acc.encryptedContent = finalEncrypted;
		acc.completed = true;
		results.push({
			reasoningMetadata: {
				openai: {
					itemId: chunk.item.id ?? acc?.itemId,
					reasoningEncryptedContent: finalEncrypted,
					textFormat: acc.textFormat,
				},
			},
			reasoningBlockId: responsesBlockId(itemChunk, "reasoning"),
			reasoningOutputIndex: chunk.output_index,
		});
		results.push({
			contentBoundary: {
				kind: "reasoning",
				phase: "complete",
				blockId: responsesBlockId(itemChunk, "reasoning"),
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Reasoning content ──
	// Responses API may stream either a summary (`reasoning_summary_text.delta`)
	// or raw reasoning text (`reasoning_text.delta`). The latter has no summary,
	// but it should still be shown immediately instead of waiting until a later
	// block_complete/tool call causes the persisted message to appear.
	if (
		(type === "response.reasoning_summary_text.delta" ||
			type === "response.reasoning_text.delta") &&
		typeof chunk.delta === "string"
	) {
		pushReasoningTextEvent(results, chunk, reasoningAccum, chunk.delta, {
			appendToAccumulator: true,
		});
		return results;
	}

	if (
		type === "response.reasoning_summary_text.done" ||
		type === "response.reasoning_text.done" ||
		type === "response.reasoning_summary_part.done"
	) {
		const text = chunk.text ?? chunk.part?.text;
		if (typeof text === "string" && text) {
			pushReasoningTextEvent(results, chunk, reasoningAccum, text, {
				emitOnlyIfAccumulatorEmpty: true,
			});
		}
		// A summary is not an independently replayable reasoning item. Final
		// encrypted_content arrives only on output_item.done.
		results.push({
			contentBoundary: {
				kind: "reasoning",
				phase: "checkpoint",
				blockId: responsesBlockId(chunk, "reasoning"),
				outputIndex: chunk.output_index,
			},
		});
		return results;
	}

	// ── Function call: output_item.added ──
	// { type, output_index, item: { type: "function_call", id, call_id, name, arguments } }
	if (type === "response.output_item.added" && chunk.item?.type === "function_call") {
		const idx = chunk.output_index;
		const callId = chunk.item.call_id;
		const name = chunk.item.name;
		if (idx != null && callId && name) {
			const existing = toolAccum.get(idx);
			if (existing) {
				if (existing.callId === callId) {
					logger.warn("Ignoring duplicate Responses API tool call start event", {
						outputIndex: idx,
						callId,
						toolName: name,
					});
					return results;
				}
				logger.warn("Responses API output_index reused for different tool call", {
					outputIndex: idx,
					previousCallId: existing.callId,
					callId,
					toolName: name,
				});
			}
			toolAccum.set(idx, { callId, name, args: "", emitted: false, outputIndex: idx });
			logger.debug("Responses API tool call started", { outputIndex: idx, callId, toolName: name });
			results.push({
				toolUseChunk: { toolUseId: callId, name, input: undefined, stop: false, outputIndex: idx },
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
					outputIndex: idx,
				},
			});
			// Early completion if args form valid JSON
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: {
						toolUseId: acc.callId,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
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
			results.push({
				toolUseChunk: {
					toolUseId: acc.callId,
					name: acc.name,
					stop: true,
					outputIndex: acc.outputIndex,
				},
			});
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
			results.push({
				toolUseChunk: {
					toolUseId: acc.callId,
					name: acc.name,
					stop: true,
					outputIndex: acc.outputIndex,
				},
			});
			return results;
		}
	}

	// ── Response completed ──
	if (type === "response.completed") {
		// Some relays only attach final annotations/credentials to response.output.
		// Recover those before completing any still-open lanes. Item completion is
		// idempotent, so a normal stream's already-finalized content is not replayed.
		if (Array.isArray(chunk.response?.output)) {
			for (const [outputIndex, item] of chunk.response.output.entries()) {
				results.push(
					...parseResponsesAPIEvent(
						{ type: "response.output_item.done", output_index: outputIndex, item },
						toolAccum,
						reasoningAccum,
					),
				);
			}
		}
		// Legacy relays may omit output_item.done but still send text.done.
		for (const [blockId, lane] of textLanes) {
			if (!lane.completed) {
				lane.completed = true;
				results.push({
					contentBoundary: {
						kind: "text",
						phase: "complete",
						blockId,
						outputIndex: lane.outputIndex,
					},
				});
			}
		}
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: {
						toolUseId: acc.callId,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				});
				acc.emitted = true;
			}
		}
		// Note: usage is already extracted at the top of this function
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
	outputIndex?: number;
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
	// Track SSE event: type for gateway-injected events
	let currentEventType = "";

	const reader = body.getReader();
	try {
		while (true) {
			const { done, value } = await readWithTimeout(reader);
			if (done) break;
			buffer += decoder.decode(value, { stream: true });

			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";

			for (const line of lines) {
				// Track SSE event: lines for gateway-injected events
				if (line.startsWith("event:")) {
					currentEventType = line.slice(6).trim();
					continue;
				}
				// Log first few SSE lines for debugging
				if (lineCount < 5 && line.trim() && line.startsWith("data: ")) {
					logger.debug("OpenAI SSE line", {
						lineIndex: lineCount,
						preview: line.slice(0, 300),
					});
				}
				lineCount++;
				const events = parseSSELine(line, toolAccum, currentEventType);
				currentEventType = "";
				for (const evt of events) {
					yield evt;
				}
			}
		}
		// Process any remaining data in the buffer after stream ends
		if (buffer.trim()) {
			const events = parseSSELine(buffer, toolAccum, "");
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
			outputIndex: acc.outputIndex,
		});
	}
	toolAccum.clear();
	return toolUses.length > 0 ? { toolUses } : null;
}

function parseSSELine(
	line: string,
	toolAccum: Map<number, ToolAccumEntry>,
	eventType?: string,
): ParsedStreamEvent[] {
	const trimmed = line.trim();
	if (!trimmed || trimmed === "data: [DONE]") return [];
	if (!trimmed.startsWith("data: ")) return [];

	let data: Record<string, unknown>;
	try {
		data = JSON.parse(trimmed.slice(6));
	} catch {
		return [];
	}

	// Gateway-injected events: check SSE event: type first, then data-embedded type
	if (eventType && isGatewayEventType(eventType)) {
		const gwEvt = parseGatewaySSEEvent(eventType, data);
		return gwEvt ? [gwEvt] : [];
	}
	const gwEvt = parseGatewayDataEvent(data);
	if (gwEvt) return [gwEvt];

	const chunk = data as OAIStreamChunk;

	// Handle error objects embedded in stream chunks
	// (some providers send errors as {error: {message, type, code}} inside the SSE stream)
	if (chunk.error) {
		// `chunk.error.message` is absent when the payload used `detail`/`description`, or
		// when `error` is itself the message string. Recovering the real text matters more
		// than the shape it arrived in — the placeholder below tells the user nothing.
		const envelope = parseUpstreamErrorEnvelope(data);
		const msg = chunk.error.message || envelope?.message || "Unknown OpenAI API error";
		const reason = String(chunk.error.code ?? chunk.error.type ?? envelope?.code ?? "api_error");
		const statusCode =
			chunk.error.statusCode ??
			chunk.error.status_code ??
			(typeof chunk.error.code === "number" ? chunk.error.code : undefined);
		return [
			{
				invalidState: {
					reason,
					message: msg,
					diagnostics: parseErrorDiagnostics(
						{ ...data, statusCode, message: msg },
						{
							source: data.diagnostics ? "gateway" : "provider",
							phase: "sse_error",
							reason,
							message: msg,
						},
					),
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
						inputTokens: promptTokens,
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
			toolAccum.set(idx, {
				id,
				name,
				args: chunk.item.arguments ?? "",
				emitted: false,
				outputIndex: chunk.output_index,
			});
			logger.debug("OpenAI Responses API tool call started", { callId: id, toolName: name });
			return [
				{
					toolUseChunk: {
						toolUseId: id,
						name,
						input: undefined,
						stop: false,
						outputIndex: chunk.output_index,
					},
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
						outputIndex: acc.outputIndex,
					},
				},
			];
			if (isParsableJson(acc.args)) {
				results.push({
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
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
			return [
				{
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				},
			];
		}
		return [];
	}

	// ── Responses API: response completed ──
	if (chunk.response?.status === "completed") {
		// Flush any remaining un-emitted tool calls
		const results: ParsedStreamEvent[] = [];
		for (const [, acc] of toolAccum) {
			if (!acc.emitted) {
				results.push({
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
				});
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

	// A chunk may contain all three lanes. Publish content before any tool can
	// start executing, and keep reasoning before visible text within the chunk.
	// biome-ignore lint/suspicious/noExplicitAny: gateway-specific field
	const reasoning = (delta as any).reasoning_content;
	if (typeof reasoning === "string" && reasoning) results.push({ reasoning });
	if (delta.content) results.push({ text: delta.content });

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
					toolUseChunk: {
						toolUseId: id,
						name,
						input: undefined,
						stop: false,
						outputIndex: chunk.output_index,
					},
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
							toolUseChunk: {
								toolUseId: acc.id,
								name: acc.name,
								stop: true,
								outputIndex: acc.outputIndex,
							},
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
					toolUseChunk: {
						toolUseId: acc.id,
						name: acc.name,
						stop: true,
						outputIndex: acc.outputIndex,
					},
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
			case "length": {
				const message = "Response truncated: model reached maximum token limit.";
				result.invalidState = {
					reason: "max_tokens",
					message,
					diagnostics: parseErrorDiagnostics(
						{ reason: "max_tokens", message },
						{ source: "provider", phase: "finish_reason", reason: "max_tokens", message },
					),
				};
				break;
			}
			case "content_filter": {
				const message = "Response blocked by content filter.";
				result.invalidState = {
					reason: "content_filter",
					message,
					diagnostics: parseErrorDiagnostics(
						{ reason: "content_filter", message },
						{ source: "provider", phase: "finish_reason", reason: "content_filter", message },
					),
				};
				break;
			}
			case "model_context_window_exceeded": {
				const message = "The model has reached its context window limit.";
				result.invalidState = {
					reason: "model_context_window_exceeded",
					message,
					diagnostics: parseErrorDiagnostics(
						{ reason: "model_context_window_exceeded", message },
						{
							source: "provider",
							phase: "finish_reason",
							reason: "model_context_window_exceeded",
							message,
						},
					),
				};
				break;
			}
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

/** Find reasoning accumulator by item id when an event omits output_index. */
function findReasoningAccumByItemId(
	reasoningAccum: Map<number, ResponsesReasoningAccum>,
	itemId: string,
): ResponsesReasoningAccum | undefined {
	for (const [, acc] of reasoningAccum) {
		if (acc.itemId === itemId) return acc;
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

function buildOAIUserMessage(
	content: string,
	images?: Array<{ format: string; base64: string }>,
): OAIMessage | null {
	const hasText = !!content && content !== ".";
	const hasImages = !!images?.length;
	if (!hasText && !hasImages) return null;

	if (hasImages) {
		const parts: OAIContentPart[] = [
			{ type: "text", text: hasText ? content : "[user sent image(s)]" },
		];
		for (const img of images) {
			parts.push({
				type: "image_url",
				image_url: { url: `data:image/${img.format};base64,${img.base64}` },
			});
		}
		return { role: "user", content: parts };
	}

	return { role: "user", content };
}

function buildResponsesUserMessage(content: string): OAIMessage {
	return { role: "user", content: [{ type: "input_text", text: content }] } as OAIMessage;
}

function buildResponsesToolResultMessage(
	toolUseId: string,
	output: string,
	images?: ResponsesToolImage[],
): ResponsesFunctionCallOutputMessage {
	return {
		type: "function_call_output",
		call_id: toolUseId,
		output,
		...(images?.length ? { _images: images } : {}),
	};
}

function expandResponsesToolResultMessage(
	message: ResponsesFunctionCallOutputMessage,
): OAIMessage[] {
	const items: OAIMessage[] = [
		{
			type: "function_call_output",
			call_id: message.call_id,
			output: message.output,
		} as unknown as OAIMessage,
	];
	if (message._images?.length) {
		items.push({
			role: "user",
			content: message._images.map((img) => ({
				type: "input_image",
				image_url: `data:image/${img.format};base64,${img.base64}`,
			})),
		} as unknown as OAIMessage);
	}
	return items;
}

async function buildResponsesUserMessageFromDbMessage(
	msg: DbMessage,
	narratorId?: string,
): Promise<OAIMessage | null> {
	const ownerNarratorId = msg.narratorId ?? narratorId;
	const blocks = Array.isArray(msg.contentJson) ? msg.contentJson : [];
	const content: OAIContentPart[] = [];
	let sawTextBlock = false;
	for (const block of blocks as Array<Record<string, unknown>>) {
		if (block.type === "text" && typeof block.text === "string") {
			sawTextBlock = true;
			if (block.text.length > 0) {
				content.push({ type: "input_text", text: block.text });
			}
			continue;
		}
		if (block.type === "image" && typeof block.imageId === "string" && ownerNarratorId) {
			const uploadNarratorId =
				typeof block.uploadNarratorId === "string" ? block.uploadNarratorId : ownerNarratorId;
			const filePath = getImagePath(uploadNarratorId, block.imageId);
			if (!filePath) {
				logger.warn("Responses history image missing on disk; skipping replay", {
					narratorId,
					messageNarratorId: msg.narratorId ?? null,
					effectiveNarratorId: ownerNarratorId,
					uploadNarratorId,
					messageId: msg.id,
					imageId: block.imageId,
				});
				continue;
			}
			try {
				const result = await imageToBase64(filePath);
				const mimeToFormat: Record<string, string> = {
					"image/png": "png",
					"image/jpeg": "jpeg",
					"image/gif": "gif",
					"image/webp": "webp",
				};
				const effectiveMime =
					result.detectedMediaType ??
					(typeof block.mediaType === "string" ? block.mediaType : "image/png");
				content.push({
					type: "input_image",
					image_url: `data:image/${mimeToFormat[effectiveMime] ?? "png"};base64,${result.base64}`,
				});
			} catch (error) {
				logger.warn("Failed to rebuild Responses history image; skipping replay", {
					narratorId,
					messageNarratorId: msg.narratorId ?? null,
					effectiveNarratorId: ownerNarratorId,
					uploadNarratorId,
					messageId: msg.id,
					imageId: block.imageId,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		}
	}
	if (content.length > 0) {
		return { role: "user", content } as unknown as OAIMessage;
	}
	const fallbackText = msg.contentText || "";
	if (fallbackText && !sawTextBlock) {
		return buildResponsesUserMessage(fallbackText);
	}
	return null;
}

/** Legacy unmarked text may be a summary, even on DeepSeek; never infer native bytes. */
function serializeResponsesReasoning(
	block: ResponsesReasoningBlock,
	options: ReasoningReplayOptions,
	trustedCurrentTurn = false,
): OAIMessage | undefined {
	const metadata = block.providerMetadata?.openai;
	const sameSource =
		trustedCurrentTurn ||
		signatureSourcesCompatible(block.providerMetadata?.signatureSource, options.currentSource);
	if (metadata?.reasoningEncryptedContent && sameSource) {
		return {
			type: "reasoning",
			id: metadata.itemId,
			summary: block.text.trim() ? [{ type: "summary_text", text: block.text.trim() }] : [],
			encrypted_content: metadata.reasoningEncryptedContent,
		} as unknown as OAIMessage;
	}
	if (!options.strict && sameSource && metadata?.textFormat === "reasoning_text" && block.text) {
		return {
			type: "reasoning",
			id: metadata.itemId,
			content: [{ type: "reasoning_text", text: block.text }],
		} as unknown as OAIMessage;
	}
	return undefined;
}

function buildResponsesPreludeItems(
	reasoningBlocks?: ResponsesReasoningBlock[],
	webSearchBlocks?: ResponsesWebSearchBlock[],
	imageGenerationBlocks?: ResponsesImageGenerationBlock[],
	text?: string,
	messageId?: string,
	textOutputIndex?: number,
	strict = true,
): { items: OAIMessage[] } {
	const entries: Array<{ item: OAIMessage; outputIndex?: number; sourceIndex: number }> = [];
	const fallbackParts: string[] = [];
	let sourceIndex = 0;
	for (const block of reasoningBlocks ?? []) {
		const text = block.text?.trim() ?? "";
		const nativeItem = serializeResponsesReasoning(block, { strict }, true);
		if (nativeItem) {
			// These blocks belong to the current in-memory upstream turn. Preserve
			// its encrypted credential or explicitly identified native plaintext.
			entries.push({
				item: nativeItem,
				outputIndex: block.outputIndex,
				sourceIndex: sourceIndex++,
			});
		} else if (!strict && text) {
			// Genuine plain-text relay (no credential protocol): degrade to text so
			// the model still sees its own prior thoughts.
			fallbackParts.push(text);
		}
		// Strict + no credential: dropped entirely (the official API rejects
		// unsigned reasoning replay).
	}
	for (const block of webSearchBlocks ?? []) {
		// Use the stored action if available; fall back to building a search action from query/queries.
		const action =
			block.action ??
			(block.query || block.queries?.length
				? {
						type: "search",
						...(block.query ? { query: block.query } : {}),
						...(Array.isArray(block.queries) && block.queries.length > 0
							? { queries: block.queries }
							: {}),
					}
				: undefined);
		if (!action) continue;
		entries.push({
			item: {
				type: "web_search_call",
				// NOTE: `id` is intentionally omitted — the upstream Responses API
				// does not accept it on input items (codex-rs skips serializing it).
				status: "completed",
				action,
			} as unknown as OAIMessage,
			outputIndex: block.outputIndex,
			sourceIndex: sourceIndex++,
		});
	}
	for (const block of imageGenerationBlocks ?? []) {
		entries.push({
			item: {
				type: "image_generation_call",
				id: block.id,
				status: "completed",
				result: block.result ?? "",
				...(block.revisedPrompt ? { revised_prompt: block.revisedPrompt } : {}),
			} as unknown as OAIMessage,
			outputIndex: block.outputIndex,
			sourceIndex: sourceIndex++,
		});
	}
	const assistantText = mergeAssistantText(text ?? "", fallbackParts.join("\n"));
	if (assistantText) {
		entries.push({
			item: {
				...(messageId ? { id: messageId } : {}),
				role: "assistant",
				content: [{ type: "output_text", text: assistantText }],
			} as unknown as OAIMessage,
			outputIndex: textOutputIndex,
			sourceIndex: sourceIndex++,
		});
	}
	entries.sort((a, b) =>
		compareOptionalOutputIndex(a.outputIndex, b.outputIndex, a.sourceIndex, b.sourceIndex),
	);
	return { items: entries.map((entry) => entry.item) };
}

function mergeAssistantText(text: string, reasoningFallbackText: string): string {
	const trimmedText = text.trim();
	const trimmedFallback = reasoningFallbackText.trim();
	if (trimmedFallback && trimmedText) return `${trimmedFallback}\n\n${trimmedText}`;
	return trimmedFallback || trimmedText;
}

function buildResponsesAssistantTurnItems(
	text: string,
	toolUses: AgentToolUse[],
	reasoningBlocks?: ResponsesReasoningBlock[],
	webSearches?: ResponsesWebSearchBlock[],
	messageId?: string,
	imageGenerations?: ResponsesImageGenerationBlock[],
	textOutputIndex?: number,
	strict = true,
): OAIMessage[] {
	const items: OAIMessage[] = [];
	const prelude = buildResponsesPreludeItems(
		reasoningBlocks,
		webSearches,
		imageGenerations,
		text,
		messageId,
		textOutputIndex,
		strict,
	);
	items.push(...prelude.items);
	for (const tu of toolUses) {
		items.push({
			type: "function_call",
			call_id: tu.toolUseId,
			name: tu.name,
			arguments: JSON.stringify(tu.input),
		} as unknown as OAIMessage);
	}
	return items;
}

function buildResponsesAssistantMessageItem(text: string, messageId?: string): OAIMessage | null {
	const trimmed = text.trim();
	if (!trimmed) return null;
	return {
		...(messageId ? { id: messageId } : {}),
		role: "assistant",
		content: [{ type: "output_text", text: trimmed }],
	} as unknown as OAIMessage;
}

/**
 * Reasoning replay policy for Responses-format history construction.
 *
 * `strict` — the target model is credential-bound (Claude family / official
 * OpenAI ids): reasoning items replay only when their `encrypted_content`
 * carries a source identity matching `currentSource` (`signatureSourcesCompatible`);
 * everything else is dropped. `strict: false` — relay models never send
 * `encrypted_content` (meaningless payload for a non-OpenAI upstream) and
 * degrade reasoning text into assistant messages instead.
 */
interface ReasoningReplayOptions {
	strict: boolean;
	currentSource?: string;
}

function buildResponsesAssistantItemsFromStoredContent(
	msg: DbMessage,
	options: ReasoningReplayOptions,
	preserveTextBlocks = false,
): OAIMessage[] {
	type StoredAssistantBlock =
		| { type: "text"; text?: string; outputIndex?: number }
		| {
				type: "reasoning";
				text?: string;
				providerMetadata?: import("./types").ReasoningProviderMetadata;
				outputIndex?: number;
		  }
		| {
				type: "web_search";
				id: string;
				query?: string;
				queries?: string[];
				outputIndex?: number;
				action?: import("./provider").WebSearchAction;
		  }
		| {
				type: "image_generation";
				id: string;
				revisedPrompt?: string;
				result?: string;
				savedPath?: string;
				outputIndex?: number;
		  }
		| { type: "tool_use"; id: string; name?: string; input?: Record<string, unknown> }
		| { type: string; [key: string]: unknown };

	const blocks = (Array.isArray(msg.contentJson) ? msg.contentJson : []) as StoredAssistantBlock[];
	const completedToolCalls = new Map(
		(msg.toolCalls ?? [])
			.filter((tc) => tc.status === "success" || tc.status === "fail")
			.filter((tc) => tc.toolName && tc.toolUseId)
			.map((tc) => [tc.toolUseId, tc]),
	);
	const items: OAIMessage[] = [];
	const textBuffer: string[] = [];
	const consumedToolUseIds = new Set<string>();
	let messageIdAvailable = msg.messageUuid ?? undefined;

	const flushTextBuffer = () => {
		const text = textBuffer.join("\n");
		textBuffer.length = 0;
		const item = buildResponsesAssistantMessageItem(text, messageIdAvailable);
		if (item) {
			items.push(item);
			messageIdAvailable = undefined;
		}
	};

	for (const block of blocks) {
		if (block.type === "text") {
			if (typeof block.text === "string" && block.text.length > 0) {
				textBuffer.push(block.text);
				if (preserveTextBlocks) flushTextBuffer();
			}
			continue;
		}

		if (block.type === "reasoning") {
			flushTextBuffer();
			const reasoningBlock = block as Extract<StoredAssistantBlock, { type: "reasoning" }>;
			const text = typeof reasoningBlock.text === "string" ? reasoningBlock.text.trim() : "";
			const nativeItem = serializeResponsesReasoning(
				{ ...reasoningBlock, text: reasoningBlock.text ?? "" },
				options,
			);
			if (nativeItem) {
				items.push(nativeItem);
			} else if (!options.strict && text) {
				// Genuine plain-text relay (or foreign encrypted block we must not echo
				// to this upstream): degrade to an assistant message so the model still
				// sees its own prior thoughts.
				const item = buildResponsesAssistantMessageItem(text, messageIdAvailable);
				if (item) {
					items.push(item);
					messageIdAvailable = undefined;
				}
			}
			continue;
		}

		if (block.type === "web_search") {
			flushTextBuffer();
			const webSearchBlock = block as Extract<StoredAssistantBlock, { type: "web_search" }>;
			// Use stored action if available; fall back to building a search action from query/queries.
			const action =
				webSearchBlock.action ??
				(webSearchBlock.query ||
				(Array.isArray(webSearchBlock.queries) && webSearchBlock.queries.length > 0)
					? {
							type: "search",
							...(webSearchBlock.query ? { query: webSearchBlock.query } : {}),
							...(Array.isArray(webSearchBlock.queries) && webSearchBlock.queries.length > 0
								? { queries: webSearchBlock.queries }
								: {}),
						}
					: undefined);
			if (!action) continue;
			items.push({
				type: "web_search_call",
				// NOTE: `id` is intentionally omitted — the upstream Responses API
				// does not accept it on input items (codex-rs skips serializing it).
				status: "completed",
				action,
			} as unknown as OAIMessage);
			continue;
		}

		if (block.type === "image_generation") {
			flushTextBuffer();
			const igBlock = block as Extract<StoredAssistantBlock, { type: "image_generation" }>;
			let result = igBlock.result ?? "";
			// If result is empty but savedPath exists, read from file
			// TODO: readFileSync blocks the event loop; refactor
			// buildResponsesAssistantItemsFromStoredContent to async to use
			// fs.promises.readFile instead.
			if (!result && igBlock.savedPath) {
				try {
					const fileData = readFileSync(igBlock.savedPath);
					result = fileData.toString("base64");
				} catch {
					// File may have been deleted — skip this block
				}
			}
			if (!result) continue;
			if (igBlock.savedPath) {
				items.push({
					role: "developer",
					content: buildImageGenerationSavedPathInstruction(igBlock.savedPath),
				} as unknown as OAIMessage);
			}
			items.push({
				type: "image_generation_call",
				id: igBlock.id,
				status: "completed",
				result,
				...(igBlock.revisedPrompt ? { revised_prompt: igBlock.revisedPrompt } : {}),
			} as unknown as OAIMessage);
			continue;
		}

		if (block.type === "tool_use") {
			flushTextBuffer();
			const toolUseBlock = block as Extract<StoredAssistantBlock, { type: "tool_use" }>;
			const toolCall = completedToolCalls.get(toolUseBlock.id);
			// Defensive guard: replaying a function_call without a persisted completed
			// tool call would create an invalid Responses history (missing the paired
			// function_call_output). If the DB/tool-call relation is missing, skip the
			// orphaned tool_use block instead of sending malformed history.
			if (!toolCall?.toolName) continue;
			consumedToolUseIds.add(toolUseBlock.id);
			items.push({
				type: "function_call",
				call_id: toolUseBlock.id,
				name: toolCall.toolName,
				arguments: JSON.stringify(toolCall.inputJson ?? toolUseBlock.input ?? {}),
			} as unknown as OAIMessage);
		}
	}

	flushTextBuffer();
	for (const [toolUseId, toolCall] of completedToolCalls.entries()) {
		if (consumedToolUseIds.has(toolUseId)) continue;
		items.push({
			type: "function_call",
			call_id: toolUseId,
			name: toolCall.toolName,
			arguments: JSON.stringify(toolCall.inputJson ?? {}),
		} as unknown as OAIMessage);
	}
	return items;
}

function compareOptionalOutputIndex(
	a: number | undefined,
	b: number | undefined,
	aSourceIndex: number,
	bSourceIndex: number,
): number {
	if (a != null && b != null) return a - b || aSourceIndex - bSourceIndex;
	if (a != null) return -1;
	if (b != null) return 1;
	return aSourceIndex - bSourceIndex;
}

async function buildResponsesHistory(
	dbMessages: DbMessage[],
	narratorId?: string,
	options: ReasoningReplayOptions = { strict: true },
): Promise<{
	history: OAIMessage[];
	trailingToolResults: ResponsesFunctionCallOutputMessage[];
}> {
	// Filter model-visible messages: user, assistant, sys (system context)
	// Exclude: system (legacy, kept for backward compatibility), disp (UI-only display messages)
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
	);

	if (topLevel.length > 0 && topLevel[topLevel.length - 1].role === "user") {
		topLevel.pop();
	}

	const history: OAIMessage[] = [];
	let pendingToolResults: ResponsesFunctionCallOutputMessage[] = [];

	for (const msg of topLevel) {
		if (msg.role === "assistant") {
			history.push(...pendingToolResults.flatMap(expandResponsesToolResultMessage));
			pendingToolResults = [];

			const assistantItems = buildResponsesAssistantItemsFromStoredContent(msg, options);
			if (assistantItems.length === 0) {
				continue;
			}
			history.push(...assistantItems);

			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						pendingToolResults.push(
							buildResponsesToolResultMessage(tc.toolUseId, outputToText(tc.outputJson)),
						);
					}
				}
			}
		} else if (msg.role === "user") {
			history.push(...pendingToolResults.flatMap(expandResponsesToolResultMessage));
			pendingToolResults = [];
			const userMessage = await buildResponsesUserMessageFromDbMessage(msg, narratorId);
			if (userMessage) history.push(userMessage);
		} else if (msg.role === "sys") {
			history.push(...pendingToolResults.flatMap(expandResponsesToolResultMessage));
			pendingToolResults = [];
			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const text = modelTextFromContentBlocks(content) || msg.contentText || "";
			// Emit sys context as a user-role input item rather than a developer
			// message. Developer/system items get hoisted into top-level
			// `instructions` (and, on Gemini-translating proxies, into
			// `system_instruction`), which can leave the conversation `input`
			// empty on turns whose only new content is a sys message (e.g. goal
			// continuation). Keeping it as a user turn guarantees non-empty input.
			if (text) {
				history.push(buildResponsesUserMessage(text));
			}
		}
	}

	return { history, trailingToolResults: pendingToolResults };
}

function buildOAIHistory(dbMessages: DbMessage[]): {
	history: OAIMessage[];
	trailingToolResults: OAIToolResult[];
} {
	// Filter model-visible messages: user, assistant, sys (system context)
	// Exclude: system (legacy, kept for backward compatibility), disp (UI-only display messages)
	const topLevel = dbMessages.filter(
		(m) => !m.parentToolUseId && (m.role === "user" || m.role === "assistant" || m.role === "sys"),
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
			) as Array<{
				type: "web_search";
				id: string;
				query?: string;
				queries?: string[];
				action?: import("./provider").WebSearchAction;
			}>;
			if (webSearchBlocks.length > 0) {
				const searchSummary = webSearchBlocks
					.map((ws) => {
						const action = ws.action;
						if (action?.type === "open_page" && action.url)
							return `[Web search: opened ${action.url}]`;
						if (action?.type === "find_in_page") {
							const parts = [action.pattern ? `'${action.pattern}'` : null, action.url].filter(
								Boolean,
							);
							return `[Web search: find ${parts.join(" in ")}]`;
						}
						const q =
							ws.query ||
							action?.query ||
							ws.queries?.join(", ") ||
							action?.queries?.join(", ") ||
							"unknown";
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
			const hasReasoningBlocks = reasoningBlocks.length > 0;
			if (!hasText && toolCalls.length === 0 && !hasReasoningBlocks) {
				// Skip empty assistant stubs (can happen after interrupted streaming).
				// Keeping them would become `content: null` in Responses API input and
				// trigger validation errors.
				continue;
			}

			// OpenAI requires assistant messages to have content (string|null) or tool_calls.
			// Use an empty string rather than null: many OpenAI-compatible endpoints
			// (local inference servers, translating proxies/gateways) reject null content
			// even though the official spec permits it when tool_calls is present.
			const assistantMsg: OAIMessage = { role: "assistant", content: hasText ? text : "" };
			if (toolCalls.length > 0) assistantMsg.tool_calls = toolCalls;
			// Attach reasoning blocks and plain-text fallback for Responses API history.
			if (reasoningBlocks.length > 0) {
				assistantMsg._reasoningBlocks = reasoningBlocks;
				assistantMsg._reasoningTextFallback = buildReasoningTextFallback(reasoningBlocks);
			}
			history.push(assistantMsg);

			// Collect tool results
			if (msg.toolCalls) {
				for (const tc of msg.toolCalls) {
					if (tc.status === "success" || tc.status === "fail") {
						pendingToolResults.push({
							tool_call_id: tc.toolUseId,
							content: outputToText(tc.outputJson),
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
		} else if (msg.role === "sys") {
			for (const tr of pendingToolResults) {
				history.push({ role: "tool", tool_call_id: tr.tool_call_id, content: tr.content });
			}
			pendingToolResults = [];

			const content = Array.isArray(msg.contentJson) ? msg.contentJson : [];
			const textParts = content
				.filter((b: { type: string }) => b.type === "text")
				.map((b: { text: string }) => b.text);
			const text = textParts.join("\n") || msg.contentText || "";
			// Emit sys context as a user-role message rather than a system message.
			// Gemini-translating proxies hoist every system message into
			// `system_instruction`, which can leave `contents` empty on turns
			// whose only new content is a sys message (e.g. goal continuation) and
			// trigger "contents is not specified". A user turn keeps it visible to
			// the model while guaranteeing non-empty conversation content.
			if (text) {
				history.push({ role: "user", content: text });
			}
		}
	}

	return { history, trailingToolResults: pendingToolResults };
}

/**
 * Plain-text degradation of an OAI assistant message's reasoning blocks, for
 * relay (non credential-strict) models on the Responses path. Unlike
 * {@link buildReasoningTextFallback} this includes blocks that DO carry
 * `encrypted_content`: the credential is meaningless to a non-OpenAI upstream,
 * so the text is all we keep.
 */
function relayReasoningText(
	m:
		| {
				_reasoningBlocks?: Array<{
					text: string;
					providerMetadata?: import("./types").ReasoningProviderMetadata;
				}>;
		  }
		| null
		| undefined,
): string {
	if (!m?._reasoningBlocks?.length) return "";
	return m._reasoningBlocks
		.map((rb) => rb.text?.trim() ?? "")
		.filter((text) => text.length > 0)
		.join("\n");
}

/**
 * Build a plain-text reasoning fallback for blocks that cannot be replayed as
 * Responses API reasoning items (for example because encrypted_content is absent).
 */
function buildReasoningTextFallback(
	reasoningBlocks:
		| Array<{
				text: string;
				providerMetadata?: import("./types").ReasoningProviderMetadata;
		  }>
		| undefined,
): string {
	if (!reasoningBlocks?.length) return "";

	const parts: string[] = [];
	for (const block of reasoningBlocks) {
		const text = block.text?.trim();
		if (!text) continue;
		const openaiMeta = block.providerMetadata?.openai;
		if (openaiMeta?.reasoningEncryptedContent) {
			continue;
		}
		if (openaiMeta?.itemId) {
			logger.debug("Using non-replayable historical reasoning summary as text fallback", {
				itemId: openaiMeta.itemId,
			});
		}
		parts.push(text);
	}

	return parts.join("\n");
}

// === Responses API history converter ===

/**
 * Convert standard Chat Completions history to Responses API format.
 * Transforms:
 *   - { role: "system" }  → { role: "developer" }
 *   - { role: "tool" }    → { type: "function_call_output", call_id, output }
 *   - { role: "assistant", tool_calls } → separate { type: "function_call" } items + text
 *
 * `options` carries the reasoning replay policy (see {@link ReasoningReplayOptions}).
 * Strict models replay only source-matching encrypted items. Non-strict models
 * also replay explicitly marked, same-source native plaintext; other reasoning
 * falls back to assistant text, without forwarding foreign credentials.
 */
export function convertHistoryToResponsesApi(
	messages: OAIMessage[],
	options: ReasoningReplayOptions = { strict: true },
): OAIMessage[] {
	/** Apply the same replay policy as live turns and stored Responses history. */
	const pushReasoningItems = (m: {
		_reasoningBlocks?: Array<{
			text: string;
			providerMetadata?: import("./types").ReasoningProviderMetadata;
		}>;
	}) => {
		if (!m._reasoningBlocks?.length) return;
		for (const rb of m._reasoningBlocks) {
			const item = serializeResponsesReasoning(rb, options);
			if (item) result.push(item);
			// No credential or a foreign one: dropped — echoing it would fail
			// verification upstream and wedge the conversation.
		}
	};

	const result: OAIMessage[] = [];
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
									return {
										type: "input_image",
										image_url: part.image_url.url,
										...(part.imageRef ? { imageRef: part.imageRef } : {}),
									};
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
			// Split assistant message with tool_calls into:
			// 1. source-matching encrypted/native reasoning items; non-strict
			//    models retain other reasoning as a leading assistant message
			// 2. assistant text
			// 3. separate function_call items

			pushReasoningItems(m);
			if (!options.strict) {
				const fallback = relayReasoningText({
					...m,
					_reasoningBlocks: m._reasoningBlocks?.filter(
						(block: ResponsesReasoningBlock) => !serializeResponsesReasoning(block, options),
					),
				});
				if (fallback) {
					result.push({
						role: "assistant",
						content: [{ type: "output_text", text: fallback }],
					} as unknown as OAIMessage);
				}
			}

			// 2. Output assistant text
			const content =
				typeof m.content === "string" ? [{ type: "output_text", text: m.content }] : m.content;
			if (content) {
				result.push({ role: "assistant", content } as unknown as OAIMessage);
			}

			// 3. Output function_call items
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

			pushReasoningItems(m);
			// Only non-replayable relay text falls back to an assistant message.
			const fallback = options.strict
				? ""
				: relayReasoningText({
						...m,
						_reasoningBlocks: m._reasoningBlocks?.filter(
							(block: ResponsesReasoningBlock) => !serializeResponsesReasoning(block, options),
						),
					});

			const content = m.content;
			if (typeof content === "string") {
				const merged = mergeAssistantText(content, fallback);
				if (!merged) continue;
				result.push({
					role: "assistant",
					content: [{ type: "output_text", text: merged }],
				} as unknown as OAIMessage);
				continue;
			}
			if (Array.isArray(content) && content.length > 0) {
				result.push({ role: "assistant", content } as unknown as OAIMessage);
			} else if (fallback) {
				result.push({
					role: "assistant",
					content: [{ type: "output_text", text: fallback }],
				} as unknown as OAIMessage);
			}
		} else if (
			m.type === "function_call_output" ||
			m.type === "function_call" ||
			m.type === "web_search_call" ||
			m.type === "image_generation_call" ||
			m.type === "reasoning"
		) {
			// Already in Responses API format — pass through.
			// Strip `id` from web_search_call: the upstream Responses API does not
			// accept it on input items (codex-rs skips serializing it).
			if (m.type === "web_search_call" && m.id != null) {
				const { id: _stripped, ...rest } = m;
				result.push(rest as unknown as OAIMessage);
			} else {
				result.push(msg);
			}
		} else {
			result.push(msg);
		}
	}
	return result;
}
