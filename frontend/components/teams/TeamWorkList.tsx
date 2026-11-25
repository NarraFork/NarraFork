/**
 * The right column's 「工作」 (the redesign R): one list in the order that means something to a
 * person, not five board columns (`team-page-model.ts:workGroups`):
 *   1. 「需要你」 (an onlooker reads 「等成员处理」): items waiting on a person's decision, or ready
 *      to accept; highlighted with the 「等你处理」 card the pointer is on;
 *   2. 「进行中」: in progress (what the worker did last, one line), then queued;
 *   3. 「评审 · 就绪」;
 *   4. 「已完成」 and 「已取消」 folded to their counts; opening one reads that column.
 * Each row: a status dot, the title, one line of what it is doing now, and `+/-`. A click opens
 * the work item drawer.
 *
 * With no work item yet the list explains where items will appear (dashed placeholders, never
 * empty columns); once everything is finished it suggests archiving or disbanding the team.
 */
import { useTeamBoardColumn } from "@frontend/hooks/useTeams";
import { formatSmartTime } from "@frontend/lib/format";
import {
	Alert,
	Box,
	Button,
	Group,
	Loader,
	Stack,
	Text,
	Tooltip,
	UnstyledButton,
} from "@mantine/core";
import type {
	TeamBoardItem,
	TeamPageSummary,
	TeamPendingApproval,
	TeamWorkDiffStat,
} from "@shared/project-teams";
import {
	IconArchive,
	IconChevronRight,
	IconFolderCode,
	IconGitBranch,
	IconLock,
} from "@tabler/icons-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import {
	type ItemMark,
	itemMarks,
	liveActivity,
	liveWorkerStatus,
	onlookerSeesWaiting,
	type RowLine,
	rowLine,
	WORK_GROUPS,
	type WorkGroup,
	type WorkRow,
	workGroups,
} from "./team-page-model";
import { ATTENTION_BG, ATTENTION_TEXT, DiffCount, MONO, StatusDot, TABULAR } from "./team-page-ui";

const TONE_TEXT: Record<RowLine["tone"], string | undefined> = {
	amber: ATTENTION_TEXT,
	green: "var(--mantine-color-green-6)",
	blue: undefined,
	gray: undefined,
	hollow: undefined,
};

export function WorkItemRow({
	row,
	stat,
	base,
	summary,
	highlighted,
	finished,
	onOpen,
}: {
	row: WorkRow;
	stat: TeamWorkDiffStat | null | undefined;
	base: string;
	summary?: TeamPageSummary;
	highlighted?: boolean;
	/** Finished rows show when they finished under the counts. */
	finished?: boolean;
	onOpen: (itemId: string) => void;
}) {
	const { t } = useTranslation("projects");
	// What it is doing now comes from the live summary when it names the worker.
	const item = { ...row.item, activity: liveActivity(row.item, summary) };
	const workerStatus = item.worker ? liveWorkerStatus(item.worker, summary) : null;
	const marks = itemMarks(item);
	const line = rowLine({ ...row, item }, workerStatus, item.baseRef ?? base);
	return (
		<UnstyledButton
			onClick={() => onOpen(item.id)}
			data-testid="team-work-row"
			data-item-id={item.id}
			data-state={item.state}
			data-highlighted={highlighted ? "true" : undefined}
			style={{
				display: "block",
				width: "100%",
				padding: "8px 10px",
				borderRadius: "var(--mantine-radius-sm)",
				background: highlighted ? ATTENTION_BG : undefined,
				transition: "background 120ms",
			}}
			className="nf-team-work-row"
		>
			<Group gap={10} wrap="nowrap" align="flex-start">
				<Box pt={6}>
					<StatusDot tone={line.tone} />
				</Box>
				<Stack gap={1} style={{ flex: 1, minWidth: 0 }}>
					<Group gap={6} wrap="nowrap" style={{ minWidth: 0 }}>
						<Text size="sm" truncate fw={500}>
							{item.title}
						</Text>
						<ItemMarks marks={marks} exclusiveKey={item.exclusiveKey} />
					</Group>
					<Text size="xs" c="dimmed" truncate data-testid="team-work-line" data-line={line.key}>
						<Text
							component="span"
							inherit
							fw={line.tone === "amber" || line.tone === "green" ? 600 : undefined}
							style={{ color: TONE_TEXT[line.tone] }}
						>
							{line.key === "activity"
								? t(`teams.page.row.tools.${line.values.tool}`, {
										defaultValue: String(line.values.tool),
									})
								: t(`teams.page.row.${line.key}`, line.values)}
						</Text>
						{line.detail && (
							<>
								{" · "}
								<Text component="span" inherit style={MONO}>
									{line.detail}
								</Text>
							</>
						)}
					</Text>
				</Stack>
				<Stack gap={1} align="flex-end" style={{ flexShrink: 0 }}>
					<DiffCount stat={stat} />
					{finished && (
						<Text size="xs" c="dimmed" style={TABULAR} title={item.updatedAt}>
							{formatSmartTime(item.updatedAt)}
						</Text>
					)}
				</Stack>
			</Group>
		</UnstyledButton>
	);
}

