export const CODEX_REBUILD_HISTORY_RETRY_CODE = "codex_quota_failover_rebuild";

/**
 * Codex quota failover needs an outer retry after the current partial turn has
 * been persisted and history rebuilt from DB.
 *
 * This is used when the upstream account reports usage_limit_reached after the
 * model already emitted visible output or tool calls. Retrying inside the same
 * provider.chat() call would reuse stale in-memory history, so the narrator
 * session must finalize the partial assistant message and retry with fresh
 * history on the next available Codex credential.
 */
export class CodexRebuildHistoryRetryError extends Error {
	readonly code = CODEX_REBUILD_HISTORY_RETRY_CODE;
	readonly previousCredentialId?: string;
	readonly operation?: string;

	constructor(message: string, options?: { previousCredentialId?: string; operation?: string }) {
		super(message);
		this.name = "CodexRebuildHistoryRetryError";
		this.previousCredentialId = options?.previousCredentialId;
		this.operation = options?.operation;
	}
}

export function isCodexRebuildHistoryRetryError(
	error: unknown,
): error is CodexRebuildHistoryRetryError {
	return (
		error instanceof CodexRebuildHistoryRetryError ||
		(!!error &&
			typeof error === "object" &&
			(error as { code?: unknown }).code === CODEX_REBUILD_HISTORY_RETRY_CODE)
	);
}
