import { BalanceProbeRequestError } from "./errors";
import { record } from "./protocol";
import {
	type BalanceProbeResult,
	type BalanceRequest,
	bounded,
	type ProviderBalanceData,
} from "./relay";

export const NEW_API_USER_QUOTA_DIVISOR = 500_000;
export const NEW_API_USER_ADAPTER = "new-api-user" as const;

function quotaNumber(value: unknown): number | null {
	if (typeof value === "number") return Number.isFinite(value) ? value : null;
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	if (!/^-?\d{1,18}(?:\.\d{1,9})?$/u.test(trimmed)) return null;
	const parsed = Number(trimmed);
	return Number.isFinite(parsed) ? parsed : null;
}

/** New API account credit, not the inference key's allowance. Unknown is never zero. */
export function parseNewApiUserQuota(body: unknown): ProviderBalanceData | null {
	if (!record(body) || !bounded(body) || body.success !== true || !record(body.data)) return null;
	const data = body.data;
	const quota = quotaNumber(data.quota);
	const used = quotaNumber(data.used_quota);
	if (quota === null || used === null || quota < -1 || used < 0) return null;
	const group = typeof data.group === "string" ? data.group.trim() : "";
	const plan = group && group.length <= 128 ? { planName: group } : {};
	if (quota === -1) return { scope: "wallet", unlimited: true, amounts: [], ...plan };
	const remaining = quota / NEW_API_USER_QUOTA_DIVISOR;
	const usedUsd = used / NEW_API_USER_QUOTA_DIVISOR;
	const total = (quota + used) / NEW_API_USER_QUOTA_DIVISOR;
	if (![remaining, usedUsd, total].every(Number.isFinite)) return null;
	return {
		scope: "wallet",
		unlimited: false,
		amounts: [{ unit: "USD", remaining, used: usedUsd, total }],
		...plan,
	};
}

export async function refreshSiteQuota(
	root: string,
	request: BalanceRequest,
): Promise<ProviderBalanceData> {
	const body = await request(`${root.replace(/\/+$/, "")}/api/user/self`, "site-token");
	const balance = parseNewApiUserQuota(body);
	if (!balance) throw new BalanceProbeRequestError("invalid_response");
	return balance;
}

export async function probeSiteQuota(
	root: string,
	request: BalanceRequest,
): Promise<BalanceProbeResult> {
	return { adapter: NEW_API_USER_ADAPTER, root, balance: await refreshSiteQuota(root, request) };
}
