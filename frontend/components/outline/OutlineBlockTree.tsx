import { ActionIcon, Badge, Box, Popover, Stack, Text, Tooltip } from "@mantine/core";
import type {
	OutlineBlockViewResponse,
	OutlineQuestionMark,
	OutlineTaskStatus,
	OutlineViewBlock,
} from "@shared/outline-api";
import { IconLock } from "@tabler/icons-react";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import { visibleRows } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { OutlineBlockBody } from "./OutlineBlockBody";
import { FOLD_ICONS, QUESTION_ICON, TASK_ICONS } from "./outline-icons";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

/** Indentation stops growing past this depth so deep outlines stay inside a phone's width. */
const MAX_INDENT_DEPTH = 8;
const INDENT_PX = 18;

/** A task's checkbox: the same icon the live editor's frame draws (`outline-icons.ts`). */
export function OutlineTaskIcon({ status }: { status: OutlineTaskStatus }) {
	const { t } = useTranslation("outline");
	const { Icon } = TASK_ICONS[status];
	return (
		<Tooltip label={t(`page.task.${status}`)} openDelay={400}>
			<span className={classes.taskIcon} role="img" aria-label={t(`page.task.${status}`)}>
				<Icon size={16} />
			</span>
		</Tooltip>
	);
}

const QUESTION_COLORS: Record<OutlineQuestionMark["state"], string> = {
	open: "var(--mantine-color-teal-5)",
	answered: "var(--mantine-color-green-6)",
	withdrawn: "var(--mantine-color-dimmed)",
};

/**
 * The mark of a question put to a person (`Ask`) where a task has its checkbox: a question is
 * answered or withdrawn, never checked off.
 */
export function OutlineQuestionIcon({
	state,
	proceed = false,
}: {
	state: OutlineQuestionMark["state"];
	proceed?: boolean;
}) {
	const { t } = useTranslation("outline");
	const label = t(`page.question.${state}${state === "open" && proceed ? "Proceeded" : ""}`);
	const { Icon } = QUESTION_ICON;
	return (
		<Tooltip label={label} openDelay={400}>
			<span
				className={classes.taskIcon}
				role="img"
				aria-label={label}
				data-testid="outline-question-mark"
				data-state={state}
				style={{ color: QUESTION_COLORS[state] }}
			>
				<Icon size={16} />
			</span>
		</Tooltip>
	);
}

function FoldIcon({ collapsed }: { collapsed: boolean }) {
	const { Icon } = FOLD_ICONS[collapsed ? "collapsed" : "expanded"];
	return <Icon size={14} />;
}

interface RowProps {
	block: OutlineViewBlock;
	depth: number;
	hasChildren: boolean;
	collapsed: boolean;
	factsView: boolean;
	spaceId: string;
	search: OutlineBlockSearch;
	onToggle: (id: string) => void;
}

const OutlineRow = memo(function OutlineRow({
	block,
	depth,
	hasChildren,
	collapsed,
	factsView,
	spaceId,
	search,
	onToggle,
}: RowProps) {
	const { t } = useTranslation("outline");
	const done = block.task?.status === "done" || block.task?.status === "cancelled";
	const focusLink = (children: React.ReactNode, className: string, label?: string) => (
		<OutlineLink
			to={outlineBlockTarget(spaceId, block.id, search.view, search.asOf)}
			className={className}
			aria-label={label}
		>
			{children}
		</OutlineLink>
	);
	return (
		<div className={classes.row} data-block-id={block.id}>
			<span
				className={classes.indent}
				style={{ width: Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX }}
			/>
			<span className={classes.toggle}>
				{hasChildren && (
					<ActionIcon
						size="xs"
						variant="subtle"
						color="gray"
						aria-label={t(collapsed ? "page.expand" : "page.collapse")}
						aria-expanded={!collapsed}
						onClick={() => onToggle(block.id)}
					>
						<FoldIcon collapsed={collapsed} />
					</ActionIcon>
				)}
			</span>
			{focusLink(
				<span className={classes.bulletDot} data-collapsed={hasChildren && collapsed} />,
				classes.bullet,
				t("page.focus"),
			)}
			{block.task && <OutlineTaskIcon status={block.task.status} />}
			{!block.task && block.question && (
				<OutlineQuestionIcon state={block.question.state} proceed={block.question.proceed} />
			)}
			<div className={classes.content} data-done={done}>
				<OutlineBlockBody content={block.content} />
				{(block.alias ||
					block.tags.length > 0 ||
					block.task?.assignee ||
					block.task?.due ||
					(factsView && block.processHidden > 0) ||
					block.lock ||
					block.pending.length > 0 ||
					block.hidden > 0) && (
					<div className={classes.meta}>
						{block.task?.assignee && (
							<Badge size="xs" variant="light" color="gray" tt="none">
								@{block.task.assignee}
							</Badge>
						)}
						{block.task?.due && (
							<Badge size="xs" variant="light" color="gray" tt="none">
								{t("page.due", { date: block.task.due })}
							</Badge>
						)}
						{block.alias && (
							<Badge size="xs" variant="outline" color="gray" tt="none">
								{t("page.alias", { alias: block.alias })}
							</Badge>
						)}
						{block.tags.map((tag) => (
							<Badge key={tag} size="xs" variant="light" color="indigo" tt="none">
								#{tag}
							</Badge>
						))}
						{factsView && block.openTasks > 0 && (
							<InProgressMarker block={block} spaceId={spaceId} search={search} />
						)}
						{factsView && block.openTasks === 0 && block.processHidden > 0 && (
							<Tooltip label={t("page.hiddenUnderHint")} openDelay={300}>
								<Badge
									size="xs"
									variant="light"
									color="gray"
									tt="none"
									data-testid="outline-hidden-under"
								>
									{t("page.hiddenUnder", { count: block.processHidden })}
								</Badge>
							</Tooltip>
						)}
						{block.lock && (
							<Badge
								size="xs"
								variant="light"
								color="indigo"
								tt="none"
								leftSection={<IconLock size={10} />}
								data-testid="outline-lock-badge"
							>
								{t("lock.badge", {
									name:
										block.lock.by.kind === "human"
											? (block.lock.by.name ?? t("lock.someone"))
											: block.lock.by.name
												? t("lock.session", { title: block.lock.by.name })
												: t("lock.untitledSession"),
								})}
							</Badge>
						)}
						{block.pending.length > 0 && (
							<Badge
								size="xs"
								variant="light"
								color="orange"
								tt="none"
								data-testid="outline-pending-badge"
							>
								{t("pending.badge")}
							</Badge>
						)}
						{block.hidden > 0 &&
							!collapsed &&
							focusLink(t("page.more", { count: block.hidden }), classes.more)}
					</div>
				)}
			</div>
		</div>
	);
});

