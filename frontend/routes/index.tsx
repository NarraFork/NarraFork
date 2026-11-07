import { MobileNavButton } from "@frontend/components/nav/MobileNavButton";
import { Group, Stack, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { DashboardComposer } from "../components/dashboard/DashboardComposer";
import { DashboardSessions, useDashboardSessions } from "../components/dashboard/DashboardSessions";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	const { t } = useTranslation("dashboard");
	const sessions = useDashboardSessions();

	return (
		<Stack gap="xl" maw={1100} w="100%" mx="auto">
			<Stack gap="sm" pt={{ base: 0, sm: "md" }}>
				<Group gap="xs" wrap="nowrap">
					<MobileNavButton />
					<Title order={2}>{t("heading")}</Title>
				</Group>
				{/* 输入即开始：选目录/模型，发送时创建独立会话并发出首条消息 */}
				<DashboardComposer />
			</Stack>

			{/* 需要用户处理的会话（待决定、出错、已完成未读）置顶，其次是正在运行的会话 */}
			<DashboardSessions data={sessions} />
		</Stack>
	);
}
