/**
 * OpenAI SSE chunks → the plugin RPC stream-event vocabulary.
 *
 * The target vocabulary is `providerStreamEventSchema` (`server/lib/plugins/protocol.ts`).
 * Every event schema there is `.strict()`, so an invented field is rejected at the host
 * boundary rather than ignored — which is why the tests validate each emitted event against
 * the real schema instead of against a local copy of its shape.
 *
 * Behaviour follows the built-in adapter's `parseSSEStream` so the two paths can be compared
 * on the same account. The differences are called out where they occur.
 *
 * ## Tokens are real here
 *
 * leave token fields absent, the Cline gateway returns genuine OpenAI usage counts. They are
 * forwarded as measured. `contextWindow` is supplied by the caller from the model catalog so
 * the host can show absolute headroom next to the count.
 */

/** The subset of `providerStreamEventSchema` this module emits. */
export type PluginStreamEvent =
	| { type: "request_started"; upstreamRequestId?: string }
	| { type: "text.delta"; text: string }
	| { type: "tool_call.start"; toolUseId: string; name: string }
	| { type: "tool_call.delta"; toolUseId: string; argumentsDelta: string }
	| { type: "tool_call.end"; toolUseId: string }
	| { type: "usage"; usage: PluginUsage }
	| { type: "error"; error: PluginError }
	| {
			type: "done";
			status: "completed" | "cancelled" | "failed";
			stopReason: StopReason;
			responseId?: string;
			usage?: PluginUsage;
	  };

/** `done.stopReason` is a closed enum in the contract; these are the values it accepts. */
export type StopReason =
	| "end_turn"
	| "tool_use"
	| "max_output_tokens"
	| "content_filter"
	| "cancelled"
	| "error"
	| "unknown";

export interface PluginUsage {
	promptTokens?: number;
	completionTokens?: number;
	reasoningTokens?: number;
	cachedInputTokens?: number;
	contextWindow?: number;
	contextUsagePercentage?: number;
}

export interface PluginError {
	classification: "api" | "transport" | "invalid_state" | "protocol" | "cancelled";
	code: string;
	message: string;
	retryable?: boolean;
	statusCode?: number;
	phase?: "prepare" | "connect" | "request" | "stream" | "parse" | "cancel";
}

/** One streaming tool-call fragment. `index` is the only stable key across chunks. */
export interface ClineToolCallDelta {
	index: number;
	id?: string;
	type?: string;
	function?: { name?: string; arguments?: string };
}

/** One parsed `data:` line from the gateway. */
export interface ClineStreamChunk {
	id?: string;
	choices?: Array<{
		index?: number;
		delta?: {
			content?: string | null;
			tool_calls?: ClineToolCallDelta[];
		};
		finish_reason?: string | null;
	}>;
	usage?: {
		prompt_tokens?: number;
		completion_tokens?: number;
		total_tokens?: number;
		completion_tokens_details?: { reasoning_tokens?: number };
		prompt_tokens_details?: { cached_tokens?: number };
	};
	error?: { message?: string; type?: string; code?: string | number };
}

function positiveInt(value: unknown): number | undefined {
	// `> 0` rather than `>= 0`: a zero from the gateway means "not reported", and forwarding it
	// would have the host record a request that consumed no input, then compute context
	// headroom from a prompt it believes was empty.
	return typeof value === "number" && Number.isFinite(value) && value > 0
		? Math.trunc(value)
		: undefined;
}

/**
 * Accumulates usage across a stream so `done` can carry the final figures.
 *
 * The gateway may report usage in the last content chunk or in a trailing chunk with an empty
 * `choices` array, so it is folded in wherever it appears rather than expected in one place.
 */
export class UsageAccumulator {
	private usage: PluginUsage = {};
	private dirty = false;

