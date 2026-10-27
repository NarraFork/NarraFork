import {
	Badge,
	Button,
	Card,
	Group,
	Loader,
	SimpleGrid,
	Stack,
	Text,
	Title,
	Tooltip,
} from "@mantine/core";
import { resolveToolRowStatusMark, type ToolRowStatusMark } from "@shared/tool-row-status";
import {
	IconBan,
	IconCircleX,
	IconClock,
	IconFolder,
	IconPlayerPause,
	IconShield,
	IconSubtask,
} from "@tabler/icons-react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { loadedHumanAttentionItems, useHumanAttention } from "../../hooks/useHumanAttention";
import { api } from "../../lib/api";
import { formatSmartTime } from "../../lib/format";
import { getEffectiveNarratorDisplay } from "../../lib/status-registry";
import { subagentRecentCallSummary, traceRowTitle } from "../narrator/tool-call/tool-display";
import { NarratorStatusIcon } from "../nav/NarratorStatusIcon";
import {
	NotificationCenterLazyDrawer,
	preloadNotificationCenterDrawer,
} from "../notifications/NotificationCenterLazyDrawer";
import type { ActivityToolRow, NarratorActivity } from "./dashboard-activity";
import {
	buildDashboardSessions,
	type DashboardNarrator,
	type DashboardSession,
	directoryLabel,
} from "./dashboard-sessions";
import { useNarratorActivity } from "./useNarratorActivity";

const SESSIONS_QUERY_GC_TIME_MS = 30_000;
const LIVE_REFETCH_INTERVAL_MS = 15_000;
const RECENT_REFETCH_INTERVAL_MS = 60_000;
const LIVE_LIST_LIMIT = 30;
const RECENT_LIST_LIMIT = 50;
/** Cap on activity subscriptions, well under the per-connection subscription limit. */
const MAX_ACTIVITY_SUBSCRIPTIONS = 40;

function narratorListQuery(status: "working" | "waiting" | null) {
	return {
		queryKey: ["narrators", "dashboard", status ?? "recent"],
		queryFn: () =>
			api.listNarratorsPaginated({
				...(status ? { status } : {}),
				limit: status ? LIVE_LIST_LIMIT : RECENT_LIST_LIMIT,
				sortBy: "updatedAt",
				sortOrder: "desc",
			}),
		gcTime: SESSIONS_QUERY_GC_TIME_MS,
		refetchInterval: status ? LIVE_REFETCH_INTERVAL_MS : RECENT_REFETCH_INTERVAL_MS,
	};
}

/** Grouped dashboard sessions with their live activity overlay. */
export function useDashboardSessions() {
	const attention = useHumanAttention();
	const working = useQuery(narratorListQuery("working"));
	const waiting = useQuery(narratorListQuery("waiting"));
	const recent = useQuery(narratorListQuery(null));

	const attentionPages = attention.data?.pages;
	const attentionItems = useMemo(() => loadedHumanAttentionItems(attentionPages), [attentionPages]);
	const narrators = useMemo(
		() =>
			[
				...((working.data?.items ?? []) as DashboardNarrator[]),
				...((waiting.data?.items ?? []) as DashboardNarrator[]),
				...((recent.data?.items ?? []) as DashboardNarrator[]),
			] satisfies DashboardNarrator[],
		[working.data, waiting.data, recent.data],
	);

	// Watch what can change on its own: sessions that need the user or are running.
	// Their live status also decides the grouping, so it is fed back in below.
	const initial = useMemo(
		() => buildDashboardSessions({ attentionItems, narrators, activity: new Map() }),
		[attentionItems, narrators],
	);
	const watchedIds = useMemo(
		() =>
			[...initial.attention, ...initial.running]
				.map((session) => session.narratorId)
				.slice(0, MAX_ACTIVITY_SUBSCRIPTIONS),
		[initial],
	);
	const activity = useNarratorActivity(watchedIds);
	const groups = useMemo(
		() => buildDashboardSessions({ attentionItems, narrators, activity }),
		[attentionItems, narrators, activity],
	);

	return {
		groups,
		activity,
		attention,
		isLoading: working.isLoading || waiting.isLoading || recent.isLoading || attention.isLoading,
	};
}

