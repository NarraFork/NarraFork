/**
 * Canonical host history → OpenAI chat/completions messages.
 *
 * This is the load-bearing translation in the plugin, and the reason none of the built-in
 * adapter's history code could be reused.
 *
 * ## The two formats
 *
 * The built-in `ClineProvider.buildHistory` consumes **database rows** (`DbMessage` with
 * `contentJson`, `toolCalls`, `sideCars`). A plugin never sees those. The host normalises
 * everything first (`server/lib/agent/remote-provider-adapter.ts`) and sends:
 *
 * ```
 * ProviderMessage { role: "system"|"user"|"assistant"|"tool", content: ProviderContentBlock[] }
 * ```
 *
 * with block types `text`, `reasoning`, `redacted_reasoning`, `image{mediaType,dataBase64}`,
 * `tool_call{toolUseId,name,input}`, `tool_result{toolUseId,name,content[],isError}`,
 * plus `web_search` and `image_generation` for providers that emit them.
 *
 * So this module translates *that* into OpenAI's wire format. The output shape matches what
 * the built-in adapter sends upstream, which is what keeps behaviour comparable between the
 * two paths.
 *
 * ## Reasoning blocks are dropped
 *
 * OpenAI chat/completions has no slot for a thinking block in the message history, and the
 * OpenRouter gateway does not require one to be echoed back. The built-in adapter drops them
 * too: `ClineMessage` declares a `_reasoningBlocks` field and `pushAssistantTurn` takes a
 * `_reasoningBlocks` parameter, both underscore-prefixed and never read. This is therefore
 * parity, not a new loss of information — and it is why the manifest declares
 * `reasoningContinuation: false` rather than promising a continuation it cannot perform.
 */

/** One message in the OpenAI request. */
export interface OpenAiMessage {
	role: "system" | "user" | "assistant" | "tool";
	content?: string | OpenAiContentPart[] | null;
	tool_calls?: OpenAiToolCall[];
	tool_call_id?: string;
}

export type OpenAiContentPart =
	| { type: "text"; text: string }
	| { type: "image_url"; image_url: { url: string } };

export interface OpenAiToolCall {
	id: string;
	type: "function";
	function: { name: string; arguments: string };
}

export interface OpenAiTool {
	type: "function";
	function: { name: string; description: string; parameters: Record<string, unknown> };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function textOf(value: unknown): string | undefined {
	return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A `data:` URL for an inline image, the only image form OpenAI accepts on the wire. */
function dataUrl(mediaType: string, dataBase64: string): string {
	// The host normalises to a full media type ("image/png"); a bare format ("png") can still
	// arrive from a hand-built payload, so it is completed rather than passed through as an
	// invalid data URL.
	const type = mediaType.includes("/") ? mediaType : `image/${mediaType}`;
	return `data:${type};base64,${dataBase64}`;
}

/**
 * Flatten a `tool_result`'s content blocks into the single string OpenAI allows.
 *
 * A `role: "tool"` message takes text only — there is no parts array and no image support.
 * An image in a tool result therefore becomes a marker rather than being dropped silently:
 * the model needs to know something was returned that it cannot see, otherwise a screenshot
 * tool appears to have produced nothing at all.
 */
export function flattenToolResultContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const block of content) {
		if (!isRecord(block)) continue;
		if (block.type === "text") {
			const text = textOf(block.text);
			if (text) parts.push(text);
			continue;
		}
		if (block.type === "image") {
			parts.push("[image omitted: tool results cannot carry images on this provider]");
		}
	}
	return parts.join("\n");
}

/** One `role: "tool"` message per tool result, which is what OpenAI expects. */
function toolResultMessages(blocks: readonly unknown[]): OpenAiMessage[] {
	const messages: OpenAiMessage[] = [];
	for (const block of blocks) {
		if (!isRecord(block)) continue;
		const toolUseId = textOf(block.toolUseId) ?? textOf(block.tool_call_id);
		if (!toolUseId) continue;
		const content = flattenToolResultContent(block.content);
		messages.push({
			role: "tool",
			tool_call_id: toolUseId,
			// An empty string, not omitted: a tool that legitimately returned nothing still
			// needs a result message, or upstream rejects the turn for an unanswered tool call.
			content,
		});
	}
	return messages;
}

/** Split one canonical message's content into the pieces OpenAI models separately. */
function partitionContent(content: readonly unknown[]): {
	text: string;
	images: OpenAiContentPart[];
	toolCalls: OpenAiToolCall[];
	toolResults: unknown[];
} {
	const textParts: string[] = [];
	const images: OpenAiContentPart[] = [];
	const toolCalls: OpenAiToolCall[] = [];
	const toolResults: unknown[] = [];

	for (const block of content) {
		if (!isRecord(block)) continue;
		switch (block.type) {
			case "text": {
				const text = textOf(block.text);
				if (text) textParts.push(text);
				break;
			}
			case "image": {
				const mediaType = textOf(block.mediaType);
				const dataBase64 = textOf(block.dataBase64);
				if (mediaType && dataBase64) {
					images.push({ type: "image_url", image_url: { url: dataUrl(mediaType, dataBase64) } });
				}
				break;
			}
			case "tool_call": {
				const toolUseId = textOf(block.toolUseId);
				const name = textOf(block.name);
				if (!toolUseId || !name) break;
				toolCalls.push({
					id: toolUseId,
					type: "function",
					function: {
						name,
						// Always a JSON object string: upstream parses this, and `undefined` or a
						// bare value would be rejected.
						arguments: JSON.stringify(isRecord(block.input) ? block.input : {}),
					},
				});
				break;
			}
			case "tool_result":
				toolResults.push(block);
				break;
			// `reasoning` and `redacted_reasoning` are dropped: see the module header.
			// `web_search` / `image_generation` are host-side annotations of what another
			// provider did; they carry no content this provider can send and are dropped too.
			default:
				break;
		}
	}

	return { text: textParts.join("\n"), images, toolCalls, toolResults };
}

