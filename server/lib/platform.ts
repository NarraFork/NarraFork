/**
 * Cross-platform helpers.
 *
 * Centralises every platform-specific constant / utility so the rest of the
 * codebase never has to scatter `process.platform === "win32"` checks or
 * hard-code Unix paths like `/dev/null`, `/tmp`, `/root`.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";

// ── Platform flags ──────────────────────────────────────────────────────────

export const IS_WINDOWS = process.platform === "win32";
export const IS_MACOS = process.platform === "darwin";
export const IS_LINUX = process.platform === "linux";

const TRUE_VALUES = new Set(["1", "true", "yes", "on"]);

function envFlag(name: string): boolean {
	const value = process.env[name];
	return value !== undefined && TRUE_VALUES.has(value.toLowerCase());
}

function pathLooksLikeTermux(path: string | undefined): boolean {
	return !!path && path.includes("/com.termux/");
}

function fileIncludes(path: string, pattern: RegExp): boolean {
	try {
		return pattern.test(readFileSync(path, "utf-8"));
	} catch {
		return false;
	}
}

function detectAndroidRuntime(): boolean {
	if (!IS_LINUX) return false;
	if (envFlag("NARRAFORK_ANDROID")) return true;
	if (process.env.TERMUX_VERSION || process.env.TERMUX_APP__PACKAGE_NAME) return true;
	if (pathLooksLikeTermux(process.env.PREFIX) || pathLooksLikeTermux(process.env.HOME)) return true;
	if (process.env.ANDROID_ROOT && process.env.ANDROID_DATA && existsSync("/system/bin")) {
		return true;
	}
	return fileIncludes("/proc/version", /android/i);
}

function detectProotRuntime(): boolean {
	if (!IS_LINUX) return false;
	if (envFlag("NARRAFORK_PROOT")) return true;
	if (process.env.PROOT_TMP_DIR || process.env.PROOT_NO_SECCOMP) return true;
	return fileIncludes("/proc/self/status", /TracerPid:\s*[1-9]/);
}

export const IS_ANDROID = detectAndroidRuntime();
export const IS_PROOT = detectProotRuntime();

export interface RuntimeEnvironmentInfo {
	android: boolean;
	proot: boolean;
	termux: boolean;
	containerSupport: boolean;
	containerUnsupportedReason?: string;
}

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

/** Human-readable reason for disabling local container management, if disabled. */
export function getContainerUnsupportedReason(): string | undefined {
	if (!IS_LINUX) return "Container management is only supported on Linux";
	if (IS_ANDROID || IS_PROOT) {
		return "Local Podman containers are not supported in Android/proot environments; use a remote container host instead.";
	}
	return undefined;
}

/** Whether the platform can run Podman containers (rootless Linux only, not proot). */
export function supportsContainers(): boolean {
	return getContainerUnsupportedReason() === undefined;
}

/** Runtime facts exposed to the frontend and setup scripts. */
export function getRuntimeEnvironment(): RuntimeEnvironmentInfo {
	const containerUnsupportedReason = getContainerUnsupportedReason();
	return {
		android: IS_ANDROID,
		proot: IS_PROOT,
		termux: !!(
			process.env.TERMUX_VERSION ||
			process.env.TERMUX_APP__PACKAGE_NAME ||
			pathLooksLikeTermux(process.env.PREFIX) ||
			pathLooksLikeTermux(process.env.HOME)
		),
		containerSupport: containerUnsupportedReason === undefined,
		...(containerUnsupportedReason && { containerUnsupportedReason }),
	};
}

// ── WSL flag ─────────────────────────────────────────────────────────────────

/**
 * Whether WSL (Windows Subsystem for Linux) is allowed.
 *
 * Controlled by the `--wsl=true|false` CLI flag. Defaults to `false`.
 * When false, the shell detector will reject WSL bash (System32/SysWOW64)
 * so agent commands run through Git Bash / PowerShell instead. This does not
 * restrict the model from mentioning or invoking `wsl.exe` when the user asks
 * for it — choosing the default shell is a runtime decision, not a prompt rule.
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
