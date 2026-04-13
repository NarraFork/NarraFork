// Codex Provider — uses the centralized CodexManager for multi-account OAuth
// Wraps OpenAIProvider with dynamic credential selection
// Supports both HTTP (default) and Responses WebSocket modes

import { type CallContext, getCodexManager } from "../codex-manager";
import { logger } from "../logger";
import { parseModelId, settings } from "../settings";
import {
	type CodexResponsesRequestBody,
	CodexWebSocketFallbackError,
	streamCodexResponsesWebSocket,
} from "./codex-websocket";
import {
	CODEX_DEFAULT_INSTRUCTIONS,
	convertHistoryToResponsesApi,
	normalizeCodexReasoningEffort,
	type OAIContentPart,
	type OAIMessage,
	OpenAIProvider,
} from "./openai-provider";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import type { AgentToolUse, ResolvedToolDefinition } from "./types";

function classifyCodexError(
	err: unknown,
): { type: "quota_exhausted"; message?: string; resetsAt?: number } | { type: "other" } {
	const msg = err instanceof Error ? err.message : String(err ?? "");
	const lower = msg.toLowerCase();
	if (
		lower.includes("usage_limit_reached") ||
		(lower.includes("usage limit") && lower.includes("reached")) ||
		lower.includes('"plan_type":"free"') ||
		lower.includes("insufficient_balance") ||
		lower.includes("insufficient balance") ||
		(lower.includes("402") && lower.includes("insufficient"))
	) {
		const resetsAtMatch = msg.match(/"resets_at"\s*:\s*(\d+)/);
		const parsedSec = resetsAtMatch?.[1] ? Number.parseInt(resetsAtMatch[1], 10) : Number.NaN;
		const resetsAt = Number.isFinite(parsedSec) ? parsedSec * 1000 : undefined;
		return { type: "quota_exhausted", message: msg, resetsAt };
	}
	return { type: "other" };
}

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

export interface CodexProviderOptions {
	/** Use WebSocket instead of HTTP for streaming (experimental) */
	useWebSocket?: boolean;
}

/**
 * Codex provider that uses the centralized credential pool.
 * Wraps OpenAIProvider with dynamic credential selection from CodexManager.
 * Supports both HTTP (default) and WebSocket modes.
 */
export class CodexProvider implements ProviderAdapter {
	private manager = getCodexManager();
	private context: CallContext | null = null;
	private contextSessionKey: string | undefined;
	private useWebSocket: boolean;
	/** Cached dummy provider for synchronous operations (formatToolResult, pushUserTurn, etc.) */
	private dummyProvider: OpenAIProvider;

	constructor(options?: CodexProviderOptions) {
		this.useWebSocket = options?.useWebSocket ?? true;
		// Create dummy provider once and reuse it
		this.dummyProvider = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
	}

	/** Get or acquire a valid credential context. */
	private async getContext(sessionKey?: string): Promise<CallContext> {
		if (this.context?.token) {
			const sameSession = (this.contextSessionKey ?? "") === (sessionKey ?? "");
			if (sameSession) {
				// Check if token is still valid (with 60s buffer) and credential wasn't disabled.
				const cred = this.context.credential;
				if (!cred.disabled && cred.expiresAt && cred.expiresAt > Date.now() + 60_000) {
					return this.context;
				}
			}
		}
		this.context = await this.manager.acquireContext(sessionKey);
		this.contextSessionKey = sessionKey;
		return this.context;
	}

	private refreshUsageOnUse(id: string): void {
		void this.manager.refreshUsageOnUseIfNeeded(id).catch((err) => {
			logger.warn("Codex usage refresh on use failed", {
				credentialId: id,
				error: err instanceof Error ? err.message : String(err),
			});
		});
	}

	/** Create a temporary OpenAIProvider with the current credential. */
	private createProvider(ctx: CallContext): OpenAIProvider {
		const proxy = settings.codex?.proxy;

		return new OpenAIProvider(
			{
				id: "codex",
				name: "Codex",
				prefix: "codex",
				apiKey: ctx.token, // Use OAuth access token as API key
				baseUrl: CODEX_BASE_URL,
				defaultModel: "gpt-5.3-codex",
				apiMode: "codex",
				codexAccountId: ctx.credential.accountId,
			},
			proxy,
		);
	}

	private getMaxFailoverAttempts(): number {
		return Math.max(this.manager.snapshot().available, 1);
	}

