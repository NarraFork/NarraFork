import { useCurrentUser } from "../../../hooks/useAuth";
import {
	type ProviderBadgeSettings,
	useCustomApiQuotaBadges,
	useProviderBalanceBadges,
} from "./use-provider-balance-badges";

/** Shared normalized Custom API windows/amounts, alongside untouched NUG/platform balances. */
export function useModelMenuProviderBadges(
	settingsData: ProviderBadgeSettings | undefined,
	enabled: boolean,
) {
	const { data: user } = useCurrentUser();
	const isAdmin = user?.role === "admin";
	const providerBadges = useCustomApiQuotaBadges(settingsData, enabled, isAdmin);
	const providerBalances = useProviderBalanceBadges(settingsData, enabled, isAdmin);
	return { providerBadges, providerBalances };
}
