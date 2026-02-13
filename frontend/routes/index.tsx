import { Button, Stack, Text, Title } from "@mantine/core";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	const { t } = useTranslation("dashboard");

	return (
		<Stack>
			<Title>{t("welcome")}</Title>
			<Text c="dimmed">{t("subtitle")}</Text>
			<Button component={Link} to="/projects" w="fit-content">
				{t("viewProjects")}
			</Button>
		</Stack>
	);
}
