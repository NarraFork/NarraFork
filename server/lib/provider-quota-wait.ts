import type { QuotaProviderKind } from "@shared/agent-protocol/quota-exhausted";
import type { ApiRequestDiagnostics } from "@shared/agent-protocol/types";
import { resolveKimiQuotaWait } from "./kimi-quota-wait";
import { findOpencodeProvider, resolveOpencodeQuotaTarget } from "./opencode-quota-wait";

/**
 * One decision point for every provider whose refusal can be waited out on a
 * known clock — Kimi's coding plan and OpenCode Go — so the agent loop's two
 * refusal paths (thrown HTTP error, in-stream invalidState) carry one call
 * instead of a branch per provider.
 *
 *  - `wait` — the reset is inside the budget; the caller suspends to `resumeAt`.
 *  - `refuse` — a real allowance wall that will not be waited on; the caller
 *    reports it, with `resetAt` when known.
 *  - `none` — not a recoverable quota refusal; normal classification continues.
 */

export interface ProviderQuotaWait {
	quotaProvider: QuotaProviderKind;
	providerId: string;
	providerPrefix: string;
	waitKind?: "quota" | "capacity" | "rate_limit";
	bucket: string;
	/** The reset instant as published upstream (no skew applied). */
	resetAt: number;
	/** Epoch ms at which the turn may be replayed. */
	resumeAt: number;
}

export interface ProviderQuotaRefusal {
	quotaProvider: QuotaProviderKind;
	providerId: string;
	providerPrefix: string;
	waitKind?: "quota" | "capacity" | "rate_limit";
	bucket: string;
	resetAt?: number;
}

export type ProviderQuotaDecision =
	| { kind: "wait"; wait: ProviderQuotaWait }
	| { kind: "refuse"; refusal: ProviderQuotaRefusal }
	| { kind: "none" };

export async function resolveProviderQuotaWait(
	providerRef: string,
	errorText: string,
	diagnostics?: ApiRequestDiagnostics,
	now = Date.now(),
): Promise<ProviderQuotaDecision> {
	const opencode = findOpencodeProvider(providerRef);
	if (opencode) {
		const target = await resolveOpencodeQuotaTarget(opencode.id, errorText, diagnostics, now);
		if (!target) return { kind: "none" };
		const identity = {
			quotaProvider: "opencode" as const,
			providerId: opencode.id,
			providerPrefix: opencode.prefix,
			waitKind:
				target.bucket === "capacity"
					? ("capacity" as const)
					: target.bucket === "rateLimit"
						? ("rate_limit" as const)
						: ("quota" as const),
		};
		if ("resumeAt" in target) {
			return {
				kind: "wait",
				wait: {
					...identity,
					bucket: target.bucket,
					resetAt: target.resetAt,
					resumeAt: target.resumeAt,
				},
			};
		}
		return {
			kind: "refuse",
			refusal: { ...identity, bucket: target.bucket, resetAt: target.resetAt },
		};
	}

	const kimi = await resolveKimiQuotaWait(
		providerRef,
		`${errorText}\n${diagnostics?.responseSnippet ?? ""}`,
		now,
	);
	if (kimi.kind === "wait") {
		const { providerId, providerPrefix, bucket, resetAt, resumeAt } = kimi.wait;
		return {
			kind: "wait",
			wait: { quotaProvider: "kimi", providerId, providerPrefix, bucket, resetAt, resumeAt },
		};
	}
	if (kimi.kind === "refuse") {
		const { providerId, providerPrefix, bucket, resetAt } = kimi.refusal;
		return {
			kind: "refuse",
			refusal: { quotaProvider: "kimi", providerId, providerPrefix, bucket, resetAt },
		};
	}
	return { kind: "none" };
}

export {
	MAX_QUOTA_WAITS_PER_RUN,
	waitForKimiQuotaReset as waitForQuotaReset,
} from "./kimi-quota-wait";
