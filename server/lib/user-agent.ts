import os from "node:os";
import { deriveCodexWindowId } from "./agent/codex-request";
import { APP_VERSION } from "./version";

export const ORIGINATOR = "narrafork";
// Managed identity pins; the Claude billing cc_version shares this value.
export const CLAUDE_CLI_VERSION = "2.1.330";
// Keep both Codex UA version positions and originator aligned.
export const CODEX_CLI_VERSION = "0.171.0";
export const ORIGINATOR_CODEX = "codex-tui";

/**
 * The upstream header that opts a Responses request into the "lite" request
 * contract. NarraFork must never send it — see {@link buildCodexEmulationHeaders}
 * for the full contract it would obligate us to implement, and
 * {@link stripResponsesLiteHeader} for the enforcement.
 */
export const RESPONSES_LITE_HEADER = "x-openai-internal-codex-responses-lite";

/**
 * Strip the lite header from an outbound header map.
 *
 * Applied to user-supplied `extraHeaders` because those are merged last and
 * would otherwise re-introduce a header whose body contract NarraFork does not
 * implement, turning every request to a strict endpoint into a 400. Operators
 * who genuinely need lite must first implement the body half of the contract.
 */
export function stripResponsesLiteHeader(headers: Record<string, string>): void {
	for (const key of Object.keys(headers)) {
		if (key.toLowerCase() === RESPONSES_LITE_HEADER) delete headers[key];
	}
}

/**
 * Get OS type string in Codex format.
 * Maps Node.js os.type() to Codex-style OS names.
 */
function getOsType(): string {
	const type = os.type();
	switch (type) {
		case "Darwin":
			return "macOS";
		case "Linux":
			return "Linux";
		case "Windows_NT":
			return "Windows";
		default:
			return type;
	}
}

/**
 * Get OS version string.
 * For Linux, tries to read from /etc/os-release, falls back to os.release().
 */
function getOsVersion(): string {
	const platform = os.platform();

	if (platform === "linux") {
		try {
			// Use readFileSync for synchronous read
			const fs = require("node:fs");
			const content = fs.readFileSync("/etc/os-release", "utf-8");
			// Extract PRETTY_NAME or NAME + VERSION_ID
			const prettyNameMatch = content.match(/PRETTY_NAME="([^"]+)"/);
			if (prettyNameMatch) {
				return prettyNameMatch[1];
			}
			const nameMatch = content.match(/NAME="([^"]+)"/);
			const versionMatch = content.match(/VERSION_ID="([^"]+)"/);
			if (nameMatch && versionMatch) {
				return `${nameMatch[1]} ${versionMatch[1]}`;
			}
			if (nameMatch) {
				return nameMatch[1];
			}
		} catch {
			// Fall through to os.release()
		}
	}

	return os.release();
}

/**
 * Get CPU architecture string.
 */
function getArchitecture(): string {
	return os.arch();
}

function getCodexArchitecture(): string {
	switch (os.arch()) {
		case "x64":
			return "x86_64";
		case "arm64":
			return "aarch64";
		case "ia32":
			return "x86";
		default:
			return os.arch();
	}
}

/**
 * Get terminal/runtime information.
 * Mimics Codex's user_agent() function from codex_terminal_detection.
 *
 * @param fallback - Value returned when no terminal can be detected. NarraFork's
 *   own UA reports the Bun runtime; the Codex UA uses "unknown" to match the real
 *   Codex CLI, which never leaks a runtime version here.
 */
function getTerminalInfo(fallback: string): string {
	// Check common terminal environment variables
	const term = process.env.TERM_PROGRAM;
	if (term) {
		const version = process.env.TERM_PROGRAM_VERSION;
		return version ? `${term}/${version}` : term;
	}

	// Check if running in VS Code
	if (process.env.VSCODE_PID) {
		return "vscode";
	}

	// Check if running in JetBrains IDE
	if (process.env.TERMINAL_EMULATOR?.includes("JetBrains")) {
		return "jetbrains";
	}

	return fallback;
}

/**
 * Build User-Agent string in Codex format:
 * {originator}/{version} ({os_type} {os_version}; {arch}) {terminal_info}
 *
 * Example: narrafork/0.1.12 (Linux Ubuntu 22.04; x64) Bun/1.2.0
 */
