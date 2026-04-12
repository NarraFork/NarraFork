import os from "node:os";
import { APP_VERSION } from "./version";

const ORIGINATOR = "narrafork";

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
 */
function getTerminalInfo(): string {
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

	// Default to Bun runtime info
	return `Bun/${Bun.version}`;
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
	const terminalInfo = getTerminalInfo();

	return `${ORIGINATOR}/${APP_VERSION} (${osType} ${osVersion}; ${arch}) ${terminalInfo}`;
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
