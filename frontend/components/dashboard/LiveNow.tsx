import { Badge, Card, Group, Loader, ScrollArea, Stack, Text, Title } from "@mantine/core";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

const LIVE_NOW_GC_TIME_MS = 30_000;
const LIVE_NOW_REFETCH_INTERVAL_MS = 15_000;

function parseSubstatus(raw: unknown): string[] {
	if (typeof raw !== "string" || !raw) return [];
	try {
		const parsed = JSON.parse(raw);
		return Array.isArray(parsed) ? parsed.filter((s): s is string => typeof s === "string") : [];
	} catch {
		return [];
	}
}

function formatRelativeTime(iso: unknown, t: TFunction): string {
	if (typeof iso !== "string" || !iso) return "-";
	const timestamp = new Date(iso).getTime();
	if (!Number.isFinite(timestamp)) return "-";
	const diffMinutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60_000));
	if (diffMinutes < 60) return t("minutesAgo", { count: diffMinutes });
	return t("hoursAgo", { count: Math.floor(diffMinutes / 60) });
}

export function LiveNow() {
	const { t } = useTranslation("dashboard");
	const { data, isLoading } = useQuery({
		queryKey: ["narrators", "working-live"],
		queryFn: () =>
			api.listNarratorsPaginated({
				standalone: "all",
				status: "working",
				limit: 20,
				sortBy: "updatedAt",
				sortOrder: "desc",
			}),
		gcTime: LIVE_NOW_GC_TIME_MS,
		refetchInterval: LIVE_NOW_REFETCH_INTERVAL_MS,
	});

	const narrators = data?.items ?? [];

	return (
		<Card withBorder>
			<Title order={4} mb="sm">
				{t("liveNow")}
			</Title>
			{isLoading ? (
				<Loader size="sm" />
			) : narrators.length === 0 ? (
				<Text c="dimmed" size="sm">
					{t("noActiveNarrators")}
				</Text>
			) : (
				<ScrollArea>
					<Group wrap="nowrap" gap="md" align="stretch">
						{/* biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure */}
						{narrators.map((narrator: any) => {
							const substatus = parseSubstatus(narrator.substatus);
							return (
								<Card
									key={narrator.id}
									withBorder
									w={260}
									component={Link}
									to="/narrators/$narratorId"
									// biome-ignore lint/suspicious/noExplicitAny: dynamic JSON structure
									params={{ narratorId: narrator.id } as any}
									style={{ textDecoration: "none", cursor: "pointer", flexShrink: 0 }}
								>
									<Stack gap="xs">
										<Text fw={700} lineClamp={1}>
											{narrator.title}
										</Text>
										<Group gap="xs">
											<Badge color="green" size="sm">
												{narrator.status}
											</Badge>
											{substatus.map((s) => (
												<Badge key={s} color="gray" variant="light" size="sm">
													{s}
												</Badge>
											))}
										</Group>
										<Text size="xs" c="dimmed">
											{formatRelativeTime(narrator.lastMessageAt, t)}
										</Text>
										<Text size="xs" c="dimmed">
											${(narrator.totalCostUsd ?? 0).toFixed(2)}
										</Text>
									</Stack>
								</Card>
							);
						})}
					</Group>
				</ScrollArea>
			)}
		</Card>
	);
}
