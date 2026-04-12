import { Badge, Tooltip } from "@mantine/core";
import React from "react";
import { useTranslation } from "react-i18next";

export type ProviderStatus = "connected" | "unverified" | "error" | "disabled" | "partial";

export interface ProviderStatusBadgeProps {
	status: ProviderStatus;
	errorMessage?: string;
	size?: "xs" | "sm" | "md";
}

export const ProviderStatusBadge = React.memo(function ProviderStatusBadge({
	status,
	errorMessage,
	size = "sm",
}: ProviderStatusBadgeProps) {
	const { t } = useTranslation("settings");

	const config = {
		connected: { color: "green", label: t("providerStatusConnected") },
		unverified: { color: "gray", label: t("providerStatusUnverified") },
		error: { color: "red", label: t("providerStatusError") },
		disabled: { color: "gray", label: t("providerStatusDisabled") },
		partial: { color: "yellow", label: t("providerStatusPartial") },
	}[status];

	const badge = (
		<Badge size={size} variant="light" color={config.color}>
			{config.label}
		</Badge>
	);

	if (status === "error" && errorMessage) {
		return (
			<Tooltip label={errorMessage} position="bottom">
				{badge}
			</Tooltip>
		);
	}

	return badge;
});