	/** Fold one chunk's usage in. Returns true when something changed. */
	observe(chunk: ClineStreamChunk): boolean {
		const source = chunk.usage;
		if (!source) return false;
		let changed = false;
		const next: Array<[keyof PluginUsage, number | undefined]> = [
			["promptTokens", positiveInt(source.prompt_tokens)],
			["completionTokens", positiveInt(source.completion_tokens)],
			["reasoningTokens", positiveInt(source.completion_tokens_details?.reasoning_tokens)],
			["cachedInputTokens", positiveInt(source.prompt_tokens_details?.cached_tokens)],
		];
		for (const [key, value] of next) {
			if (value !== undefined && this.usage[key] !== value) {
				this.usage[key] = value;
				changed = true;
			}
		}
		if (changed) this.dirty = true;
		return changed;
	}

	/** Record the model's context window so the host can show absolute headroom. */
	setContextWindow(tokens: number | undefined): void {
		const value = positiveInt(tokens);
		if (value === undefined) return;
		this.usage.contextWindow = value;
		// Deliberately not marking dirty: a context window on its own is host-supplied
		// metadata, not a measurement. Emitting a usage event for it would report a turn that
		// consumed nothing. It still rides along once real usage arrives.
	}

	/** Snapshot, or undefined when the gateway never reported usage. */
	snapshot(): PluginUsage | undefined {
		if (!this.dirty) return undefined;
		return { ...this.usage };
	}
}

/** Tracks a streaming tool call while its arguments arrive in fragments. */
interface ToolAccumulator {
	id: string;
	name: string;
	args: string;
	ended: boolean;
}

/**
 * Translates a chunk sequence into events, holding the state a single chunk cannot carry.
 *
 * Stateful because OpenAI streams a tool call across chunks keyed only by an array index: the
 * id and name arrive once, the arguments in pieces, and the close is implied by
 * `finish_reason`. A stateless mapper would have no way to attribute a fragment to a call.
 */
export class StreamMapper {
	private readonly tools = new Map<number, ToolAccumulator>();
	private stopReason: StopReason = "end_turn";
	private responseId: string | undefined;
	private failure: PluginError | undefined;

	constructor(private readonly usage: UsageAccumulator) {}

	/** Events for one chunk, in the order a consumer should see them. */
	map(chunk: ClineStreamChunk): PluginStreamEvent[] {
		const events: PluginStreamEvent[] = [];

		if (chunk.id && !this.responseId) this.responseId = chunk.id;

		// An error inside the stream is terminal: the gateway will not produce a usable
		// completion after it, so it is recorded and the caller stops reading.
		if (chunk.error) {
			this.failure = {
				classification: "api",
				code: String(chunk.error.code ?? chunk.error.type ?? "UPSTREAM_ERROR"),
				message: chunk.error.message || "Cline API reported an error",
				retryable: false,
				phase: "stream",
			};
			this.stopReason = "error";
			events.push({ type: "error", error: this.failure });
			return events;
		}

		if (this.usage.observe(chunk)) {
			const snapshot = this.usage.snapshot();
			if (snapshot) events.push({ type: "usage", usage: snapshot });
		}

		const choice = chunk.choices?.[0];
		// A usage-only chunk carries no choices. Its usage was folded in above; there is
		// nothing else to do with it.
		if (!choice) return events;

		const content = choice.delta?.content;
		if (typeof content === "string" && content.length > 0) {
			events.push({ type: "text.delta", text: content });
		}

		for (const delta of choice.delta?.tool_calls ?? []) {
			events.push(...this.mapToolCallDelta(delta));
		}

		if (choice.finish_reason) {
			events.push(...this.closeOpenToolCalls());
			this.stopReason = mapFinishReason(choice.finish_reason, this.tools.size > 0);
		}

		return events;
	}

