import type { GenerateMetaResult, ResponseFormat } from "./provider";

/**
 * Shared plumbing for {@link ResponseFormat}.
 *
 * Three adapters express a JSON-Schema output constraint natively, each with a
 * different wire shape, so the mapping lives here rather than being copied into
 * every provider. Two rules hold for all of them:
 *
 *  - A schema the upstream cannot represent must be *reported*, never silently
 *    dropped (see `degraded`). Callers depend on the difference between "the
 *    model produced JSON that satisfied the schema" and "the model produced
 *    prose and we hoped for the best".
 *  - Parsing is deliberately permissive about *wrapping* (a model that answers
 *    with a fenced block or a leading sentence still yields its JSON payload)
 *    and strict about *shape* (the caller validates the fields it needs).
 */

/** Reason reported when an adapter has no native structured-output mechanism. */
export function unsupportedResponseFormatReason(adapter: string): string {
	return `${adapter} has no native JSON-Schema output mode`;
}

/**
 * Strip a single wrapping code fence, if the whole payload is fenced.
 *
 * Models that are asked for JSON sometimes still wrap it in ```json … ```. This
 * only removes a fence that encloses the *entire* string so a schema field whose
 * value legitimately contains fences is never mangled.
 */
function stripWrappingFence(text: string): string {
	const trimmed = text.trim();
	if (!trimmed.startsWith("```") || !trimmed.endsWith("```")) return trimmed;
	const firstNewline = trimmed.indexOf("\n");
	const lastFence = trimmed.lastIndexOf("```");
	if (firstNewline === -1 || lastFence <= firstNewline) return trimmed;
	return trimmed.slice(firstNewline + 1, lastFence).trim();
}

/**
 * Find the first balanced `{...}` substring, ignoring braces inside strings.
 *
 * Relays that support a schema but not the framing contract still return the
 * object — just with a leading sentence ("Here you go:") or a trailing note. A
 * whole-string `JSON.parse` fails on that even though the payload is present.
 */
function firstBalancedJsonObject(text: string): string | undefined {
	const start = text.indexOf("{");
	if (start === -1) return undefined;
	let depth = 0;
	let inString = false;
	let escaped = false;
	for (let i = start; i < text.length; i++) {
		const ch = text[i];
		if (inString) {
			if (escaped) escaped = false;
			else if (ch === "\\") escaped = true;
			else if (ch === '"') inString = false;
			continue;
		}
		if (ch === '"') inString = true;
		else if (ch === "{") depth++;
		else if (ch === "}") {
			depth--;
			if (depth === 0) return text.slice(start, i + 1);
		}
	}
	return undefined;
}

/**
 * Parse a provider response that was supposed to be JSON.
 *
 * Tolerant about framing (fences, a leading sentence, a trailing note), strict
 * about shape (an object, never an array or a bare scalar). Returns `undefined`
 * when no JSON object is present, so the caller can report a degradation instead
 * of handing prose to a schema consumer.
 */
export function parseStructuredJsonText(text: string | undefined): unknown | undefined {
	if (!text) return undefined;
	const candidates = [stripWrappingFence(text), text.trim()];
	const embedded = firstBalancedJsonObject(candidates[0] ?? "");
	if (embedded) candidates.push(embedded);
	for (const candidate of candidates) {
		if (!candidate) continue;
		try {
			const parsed: unknown = JSON.parse(candidate);
			if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
				return parsed as Record<string, unknown>;
			}
			// Parsed, but not the object shape these schemas describe: keep looking
			// rather than reporting a type mismatch as a parse failure.
			if (candidate !== embedded) continue;
			return undefined;
		} catch {
			// Try the next candidate.
		}
	}
	return undefined;
}

/** Parse already-accumulated tool arguments (Anthropic forced-tool mode). */
export function parseToolArguments(args: string | undefined): unknown | undefined {
	if (!args?.trim()) return undefined;
	try {
		const parsed: unknown = JSON.parse(args);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed;
		return undefined;
	} catch {
		return undefined;
	}
}

