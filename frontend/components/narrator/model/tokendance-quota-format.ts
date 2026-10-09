import type { TokenDanceBalance } from "@shared/tokendance";
import { formatLocaleNumber } from "../../../lib/intl-format";

/** Keep tiny positive balances visible instead of rounding them to an empty allowance. */
export function formatTokenDanceAmount(microCny: number, locale?: string): string {
	return formatLocaleNumber(
		microCny / 1_000_000,
		{ minimumFractionDigits: 2, maximumFractionDigits: 6 },
		locale,
	);
}

type Translate = (key: string, values?: Record<string, string>) => string;

export function tokenDanceQuotaView(
	data: TokenDanceBalance | undefined,
	generation: number | undefined,
	admin: boolean,
	t: Translate,
	locale?: string,
	now = Date.now(),
) {
	if (generation === undefined) return null;
	const current = data?.generation === generation ? data : undefined;
	const balance = current?.balance;
	const known = typeof balance === "number" && Number.isSafeInteger(balance);
	const amount = (value: number | null | undefined) =>
		typeof value === "number" && Number.isSafeInteger(value)
			? formatTokenDanceAmount(value, locale)
			: "—";
	const text = known
		? t("tokendanceBalance", { balance: amount(balance) })
		: t("tokendanceBalanceUnknown");
	const details = known
		? t("tokendanceBalanceDetails", {
				credits: amount(current?.credits),
				used: amount(current?.creditsUsed),
				balance: amount(balance),
			})
		: t("tokendanceBalanceUnknown");
	const stale =
		!!current &&
		(current.hasError || (current.updatedAt !== null && now - current.updatedAt > 90_000));
	const messages = [details];
	if (stale) messages.push(t("tokendanceBalanceStale"));
	if (!admin && known && balance <= 0) messages.push(t("tokendanceAdminRechargeRequired"));
	return {
		balance: text,
		detailsText: messages.join("\n"),
		hasDetailsPopover: true,
		showRechargeButton: admin && (!known || balance <= 0),
		showRechargeInDetails: admin && known && balance > 0,
	};
}
