import { Box, Group, Loader, Text, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { useSession } from "../../hooks/useSessions";

export const Route = createFileRoute("/sessions/$sessionId")({
	component: SessionDetailPage,
});

function SessionDetailPage() {
	const { sessionId } = Route.useParams();
	const { data: session, isLoading } = useSession(sessionId);
	const { t } = useTranslation("sessions");

	if (isLoading) return <Loader />;
	if (!session) return <Text>{t("sessionNotFound")}</Text>;

	return (
		<Box h="calc(100vh - 100px)" style={{ display: "flex", flexDirection: "column" }}>
			<Group p="xs">
				<Title order={3}>{t("sessionId", { id: session.id.slice(0, 8) })}</Title>
				<Text size="sm" c="dimmed">
					{t("sessionMeta", { model: session.model, count: session.messageCount ?? 0 })}
				</Text>
			</Group>
			<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
				<NarratorPanel narratorId={sessionId} narrator={session} />
			</Box>
		</Box>
	);
}
