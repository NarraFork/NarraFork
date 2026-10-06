/**
 * Windows environment variable refresh.
 *
 * On Windows, child processes inherit PATH from their parent at launch time.
 * If the user installs a tool (e.g. git) after NarraFork is already running,
 * the registry PATH is updated but `process.env.PATH` still holds the stale
 * value — even across NarraFork restarts (because the parent shell / Explorer
 * also has the old PATH).
 *
 * This module reads the *current* system + user PATH directly from the Windows
 * registry and patches `process.env.PATH` so that subsequent `Bun.spawnSync`,
 * `Bun.which`, etc. can find newly-installed executables without a full reboot.
 */

import { IS_WINDOWS } from "./platform";

const MAX_ENV_EXPANSION_PASSES = 16;
const WINDOWS_ENV_REFERENCE = /%([^%]+)%/g;
const SYSTEM_ENV_KEY = "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment";
const USER_ENV_KEY = "HKCU\\Environment";

type EnvironmentResolver = (name: string) => string | null;

/**
 * Expand Windows-style `%NAME%` references using a case-insensitive environment.
 *
 * When provided, the resolver is authoritative (for example, current registry
 * values) and the inherited environment is only used as a fallback. Unknown
 * references are preserved. Multiple passes support nested values while the
 * pass limit and seen-value set prevent cyclic references from looping forever.
 */
export function expandWindowsEnvironmentVariables(
	value: string,
	env: NodeJS.ProcessEnv = process.env,
	resolveCurrent?: EnvironmentResolver,
): string {
	const normalizedEnv = new Map<string, string>();
	for (const [name, envValue] of Object.entries(env)) {
		if (envValue != null) normalizedEnv.set(name.toLowerCase(), envValue);
	}

	let expanded = value;
	const seen = new Set<string>([expanded]);
	for (let pass = 0; pass < MAX_ENV_EXPANSION_PASSES; pass++) {
		let replaced = false;
		const next = expanded.replace(WINDOWS_ENV_REFERENCE, (reference, name: string) => {
			const normalizedName = name.toLowerCase();
			const currentValue = resolveCurrent?.(name);
			const replacement = currentValue ?? normalizedEnv.get(normalizedName);
			if (replacement == null) return reference;
			replaced = true;
			return replacement;
		});
		if (!replaced || next === expanded || seen.has(next)) return next;
		seen.add(next);
		expanded = next;
	}
	return expanded;
}

/**
 * Read a registry value via `reg query`.
 * Returns the value string or null on failure.
 */
function readRegValue(key: string, valueName: string): string | null {
	try {
		const result = Bun.spawnSync(["reg", "query", key, "/v", valueName], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode !== 0) return null;
		const output = new TextDecoder().decode(result.stdout);
		// Output format:
		//   HKEY_LOCAL_MACHINE\...\Environment
		//       Path    REG_EXPAND_SZ    C:\Windows;C:\Program Files\Git\cmd;...
		// We need the part after REG_SZ or REG_EXPAND_SZ
		const match = output.match(/^\s+\S+\s+REG_(?:EXPAND_)?SZ\s+(.+)$/m);
		return match?.[1]?.trim() ?? null;
	} catch {
		return null;
	}
}

function createRegistryEnvironmentResolver(): EnvironmentResolver {
	const cache = new Map<string, string | null>();
	return (name) => {
		const normalizedName = name.toLowerCase();
		if (cache.has(normalizedName)) return cache.get(normalizedName) ?? null;

		// User variables override system variables in a Windows user environment block.
		const value = readRegValue(USER_ENV_KEY, name) ?? readRegValue(SYSTEM_ENV_KEY, name);
		cache.set(normalizedName, value);
		return value;
	};
}

/**
 * Refresh `process.env.PATH` from the Windows registry.
 *
 * Reads the system PATH and user PATH from the registry, merges them
 * (system first, then user — matching Windows behaviour), and updates
 * `process.env.PATH`.
 *
 * @returns `true` if PATH was changed, `false` if unchanged or not on Windows.
 */
export function refreshWindowsPath(): boolean {
	if (!IS_WINDOWS) return false;

	const rawSystemPath = readRegValue(SYSTEM_ENV_KEY, "Path");
	const rawUserPath = readRegValue(USER_ENV_KEY, "Path");

	if (!rawSystemPath && !rawUserPath) return false;

	const resolveRegistryVariable = createRegistryEnvironmentResolver();
	const systemPath = rawSystemPath
		? expandWindowsEnvironmentVariables(rawSystemPath, process.env, resolveRegistryVariable)
		: null;
	const userPath = rawUserPath
		? expandWindowsEnvironmentVariables(rawUserPath, process.env, resolveRegistryVariable)
		: null;
	const newPath = [systemPath, userPath].filter(Boolean).join(";");
	const oldPath = process.env.PATH ?? "";

	if (newPath === oldPath) return false;

	process.env.PATH = newPath;
	return true;
}
