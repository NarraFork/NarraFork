import { normalizeApiRequestDiagnostics } from "@shared/agent-protocol/error-diagnostics";
import { parseModelId } from "@shared/model-id";
import {
	parseTokenDanceRecoveryAction,
	selectTokenDanceProtocol,
	TOKENDANCE_APP_URL,
	TOKENDANCE_ORIGIN,
} from "@shared/tokendance";
import { readWithTimeout } from "../stream-timeout";
import {
	assertTokenDanceConnection,
	getTokenDanceCatalogModels,
	getTokenDanceRuntimeConfig,
	registerTokenDanceRequest,
	setTokenDanceRecoveryAction,
} from "../tokendance-runtime";
import { AnthropicProvider } from "./anthropic-provider";
import { GeminiProvider } from "./gemini-provider";
import { OpenAIProvider } from "./openai-provider";
import type { ChatParams, GenerateMetaResult, GenerateOptions, ProviderAdapter } from "./provider";
import type { ProviderTransport } from "./provider-transport";
import { maskSecretValues } from "./request-dump";
import { ApiError } from "./types";

/** Redacts before delegates, request dumps, SSE parsing and logging see any upstream bytes. */
export function tokenDanceTransport(apiKey: string, generation: number): ProviderTransport {
	const patterns = [
		apiKey,
		JSON.stringify(apiKey).slice(1, -1),
		encodeURIComponent(apiKey),
		Buffer.from(apiKey).toString("base64"),
		Buffer.from(apiKey).toString("base64url"),
	];
	const hold = Math.max(...patterns.map((s) => s.length), 1);
	const mask = (text: string) => maskSecretValues(text, [apiKey]);
	return {
		redactText: mask,
		transportHeaders(headers) {
			headers.set("X-App-URL", TOKENDANCE_APP_URL);
		},
		async fetch(input, init, next) {
			assertTokenDanceConnection(generation);
			const controller = new AbortController();
			const unregister = registerTokenDanceRequest(controller, generation);
			const signal = init?.signal;
			const abort = () => controller.abort(signal?.reason);
			if (signal?.aborted) abort();
			else signal?.addEventListener("abort", abort, { once: true });
			let released = false;
			const release = () => {
				if (released) return;
				released = true;
				signal?.removeEventListener("abort", abort);
				unregister();
			};
			try {
				const response = await next(input, {
					...init,
					signal: controller.signal,
					redirect: "error",
				});
				const headers = new Headers(response.headers);
				for (const [name, value] of headers) headers.set(name, mask(value));
				if (!response.ok) {
					const action = parseTokenDanceRecoveryAction(
						response.headers.get("TokenDance-Recovery-Action"),
					);
					if (action) {
						setTokenDanceRecoveryAction(action, generation);
						void response.body?.cancel().catch(() => {});
						const message = `TokenDance requires user action: ${action}`;
						throw new ApiError(
							response.status,
							message,
							normalizeApiRequestDiagnostics({
								provider: "tokendance",
								phase: "http",
								statusCode: response.status,
								message,
								tokendanceRecoveryAction: action,
								retryable: false,
								resumable: false,
							}),
						);
					}
					let body = "";
					let truncated = false;
					if (response.body) {
						const reader = response.body.getReader();
						const decoder = new TextDecoder();
						let bytes = 0;
						const deadline = performance.now() + 30_000;
						try {
							while (bytes < 8192) {
								const remainingMs = deadline - performance.now();
								if (remainingMs <= 0)
									throw new Error("TokenDance error body read deadline exceeded");
								const chunk = await readWithTimeout(reader, Math.min(10_000, remainingMs));
								if (chunk.done) break;
								const remaining = 8192 - bytes;
								body += decoder.decode(chunk.value.slice(0, remaining), { stream: true });
								bytes += chunk.value.length;
								truncated = bytes >= 8192;
							}
						} catch (error) {
							body += ` [error body unavailable: ${mask(String(error))}]`;
						} finally {
							void reader
								.cancel()
								.finally(() => reader.releaseLock())
								.catch(() => {});
						}
					}
					body = mask(body);
					// Discard the bounded tail after masking complete keys, so a key split by the hard ceiling cannot escape.
					if (truncated) body = body.slice(0, Math.max(0, body.length - hold));
					const message = `TokenDance API error ${response.status}: ${body || response.statusText}`;
					throw new ApiError(
						response.status,
						mask(message),
						normalizeApiRequestDiagnostics({
							provider: "tokendance",
							phase: "http",
							statusCode: response.status,
							message: mask(message),
							responseSnippet: body,
							tokendanceRecoveryAction: action,
							...(action ? { retryable: false, resumable: false } : {}),
						}),
					);
				}
				if (!response.body) {
					release();
					return new Response(null, {
						status: response.status,
						statusText: mask(response.statusText),
						headers,
					});
				}
				const reader = response.body.getReader();
				const decoder = new TextDecoder();
				const encoder = new TextEncoder();
				let pending = "";
				const stream = new ReadableStream<Uint8Array>({
					async pull(sink) {
						try {
							while (true) {
								const chunk = await readWithTimeout(reader, 60_000);
								if (chunk.done) {
									pending += decoder.decode();
									if (pending) sink.enqueue(encoder.encode(mask(pending)));
									sink.close();
									reader.releaseLock();
									release();
									return;
								}
								pending += decoder.decode(chunk.value, { stream: true });
								let cut = Math.max(0, pending.length - hold);
								for (const pattern of patterns) {
									const start = pending.lastIndexOf(pattern, cut);
									if (start >= 0 && start < cut && start + pattern.length > cut) cut = start;
								}
								if (cut > 0 && /[\uD800-\uDBFF]/.test(pending[cut - 1])) cut--;
								if (!cut) continue;
								sink.enqueue(encoder.encode(mask(pending.slice(0, cut))));
								pending = pending.slice(cut);
								return;
							}
						} catch (error) {
							sink.error(new Error(mask(String(error))));
							release();
							void reader
								.cancel()
								.finally(() => reader.releaseLock())
								.catch(() => {});
						}
					},
					async cancel(reason) {
						controller.abort(reason);
						release();
						await reader
							.cancel(reason)
							.finally(() => reader.releaseLock())
							.catch(() => {});
					},
				});
				return new Response(stream, {
					status: response.status,
					statusText: mask(response.statusText),
					headers,
				});
			} catch (error) {
				release();
				if (error instanceof ApiError) throw error;
				throw new Error(mask(error instanceof Error ? error.message : String(error)));
			}
		},
	};
}

