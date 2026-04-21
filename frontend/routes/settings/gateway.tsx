import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { GatewaySection } from "../../components/settings/GatewaySection";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

export const Route = createFileRoute("/settings/gateway")({
	component: SettingsGatewayPage,
});

function SettingsGatewayPage() {
	const { t } = useTranslation("settings");
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();

	return (
		<Stack>
			<Title order={3}>{t("gatewaySection")}</Title>
			<GatewaySection userPrefs={userPrefs} updateUserPref={updateUserPref} />
		</Stack>
	);
}
