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

	const systemPath = readRegValue(
		"HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment",
		"Path",
	);
	const userPath = readRegValue("HKCU\\Environment", "Path");

	if (!systemPath && !userPath) return false;

	const newPath = [systemPath, userPath].filter(Boolean).join(";");
	const oldPath = process.env.PATH ?? "";

	if (newPath === oldPath) return false;

	process.env.PATH = newPath;
	return true;
}
