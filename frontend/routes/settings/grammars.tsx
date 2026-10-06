import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { StructuralGrammarsSection } from "../../components/settings/StructuralGrammarsSection";

export const Route = createFileRoute("/settings/grammars")({
	component: SettingsGrammarsPage,
});

function SettingsGrammarsPage() {
	const { t } = useTranslation("settings");

	return (
		<Stack>
			<Title order={3}>{t("grammarsSection")}</Title>
			<StructuralGrammarsSection />
		</Stack>
	);
}
