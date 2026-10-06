/**
 * Dependency detection & installation service.
 *
 * Checks whether required / optional system tools (git, rg, dtach) are
 * available, reports per-platform install commands, and can attempt
 * one-click installation via the detected package manager.
 */

import { execSync } from "node:child_process";
import { getRuntimeEnvironment, IS_ANDROID, IS_MACOS, IS_WINDOWS } from "../lib/platform";
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
	runtimeEnvironment: ReturnType<typeof getRuntimeEnvironment>;
	dependencies: DependencyInfo[];
	allRequiredMet: boolean;
}

/**
 * Ceiling for a one-click install. Generous because a package index refresh on a
 * slow link legitimately takes minutes, but finite: the realistic hang is a
 * network stall against a mirror, and a package manager without a `-y`-style flag
 * (`apk add`, `brew install`, `pkg install`, winget/scoop) can also sit waiting on
 * a `/dev/null` stdin forever. Either way an unbounded install never returns an
 * answer at all, so a timeout is what turns it into a reportable failure.
 */
const INSTALL_TIMEOUT_MS = 10 * 60_000;

// ── Install command matrix ───────────────────────────────────────────────────

const INSTALL_COMMANDS: Record<string, Record<string, string>> = {
	git: {
		termux: "pkg install git",
		"apt-root": "apt-get update && apt-get install -y git",
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
		termux: "pkg install ripgrep",
		"apt-root": "apt-get update && apt-get install -y ripgrep",
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
		termux: "pkg install dtach",
		"apt-root": "apt-get update && apt-get install -y dtach",
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
	// Android/Termux host package manager.
	if (IS_ANDROID && Bun.which("pkg")) return "termux";
	// Linux rootfs (common in proot-distro): sudo is often unavailable because the
	// guest shell already runs as root via proot UID/GID remapping.
	if (process.getuid?.() === 0 && Bun.which("apt-get")) return "apt-root";
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
		runtimeEnvironment: getRuntimeEnvironment(),
		dependencies: deps,
		allRequiredMet: deps.filter((d) => d.required).every((d) => d.installed),
	};
}

/**
 * Everything the sudo gate needs to know about one command on this host.
 *
 * The reasoning behind each field lives on `needsUnavailableSudoPassword`, which
 * is what gathers them; this is only the shape they are handed over in.
 */
export interface SudoAvailability {
	/** Whether the command text invokes sudo at all. */
	usesSudo: boolean;
	/** Whether a `SUDO_ASKPASS` helper is configured. */
	hasAskpass: boolean;
	/**
	 * Whether sudo currently runs without a password (NOPASSWD or a live
	 * timestamp), i.e. `sudo -n true` succeeded. `null` when sudo is absent or
	 * could not be probed.
	 */
	passwordlessSudo: boolean | null;
	/** Windows has no sudo/tty problem here. */
	isWindows: boolean;
}

/** `sudo` as a command word, not as a substring of e.g. `sudoku` or a path. */
const SUDO_WORD_RE = /(^|[\s;&|])sudo(\s|$)/;

/**
 * Pure decision half of the sudo gate, separated so it can be tested on any
 * machine. The runtime probe result is an input rather than something this reads,
 * because the answer differs per host: a NOPASSWD box (like most CI) can never
 * exercise the blocking branch, and a box that prompts can never exercise the
 * allowing branch.
 */
export function decideSudoPasswordBlocked(info: SudoAvailability): boolean {
	if (info.isWindows) return false;
	if (!info.usesSudo) return false;
	// An askpass helper lets sudo obtain the password without a tty.
	if (info.hasAskpass) return false;
	// Absent/unprobeable sudo (null) cannot work either way.
	return info.passwordlessSudo !== true;
}

/**
 * Whether a command would need a sudo password we cannot supply.
 *
 * `install()` runs through `safeSpawn`, which gives the child `/dev/null` on
 * stdin and no controlling terminal. sudo does not read the password from stdin
 * anyway — it opens `/dev/tty` — so on a machine where sudo prompts, a one-click
 * install cannot possibly succeed: it fails with "no tty present and no askpass
 * program specified", which tells the user nothing about what to do next.
 *
 * `sudo -n` ("non-interactive") is the authoritative test and is safe to run:
 * it never prompts and never blocks; it exits non-zero when a password would be
 * required. It deliberately does NOT clear the sudo timestamp the way `sudo -k`
 * would, so probing does not log the user out of sudo.
 *
 * A configured `SUDO_ASKPASS` is honoured: sudo can then obtain the password
 * through a helper without a tty, so such a command is left alone.
 */
function needsUnavailableSudoPassword(cmd: string): boolean {
	const usesSudo = SUDO_WORD_RE.test(cmd);
	let passwordlessSudo: boolean | null = null;
	// Only probe when it can change the answer — no stray sudo calls otherwise.
	if (!IS_WINDOWS && usesSudo && !process.env.SUDO_ASKPASS) {
		try {
			// -n: fail rather than prompt. exitCode 0 means sudo is currently usable
			// without a password (NOPASSWD, or a live timestamp).
			const probe = Bun.spawnSync(["sudo", "-n", "true"], {
				stdout: "ignore",
				stderr: "ignore",
				stdin: "ignore",
			});
			passwordlessSudo = probe.exitCode === 0;
		} catch {
			passwordlessSudo = null;
		}
	}
	return decideSudoPasswordBlocked({
		usesSudo,
		hasAskpass: !!process.env.SUDO_ASKPASS,
		passwordlessSudo,
		isWindows: IS_WINDOWS,
	});
}

async function install(
	name: string,
): Promise<{ ok: boolean; code?: string; error?: string; dependency?: DependencyInfo }> {
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

	// Refuse before spawning rather than letting sudo fail with "no tty present
	// and no askpass program specified". The command is genuinely unrunnable
	// here, and the useful next step (run it in the interactive terminal, where
	// the password CAN be typed) is something only this code knows.
	if (needsUnavailableSudoPassword(cmd)) {
		return {
			ok: false,
			code: "SUDO_PASSWORD_REQUIRED",
			error:
				`This install needs a sudo password, which cannot be entered here. ` +
				`Use "Install in terminal" to run it interactively, or run it yourself: ${cmd}`,
		};
	}

	const shell = IS_WINDOWS ? ["cmd", "/c", cmd] : ["sh", "-c", cmd];

	// A stalled mirror, or a package manager that prompts because its command has
	// no -y/--noconfirm, shows up as a hang rather than an error — stdin here is
	// /dev/null, so nothing ever answers. A ceiling makes it reportable.
	const result = await safeSpawn({
		cmd: shell,
		env: process.env as Record<string, string>,
		timeout: INSTALL_TIMEOUT_MS,
	});

	if (result.exitCode !== 0) {
		const output = (result.stderr || result.stdout).trim().slice(0, 500);
		return { ok: false, error: output || `Install command failed: ${cmd}` };
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

/** Exposed for tests: the command-shape half of the sudo gate. */
export function commandUsesSudo(cmd: string): boolean {
	return SUDO_WORD_RE.test(cmd);
}

/** Exposed for tests so the shipped command matrix itself can be asserted on. */
export const INSTALL_COMMANDS_FOR_TESTS = INSTALL_COMMANDS;
