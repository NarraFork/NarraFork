import { refreshWindowsPath } from "./win-env";

/** Global git availability state — set once at startup, re-checkable at runtime. */
export let gitAvailable = false;
export let gitVersion = "";

export function setGitStatus(available: boolean, version: string) {
	gitAvailable = available;
	gitVersion = version;
}

/** Try to run `git --version` and return the version string, or null on failure. */
function tryGit(): string | null {
	try {
		const result = Bun.spawnSync(["git", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			return new TextDecoder().decode(result.stdout).trim();
		}
	} catch {
		// ENOENT — git binary not found
	}
	return null;
}

/**
 * Re-check git availability at runtime (e.g. when the user clicks "recheck").
 * Updates the global state so subsequent middleware checks reflect the new status.
 *
 * On Windows, if the first attempt fails we refresh `process.env.PATH` from the
 * registry and retry — this handles the case where git was installed after
 * NarraFork (or its parent process) started.
 */
export function recheckGit(): boolean {
	let version = tryGit();

	// On Windows, PATH inherited from the parent process may be stale.
	// Read the current PATH from the registry and retry.
	if (!version) {
		if (refreshWindowsPath()) {
			version = tryGit();
		}
	}

	if (version) {
		setGitStatus(true, version);
		return true;
	}
	setGitStatus(false, "");
	return false;
}
