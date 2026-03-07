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
