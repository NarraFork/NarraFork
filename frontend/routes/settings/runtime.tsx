import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { RuntimeSection } from "../../components/settings/RuntimeSection";

export const Route = createFileRoute("/settings/runtime")({
	component: SettingsRuntimePage,
});

function SettingsRuntimePage() {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Title order={3}>{t("runtimeSection")}</Title>
			<RuntimeSection />
		</Stack>
	);
}
