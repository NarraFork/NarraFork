import { Badge, Tooltip } from "@mantine/core";
import { useTranslation } from "react-i18next";
import type { PluginTrustTier } from "../../lib/api/plugins";

const TRUST_TIER_COLORS: Record<PluginTrustTier, string> = {
	T0: "indigo",
	T1: "green",
	T2: "blue",
	T3: "red",
};

const TRUST_TIERS: readonly PluginTrustTier[] = ["T0", "T1", "T2", "T3"];

function isTrustTier(value: unknown): value is PluginTrustTier {
	return typeof value === "string" && (TRUST_TIERS as readonly string[]).includes(value);
}

export function PluginTrustBadges({ trustTier }: { trustTier?: string }) {
	const { t } = useTranslation("plugins");
	const tier: PluginTrustTier | null = isTrustTier(trustTier) ? trustTier : null;

	if (!tier) {
		return (
			<Badge color="gray" variant="outline" size="sm">
				{t("admin.trust.unknown")}
			</Badge>
		);
	}

	return (
		<Tooltip label={t(`admin.trust.${tier}`)} withArrow>
			<Badge color={TRUST_TIER_COLORS[tier]} variant={tier === "T3" ? "filled" : "light"} size="sm">
				{tier}
			</Badge>
		</Tooltip>
	);
}
