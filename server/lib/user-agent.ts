import os from "node:os";
import { deriveCodexWindowId } from "./agent/codex-request";
import { APP_VERSION } from "./version";

const ORIGINATOR = "narrafork";
/**
 * Claude Code CLI version mimicked by the "claude-code" User-Agent mode.
 *
 * Must stay in sync with the `cc_version` reported in the Anthropic billing
 * block (see CC_CLI_VERSION in agent/anthropic-provider.ts): a request whose
 * User-Agent and billing block disagree does not match any real CLI release.
 */
export const CLAUDE_CLI_VERSION = "2.1.220";
// Managed Codex client version used only for outbound protocol emulation.
// Keep the User-Agent prefix/suffix and originator aligned when updating it.
const CODEX_CLI_VERSION = "0.146.0";
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
 * Sanitize User-Agent string to ensure it's a valid HTTP header value.
 * Replaces invalid characters with underscores.
 */
export function sanitizeUserAgent(userAgent: string): string {
	// HTTP header values must be ASCII printable characters (0x20-0x7E)
	return userAgent.replace(/[^\x20-\x7E]/g, "_");
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
 * simultaneously (a) sends the header, (b) omits top-level `instructions` and
 * `tools` entirely, (c) splices an `additional_tools` item plus a developer
 * instructions message to the front of `input`, and (d) forces
 * `parallel_tool_calls: false`. Upstream validates the pairing and rejects the
 * header whenever `tools` carries anything but function/custom/client-executed
 * search tools:
 *
 *   "X-OpenAI-Internal-Codex-Responses-Lite only supports function tools,
 *    custom tools, and client-executed tool search."
 *
 * NarraFork emits the classic non-lite body (top-level instructions + tools,
 * including the hosted `web_search`/`image_generation` tools), so claiming lite
 * produced a request no real client emits and hard-failed any endpoint that
 * enforces the pairing. Non-lite is the universally accepted shape and is what
 * real Codex sends for every model whose catalog entry leaves the flag false, so
 * the header is dropped rather than the tools. {@link stripResponsesLiteHeader}
 * enforces this on every outbound header map, and the codex parity tests pin it.
 *
 * Included:
 * - originator: codex-tui
 * - x-codex-installation-id: <persisted UUID>
 * - session-id / thread-id / x-client-request-id: one stable conversation id
 * - x-codex-window-id: window UUID derived from the conversation id
 */
export function buildCodexEmulationHeaders(opts: {
	installationId: string;
	conversationId?: string;
}): Record<string, string> {
	const headers: Record<string, string> = {
		originator: ORIGINATOR_CODEX,
		"x-codex-installation-id": opts.installationId,
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

/**
 * Resolve the effective client fingerprint (User-Agent + request headers) for a
 * provider request.
 *
 * Header precedence (later wins):
 *   1. Codex client headers — emitted whenever `installationId` is supplied.
 *   2. User-configured `extraHeaders` — always applied last so operators can
 *      override or clear any emitted header.
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
			}),
		);
	}
	for (const [key, value] of Object.entries(options.extraHeaders ?? {})) {
		if (value) headers[key] = value;
	}
	stripResponsesLiteHeader(headers);
	return { userAgent, headers };
}
