import { getCodexManager } from "@server/lib/codex-manager";

/**
 * Human-readable name for a credential id, or the id itself when no better name exists.
 *
 * Lives here rather than inside a service because two unrelated consumers need the same
 * answer: the usage-history list/detail projections, and the dump spill store recording
 * *which account* sent a request that got rejected. A dump is forwarded to whoever is
 * helping diagnose it, and an opaque credential id does not identify the account.
 *
 * Never throws: a provider plugin that is not loaded must degrade to the id, not fail the
 * request that was merely being recorded.
 */
export function resolveCredentialDisplayName(
	provider: string | null | undefined,
	credentialId: string | null | undefined,
): string | null {
	if (!provider || !credentialId) return null;

	try {
		if (provider === "codex") {
			const snapshot = getCodexManager().snapshot();
			const cred = snapshot.entries.find((c) => c.id === credentialId);
			return cred?.displayName || cred?.email || cred?.accountId || credentialId;
		}
		// Anthropic and OpenAI direct connections have no credential management.
	} catch {
		// Ignore snapshot failures (e.g. plugin not loaded).
	}

	return credentialId;
}
