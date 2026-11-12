import type { ProviderBalanceAmount, ProviderBalanceSnapshot } from "@shared/provider-balance";
import { formatLocaleNumber } from "./intl-format";

type Translate = (key: string, options?: Record<string, unknown>) => string;

function amountText(value: number | null | undefined, unit: string, t: Translate): string {
	if (value == null || !Number.isFinite(value)) return t("providerBalance.unknown");
	const label =
		unit === "QUOTA"
			? t("providerBalance.quotaUnit")
			: unit === "TOKENS"
				? t("providerBalance.tokens")
				: unit;
	const amount = formatLocaleNumber(value, { maximumSignificantDigits: 12 });
	return unit === "QUOTA" || unit === "TOKENS" ? `${amount} ${label}` : `${label} ${amount}`;
}

function remainingText(amount: ProviderBalanceAmount, t: Translate): string {
	const value = amountText(amount.remaining, amount.unit, t);
	return amount.window ? `${amount.window}: ${value}` : value;
}

/**
 * One fixed label per failure code.
 *
 * The server decides these codes from the error type and HTTP status, never from response
 * text, so a deterministic failure ("your token was rejected") is never described as a
 * retryable network problem or the other way around.
 */
function failureLabel(snapshot: ProviderBalanceSnapshot | undefined, t: Translate): string {
	switch (snapshot?.error) {
		case "auth_failed":
			return t("providerBalance.errorAuth");
		case "invalid_response":
			return t("providerBalance.errorInvalidResponse");
		case "invalid_configuration":
			return t("providerBalance.errorInvalidConfiguration");
		case "plugin_not_enabled":
			return t("providerBalance.errorPluginNotEnabled");
		case "request_failed":
			return t("providerBalance.errorRequestFailed");
		default:
			return t("providerBalance.failed");
	}
}

export function formatProviderBalance(
	snapshot: ProviderBalanceSnapshot | undefined,
	t: Translate,
	queryFailed = false,
	now = Date.now(),
): { quotaBalance: string; detailedQuotaBalance: string } {
	const balance = snapshot?.balance;
	if (!balance) {
		const text =
			queryFailed || snapshot?.error
				? failureLabel(snapshot, t)
				: t(`providerBalance.${snapshot?.status ?? "pending"}`);
		return { quotaBalance: text, detailedQuotaBalance: text };
	}
	// 徽标只放数值：状态栏本来就窄，额度种类留给悬浮提示（见下方 lines）。
	const scope = balance.scope === "wallet" ? "" : t(`providerBalance.${balance.scope}`);
	const values = balance.unlimited
		? t("providerBalance.unlimited")
		: balance.amounts.map((amount) => remainingText(amount, t)).join(" / ") ||
			t("providerBalance.unknown");
	const failed = queryFailed || snapshot.error != null;
	const stale = failed || snapshot.fetchedAt === 0 || now - snapshot.fetchedAt > 120_000;
	const suffix = [
		failed ? failureLabel(snapshot, t) : "",
		stale ? t("providerBalance.stale") : "",
	].filter(Boolean);
	const summary = `${values}${suffix.length ? ` · ${suffix.join(" · ")}` : ""}`;
	const lines =
		balance.unlimited || balance.amounts.length === 0
			? [values]
			: balance.amounts.map((amount) => {
					const details = [remainingText(amount, t)];
					if (amount.used != null)
						details.push(
							t("providerBalance.used", { amount: amountText(amount.used, amount.unit, t) }),
						);
					if (amount.total != null)
						details.push(
							t("providerBalance.total", { amount: amountText(amount.total, amount.unit, t) }),
						);
					return details.join(" · ");
				});
	if (scope) lines.unshift(scope);
	// The group a New API site places the account in; optional, and never a substitute for
	// the reported amounts.
	if (balance.planName) lines.push(t("providerBalance.group", { name: balance.planName }));
	if (suffix.length) lines.push(suffix.join(" · "));
	return { quotaBalance: summary, detailedQuotaBalance: lines.join("\n") };
}
