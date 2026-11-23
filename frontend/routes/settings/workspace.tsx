import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { WorkspaceContainersSection } from "../../components/settings/WorkspaceContainersSection";

export const Route = createFileRoute("/settings/workspace")({
	component: SettingsWorkspacePage,
});

function SettingsWorkspacePage() {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Title order={3}>{t("workspaceAndContainersSection")}</Title>
			<WorkspaceContainersSection />
		</Stack>
	);
}
