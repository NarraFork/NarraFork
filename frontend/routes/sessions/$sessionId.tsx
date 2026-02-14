import { Box, Loader, Text } from "@mantine/core";
import { createFileRoute, useLocation } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { NarratorPanel } from "../../components/narrator/NarratorPanel";
import { useNarrator } from "../../hooks/useNarrator";

export const Route = createFileRoute("/sessions/$sessionId")({
	component: SessionDetailPage,
});

function SessionDetailPage() {
	const { sessionId } = Route.useParams();
	const location = useLocation();
	const highlightMessageId = location.hash?.startsWith("msg-") ? location.hash.slice(4) : undefined;
	const { data: session, isLoading } = useNarrator(sessionId);
	const { t } = useTranslation("sessions");

	if (isLoading) return <Loader />;
	if (!session) return <Text>{t("sessionNotFound")}</Text>;

	return (
		<Box h="calc(100dvh - 92px)" style={{ display: "flex", flexDirection: "column" }}>
			<Box style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
				<NarratorPanel
					narratorId={sessionId}
					narrator={session}
					highlightMessageId={highlightMessageId}
				/>
			</Box>
		</Box>
	);
}
