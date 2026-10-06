/**
 * Upstream policy-violation detection (Codex / OpenAI Responses family).
 *
 * The headline code is `cyber_policy`: Codex's upstream hard-blocks the turn
 * with `error.code === "cyber_policy"` (non-streaming 400) or a streamed
 * `response.failed` / `error` event carrying `response.error.code` /
 * `error.code`. Retrying or failing over such a request replays the violating
 * prompt against other credentials, which is how accounts get banned — so every
 * layer (classification, credential health, retries) keys off this detector
 * instead of re-implementing string matching.
 *
 * Detection is exact-match on a normalized code, never substring matching on
 * prose: the reason field carries a machine code, and a loose match against
 * message text would misfire on ordinary content discussing the policy.
 */

/** Canonical upstream code for a cyber-policy hard block. */
export const CYBER_POLICY_VIOLATION_CODE = "cyber_policy";

/**
 * Codes treated as upstream policy violations. The set is the extension point:
 * a newly observed upstream violation code is a one-line addition, and every
 * consumer (classifier, credential guard, UI) picks it up at once.
 */
const POLICY_VIOLATION_CODES: ReadonlySet<string> = new Set([CYBER_POLICY_VIOLATION_CODE]);

/**
 * Normalize a machine code for comparison: lowercase, `-`/whitespace → `_`.
 * Returns the normalized violation code, or null when `code` is not a known
 * policy violation — use this when the caller needs the canonical code back.
 */
export function normalizePolicyViolationCode(code: string | null | undefined): string | null {
	if (typeof code !== "string" || code.trim() === "") return null;
	const normalized = code.trim().toLowerCase().replace(/[-\s]/g, "_");
	return POLICY_VIOLATION_CODES.has(normalized) ? normalized : null;
}

/**
 * True when `code` is a known upstream policy-violation code. Accepts the raw
 * value from `error.code` / `response.error.code` / `invalidState.reason`.
 */
export function isPolicyViolationCode(code: string | null | undefined): boolean {
	return normalizePolicyViolationCode(code) !== null;
}

/**
 * Recover a policy-violation code from a thrown error without importing server
 * modules (this file is shared with bundled plugin code). Reads the structured
 * carriers used across the Codex paths by shape:
 *  - `ApiError.diagnostics.code` / `diagnostics.reason` (non-streaming HTTP errors)
 *  - `CodexWebSocketRetryableError.code` (WS transport-classified errors)
 *  - a flat string `code` property (wrapped upstream error events)
 *
 * Message text is deliberately NOT consulted: a prose match would turn any
 * error mentioning the policy into a violation.
 */
export function extractPolicyViolationCode(err: unknown): string | null {
	if (!err || typeof err !== "object") return null;
	const record = err as Record<string, unknown>;
	const candidates: unknown[] = [];
	const diagnostics = record.diagnostics;
	if (diagnostics && typeof diagnostics === "object") {
		const diag = diagnostics as Record<string, unknown>;
		candidates.push(diag.code, diag.reason);
	}
	candidates.push(record.code);
	for (const candidate of candidates) {
		if (typeof candidate === "string") {
			const normalized = normalizePolicyViolationCode(candidate);
			if (normalized) return normalized;
		}
	}
	return null;
}
