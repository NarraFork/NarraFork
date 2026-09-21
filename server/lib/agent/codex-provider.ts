// Codex Provider — uses the centralized CodexManager for multi-account OAuth
// Wraps OpenAIProvider with dynamic credential selection
// Supports both HTTP (default) and Responses WebSocket modes

import {
	extractPolicyViolationCode,
	isPolicyViolationCode,
} from "@shared/agent-protocol/policy-violation";
import { hasCredentialBoundReasoning } from "@shared/reasoning-credentials";
import { isAgentTaskInvalidMessage } from "../codex-agent-identity";
import { type CallContext, getCodexManager } from "../codex-manager";
import { isUnauthorizedCodexUsageError } from "../codex-usage";
import { getInstallationId } from "../installation-id";
import { logger } from "../logger";
import { resolveOverride } from "../net/proxy";
import { isNativeSearchChannelFirstEnabled } from "../search/native";
import { parseModelId, settings } from "../settings";
import { getHttpCodexUserAgent, resolveClientFingerprint } from "../user-agent";
import { CodexRebuildHistoryRetryError } from "./codex-errors";
import { applyCodexStableRequestFields, createCodexRequestIdentity } from "./codex-request";
import {
	type CodexResponsesRequestBody,
	CodexWebSocketFallbackError,
	CodexWebSocketRetryableError,
	shouldTreatCodexStreamEventAsYielded,
	streamCodexResponsesWebSocket,
} from "./codex-websocket";
import {
	appendCodexNativeTools,
	CODEX_DEFAULT_INSTRUCTIONS,
	convertHistoryToResponsesApi,
	type OAIContentPart,
	type OAIMessage,
	OpenAIProvider,
	resolveCodexRequestReasoningEffort,
	stampReasoningSource,
} from "./openai-provider";
import type {
	ChatParams,
	DbMessage,
	GenerateMetaResult,
	GenerateOptions,
	ParsedStreamEvent,
	ProviderAdapter,
} from "./provider";
import type { AgentToolUse, ResolvedToolDefinition } from "./types";

function getCodexProviderErrorMessage(err: unknown): string {
	if (err instanceof Error) return err.message;
	if (typeof err === "string") return err;
	if (err && typeof err === "object") {
		const obj = err as Record<string, unknown>;
		if (typeof obj.message === "string" && obj.message) return obj.message;
		if (obj.error instanceof Error) return obj.error.message;
		if (typeof obj.error === "string" && obj.error) return obj.error;
		if (obj.error && typeof obj.error === "object") {
			const nested = obj.error as Record<string, unknown>;
			if (typeof nested.message === "string" && nested.message) return nested.message;
		}
	}
	return String(err ?? "");
}

export function isCodexProviderExpected101WebSocketFailure(err: unknown): boolean {
	return /Expected\s+101\s+status\s+code/i.test(getCodexProviderErrorMessage(err));
}