/** A singleton platform namespace; delegates never infer protocol from the model's name. */
export class TokenDanceProvider implements ProviderAdapter {
	private delegate?: ProviderAdapter;
	private model?: string;
	private protocol?: string;
	private readonly config = (() => {
		const config = getTokenDanceRuntimeConfig();
		return config ? { ...config } : undefined;
	})();

	prepareForModel(model: string): void {
		if (!this.config || this.config.disabled)
			throw new Error("TokenDance connection is not configured or is disabled.");
		assertTokenDanceConnection(this.config.generation);
		const parsed = parseModelId(model);
		if (parsed.provider && parsed.provider !== "tokendance")
			throw new Error("Invalid TokenDance model namespace.");
		const catalog = getTokenDanceCatalogModels().find((entry) => entry.id === parsed.model);
		const protocol = catalog && selectTokenDanceProtocol(catalog.supported_protocols);
		if (!catalog || !protocol)
			throw new Error(
				"TokenDance model is missing or has no supported protocol. Refresh the model catalog.",
			);
		if (this.delegate && this.model === parsed.model) {
			if (this.protocol !== protocol)
				throw new Error(
					"TokenDance model protocol changed. Rebuild the conversation before retrying.",
				);
			return;
		}
		const config = {
			id: "tokendance",
			name: "TokenDance",
			prefix: "tokendance",
			apiKey: this.config.apiKey,
			defaultModel: parsed.model,
			defaultContextWindow: catalog.context_length,
			baseUrl: `${TOKENDANCE_ORIGIN}/gateway/v1`,
		};
		const transport = tokenDanceTransport(this.config.apiKey, this.config.generation);
		const source = `tokendance:${protocol}`;
		if (protocol === "anthropic-messages") {
			const delegate = new AnthropicProvider({ ...config, officialApi: false }, transport);
			delegate.setReasoningSourceOverride(source);
			this.delegate = delegate;
		} else if (protocol === "gemini-compatible") {
			const delegate = new GeminiProvider(
				{ ...config, baseUrl: `${TOKENDANCE_ORIGIN}/gateway/v1beta` },
				transport,
			);
			delegate.setReasoningSourceOverride(source);
			this.delegate = delegate;
		} else {
			const delegate = new OpenAIProvider(
				{ ...config, apiMode: protocol === "openai-responses" ? "responses" : "completions" },
				undefined,
				transport,
			);
			delegate.setReasoningSourceOverride(source);
			delegate.noteActiveModel(model);
			this.delegate = delegate;
		}
		this.model = parsed.model;
		this.protocol = protocol;
	}
	private active(model?: string): ProviderAdapter {
		if (model) this.prepareForModel(model);
		if (!this.delegate)
			throw new Error("TokenDance protocol must be prepared before formatting history or tools.");
		return this.delegate;
	}
	getActiveReasoningSource() {
		return this.active().getActiveReasoningSource?.();
	}
	formatTools(...args: Parameters<ProviderAdapter["formatTools"]>) {
		return this.active().formatTools(...args);
	}
	buildHistory(...args: Parameters<ProviderAdapter["buildHistory"]>) {
		return this.active(args[1]).buildHistory(...args);
	}
	injectSystemPrompt(...args: Parameters<ProviderAdapter["injectSystemPrompt"]>) {
		this.active(args[2]).injectSystemPrompt(...args);
	}
	formatToolResult(...args: Parameters<ProviderAdapter["formatToolResult"]>) {
		return this.active().formatToolResult(...args);
	}
	pushUserTurn(...args: Parameters<ProviderAdapter["pushUserTurn"]>) {
		this.active(args[2]).pushUserTurn(...args);
	}
	pushAssistantTurn(...args: Parameters<ProviderAdapter["pushAssistantTurn"]>) {
		this.active().pushAssistantTurn(...args);
	}
	async *chat(params: ChatParams) {
		yield* this.active(params.model).chat(params);
	}
	async generate(text: string, model: string) {
		return (await this.generateWithMeta(text, model)).text;
	}
	generateWithMeta(
		text: string,
		model: string,
		system?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		return this.active(model).generateWithMeta(text, model, system, options);
	}
	async generateWithHistory(
		system: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	) {
		return (await this.generateWithHistoryWithMeta(system, content, model, locale, options)).text;
	}
	async generateWithHistoryWithMeta(
		system: string,
		content: string,
		model: string,
		locale?: string,
		options?: GenerateOptions,
	): Promise<GenerateMetaResult> {
		const delegate = this.active(model);
		return delegate.generateWithHistoryWithMeta
			? delegate.generateWithHistoryWithMeta(system, content, model, locale, options)
			: { text: await delegate.generateWithHistory(system, content, model, locale, options) };
	}
}
