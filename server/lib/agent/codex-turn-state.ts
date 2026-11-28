import { createHash, randomUUID } from "node:crypto";

/** In-memory identity of one logical user turn; never persist or derive it from a session id. */
export interface ProviderTurnContext {
	readonly id: string;
}

export function createProviderTurnContext(): ProviderTurnContext {
	return Object.freeze({ id: randomUUID() });
}

export interface CodexTurnStateScope {
	baseUrl: string;
	credentialId?: string;
	/** Final, case-insensitively merged headers, including actual authentication overrides. */
	headers: Record<string, string> | Headers;
}

export interface CodexTurnState {
	readonly value: string | null;
	/** OnceLock semantics: the first nonempty server token owns this logical turn. */
	capture(value: unknown): void;
}

const turnStates = new WeakMap<
	ProviderTurnContext,
	{ scopeDigest: string; state: CodexTurnState }
>();

/** Canonical wire header names/values, independent of object order and name casing. */
export function normalizedCodexHeaders(
	headers: Record<string, string> | Headers,
): Array<[string, string]> {
	return Array.from(new Headers(headers).entries()).sort(([left], [right]) =>
		left < right ? -1 : left > right ? 1 : 0,
	);
}

/** HTTP and WebSocket are transports of the same Responses endpoint. */
function normalizeEndpoint(baseUrl: string): string {
	const url = new URL(baseUrl);
	if (url.protocol === "ws:") url.protocol = "http:";
	if (url.protocol === "wss:") url.protocol = "https:";
	url.pathname = url.pathname.replace(/\/+$/, "");
	if (!url.pathname.endsWith("/responses")) url.pathname += "/responses";
	url.hash = "";
	return url.toString();
}

function authenticationHeader(name: string): boolean {
	return (
		name === "authorization" ||
		name === "proxy-authorization" ||
		name === "cookie" ||
		name === "openai-organization" ||
		name === "openai-project" ||
		/(?:^|-)(?:auth|token|key|secret|credential|account)(?:-|$)/.test(name)
	);
}

function createTurnState(): CodexTurnState {
	let token: string | null = null;
	return {
		get value() {
			return token;
		},
		capture(value) {
			if (token !== null) return;
			const candidate =
				typeof value === "string"
					? value.trim()
					: typeof value === "number" && Number.isFinite(value)
						? String(value)
						: "";
			if (candidate) token = candidate;
		},
	};
}

/**
 * No context means one isolated transport call. A changed authentication owner
 * replaces (rather than parks) the old lock, so switching A → B → A cannot revive
 * A's stale token. Header/proxy/UA changes that do not change auth preserve it.
 * Only the irreversible digest and server token are retained, never credentials.
 */
export function getCodexTurnState(
	context: ProviderTurnContext | undefined,
	scope: CodexTurnStateScope,
): CodexTurnState {
	if (!context) return createTurnState();
	const scopeDigest = createHash("sha256")
		.update(
			JSON.stringify([
				normalizeEndpoint(scope.baseUrl),
				scope.credentialId ?? "",
				normalizedCodexHeaders(scope.headers).filter(([name]) => authenticationHeader(name)),
			]),
		)
		.digest("hex");
	const current = turnStates.get(context);
	if (current?.scopeDigest === scopeDigest) return current.state;
	const state = createTurnState();
	turnStates.set(context, { scopeDigest, state });
	return state;
}

/**
 * Redact ephemeral turn identity in recorded JSON without parsing/reserializing a
 * potentially large response body. Tokenizing JSON scalars keeps quoted user text
 * intact and recognizes escaped property names as well as numeric server tokens.
 * This is only for evidence bytes; never apply it to the actual transport payload.
 */
export function redactCodexTurnStateInJsonText(text: string): string {
	if (!/turn|\\u/i.test(text)) return text;
	let sensitiveKeyEnd = -1;
	return text.replace(
		/"(?:[^"\\]|\\.)*(?:"|\\?$)|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?|true|false|null/g,
		(scalar: string, offset: number) => {
			if (sensitiveKeyEnd >= 0 && /^\s*:\s*$/.test(text.slice(sensitiveKeyEnd, offset))) {
				sensitiveKeyEnd = -1;
				return '"[REDACTED]"';
			}
			sensitiveKeyEnd = -1;
			// Sensitive names are short even when every character is Unicode-escaped.
			if (scalar[0] !== '"' || scalar.length > 128) return scalar;
			const end = offset + scalar.length;
			let next = end;
			while (/\s/.test(text[next] ?? "")) next++;
			if (text[next] !== ":") return scalar;
			try {
				const name = (JSON.parse(scalar) as string).toLowerCase();
				if (name === "x-codex-turn-state" || name === "turn_id") sensitiveKeyEnd = end;
			} catch {
				// Malformed upstream evidence must not interrupt the business stream.
			}
			return scalar;
		},
	);
}

/** Metadata events use the same header field as an HTTP response/WS upgrade. */
export function extractCodexTurnStateFromEvent(chunk: Record<string, unknown>): string | null {
	if (chunk.type !== "response.metadata" && chunk.type !== "codex.response.metadata") return null;
	if (!chunk.headers || typeof chunk.headers !== "object" || Array.isArray(chunk.headers))
		return null;
	for (const [name, value] of Object.entries(chunk.headers)) {
		if (name.toLowerCase() !== "x-codex-turn-state") continue;
		if (typeof value === "string" && value.trim()) return value.trim();
		if (typeof value === "number" && Number.isFinite(value)) return String(value);
	}
	return null;
}
