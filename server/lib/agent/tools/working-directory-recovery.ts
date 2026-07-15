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
