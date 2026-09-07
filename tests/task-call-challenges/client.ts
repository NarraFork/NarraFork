// Small protocol-only client for this experiment. It deliberately does not import
// application provider adapters: their transitive imports acquire the live DB lock.
import { resolveProxyForUrl } from "../../server/lib/net/proxy";
import { redactExperimentError } from "./error-redaction";

export class BenchProvider {
	private nativeAssistant: any[] = [];
	constructor(
		private readonly config: {
			baseUrl: string;
			apiKey: string;
			model: string;
			protocol: "codex" | "anthropic";
			proxy?: any;
			modelHash: string;
		},
	) {}

	injectSystemPrompt(history: unknown[], text: string, ..._rest: unknown[]) {
		history.push({ role: "__system", content: text });
	}
	formatTools(definitions: any[]) {
		return definitions.map((tool) =>
			this.config.protocol === "anthropic"
				? { name: tool.name, description: tool.description, input_schema: tool.rawJsonSchema }
				: {
						type: "function",
						name: tool.name,
						description: tool.description,
						parameters: tool.rawJsonSchema,
						strict: true,
					},
		);
	}
	formatToolResult(id: string, output: string, isError: boolean, ..._rest: unknown[]) {
		return this.config.protocol === "anthropic"
			? { type: "tool_result", tool_use_id: id, content: output, is_error: isError }
			: { type: "function_call_output", call_id: id, output };
	}
	pushUserTurn(history: unknown[], content: string, _model: string, results: unknown[]) {
		if (this.config.protocol === "anthropic") {
			if (results.length)
				history.push({
					role: "user",
					content: [...results, ...(content ? [{ type: "text", text: content }] : [])],
				});
			else if (content) history.push({ role: "user", content });
		} else {
			history.push(...results);
			if (content) history.push({ role: "user", content: [{ type: "input_text", text: content }] });
		}
	}
	pushAssistantTurn(history: unknown[], ..._rest: unknown[]) {
		if (this.config.protocol === "anthropic")
			history.push({ role: "assistant", content: structuredClone(this.nativeAssistant) });
		else history.push(...structuredClone(this.nativeAssistant));
	}

	async *chat(params: any): AsyncGenerator<any> {
		try {
			yield* this.chatUnchecked(params);
		} catch (error) {
			// Also cover fetch/reader failures and parser errors. This client owns its
			// credential and must never rely on run.ts registering it beforehand.
			const message = redactExperimentError(error instanceof Error ? error.message : error, [
				this.config.apiKey,
			]);
			if (error instanceof Error && error.name === "AbortError")
				throw new DOMException(message, "AbortError");
			throw new Error(message);
		}
	}

