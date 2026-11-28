/** A minimal process-tree cleanup graph for the isolated Git status Worker. */
export interface GitStatusPageOwnedProcess {
	pid: number;
	kill: (signal: "SIGKILL") => unknown;
}
interface TaskkillOptions {
	stdin: "ignore";
	stdout: "ignore";
	stderr: "ignore";
	timeout: number;
	windowsHide: boolean;
}
type TaskkillSpawn = (command: string[], options: TaskkillOptions) => { exited: Promise<number> };

/** Same bounded taskkill /T contract as the application spawner, without its logger/config imports. */
export async function killGitStatusPageWindowsTree(
	pid: number,
	spawn: TaskkillSpawn = (command, options) => Bun.spawn(command, options),
): Promise<void> {
	if (!Number.isSafeInteger(pid) || pid <= 0) return;
	try {
		const helper = spawn(["taskkill", "/T", "/F", "/PID", String(pid)], {
			stdin: "ignore",
			stdout: "ignore",
			stderr: "ignore",
			timeout: 5000,
			windowsHide: true,
		});
		await helper.exited;
	} catch {
		/* The owned process may already have exited. */
	}
}

/** Never kill by name: POSIX receives the scan's private group, Windows receives its owned PID. */
export async function terminateGitStatusPageChild(
	child: GitStatusPageOwnedProcess,
	platform: NodeJS.Platform = process.platform,
	windowsTree: (pid: number) => Promise<void> = killGitStatusPageWindowsTree,
): Promise<void> {
	if (!Number.isSafeInteger(child.pid) || child.pid <= 0) return;
	if (platform === "win32") {
		// Discover/terminate descendants before killing their parent, and await the helper.
		await windowsTree(child.pid);
	} else {
		try {
			process.kill(-child.pid, "SIGKILL");
			return;
		} catch {
			/* Group already exited. */
		}
	}
	try {
		child.kill("SIGKILL");
	} catch {
		/* Direct-child fallback. */
	}
}
