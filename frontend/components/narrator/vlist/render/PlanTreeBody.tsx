/**
 * PlanTreeBody.tsx — paints an outline plan's tree in its ExitPlanMode card (plan readability),
 * at the geometry `measure-plan-tree.ts` laid out: the toolbar line (what the overview shows,
 * 「全部展开」/「全部收起」), then the rows in the plan's box. Every row sits where the measure
 * put it; its text is laid out again from the same prepared flows at the same width, line by
 * line, and only as many lines as were measured are drawn (a clamped text's last line narrower,
 * by the ellipsis's width, so the ellipsis fits on it). Nothing here changes a height.
 *
 * The fold arrow, the child-count badge and a clamped text are the controls; each calls
 * `onPlanTree`, which flips the reader's view in the list's interaction state (the card is then
 * measured again). They are plain elements with `role="button"` (a native button's chrome is
 * not in the measure), and none of them has a hover style.
 */
import {
	layoutNextRichInlineLineRange,
	materializeRichInlineLineRange,
	type RichInlineCursor,
} from "@chenglou/pretext/rich-inline";
import type { PlanTreeAction } from "@shared/outline-plan-tree";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { Fragment, useMemo } from "react";
import { FOLD_ICONS, TASK_ICONS } from "../../../outline/outline-icons";
import type { PlanTreeLayout, PlanTreeRowLayout } from "../measure/measure-plan-tree";
import {
	PLAN_TREE_ELLIPSIS,
	PLAN_TREE_MARKER_GAP,
	PLAN_TREE_PAD_X,
	PLAN_TREE_PAD_Y,
	PLAN_TREE_TOGGLE_SLOT,
	planTreeIconPx,
} from "../measure/measure-plan-tree";
import type { BlockFrame, PreparedBlock } from "../prepared-block";
import { typographyMetrics } from "../pretext-fonts";
import { activateOnKey } from "./key-activate";
import { FragmentGap, LineFragments } from "./line-fragments";
import { ROW_BUTTON_CLASS } from "./row-chrome";
import "./plan-tree.css";

/** The tree's words (render-only: every one of them sits in a fixed line or a tooltip). */
export interface PlanTreeLabels {
	overview: (count: number) => string;
	overviewAll: (count: number) => string;
	expandAll: string;
	collapseAll: string;
	expand: string;
	collapse: string;
	hidden: (count: number) => string;
	showWhole: string;
	showLess: string;
	more: (count: number) => string;
}

export const DEFAULT_PLAN_TREE_LABELS: PlanTreeLabels = {
	overview: (count) => `Outline · two levels by default · ${count} blocks`,
	overviewAll: (count) => `Outline · all ${count} blocks shown`,
	expandAll: "Expand all",
	collapseAll: "Collapse all",
	expand: "Expand",
	collapse: "Collapse",
	hidden: (count) => `${count} items inside`,
	showWhole: "Show the whole text",
	showLess: "Show less",
	more: (count) => `${count} more blocks: open the plan in the outline to see them`,
};

interface PaintedLine {
	top: number;
	fragments: Array<{ text: string; font: string; className: string; gapBefore: number }>;
	ellipsis: boolean;
}

/** The visual lines a row draws: as many as measured, the clamped last one narrower. */
function paintRow(row: PlanTreeRowLayout, lineHeight: number, ellipsisWidth: number) {
	const out: PaintedLine[] = [];
	row.lines.forEach((entry, entryIndex) => {
		const { line, shown } = entry;
		const lastEntry = entryIndex === row.lines.length - 1;
		let cursor: RichInlineCursor | undefined;
		for (let k = 0; k < shown; k++) {
			const top = entry.top + k * lineHeight;
			const ellipsis = row.clamped && lastEntry && k === shown - 1;
			if (!line.flow) {
				out.push({ top, fragments: [], ellipsis });
				continue;
			}
			const width = Math.max(1, row.textWidth - (ellipsis ? ellipsisWidth : 0));
			const range = layoutNextRichInlineLineRange(line.flow, width, cursor);
			if (!range) {
				out.push({ top, fragments: [], ellipsis });
				continue;
			}
			cursor = range.end;
			const materialized = materializeRichInlineLineRange(line.flow, range);
			out.push({
				top,
				ellipsis,
				fragments: materialized.fragments.map((f) => ({
					text: f.text,
					font: line.fonts[f.itemIndex] ?? "",
					className: line.classNames[f.itemIndex] ?? "",
					gapBefore: f.gapBefore,
				})),
			});
		}
	});
	return out;
}

