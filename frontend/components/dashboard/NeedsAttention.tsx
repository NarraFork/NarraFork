import { Alert, Badge, Card, Group, Loader, Stack, Text, ThemeIcon, Title } from "@mantine/core";
import { IconAlertCircle, IconExclamationMark } from "@tabler/icons-react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useTranslation } from "react-i18next";
import { api } from "../../lib/api";

const NEEDS_ATTENTION_QUERY_GC_TIME_MS = 30_000;
const MAX_ITEMS = 5;
const ERROR_MESSAGE_MAX_LENGTH = 60;

// biome-ignore lint/suspicious/noExplicitAny: ApiEntity is loosely typed
type NarratorEntity = any;

interface AttentionItem {
	id: string;
	title: string;
	subtitle: string;
}

function truncate(text: string, maxLength: number): string {
	if (text.length <= maxLength) return text;
	return `${text.slice(0, maxLength)}…`;
}

function toAttentionItems(narrators: NarratorEntity[], subtitle: string): AttentionItem[] {
	return narrators.map((n) => ({
		id: n.id,
		title: n.title ?? n.id,
		subtitle,
	}));
}

export function NeedsAttention() {
	const { t } = useTranslation("dashboard");

	const { data: waitingData, isLoading: waitingLoading } = useQuery({
		queryKey: ["narrators", "waiting-attention"],
		queryFn: () => api.listNarratorsPaginated({ standalone: "all", status: "waiting", limit: 20 }),
		gcTime: NEEDS_ATTENTION_QUERY_GC_TIME_MS,
	});

	const { data: recentData, isLoading: recentLoading } = useQuery({
		queryKey: ["narrators", "failed-attention"],
		queryFn: () =>
			api.listNarratorsPaginated({
				standalone: "all",
				limit: 50,
				sortBy: "updatedAt",
				sortOrder: "desc",
			}),
		gcTime: NEEDS_ATTENTION_QUERY_GC_TIME_MS,
	});

	const waitingNarrators: NarratorEntity[] = useMemo(() => waitingData?.items ?? [], [waitingData]);

	const permissionQueries = useQueries({
		queries: waitingNarrators.map((n: NarratorEntity) => ({
			queryKey: ["permissions", n.id],
			queryFn: () => api.getPendingPermissions(n.id),
			gcTime: NEEDS_ATTENTION_QUERY_GC_TIME_MS,
			retry: false,
		})),
	});

	// Only surface narrators that have at least one *visible* pending item.
	// The backend's getPendingPermissions hides non-awaiting_user reflections
	// (danger/plan/task/question) via shouldHidePendingPermission, so a narrator
	// whose waiting status comes purely from an in-flight reflection (running)
	// returns an empty array here and must NOT be flagged as needing attention.
	// On query error (q.data === undefined) we fall back to showing the narrator
	// to avoid hiding a genuine permission request.
	const visibleWaitingNarrators = useMemo(() => {
		return waitingNarrators.filter((_n: NarratorEntity, i: number) => {
			const q = permissionQueries[i];
			if (!q) return false;
			if (q.data === undefined) return true; // error / still settling → keep visible
			return Array.isArray(q.data) && q.data.length > 0;
		});
	}, [waitingNarrators, permissionQueries]);

	const waitingItems = useMemo<AttentionItem[]>(() => {
		return toAttentionItems(visibleWaitingNarrators, t("waitingPermission"));
	}, [visibleWaitingNarrators, t]);

	const failedItems = useMemo<AttentionItem[]>(() => {
		const failed = (recentData?.items ?? []).filter((n: NarratorEntity) => n.errorMessage);
		return failed.map((n: NarratorEntity) => ({
			id: n.id,
			title: n.title ?? n.id,
			subtitle: truncate(String(n.errorMessage), ERROR_MESSAGE_MAX_LENGTH),
		}));
	}, [recentData]);

	const permissionsLoading = permissionQueries.some((q) => q.isLoading);
	const isLoading =
		waitingLoading || recentLoading || (waitingNarrators.length > 0 && permissionsLoading);

	const waitingCount = waitingItems.length;
	const failedCount = failedItems.length;
	const allClear = waitingCount === 0 && failedCount === 0;

	return (
		<Card withBorder>
			<Group justify="space-between" mb="sm">
				<Title order={4}>{t("needsAttention")}</Title>
				{isLoading && <Loader size="sm" />}
			</Group>

			{isLoading ? null : allClear ? (
				<Alert color="green" variant="light">
					{t("allClear")}
				</Alert>
			) : (
				<Stack gap="sm">
					{waitingCount > 0 && (
						<AttentionSection
							icon={
								<ThemeIcon color="yellow" variant="light" size="lg">
									<IconAlertCircle size={18} />
								</ThemeIcon>
							}
							title={t("waitingPermission")}
							count={waitingCount}
							items={waitingItems}
						/>
					)}
					{failedCount > 0 && (
						<AttentionSection
							icon={
								<ThemeIcon color="red" variant="light" size="lg">
									<IconExclamationMark size={18} />
								</ThemeIcon>
							}
							title={t("failedNarrators")}
							count={failedCount}
							items={failedItems}
						/>
					)}
				</Stack>
			)}
		</Card>
	);
}

function AttentionSection({
	icon,
	title,
	count,
	items,
}: {
	icon: React.ReactNode;
	title: string;
	count: number;
	items: AttentionItem[];
}) {
	const { t } = useTranslation("dashboard");
	const visibleItems = items.slice(0, MAX_ITEMS);

	return (
		<Card withBorder padding="sm">
			<Group gap="sm" mb="xs">
				{icon}
				<Text fw={500}>{title}</Text>
				<Badge size="sm" variant="light">
					{count}
				</Badge>
			</Group>
			<Stack gap={4}>
				{visibleItems.map((item) => (
					<Text
						key={item.id}
						component={Link}
						to="/narrators/$narratorId"
						// biome-ignore lint/suspicious/noExplicitAny: dynamic route params
						params={{ narratorId: item.id } as any}
						style={{ textDecoration: "none", color: "inherit" }}
						size="sm"
						lineClamp={1}
					>
						<Text span fw={500}>
							{item.title}
						</Text>{" "}
						<Text span size="xs" c="dimmed">
							{item.subtitle}
						</Text>
					</Text>
				))}
				{count > MAX_ITEMS && (
					<Text size="xs" c="dimmed">
						{t("viewAll")}
					</Text>
				)}
			</Stack>
		</Card>
	);
}
