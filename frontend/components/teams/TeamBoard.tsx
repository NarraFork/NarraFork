/**
 * The team board (docs/PROJECT_TEAMS-PLAN.md §二.4; P4): five columns from the work item states,
 * each a section of cards that pages on demand. Stacked vertically so the same board fits the
 * page's right pane and a 360 px phone; finished columns start folded.
 */
import { NarratorStatusIcon } from "@frontend/components/nav/NarratorStatusIcon";
import {
	OutlineStatusChip,
	OutlineStatusIcon,
} from "@frontend/components/outline/OutlineStatusIcon";
import { useTeamBoardColumn } from "@frontend/hooks/useTeams";
import {
	Alert,
	Badge,
	Button,
	Card,
	Group,
	Loader,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import type { TeamBoardColumn, TeamBoardItem, TeamPageSummary } from "@shared/project-teams";
import {
	IconAlertTriangle,
	IconChevronDown,
	IconChevronRight,
	IconCircleCheck,
	IconGitBranch,
	IconLock,
	IconTrash,
} from "@tabler/icons-react";
import { useState } from "react";
import { useTranslation } from "react-i18next";
import {
	BOARD_COLUMN_STATUS_ICON,
	type CardMark,
	cardMarks,
	cardNeedsStateChip,
	columnStartsFolded,
	columnTotal,
	liveWorkerStatus,
	TEAM_BOARD_COLUMNS,
	WORK_ITEM_STATUS_ICON,
} from "./team-page-model";

const MARK_ICON: Record<CardMark, typeof IconLock> = {
	exclusive: IconLock,
	cleanable: IconTrash,
};
const MARK_COLOR: Record<CardMark, string> = {
	exclusive: "indigo",
	cleanable: "gray",
};

export function TeamBoardCard({
	item,
	onOpenSession,
	summary,
}: {
	item: TeamBoardItem;
	onOpenSession?: (narratorId: string) => void;
	/** Keeps the worker's status current without refetching the board. */
	summary?: TeamPageSummary;
}) {
	const { t } = useTranslation("projects");
	const marks = cardMarks(item);
	const workerStatus = item.worker ? liveWorkerStatus(item.worker, summary) : null;
	return (
		<Card
			withBorder
			padding="xs"
			radius="sm"
			data-testid="team-card"
			data-item-id={item.id}
			data-state={item.state}
		>
			<Stack gap={6}>
				<Group gap={6} wrap="nowrap" align="flex-start">
					<OutlineStatusIcon
						status={WORK_ITEM_STATUS_ICON[item.state]}
						size={16}
						label={t(`teams.states.${item.state}`)}
					/>
					<Text size="sm" fw={500} style={{ flex: 1, minWidth: 0, overflowWrap: "anywhere" }}>
						{item.title}
					</Text>
				</Group>
				{cardNeedsStateChip(item) && (
					<OutlineStatusChip
						status={WORK_ITEM_STATUS_ICON[item.state]}
						style={{ alignSelf: "flex-start" }}
						data-testid="team-card-state"
					>
						{t(`teams.states.${item.state}`)}
					</OutlineStatusChip>
				)}
				<Group gap={4} wrap="nowrap" c="dimmed" style={{ minWidth: 0 }}>
					<IconGitBranch size={14} aria-hidden style={{ flexShrink: 0 }} />
					<Text
						size="xs"
						ff="monospace"
						truncate
						data-testid="team-card-branch"
						title={item.branch ?? undefined}
					>
						{item.branch ?? t("teams.board.noBranch")}
					</Text>
				</Group>
				<Group gap={6} wrap="wrap" justify="space-between">
					{item.worker ? (
						<UnstyledButton
							onClick={() => item.worker && onOpenSession?.(item.worker.id)}
							disabled={!onOpenSession}
							data-testid="team-card-worker"
							data-status={workerStatus ?? undefined}
							style={{ display: "inline-flex", alignItems: "center", gap: 4, minWidth: 0 }}
						>
							<NarratorStatusIcon size={14} status={workerStatus} />
							<Text size="xs" truncate maw={160}>
								{item.worker.title || item.worker.id}
							</Text>
						</UnstyledButton>
					) : (
						<Text size="xs" c="dimmed">
							{t("teams.board.noWorker")}
						</Text>
					)}
					{item.lastReview && (
						<Badge
							size="xs"
							variant="light"
							tt="none"
							color={item.lastReview === "clear" ? "green" : "red"}
							leftSection={
								item.lastReview === "clear" ? (
									<IconCircleCheck size={10} aria-hidden />
								) : (
									<IconAlertTriangle size={10} aria-hidden />
								)
							}
							data-testid="team-card-verdict"
							data-verdict={item.lastReview}
						>
							{t(`teams.board.verdict.${item.lastReview}`)}
							{" · "}
							{t("teams.board.reviewRounds", { count: item.reviewRounds })}
						</Badge>
					)}
				</Group>
				{marks.length > 0 && (
					<Group gap={4} data-testid="team-card-marks">
						{marks.map((mark) => {
							const Icon = MARK_ICON[mark];
							const label = t(`teams.board.marks.${mark}`, { key: item.exclusiveKey ?? "" });
							return (
								<Tooltip key={mark} label={label} withinPortal>
									<Badge
										size="xs"
										variant="light"
										color={MARK_COLOR[mark]}
										tt="none"
										leftSection={<Icon size={10} aria-hidden />}
										data-mark={mark}
										aria-label={label}
									>
										{mark === "exclusive" ? item.exclusiveKey : null}
									</Badge>
								</Tooltip>
							);
						})}
					</Group>
				)}
			</Stack>
		</Card>
	);
}

function BoardColumn({
	projectId,
	teamId,
	column,
	summary,
	onOpenSession,
}: {
	projectId: string;
	teamId: string;
	column: TeamBoardColumn;
	summary: TeamPageSummary | undefined;
	onOpenSession?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("projects");
	const [open, setOpen] = useState(!columnStartsFolded(column));
	const pages = useTeamBoardColumn(projectId, teamId, column, open);
	const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
	const total = columnTotal(column, summary, items.length);
	const name = t(`teams.columns.${column}`);
	return (
		<Stack gap={6} data-testid="team-column" data-column={column} data-count={total}>
			<UnstyledButton
				onClick={() => setOpen((value) => !value)}
				aria-expanded={open}
				aria-label={t(open ? "teams.board.collapse" : "teams.board.expand", { column: name })}
				data-testid="team-column-toggle"
				style={{ display: "flex", alignItems: "center", gap: 6, minHeight: 28 }}
			>
				{open ? (
					<IconChevronDown size={14} aria-hidden />
				) : (
					<IconChevronRight size={14} aria-hidden />
				)}
				<OutlineStatusIcon status={BOARD_COLUMN_STATUS_ICON[column]} size={16} />
				<Text size="sm" fw={600}>
					{name}
				</Text>
				<Badge size="sm" variant="light" color="gray" data-testid="team-column-count">
					{total}
				</Badge>
			</UnstyledButton>
			{open && (
				<Stack gap={6} pl={4}>
					{pages.isLoading && <Loader size="xs" />}
					{pages.isError && (
						<Alert color="red" p="xs">
							{t("teams.board.loadFailed")}
						</Alert>
					)}
					{pages.isSuccess && items.length === 0 && (
						<Text size="xs" c="dimmed" data-testid="team-column-empty">
							{t("teams.board.empty")}
						</Text>
					)}
					{items.map((item) => (
						<TeamBoardCard
							key={item.id}
							item={item}
							onOpenSession={onOpenSession}
							summary={summary}
						/>
					))}
					{pages.hasNextPage && (
						<Button
							size="xs"
							variant="subtle"
							loading={pages.isFetchingNextPage}
							onClick={() => void pages.fetchNextPage()}
						>
							{t("teams.loadMore")}
						</Button>
					)}
				</Stack>
			)}
		</Stack>
	);
}

export function TeamBoard({
	projectId,
	teamId,
	summary,
	onOpenSession,
}: {
	projectId: string;
	teamId: string;
	summary: TeamPageSummary | undefined;
	onOpenSession?: (narratorId: string) => void;
}) {
	return (
		<Stack gap="md" data-testid="team-board">
			{TEAM_BOARD_COLUMNS.map((column) => (
				<BoardColumn
					key={column}
					projectId={projectId}
					teamId={teamId}
					column={column}
					summary={summary}
					onOpenSession={onOpenSession}
				/>
			))}
		</Stack>
	);
}