function PlanTreeRow({
	row,
	layout,
	labels,
	onPlanTree,
}: {
	row: PlanTreeRowLayout;
	layout: PlanTreeLayout;
	labels: PlanTreeLabels;
	onPlanTree?: (action: PlanTreeAction) => void;
}) {
	const lines = useMemo(
		() => paintRow(row, layout.lineHeight, layout.ellipsisWidth),
		[row, layout.lineHeight, layout.ellipsisWidth],
	);
	const lineHeight = layout.lineHeight;
	const icon = planTreeIconPx();
	const toggleNode = () => onPlanTree?.({ kind: "node", key: row.key });
	const toggleText = () => {
		// A drag that selected text is a selection, not a click on the text.
		if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
		onPlanTree?.({ kind: "text", key: row.key });
	};
	const Fold = FOLD_ICONS[row.open ? "expanded" : "collapsed"].Icon;
	const Task = row.task ? TASK_ICONS[row.task].Icon : null;
	return (
		<div
			data-plan-row={row.key}
			data-plan-depth={row.depth}
			data-plan-open={row.hasChildren ? (row.open ? "1" : "0") : undefined}
			data-task-status={row.task ?? undefined}
			className="vlist-plan-row"
			style={{
				position: "absolute",
				top: PLAN_TREE_PAD_Y + row.top,
				left: PLAN_TREE_PAD_X,
				right: PLAN_TREE_PAD_X,
				height: row.height,
			}}
		>
			{row.hasChildren ? (
				<button
					type="button"
					aria-expanded={row.open}
					aria-label={row.open ? labels.collapse : labels.expand}
					title={row.open ? labels.collapse : labels.expand}
					data-plan-toggle=""
					className={`${ROW_BUTTON_CLASS} vlist-plan-toggle`}
					onClick={toggleNode}
					style={{
						position: "absolute",
						left: row.left,
						top: 0,
						width: PLAN_TREE_TOGGLE_SLOT,
						height: lineHeight,
					}}
				>
					<Fold size={Math.min(14, Math.max(10, Math.round(typographyMetrics().size.sm)))} />
				</button>
			) : null}
			<span
				aria-hidden
				className="vlist-plan-marker"
				style={{
					position: "absolute",
					left: row.left + PLAN_TREE_TOGGLE_SLOT,
					top: 0,
					width: icon + PLAN_TREE_MARKER_GAP,
					height: lineHeight,
				}}
			>
				{Task ? <Task size={icon} /> : <span className="vlist-plan-dot" />}
			</span>
			<div
				data-plan-text=""
				{...(row.textToggles
					? {
							role: "button",
							tabIndex: 0,
							"aria-expanded": !row.clamped,
							title: row.clamped ? labels.showWhole : labels.showLess,
							onClick: toggleText,
							onKeyDown: activateOnKey(toggleText),
						}
					: {})}
				className={row.textToggles ? "vlist-plan-text vlist-plan-text--toggles" : "vlist-plan-text"}
				style={{
					position: "absolute",
					left: row.textLeft,
					top: 0,
					width: row.textWidth,
					height: row.height,
				}}
			>
				{lines.map((line) => (
					<div
						key={line.top}
						style={{
							position: "absolute",
							left: 0,
							top: line.top,
							height: lineHeight,
							display: "flex",
							alignItems: "center",
							width: "max-content",
						}}
					>
						<LineFragments>
							{line.fragments.map((frag, fi) => (
								<Fragment
									// biome-ignore lint/suspicious/noArrayIndexKey: fragments are a stable ordered list
									key={fi}
								>
									<FragmentGap gapBefore={frag.gapBefore} />
									<span
										className={frag.className}
										style={fragmentTextStyle({
											font: frag.font,
											gapBefore: frag.gapBefore,
											letterSpacing: letterSpacingForFont(frag.font),
										})}
									>
										{frag.text}
									</span>
								</Fragment>
							))}
							{line.ellipsis ? (
								<span
									className="vlist-frag vlist-plan-dim"
									data-plan-ellipsis=""
									style={fragmentTextStyle({
										font: typographyMetrics().font.body,
										letterSpacing: letterSpacingForFont(typographyMetrics().font.body),
									})}
								>
									{PLAN_TREE_ELLIPSIS}
								</span>
							) : null}
						</LineFragments>
					</div>
				))}
			</div>
			{row.badge ? (
				<button
					type="button"
					aria-label={`${labels.expand}: ${labels.hidden(row.badge.count)}`}
					title={labels.hidden(row.badge.count)}
					data-plan-badge=""
					className={`${ROW_BUTTON_CLASS} vlist-plan-badge`}
					onClick={toggleNode}
					style={{
						position: "absolute",
						right: 0,
						top: 0,
						width: row.badge.width,
						height: lineHeight,
						font: typographyMetrics().font.xs,
						letterSpacing: letterSpacingForFont(typographyMetrics().font.xs) || undefined,
					}}
				>
					<span className="vlist-plan-badge-chip">{row.badge.text}</span>
				</button>
			) : null}
		</div>
	);
}

