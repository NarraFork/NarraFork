/** Global git availability state — set once at startup, re-checkable at runtime. */
export let gitAvailable = false;
export let gitVersion = "";

export function setGitStatus(available: boolean, version: string) {
	gitAvailable = available;
	gitVersion = version;
}

/**
 * Re-check git availability at runtime (e.g. when the user clicks "recheck").
 * Updates the global state so subsequent middleware checks reflect the new status.
 */
export function recheckGit(): boolean {
	try {
		const result = Bun.spawnSync(["git", "--version"], {
			stdout: "pipe",
			stderr: "pipe",
		});
		if (result.exitCode === 0) {
			const version = new TextDecoder().decode(result.stdout).trim();
			setGitStatus(true, version);
			return true;
		}
	} catch {
		// ENOENT — git binary not found
	}
	setGitStatus(false, "");
	return false;
}
