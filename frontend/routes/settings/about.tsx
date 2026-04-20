import { Stack, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { AboutSection } from "../../components/settings/AboutSection";
import { api } from "../../lib/api";

export const Route = createFileRoute("/settings/about")({
	component: SettingsAboutPage,
});

function SettingsAboutPage() {
	const { t } = useTranslation("settings");
	const { data: healthData } = useQuery({
		queryKey: ["health"],
		queryFn: api.health,
		staleTime: 5 * 60 * 1000,
	});

	return (
		<Stack>
			<Title order={3}>{t("versionSection")}</Title>
			<AboutSection healthData={healthData} />
		</Stack>
	);
}
