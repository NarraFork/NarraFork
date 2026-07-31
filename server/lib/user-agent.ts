import os from "node:os";
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
// Codex CLI version mimicked by the "codex" User-Agent mode.
// Matches the codex_cli_rs originator/version format. Update manually as needed.
// Bumped to 0.144.0 to satisfy gpt-5.6 family minimal_client_version gating.
const CODEX_CLI_VERSION = "0.144.0";

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
 * Build User-Agent string in Codex CLI format:
 * codex_cli_rs/{version} ({os_type} {os_version}; {arch}) {terminal_info}
 *
 * Mirrors the official Codex CLI `get_codex_user_agent()` output so requests
 * can present themselves as the Codex client. When no terminal is detected the
 * token falls back to "unknown", matching the real Codex CLI (it never reports a
 * runtime version here).
 *
 * Example: codex_cli_rs/0.144.0 (Linux Ubuntu 22.04; x64) unknown
 */
export function getCodexUserAgent(): string {
	const osType = getOsType();
	const osVersion = getOsVersion();
	const arch = getArchitecture();
	const terminalInfo = getTerminalInfo("unknown");

	return `codex_cli_rs/${CODEX_CLI_VERSION} (${osType} ${osVersion}; ${arch}) ${terminalInfo}`;
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

/** Originator token used by the real Codex CLI. */
export const ORIGINATOR_CODEX = "codex_cli_rs";

/**
 * Build the stable Codex-emulation headers, mirroring the real Codex CLI's
 * durable request headers while deliberately omitting tracking/semantic headers
 * (x-codex-turn-metadata, workspaces, sandbox, x-codex-window-id, ...).
 *
 * Included:
 * - originator: codex_cli_rs
 * - x-codex-installation-id: <persisted UUID>
 * - session-id / thread-id: weak per-conversation identifiers (only when a
 *   conversation id is available). These are not turn-level tracking headers.
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
 *   1. Codex emulation headers (only when `emulateCodex` is true).
 *   2. User-configured `extraHeaders` — always applied last so operators can
 *      override or clear any emulated header.
 *
 * Codex semantic headers are only injected when `emulateCodex` is true, so
 * non-codex providers never leak codex-specific identifiers unless explicitly
 * opted in.
 */
export function resolveClientFingerprint(options: {
	mode?: UserAgentMode;
	custom?: string;
	fallback: string;
	extraHeaders?: Record<string, string>;
	emulateCodex?: boolean;
	installationId?: string;
	conversationId?: string;
}): { userAgent: string; headers: Record<string, string> } {
	const userAgent = resolveHttpUserAgent({
		mode: options.mode,
		custom: options.custom,
		fallback: options.fallback,
	});

	const headers: Record<string, string> = {};
	if (options.emulateCodex && options.installationId) {
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
	return { userAgent, headers };
}
