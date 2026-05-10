/**
 * Dependency detection & installation service.
 *
 * Checks whether required / optional system tools (git, rg, dtach) are
 * available, reports per-platform install commands, and can attempt
 * one-click installation via the detected package manager.
 */

import { execSync } from "node:child_process";
import { IS_MACOS, IS_WINDOWS } from "../lib/platform";
import { findRgSync, getRgVersionSync } from "../lib/ripgrep";
import { safeSpawn } from "../lib/spawn";
import { refreshWindowsPath } from "../lib/win-env";

// ── Types ────────────────────────────────────────────────────────────────────

export interface DependencyInfo {
	name: string;
	required: boolean;
	installed: boolean;
	version?: string;
	platformSupported: boolean;
	installCommands: Record<string, string>;
}

export interface DependencyCheckResult {
	platform: "windows" | "macos" | "linux";
	packageManager?: string;
	dependencies: DependencyInfo[];
	allRequiredMet: boolean;
}

// ── Install command matrix ───────────────────────────────────────────────────

const INSTALL_COMMANDS: Record<string, Record<string, string>> = {
	git: {
		apt: "sudo apt-get update && sudo apt-get install -y git",
		dnf: "sudo dnf install -y git",
		pacman: "sudo pacman -S --noconfirm git",
		zypper: "sudo zypper install -y git",
		apk: "sudo apk add git",
		brew: "brew install git",
		winget: "winget install -e --id Git.Git",
		scoop: "scoop install git",
		choco: "choco install git -y",
	},
	rg: {
		apt: "sudo apt-get update && sudo apt-get install -y ripgrep",
		dnf: "sudo dnf install -y ripgrep",
		pacman: "sudo pacman -S --noconfirm ripgrep",
		zypper: "sudo zypper install -y ripgrep",
		apk: "sudo apk add ripgrep",
		brew: "brew install ripgrep",
		winget: "winget install BurntSushi.ripgrep.MSVC",
		scoop: "scoop install ripgrep",
		choco: "choco install ripgrep -y",
	},
	dtach: {
		apt: "sudo apt-get update && sudo apt-get install -y dtach",
		dnf: "sudo dnf install -y dtach",
		pacman: "sudo pacman -S --noconfirm dtach",
		zypper: "sudo zypper install -y dtach",
		apk: "sudo apk add dtach",
		brew: "brew install dtach",
	},
};

// ── Package-manager detection ────────────────────────────────────────────────

/**
 * Check if a command exists on Windows.
 * `Bun.which()` can fail for UWP app execution aliases (e.g. winget) because
 * they are zero-byte reparse-point files in WindowsApps. Fall back to `where`
 * which resolves them correctly.
 */
function winWhich(name: string): boolean {
	if (Bun.which(name)) return true;
	try {
		const result = execSync(`where ${name}`, { encoding: "utf-8", stdio: "pipe", timeout: 5000 });
		return result.trim().length > 0;
	} catch {
		return false;
	}
}

function detectPackageManager(): string | undefined {
	if (IS_WINDOWS) {
		for (const pm of ["winget", "scoop", "choco"]) {
			if (winWhich(pm)) return pm;
		}
		return undefined;
	}
	if (IS_MACOS) {
		if (Bun.which("brew")) return "brew";
		if (Bun.which("port")) return "port";
		return undefined;
	}
	// Linux
	for (const pm of ["apt-get", "dnf", "pacman", "zypper", "apk"]) {
		if (Bun.which(pm)) return pm === "apt-get" ? "apt" : pm;
	}
	return undefined;
}

// ── Individual checks ────────────────────────────────────────────────────────

function execQuiet(cmd: string): string | null {
	try {
		return execSync(cmd, { encoding: "utf-8", stdio: "pipe", timeout: 5000 }).trim();
	} catch {
		return null;
	}
}

function checkGit(): DependencyInfo {
	const path = Bun.which("git");
	let version: string | undefined;
	if (path) {
		const out = execQuiet("git --version");
		// "git version 2.43.0"
		version = out?.match(/git version ([\d.]+)/)?.[1] ?? out ?? undefined;
	}
	return {
		name: "git",
		required: true,
		installed: !!path,
		version,
		platformSupported: true,
		installCommands: INSTALL_COMMANDS.git,
	};
}

function checkRg(): DependencyInfo {
	const path = findRgSync();
	const version = getRgVersionSync(path);
	return {
		name: "rg",
		required: false,
		installed: !!path,
		version,
		platformSupported: true,
		installCommands: INSTALL_COMMANDS.rg,
	};
}

function checkDtach(): DependencyInfo {
	if (IS_WINDOWS) {
		return {
			name: "dtach",
			required: false,
			installed: false,
			platformSupported: false,
			installCommands: {},
		};
	}
	const path = Bun.which("dtach");
	return {
		name: "dtach",
		required: false,
		installed: !!path,
		platformSupported: true,
		installCommands: INSTALL_COMMANDS.dtach,
	};
}

// ── Public API ───────────────────────────────────────────────────────────────

function getPlatform(): "windows" | "macos" | "linux" {
	if (IS_WINDOWS) return "windows";
	if (IS_MACOS) return "macos";
	return "linux";
}

function checkByName(name: string): DependencyInfo {
	const checkers: Record<string, () => DependencyInfo> = {
		git: checkGit,
		rg: checkRg,
		dtach: checkDtach,
	};
	return (
		checkers[name]?.() ?? {
			name,
			required: false,
			installed: false,
			platformSupported: false,
			installCommands: {},
		}
	);
}

function checkAll(): DependencyCheckResult {
	let deps = [checkGit(), checkRg(), checkDtach()];
	let pm = detectPackageManager();
	// On Windows the inherited PATH may be stale — if any tool or the package
	// manager is missing, refresh PATH from the registry and re-detect.
	if (IS_WINDOWS && (deps.some((d) => !d.installed) || !pm)) {
		if (refreshWindowsPath()) {
			deps = deps.map((d) => (d.installed ? d : checkByName(d.name)));
			if (!pm) pm = detectPackageManager();
		}
	}
	return {
		platform: getPlatform(),
		packageManager: pm,
		dependencies: deps,
		allRequiredMet: deps.filter((d) => d.required).every((d) => d.installed),
	};
}

async function install(
	name: string,
): Promise<{ ok: boolean; error?: string; dependency?: DependencyInfo }> {
	const commands = INSTALL_COMMANDS[name];
	if (!commands) {
		return { ok: false, error: `Unknown dependency: ${name}` };
	}

	let pm = detectPackageManager();
	// On Windows, try refreshing PATH if no package manager found
	if (!pm && IS_WINDOWS) {
		refreshWindowsPath();
		pm = detectPackageManager();
	}
	if (!pm || !commands[pm]) {
		return {
			ok: false,
			error: `No install command available for package manager: ${pm ?? "none"}`,
		};
	}

	const cmd = commands[pm];
	const shell = IS_WINDOWS ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];

	const result = await safeSpawn({ cmd: shell, env: process.env as Record<string, string> });

	if (result.exitCode !== 0) {
		return { ok: false, error: (result.stderr || result.stdout).trim().slice(0, 500) };
	}

	// Re-check the dependency after installation
	const checkers: Record<string, () => DependencyInfo> = {
		git: checkGit,
		rg: checkRg,
		dtach: checkDtach,
	};
	const dep = checkers[name]?.();
	return { ok: true, dependency: dep };
}

export const dependencyService = { checkAll, install };
