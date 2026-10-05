import { Alert, Center, Stack, Text } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { parsePanelWindowDescriptor } from "../../components/window/panel-window";
import { StandalonePanelWindow } from "../../components/window/StandalonePanelWindow";

export const Route = createFileRoute("/windows/panel")({
	validateSearch: (search: Record<string, unknown>) => ({
		d: parsePanelWindowDescriptor(search.d),
	}),
	component: PanelWindowRoute,
});

function PanelWindowRoute() {
	const { d: descriptor } = Route.useSearch();
	if (!descriptor) return <InvalidPanelWindow />;
	return <StandalonePanelWindow descriptor={descriptor} />;
}

function InvalidPanelWindow() {
	const { t } = useTranslation("common");
	return (
		<Center mih="100dvh" p="md">
			<Alert color="red" role="alert">
				<Stack gap={4}>
					<Text fw={600}>{t("panelWindow.invalidTitle")}</Text>
					<Text size="sm">{t("panelWindow.invalidDescription")}</Text>
				</Stack>
			</Alert>
		</Center>
	);
}