	private async *chatUnchecked(
		params: Parameters<BenchProvider["chat"]>[0],
	): ReturnType<BenchProvider["chat"]> {
		params.signal?.throwIfAborted();
		const system = params.history.find((m: any) => m.role === "__system")?.content ?? "";
		const history = params.history
			.filter((m: any) => m.role !== "__system")
			.map((m: any) => structuredClone(m));
		this.pushUserTurn(history, params.content, params.model, params.toolResults);
		const anthropic = this.config.protocol === "anthropic";
		const body: any = anthropic
			? {
					model: this.config.model,
					system,
					messages: history,
					tools: params.tools,
					stream: true,
					max_tokens: 4096,
					thinking: { type: "enabled", budget_tokens: 1024 },
					output_config: { effort: "low" },
				}
			: {
					model: this.config.model,
					instructions: system,
					input: history,
					tools: params.tools,
					stream: true,
					store: false,
					tool_choice: "auto",
					parallel_tool_calls: true,
					reasoning: { effort: "low", summary: "auto" },
					include: ["reasoning.encrypted_content"],
					text: { verbosity: "low" },
					prompt_cache_key: params.conversationId,
				};
		params.requestDump?.setRequest({ body }); // Observer stores selected metadata only.
		const url = `${this.config.baseUrl}${anthropic ? "/v1/anthropic/messages" : "/v1/responses"}`;
		const proxy = resolveProxyForUrl(url, this.config.proxy);
		const response = await fetch(url, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				Accept: "text/event-stream",
				Authorization: `Bearer ${this.config.apiKey}`,
				"X-NUG-Model-Hash": this.config.modelHash,
				...(anthropic
					? { "x-api-key": this.config.apiKey, "anthropic-version": "2023-06-01" }
					: { originator: "codex_cli_rs", session_id: params.conversationId }),
			},
			body: JSON.stringify(body),
			signal: params.signal,
			...(proxy ? { proxy } : {}),
		} as RequestInit);
		if (!response.ok) {
			const text = await readBounded(response, 12_000, this.config.apiKey, params.signal);
			throw new Error(`HTTP ${response.status}: ${text}`);
		}
		const blocks = new Map<number, any>();
		const inputs = new Map<number, string>();
		const outputItems = new Map<number, any>();
		let completed: any;
		let sawTerminal = false;
		let stopReason: string | undefined;
		let usage: any = {};
		for await (const data of events(response, params.signal)) {
			if (data.type === "error")
				throw new Error(
					`UPSTREAM_ERROR: ${redactExperimentError(JSON.stringify(data.error ?? data), [this.config.apiKey], 1500)}`,
				);
			if (anthropic) {
				if (data.type === "message_start") usage = { ...usage, ...(data.message?.usage ?? {}) };
				if (data.type === "content_block_start")
					blocks.set(data.index, structuredClone(data.content_block));
				if (data.type === "content_block_delta") {
					const block = blocks.get(data.index);
					if (!block) throw new Error("SSE block delta without start");
					const delta = data.delta;
					if (delta.type === "text_delta") {
						block.text = (block.text ?? "") + delta.text;
						yield { text: delta.text };
					}
					if (delta.type === "thinking_delta") {
						block.thinking = (block.thinking ?? "") + delta.thinking;
						yield { reasoning: delta.thinking };
					}
					if (delta.type === "signature_delta")
						block.signature = (block.signature ?? "") + delta.signature;
					if (delta.type === "input_json_delta")
						inputs.set(data.index, (inputs.get(data.index) ?? "") + delta.partial_json);
				}
				if (data.type === "message_delta") {
					stopReason = data.delta?.stop_reason;
					usage = { ...usage, ...(data.usage ?? {}) };
				}
				if (data.type === "message_stop") sawTerminal = true;
			} else {
				if (data.type === "response.output_text.delta") yield { text: data.delta };
				if (data.type === "response.reasoning_summary_text.delta") yield { reasoning: data.delta };
				if (data.type === "response.output_item.done")
					outputItems.set(data.output_index, data.item);
				if (data.type === "response.completed" || data.type === "response.incomplete") {
					completed = data.response;
					sawTerminal = true;
					usage = completed?.usage ?? {};
					stopReason = data.type === "response.incomplete" ? "max_tokens" : "end_turn";
				}
				if (data.type === "response.failed")
					throw new Error(
						`RESPONSE_FAILED: ${redactExperimentError(JSON.stringify(data.response?.error ?? data), [this.config.apiKey], 1500)}`,
					);
			}
		}
		if (!sawTerminal) throw new Error("SSE ended without a terminal response");
		let toolUses: any[];
		if (anthropic) {
			this.nativeAssistant = [...blocks.entries()]
				.sort(([a], [b]) => a - b)
				.map(([index, block]) => {
					if (block.type === "tool_use" && inputs.has(index))
						block.input = JSON.parse(inputs.get(index)!);
					return block;
				});
			toolUses = this.nativeAssistant
				.filter((b) => b.type === "tool_use")
				.map((b) => ({ toolUseId: b.id, name: b.name, input: b.input }));
		} else {
			this.nativeAssistant = completed?.output?.length
				? completed.output
				: [...outputItems.entries()].sort(([a], [b]) => a - b).map(([, item]) => item);
			toolUses = this.nativeAssistant
				.filter((b) => b.type === "function_call")
				.map((b) => ({ toolUseId: b.call_id, name: b.name, input: JSON.parse(b.arguments) }));
		}
		yield {
			toolUses,
			stopReason: toolUses.length ? "tool_use" : stopReason,
			// Preserve truncation even when a valid tool call masks the normalized reason.
			upstreamStopReason: stopReason,
			usage: {
				promptTokens: usage.input_tokens,
				completionTokens: usage.output_tokens,
				cachedInputTokens:
					usage.cache_read_input_tokens ?? usage.input_tokens_details?.cached_tokens,
				reasoningTokens: usage.output_tokens_details?.reasoning_tokens,
			},
		};
	}
}