	private mapToolCallDelta(delta: ClineToolCallDelta): PluginStreamEvent[] {
		const events: PluginStreamEvent[] = [];
		const index = delta.index;
		let accumulator = this.tools.get(index);

		if (!accumulator) {
			// A fragment for an index we have not seen and with no id cannot be attributed to
			// anything. Dropping it is the only honest option: inventing an id would produce a
			// tool call the host would try to execute.
			if (!delta.id) return events;
			accumulator = { id: delta.id, name: delta.function?.name ?? "", args: "", ended: false };
			this.tools.set(index, accumulator);
			// `tool_call.start` requires a non-empty name. A gateway that sends the id before
			// the name would fail the contract here, so the start is deferred until the name is
			// known (below).
			if (accumulator.name) {
				events.push({ type: "tool_call.start", toolUseId: accumulator.id, name: accumulator.name });
			}
		} else if (!accumulator.name && delta.function?.name) {
			accumulator.name = delta.function.name;
			events.push({ type: "tool_call.start", toolUseId: accumulator.id, name: accumulator.name });
		}

		if (accumulator.ended) return events;

		const fragment = delta.function?.arguments;
		if (typeof fragment === "string" && fragment.length > 0) {
			accumulator.args += fragment;
			events.push({
				type: "tool_call.delta",
				toolUseId: accumulator.id,
				argumentsDelta: fragment,
			});
			// Close as soon as the accumulated text parses. The host executes a tool the moment
			// its arguments are complete, so ending early lets work start while the model is
			// still producing later output. Matches the built-in adapter's `isParsableJson`
			// check.
			//
			// Only meaningful once a name is known: the host cannot execute a nameless call.
			if (accumulator.name && isParsableJson(accumulator.args)) {
				accumulator.ended = true;
				events.push({ type: "tool_call.end", toolUseId: accumulator.id });
			}
		}

		return events;
	}

	/** Close anything still open, which `finish_reason` implies. */
	private closeOpenToolCalls(): PluginStreamEvent[] {
		const events: PluginStreamEvent[] = [];
		for (const accumulator of this.tools.values()) {
			if (accumulator.ended) continue;
			accumulator.ended = true;
			// A call whose name never arrived is skipped rather than closed: `tool_call.start`
			// was never emitted for it, so an `end` would reference an id the host never opened.
			if (!accumulator.name) continue;
			events.push({ type: "tool_call.end", toolUseId: accumulator.id });
		}
		return events;
	}

	/** Whether the stream reported an error, so the caller can stop reading. */
	failed(): boolean {
		return this.failure !== undefined;
	}

	/** The terminal event the operation owes the host. */
	finalEvent(): PluginStreamEvent {
		const usage = this.usage.snapshot();
		if (this.failure) {
			return {
				type: "done",
				status: "failed",
				stopReason: "error",
				...(this.responseId ? { responseId: this.responseId } : {}),
				...(usage ? { usage } : {}),
			};
		}
		return {
			type: "done",
			status: "completed",
			stopReason: this.stopReason,
			...(this.responseId ? { responseId: this.responseId } : {}),
			...(usage ? { usage } : {}),
		};
	}

	/** Arguments accumulated per tool call. Used by the non-streaming generate path. */
	toolArguments(): Array<{ id: string; name: string; args: string }> {
		return [...this.tools.values()]
			.filter((entry) => entry.name)
			.map((entry) => ({ id: entry.id, name: entry.name, args: entry.args }));
	}
}

/**
 * OpenAI `finish_reason` → contract `stopReason`.
 *
 * `tool_calls` and `stop`-with-open-tool-calls both mean the turn continues with tool
 * execution. The second case is not hypothetical: gateways have been observed reporting
 * `stop` on a turn that did emit tool calls, and reporting `end_turn` there would have the
 * host finish the narration with tools left unexecuted.
 */
export function mapFinishReason(reason: string, hasToolCalls: boolean): StopReason {
	switch (reason) {
		case "tool_calls":
		case "function_call":
			return "tool_use";
		case "length":
			return "max_output_tokens";
		case "content_filter":
			return "content_filter";
		case "stop":
			return hasToolCalls ? "tool_use" : "end_turn";
		default:
			return hasToolCalls ? "tool_use" : "unknown";
	}
}

function isParsableJson(value: string): boolean {
	try {
		JSON.parse(value);
		return true;
	} catch {
		return false;
	}
}

/**
 * Ceiling on the unconsumed tail of an SSE body, in UTF-16 code units.
 *
 * This is the only part of the response held in memory: `splitSseLines` hands back everything
 * after the last newline so a JSON object split across reads can be rejoined. An upstream that
 * never sends a newline therefore grows that tail without bound, so it needs a stop. 8M code
 * units is ~16MB of string data, far above any single `data:` line a chat completion produces
 * (the largest realistic one is a tool call's arguments) and far below a memory problem.
 */
