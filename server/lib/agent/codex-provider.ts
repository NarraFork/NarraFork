// Codex Provider — uses the centralized CodexManager for multi-account OAuth
// Wraps OpenAIProvider with dynamic credential selection

import { type CallContext, getCodexManager } from "../codex-manager";
import { logger } from "../logger";
import { loadSettings } from "../settings";
import { OpenAIProvider } from "./openai-provider";
import type { ChatParams, DbMessage, ParsedStreamEvent, ProviderAdapter } from "./provider";
import type { AgentToolUse, ResolvedToolDefinition } from "./types";

const CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";

/**
 * Codex provider that uses the centralized credential pool.
 * Wraps OpenAIProvider with dynamic credential selection from CodexManager.
 */
export class CodexProvider implements ProviderAdapter {
	private manager = getCodexManager();
	private context: CallContext | null = null;

	/** Get or acquire a valid credential context. */
	private async getContext(): Promise<CallContext> {
		if (this.context?.token) {
			// Check if token is still valid (with 60s buffer)
			const cred = this.context.credential;
			if (cred.expiresAt && cred.expiresAt > Date.now() + 60_000) {
				return this.context;
			}
		}
		this.context = await this.manager.acquireContext();
		return this.context;
	}

	/** Create a temporary OpenAIProvider with the current credential. */
	private createProvider(ctx: CallContext): OpenAIProvider {
		const settings = loadSettings();
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
		const ctx = await this.getContext();
		const provider = this.createProvider(ctx);

		try {
			yield* provider.chat(params);
			this.manager.reportSuccess(ctx.id);
		} catch (err) {
			const hasMore = this.manager.reportFailure(ctx.id);
			if (!hasMore) {
				logger.error("All Codex credentials exhausted");
			}
			throw err;
		}
	}

	formatToolResult(toolUseId: string, output: string, isError: boolean): unknown {
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		return dummy.formatToolResult(toolUseId, output, isError);
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

	pushAssistantTurn(history: unknown[], text: string, toolUses: AgentToolUse[]): void {
		const dummy = new OpenAIProvider({
			id: "codex",
			name: "Codex",
			prefix: "codex",
			apiKey: "",
			baseUrl: CODEX_BASE_URL,
			defaultModel: "gpt-5.3-codex",
			apiMode: "codex",
		});
		dummy.pushAssistantTurn(history, text, toolUses);
	}

	async generate(text: string, model: string): Promise<string> {
		const ctx = await this.getContext();
		const provider = this.createProvider(ctx);

		try {
			const result = await provider.generate(text, model);
			this.manager.reportSuccess(ctx.id);
			return result;
		} catch (err) {
			this.manager.reportFailure(ctx.id);
			throw err;
		}
	}

	async generateWithMeta(
		text: string,
		model: string,
	): Promise<{ text: string; contextPercent?: number }> {
		const ctx = await this.getContext();
		const provider = this.createProvider(ctx);

		try {
			const result = await provider.generateWithMeta(text, model);
			this.manager.reportSuccess(ctx.id);
			return result;
		} catch (err) {
			this.manager.reportFailure(ctx.id);
			throw err;
		}
	}

	async generateWithHistory(
		systemInstruction: string,
		content: string,
		model: string,
		locale?: string,
	): Promise<string> {
		const ctx = await this.getContext();
		const provider = this.createProvider(ctx);

		try {
			const result = await provider.generateWithHistory(systemInstruction, content, model, locale);
			this.manager.reportSuccess(ctx.id);
			return result;
		} catch (err) {
			this.manager.reportFailure(ctx.id);
			throw err;
		}
	}
}
