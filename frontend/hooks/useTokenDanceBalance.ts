import { useQuery } from "@tanstack/react-query";
import { api } from "../lib/api";
import { formatLocaleNumber } from "../lib/intl-format";

/** Micro-CNY values must not be rounded before presentation. */
export function formatTokenDanceMoney(
	value: number | null | undefined,
	locale?: string,
): string | undefined {
	return value == null || !Number.isFinite(value)
		? undefined
		: `¥${formatLocaleNumber(
				value / 1_000_000,
				{
					minimumFractionDigits: 2,
					maximumFractionDigits: 6,
				},
				locale,
			)}`;
}

export function useTokenDanceBalance(generation: number | undefined, enabled = true) {
	const query = useQuery({
		queryKey: ["tokendance", "balance", generation],
		queryFn: ({ signal }) => api.tokenDanceBalance({ signal }),
		enabled: enabled && generation !== undefined,
		staleTime: 30_000,
		refetchInterval: (query) => {
			if (!enabled || generation === undefined) return false;
			const data = query.state.data;
			return data?.generation === generation && data.loading && !data.hasError ? 3000 : 30_000;
		},
		refetchIntervalInBackground: false,
		retry: false,
	});
	return { ...query, data: query.data?.generation === generation ? query.data : undefined };
}