/** The user-role message for a text/image pair, or undefined when there is nothing to send. */
function userMessage(text: string, images: OpenAiContentPart[]): OpenAiMessage | undefined {
	if (images.length === 0) {
		return text ? { role: "user", content: text } : undefined;
	}
	// Images require the parts form, and a parts array with no text is accepted but gives the
	// model no instruction, so a placeholder stands in — matching the built-in adapter's
	// "[user sent image(s)]".
	const parts: OpenAiContentPart[] = [
		{ type: "text", text: text || "[user sent image(s)]" },
		...images,
	];
	return { role: "user", content: parts };
}

/** Translate the canonical history into OpenAI messages. */
export function convertHistory(history: readonly unknown[]): OpenAiMessage[] {
	const messages: OpenAiMessage[] = [];

	for (const entry of history) {
		if (!isRecord(entry)) continue;
		const role = entry.role;
		const content = Array.isArray(entry.content) ? entry.content : [];
		const { text, images, toolCalls, toolResults } = partitionContent(content);

		if (role === "tool") {
			messages.push(...toolResultMessages(toolResults));
			continue;
		}

		if (role === "assistant") {
			// An assistant message with neither text nor tool calls is skipped: upstream
			// rejects a content-less assistant turn, and the host can produce one from a
			// message whose only blocks were reasoning (which is dropped above).
			if (!text && toolCalls.length === 0) continue;
			const message: OpenAiMessage = { role: "assistant", content: text || "" };
			if (toolCalls.length > 0) message.tool_calls = toolCalls;
			messages.push(message);
			continue;
		}

		if (role === "system") {
			if (text) messages.push({ role: "system", content: text });
			continue;
		}

		if (role === "user") {
			// Defensive, not a path the host takes: `buildHistory` and `pushUserTurn` both emit
			// tool results as their own `role: "tool"` message and never attach one to a user
			// message. Handled anyway because dropping a tool result would leave a tool call
			// unanswered and upstream rejects the whole turn for that — a costly failure mode
			// for two lines of tolerance. Emitted before the user text so the answer precedes
			// the next instruction.
			messages.push(...toolResultMessages(toolResults));
			const message = userMessage(text, images);
			if (message) messages.push(message);
		}
	}

	return messages;
}

/** The `current` turn of a chat request, in the canonical shape. */
export interface CanonicalCurrent {
	text?: unknown;
	images?: unknown;
	toolResults?: unknown;
}

/**
 * A continuation marker, which must not become a user message.
 *
 * The host sends `"."` to mean "keep going" when it has tool results to deliver and nothing
 * for the user to say. Forwarding it verbatim would put a literal period in the conversation.
 * The built-in adapter does the same check.
 */
function isContinuationMarker(text: string): boolean {
	return text === ".";
}

/** Append the current turn: pending tool results first, then whatever the user said. */
export function appendCurrentTurn(messages: OpenAiMessage[], current: CanonicalCurrent): void {
	const toolResults = Array.isArray(current.toolResults) ? current.toolResults : [];
	messages.push(...toolResultMessages(toolResults));

	const text = typeof current.text === "string" ? current.text : "";
	const images: OpenAiContentPart[] = [];
	if (Array.isArray(current.images)) {
		for (const image of current.images) {
			if (!isRecord(image)) continue;
			const mediaType = textOf(image.mediaType);
			const dataBase64 = textOf(image.dataBase64);
			if (mediaType && dataBase64) {
				images.push({ type: "image_url", image_url: { url: dataUrl(mediaType, dataBase64) } });
			}
		}
	}

	// A marker with images still has to be sent — the images are the payload. A marker on its
	// own carries nothing, and the tool results pushed above are what continues the turn.
	if (isContinuationMarker(text) && images.length === 0) return;

	const message = userMessage(isContinuationMarker(text) ? "" : text, images);
	if (message) messages.push(message);
}

/** Translate the canonical tool definitions into OpenAI function tools. */
export function convertTools(tools: readonly unknown[]): OpenAiTool[] {
	const converted: OpenAiTool[] = [];
	for (const tool of tools) {
		if (!isRecord(tool)) continue;
		const name = textOf(tool.name);
		if (!name) continue;
		converted.push({
			type: "function",
			function: {
				name,
				description: textOf(tool.description) ?? "",
				// An absent schema becomes an empty object schema rather than being omitted:
				// upstream requires `parameters` to be present for a function tool.
				parameters: isRecord(tool.inputSchema)
					? (tool.inputSchema as Record<string, unknown>)
					: { type: "object", properties: {} },
			},
		});
	}
	return converted;
}

/**
 * Prepend the system prompt.
 *
 * The host already injected one into the canonical history via
 * `RemoteProviderAdapter.injectSystemPrompt`, so this only handles the `generate` paths,
 * which build a message list from scratch.
 */
export function withSystemPrompt(
	messages: OpenAiMessage[],
	systemPrompt: string | undefined,
): OpenAiMessage[] {
	if (!systemPrompt) return messages;
	return [{ role: "system", content: systemPrompt }, ...messages];
}
