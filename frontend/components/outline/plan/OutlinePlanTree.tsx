/**
 * An outline plan as an outline, outside the session's list (plan readability): where a plan
 * waiting for a decision is read in the DOM (the inbox), the same view as its tool card
 * (`@shared/outline-plan-tree`) — the title, the background paragraph whole under it, the big
 * and small points, each closed node's children behind ONE preview line (its first child's first
 * line and 「还有 N 条 ▸」), the notable points whole — that the reader opens node by node (the
 * arrow), everything inside a node at once (the preview line, the row's quick control, Alt+click
 * or Alt+Enter on the arrow), or the whole plan (「全部展开 / 全部收起」). The session's list draws
 * the card itself, measured arithmetically (`vlist/render/PlanTreeBody.tsx`); this is the plain
 * DOM twin, its view held in local state. What the card knows by arithmetic (does a text clamp,
 * does a lone preview line fit) this one reads from the DOM.
 *
 * Enter and Space on each control are its own (their default prevented, the key kept from the
 * window, where a session's permission shortcut listens); a Ctrl/Cmd/Shift click is not a toggle;
 * a preview line's activation moves focus to its row's quick control or arrow.
 */
import { Anchor, Box, Group, Text } from "@mantine/core";
import {
	applyPlanTreeAction,
	DEFAULT_PLAN_TREE_VIEW,
	isDefaultPlanTreeView,
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
import { Fragment, type RefObject, useLayoutEffect, useRef, useState } from "react";
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

/** A modified click (Ctrl/Cmd/Shift) is not a toggle. */
function plainClick(e: React.MouseEvent): boolean {
	return !(e.metaKey || e.ctrlKey || e.shiftKey);
}

/** Enter and Space on a control: its own, never the window's. `activate` gets Alt. */
function ownKeys(activate: (alt: boolean) => void) {
	return (e: React.KeyboardEvent) => {
		const space = e.code === "Space" || e.key === " " || e.key === "Spacebar";
		if (e.key !== "Enter" && !space) return;
		if (e.target !== e.currentTarget || e.ctrlKey || e.metaKey) return;
		e.preventDefault();
		e.stopPropagation();
		// A held key repeats: one toggle per press.
		if (e.repeat) return;
		activate(e.altKey);
	};
}

/** The preview's line as plain text, for its accessible name. */
function firstLineText(preview: PlanTreePreview): string {
	const text = preview.first.plain.split("\n")[0] ?? "";
	return text.length > 80 ? `${text.slice(0, 79)}…` : text;
}

/** A label without its trailing arrow (an accessible name says what, not "▸"). */
function spoken(label: string): string {
	return label.replace(/\s*[▸▾▴►]\s*$/u, "");
}

/**
 * Watch an element with `check` after every render and whenever its box changes (where
 * `ResizeObserver` is there; a test DOM may not have it).
 */
function useBoxCheck<T extends HTMLElement>(
	ref: RefObject<T | null>,
	check: (el: T) => boolean,
): boolean {
	const [value, setValue] = useState(false);
	const latest = useRef(check);
	latest.current = check;
	// After every render: what it checks may have changed with it (cheap; same value bails out).
	useLayoutEffect(() => {
		const el = ref.current;
		if (el) setValue(latest.current(el));
	});
	useLayoutEffect(() => {
		const el = ref.current;
		if (!el || typeof ResizeObserver === "undefined") return;
		const observer = new ResizeObserver(() => setValue(latest.current(el)));
		observer.observe(el);
		return () => observer.disconnect();
	}, [ref]);
	return value;
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
	const overflow = useBoxCheck(text, (el) => !preview.more && el.scrollWidth > el.clientWidth + 1);
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
			aria-label={`${t("outlinePlan.tree.showInside")}: ${firstLineText(preview)}${
				label ? ` (${spoken(label)})` : ""
			}`}
			onClick={(e: React.MouseEvent) => {
				if (plainClick(e)) onOpen();
			}}
			onKeyDown={ownKeys(() => onOpen())}
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

function PlanRow({
	row,
	act,
	onHidden,
}: {
	row: PlanTreeRow;
	act: (action: PlanTreeAction) => void;
	/** The row's text is cut by its clamp now (what 「全部收起」 is offered by). */
	onHidden: (key: string, hidden: boolean) => void;
}) {
	const { t } = useTranslation("narrator");
	const { node, open, whole, preview, subtree } = row;
	const key = node.key;
	const background = node.role === "background";
	const hasChildren = node.children.length > 0;
	const arrowRef = useRef<HTMLButtonElement>(null);
	const quickRef = useRef<HTMLButtonElement>(null);
	const textRef = useRef<HTMLParagraphElement>(null);
	const focusAfterPreview = useRef(false);
	useLayoutEffect(() => {
		if (!focusAfterPreview.current || preview) return;
		focusAfterPreview.current = false;
		(quickRef.current ?? arrowRef.current)?.focus();
	}, [preview]);
	const clamps = planTextClamps(node);
	// Whether the text is longer than its clamp: cut now (clamped), or taller than the clamp
	// (whole). Only then does it toggle (a short point's text is not a control).
	const longer = useBoxCheck(textRef, (el) => {
		if (!clamps) return false;
		if (!whole) return el.scrollHeight > el.clientHeight + 1;
		const line = Number.parseFloat(getComputedStyle(el).lineHeight);
		return Number.isFinite(line) && el.clientHeight > line * PLAN_TREE_CLAMP_LINES + 1;
	});
	useLayoutEffect(() => {
		onHidden(key, longer && !whole);
		return () => onHidden(key, false);
	}, [key, longer, whole, onHidden]);
	const toggleNode = () => act({ kind: "node", key });
	const toggleSubtree = () =>
		act({ kind: "subtree", key, ...(subtree ? { open: subtree === "expand" } : {}) });
	const openPreview = () => {
		focusAfterPreview.current = true;
		act({ kind: "subtree", key, open: true });
	};
	const toggleText = () => {
		if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
		act({ kind: "text", key });
	};
	const Fold = FOLD_ICONS[open ? "expanded" : "collapsed"].Icon;
	const Task = node.task ? TASK_ICONS[node.task].Icon : null;
	const weight = background
		? undefined
		: node.depth === 0 || node.heading
			? 700
			: node.depth === 1
				? 500
				: undefined;
	const arrowAction = open ? t("outlinePlan.tree.collapse") : t("outlinePlan.tree.expand");
	const subtreeAction =
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
							ref={arrowRef}
							component="button"
							type="button"
							c="dimmed"
							aria-expanded={open}
							aria-label={node.plain.split("\n")[0]?.slice(0, 80) || arrowAction}
							title={`${arrowAction} · ${t("outlinePlan.tree.altHint")}`}
							onClick={(e: React.MouseEvent) => {
								if (!plainClick(e)) return;
								if (e.altKey) toggleSubtree();
								else toggleNode();
							}}
							onKeyDown={ownKeys((alt) => (alt ? toggleSubtree() : toggleNode()))}
							data-plan-toggle=""
							style={{ display: "flex", lineHeight: 1, padding: "3px 4px", margin: "0 -4px" }}
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
					ref={textRef}
					size="sm"
					fw={weight}
					lineClamp={clamps && !whole ? PLAN_TREE_CLAMP_LINES : undefined}
					title={longer && !whole ? node.plain : undefined}
					{...(longer
						? {
								role: "button",
								tabIndex: 0,
								"aria-expanded": whole,
								className: "mantine-focus-auto",
								onClick: (e: React.MouseEvent) => {
									if (plainClick(e)) toggleText();
								},
								onKeyDown: ownKeys(() => toggleText()),
							}
						: {})}
					c={node.task === "done" || node.task === "cancelled" ? "dimmed" : undefined}
					td={node.task === "cancelled" ? "line-through" : undefined}
					style={{
						flex: "1 1 auto",
						minWidth: 0,
						overflowWrap: "anywhere",
						whiteSpace: "pre-wrap",
						cursor: longer ? "pointer" : undefined,
					}}
					data-plan-text=""
				>
					{textBody}
				</Text>
				{subtree ? (
					<Anchor
						ref={quickRef}
						component="button"
						type="button"
						c="dimmed"
						aria-expanded={subtree === "collapse"}
						aria-label={t("outlinePlan.tree.subtree", {
							title: node.plain.split("\n")[0]?.slice(0, 80) || subtreeAction,
						})}
						title={subtreeAction}
						onClick={(e: React.MouseEvent) => {
							if (plainClick(e)) toggleSubtree();
						}}
						onKeyDown={ownKeys(() => toggleSubtree())}
						data-plan-subtree={subtree}
						style={{
							display: "flex",
							lineHeight: 1,
							padding: "3px 5px",
							margin: "0 -5px",
							flexShrink: 0,
						}}
					>
						{subtree === "collapse" ? <IconFoldUp size={14} /> : <IconFoldDown size={14} />}
					</Anchor>
				) : null}
			</Box>
			{preview ? <PreviewLine preview={preview} depth={node.depth} onOpen={openPreview} /> : null}
		</>
	);
}

export function OutlinePlanTree({ tree }: { tree: PlanTree }) {
	const { t } = useTranslation("narrator");
	const [view, setView] = useState<PlanTreeView>(DEFAULT_PLAN_TREE_VIEW);
	const act = (action: PlanTreeAction) => setView((prev) => applyPlanTreeAction(prev, action));
	// Rows whose text is cut by its clamp now (read from the DOM, as the card measures it).
	const [cutTexts, setCutTexts] = useState<ReadonlySet<string>>(() => new Set());
	const onHidden = useRef((key: string, hidden: boolean) =>
		setCutTexts((prev) => {
			if (prev.has(key) === hidden) return prev;
			const next = new Set(prev);
			if (hidden) next.add(key);
			else next.delete(key);
			return next;
		}),
	).current;
	const { rows, cut } = visiblePlanRows(tree, view);
	// 「全部收起」 when everything is expanded, or nothing drawn is hidden any more.
	const all =
		isPlanTreeAllExpanded(view) ||
		(cut === 0 && cutTexts.size === 0 && rows.every((r) => !r.preview));
	return (
		<Box data-testid="outline-plan-tree">
			<Group justify="space-between" gap={8} wrap="nowrap" mb={4}>
				<Text size="xs" c="dimmed" truncate="end" style={{ minWidth: 0 }}>
					{all
						? t("outlinePlan.tree.overviewAll", { count: tree.size })
						: t("outlinePlan.tree.overview", { count: tree.size })}
				</Text>
				{/* Only when there is something to open or to return: as the card's toolbar. */}
				{tree.folds || cutTexts.size > 0 || !isDefaultPlanTreeView(view) ? (
					<Anchor
						component="button"
						type="button"
						size="xs"
						style={{ flexShrink: 0 }}
						onClick={() => act({ kind: "all", open: !all })}
						onKeyDown={ownKeys(() => act({ kind: "all", open: !all }))}
						data-testid="outline-plan-tree-all"
					>
						{all ? t("outlinePlan.tree.collapseAll") : t("outlinePlan.tree.expandAll")}
					</Anchor>
				) : null}
			</Group>
			{rows.map((row) => (
				<PlanRow key={row.node.key} row={row} act={act} onHidden={onHidden} />
			))}
			{cut > 0 ? (
				<Text size="xs" c="dimmed" mt={4}>
					{t("outlinePlan.tree.more", { count: cut })}
				</Text>
			) : null}
		</Box>
	);
}
