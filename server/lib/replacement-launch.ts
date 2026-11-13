/**
 * Arguments for the replacement process.
 *
 * A server supervised by the Windows manager is a `--serve` child of that manager. Relaunching
 * the new binary with `--serve` would update only the server and leave the old manager running
 * the old exe forever, keeping it locked. Start the new binary as a manager instead: it asks the
 * old manager to step aside and then starts and supervises the replacement server itself, passing
 * this handoff on to it.
 */
import { spawnWindowsReplacementProcess } from "./windows-replacement-process";
export function replacementLaunchArgs(
	args: readonly string[],
	options: { platform: string; managerManaged: boolean },
): string[] {
	if (options.platform !== "win32" || !options.managerManaged) return [...args];
	return [...args.filter((arg) => arg !== "--serve"), "--manager"];
}

interface ReplacementProcess {
	pid: number;
	unref(): void;
}

interface ReplacementSpawnOptions {
	cwd: string;
	env: Record<string, string | undefined>;
	detached: true;
	stdio: ["ignore", "ignore", "ignore"];
	windowsHide: boolean;
}

type ReplacementSpawner = (
	command: string[],
	options: ReplacementSpawnOptions,
) => ReplacementProcess;

/** The update successor must outlive both the old server and its supervising manager. */
export function spawnReplacementProcess(
	options: {
		execPath: string;
		args: readonly string[];
		cwd: string;
		env: Record<string, string | undefined>;
		platform?: string;
	},
	dependencies: {
		spawn?: ReplacementSpawner;
		spawnWindows?: typeof spawnWindowsReplacementProcess;
	} = {},
): number {
	if ((options.platform ?? process.platform) === "win32") {
		return (dependencies.spawnWindows ?? spawnWindowsReplacementProcess)(options);
	}
	const child = (dependencies.spawn ?? Bun.spawn)([options.execPath, ...options.args], {
		cwd: options.cwd,
		env: options.env,
		detached: true,
		stdio: ["ignore", "ignore", "ignore"],
		windowsHide: false,
	});
	child.unref();
	return child.pid;
}