export const MAX_SSE_PENDING_CHARS = 8 * 1024 * 1024;

/**
 * Ceiling on the total decoded bytes of one SSE body.
 *
 * Unlike the pending tail this is not a memory bound — consumed lines are released as they are
 * parsed — it bounds *time*: a stream that never ends would otherwise keep one operation, and
 * its host-side turn, alive forever. 128MB is well past the SSE-framed size of a
 * maximum-length completion, so hitting it means upstream is malfunctioning.
 */
export const MAX_SSE_TOTAL_BYTES = 128 * 1024 * 1024;

/**
 * An SSE body exceeded one of the limits above.
 *
 * Reported through `classifyClineError` as non-retryable: a runaway stream is an upstream
 * fault, and replaying it would spend the same bounded budget again to fail the same way.
 */
export class StreamTooLargeError extends Error {
	override readonly name = "StreamTooLargeError";
}

/**
 * Split an SSE buffer into complete `data:` payloads.
 *
 * Returns the unconsumed tail so the caller can carry a partial line into the next chunk. A
 * JSON object can be split mid-escape across network reads, so anything but line-accurate
 * buffering silently corrupts tool arguments.
 */
export function splitSseLines(buffer: string): { payloads: string[]; rest: string } {
	const lines = buffer.split("\n");
	const rest = lines.pop() ?? "";
	const payloads: string[] = [];
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed === "data: [DONE]") continue;
		if (!trimmed.startsWith("data: ")) continue;
		payloads.push(trimmed.slice(6));
	}
	return { payloads, rest };
}

/** Parse one payload, or undefined when it is not JSON (which is skipped, as upstream may send keep-alives). */
export function parseChunk(payload: string): ClineStreamChunk | undefined {
	try {
		return JSON.parse(payload) as ClineStreamChunk;
	} catch {
		return undefined;
	}
}

/**
 * Read an SSE body, handing each mapped event to `onEvent`. Stops early on a stream error.
 *
 * Bounded on two axes, because neither the pending tail nor the stream length is under this
 * process's control:
 *
 * - The pending tail is the MEMORY bound. `splitSseLines` returns everything after the last
 *   newline so a JSON object split across reads can be rejoined, so an upstream that never
 *   sends a newline would grow one string without limit.
 * - The decoded total is the LIVENESS bound. Consumed lines are released as they are parsed,
 *   so this is not about memory: a stream that never ends would pin this operation, and the
 *   host-side turn waiting on it, indefinitely.
 *
 * Both raise `StreamTooLargeError`, which `classifyClineError` reports as a non-retryable
 * transport failure, so the caller's existing `catch` turns it into a terminal `error` event
 * instead of leaving the host waiting.
 *
 * The body is cancelled on the way out, because every exit path except a clean `done`
 * abandons the stream and an un-cancelled body holds the connection open.
 *
 * `limits` exists so tests can trip each bound without producing a 128MB stream. Production
 * callers omit it and get the constants above.
 */
export async function consumeStream(
	body: ReadableStream<Uint8Array>,
	mapper: StreamMapper,
	onEvent: (event: PluginStreamEvent) => void,
	signal: AbortSignal,
	limits?: { maxPendingChars?: number; maxTotalBytes?: number },
): Promise<void> {
	const maxPendingChars = limits?.maxPendingChars ?? MAX_SSE_PENDING_CHARS;
	const maxTotalBytes = limits?.maxTotalBytes ?? MAX_SSE_TOTAL_BYTES;
	const decoder = new TextDecoder();
	const reader = body.getReader();
	let buffer = "";
	let totalBytes = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (signal.aborted) return;
			totalBytes += value.byteLength;
			if (totalBytes > maxTotalBytes) {
				throw new StreamTooLargeError(
					`upstream response exceeded ${maxTotalBytes} bytes without completing`,
				);
			}
			buffer += decoder.decode(value, { stream: true });
			const { payloads, rest } = splitSseLines(buffer);
			buffer = rest;
			if (buffer.length > maxPendingChars) {
				throw new StreamTooLargeError(
					`upstream sent a single SSE line longer than ${maxPendingChars} characters`,
				);
			}
			for (const payload of payloads) {
				const chunk = parseChunk(payload);
				if (!chunk) continue;
				for (const event of mapper.map(chunk)) onEvent(event);
				if (mapper.failed()) return;
			}
		}
	} finally {
		reader.releaseLock();
		void body.cancel().catch(() => undefined);
	}
}