/**
 * Lift the optional user-facing rationale out of a parsed payload.
 *
 * Adapters do not know the caller's field names, so the caller names the field
 * on the format (`summaryField`). This is read-only reporting: the value is
 * never merged into `text`, so it cannot leak into a generated body.
 */
export function extractReasoningSummary(
	structured: unknown,
	responseFormat: ResponseFormat | undefined,
): string | undefined {
	const field = responseFormat?.summaryField;
	if (!field || !structured || typeof structured !== "object") return undefined;
	const value = (structured as Record<string, unknown>)[field];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

/**
 * Build the `structured` / `reasoningSummary` / `responseFormatDegraded` triple
 * for a request that carried a `responseFormat`.
 *
 * `raw` is the text the provider produced (or `undefined` when the adapter
 * already extracted structure itself, e.g. from a tool call).
 */
export function structuredResult(
	options: { responseFormat?: ResponseFormat } | undefined,
	raw: string | undefined,
	adapter: string,
): Pick<GenerateMetaResult, "structured" | "reasoningSummary" | "responseFormatDegraded"> {
	if (!options?.responseFormat) return {};
	const structured = parseStructuredJsonText(raw);
	if (structured !== undefined) {
		const reasoningSummary = extractReasoningSummary(structured, options.responseFormat);
		return { structured, ...(reasoningSummary ? { reasoningSummary } : {}) };
	}
	// The request asked for a schema but the answer was not JSON: the text is
	// still worth returning (it may be the model's best attempt, and the caller's
	// fallback path can clean it), but the caller must not assume structure — and
	// no summary is invented from the prose.
	return {
		responseFormatDegraded: `${adapter} returned output that is not a JSON object`,
	};
}

/** OpenAI Chat Completions `response_format`. */
export function openAIChatResponseFormat(responseFormat: ResponseFormat): Record<string, unknown> {
	return {
		type: "json_schema",
		json_schema: {
			name: responseFormat.name,
			schema: responseFormat.schema,
			...(responseFormat.strict === false ? {} : { strict: true }),
		},
	};
}

/**
 * OpenAI Responses API expresses the constraint as `text.format` rather than
 * `response_format`; the shape of the inner object is the same.
 */
export function openAIResponsesTextFormat(responseFormat: ResponseFormat): Record<string, unknown> {
	return {
		format: {
			type: "json_schema",
			name: responseFormat.name,
			schema: responseFormat.schema,
			...(responseFormat.strict === false ? {} : { strict: true }),
		},
	};
}

/**
 * Gemini accepts only an OpenAPI-schema subset in `responseSchema` and rejects
 * unknown keywords with a 400, so the shared JSON Schema is projected down to
 * the keywords Gemini documents. Dropping `additionalProperties` is safe: Gemini
 * has no way to express it, and the caller validates the shape anyway.
 */
const GEMINI_SCHEMA_KEYWORDS = new Set([
	"type",
	"format",
	"title",
	"description",
	"nullable",
	"enum",
	"items",
	"properties",
	"required",
	"minimum",
	"maximum",
	"minItems",
	"maxItems",
	"minLength",
	"maxLength",
	"pattern",
	"example",
	"anyOf",
	"propertyOrdering",
]);

export function geminiResponseSchema(schema: Record<string, unknown>): Record<string, unknown> {
	const project = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(project);
		if (!node || typeof node !== "object") return node;
		const source = node as Record<string, unknown>;
		const out: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(source)) {
			if (key === "properties" && value && typeof value === "object") {
				const props: Record<string, unknown> = {};
				for (const [propName, propSchema] of Object.entries(value as Record<string, unknown>)) {
					props[propName] = project(propSchema);
				}
				out.properties = props;
				continue;
			}
			if (key === "items" || key === "anyOf") {
				out[key] = project(value);
				continue;
			}
			if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;
			out[key] = value;
		}
		return out;
	};
	const projected = project(schema);
	return (projected && typeof projected === "object" ? projected : {}) as Record<string, unknown>;
}
