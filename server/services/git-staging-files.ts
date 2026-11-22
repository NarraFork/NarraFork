const GIT_STAGING_PROJECT_DIRECTORY = ".narrafork/git-staging";

export const GIT_STAGING_EXCLUDE_PATHSPEC =
	process.platform === "win32" || process.platform === "darwin"
		? ":(top,exclude,icase,glob)[.]narrafork/git-staging/**"
		: ":(top,exclude,glob)[.]narrafork/git-staging/**";

/** Only this root-anchored internal directory is reserved; other .narrafork files remain user data. */
export function isGitStagingInternalPath(path: string) {
	const raw = (process.platform === "win32" ? path.replaceAll("\\", "/") : path).replace(
		/^(?:\.\/)+/,
		"",
	);
	const normalized =
		process.platform === "win32" || process.platform === "darwin" ? raw.toLowerCase() : raw;
	return (
		normalized === GIT_STAGING_PROJECT_DIRECTORY ||
		normalized.startsWith(`${GIT_STAGING_PROJECT_DIRECTORY}/`)
	);
}
