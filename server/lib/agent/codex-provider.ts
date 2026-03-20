// Codex Provider — uses the centralized CodexManager for multi-account OAuth
// Wraps OpenAIProvider with dynamic credential selection

import { type CallContext, getCodexManager } from "../codex-manager";
import { logger } from "../logger";
import { settings } from "../settings";
import { OpenAIProvider } from "./openai-provider";
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

/**
 * Codex provider that uses the centralized credential pool.
 * Wraps OpenAIProvider with dynamic credential selection from CodexManager.
 */
export class CodexProvider implements ProviderAdapter {
	private manager = getCodexManager();
	private context: CallContext | null = null;
	private contextSessionKey: string | undefined;

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
					yield event;
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

	formatToolResult(
		toolUseId: string,
		output: string,
		isError: boolean,
		images?: Array<{ format: string; base64: string }>,
	): unknown {
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		return dummy.formatToolResult(toolUseId, output, isError, images);
	}

	pushUserTurn(history: unknown[], content: string, model: string, toolResults: unknown[]): void {
		// Use a dummy provider for this synchronous operation
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		dummy.pushUserTurn(history, content, model, toolResults);
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
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		dummy.pushAssistantTurn(history, text, toolUses, reasoningBlocks);
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
