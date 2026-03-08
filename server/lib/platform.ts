/**
 * Cross-platform helpers.
 *
 * Centralises every platform-specific constant / utility so the rest of the
 * codebase never has to scatter `process.platform === "win32"` checks or
 * hard-code Unix paths like `/dev/null`, `/tmp`, `/root`.
 */

import { homedir } from "node:os";

// ── Platform flags ──────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

// ── Path / env helpers ──────────────────────────────────────────────────────

/** Cross-platform `/dev/null` equivalent. */
export const DEV_NULL = IS_WINDOWS ? "NUL" : "/dev/null";

/**
 * Return the current user's home directory.
 *
 * Uses `os.homedir()` which already handles `USERPROFILE` on Windows and
 * `$HOME` on Unix, so callers should never read `process.env.HOME` directly.
 */
export function getHome(): string {
	return homedir();
}

// ── Capability queries ──────────────────────────────────────────────────────

/** Whether the platform can run dtach (Unix-socket based session persistence). */
export function supportsDtach(): boolean {
	return !IS_WINDOWS;
}

/** Whether the platform can run Podman containers (rootless Linux only). */
export function supportsContainers(): boolean {
	return IS_LINUX;
}

// ── WSL flag ─────────────────────────────────────────────────────────────────

/**
 * Whether WSL (Windows Subsystem for Linux) is allowed.
 *
 * Controlled by the `--wsl=true|false` CLI flag. Defaults to `false`.
 * When false, the shell detector will reject WSL bash and the system prompt
 * will instruct the AI not to suggest WSL migration.
 */
let _allowWsl = false;

/** Initialise the WSL flag from CLI args. Call once at startup. */
export function initWslFlag(): void {
	const arg = process.argv.find((a) => a.startsWith("--wsl="));
	if (arg) {
		_allowWsl = arg.split("=")[1]?.toLowerCase() === "true";
	}
}

/** Whether WSL usage is permitted (default: false). */
export function isWslAllowed(): boolean {
	return _allowWsl;
}
