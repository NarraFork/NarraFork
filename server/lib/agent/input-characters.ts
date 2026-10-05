import type { ContextInputCharacters } from "@shared/context-usage";
import { logger } from "../logger";

type CountFailure =
	| "aborted"
	| "time_budget"
	| "node_budget"
	| "character_budget"
	| "depth_budget"
	| "unsupported_input"
	| "upstream_only_history";
interface CountDiagnostic {
	reason?: CountFailure;
}
// Fixed reason set bounds this map; global throttling also suppresses internal retry storms.
const diagnosticLastLogged = new Map<CountFailure | "slow", number>();
const DIAGNOSTIC_INTERVAL_MS = 60_000;
const SLOW_COUNT_MS = 25;

export interface InputCharacterBudget {
	maxChars?: number;
	maxNodes?: number;
	maxMilliseconds?: number;
}

export interface InputCharacterOptions extends InputCharacterBudget {
	/** Completions only: first messages[] entry is the known injected runtime prefix. */
	firstMessageIsRuntimeSystem?: boolean;
	/** Responses may concatenate historical system turns into instructions; only this prefix is fixed. */
	instructionsFixedChars?: number;
}

// Runtime provenance is object identity, not a text/role heuristic. This survives delegate
// replacement while remaining absent from serialized wire/history data and user JSON.
const runtimeSystemMessages = new WeakSet<object>();
const runtimeInstructionRoots = new WeakSet<object>();
/** The builder generated root instructions itself rather than lifting history text. */
export function markRuntimeInstructions<T extends object>(body: T): T {
	runtimeInstructionRoots.add(body);
	return body;
}
export function markRuntimeSystemMessage<T extends object>(message: T): T {
	runtimeSystemMessages.add(message);
	return message;
}

type ObjectValue = Record<string, unknown>;
function object(value: unknown): ObjectValue {
	return value && typeof value === "object" ? (value as ObjectValue) : {};
}

/** Counts the complete logical request, never a WS delta or serialized transport frame.
 * Protocol fields are selected here; user JSON (schema/args/results) is NOT filtered.
 * No request-sized copy/stringification is made. Failure is an unknown, not a partial count.
 */
export function countInputCharacters(
	body: unknown,
	signal?: AbortSignal,
	budget: InputCharacterOptions = {},
): Promise<ContextInputCharacters | null> {
	return measureInputCharacters(body, signal, budget, {});
}