export function DashboardSessions({ data }: { data: ReturnType<typeof useDashboardSessions> }) {
	const { t } = useTranslation("dashboard");
	const { t: tn } = useTranslation("narrator");
	const [inboxOpened, setInboxOpened] = useState(false);
	const { groups, activity, attention, isLoading } = data;
	const empty =
		groups.attention.length === 0 && groups.running.length === 0 && groups.recent.length === 0;

	if (isLoading && empty) {
		return (
			<Group justify="center" py="xl">
				<Loader size="sm" />
			</Group>
		);
	}

	return (
		<Stack gap="xl">
			{attention.isError && (
				<Group gap="xs">
					<Text size="sm" c="red">
						{tn("humanAttentionLoadError")}
					</Text>
					<Button
						size="compact-xs"
						variant="subtle"
						onClick={() => void attention.refetch()}
						loading={attention.isFetching}
					>
						{tn("humanAttentionRetry")}
					</Button>
				</Group>
			)}

			{groups.attention.length > 0 && (
				<Section
					title={t("sections.needsYou")}
					count={groups.attention.length}
					more={attention.hasNextPage}
					action={
						<Button
							size="compact-sm"
							variant="subtle"
							onPointerEnter={preloadNotificationCenterDrawer}
							onFocus={preloadNotificationCenterDrawer}
							onPointerDown={preloadNotificationCenterDrawer}
							onClick={() => setInboxOpened(true)}
						>
							{t("openInbox")}
						</Button>
					}
				>
					{groups.attention.map((session) => (
						<SessionCard
							key={session.narratorId}
							session={session}
							activity={activity.get(session.narratorId)}
						/>
					))}
				</Section>
			)}

			<Section title={t("sections.running")} count={groups.running.length}>
				{groups.running.length === 0 ? (
					<Text size="sm" c="dimmed">
						{t("noActiveNarrators")}
					</Text>
				) : (
					groups.running.map((session) => (
						<SessionCard
							key={session.narratorId}
							session={session}
							activity={activity.get(session.narratorId)}
						/>
					))
				)}
			</Section>

			{groups.recent.length > 0 && (
				<Section
					title={t("sections.recent")}
					action={
						<Button size="compact-sm" variant="subtle" component={Link} to="/narrators">
							{t("viewAll")}
						</Button>
					}
				>
					{groups.recent.map((session) => (
						<SessionCard key={session.narratorId} session={session} />
					))}
				</Section>
			)}

			<NotificationCenterLazyDrawer
				opened={inboxOpened}
				onClose={() => setInboxOpened(false)}
				initialTab="attention"
			/>
		</Stack>
	);
}

function Section({
	title,
	count,
	more,
	action,
	children,
}: {
	title: string;
	count?: number;
	more?: boolean;
	action?: React.ReactNode;
	children: React.ReactNode;
}) {
	return (
		<Stack gap="sm">
			<Group justify="space-between" wrap="nowrap">
				<Group gap="xs" wrap="nowrap">
					<Title order={4}>{title}</Title>
					{count != null && count > 0 && (
						<Badge variant="light" color="gray" size="sm">
							{count}
							{more ? "+" : ""}
						</Badge>
					)}
				</Group>
				{action}
			</Group>
			{Array.isArray(children) || children ? (
				<SimpleGrid cols={{ base: 1, sm: 2, lg: 3 }} spacing="sm">
					{children}
				</SimpleGrid>
			) : null}
		</Stack>
	);
}

