/**
 * Tool-name normalization for provider wire formats.
 *
 * Every provider we talk to constrains function names to a conservative
 * identifier alphabet. OpenAI (both Responses and Completions) rejects the
 * whole request with
 *
 * ```
 * 400 Invalid 'tools[19].function.name': string does not match pattern
 *     '^[a-zA-Z0-9_-]+$'
 * ```
 *
 * so one bad name kills the entire turn, not just that tool. Anthropic and
 * Gemini apply the same alphabet, and Gemini additionally requires the name to
 * start with a letter or underscore.
 *
 * Built-in tool names are hand-written and already safe. The dynamic sources are
 * not: MCP servers may expose dotted/namespaced names (`github.search_issues`,
 * `fs/read`), and plugin contributions are keyed by reverse-DNS plugin IDs
 * (`com.example.duo`). Both flow straight into the registry, so normalization
 * has to happen where the name is minted — see `mcp/tool-bridge.ts` and
 * `services/plugin-agent-tool-bridge.ts`.
 */

/** The intersection of the name alphabets accepted by OpenAI/Anthropic/Gemini. */
export const TOOL_NAME_PATTERN = /^[a-zA-Z0-9_-]+$/;

/**
 * Upper bound on a wire tool name. OpenAI documents 64 for function names;
 * Anthropic allows 128. We keep the stricter limit so a name is valid for every
 * provider a session can switch to mid-run.
 */
export const MAX_TOOL_NAME_LENGTH = 64;

/** True when `name` can be sent to every supported provider as-is. */
export function isValidToolName(name: string): boolean {
	return name.length > 0 && name.length <= MAX_TOOL_NAME_LENGTH && TOOL_NAME_PATTERN.test(name);
}

/**
 * Coerce one name segment into the safe alphabet.
 *
 * Illegal characters collapse to `_` rather than being dropped, so distinct
 * source names stay distinct (`a.b` and `a-b` do not both become `ab`).
 * Returns `"unknown"` for input that contains nothing usable.
 */
export function sanitizeToolNameSegment(value: string): string {
	const replaced = value.replace(/[^a-zA-Z0-9_-]/g, "_");
	// A segment of pure separators carries no information — treat it as empty.
	return /[a-zA-Z0-9]/.test(replaced) ? replaced : "unknown";
}

/**
 * Deterministic short suffix used when a name has to be shortened. Truncation
 * alone would let two long names collide under one wire name, which the tool
 * registry would then silently dedupe.
 */
function nameDigest(value: string): string {
	// FNV-1a: no crypto dependency, stable across processes, plenty for a
	// collision-avoidance tag on a 64-char budget.
	let hash = 0x811c9dc5;
	for (let i = 0; i < value.length; i++) {
		hash ^= value.charCodeAt(i);
		hash = Math.imul(hash, 0x01000193) >>> 0;
	}
	return hash.toString(36).padStart(7, "0").slice(-7);
}

/**
 * Normalize a fully-assembled tool name so it is accepted by every provider.
 *
 * Names already inside the alphabet and length budget are returned untouched,
 * so built-in tool names (and existing conversation history that references
 * them) never shift.
 */
export function normalizeToolName(name: string): string {
	const sanitized = sanitizeToolNameSegment(name);
	if (sanitized.length <= MAX_TOOL_NAME_LENGTH) return sanitized;
	const suffix = `_${nameDigest(name)}`;
	return `${sanitized.slice(0, MAX_TOOL_NAME_LENGTH - suffix.length)}${suffix}`;
}