export function getUserAgent(): string {
	const osType = getOsType();
	const osVersion = getOsVersion();
	const arch = getArchitecture();
	const terminalInfo = getTerminalInfo(`Bun/${Bun.version}`);

	return `${ORIGINATOR}/${APP_VERSION} (${osType} ${osVersion}; ${arch}) ${terminalInfo}`;
}

/**
 * Build the managed Codex client User-Agent shape:
 * codex-tui/{version} ({os_type} {os_version}; {arch}) unknown (codex-tui; {version})
 */
export function getCodexUserAgent(): string {
	const osType = getOsType();
	const osVersion = getOsVersion();
	const arch = getCodexArchitecture();

	return `${ORIGINATOR_CODEX}/${CODEX_CLI_VERSION} (${osType} ${osVersion}; ${arch}) unknown (${ORIGINATOR_CODEX}; ${CODEX_CLI_VERSION})`;
}

/**
 * Build User-Agent string in Claude CLI format (for Anthropic API):
 * claude-cli/{version} (external, cli)
 *
 * This format is required by Anthropic's official API for proper authentication.
 * The "external" user type indicates this is a third-party client.
 * Uses the official Claude CLI version number for compatibility.
 */
export function getClaudeCliUserAgent(): string {
	return `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`;
}

/**
 * Upper bound on an outbound User-Agent, well above any real client's UA.
 *
 * A UA is partly built from host-supplied text (`PRETTY_NAME` in /etc/os-release,
 * terminal env vars, an operator's custom string), none of which is length-bounded
 * at the source. Some upstreams reject oversized request headers outright, so an
 * unusual host string would otherwise break every request with a confusing error.
 */
const MAX_USER_AGENT_LENGTH = 256;

/**
 * Sanitize User-Agent string to ensure it's a valid HTTP header value.
 * Replaces invalid characters with underscores and bounds the length.
 */
export function sanitizeUserAgent(userAgent: string): string {
	// HTTP header values must be ASCII printable characters (0x20-0x7E)
	return userAgent.replace(/[^\x20-\x7E]/g, "_").slice(0, MAX_USER_AGENT_LENGTH);
}

/**
 * Merge HTTP header layers without retaining differently-cased duplicates.
 * The later non-empty value wins, including within a single supplied layer.
 * Preserve the first spelling for callers that inspect the record; User-Agent
 * always uses the caller's spelling and is sanitized. Empty overrides keep the
 * default (they do not mean deletion).
 */
