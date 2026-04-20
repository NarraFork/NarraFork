import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { StorageSection } from "../../components/settings/StorageSection";

export const Route = createFileRoute("/settings/storage")({
	component: SettingsStoragePage,
});

function SettingsStoragePage() {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Title order={3}>{t("storageSection")}</Title>
			<StorageSection />
		</Stack>
	);
}