/**
 * The "in progress" marker of a fact (design §3.1): the open tasks under it; opening it lists them
 * (title, state, who, whether a change to it waits for confirmation), each focusable.
 */
function InProgressMarker({
	block,
	spaceId,
	search,
}: {
	block: OutlineViewBlock;
	spaceId: string;
	search: OutlineBlockSearch;
}) {
	const { t } = useTranslation("outline");
	return (
		<Popover position="bottom-start" withinPortal shadow="sm" width={300}>
			<Popover.Target>
				<Badge
					size="xs"
					variant="dot"
					color="yellow"
					tt="none"
					component="button"
					style={{ cursor: "pointer" }}
					aria-label={t("page.inProgressHint")}
					data-testid="outline-in-progress"
				>
					{t("page.inProgress", { count: block.openTasks })}
				</Badge>
			</Popover.Target>
			<Popover.Dropdown p={4}>
				<Text size="xs" c="dimmed" px={6} pb={2}>
					{t("page.inProgressHint")}
				</Text>
				<InProgressList block={block} spaceId={spaceId} search={search} />
			</Popover.Dropdown>
		</Popover>
	);
}

/**
 * The tasks and questions put to people in progress under a block (the "in progress" marker's
 * list): a question shows its mark, a task its checkbox.
 */
export function InProgressList({
	block,
	spaceId,
	search,
}: {
	block: OutlineViewBlock;
	spaceId: string;
	search: OutlineBlockSearch;
}) {
	const { t } = useTranslation("outline");
	return (
		<Stack gap={0}>
			{block.inProgress.map((item) => (
				<OutlineLink
					key={item.id}
					to={outlineBlockTarget(spaceId, item.id, search.view, search.asOf)}
					className={classes.listItem}
				>
					<Box style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
						{item.question ? (
							<OutlineQuestionIcon state="open" />
						) : (
							<OutlineTaskIcon status={item.status} />
						)}
						<Text size="sm" className={classes.ellipsis}>
							{item.title || item.sid}
						</Text>
					</Box>
					{(item.assignee || item.waiting) && (
						<Text size="xs" c="dimmed" className={classes.ellipsis}>
							{[
								item.assignee ? `@${item.assignee}` : null,
								item.waiting ? t("page.waitingConfirmation") : null,
							]
								.filter(Boolean)
								.join(" · ")}
						</Text>
					)}
				</OutlineLink>
			))}
			{block.openTasks > block.inProgress.length && (
				<OutlineLink
					to={outlineBlockTarget(spaceId, block.id, "all", search.asOf)}
					className={classes.listItem}
				>
					<Text size="xs" c="dimmed">
						{t("page.inProgressMore", {
							count: block.openTasks - block.inProgress.length,
						})}
					</Text>
				</OutlineLink>
			)}
		</Stack>
	);
}

export interface OutlineBlockTreeProps {
	view: OutlineBlockViewResponse;
	collapsed: ReadonlySet<string>;
	search: OutlineBlockSearch;
	onToggle: (id: string) => void;
}

/** The blocks under the view's root, as an indented list with collapse and focus. */
export function OutlineBlockTree({ view, collapsed, search, onToggle }: OutlineBlockTreeProps) {
	const { t } = useTranslation("outline");
	const rows = useMemo(() => visibleRows(view, collapsed), [view, collapsed]);
	const root = view.blocks.find((b) => b.id === view.rootId);
	if (rows.length === 0) {
		return (
			<Text size="sm" c="dimmed">
				{view.view === "facts" && view.hiddenByView > 0 ? t("page.factsEmpty") : t("page.empty")}
			</Text>
		);
	}
	return (
		<Box className={classes.rows}>
			{rows.map((row) => (
				<OutlineRow
					key={row.block.id}
					block={row.block}
					depth={row.depth}
					hasChildren={row.hasChildren}
					collapsed={row.collapsed}
					factsView={view.view === "facts"}
					spaceId={view.space.id}
					search={search}
					onToggle={onToggle}
				/>
			))}
			{root && root.hidden > 0 && (
				<Text size="xs" c="dimmed" mt={4}>
					{t("page.moreAtRoot", { count: root.hidden })}
				</Text>
			)}
		</Box>
	);
}
