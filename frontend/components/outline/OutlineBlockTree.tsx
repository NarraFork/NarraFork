import { ActionIcon, Badge, Box, Text, Tooltip } from "@mantine/core";
import type {
	OutlineBlockViewResponse,
	OutlineTaskStatus,
	OutlineViewBlock,
} from "@shared/outline-api";
import {
	IconChevronDown,
	IconChevronRight,
	IconSquare,
	IconSquareCheck,
	IconSquareHalf,
	IconSquareX,
} from "@tabler/icons-react";
import { memo, useMemo } from "react";
import { useTranslation } from "react-i18next";
import type { OutlineBlockSearch } from "../../lib/outline-view";
import { visibleRows } from "../../lib/outline-view";
import classes from "./Outline.module.css";
import { OutlineBlockBody } from "./OutlineBlockBody";
import { OutlineLink, outlineBlockTarget } from "./outline-nav";

/** Indentation stops growing past this depth so deep outlines stay inside a phone's width. */
const MAX_INDENT_DEPTH = 8;
const INDENT_PX = 18;

const TASK_ICONS: Record<OutlineTaskStatus, typeof IconSquare> = {
	todo: IconSquare,
	doing: IconSquareHalf,
	done: IconSquareCheck,
	cancelled: IconSquareX,
};

export function OutlineTaskIcon({ status }: { status: OutlineTaskStatus }) {
	const { t } = useTranslation("outline");
	const Icon = TASK_ICONS[status];
	return (
		<Tooltip label={t(`page.task.${status}`)} openDelay={400}>
			<span className={classes.taskIcon} role="img" aria-label={t(`page.task.${status}`)}>
				<Icon size={16} />
			</span>
		</Tooltip>
	);
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
						{collapsed ? <IconChevronRight size={14} /> : <IconChevronDown size={14} />}
					</ActionIcon>
				)}
			</span>
			{focusLink(<span className={classes.bulletDot} />, classes.bullet, t("page.focus"))}
			{block.task && <OutlineTaskIcon status={block.task.status} />}
			<div className={classes.content} data-done={done}>
				<OutlineBlockBody content={block.content} />
				{(block.alias ||
					block.tags.length > 0 ||
					block.task?.assignee ||
					block.task?.due ||
					(factsView && block.openTasks > 0) ||
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
							<Tooltip label={t("page.inProgressHint")} openDelay={300}>
								<Badge size="xs" variant="dot" color="yellow" tt="none">
									{t("page.inProgress", { count: block.openTasks })}
								</Badge>
							</Tooltip>
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