async function measureInputCharacters(
	body: unknown,
	signal: AbortSignal | undefined,
	budget: InputCharacterOptions,
	diagnostic: CountDiagnostic,
): Promise<ContextInputCharacters | null> {
	const maxChars = budget.maxChars ?? 32 * 1024 * 1024;
	const maxNodes = budget.maxNodes ?? 100_000;
	const deadline = performance.now() + (budget.maxMilliseconds ?? 100);
	let nodes = 0;
	let work = 0;
	let totalChars = 0;
	let systemChars = 0;
	let toolsChars = 0;
	const ancestors = new Set<object>();
	const fail: (reason: CountFailure) => never = (reason) => {
		diagnostic.reason = reason;
		throw reason;
	};
	const check = () => {
		if (signal?.aborted) fail("aborted");
		if (nodes > maxNodes) fail("node_budget");
		if (performance.now() > deadline) fail("time_budget");
	};
	const tick = async () => {
		nodes++;
		check();
		if (++work % 2048 === 0) {
			await new Promise<void>((resolve) => setTimeout(resolve, 0));
			check();
		}
	};
	const add = (length: number, category: "system" | "tools" | "content") => {
		totalChars += length;
		if (totalChars > maxChars) fail("character_budget");
		if (category === "system") systemChars += length;
		if (category === "tools") toolsChars += length;
	};
	const text = (value: unknown, category: "system" | "content") => {
		check();
		if (typeof value === "string") add(value.length, category);
	};
	// JSON string length without allocating the escaped string. UTF-16, matching JSON.stringify.
	const quotedLength = async (value: string): Promise<number> => {
		if (value.length > maxChars) fail("character_budget");
		let length = 2;
		for (let i = 0; i < value.length; i++) {
			if (i % 256 === 0) await tick();
			const c = value.charCodeAt(i);
			if (c === 34 || c === 92 || c === 8 || c === 9 || c === 10 || c === 12 || c === 13)
				length += 2;
			else if (c < 32) length += 6;
			else if (c >= 0xd800 && c <= 0xdbff) {
				const next = value.charCodeAt(i + 1);
				if (next >= 0xdc00 && next <= 0xdfff) {
					length += 2;
					i++;
				} else length += 6;
			} else if (c >= 0xdc00 && c <= 0xdfff) length += 6;
			else length++;
		}
		return length;
	};
	const json = async (value: unknown, category: "tools" | "content", depth = 0): Promise<void> => {
		await tick();
		if (depth > 128) fail("depth_budget");
		if (typeof value === "string") {
			add(await quotedLength(value), category);
			return;
		}
		if (value === null || typeof value === "boolean" || typeof value === "number") {
			add(JSON.stringify(value).length, category);
			return;
		}
		if (typeof value !== "object" || ancestors.has(value)) fail("unsupported_input");
		const prototype = Object.getPrototypeOf(value);
		if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null)
			fail("unsupported_input");
		if (typeof (value as ObjectValue).toJSON === "function") fail("unsupported_input");
		ancestors.add(value);
		add(2, category);
		let count = 0;
		if (Array.isArray(value)) {
			for (const item of value) {
				if (count++) add(1, category);
				await json(item ?? null, category, depth + 1);
			}
		} else {
			for (const key in value) {
				if (!Object.hasOwn(value, key)) continue;
				await tick();
				const item = (value as ObjectValue)[key];
				if (item === undefined) continue;
				if (count++) add(1, category);
				add((await quotedLength(key)) + 1, category);
				await json(item, category, depth + 1);
			}
		}
		ancestors.delete(value);
	};
	const content = async (
		value: unknown,
		category: "system" | "content",
		depth = 0,
	): Promise<void> => {
		await tick();
		if (depth > 128) fail("depth_budget");
		if (typeof value === "string") {
			text(value, category);
			return;
		}
		if (Array.isArray(value)) {
			for (const part of value) await content(part, category, depth + 1);
			return;
		}
		if (value === undefined || value === null) return;
		if (typeof value !== "object") fail("unsupported_input");
		const part = object(value);
		// Explicit protocol discriminants. Never inspect image/data/signature/encrypted blobs.
		switch (part.type) {
			case "text":
			case "input_text":
			case "output_text":
			case "summary_text":
			case "reasoning_text":
				text(part.text, category);
				return;
			case "thinking":
				text(part.thinking, category);
				return;
			case "reasoning":
				await content(part.summary, category, depth + 1);
				await content(part.content, category, depth + 1);
				return;
			case "web_search_call": {
				const action = object(part.action);
				const selected: ObjectValue = {};
				for (const field of ["type", "query", "queries", "url", "pattern"]) {
					if (action[field] !== undefined) selected[field] = action[field];
				}
				await json(selected, "content");
				return;
			}
			case "image_generation_call":
				text(part.revised_prompt, category);
				return;
			case "refusal":
				text(part.refusal, category);
				return;
			case "image":
			case "input_image":
			case "image_url":
			case "redacted_thinking":
				return;
			case "tool_use":
				await json({ name: part.name, input: part.input }, "content");
				return;
			case "function_call":
				await json({ name: part.name, arguments: part.arguments }, "content");
				return;
			case "function_call_output":
				if (part.output && typeof part.output === "object" && !Array.isArray(part.output)) {
					await json(part.output, "content");
				} else await content(part.output, category, depth + 1);
				return;
			case "tool_result":
			case "user_input":
			case "model_output":
				await content(part.content, category, depth + 1);
				return;
			case "thought":
				await content(part.summary, category, depth + 1);
				return;
			case "function_result":
				if (typeof part.result === "string" || Array.isArray(part.result)) {
					await content(part.result, category, depth + 1);
				} else await json(part.result, "content");
				return;
		}
		if (part.role || part.type === "message") {
			// Role describes history, not fixed runtime ownership. The caller selects the prefix.
			await content(part.content, category, depth + 1);
			await content(part.parts, category, depth + 1);
			if (part.tool_calls) {
				if (!Array.isArray(part.tool_calls)) fail("unsupported_input");
				for (const call of part.tool_calls) {
					await tick();
					const fn = object(object(call).function);
					await json({ name: fn.name, arguments: fn.arguments }, "content");
				}
			}
			text(part.reasoning_content, category);
			return;
		}
		// Unknown typed blocks may carry new model-visible fields: never label a partial count complete.
		if (part.type !== undefined) fail("unsupported_input");
		// Gemini parts have no `type`. thoughtSignature is intentionally not selected.
		if (
			![
				"text",
				"functionCall",
				"functionResponse",
				"parts",
				"inlineData",
				"fileData",
				"thoughtSignature",
			].some((field) => Object.hasOwn(part, field))
		)
			fail("unsupported_input");
		text(part.text, category);
		if (part.functionCall) await json(part.functionCall, "content");
		if (part.functionResponse) {
			const response = object(part.functionResponse);
			// response is arbitrary user JSON; only sibling native parts are multimodal protocol.
			await json({ name: response.name, id: response.id, response: response.response }, "content");
			await content(response.parts, category, depth + 1);
		}
		if (part.parts) await content(part.parts, category, depth + 1);
	};
	try {
		check();
		if (!body || typeof body !== "object" || Array.isArray(body)) fail("unsupported_input");
		const request = object(body);
		const inputFields = [
			"system_instruction",
			"instructions",
			"system",
			"systemInstruction",
			"messages",
			"input",
			"contents",
			"tools",
		];
		let hasInput = false;
		for (const field of inputFields) {
			if (!Object.hasOwn(request, field) || request[field] === undefined) continue;
			const value = request[field];
			const valid =
				field === "messages" || field === "contents" || field === "tools"
					? Array.isArray(value)
					: field === "systemInstruction"
						? typeof value === "string" || Array.isArray(object(value).parts)
						: field === "instructions" || field === "system_instruction"
							? typeof value === "string"
							: typeof value === "string" || Array.isArray(value);
			if (!valid) fail("unsupported_input");
			hasInput = true;
		}
		if (!hasInput) fail("unsupported_input");
		// Interactions chains reference upstream-only history, so a delta is not a full denominator.
		if (request.previous_interaction_id != null) fail("upstream_only_history");
		text(request.system_instruction, "system");
		if (typeof request.instructions === "string") {
			text(request.instructions, "content");
			const fixed = budget.instructionsFixedChars ?? request.instructions.length;
			if (!Number.isSafeInteger(fixed) || fixed < 0 || fixed > request.instructions.length)
				fail("unsupported_input");
			systemChars += fixed;
		}
		await content(request.system, "system");
		await content(request.systemInstruction, "system");
		if (Array.isArray(request.messages)) {
			for (const [index, message] of request.messages.entries()) {
				const role = object(message).role;
				const fixed =
					budget.firstMessageIsRuntimeSystem &&
					index === 0 &&
					(role === "system" || role === "developer");
				await content(message, fixed ? "system" : "content");
			}
		}
		for (const field of ["input", "contents"]) await content(request[field], "content");
		if (request.tools) {
			// Tool declarations are model inputs; only transport/cache annotations are omitted.
			if (!Array.isArray(request.tools)) fail("unsupported_input");
			for (const declaration of request.tools) {
				await tick();
				const tool = object(declaration);
				const selected: ObjectValue = {};
				for (const field of [
					"type",
					"name",
					"description",
					"input_schema",
					"parameters",
					"strict",
					"function",
					"functionDeclarations",
					"googleSearch",
					"google_search",
					"url_context",
					"search_context_size",
					"user_location",
					"filters",
					"allowed_domains",
					"blocked_domains",
					"max_uses",
					"defer_loading",
					"output_format",
					"size",
					"quality",
					"background",
					"moderation",
					"input_fidelity",
					"partial_images",
					"vector_store_ids",
					"max_num_results",
					"ranking_options",
					"container",
					"environment",
				]) {
					if (tool[field] !== undefined) selected[field] = tool[field];
				}
				for (const field in tool) {
					await tick();
					if (
						Object.hasOwn(tool, field) &&
						field !== "cache_control" &&
						tool[field] !== undefined &&
						!Object.hasOwn(selected, field)
					)
						fail("unsupported_input");
				}
				await json(selected, "tools");
			}
		}
		check();
		return { totalChars, systemChars, toolsChars };
	} catch {
		diagnostic.reason ??= "unsupported_input";
		return null;
	}
}