	private reportCallError(
		ctx: CallContext,
		err: unknown,
	): {
		classified: ReturnType<typeof classifyCodexError>;
		hasMore: boolean;
	} {
		const classified = classifyCodexError(err);
		const hasMore =
			classified.type === "quota_exhausted"
				? this.manager.reportQuotaExhausted(ctx.id, classified.resetsAt)
				: this.manager.reportFailure(ctx.id);

		if (classified.type === "quota_exhausted") {
			logger.warn("Codex credential quota exhausted", {
				credentialId: ctx.id,
				accountId: ctx.credential.accountId,
				resetsAt: classified.resetsAt,
				error: classified.message,
				hasMore,
			});
		}
		if (!hasMore) {
			logger.error("All Codex credentials exhausted");
		}

		return { classified, hasMore };
	}

	private async runWithFailover<T>(
		operationName: string,
		run: (provider: OpenAIProvider) => Promise<T>,
	): Promise<T> {
		const maxAttempts = this.getMaxFailoverAttempts();
		let attempt = 0;
		let lastError: unknown;

		while (attempt < maxAttempts) {
			const ctx = await this.getContext();
			this.refreshUsageOnUse(ctx.id);
			const provider = this.createProvider(ctx);

			try {
				const result = await run(provider);
				this.manager.reportSuccess(ctx.id);
				return result;
			} catch (err) {
				lastError = err;
				attempt++;
				const { classified, hasMore } = this.reportCallError(ctx, err);
				const shouldRetry =
					classified.type === "quota_exhausted" && hasMore && attempt < maxAttempts;
				if (shouldRetry) {
					this.context = null;
					this.contextSessionKey = undefined;
					logger.info("Codex quota failover: retrying with next credential", {
						operation: operationName,
						attempt,
						maxAttempts,
						previousCredentialId: ctx.id,
					});
					continue;
				}
				throw err;
			}
		}

		if (lastError instanceof Error) throw lastError;
		throw new Error("Codex request failed");
	}

	formatTools(tools: ResolvedToolDefinition[]): unknown[] {
		// Use a dummy provider just for formatting
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		return dummy.formatTools(tools);
	}

	async buildHistory(
		dbMessages: DbMessage[],
		model: string,
		narratorId?: string,
	): Promise<{ history: unknown[]; trailingToolResults: unknown[] }> {
		const ctx = await this.getContext();
		const provider = this.createProvider(ctx);
		return provider.buildHistory(dbMessages, model, narratorId);
	}

	injectSystemPrompt(
		history: unknown[],
		systemPrompt: string,
		model: string,
		locale?: string,
	): void {
		// This is synchronous, so we can't await. Use a dummy provider.
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		dummy.injectSystemPrompt(history, systemPrompt, model, locale);
	}

	async *chat(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		// Use WebSocket mode if enabled
		if (this.useWebSocket) {
			yield* this.chatWebSocket(params);
			return;
		}

		// Default HTTP mode
		const maxAttempts = this.getMaxFailoverAttempts();
		let attempt = 0;
		let lastError: unknown;

		while (attempt < maxAttempts) {
			const ctx = await this.getContext(params.stickySessionKey);
			this.refreshUsageOnUse(ctx.id);
			const provider = this.createProvider(ctx);
			let hasStreamedEvents = false;

			try {
				for await (const event of provider.chat(params)) {
					hasStreamedEvents = true;
					// Inject credentialId into the event
					yield { ...event, credentialId: ctx.id };
				}
				this.manager.reportSuccess(ctx.id);
				return;
			} catch (err) {
				lastError = err;
				attempt++;

				const { classified, hasMore } = this.reportCallError(ctx, err);
				const shouldRetry =
					classified.type === "quota_exhausted" &&
					hasMore &&
					!hasStreamedEvents &&
					attempt < maxAttempts;
				if (shouldRetry) {
					this.context = null;
					this.contextSessionKey = undefined;
					logger.info("Codex quota failover: retrying with next credential", {
						operation: "chat",
						attempt,
						maxAttempts,
						previousCredentialId: ctx.id,
					});
					continue;
				}
				throw err;
			}
		}

		if (lastError instanceof Error) throw lastError;
		throw new Error("Codex chat failed");
	}

