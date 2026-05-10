import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
	downloadHelperBinary,
	getCachedHelperBinaryPath,
	type HelperBinarySpec,
} from "./helper-binaries";
import { logger } from "./logger";
import { IS_WINDOWS } from "./platform";

export const RG_INSTALL_HINT = IS_WINDOWS
	? "ripgrep (rg) is not installed. Install it with:\n\n  winget install BurntSushi.ripgrep.MSVC\n\nThen retry the Grep tool."
	: "ripgrep (rg) is not installed. Install it with your package manager, e.g.:\n\n  # macOS\n  brew install ripgrep\n\n  # Ubuntu/Debian\n  sudo apt install ripgrep\n\nThen retry the Grep tool.";

/**
 * Scan the WinGet packages directory for any ripgrep package folder.
 * The folder name contains a version-dependent hash (e.g.
 * `BurntSushi.ripgrep.MSVC_Microsoft.Winget.Source_8wekyb3d8bbwe`)
 * so we cannot hard-code it — instead we glob for `BurntSushi.ripgrep*`.
 */
function findRgInWinGet(): string | undefined {
	const localAppData = process.env.LOCALAPPDATA;
	if (!localAppData) return undefined;
	const packagesDir = join(localAppData, "Microsoft", "WinGet", "Packages");
	try {
		const entries = readdirSync(packagesDir);
		for (const entry of entries) {
			if (entry.toLowerCase().startsWith("burntsushi.ripgrep")) {
				const candidate = join(packagesDir, entry, "rg.exe");
				if (existsSync(candidate)) return candidate;
			}
		}
	} catch {
		// Directory doesn't exist or not readable.
	}
	return undefined;
}

function getRipgrepHelperSpec(): HelperBinarySpec | null {
	if (process.platform === "win32") {
		return { toolName: "rg-win64.exe", cachedName: "rg.exe", displayName: "ripgrep" };
	}
	if (process.platform === "linux" && process.arch === "arm64") {
		return { toolName: "rg-linux-arm64", cachedName: "rg", displayName: "ripgrep" };
	}
	if (process.platform === "linux") {
		return { toolName: "rg-linux-x64", cachedName: "rg", displayName: "ripgrep" };
	}
	if (process.platform === "darwin" && process.arch === "arm64") {
		return { toolName: "rg-darwin-arm64", cachedName: "rg", displayName: "ripgrep" };
	}
	if (process.platform === "darwin") {
		return { toolName: "rg-darwin-x64", cachedName: "rg", displayName: "ripgrep" };
	}
	return null;
}

function findCachedRg(): string | null {
	const spec = getRipgrepHelperSpec();
	const cached = spec ? getCachedHelperBinaryPath(spec.cachedName) : null;
	return cached && verifyRg(cached) ? cached : null;
}

/** Resolve the ripgrep binary path synchronously, without downloading. */
export function findRgSync(): string | null {
	if (IS_WINDOWS) {
		// 1. Static well-known paths (scoop, chocolatey, cargo, Program Files).
		const winPaths = [
			`${process.env.USERPROFILE ?? ""}\\scoop\\shims\\rg.exe`,
			`${process.env.ProgramData ?? "C:\\ProgramData"}\\chocolatey\\bin\\rg.exe`,
			`${process.env.ProgramFiles ?? "C:\\Program Files"}\\ripgrep\\rg.exe`,
			`${process.env.USERPROFILE ?? ""}\\.cargo\\bin\\rg.exe`,
		];
		for (const p of winPaths) {
			if (p && existsSync(p)) return p;
		}

		// 2. WinGet packages (dynamic folder name).
		const winget = findRgInWinGet();
		if (winget) return winget;

		// 3. Ask the OS to find it on PATH.
		const which = Bun.which("rg");
		if (which) return which;

		// 4. Use NarraFork-managed helper binary if already cached.
		return findCachedRg();
	}

	const systemPaths = [
		"/usr/bin/rg",
		"/usr/local/bin/rg",
		"/opt/homebrew/bin/rg",
		"/home/linuxbrew/.linuxbrew/bin/rg",
	];
	for (const p of systemPaths) {
		if (existsSync(p)) return p;
	}

	const which = Bun.which("rg");
	if (which) return which;

	return findCachedRg();
}

let resolvedRgPath = findRgSync();
let preparePromise: Promise<string | null> | null = null;

/** Whether ripgrep is already available without an async download attempt. */
export const isRgAvailable = resolvedRgPath !== null;

function verifyRg(path: string): boolean {
	try {
		const result = Bun.spawnSync([path, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		return result.exitCode === 0;
	} catch {
		return false;
	}
}

async function prepareRipgrep(): Promise<string | null> {
	const current = findRgSync();
	if (current) {
		resolvedRgPath = current;
		return current;
	}

	const spec = getRipgrepHelperSpec();
	if (!spec) return null;
	const allowUnsignedDownload = process.env.NARRAFORK_ALLOW_UNSIGNED_HELPER_DOWNLOADS === "1";
	if (!spec.expectedSha256 && !allowUnsignedDownload) return null;

	const downloaded = await downloadHelperBinary(spec, {
		useCache: false,
		allowUnsignedDownload,
	});
	if (!downloaded) return null;
	if (!verifyRg(downloaded)) {
		logger.warn("Prepared ripgrep binary failed version check", { path: downloaded });
		return null;
	}

	resolvedRgPath = downloaded;
	return downloaded;
}

/** Resolve ripgrep, optionally downloading a NarraFork-managed helper binary when explicitly enabled. */
export async function resolveRgPath(): Promise<string | null> {
	if (resolvedRgPath && existsSync(resolvedRgPath)) return resolvedRgPath;

	const current = findRgSync();
	if (current) {
		resolvedRgPath = current;
		return current;
	}

	preparePromise ??= prepareRipgrep();
	try {
		return await preparePromise;
	} finally {
		preparePromise = null;
	}
}

export function getRgVersionSync(path = findRgSync()): string | undefined {
	if (!path) return undefined;
	try {
		const result = Bun.spawnSync([path, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return undefined;
		const out = new TextDecoder().decode(result.stdout).trim();
		return out.match(/ripgrep ([\d.]+)/)?.[1] ?? undefined;
	} catch {
		return undefined;
	}
}

if (!resolvedRgPath) {
	logger.warn(
		IS_WINDOWS
			? "ripgrep (rg) not found — install with: winget install BurntSushi.ripgrep.MSVC"
			: "ripgrep (rg) not found — install via package manager (e.g. brew install ripgrep, apt install ripgrep).",
	);
}