export async function reportInputCharacters(
	params: {
		signal: AbortSignal;
		history?: readonly unknown[];
		onInputCharacters?: (counts: ContextInputCharacters | null) => void;
	},
	body: unknown,
	budget: InputCharacterOptions = {},
): Promise<void> {
	if (!params.onInputCharacters) return;
	const diagnostic: CountDiagnostic = {};
	const startedAt = performance.now();
	const options: InputCharacterOptions = { ...budget };
	const request = object(body);
	const first = params.history?.[0];
	const synthetic = !!first && typeof first === "object" && runtimeSystemMessages.has(first);
	if (
		params.history &&
		Array.isArray(request.messages) &&
		options.firstMessageIsRuntimeSystem === undefined
	) {
		options.firstMessageIsRuntimeSystem = synthetic && request.messages[0] === first;
	}
	if (
		params.history &&
		typeof request.instructions === "string" &&
		options.instructionsFixedChars === undefined
	) {
		const runtimeContent = object(first).content;
		options.instructionsFixedChars = runtimeInstructionRoots.has(request)
			? request.instructions.length
			: synthetic && typeof runtimeContent === "string"
				? runtimeContent.length > (options.maxChars ?? 32 * 1024 * 1024) ||
					request.instructions === runtimeContent ||
					(!params.signal.aborted && request.instructions.startsWith(runtimeContent))
					? runtimeContent.length
					: -1
				: 0;
	}
	// Charge prefix projection to the same wall-clock budget as traversal.
	options.maxMilliseconds = (budget.maxMilliseconds ?? 100) - (performance.now() - startedAt);
	const counts = await measureInputCharacters(body, params.signal, options, diagnostic);
	const durationMs = Math.round(performance.now() - startedAt);
	const reason = diagnostic.reason ?? (durationMs >= SLOW_COUNT_MS ? "slow" : undefined);
	if (reason) {
		const now = Date.now();
		const lastLogged = diagnosticLastLogged.get(reason);
		if (lastLogged === undefined || now - lastLogged >= DIAGNOSTIC_INTERVAL_MS) {
			diagnosticLastLogged.set(reason, now);
			// Fixed metadata only: never include the input, exception, or stack.
			const metadata = { reason, durationMs };
			if (reason === "aborted")
				logger.debug("Provider input character count unavailable", metadata);
			else
				logger.warn(
					counts === null
						? "Provider input character count unavailable"
						: "Provider input character count slow",
					metadata,
				);
		}
	}
	params.onInputCharacters(counts);
}
