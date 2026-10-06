import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ChaptersContainersSection } from "../../components/settings/ChaptersContainersSection";
import { useInstanceSettingsContext } from "../../hooks/useInstanceSettings";

export const Route = createFileRoute("/settings/chapters")({
	component: SettingsChaptersPage,
});

function SettingsChaptersPage() {
	const { t } = useTranslation("settings");
	const is = useInstanceSettingsContext();

	return (
		<Stack>
			<Title order={3}>{t("chaptersAndContainersSection")}</Title>
			<ChaptersContainersSection
				maxWorktrees={is.maxWorktrees}
				setMaxWorktrees={is.setMaxWorktrees}
				maxContainers={is.maxContainers}
				setMaxContainers={is.setMaxContainers}
				sizeWarning={is.sizeWarning}
				setSizeWarning={is.setSizeWarning}
				autoSave={is.autoSave}
				setAutoSave={is.setAutoSave}
				dormantMinutes={is.dormantMinutes}
				setDormantMinutes={is.setDormantMinutes}
				treeSnapshots={is.treeSnapshots}
				setTreeSnapshots={is.setTreeSnapshots}
				portStart={is.portStart}
				setPortStart={is.setPortStart}
				portEnd={is.portEnd}
				setPortEnd={is.setPortEnd}
				proxyEnabled={is.proxyEnabled}
				setProxyEnabled={is.setProxyEnabled}
				proxyPort={is.proxyPort}
				setProxyPort={is.setProxyPort}
			/>
		</Stack>
	);
}
