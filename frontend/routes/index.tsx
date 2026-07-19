import { Stack, Text, Title } from "@mantine/core";
import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { LiveNow } from "../components/dashboard/LiveNow";
import { NeedsAttention } from "../components/dashboard/NeedsAttention";
import { QuickActions } from "../components/dashboard/QuickActions";
import { RecentNarrators } from "../components/dashboard/RecentNarrators";
import { StatsRow } from "../components/dashboard/StatsRow";

export const Route = createFileRoute("/")({
	component: DashboardPage,
});

function DashboardPage() {
	const { t } = useTranslation("dashboard");

	return (
		<Stack>
			<div>
				<Title>{t("welcome")}</Title>
				<Text c="dimmed">{t("subtitle")}</Text>
			</div>

			{/* ① 需要处理 — 等待权限 / 失败错误，行动导向置顶 */}
			<NeedsAttention />

			{/* ② 正在运行 — 当前工作中的叙述者卡片条 */}
			<LiveNow />

			{/* ③ 全局概览统计行 */}
			<StatsRow />

			{/* ④ 快速入口 + 最近活跃叙述者 */}
			<QuickActions />
			<RecentNarrators />
		</Stack>
	);
}
