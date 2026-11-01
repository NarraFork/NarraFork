import { logger } from "../logger";
import type { ResponseFormat } from "./provider";
import { ApiError } from "./types";
import { parseUnsupportedParameter } from "./unsupported-parameter-fallback";

/**
 * Fallback for relays that explicitly reject a JSON-Schema output constraint
 * or accept the request but ignore the constraint.
 *
 * Observed on relayed OpenAI-Responses-compatible endpoints (e.g. `geek2api`
 * serving `deepseek-v4.1-flash`): the request carries `text.format`, the call
 * succeeds, and the body comes back as ordinary prose. The result is a silent
 * capability gap — the caller gets text and no structured fields, with nothing
 * to distinguish "the model chose prose" from "the relay dropped the field".
 *
 * Two rules keep this honest:
 *
 *  - Native structured output stays the first choice. Only a relay that has
 *    actually failed to honour it is downgraded, so upstreams that do support it
 *    are untouched.
 *  - The downgrade is *remembered per model* and re-applied, so a known-bad relay
 *    costs one wasted attempt per process rather than one per request.
 *
 * Trade-off, stated plainly: the text path can still yield every field (the
 * schema is restated in the instruction and the reply is parsed with the same
 * tolerant parser), but it loses the *guarantee*. A strict `json_schema` makes
 * malformed output impossible; an instruction makes it merely unlikely.
 */

/** Only an explicit capability rejection of the sent format warrants a retry. */
export function isStructuredOutputRejection(
	error: unknown,
	parameter: "response_format" | "text.format",
): boolean {
	if (!(error instanceof ApiError) || error.status !== 400) return false;
	if (parseUnsupportedParameter(error.message) === parameter) return true;
	const field = parameter.replace(".", "\\.");
	return new RegExp(
		`\\b${field}["']?(?:\\s+of type\\s+["']?json_schema["']?)?\\s+(?:is\\s+)?not supported\\b`,
		"i",
	).test(error.message);
}

/** Models known to reject or ignore a native structured-output constraint. */
const lacksNativeStructuredOutput = new Set<string>();

/**
 * Bound the learned set. Keys are caller-supplied, so an unbounded set would be
 * a slow leak in a long-lived process.
 */
const MAX_REMEMBERED_MODELS = 200;

/**
 * Identity of the thing whose capability is being learned.
 *
 * The API mode is part of the key because the two endpoints carry different
 * fields — chat completions uses `response_format`, the Responses API uses
 * `text.format` — and relays routinely implement one while dropping the other.
 * Keying on the model alone would let a chat-only failure silently downgrade a
 * Responses request that would have worked.
 */
export function structuredOutputRelayKey(apiMode: string, model: string): string {
	return `${apiMode}:${model}`;
}

/** Test seam: forget everything learned so far. */
export function resetStructuredOutputFallbackMemory(): void {
	lacksNativeStructuredOutput.clear();
}

/** Whether this relay has already failed to honour a native structured constraint. */
export function modelLacksNativeStructuredOutput(relayKey: string): boolean {
	return lacksNativeStructuredOutput.has(relayKey);
}

/**
 * Record that a relay rejected or ignored a native structured constraint.
 *
 * Per-process and in-memory on purpose: it only ever saves a wasted first
 * attempt, so losing it on restart costs one extra request, while persisting it
 * would keep downgrading an upstream long after the relay added support.
 */
export function rememberMissingNativeStructuredOutput(relayKey: string): void {
	if (lacksNativeStructuredOutput.has(relayKey)) return;
	if (lacksNativeStructuredOutput.size >= MAX_REMEMBERED_MODELS) {
		// Drop the oldest insertion rather than clearing everything, so the
		// busiest relays keep their learned state.
		const oldest = lacksNativeStructuredOutput.values().next();
		if (!oldest.done) lacksNativeStructuredOutput.delete(oldest.value);
	}
	lacksNativeStructuredOutput.add(relayKey);
	logger.warn("Relay rejected or ignored structured output; downgrading to a text instruction", {
		relay: relayKey,
	});
}

/**
 * Render the schema as an instruction the model can follow without any native
 * support for structured output.
 *
 * The schema is serialized verbatim (not summarized) so the model sees exactly
 * the field names and requirements the caller will parse.
 */
export function renderSchemaInstruction(responseFormat: ResponseFormat): string {
	const schema = JSON.stringify(responseFormat.schema, null, 2);
	return [
		"",
		"═══════════════════════════════════════════════════════════════",
		"OUTPUT FORMAT — return JSON only",
		"═══════════════════════════════════════════════════════════════",
		`Respond with a single JSON object that satisfies this JSON Schema (${responseFormat.name}):`,
		"",
		schema,
		"",
		"Output the JSON object and nothing else: no explanation, no commentary, no",
		"summary of your process, no text before or after the object, and no markdown",
		"code fences. Every required field must be present. Do not add fields that the",
		"schema does not declare.",
	].join("\n");
}

/**
 * Append the schema instruction to a caller's system instruction.
 *
 * Appending (rather than replacing) keeps the task instructions intact: the
 * optimizer still receives its style guidance and any segment-marker contract,
 * with only the output framing added.
 */
export function withSchemaInstruction(
	systemInstruction: string | undefined,
	responseFormat: ResponseFormat,
): string {
	const block = renderSchemaInstruction(responseFormat);
	return systemInstruction ? `${systemInstruction}\n${block}` : block.trimStart();
}
