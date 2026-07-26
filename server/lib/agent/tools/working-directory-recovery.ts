import type { ToolResult } from "../types";

export const MISSING_WORKING_DIRECTORY_RECOVERY_KIND = "missing_working_directory";

export interface MissingWorkingDirectoryRecovery {
	kind: typeof MISSING_WORKING_DIRECTORY_RECOVERY_KIND;
	missingCwd: string;
	suggestedCwd: string;
}

export function createMissingWorkingDirectoryResult({
	missingCwd,
	suggestedCwd,
	title,
}: {
	missingCwd: string;
	suggestedCwd: string;
	title: string;
}): ToolResult {
	return {
		output: `Working directory does not exist: ${missingCwd}\nPlease check your project path and try again.`,
		isError: true,
		fatal: true,
		title,
		metadata: {
			cwdRecovery: {
				kind: MISSING_WORKING_DIRECTORY_RECOVERY_KIND,
				missingCwd,
				suggestedCwd,
			},
		},
	};
}

/**
 * A bad `workdir` argument is the model's mistake, not a broken session: the narrator's
 * own cwd is still usable, so the loop must keep running and let the model retry with a
 * correct path. Only a missing session cwd justifies the fatal stop plus recovery card.
 */
export function createInvalidWorkdirArgumentResult({
	missingCwd,
	baseCwd,
	title,
}: {
	missingCwd: string;
	baseCwd: string;
	title: string;
}): ToolResult {
	return {
		output:
			`Working directory does not exist: ${missingCwd}\n` +
			`This path came from the \`workdir\` argument, not from the session working directory ` +
			`(${baseCwd}), which is still available.\n` +
			`Verify the path (list its parent first) and retry, or omit \`workdir\` to use the session working directory.`,
		isError: true,
		title,
	};
}

export function getMissingWorkingDirectoryRecovery(
	metadata: Record<string, unknown> | undefined,
): MissingWorkingDirectoryRecovery | null {
	const recovery = metadata?.cwdRecovery;
	if (!recovery || typeof recovery !== "object") return null;

	const { kind, missingCwd, suggestedCwd } = recovery as Record<string, unknown>;
	if (
		kind !== MISSING_WORKING_DIRECTORY_RECOVERY_KIND ||
		typeof missingCwd !== "string" ||
		!missingCwd ||
		typeof suggestedCwd !== "string" ||
		!suggestedCwd
	) {
		return null;
	}

	return { kind, missingCwd, suggestedCwd };
}