function SessionCard({
	session,
	activity,
}: {
	session: DashboardSession;
	activity?: NarratorActivity;
}) {
	const { t } = useTranslation("dashboard");
	const { t: tc } = useTranslation("common");
	const { t: tn } = useTranslation("narrator");
	const display = getEffectiveNarratorDisplay(session.status, session.substatus);
	const decision = session.decision;
	const tools = activity?.tools ?? [];
	const accent = decision
		? decision.blocking
			? "var(--mantine-color-yellow-filled)"
			: "var(--mantine-color-blue-filled)"
		: session.errored
			? "var(--mantine-color-red-filled)"
			: undefined;

	return (
		<Card
			withBorder
			shadow="sm"
			padding="sm"
			component={Link}
			to="/narrators/$narratorId"
			// biome-ignore lint/suspicious/noExplicitAny: Card's polymorphic props lose route typing
			params={{ narratorId: session.narratorId } as any}
			style={{
				textDecoration: "none",
				color: "inherit",
				...(accent ? { borderLeft: `3px solid ${accent}` } : {}),
			}}
		>
			<Stack gap={6}>
				<Group justify="space-between" wrap="nowrap" gap="xs">
					<Group gap="xs" wrap="nowrap" style={{ minWidth: 0 }}>
						<Tooltip label={tc(display.i18nKey)} openDelay={400}>
							<span style={{ display: "inline-flex", flexShrink: 0 }}>
								<NarratorStatusIcon
									size={18}
									status={session.status}
									substatus={session.substatus}
									activeBackgroundWorkCount={session.activeBackgroundWorkCount}
								/>
							</span>
						</Tooltip>
						<Text fw={500} truncate>
							{session.title}
						</Text>
					</Group>
					{session.time && (
						<Text size="xs" c="dimmed" style={{ flexShrink: 0 }}>
							{formatSmartTime(session.time)}
						</Text>
					)}
				</Group>

				<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
					<Text size="xs" c="dimmed" tt="none" style={{ display: "inline-flex", flexShrink: 0 }}>
						<IconFolder size={13} />
					</Text>
					<Text size="xs" c="dimmed" truncate title={session.cwd ?? undefined} style={{ flex: 1 }}>
						{session.cwd ? directoryLabel(session.cwd) : "—"}
					</Text>
					{session.activeBackgroundWorkCount > 0 && (
						<Tooltip label={t("backgroundWork", { count: session.activeBackgroundWorkCount })}>
							<Badge
								size="xs"
								variant="light"
								color="blue"
								leftSection={<IconSubtask size={10} />}
								style={{ flexShrink: 0 }}
							>
								{session.activeBackgroundWorkCount}
							</Badge>
						</Tooltip>
					)}
				</Group>

				{decision ? (
					<Stack gap={2}>
						<Group gap={6} wrap="nowrap">
							<Badge size="xs" variant="light" color={decision.blocking ? "yellow" : "blue"}>
								{tn(`humanAttentionKind.${decision.kind}`)}
							</Badge>
							{decision.count > 1 && (
								<Text size="xs" c="dimmed">
									{t("moreDecisions", { count: decision.count - 1 })}
								</Text>
							)}
						</Group>
						{decision.summary && (
							<Text size="sm" lineClamp={2}>
								{decision.summary}
							</Text>
						)}
					</Stack>
				) : session.errored ? (
					<Text size="xs" c="red">
						{tc(display.i18nKey)}
					</Text>
				) : null}

				{tools.length > 0 ? (
					<Stack gap={2}>
						{tools.map((tool) => (
							<ToolRow key={tool.toolUseId} tool={tool} />
						))}
					</Stack>
				) : !decision && !session.errored && session.status !== "idle" ? (
					<Text size="xs" c="dimmed">
						{tc(display.i18nKey)}
					</Text>
				) : null}
			</Stack>
		</Card>
	);
}

const TOOL_MARK_SIZE = 12;

/**
 * A compact row's status glyph. Same mark rule (`@shared/tool-row-status`: success
 * unmarked, only `running` moves) and the same icons/hues as the vlist trace rows;
 * drawn here because nothing outside `vlist/` may import it statically.
 */
function ToolMarkGlyph({ mark }: { mark: ToolRowStatusMark }) {
	const props = { size: TOOL_MARK_SIZE, style: { flexShrink: 0 } } as const;
	switch (mark) {
		case "running":
			return <Loader size={10} />;
		case "queued":
			return <IconClock {...props} color="var(--mantine-color-slate-5)" />;
		case "reflecting":
			return <IconShield {...props} color="var(--mantine-color-indigo-6)" />;
		case "awaiting":
			return <IconPlayerPause {...props} color="var(--mantine-color-yellow-6)" />;
		case "failed":
			return <IconCircleX {...props} color="var(--mantine-color-red-6)" />;
		default:
			return <IconBan {...props} color="var(--mantine-color-orange-6)" />;
	}
}

/** One recent tool call: the same label and status mark as a subagent card's row. */
function ToolRow({ tool }: { tool: ActivityToolRow }) {
	const mark = resolveToolRowStatusMark(tool.status);
	const label = traceRowTitle(
		tool.toolName,
		subagentRecentCallSummary(tool.toolName, tool.inputSummary ?? null),
	);
	return (
		<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
			<span
				style={{
					width: TOOL_MARK_SIZE,
					height: TOOL_MARK_SIZE,
					flexShrink: 0,
					display: "flex",
					alignItems: "center",
					justifyContent: "center",
				}}
			>
				{mark ? <ToolMarkGlyph mark={mark} /> : null}
			</span>
			<Text size="xs" c={mark === "running" ? undefined : "dimmed"} ff="monospace" truncate>
				{label}
			</Text>
		</Group>
	);
}