export function mergeExtraHeaders(
	headers: Record<string, string>,
	extraHeaders: Record<string, string> | undefined,
	userAgentKey: string,
): void {
	const names = new Map<string, string>();
	for (const [key, value] of Object.entries(headers)) {
		const lower = key.toLowerCase();
		const name = lower === "user-agent" ? userAgentKey : (names.get(lower) ?? key);
		if (name !== key) delete headers[key];
		Object.defineProperty(headers, name, {
			value: lower === "user-agent" ? sanitizeUserAgent(value) : value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		names.set(lower, name);
	}
	for (const [key, value] of Object.entries(extraHeaders ?? {})) {
		if (!value) continue;
		const lower = key.toLowerCase();
		if (lower === "user-agent" && !value.trim()) continue;
		const name = lower === "user-agent" ? userAgentKey : (names.get(lower) ?? key);
		Object.defineProperty(headers, name, {
			value: lower === "user-agent" ? sanitizeUserAgent(value.trim()) : value,
			writable: true,
			enumerable: true,
			configurable: true,
		});
		names.set(lower, name);
	}
}

/**
 * Get sanitized User-Agent string ready for HTTP headers.
 */
export function getHttpUserAgent(): string {
	return sanitizeUserAgent(getUserAgent());
}

/**
 * Get sanitized Claude CLI User-Agent string for Anthropic API.
 */
export function getHttpClaudeCliUserAgent(): string {
	return sanitizeUserAgent(getClaudeCliUserAgent());
}

/**
 * Get sanitized Codex CLI User-Agent string.
 */
export function getHttpCodexUserAgent(): string {
	return sanitizeUserAgent(getCodexUserAgent());
}

/**
 * Build the stable Codex client headers, transcribed from captured codex-tui
 * traffic, while deliberately omitting the volatile per-turn tracking headers
 * the real client also sends (x-codex-turn-metadata).
 *
 * The turn-metadata blob carries runtime environment and timing detail —
 * sandbox mode, workspace git state, turn start timestamp — that NarraFork has
 * no reason to report upstream. Every header below is stable for the lifetime
 * of a conversation, including x-codex-window-id, which codex-rs keeps stable
 * per TUI window and NarraFork derives deterministically per conversation
 * (see deriveCodexWindowId).
 *
 * Also omitted: x-codex-beta-features. The real client derives it from the beta
 * features it actually has enabled (responses_websockets_v2,
 * remote_compaction_v2, use_agent_identity, workspace_dependencies, ...), so a
 * hardcoded value would claim capabilities NarraFork does not implement.
 *
 * Also omitted: x-openai-internal-codex-responses-lite. In the real client that
 * header is not an identity marker at all — it is one half of a request contract
 * driven by the per-model `ModelInfo.use_responses_lite` flag, which upstream
 * publishes in its model catalog. When that flag is set, codex-rs/core/src/client.rs
 * sends the header, moves `tools` into an `additional_tools` input item, and
 * forces `parallel_tool_calls: false`. In 0.171.0, NONEMPTY base instructions
 * are a developer input prefix in BOTH lite and non-lite requests; empty
 * instructions produce no prefix. Upstream validates the tools/header pairing and rejects the
 * header whenever `tools` carries anything but function/custom/client-executed
 * search tools:
 *
 *   "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools,
 *    custom tools, and client-executed tool search."
 *
 * NarraFork implements the non-lite branch with top-level tools, including
 * hosted `web_search`/`image_generation`, and a nonempty developer instruction prefix.
 * Claiming lite would violate that pairing. Upstream still supports non-lite;
 * this does not guarantee every model supports it. The opt-in is dropped rather
 * than silently deleting tools. {@link stripResponsesLiteHeader} enforces this
 * on outbound header maps, and the codex parity tests pin it.
 *
 * Also omitted: x-codex-installation-id as a direct header. codex-rs only puts
 * the installation id in the request body's `client_metadata` (and inside the
 * turn-metadata blob we deliberately do not send); its `compatibility_headers()`
 * projects window-id / session-id / thread-id onto real headers but never the
 * installation id — the only place that constant is sent as a real HTTP header
 * is the remote-control enrollment API, a different service. Emitting it here
 * produced a header set no real `/responses` client sends. The value still
 * travels in body `client_metadata["x-codex-installation-id"]` via
 * createCodexRequestIdentity; only this header projection is absent.
 *
 * Included:
 * - originator: follows the operator's User-Agent mode — "narrafork" when they
 *   chose NarraFork identity, otherwise the managed Codex CLI value. Selecting
 *   NarraFork and still shipping `originator: codex-tui` is exactly the bug
 *   users reported: dumps and relays key off originator first, so a UA-only
 *   override still looked like codex-tui on the wire.
 * - session-id / thread-id: one stable conversation id
 * - x-client-request-id: same value as thread-id. codex-rs sends it on every
 *   HTTP `/responses` request (codex-api/src/endpoint/responses.rs inserts it
 *   alongside build_session_headers) and on the websocket handshake
 *   (build_websocket_headers); only `/responses/compact` omits it. The WS
 *   transport sets the same value itself, so this projection is a no-op there
 *   and covers the HTTP path.
 * - x-codex-window-id: window UUID derived from the conversation id
 */
export function buildCodexEmulationHeaders(opts: {
	/**
	 * Presence of a non-empty id is what opts the caller into the Codex header
	 * set (see resolveClientFingerprint). The value itself is intentionally NOT
	 * emitted as a header — official `/responses` carries it only in body
	 * `client_metadata`.
	 */
	installationId: string;
	conversationId?: string;
	/** When "narrafork", originator presents as NarraFork instead of codex-tui. */
	userAgentMode?: UserAgentMode;
}): Record<string, string> {
	const headers: Record<string, string> = {
		originator: originatorForUserAgentMode(opts.userAgentMode),
	};
	if (opts.conversationId) {
		headers["session-id"] = opts.conversationId;
		headers["thread-id"] = opts.conversationId;
		headers["x-client-request-id"] = opts.conversationId;
		headers["x-codex-window-id"] = deriveCodexWindowId(opts.conversationId);
	}
	return headers;
}

/** Per-provider User-Agent selection mode. */
export type UserAgentMode = "narrafork" | "claude-code" | "codex" | "custom";

/**
 * Resolve the Codex protocol `originator` header for a User-Agent mode.
 *
 * Only the explicit "narrafork" choice opts out of the managed Codex identity.
 * "codex", "claude-code", "custom", and unset keep `codex-tui`: those modes
 * either intend Codex presentation or leave protocol headers to extraHeaders,
 * and inventing a third originator for them would match no real client.
 */
export function originatorForUserAgentMode(mode?: UserAgentMode): string {
	return mode === "narrafork" ? ORIGINATOR : ORIGINATOR_CODEX;
}

/**
 * Resolve the effective HTTP User-Agent for a provider request.
 *
 * When `mode` is unset the caller's `fallback` is used, preserving the previous
 * per-provider default (e.g. Claude CLI UA for official Anthropic, narrafork UA
 * otherwise). "custom" falls back when the custom string is blank.
 */
export function resolveHttpUserAgent(options: {
	mode?: UserAgentMode;
	custom?: string;
	fallback: string;
}): string {
	const { mode, custom, fallback } = options;
	switch (mode) {
		case "narrafork":
			return getHttpUserAgent();
		case "claude-code":
			return getHttpClaudeCliUserAgent();
		case "codex":
			return getHttpCodexUserAgent();
		case "custom": {
			const trimmed = custom?.trim();
			return trimmed ? sanitizeUserAgent(trimmed) : fallback;
		}
		default:
			return fallback;
	}
}

interface UserAgentSelection {
	mode?: UserAgentMode;
	custom?: string;
	extraHeaders?: Record<string, string>;
}

/** Only a real operator choice pins UA. Blank custom/header values keep defaults.
 * selected is the already-resolved fingerprint value, avoiding duplicate OS lookup. */
export function resolveExplicitUserAgent(
	options: UserAgentSelection,
	selected?: string,
): string | undefined {
	let extra: string | undefined;
	for (const [name, value] of Object.entries(options.extraHeaders ?? {})) {
		if (name.toLowerCase() === "user-agent" && typeof value === "string" && value.trim())
			extra = value.trim();
	}
	if (extra !== undefined) return sanitizeUserAgent(extra);
	if (!options.mode || (options.mode === "custom" && !options.custom?.trim())) return undefined;
	if (
		options.mode !== "custom" &&
		options.mode !== "narrafork" &&
		options.mode !== "codex" &&
		options.mode !== "claude-code"
	)
		return undefined;
	return sanitizeUserAgent(selected ?? resolveHttpUserAgent({ ...options, fallback: "" }));
}

/** Apply after dynamic defaults; all other headers retain their existing priority. */
export function applyExplicitUserAgent(
	headers: Record<string, string>,
	selection: UserAgentSelection,
	userAgentKey: string,
	selected?: string,
): void {
	const explicit = resolveExplicitUserAgent(selection, selected);
	if (explicit !== undefined)
		mergeExtraHeaders(headers, { [userAgentKey]: explicit }, userAgentKey);
}

/**
 * Resolve the effective client fingerprint (User-Agent + request headers) for a
 * provider request.
 *
 * Header precedence (later wins):
 *   1. Codex client headers — emitted whenever `installationId` is supplied.
 *   2. User-configured non-empty `extraHeaders` override defaults without
 *      case-sensitive duplicates. Empty values leave the default unchanged.
 *
 * Passing `installationId` is what opts a caller into the Codex header set, so
 * non-codex providers never leak codex-specific identifiers.
 *
 * The one header `extraHeaders` may not set is the responses-lite opt-in: it is a
 * body contract, not an identity string, and NarraFork emits the non-lite body.
 */
export function resolveClientFingerprint(options: {
	mode?: UserAgentMode;
	custom?: string;
	fallback: string;
	extraHeaders?: Record<string, string>;
	installationId?: string;
	conversationId?: string;
}): { userAgent: string; headers: Record<string, string> } {
	const userAgent = resolveHttpUserAgent({
		mode: options.mode,
		custom: options.custom,
		fallback: options.fallback,
	});

	const headers: Record<string, string> = {};
	if (options.installationId) {
		Object.assign(
			headers,
			buildCodexEmulationHeaders({
				installationId: options.installationId,
				conversationId: options.conversationId,
				userAgentMode: options.mode,
			}),
		);
	}
	// `"User-Agent"` is the casing openai-provider writes its own UA with, so an
	// operator override replaces that key instead of adding a second one.
	mergeExtraHeaders(headers, options.extraHeaders, "User-Agent");
	stripResponsesLiteHeader(headers);
	return { userAgent: headers["User-Agent"] ?? userAgent, headers };
}
