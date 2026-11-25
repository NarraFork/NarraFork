/**
 * The team page's body (the redesign R): the header, 「等你处理」, the coordinator's conversation
 * and the right column (the work list or the activity), the work item drawer, and the dialogs of
 * the header's menu. The route passes the coordinator's conversation (the narrator panel) and
 * the navigation; the browser fixture passes a stand-in conversation.
 *
 * Reads: the team, its live summary (`useTeamSummary`), the open board columns (queued, in
 * progress, review: one page of 50 each), the pending calls (members only), the members (for the
 * header's avatars) and the sizes of the items shown (`work-stats`, at most 50).
 */

import { useProject } from "@frontend/hooks/useProjects";
import {
	teamsUnavailable,
	useArchiveTeam,
	useTeam,
	useTeamApprovals,
	useTeamBoardColumn,
	useTeamSummary,
	useTeamWorkStats,
} from "@frontend/hooks/useTeams";
import { APP_SHELL_FULL_BLEED_HEIGHT } from "@frontend/lib/safe-area";
import { Alert, Box, Skeleton } from "@mantine/core";
import { notifications } from "@mantine/notifications";
import type { TeamBoardItem } from "@shared/project-teams";
import { type ReactNode, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { TeamActivity } from "./TeamActivity";
import { TeamAttention } from "./TeamAttention";
import { TeamDisbandDialog } from "./TeamDisbandDialog";
import { TeamHeader } from "./TeamHeader";
import { TeamSettingsModal } from "./TeamSettingsModal";
import { TeamReadOnlyStart, TeamStart } from "./TeamStart";
import { TeamWorkDrawer } from "./TeamWorkDrawer";
import { TeamWorkList } from "./TeamWorkList";
import { TeamWorkspace } from "./TeamWorkspace";
import {
	attentionEntries,
	onlookerSeesWaiting,
	statusSentence,
	teamPageMode,
	teamPinTitle,
	unfinishedCount,
	workGroups,
} from "./team-page-model";

export function TeamPageView({
	projectId,
	teamId,
	conversation,
	onOpenSession,
	onOpenCoordinatorSession,
	onBack,
	onDisbanded,
}: {
	projectId: string;
	teamId: string;
	conversation: ReactNode;
	onOpenSession?: (narratorId: string) => void;
	/** The coordinator's own session page (the 「…」 menu's 协调者完整会话). */
	onOpenCoordinatorSession?: () => void;
	onBack: () => void;
	/** After the team was disbanded: its session is kept (the route opens it). */
	onDisbanded?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const team = useTeam(projectId, teamId);
	const project = useProject(projectId);
	const summary = useTeamSummary(projectId, teamId);
	const member = summary.data?.access === "write";
	const approvals = useTeamApprovals(projectId, teamId, member);
	const queued = useTeamBoardColumn(projectId, teamId, "queued");
	const inProgress = useTeamBoardColumn(projectId, teamId, "in_progress");
	const review = useTeamBoardColumn(projectId, teamId, "review");
	const columns = [queued, inProgress, review];
	const items: TeamBoardItem[] = useMemo(
		() =>
			[queued.data, inProgress.data, review.data].flatMap(
				(data) => data?.pages.flatMap((page) => page.items) ?? [],
			),
		[queued.data, inProgress.data, review.data],
	);
	const [finishedIds, setFinishedIds] = useState<Record<"done" | "cancelled", string[]>>({
		done: [],
		cancelled: [],
	});
	const onVisibleFinishedIds = useCallback(
		(column: "done" | "cancelled", ids: string[]) =>
			setFinishedIds((current) =>
				current[column].join(",") === ids.join(",") ? current : { ...current, [column]: ids },
			),
		[],
	);
	const statIds = useMemo(
		() =>
			// Every row shown gets its size: requested 50 at a time.
			[...items.map((item) => item.id), ...finishedIds.done, ...finishedIds.cancelled],
		[items, finishedIds],
	);
	const stats = useTeamWorkStats(projectId, teamId, statIds);
	const archive = useArchiveTeam(projectId, teamId);

	const [focusConversation, setFocusConversation] = useState(0);
	const [highlightId, setHighlightId] = useState<string | null>(null);
	const [drawer, setDrawer] = useState<{ itemId: string; returning: boolean } | null>(null);
	const [disbanding, setDisbanding] = useState(false);
	const [settingsOpen, setSettingsOpen] = useState(false);
	const [phone, setPhone] = useState(false);
	const onLayout = useCallback((layout: "split" | "tabs") => setPhone(layout === "tabs"), []);

	// The coordinator's conversation is already on this page: bring it forward, do not leave.
	const openSession = useCallback(
		(narratorId: string) => {
			if (narratorId === teamId) setFocusConversation((value) => value + 1);
			else onOpenSession?.(narratorId);
		},
		[teamId, onOpenSession],
	);
	const openItem = useCallback(
		(itemId: string, options?: { returning?: boolean }) =>
			setDrawer({ itemId, returning: !!options?.returning }),
		[],
	);

	if (team.isError)
		return teamsUnavailable(team.error) ? (
			<Alert color="gray">{t("teams.unavailable")}</Alert>
		) : (
			<Alert color="red">{t("teams.notFound")}</Alert>
		);

	const pendingCalls = member ? (approvals.data?.approvals ?? []) : [];
	const entries = attentionEntries({ member, approvals: pendingCalls, items });
	const groups = workGroups(
		items,
		pendingCalls,
		member ? undefined : (item) => onlookerSeesWaiting(item, summary.data),
	);
	const mode = teamPageMode(summary.data);
	const archived = summary.data?.coordinatorStatus === "archived";
	const base = team.data?.baseBranch ?? "main";
	const status = summary.data
		? statusSentence({
				summary: summary.data,
				member,
				waiting: member ? entries.length : groups.needsYou.length,
				waitingItems: groups.needsYou.length,
				waitingMore: member && (approvals.data?.more ?? false),
			})
		: null;
	const openCount = summary.data ? unfinishedCount(summary.data) : items.length;
	const canDisband = member && !!onDisbanded;

	return (
		// Full bleed in the app shell's content box, like a session page.
		<Box
			h={APP_SHELL_FULL_BLEED_HEIGHT}
			mx="calc(var(--mantine-spacing-md) * -1)"
			my="calc(var(--mantine-spacing-md) * -1)"
			style={{ overflow: "hidden", display: "flex", flexDirection: "column" }}
			data-testid="team-page"
		>
			<TeamWorkspace
				focusConversation={focusConversation}
				onLayout={onLayout}
				openCount={openCount}
				header={(layout) => (
					<TeamHeader
						projectId={projectId}
						teamId={teamId}
						projectName={project.data?.name ?? null}
						title={team.data?.name ?? <Skeleton height={18} width={140} />}
						pinTitle={teamPinTitle(team.data, summary.data?.coordinatorStatus)}
						summary={summary.data}
						status={status}
						phone={layout === "tabs"}
						onBack={onBack}
						onOpenCoordinatorSession={onOpenCoordinatorSession}
						onOpenSettings={() => setSettingsOpen(true)}
						onOpenSession={openSession}
						onDisband={canDisband ? () => setDisbanding(true) : undefined}
					/>
				)}
				attention={(layout) => (
					<TeamAttention
						entries={entries}
						phone={layout === "tabs"}
						teamId={teamId}
						base={base}
						stats={stats.stats}
						more={approvals.data?.more ?? false}
						unscanned={approvals.data?.unscanned ?? false}
						onOpenCoordinatorSession={onOpenCoordinatorSession}
						onHover={setHighlightId}
						onOpenItem={openItem}
						onOpenSession={openSession}
					/>
				)}
				conversation={conversation}
				conversationOverlay={
					// Only members can tell the coordinator anything; others see a plain line.
					mode.starting ? member ? <TeamStart teamId={teamId} /> : <TeamReadOnlyStart /> : undefined
				}
				work={
					<TeamWorkList
						projectId={projectId}
						teamId={teamId}
						summary={summary.data}
						items={items}
						approvals={pendingCalls}
						stats={stats.stats}
						base={base}
						loading={columns.some((column) => column.isLoading)}
						failed={columns.some((column) => column.isError)}
						hasMore={columns.some((column) => column.hasNextPage)}
						onLoadMore={() => {
							for (const column of columns) if (column.hasNextPage) void column.fetchNextPage();
						}}
						highlightId={highlightId}
						mode={mode}
						archiving={archive.isPending}
						onArchive={
							member && !archived
								? () =>
										archive.mutate(undefined, {
											onSuccess: () =>
												notifications.show({
													color: "green",
													message: t("teams.page.wrapUp.archived"),
												}),
											onError: () =>
												notifications.show({
													color: "red",
													message: t("teams.page.wrapUp.archiveFailed"),
												}),
										})
								: undefined
						}
						onDisband={canDisband ? () => setDisbanding(true) : undefined}
						onOpenItem={openItem}
						onVisibleFinishedIds={onVisibleFinishedIds}
					/>
				}
				activity={<TeamActivity projectId={projectId} teamId={teamId} />}
			/>
			<TeamWorkDrawer
				projectId={projectId}
				teamId={teamId}
				itemId={drawer?.itemId ?? null}
				startReturning={drawer?.returning}
				phone={phone}
				onClose={() => setDrawer(null)}
				onOpenSession={onOpenSession ? openSession : undefined}
			/>
			{canDisband && onDisbanded && (
				<TeamDisbandDialog
					projectId={projectId}
					teamId={teamId}
					opened={disbanding}
					onClose={() => setDisbanding(false)}
					onDisbanded={onDisbanded}
				/>
			)}
			<TeamSettingsModal
				projectId={projectId}
				team={team.data}
				opened={settingsOpen}
				onClose={() => setSettingsOpen(false)}
			/>
		</Box>
	);
}
