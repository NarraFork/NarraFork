import { Badge, Card, Group, Stack, Text, UnstyledButton } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import { NARRATOR_STATUS_COLORS } from "../../lib/status-registry";

const DASHBOARD_QUERY_GC_TIME_MS = 60_000;
const RECENT_NARRATORS_LIMIT = 5;

export function RecentNarrators() {
	const { t } = useTranslation("dashboard");
	const navigate = useNavigate();

	const { data } = useQuery({
		queryKey: ["narrators", "recent-active", { standalone: "all" }],
		queryFn: () =>
			api.listNarratorsPaginated({
				standalone: "all",
				limit: 50,
				sortBy: "updatedAt",
				sortOrder: "desc",
			}),
		gcTime: DASHBOARD_QUERY_GC_TIME_MS,
	});

	const recentNarrators = useMemo(() => {
		const items = data?.items ?? [];
		return (
			items
				// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
				.map((item) => item as any)
				.sort((a, b) => {
					// Narrators without lastMessageAt sort last
					const ta = a.lastMessageAt ? new Date(a.lastMessageAt).getTime() : 0;
					const tb = b.lastMessageAt ? new Date(b.lastMessageAt).getTime() : 0;
					return tb - ta;
				})
				.slice(0, RECENT_NARRATORS_LIMIT)
		);
	}, [data]);

	if (recentNarrators.length === 0) return null;

	return (
		<Card withBorder>
			<Text size="xs" tt="uppercase" fw={700} c="dimmed" mb="sm">
				{t("recentNarrators")}
			</Text>
			<Stack gap="xs">
				{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
				{recentNarrators.map((narrator: any) => (
					<UnstyledButton
						key={narrator.id}
						onClick={() =>
							navigate({
								// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
								to: "/narrators/$narratorId" as any,
								// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
								params: { narratorId: narrator.id } as any,
							})
						}
					>
						<Group justify="space-between" wrap="nowrap">
							<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
								<Text size="sm" fw={500} truncate>
									{narrator.title || narrator.id.slice(0, 8)}
								</Text>
								<Badge
									size="sm"
									color={NARRATOR_STATUS_COLORS[narrator.status as string] ?? "gray"}
								>
									{narrator.status}
								</Badge>
							</Group>
							<Group gap="xs" wrap="nowrap">
								<Text size="xs" c="dimmed">
									{narrator.chapterId ? t("chapterSession") : t("standaloneSession")}
								</Text>
								{narrator.lastMessageAt && (
									<Text size="xs" c="dimmed">
										{formatSmartTime(narrator.lastMessageAt)}
									</Text>
								)}
							</Group>
						</Group>
					</UnstyledButton>
				))}
			</Stack>
		</Card>
	);
}