/**
 * Classify a failure for the host's `error` event.
 *
 * `retryable` is the field that matters: the host retries on true, and a retry against a
 * revoked credential or an exhausted balance only burns time. The mapping mirrors how the
 * built-in path classifies the same statuses.
 */
export function classifyClineError(error: unknown): PluginError {
	const name = error instanceof Error ? error.name : "";
	const message = error instanceof Error ? error.message : String(error);

	if (name === "AbortError") {
		return { classification: "cancelled", code: "CANCELLED", message: "Request was cancelled" };
	}
	if (name === "StreamTooLargeError") {
		return {
			classification: "transport",
			code: "RESPONSE_TOO_LARGE",
			message,
			retryable: false,
		};
	}
	// Retryable, unlike the abort above: nothing was cancelled, upstream simply stalled, and
	// the next attempt may reach a healthy instance.
	if (name === "RequestTimeoutError") {
		return {
			classification: "transport",
			code: "REQUEST_TIMEOUT",
			message,
			retryable: true,
		};
	}
	if (name === "MissingCredentialError") {
		return {
			classification: "invalid_state",
			code: "NOT_CONFIGURED",
			message,
			retryable: false,
		};
	}
	if (name === "InvalidCredentialsError") {
		return {
			classification: "invalid_state",
			code: "INVALID_CONFIG",
			message,
			retryable: false,
		};
	}

	const statusCode =
		error && typeof error === "object" && "statusCode" in error
			? (error as { statusCode?: unknown }).statusCode
			: undefined;
	const status = typeof statusCode === "number" ? statusCode : undefined;

	if (status !== undefined) return classifyStatus(status, message);
	return { classification: "transport", code: "REQUEST_FAILED", message, retryable: true };
}

function classifyStatus(status: number, message: string): PluginError {
	// 400 covers both a malformed request and an over-long prompt. They are separated because
	// the host handles context overflow by compacting and retrying, while a malformed request
	// is terminal — conflating them would either lose a recoverable turn or loop on a bad one.
	if (status === 400) {
		return looksLikeContextOverflow(message)
			? {
					classification: "api",
					code: "CONTEXT_LENGTH_EXCEEDED",
					message,
					retryable: false,
					statusCode: status,
				}
			: {
					classification: "api",
					code: "BAD_REQUEST",
					message,
					retryable: false,
					statusCode: status,
				};
	}
	if (status === 401 || status === 403) {
		return {
			classification: "api",
			code: "AUTH_FAILED",
			message,
			retryable: false,
			statusCode: status,
		};
	}
	if (status === 402) {
		// Cline bills per request; 402 is an exhausted balance, which no retry can fix.
		return {
			classification: "api",
			code: "QUOTA_EXHAUSTED",
			message,
			retryable: false,
			statusCode: status,
		};
	}
	if (status === 429) {
		return {
			classification: "api",
			code: "THROTTLED",
			message,
			retryable: true,
			statusCode: status,
		};
	}
	if (status === 408 || status >= 500) {
		return {
			classification: "api",
			code: "UPSTREAM_ERROR",
			message,
			retryable: true,
			statusCode: status,
		};
	}
	return {
		classification: "api",
		code: "UPSTREAM_ERROR",
		message,
		retryable: false,
		statusCode: status,
	};
}

/** Whether a 400 body reads like a context-length rejection. */
function looksLikeContextOverflow(message: string): boolean {
	const lower = message.toLowerCase();
	return (
		lower.includes("context length") ||
		lower.includes("context_length") ||
		lower.includes("context window") ||
		lower.includes("maximum context") ||
		lower.includes("too many tokens") ||
		lower.includes("prompt is too long")
	);
}
