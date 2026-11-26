import { formatLocaleNumber } from "./intl-format";

/** Payment APIs use micro-CNY; retain precision until presentation. */
export function formatTokenDanceMoney(
	value: number | null | undefined,
	locale?: string,
): string | undefined {
	return value == null || !Number.isFinite(value)
		? undefined
		: `¥${formatLocaleNumber(
				value / 1_000_000,
				{ minimumFractionDigits: 2, maximumFractionDigits: 6 },
				locale,
			)}`;
}
