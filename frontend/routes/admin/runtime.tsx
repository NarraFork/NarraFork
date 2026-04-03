import { ActionIcon, Group, Stack, Title } from "@mantine/core";
import { IconArrowLeft } from "@tabler/icons-react";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { RuntimeSection } from "../../components/settings/RuntimeSection";
import { useCurrentUser } from "../../hooks/useAuth";

export const Route = createFileRoute("/admin/runtime")({
	component: AdminRuntimePage,
});

function AdminRuntimePage() {
	const { data: user } = useCurrentUser();
	const navigate = useNavigate();
	const { t } = useTranslation("settings");

	if (user && user.role !== "admin") {
		navigate({ to: "/" });
		return null;
	}

	return (
		<Stack>
			<Group mb="xs">
				<ActionIcon variant="subtle" component={Link} to="/admin">
					<IconArrowLeft size={18} />
				</ActionIcon>
				<Title order={2}>{t("runtimeSection")}</Title>
			</Group>
			<RuntimeSection />
		</Stack>
	);
}
