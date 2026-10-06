import { Card, SimpleGrid, Text } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatCompactNumber } from "../../lib/compact-number";

const DASHBOARD_QUERY_GC_TIME_MS = 60_000;

export function StatsRow() {
	const { t } = useTranslation("dashboard");

	// Single aggregated request — replaces the previous 5 scattered queries.
	// All counts are computed server-side over indexed columns.
	const { data: summary } = useQuery({
		queryKey: ["dashboard", "summary"],
		queryFn: () => api.getDashboardSummary(),
		gcTime: DASHBOARD_QUERY_GC_TIME_MS,
	});

	const todayTokens = summary?.todayTokens.total ?? 0;
	const formattedTokens = formatCompactNumber(todayTokens);

	return (
		<SimpleGrid cols={{ base: 2, sm: 3, lg: 5 }}>
			<StatCard
				label={t("workingNarrators")}
				value={summary?.workingNarratorCount ?? 0}
				color="blue"
				to="/narrators"
			/>
			<StatCard
				label={t("waitingNarrators")}
				value={summary?.waitingNarratorCount ?? 0}
				color="yellow"
				to="/narrators"
			/>
			<StatCard
				label={t("runningTerminals")}
				value={summary?.runningTerminalCount ?? 0}
				color="teal"
				to="/settings/terminals"
			/>
			<StatCard
				label={t("enabledScheduledTasks")}
				value={summary?.enabledScheduledTaskCount ?? 0}
				color="grape"
				to="/scheduled-tasks"
			/>
			<StatCard
				label={t("todayTokens")}
				value={formattedTokens.compact}
				color="green"
				to="/narrators"
				title={formattedTokens.isCompact ? formattedTokens.exact : undefined}
			/>
		</SimpleGrid>
	);
}

function StatCard({
	label,
	value,
	color,
	to,
	title,
}: {
	label: string;
	value: number | string;
	color: string;
	to: string;
	title?: string;
}) {
	return (
		<Card
			withBorder
			component={Link}
			to={to}
			style={{ textDecoration: "none", cursor: "pointer" }}
			title={title}
		>
			<Text size="xs" tt="uppercase" fw={700} c="dimmed">
				{label}
			</Text>
			<Text size="xl" fw={700} c={color}>
				{value}
			</Text>
		</Card>
	);
}
