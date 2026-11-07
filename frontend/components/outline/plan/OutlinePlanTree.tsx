/**
 * An outline plan as an outline, outside the session's list (plan readability): where a plan
 * waiting for a decision is read in the DOM (the inbox), the same view as its tool card
 * (`@shared/outline-plan-tree`) — the title, the background paragraph whole under it, the big
 * and small points, each closed node's children behind ONE preview line (its first child's first
 * line and 「还有 N 条 ▸」), the notable points whole — that the reader opens node by node (the
 * arrow), everything inside a node at once (the preview line, the row's quick control, Alt+click
 * or Alt+Enter on the arrow), or the whole plan (「全部展开 / 全部收起」). The session's list draws
 * the card itself, measured arithmetically (`vlist/render/PlanTreeBody.tsx`); this is the plain
 * DOM twin, its view held in local state.
 */
import { Anchor, Box, Group, Text } from "@mantine/core";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	isPlanTreeAllExpanded,
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	type PlanTreeAction,
	type PlanTreeLine,
	type PlanTreePreview,
	type PlanTreeRow,
	type PlanTreeView,
	planTextClamps,
	visiblePlanRows,
} from "@shared/outline-plan-tree";
import { IconFoldDown, IconFoldUp } from "@tabler/icons-react";
import type React from "react";
import { Fragment, useLayoutEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { FOLD_ICONS, TASK_ICONS } from "../outline-icons";

const INDENT_PX = 16;
const MAX_INDENT_DEPTH = 6;
/** The arrow's slot, the marker's slot and the gaps after them: where a row's text starts. */
const ARROW_PX = 16;
const MARKER_PX = 16;
const GAP_PX = 4;
const TEXT_OFFSET_PX = ARROW_PX + GAP_PX + MARKER_PX + GAP_PX;

const indentOf = (depth: number) => Math.min(depth, MAX_INDENT_DEPTH) * INDENT_PX;

function LineText({ line }: { line: PlanTreeLine }) {
	return (
		<>
			{line.runs.map((run, i) => (
				<span
					// biome-ignore lint/suspicious/noArrayIndexKey: a static list of runs
					key={i}
					style={{
						fontWeight: run.strong ? 700 : undefined,
						fontStyle: run.em ? "italic" : undefined,
						textDecoration: run.strike ? "line-through" : undefined,
						fontFamily:
							run.code || line.tone === "code" ? "var(--mantine-font-family-monospace)" : undefined,
						fontSize: run.code ? "0.92em" : undefined,
						color: run.link
							? "var(--mantine-color-anchor)"
							: line.tone === "dim"
								? "var(--mantine-color-dimmed)"
								: undefined,
					}}
				>
					{run.text}
				</span>
			))}
		</>
	);
}

function activateKey(activate: () => void) {
	return (e: React.KeyboardEvent) => {
		if (e.key !== "Enter" && e.key !== " ") return;
		if (e.target !== e.currentTarget) return;
		e.preventDefault();
		activate();
	};
}

/** One line of what a closed node holds: its first child's first line, cut, and how much more. */
function PreviewLine({
	preview,
	depth,
	onOpen,
}: {
	preview: PlanTreePreview;
	depth: number;
	onOpen: () => void;
}) {
	const { t } = useTranslation("narrator");
	const text = useRef<HTMLSpanElement>(null);
	// A lone one-line child shows whole unless it is wider than the line (then 「展开 ▸」).
	const [overflow, setOverflow] = useState(false);
	useLayoutEffect(() => {
		const el = text.current;
		if (!el || preview.more) return;
		const check = () => setOverflow(el.scrollWidth > el.clientWidth + 1);
		check();
		if (typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(check);
		observer.observe(el);
		return () => observer.disconnect();
	}, [preview]);
	const more = preview.more || overflow;
	const label = more
		? preview.rest > 0
			? t("outlinePlan.tree.detailsMore", { n: preview.rest })
			: t("outlinePlan.tree.detailsOne")
		: null;
	const first = preview.first.lines[0] as PlanTreeLine;
	return (
		<Box
			role="button"
			tabIndex={0}
			aria-expanded={false}
			aria-label={
				label ? `${t("outlinePlan.tree.showDetails")}: ${label}` : t("outlinePlan.tree.showDetails")
			}
			onClick={onOpen}
			onKeyDown={activateKey(onOpen)}
			data-plan-preview=""
			className="mantine-focus-auto"
			style={{
				display: "flex",
				alignItems: "baseline",
				gap: 8,
				paddingLeft: indentOf(depth + 1) + TEXT_OFFSET_PX,
				marginTop: 2,
				cursor: "pointer",
				whiteSpace: "nowrap",
				minWidth: 0,
			}}
		>
			<Text
				ref={text}
				component="span"
				size="sm"
				c="dimmed"
				data-plan-preview-text=""
				style={{ overflow: "hidden", textOverflow: "ellipsis", minWidth: 0, flex: "0 1 auto" }}
			>
				<LineText line={first} />
				{more ? "…" : null}
			</Text>
			{label ? (
				<Text
					component="span"
					size="sm"
					c="var(--mantine-color-anchor)"
					data-plan-preview-label=""
					style={{ flex: "0 0 auto" }}
				>
					{label}
				</Text>
			) : null}
		</Box>
	);
}

function PlanRow({ row, act }: { row: PlanTreeRow; act: (action: PlanTreeAction) => void }) {
	const { t } = useTranslation("narrator");
	const { node, open, whole, preview, subtree } = row;
	const key = node.key;
	const background = node.role === "background";
	const hasChildren = node.children.length > 0;
	const toggleNode = () => act({ kind: "node", key });
	const toggleSubtree = () => act({ kind: "subtree", key });
	const clamps = planTextClamps(node);
	const Fold = FOLD_ICONS[open ? "expanded" : "collapsed"].Icon;
	const Task = node.task ? TASK_ICONS[node.task].Icon : null;
	const weight = background
		? undefined
		: node.depth === 0 || node.heading
			? 700
			: node.depth === 1
				? 500
				: undefined;
	const arrowLabel = open ? t("outlinePlan.tree.collapse") : t("outlinePlan.tree.expand");
	const subtreeLabel =
		subtree === "collapse"
			? t("outlinePlan.tree.subtreeCollapse")
			: t("outlinePlan.tree.subtreeExpand");
	const textBody = node.lines.map((line, i) => (
		<Fragment
			// biome-ignore lint/suspicious/noArrayIndexKey: a static list of lines
			key={i}
		>
			{i > 0 ? "\n" : null}
			<span style={i > 0 ? { fontWeight: 400 } : undefined}>
				<LineText line={line} />
			</span>
		</Fragment>
	));
	if (background)
		return (
			<Text
				size="sm"
				c="dimmed"
				data-plan-row={key}
				data-plan-depth={node.depth}
				data-plan-role="background"
				data-plan-text=""
				style={{
					paddingLeft: TEXT_OFFSET_PX,
					marginTop: 2,
					marginBottom: 4,
					whiteSpace: "pre-wrap",
					overflowWrap: "anywhere",
				}}
			>
				{textBody}
			</Text>
		);
	return (
		<>
			<Box
				data-plan-row={key}
				data-plan-depth={node.depth}
				data-plan-role={node.role}
				data-plan-open={hasChildren ? (open ? "1" : "0") : undefined}
				style={{
					display: "flex",
					alignItems: "flex-start",
					gap: GAP_PX,
					paddingLeft: indentOf(node.depth),
					marginTop: 2,
				}}
			>
				<Box
					style={{
						width: ARROW_PX,
						flex: `0 0 ${ARROW_PX}px`,
						display: "flex",
						justifyContent: "center",
					}}
				>
					{hasChildren ? (
						<Anchor
							component="button"
							type="button"
							c="dimmed"
							aria-expanded={open}
							aria-label={arrowLabel}
							title={`${arrowLabel} · ${t("outlinePlan.tree.altHint")}`}
							onClick={(e: React.MouseEvent) => (e.altKey ? toggleSubtree() : toggleNode())}
							onKeyDown={(e: React.KeyboardEvent) => {
								if (!e.altKey || (e.key !== "Enter" && e.key !== " ")) return;
								e.preventDefault();
								toggleSubtree();
							}}
							data-plan-toggle=""
							style={{ display: "flex", lineHeight: 1, paddingTop: 3 }}
						>
							<Fold size={14} />
						</Anchor>
					) : null}
				</Box>
				<Box
					c={
						node.role === "notable"
							? "orange.6"
							: node.task === "done"
								? "green.6"
								: node.task === "doing"
									? "blue.6"
									: "dimmed"
					}
					style={{ flex: `0 0 ${MARKER_PX}px`, display: "flex", paddingTop: 2 }}
				>
					{Task ? (
						<Task size={MARKER_PX} />
					) : (
						<span
							style={{
								width: 6,
								height: 6,
								margin: "6px 5px 0",
								borderRadius: "50%",
								background: "currentColor",
							}}
						/>
					)}
				</Box>
				<Text
					size="sm"
					fw={weight}
					lineClamp={clamps && !whole ? PLAN_TREE_CLAMP_LINES : undefined}
					title={clamps && !whole ? node.plain : undefined}
					onClick={clamps ? () => act({ kind: "text", key }) : undefined}
					c={node.task === "done" || node.task === "cancelled" ? "dimmed" : undefined}
					td={node.task === "cancelled" ? "line-through" : undefined}
					style={{
						flex: "1 1 auto",
						minWidth: 0,
						overflowWrap: "anywhere",
						whiteSpace: "pre-wrap",
						cursor: clamps ? "pointer" : undefined,
					}}
					data-plan-text=""
				>
					{textBody}
				</Text>
				{subtree ? (
					<Anchor
						component="button"
						type="button"
						c="dimmed"
						aria-expanded={subtree === "collapse"}
						aria-label={subtreeLabel}
						title={subtreeLabel}
						onClick={toggleSubtree}
						data-plan-subtree={subtree}
						style={{ display: "flex", lineHeight: 1, paddingTop: 3, flexShrink: 0 }}
					>
						{subtree === "collapse" ? <IconFoldUp size={14} /> : <IconFoldDown size={14} />}
					</Anchor>
				) : null}
			</Box>
			{preview ? <PreviewLine preview={preview} depth={node.depth} onOpen={toggleSubtree} /> : null}
		</>
	);
}

export function OutlinePlanTree({ tree }: { tree: PlanTree }) {
	const { t } = useTranslation("narrator");
	const [view, setView] = useState<PlanTreeView>(DEFAULT_PLAN_TREE_VIEW);
	const act = (action: PlanTreeAction) => setView((prev) => applyPlanTreeAction(prev, action));
	const { rows, cut } = visiblePlanRows(tree, view);
	const all = isPlanTreeAllExpanded(view);
	return (
		<Box data-testid="outline-plan-tree">
			<Group justify="space-between" gap={8} wrap="nowrap" mb={4}>
				<Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
					{all
						? t("outlinePlan.tree.overviewAll", { count: tree.size })
						: t("outlinePlan.tree.overview", { count: tree.size })}
				</Text>
				<Anchor
					component="button"
					type="button"
					size="xs"
					style={{ flexShrink: 0 }}
					aria-pressed={all}
					onClick={() => act({ kind: "all" })}
					data-testid="outline-plan-tree-all"
				>
					{all ? t("outlinePlan.tree.collapseAll") : t("outlinePlan.tree.expandAll")}
				</Anchor>
			</Group>
			{rows.map((row) => (
				<PlanRow key={row.node.key} row={row} act={act} />
			))}
			{cut > 0 ? (
				<Text size="xs" c="dimmed" mt={4}>
					{t("outlinePlan.tree.more", { count: cut })}
				</Text>
			) : null}
		</Box>
	);
}
