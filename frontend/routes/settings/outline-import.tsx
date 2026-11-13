import { Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { SpecImportAdminSection } from "../../components/settings/SpecImportAdminSection";

/** The Dynamic Spec import's admin page (outline P2 PR 12b2); administrators only. */
export const Route = createFileRoute("/settings/outline-import")({
	component: SettingsOutlineImportPage,
});

function SettingsOutlineImportPage() {
	const { t } = useTranslation("settings");
	return (
		<Stack>
			<Title order={3}>{t("outlineImportSection")}</Title>
			<SpecImportAdminSection />
		</Stack>
	);
}
