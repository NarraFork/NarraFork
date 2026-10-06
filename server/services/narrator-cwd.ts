export function resolveNarratorSessionCwd(
	narratorCwd: string | null | undefined,
	worktreePath: string | null | undefined,
	projectGitPath: string | null | undefined,
	fallbackCwd: string,
): string {
	return narratorCwd || worktreePath || projectGitPath || fallbackCwd;
}
