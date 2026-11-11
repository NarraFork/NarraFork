import { Alert, Text } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { ContextMemoryManager } from "../../components/context-memory/ContextMemoryManager";
import { useCurrentUser } from "../../hooks/useAuth";

export const Route = createFileRoute("/settings/memories")({ component: MemoriesPage });

function MemoriesPage() {
	const { t } = useTranslation("settings");
	const user = useCurrentUser();
	if (user.isError)
		return (
			<Alert color="red" role="alert">
				{t("memory.listError")}
			</Alert>
		);
	if (!user.data?.id) return <Text role="status">{t("memory.loading")}</Text>;
	return <ContextMemoryManager userId={user.data.id} />;
}