/** The plan's toolbar line and its rows' box, from the measured blocks. */
export function PlanTreeBody({
	blocks,
	frames,
	availableWidth,
	height,
	all,
	labels = DEFAULT_PLAN_TREE_LABELS,
	onPlanTree,
}: {
	blocks: readonly PreparedBlock[];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
	/** The reader turned everything open (「全部收起」 returns to the overview). */
	all: boolean;
	labels?: PlanTreeLabels;
	onPlanTree?: (action: PlanTreeAction) => void;
}) {
	const toolbarIndex = blocks.findIndex(
		(b) => b.kind === "fixed" && b.tag === "detail-plan-toolbar",
	);
	const treeIndex = blocks.findIndex((b) => b.kind === "fixed" && b.tag === "detail-plan-tree");
	const tree = blocks[treeIndex];
	const treeFrame = frames[treeIndex];
	const toolbarFrame = toolbarIndex >= 0 ? frames[toolbarIndex] : undefined;
	if (!tree || tree.kind !== "fixed" || !treeFrame) return null;
	const layout = (tree.data as { layout: PlanTreeLayout }).layout;
	const toggleAll = () => onPlanTree?.({ kind: "all" });
	const xs = typographyMetrics().line.xs;
	return (
		<div data-plan-tree="" style={{ position: "relative", width: availableWidth, height }}>
			{toolbarFrame ? (
				<div
					data-plan-toolbar=""
					className="vlist-plan-toolbar"
					style={{
						position: "absolute",
						top: toolbarFrame.top,
						left: 0,
						width: availableWidth,
						height: toolbarFrame.height,
						font: typographyMetrics().font.xs,
						lineHeight: `${xs}px`,
					}}
				>
					<span className="vlist-plan-toolbar-summary" data-plan-summary="">
						{all ? labels.overviewAll(layout.size) : labels.overview(layout.size)}
					</span>
					<button
						type="button"
						aria-pressed={all}
						data-plan-all=""
						className={`${ROW_BUTTON_CLASS} vlist-plan-toolbar-action`}
						onClick={toggleAll}
						style={{ font: "inherit", lineHeight: "inherit" }}
					>
						{all ? labels.collapseAll : labels.expandAll}
					</button>
				</div>
			) : null}
			<div
				data-plan-box=""
				className="vlist-plan-box"
				style={{
					position: "absolute",
					top: treeFrame.top,
					left: 0,
					width: availableWidth,
					height: treeFrame.height,
					overflowY:
						layout.contentHeight + PLAN_TREE_PAD_Y * 2 > treeFrame.height ? "auto" : "hidden",
					overflowX: "hidden",
				}}
			>
				<div
					style={{
						position: "relative",
						width: "100%",
						height: layout.contentHeight + PLAN_TREE_PAD_Y * 2,
					}}
				>
					{layout.rows.map((row) => (
						<PlanTreeRow
							key={row.key}
							row={row}
							layout={layout}
							labels={labels}
							onPlanTree={onPlanTree}
						/>
					))}
					{layout.cut > 0 ? (
						<div
							className="vlist-plan-more"
							data-plan-more=""
							style={{
								position: "absolute",
								left: PLAN_TREE_PAD_X,
								right: PLAN_TREE_PAD_X,
								top: PLAN_TREE_PAD_Y + layout.contentHeight - xs,
								height: xs,
								font: typographyMetrics().font.xs,
								lineHeight: `${xs}px`,
							}}
						>
							{labels.more(layout.cut)}
						</div>
					) : null}
				</div>
			</div>
		</div>
	);
}
