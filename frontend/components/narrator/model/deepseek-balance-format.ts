import { identifyService } from "@shared/sourcing/identify";
import type { DeepSeekBalanceCache } from "../../../lib/api/types";

type Translate = (key: string, options?: Record<string, unknown>) => string;

/** Match only the official platform, not relays offering DeepSeek models. */
export function isDeepSeekProviderBaseUrl(baseUrl?: string): boolean {
	return identifyService({ baseUrl }).templateId === "deepseek";
}

export function formatDeepSeekBalance(
	balance: DeepSeekBalanceCache | undefined,
	t: Translate,
	queryFailed = false,
): { quotaBalance: string; detailedQuotaBalance: string } {
	const failed = queryFailed || balance?.error != null || balance?.hasError === true;
	if (!balance || balance.fetchedAt === 0 || failed) {
		const text = t(failed ? "deepseek.unavailable" : "deepseek.loading");
		return { quotaBalance: text, detailedQuotaBalance: text };
	}
	// Keep the API's decimal strings intact; do not round monetary amounts through Number.
	const totals = balance.balanceInfos.map((info) => `${info.currency} ${info.totalBalance}`);
	const lines: string[] = [];
	if (balance.isAvailable !== null) {
		lines.push(t(balance.isAvailable ? "deepseek.available" : "deepseek.accountUnavailable"));
	}
	for (const info of balance.balanceInfos) {
		lines.push(
			t("deepseek.total", { currency: info.currency, amount: info.totalBalance }),
			t("deepseek.granted", { currency: info.currency, amount: info.grantedBalance }),
			t("deepseek.toppedUp", { currency: info.currency, amount: info.toppedUpBalance }),
		);
	}
	return {
		quotaBalance:
			balance.isAvailable === false
				? t("deepseek.accountUnavailable")
				: totals.join(" / ") || t("deepseek.unavailable"),
		detailedQuotaBalance: lines.join("\n") || t("deepseek.unavailable"),
	};
}
