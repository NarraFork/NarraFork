/**
 * Project tool schemas at the Gemini `parameters` boundary, not in the shared catalog.
 * This is the existing lossy Schema projection, not a JSON Schema compiler: refs
 * and dynamic-key constraints are omitted, string const becomes enum, and the
 * existing oneOf/allOf → anyOf compatibility behavior is retained.
 */
export function sanitizeGeminiSchema(schema: Record<string, unknown>): Record<string, unknown> {
	return sanitizeNode(schema) as Record<string, unknown>;
}

// Match the Schema vocabulary already used by geminiResponseSchema. A denylist
// cannot cover arbitrary annotations supplied by MCP servers. Property names and
// example data are not Schema keywords and must not be filtered through this set.
const GEMINI_SCHEMA_KEYS = new Set([
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

function sanitizeNode(node: unknown): unknown {
	if (Array.isArray(node)) return node.map(sanitizeNode);
	if (!node || typeof node !== "object") return node;
	const output: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
		if (key === "const") {
			// Gemini's enum field accepts strings only; retain other literals' types.
			if (typeof value === "string") output.enum = [value];
			continue;
		}
		if (key === "oneOf" || key === "allOf" || key === "anyOf") {
			output.anyOf = (value as unknown[]).map(sanitizeNode);
			continue;
		}
		if (!GEMINI_SCHEMA_KEYS.has(key)) continue;
		if (key === "enum" && Array.isArray(value) && !value.every((v) => typeof v === "string")) {
			continue;
		}
		if (key === "properties" && value && typeof value === "object") {
			output.properties = Object.fromEntries(
				Object.entries(value as Record<string, unknown>).map(([name, schema]) => [
					name,
					sanitizeNode(schema),
				]),
			);
		} else if (key === "items") {
			output.items = sanitizeNode(value);
		} else {
			// Clone data values without treating their keys as schema keywords.
			output[key] = value !== null && typeof value === "object" ? structuredClone(value) : value;
		}
	}
	return output;
}
