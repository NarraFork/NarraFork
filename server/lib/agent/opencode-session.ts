import { createHash, randomUUID } from "node:crypto";

/**
 * OpenCode Go's per-session routing header.
 *
 * OpenCode Go (`https://opencode.ai/zen/go/v1/...`) routes every request of one
 * session to the same upstream provider so the prompt cache actually hits. It
 * reads the session identity from this header alone — the Anthropic/OpenAI wire
 * formats it speaks have no session field of their own — and announced that
 * requests arriving without it may start erroring.
 *
 * Lowercase because HTTP header names are case-insensitive and every other
 * derived-identity header NarraFork emits (`x-codex-window-id`,
 * `x-conversation-id`) is written lowercase.
 */
export const OPENCODE_SESSION_HEADER = "x-opencode-session";

/**
 * Whether a base URL points at OpenCode's hosted gateway.
 *
 * Host-based rather than path-based: OpenCode Go serves three different paths
 * (`/zen/go/v1/responses`, `/chat/completions`, `/messages`) depending on the
 * model family, so a user's configured base URL may end at any of them, and
 * OpenCode Zen shares the same host. Matching the host covers every shape
 * without having to track their path layout.
 *
 * A relay in front of OpenCode (a NUG-style gateway on some other host) will
 * NOT match — from NarraFork's side that request is addressed to the relay, and
 * it is the relay that must carry the session identity the rest of the way.
 */
export function isOpencodeEndpoint(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		const host = new URL(baseUrl).hostname.toLowerCase();
		return host === "opencode.ai" || host.endsWith(".opencode.ai");
	} catch {
		return false;
	}
}

/**
 * Derive the stable session id for a conversation.
 *
 * Same construction as the Codex window id and the Claude session id: sha256 of
 * a namespaced conversation id, truncated to 16 bytes with the RFC 4122
 * version/variant bits forced so the result is a well-formed v4 UUID.
 *
 * Deterministic on purpose. Provider instances are rebuilt every chat turn, so
 * an instance-scoped id would change on every message of a single conversation
 * — which is precisely the case OpenCode's routing is trying to avoid, and it
 * fails silently: the request still succeeds, it just lands on a different
 * upstream and misses the cache.
 */
export function deriveOpencodeSessionId(conversationId: string): string {
	const bytes = createHash("sha256")
		.update(`narrafork-opencode-session:${conversationId}`)
		.digest()
		.subarray(0, 16);
	bytes[6] = (bytes[6] & 0x0f) | 0x40;
	bytes[8] = (bytes[8] & 0x3f) | 0x80;
	const hex = bytes.toString("hex");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/**
 * Session id for outbound requests that belong to no conversation.
 *
 * Minted once per process rather than per request: OpenCode keys prompt-cache
 * affinity on this value, so a fresh id every time would scatter the utility
 * calls of one running instance across upstreams for no benefit.
 */
const PROCESS_SESSION_ID = randomUUID();

/**
 * Build the OpenCode session header for one outbound request, or `{}` when it
 * does not apply.
 *
 * Returns empty when the endpoint is not OpenCode, and when the operator
 * already set the header themselves through `extraHeaders` — in that case
 * emitting our own would leave two differently-cased keys in the map, which
 * `fetch` comma-joins into a single malformed value.
 *
 * Requests with no conversation id (title generation, compaction, model probes)
 * fall back to {@link PROCESS_SESSION_ID}. They still need *a* session, and one
 * that is stable for the process beats a fresh id per request; they are simply
 * not tied to any one conversation.
 */
export function buildOpencodeSessionHeader(options: {
	baseUrl: string | undefined;
	conversationId?: string;
	extraHeaders?: Record<string, string>;
}): Record<string, string> {
	if (!isOpencodeEndpoint(options.baseUrl)) return {};
	const alreadySet = Object.keys(options.extraHeaders ?? {}).some(
		(key) => key.toLowerCase() === OPENCODE_SESSION_HEADER,
	);
	if (alreadySet) return {};
	const id = options.conversationId
		? deriveOpencodeSessionId(options.conversationId)
		: PROCESS_SESSION_ID;
	return { [OPENCODE_SESSION_HEADER]: id };
}
