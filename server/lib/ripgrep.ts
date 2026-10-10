import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { downloadHelperBinary, getVerifiedCachedHelperBinaryPath } from "./helper-binaries";
import { getCliHelperSpec, isNativeCliHelper } from "./helper-binary-platform";
import { createDistributionContext, withDeadline } from "./helper-distribution-runtime";
import { logger } from "./logger";
import { IS_WINDOWS } from "./platform";

export const RG_INSTALL_HINT = IS_WINDOWS
	? "ripgrep (rg) is not installed. Install it with:\n\n  winget install BurntSushi.ripgrep.MSVC\n\nThen retry the Grep tool."
	: "ripgrep (rg) is not installed. Install it with your package manager, e.g.:\n\n  # macOS\n  brew install ripgrep\n\n  # Ubuntu/Debian\n  sudo apt install ripgrep\n\nThen retry the Grep tool.";

/**
 * Notice prepended to Grep results when ripgrep was unavailable and the search
 * fell back to the system `grep`. Explains the capability gap so the model does
 * not over-trust the result (grep uses POSIX ERE, has no .gitignore awareness,
 * and ignores rg-only options like multiline / --type).
 */
export const RG_FALLBACK_NOTE =
	"Note: ripgrep (rg) is not installed — fell back to the system `grep`. Behavior differs: pattern is treated as POSIX extended regex (grep -E), so rg-only escapes like \\d and \\b may not work; the multiline and type filters are ignored; and .gitignore/hidden-file rules are not applied. Install ripgrep for full fidelity.";

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
				if (existsSync(candidate) && isNativeCliHelper(candidate)) return candidate;
			}
		}
	} catch {
		// Directory doesn't exist or not readable.
	}
	return undefined;
}

function getRipgrepHelperSpec() {
	return getCliHelperSpec("rg");
}

// Managed binaries require asynchronous digest verification before execution.
function findCachedRg(): null {
	return null;
}

/** Resolve the ripgrep binary path synchronously, without downloading. */
export function findRgSync(): string | null {
	const pathCandidate = Bun.which("rg");
	if (pathCandidate && isNativeCliHelper(pathCandidate)) return pathCandidate;
	if (IS_WINDOWS) {
		// 1. Static well-known paths (scoop, chocolatey, cargo, Program Files).
		const winPaths = [
			`${process.env.USERPROFILE ?? ""}\\scoop\\shims\\rg.exe`,
			`${process.env.ProgramData ?? "C:\\ProgramData"}\\chocolatey\\bin\\rg.exe`,
			`${process.env.ProgramFiles ?? "C:\\Program Files"}\\ripgrep\\rg.exe`,
			`${process.env.USERPROFILE ?? ""}\\.cargo\\bin\\rg.exe`,
		];
		for (const p of winPaths) {
			if (p && existsSync(p) && isNativeCliHelper(p)) return p;
		}

		// 2. WinGet packages (dynamic folder name).
		const winget = findRgInWinGet();
		if (winget) return winget;

		// 3. Ask the OS to find it on PATH.
		const which = Bun.which("rg");
		if (which && isNativeCliHelper(which)) return which;

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
	if (which && isNativeCliHelper(which)) return which;

	return findCachedRg();
}

let resolvedRgPath = findRgSync();

/** Whether ripgrep is already available without an async download attempt. */
export const isRgAvailable = resolvedRgPath !== null;

async function verifyRg(path: string, signal?: AbortSignal): Promise<boolean> {
	signal?.throwIfAborted();
	try {
		const result = Bun.spawn([path, "--version"], {
			stdout: "ignore",
			stderr: "ignore",
			timeout: 5_000,
			killSignal: "SIGKILL",
			signal,
		});
		const exitCode = await result.exited;
		signal?.throwIfAborted();
		return exitCode === 0;
	} catch {
		signal?.throwIfAborted();
		return false;
	}
}

async function prepareRipgrep(signal?: AbortSignal): Promise<string | null> {
	signal?.throwIfAborted();
	const current = findRgSync();
	if (current) {
		resolvedRgPath = current;
		return current;
	}

	const spec = getRipgrepHelperSpec();
	if (!spec) return null;
	// Cache lookup, download and the final probe are one operation: never recapture
	// a newly selected server/proxy when the old source's cache lookup returns null.
	const context = createDistributionContext();
	const deadline = withDeadline(signal, 60_000);
	const stillCurrent = () => {
		deadline.signal.throwIfAborted();
		return context.isCurrent();
	};
	try {
		const cached = await getVerifiedCachedHelperBinaryPath(spec, {
			context,
			signal: deadline.signal,
		});
		if (!stillCurrent()) return null;
		if (cached && (await verifyRg(cached, deadline.signal))) {
			return stillCurrent() ? cached : null;
		}
		if (!stillCurrent()) return null;
		const allowUnsignedDownload = process.env.NARRAFORK_ALLOW_UNSIGNED_HELPER_DOWNLOADS === "1";
		const downloaded = await downloadHelperBinary(spec, {
			context,
			signal: deadline.signal,
			useCache: false,
			allowUnsignedDownload,
		});
		if (!stillCurrent() || !downloaded) return null;
		if (!(await verifyRg(downloaded, deadline.signal))) {
			logger.warn("Prepared ripgrep binary failed version check", { path: downloaded });
			return null;
		}
		return stillCurrent() ? downloaded : null;
	} finally {
		deadline.dispose();
	}
}

/** Resolve ripgrep, optionally downloading a NarraFork-managed helper binary when explicitly enabled. */
export async function resolveRgPath(signal?: AbortSignal): Promise<string | null> {
	signal?.throwIfAborted();
	if (resolvedRgPath && existsSync(resolvedRgPath)) return resolvedRgPath;

	const current = findRgSync();
	if (current) {
		resolvedRgPath = current;
		return current;
	}

	return prepareRipgrep(signal);
}

export function getRgVersionSync(path = findRgSync()): string | undefined {
	if (!path) return undefined;
	try {
		const result = Bun.spawnSync([path, "--version"], {
			stdout: "pipe",
			stderr: "pipe",
			timeout: 1_000,
			killSignal: "SIGKILL",
			maxBuffer: 32 * 1024,
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
			? "ripgrep (rg) not found — the Grep tool will fall back to the system grep (degraded capability). Install rg for full fidelity: winget install BurntSushi.ripgrep.MSVC"
			: "ripgrep (rg) not found — the Grep tool will fall back to the system grep (degraded capability). Install rg for full fidelity (e.g. brew install ripgrep, apt install ripgrep).",
	);
}