	/** WebSocket-based chat implementation */
	private async *chatWebSocket(params: ChatParams): AsyncGenerator<ParsedStreamEvent> {
		const maxAttempts = this.getMaxFailoverAttempts();
		let attempt = 0;
		let lastError: unknown;

		while (attempt < maxAttempts) {
			const ctx = await this.getContext(params.stickySessionKey);
			this.refreshUsageOnUse(ctx.id);
			const provider = this.createProvider(ctx);
			let hasStreamedEvents = false;

			try {
				const request = this.buildResponsesWebSocketRequest(params);
				params.requestDump?.setRequest({
					transport: "websocket",
					url: `${CODEX_BASE_URL.replace(/\/+$/, "")}/responses`,
					headers: {
						Authorization: "Bearer [REDACTED]",
						originator: "narrafork",
						OpenAI_Beta: "responses_websockets=2026-02-06",
					},
					body: { type: "response.create", ...request },
				});

				for await (const event of streamCodexResponsesWebSocket({
					baseUrl: CODEX_BASE_URL,
					apiKey: ctx.token,
					accountId: ctx.credential.accountId,
					proxy: settings.codex?.proxy,
					sessionKey: params.stickySessionKey ?? params.conversationId,
					credentialId: ctx.id,
					model: params.model,
					request,
					signal: params.signal,
				})) {
					hasStreamedEvents = true;
					yield { ...event, credentialId: ctx.id };
				}
				this.manager.reportSuccess(ctx.id);
				return;
			} catch (err) {
				if (err instanceof CodexWebSocketFallbackError) {
					logger.warn("Codex Responses WebSocket unavailable, falling back to HTTP", {
						credentialId: ctx.id,
						status: err.status,
						error: err.message,
					});
					for await (const event of provider.chat(params)) {
						hasStreamedEvents = true;
						yield { ...event, credentialId: ctx.id };
					}
					this.manager.reportSuccess(ctx.id);
					return;
				}

				lastError = err;
				attempt++;

				const { classified, hasMore } = this.reportCallError(ctx, err);
				const shouldRetry =
					classified.type === "quota_exhausted" &&
					hasMore &&
					!hasStreamedEvents &&
					attempt < maxAttempts;
				if (shouldRetry) {
					this.context = null;
					this.contextSessionKey = undefined;
					logger.info("Codex Responses WebSocket quota failover: retrying with next credential", {
						operation: "chat",
						attempt,
						maxAttempts,
						previousCredentialId: ctx.id,
					});
					continue;
				}
				throw err;
			}
		}

		if (lastError instanceof Error) throw lastError;
		throw new Error("Codex Responses WebSocket chat failed");
	}

	private buildResponsesWebSocketRequest(params: ChatParams): CodexResponsesRequestBody {
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

		let instructions = "";
		const inputMessages: OAIMessage[] = [];
		for (const msg of messages) {
			if (msg.role === "system") {
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
			input: convertHistoryToResponsesApi(sanitizedInputMessages),
			stream: true,
			store: false,
			prompt_cache_key: params.conversationId,
			parallel_tool_calls: true,
		};
		request.instructions = instructions || CODEX_DEFAULT_INSTRUCTIONS;
		const tools = Array.isArray(params.tools) ? [...params.tools] : [];
		tools.push({ type: "web_search" });
		request.tools = tools;

		const reasoningEffort = normalizeCodexReasoningEffort(model, params.reasoningEffort);
		if (reasoningEffort) {
			request.reasoning = {
				effort: reasoningEffort,
				summary: "auto",
			};
			request.include = ["reasoning.encrypted_content"];
		}
		if (params.serviceTier) {
			request.service_tier = params.serviceTier;
		}

		return request;
	}

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
	): unknown {
		return this.dummyProvider.formatToolResult(toolUseId, output, isError, images);
	}

	pushUserTurn(history: unknown[], content: string, model: string, toolResults: unknown[]): void {
		this.dummyProvider.pushUserTurn(history, content, model, toolResults);
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
		}>,
	): void {
		this.dummyProvider.pushAssistantTurn(history, text, toolUses, reasoningBlocks, webSearches);
	}

	async generate(text: string, model: string): Promise<string> {
		return this.runWithFailover("generate", (provider) => provider.generate(text, model));
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
	): Promise<{ text: string; contextPercent?: number }> {
		return this.runWithFailover("generateWithMeta", (provider) =>
			provider.generateWithMeta(text, model, systemInstruction),
		);
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
		return this.runWithFailover("generateWithHistory", (provider) =>
			provider.generateWithHistory(systemInstruction, content, model, locale),
		);
	}
}