function classifyCodexError(
	err: unknown,
):
	| { type: "quota_exhausted"; message?: string; resetsAt?: number }
	| { type: "policy_violation"; code: string }
	| { type: "other" } {
	// A policy violation (cyber_policy) indicted the request content, not the
	// credential — it must be recognized before any message-based bucket so it
	// can skip failure reporting and failover entirely.
	const violationCode = extractPolicyViolationCode(err);
	if (violationCode) {
		return { type: "policy_violation", code: violationCode };
	}
	const msg = getCodexProviderErrorMessage(err);
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

/**
 * Resolve the client-fingerprint config for the built-in Codex adapter from
 * `settings.codex`. The adapter always presents itself as the Codex client;
 * users can still override the UA or individual headers via settings.
 */
function codexFingerprintConfig(): {
	userAgentMode?: "narrafork" | "claude-code" | "codex" | "custom";
	customUserAgent?: string;
	extraHeaders?: Record<string, string>;
} {
	const codex = settings.codex;
	return {
		userAgentMode: codex?.userAgentMode ?? "codex",
		customUserAgent: codex?.customUserAgent,
		extraHeaders: codex?.extraHeaders,
	};
}

function resolveCodexProviderFingerprint(conversationId: string) {
	const config = codexFingerprintConfig();
	return resolveClientFingerprint({
		mode: config.userAgentMode,
		custom: config.customUserAgent,
		fallback: getHttpCodexUserAgent(),
		extraHeaders: config.extraHeaders,
		installationId: getInstallationId(),
		conversationId,
	});
}

export interface CodexProviderOptions {
	/** Use WebSocket instead of HTTP for streaming (experimental) */
	useWebSocket?: boolean;
	/** Allow the native web_search tool to be sent to Codex models. */
	useWebSearch?: boolean;
	/** Allow the native image_generation tool to be sent to Codex models. */
	useImageGeneration?: boolean;
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
	private useWebSearch: boolean;
	private useImageGeneration: boolean;
	/** Cached dummy provider for synchronous operations (formatToolResult, pushUserTurn, etc.) */
	private dummyProvider: OpenAIProvider;

	constructor(options?: CodexProviderOptions) {
		const mode = settings.codex?.loadBalancingMode;
		if (mode === "priority" || mode === "balanced" || mode === "tier-balanced") {
			this.manager.setLoadBalancingMode(mode);
		}
		this.manager.setTierOrder(settings.codex?.tierOrder);
		this.useWebSocket = options?.useWebSocket ?? true;
		this.useWebSearch = options?.useWebSearch ?? true;
		this.useImageGeneration = options?.useImageGeneration ?? true;
		// Create dummy provider once and reuse it
		this.dummyProvider = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexWebSearch: this.useWebSearch,
			codexImageGeneration: this.useImageGeneration,
			...codexFingerprintConfig(),
		});
	}

	/** Get or acquire a valid credential context. */
	private async getContext(sessionKey?: string): Promise<CallContext> {
		// Agent Identity assertions are time-stamped and must be rebuilt per request,
		// so never reuse a cached context for them.
		if (this.context?.token && this.context.credential.authMode !== "agent_identity") {
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
		// Resolve codex's own proxy override (absent/"default" → global). The
		// resolved string is passed to OpenAIProvider so it covers both HTTP
		// (via pfetch precedence) and the WebSocket path, never falling back to
		// the global policy and losing codex's override.
		const proxy = resolveOverride(settings.codex?.proxy);

		return new OpenAIProvider(
			{
				id: "codex",
				name: "Codex",
				prefix: "codex",
				apiKey: ctx.token, // OAuth/PAT access token (empty for agent identity)
				// Full Authorization header (Bearer or AgentAssertion) resolved by the manager.
				authorizationHeader: ctx.authorization,
				baseUrl: CODEX_BASE_URL,
				defaultModel: "gpt-5.5",
				apiMode: "codex",
				codexAccountId: ctx.credential.accountId,
				codexWebSearch: this.useWebSearch,
				codexImageGeneration: this.useImageGeneration,
				...codexFingerprintConfig(),
			},
			proxy,
		);
	}

	private getMaxFailoverAttempts(): number {
		return Math.max(this.manager.snapshot().available, 1);
	}

	private getCredentialSnapshot(id: string) {
		return this.manager.snapshot().entries.find((entry) => entry.id === id);
	}

	private async resolveExpected101WebSocketFailure(
		ctx: CallContext,
		err: unknown,
	): Promise<"not_expected_101" | "retry_sse" | "credential_unavailable"> {
		if (!isCodexProviderExpected101WebSocketFailure(err)) return "not_expected_101";
		const websocketErrorMessage = getCodexProviderErrorMessage(err);

		try {
			await this.manager.getUsage(ctx.id);
			const credential = this.getCredentialSnapshot(ctx.id);
			if (credential?.disabled) {
				this.context = null;
				this.contextSessionKey = undefined;
				logger.warn(
					"Codex Responses WebSocket expected 101 failure; usage check disabled credential",
					{
						credentialId: ctx.id,
						accountId: ctx.credential.accountId,
						disabledReason: credential.disabledReason,
						error: websocketErrorMessage,
					},
				);
				return "credential_unavailable";
			}
			logger.warn(
				"Codex Responses WebSocket expected 101 failure; usage check passed, retrying via SSE",
				{
					credentialId: ctx.id,
					accountId: ctx.credential.accountId,
					error: websocketErrorMessage,
				},
			);
			return "retry_sse";
		} catch (usageError) {
			if (isUnauthorizedCodexUsageError(usageError)) {
				this.manager.markBanned(ctx.id);
				this.context = null;
				this.contextSessionKey = undefined;
				logger.warn("Codex credential usage check returned 401; marked credential as banned", {
					credentialId: ctx.id,
					accountId: ctx.credential.accountId,
					websocketError: websocketErrorMessage,
					usageError: getCodexProviderErrorMessage(usageError),
				});
				return "credential_unavailable";
			}

			logger.warn(
				"Codex Responses WebSocket expected 101 failure; usage check was inconclusive, retrying via SSE",
				{
					credentialId: ctx.id,
					accountId: ctx.credential.accountId,
					websocketError: websocketErrorMessage,
					usageError: getCodexProviderErrorMessage(usageError),
				},
			);
			return "retry_sse";
		}
	}

	private async reportCallError(
		ctx: CallContext,
		err: unknown,
	): Promise<{
		classified: ReturnType<typeof classifyCodexError>;
		hasMore: boolean;
	}> {
		const classified = classifyCodexError(err);
		if (classified.type === "policy_violation") {
			// Content-level violation: the credential is healthy, so never count a
			// failure (which would eventually disable it as too_many_failures) and
			// never rotate — replaying the violating prompt against another account
			// spreads the ban risk across the pool.
			logger.warn("Codex request blocked by upstream policy violation", {
				credentialId: ctx.id,
				accountId: ctx.credential.accountId,
				code: classified.code,
			});
			return { classified, hasMore: false };
		}
		const hasMore =
			classified.type === "quota_exhausted"
				? await this.manager.reportQuotaExhaustedAndRefreshUsage(ctx.id, classified.resetsAt)
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

	/**
	 * If the error is an Agent Identity task-invalid 401, clear+re-register the
	 * task and signal the caller to retry with the same credential. Returns true
	 * when recovery succeeded and a retry should be attempted.
	 */
	private async tryRecoverAgentIdentityTask(ctx: CallContext, err: unknown): Promise<boolean> {
		if (ctx.credential.authMode !== "agent_identity") return false;
		const message = getCodexProviderErrorMessage(err);
		if (!isAgentTaskInvalidMessage(message)) return false;
		const recovered = await this.manager.recoverAgentIdentityTask(ctx.id, 401, message);
		if (recovered) {
			this.context = null;
			this.contextSessionKey = undefined;
			logger.info("Codex agent identity task recovered after 401; retrying", {
				credentialId: ctx.id,
				accountId: ctx.credential.accountId,
			});
		}
		return recovered;
	}

	private throwRebuildHistoryRetry(ctx: CallContext, operation: string, cause: unknown): never {
		this.context = null;
		this.contextSessionKey = undefined;
		const causeMessage = cause instanceof Error ? cause.message : String(cause ?? "");
		logger.info("Codex quota failover requires rebuilt history before retrying", {
			operation,
			previousCredentialId: ctx.id,
			accountId: ctx.credential.accountId,
			error: causeMessage,
		});
		throw new CodexRebuildHistoryRetryError(
			causeMessage || "Codex credential quota exhausted; retrying with rebuilt history",
			{ previousCredentialId: ctx.id, operation },
		);
	}

	private async shouldRetryAfterFallbackError(
		ctx: CallContext,
		err: unknown,
		hasStreamedEvents: boolean,
		attempt: number,
		maxAttempts: number,
		operation: string,
	): Promise<boolean> {
		const { classified, hasMore } = await this.reportCallError(ctx, err);
		const shouldRetry =
			classified.type === "quota_exhausted" &&
			hasMore &&
			!hasStreamedEvents &&
			attempt < maxAttempts;
		if (shouldRetry) {
			this.context = null;
			this.contextSessionKey = undefined;
			logger.info("Codex SSE fallback quota failover: retrying with next credential", {
				operation,
				attempt,
				maxAttempts,
				previousCredentialId: ctx.id,
			});
		}
		if (classified.type === "quota_exhausted" && hasMore && hasStreamedEvents) {
			this.throwRebuildHistoryRetry(ctx, operation, err);
		}
		return shouldRetry;
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
				if (attempt < maxAttempts && (await this.tryRecoverAgentIdentityTask(ctx, err))) {
					continue;
				}
				const { classified, hasMore } = await this.reportCallError(ctx, err);
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
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexWebSearch: this.useWebSearch,
			codexImageGeneration: this.useImageGeneration,
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
			defaultModel: "gpt-5.5",
			apiMode: "codex",
			codexWebSearch: this.useWebSearch,
			codexImageGeneration: this.useImageGeneration,
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
			const chatParams: ChatParams = {
				...params,
				onRequestStart: (info) =>
					params.onRequestStart?.({ credentialId: info?.credentialId ?? ctx.id }),
			};
			let hasStreamedEvents = false;
			let sawPolicyViolation = false;

			try {
				for await (const event of provider.chat(chatParams)) {
					hasStreamedEvents ||= shouldTreatCodexStreamEventAsYielded(event);
					// A policy-violation terminal event says nothing about credential
					// health — count it as neither success nor failure.
					sawPolicyViolation ||= isPolicyViolationCode(event.invalidState?.reason);
					// Inject credentialId into the event
					yield { ...event, credentialId: ctx.id };
				}
				if (!sawPolicyViolation) {
					this.manager.reportSuccess(ctx.id);
				}
				return;
			} catch (err) {
				if (params.signal.aborted) {
					throw err;
				}
				lastError = err;
				attempt++;

				if (
					!hasStreamedEvents &&
					attempt < maxAttempts &&
					(await this.tryRecoverAgentIdentityTask(ctx, err))
				) {
					continue;
				}

				const { classified, hasMore } = await this.reportCallError(ctx, err);
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
				if (classified.type === "quota_exhausted" && hasMore && hasStreamedEvents) {
					this.throwRebuildHistoryRetry(ctx, "chat", err);
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
			const chatParams: ChatParams = {
				...params,
				onRequestStart: (info) =>
					params.onRequestStart?.({ credentialId: info?.credentialId ?? ctx.id }),
			};
			let hasStreamedEvents = false;
			let sawPolicyViolation = false;

			try {
				const request = this.buildResponsesWebSocketRequest(params);
				const fingerprint = resolveCodexProviderFingerprint(params.conversationId);

				params.onRequestStart?.({ credentialId: ctx.id });
				for await (const event of streamCodexResponsesWebSocket({
					baseUrl: CODEX_BASE_URL,
					apiKey: ctx.token,
					authorization: ctx.authorization,
					accountId: ctx.credential.accountId,
					proxy: resolveOverride(settings.codex?.proxy),
					sessionKey: params.stickySessionKey ?? params.conversationId,
					conversationId: params.conversationId,
					narratorId: params.stickySessionKey,
					credentialId: ctx.id,
					model: params.model,
					request,
					signal: params.signal,
					resetSessionBeforeRequest: params.resetUpstreamSession,
					userAgent: fingerprint.userAgent,
					extraHeaders: fingerprint.headers,
					requestDump: params.requestDump,
					requestDumpMaxBytes: settings.agent?.requestDumpMaxSize,
				})) {
					hasStreamedEvents ||= shouldTreatCodexStreamEventAsYielded(event);
					// Same neutrality rule as the SSE path: a policy violation is a
					// content verdict, not a credential-health signal.
					sawPolicyViolation ||= isPolicyViolationCode(event.invalidState?.reason);
					// The WebSocket path bypasses OpenAIProvider.chat(), so tag encrypted
					// reasoning credentials with the "codex" identity here — without it,
					// the strict replay check on the next turn cannot prove ownership
					// and would drop the credential.
					yield { ...stampReasoningSource(event, "codex"), credentialId: ctx.id };
				}
				if (!sawPolicyViolation) {
					this.manager.reportSuccess(ctx.id);
				}
				return;
			} catch (err) {
				if (params.signal.aborted) {
					throw err;
				}

				// The transport already exhausted its own reconnect budget for this error and
				// classified it as retryable. Surface it unchanged: routing it through the
				// failover path below would call reportFailure() and penalize a perfectly
				// healthy credential for what is a connection-lifetime event, and could
				// eventually disable it as "too_many_failures".
				if (err instanceof CodexWebSocketRetryableError) {
					logger.warn("Codex Responses WebSocket transport error is retryable upstream", {
						credentialId: ctx.id,
						status: err.status,
						code: err.code,
						resumable: err.resumable,
						hasStreamedEvents,
						error: err.message,
					});
					throw err;
				}

				const expected101Decision = await this.resolveExpected101WebSocketFailure(ctx, err);
				if (expected101Decision === "retry_sse") {
					try {
						for await (const event of provider.chat(chatParams)) {
							hasStreamedEvents ||= shouldTreatCodexStreamEventAsYielded(event);
							sawPolicyViolation ||= isPolicyViolationCode(event.invalidState?.reason);
							yield { ...event, credentialId: ctx.id };
						}
						if (!sawPolicyViolation) {
							this.manager.reportSuccess(ctx.id);
						}
						return;
					} catch (fallbackErr) {
						if (params.signal.aborted) throw fallbackErr;
						lastError = fallbackErr;
						attempt++;
						if (
							await this.shouldRetryAfterFallbackError(
								ctx,
								fallbackErr,
								hasStreamedEvents,
								attempt,
								maxAttempts,
								"chat",
							)
						) {
							continue;
						}
						throw fallbackErr;
					}
				}
				if (expected101Decision === "credential_unavailable") {
					lastError = err;
					attempt++;
					const hasMore = this.manager.snapshot().available > 0;
					if (hasMore && !hasStreamedEvents && attempt < maxAttempts) {
						logger.info("Codex unavailable credential failover: retrying with next credential", {
							operation: "chat",
							attempt,
							maxAttempts,
							previousCredentialId: ctx.id,
						});
						continue;
					}
					throw err;
				}

				if (err instanceof CodexWebSocketFallbackError) {
					logger.warn("Codex Responses WebSocket unavailable, falling back to SSE", {
						credentialId: ctx.id,
						status: err.status,
						error: err.message,
					});
					try {
						for await (const event of provider.chat(chatParams)) {
							hasStreamedEvents ||= shouldTreatCodexStreamEventAsYielded(event);
							sawPolicyViolation ||= isPolicyViolationCode(event.invalidState?.reason);
							yield { ...event, credentialId: ctx.id };
						}
						if (!sawPolicyViolation) {
							this.manager.reportSuccess(ctx.id);
						}
						return;
					} catch (fallbackErr) {
						if (params.signal.aborted) throw fallbackErr;
						lastError = fallbackErr;
						attempt++;
						if (
							await this.shouldRetryAfterFallbackError(
								ctx,
								fallbackErr,
								hasStreamedEvents,
								attempt,
								maxAttempts,
								"chat",
							)
						) {
							continue;
						}
						throw fallbackErr;
					}
				}

				lastError = err;
				attempt++;

				if (
					!hasStreamedEvents &&
					attempt < maxAttempts &&
					(await this.tryRecoverAgentIdentityTask(ctx, err))
				) {
					continue;
				}

				const { classified, hasMore } = await this.reportCallError(ctx, err);
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
				if (classified.type === "quota_exhausted" && hasMore && hasStreamedEvents) {
					this.throwRebuildHistoryRetry(ctx, "chat", err);
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
				// Codex runs official gpt/codex ids → credential-strict replay. The
				// reasoning source identity is the "codex" prefix shared by every
				// provider instance this class creates.
				strict: hasCredentialBoundReasoning(model),
				currentSource: "codex",
			}),
			stream: true,
			store: false,
		};
		request.instructions = instructions || CODEX_DEFAULT_INSTRUCTIONS;
		const tools = Array.isArray(params.tools) ? [...params.tools] : [];
		appendCodexNativeTools(tools, model, {
			webSearch: this.useWebSearch && isNativeSearchChannelFirstEnabled(),
			imageGeneration: this.useImageGeneration,
		});
		request.tools = tools;

		applyCodexStableRequestFields(request, {
			identity: createCodexRequestIdentity(params.conversationId),
			reasoningEffort: resolveCodexRequestReasoningEffort(model, params.reasoningEffort),
		});
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
		toolName?: string,
	): unknown {
		void toolName;
		return this.dummyProvider.formatToolResult(toolUseId, output, isError, images);
	}

	pushUserTurn(
		history: unknown[],
		content: string,
		model: string,
		toolResults: unknown[],
		images?: Array<{ format: string; base64: string }>,
	): void {
		this.dummyProvider.pushUserTurn(history, content, model, toolResults, images);
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
		redactedThinkingBlocks?: Parameters<ProviderAdapter["pushAssistantTurn"]>[8],
		orderedContent?: readonly import("./types").ContentBlock[],
	): void {
		this.dummyProvider.pushAssistantTurn(
			history,
			text,
			toolUses,
			reasoningBlocks,
			webSearches,
			messageId,
			imageGenerations,
			textOutputIndex,
			redactedThinkingBlocks,
			orderedContent,
		);
	}

	async generate(text: string, model: string): Promise<string> {
		return this.runWithFailover("generate", (provider) => provider.generate(text, model));
	}

	async generateWithMeta(
		text: string,
		model: string,
		systemInstruction?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		return this.runWithFailover("generateWithMeta", (provider) =>
			provider.generateWithMeta(text, model, systemInstruction, options),
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
		return this.runWithFailover("generateWithHistoryWithMeta", (provider) =>
			provider.generateWithHistoryWithMeta(systemInstruction, content, model, locale, options),
		);
	}
}