function cancelReader(reader: ReadableStreamDefaultReader<Uint8Array>) {
	// Cancellation is best effort: an upstream's cancel hook must not be allowed
	// to hold an already bounded diagnostic (or an aborted request) open forever.
	void reader.cancel().catch(() => undefined);
}

async function readChunk(
	reader: ReadableStreamDefaultReader<Uint8Array>,
	signal?: AbortSignal,
): ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> {
	signal?.throwIfAborted();
	if (!signal) return reader.read();
	return new Promise((resolve, reject) => {
		const abort = () => {
			cancelReader(reader);
			reject(signal.reason);
		};
		signal.addEventListener("abort", abort, { once: true });
		reader.read().then(
			(result) => {
				signal.removeEventListener("abort", abort);
				if (signal.aborted) reject(signal.reason);
				else resolve(result);
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				reject(error);
			},
		);
	});
}

async function readBounded(
	response: Response,
	cap: number,
	secret: string,
	signal?: AbortSignal,
): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await readChunk(reader, signal);
			if (done) return redactExperimentError(text + decoder.decode(), [secret], cap);
			const accepted = value.subarray(0, cap - bytes);
			bytes += accepted.byteLength;
			// Never decode an oversized chunk in full or read beyond the raw byte
			// budget. Redaction withholds a possible partial key at this boundary.
			text += decoder.decode(accepted, { stream: true });
			if (bytes >= cap) return `${redactExperimentError(text, [secret], cap)} [truncated]`;
		}
	} finally {
		cancelReader(reader);
		reader.releaseLock();
	}
}

async function* events(response: Response, signal?: AbortSignal): AsyncGenerator<any> {
	if (!response.body) throw new Error("Missing SSE body");
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let bytes = 0;
	try {
		for (;;) {
			const { value, done } = await readChunk(reader, signal);
			if (done) break;
			bytes += value.byteLength;
			if (bytes > 2_000_000) throw new Error("SSE byte budget exceeded");
			buffer += decoder.decode(value, { stream: true });
			for (;;) {
				const boundary = /\r?\n\r?\n/.exec(buffer);
				if (!boundary) break;
				if (boundary.index > 1_000_000) throw new Error("SSE frame budget exceeded");
				const frame = buffer.slice(0, boundary.index);
				buffer = buffer.slice(boundary.index + boundary[0].length);
				const data = frame
					.split(/\r?\n/)
					.filter((line) => line.startsWith("data:"))
					.map((line) => line.slice(5).trimStart())
					.join("\n");
				if (data && data !== "[DONE]") {
					let parsed: unknown;
					try {
						parsed = JSON.parse(data);
					} catch {
						// Engine SyntaxErrors can contain their own pre-truncated raw
						// excerpts. Do not echo them into credential-bearing diagnostics.
						throw new Error("Invalid SSE JSON");
					}
					yield parsed;
				}
			}
			if (buffer.length > 1_000_000) throw new Error("SSE frame budget exceeded");
		}
	} finally {
		cancelReader(reader);
		reader.releaseLock();
	}
}
