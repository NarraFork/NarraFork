/**
 * An outline plan as an outline, outside the session's list (plan readability): where a plan
 * waiting for a decision is read in the DOM (the inbox), the same overview as its tool card —
 * the root and the two levels under it, deeper levels folded with their child count, long text
 * clamped to two lines — that the reader opens node by node, text by text, or all at once
 * (`@shared/outline-plan-tree`). The session's list draws the card itself, measured
 * arithmetically (`vlist/render/PlanTreeBody.tsx`); this is the plain DOM twin, its folds held
 * in local state.
 */
import { Anchor, Box, Group, Text } from "@mantine/core";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	PLAN_TREE_CLAMP_LINES,
	type PlanTree,
	type PlanTreeLine,
	type PlanTreeView,
	visiblePlanRows,
} from "@shared/outline-plan-tree";
import { Fragment, useState } from "react";
import { useTranslation } from "react-i18next";
import { FOLD_ICONS, TASK_ICONS } from "../outline-icons";

const INDENT_PX = 16;
const MAX_INDENT_DEPTH = 6;

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

export function OutlinePlanTree({ tree }: { tree: PlanTree }) {
	const { t } = useTranslation("narrator");
	const [view, setView] = useState<PlanTreeView>(DEFAULT_PLAN_TREE_VIEW);
	const act = (action: Parameters<typeof applyPlanTreeAction>[1]) =>
		setView((prev) => applyPlanTreeAction(prev, action));
	const { rows, cut } = visiblePlanRows(tree, view);
	return (
		<Box data-testid="outline-plan-tree">
			<Group justify="space-between" gap={8} wrap="nowrap" mb={4}>
				<Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
					{view.all
						? t("outlinePlan.tree.overviewAll", { count: tree.size })
						: t("outlinePlan.tree.overview", { count: tree.size })}
				</Text>
				<Anchor
					component="button"
					type="button"
					size="xs"
					style={{ flexShrink: 0 }}
					aria-pressed={view.all}
					onClick={() => act({ kind: "all" })}
					data-testid="outline-plan-tree-all"
				>
					{view.all ? t("outlinePlan.tree.collapseAll") : t("outlinePlan.tree.expandAll")}
				</Anchor>
			</Group>
			{rows.map(({ node, open, whole }) => {
				const Fold = FOLD_ICONS[open ? "expanded" : "collapsed"].Icon;
				const Task = node.task ? TASK_ICONS[node.task].Icon : null;
				const hasChildren = node.children.length > 0;
				const weight = node.depth === 0 || node.heading ? 700 : node.depth === 1 ? 500 : undefined;
				return (
					<Box
						key={node.key}
						data-plan-row={node.key}
						data-plan-depth={node.depth}
						data-plan-open={hasChildren ? (open ? "1" : "0") : undefined}
						style={{
							display: "flex",
							alignItems: "flex-start",
							gap: 4,
							paddingLeft: Math.min(node.depth, MAX_INDENT_DEPTH) * INDENT_PX,
							marginTop: 2,
						}}
					>
						<Box style={{ width: 16, flex: "0 0 16px", display: "flex", justifyContent: "center" }}>
							{hasChildren ? (
								<Anchor
									component="button"
									type="button"
									c="dimmed"
									aria-expanded={open}
									aria-label={open ? t("outlinePlan.tree.collapse") : t("outlinePlan.tree.expand")}
									onClick={() => act({ kind: "node", key: node.key })}
									data-plan-toggle=""
									style={{ display: "flex", lineHeight: 1, paddingTop: 3 }}
								>
									<Fold size={14} />
								</Anchor>
							) : null}
						</Box>
						<Box
							c={node.task === "done" ? "green.6" : node.task === "doing" ? "blue.6" : "dimmed"}
							style={{ flex: "0 0 auto", display: "flex", paddingTop: 2 }}
						>
							{Task ? (
								<Task size={16} />
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
							lineClamp={whole ? undefined : PLAN_TREE_CLAMP_LINES}
							title={whole ? undefined : node.plain}
							onClick={() => act({ kind: "text", key: node.key })}
							c={node.task === "done" || node.task === "cancelled" ? "dimmed" : undefined}
							td={node.task === "cancelled" ? "line-through" : undefined}
							style={{
								flex: "1 1 auto",
								minWidth: 0,
								overflowWrap: "anywhere",
								whiteSpace: "pre-wrap",
								cursor: "pointer",
							}}
							data-plan-text=""
						>
							{node.lines.map((line, i) => (
								<Fragment
									// biome-ignore lint/suspicious/noArrayIndexKey: a static list of lines
									key={i}
								>
									{i > 0 ? "\n" : null}
									<span style={i > 0 ? { fontWeight: 400 } : undefined}>
										<LineText line={line} />
									</span>
								</Fragment>
							))}
						</Text>
						{hasChildren && !open ? (
							<Anchor
								component="button"
								type="button"
								size="xs"
								c="dimmed"
								title={t("outlinePlan.tree.hidden", { count: node.children.length })}
								onClick={() => act({ kind: "node", key: node.key })}
								data-plan-badge=""
								style={{ flexShrink: 0 }}
							>
								+{node.children.length}
							</Anchor>
						) : null}
					</Box>
				);
			})}
			{cut > 0 ? (
				<Text size="xs" c="dimmed" mt={4}>
					{t("outlinePlan.tree.more", { count: cut })}
				</Text>
			) : null}
		</Box>
	);
}
