import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NotificationSection } from "../../components/settings/NotificationSection";
import { useUpdateUserPreferences, useUserPreferences } from "../../hooks/useUserPreferences";

export const Route = createFileRoute("/settings/notifications")({
	component: SettingsNotificationsPage,
});

function SettingsNotificationsPage() {
	const { t } = useTranslation("settings");
	const { data: userPrefs } = useUserPreferences();
	const updateUserPref = useUpdateUserPreferences();

	return (
		<Stack>
			<Title order={3}>{t("notificationSection")}</Title>
			<NotificationSection userPrefs={userPrefs} updateUserPref={updateUserPref} />
		</Stack>
	);
}