function GroupTitle({ label, count }: { label: string; count: number }) {
	return (
		<Group gap={6} px={10} pt={6} pb={2}>
			<Text size="xs" fw={600} c="dimmed">
				{label}
			</Text>
			<Text size="xs" c="dimmed" style={TABULAR}>
				{count}
			</Text>
		</Group>
	);
}

/** 「已完成」 / 「已取消」: a count; opened, the column's items (read only then). */
function FinishedGroup({
	projectId,
	teamId,
	column,
	count,
	base,
	stats,
	initiallyOpen = false,
	onOpenItem,
	onVisibleIds,
}: {
	projectId: string;
	teamId: string;
	column: "done" | "cancelled";
	count: number;
	base: string;
	stats: Record<string, TeamWorkDiffStat | null> | undefined;
	initiallyOpen?: boolean;
	onOpenItem: (itemId: string) => void;
	onVisibleIds?: (column: "done" | "cancelled", ids: string[]) => void;
}) {
	const { t } = useTranslation("projects");
	// Follows `initiallyOpen` (the wrap-up opens 已完成) until the person toggles it.
	const [toggled, setOpen] = useState<boolean | null>(null);
	const open = toggled ?? initiallyOpen;
	const pages = useTeamBoardColumn(projectId, teamId, column, open && count > 0);
	const items = pages.data?.pages.flatMap((page) => page.items) ?? [];
	const label = t(`teams.page.work.groups.${column}`);
	// The page reads the sizes of the finished items shown, with the open ones.
	const shownIds = open ? items.map((item) => item.id).join(",") : "";
	useEffect(() => {
		onVisibleIds?.(column, shownIds ? shownIds.split(",") : []);
	}, [column, shownIds, onVisibleIds]);
	return (
		<Box data-testid={`team-finished-${column}`} data-open={open ? "true" : "false"}>
			<UnstyledButton
				onClick={() => setOpen(!open)}
				aria-expanded={open}
				disabled={count === 0}
				style={{ width: "100%", padding: "8px 10px" }}
				data-testid={`team-finished-${column}-toggle`}
			>
				<Group gap={6} wrap="nowrap">
					<IconChevronRight
						size={14}
						aria-hidden
						style={{
							transform: open ? "rotate(90deg)" : undefined,
							transition: "transform 120ms",
							opacity: 0.6,
						}}
					/>
					<Text size="sm" c="dimmed">
						{label}
					</Text>
					<Text size="sm" c="dimmed" style={TABULAR}>
						{count}
					</Text>
				</Group>
			</UnstyledButton>
			{open && (
				<Stack gap={0}>
					{pages.isLoading && <Loader size="xs" ml="md" />}
					{items.map((item) => (
						<WorkItemRow
							key={item.id}
							row={{ item, approval: null }}
							stat={stats?.[item.id]}
							base={base}
							finished
							onOpen={onOpenItem}
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
		</Box>
	);
}

/** No work item yet: what will appear here, with two dashed stand-ins. */
export function TeamWorkEmpty() {
	const { t } = useTranslation("projects");
	return (
		<Box
			p="md"
			m={4}
			data-testid="team-work-empty"
			style={{
				borderRadius: "var(--mantine-radius-md)",
				background: "var(--mantine-color-default-hover)",
			}}
		>
			<Text fw={600} size="sm">
				{t("teams.page.empty.title")}
			</Text>
			<Text size="sm" c="dimmed" mt={6}>
				{t("teams.page.empty.body")}
			</Text>
			<Stack gap={8} mt="md">
				{(["placeholderDoing", "placeholderReady"] as const).map((key) => (
					<Group
						key={key}
						gap={10}
						wrap="nowrap"
						px="sm"
						py={8}
						style={{
							border: "1px dashed var(--mantine-color-default-border)",
							borderRadius: "var(--mantine-radius-sm)",
						}}
					>
						<StatusDot tone="hollow" />
						<Stack gap={0} style={{ flex: 1, minWidth: 0 }}>
							<Text size="sm" c="dimmed">
								{t("teams.page.empty.placeholderTitle")}
							</Text>
							<Text size="xs" c="dimmed" truncate>
								{t(`teams.page.empty.${key}`)}
							</Text>
						</Stack>
						<IconGitBranch size={14} aria-hidden style={{ opacity: 0.5 }} />
					</Group>
				))}
			</Stack>
		</Box>
	);
}

/** Small marks after a title: the exclusive path lock, a finished item's kept worktree. */
export function ItemMarks({
	marks,
	exclusiveKey,
}: {
	marks: ItemMark[];
	exclusiveKey: string | null;
}) {
	const { t } = useTranslation("projects");
	if (marks.length === 0) return null;
	return (
		<Group gap={4} wrap="nowrap" style={{ flexShrink: 0 }}>
			{marks.map((mark) => {
				const Icon = mark === "exclusive" ? IconLock : IconFolderCode;
				const label = t(`teams.page.marks.${mark}`, { key: exclusiveKey ?? "" });
				return (
					<Tooltip key={mark} label={label} withinPortal multiline maw={260}>
						<span data-mark={mark} aria-label={label} style={{ display: "inline-flex" }}>
							<Icon size={13} aria-hidden style={{ opacity: 0.7 }} />
						</span>
					</Tooltip>
				);
			})}
		</Group>
	);
}

/** Everything finished: keep going in the conversation, or archive / disband the team. */
function TeamWrapUp({
	done,
	held,
	base,
	member,
	archiving,
	onArchive,
	onDisband,
}: {
	done: number;
	/** Finished items still holding a worktree: disbanding is refused until they are cleaned. */
	held: number;
	base: string;
	member: boolean;
	archiving: boolean;
	onArchive?: () => void;
	onDisband?: () => void;
}) {
	const { t } = useTranslation("projects");
	return (
		<Box
			p="md"
			m={4}
			data-testid="team-wrap-up"
			style={{
				borderRadius: "var(--mantine-radius-md)",
				background: "var(--mantine-color-default-hover)",
			}}
		>
			<Text fw={600} size="sm">
				{t("teams.page.wrapUp.title")}
			</Text>
			<Text size="sm" c="dimmed" mt={6} style={TABULAR}>
				{done > 0
					? t("teams.page.wrapUp.bodyMerged", { count: done, base })
					: t("teams.page.wrapUp.body")}
			</Text>
			{held > 0 && (
				<Text size="sm" mt={6} style={TABULAR} data-testid="team-wrap-up-held">
					{t("teams.page.wrapUp.held", { count: held })}
				</Text>
			)}
			{member && (
				<Group gap="xs" mt="md">
					{onArchive && (
						<Button
							size="xs"
							variant="default"
							leftSection={<IconArchive size={14} aria-hidden />}
							loading={archiving}
							onClick={onArchive}
							data-testid="team-wrap-up-archive"
						>
							{t("teams.page.wrapUp.archive")}
						</Button>
					)}
					{onDisband && held === 0 && (
						<Button
							size="xs"
							variant="subtle"
							color="gray"
							onClick={onDisband}
							data-testid="team-wrap-up-disband"
						>
							{t("teams.page.wrapUp.disband")}
						</Button>
					)}
				</Group>
			)}
		</Box>
	);
}

export function TeamWorkList({
	projectId,
	teamId,
	summary,
	items,
	approvals,
	stats,
	base,
	loading,
	failed,
	hasMore,
	onLoadMore,
	highlightId,
	mode,
	archiving,
	onArchive,
	onDisband,
	onOpenItem,
	onVisibleFinishedIds,
}: {
	projectId: string;
	teamId: string;
	summary: TeamPageSummary | undefined;
	/** The open items (queued, in progress, in review, ready). */
	items: TeamBoardItem[];
	approvals: TeamPendingApproval[];
	stats: Record<string, TeamWorkDiffStat | null> | undefined;
	base: string;
	loading: boolean;
	failed: boolean;
	hasMore: boolean;
	onLoadMore: () => void;
	highlightId: string | null;
	mode: { emptyWork: boolean; wrapUp: boolean };
	archiving: boolean;
	onArchive?: () => void;
	onDisband?: () => void;
	onOpenItem: (itemId: string) => void;
	onVisibleFinishedIds?: (column: "done" | "cancelled", ids: string[]) => void;
}) {
	const { t } = useTranslation("projects");
	const member = summary?.access === "write";
	if (mode.emptyWork) return <TeamWorkEmpty />;
	const groups = workGroups(
		items,
		approvals,
		member ? undefined : (item) => onlookerSeesWaiting(item, summary),
	);
	const counts = summary?.columnCounts;
	const labelOf = (group: WorkGroup) =>
		group === "needsYou" && !member
			? t("teams.page.work.groups.needsMembers")
			: t(`teams.page.work.groups.${group}`);
	return (
		<Stack gap={4} data-testid="team-work-list">
			{mode.wrapUp && (
				<TeamWrapUp
					done={counts?.done ?? 0}
					held={summary?.heldWorktreeCount ?? 0}
					base={base}
					member={member}
					archiving={archiving}
					onArchive={onArchive}
					onDisband={onDisband}
				/>
			)}
			{failed && <Alert color="red">{t("teams.page.work.loadFailed")}</Alert>}
			{loading && items.length === 0 && <Loader size="sm" m="sm" />}
			{WORK_GROUPS.map((group) =>
				groups[group].length === 0 ? null : (
					<Box key={group} data-testid={`team-group-${group}`} mb={6}>
						<GroupTitle label={labelOf(group)} count={groups[group].length} />
						<Stack gap={0}>
							{groups[group].map((row) => (
								<WorkItemRow
									key={row.item.id}
									row={row}
									stat={stats?.[row.item.id]}
									base={base}
									summary={summary}
									highlighted={highlightId === row.item.id}
									onOpen={onOpenItem}
								/>
							))}
						</Stack>
					</Box>
				),
			)}
			{hasMore && (
				<Button size="xs" variant="subtle" onClick={onLoadMore}>
					{t("teams.loadMore")}
				</Button>
			)}
			<Box style={{ borderTop: "1px solid var(--mantine-color-default-border)" }} mt={4}>
				<FinishedGroup
					projectId={projectId}
					teamId={teamId}
					column="done"
					count={counts?.done ?? 0}
					base={base}
					stats={stats}
					initiallyOpen={mode.wrapUp}
					onOpenItem={onOpenItem}
					onVisibleIds={onVisibleFinishedIds}
				/>
				<FinishedGroup
					projectId={projectId}
					teamId={teamId}
					column="cancelled"
					count={counts?.cancelled ?? 0}
					base={base}
					stats={stats}
					onOpenItem={onOpenItem}
					onVisibleIds={onVisibleFinishedIds}
				/>
			</Box>
		</Stack>
	);
}
