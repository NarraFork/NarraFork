import type { CodexCredits } from "./api/types";

/**
 * Display projection of the spendable Codex credit balance reported by the
 * /wham/usage `credits` field. The balance is a decimal string kept verbatim
 * to preserve precision, so it is rendered as-is rather than reformatted.
 */
export type CodexCreditsDisplay = { kind: "unlimited" } | { kind: "balance"; value: string };

export function getCodexCreditsDisplay(credits?: CodexCredits): CodexCreditsDisplay | null {
	if (!credits) return null;
	if (credits.unlimited) return { kind: "unlimited" };
	if (!credits.has_credits) return { kind: "balance", value: "0" };
	return { kind: "balance", value: credits.balance ?? "0" };
}
