/**
 * PlanTreeBody.tsx — paints an outline plan's tree in its ExitPlanMode card (plan readability),
 * at the geometry `measure-plan-tree.ts` laid out: the toolbar line (the plan's size,
 * 「全部展开」/「全部收起」), then the rows in the plan's box — the title, the background paragraph
 * under it, the points, each closed row's preview line (its first child's first line and
 * 「还有 N 条 ▸」). Every row sits where the measure put it; its text is laid out again from the
 * same prepared flows at the same width, line by line, and only as many lines as were measured
 * are drawn (a clamped text's last line, and a preview's line, narrower by the ellipsis and the
 * label, so they fit on it). Nothing here changes a height.
 *
 * The controls, each calling `onPlanTree` (the list's interaction state flips, the card is
 * measured again):
 *   - the fold arrow opens or closes the node; Alt+click (Alt+Enter / Alt+Space) on it expands or
 *     collapses everything inside it, as outliners do;
 *   - the quick control at the right of a row with something folded inside does the same as
 *     Alt+click, for touch and for a reader who does not know the gesture;
 *   - a preview line opens everything inside its node (the small point's details, each whole);
 *   - a clamped text shows whole, and clamps again.
 * The arrow and the quick control are native buttons sized by the measure's slots; the preview
 * and the text are `role="button"` boxes (a native button's chrome is not in the measure). None
 * has a hover style: they are always drawn, and focus shows them as every button in the list.
 */
import {
	layoutNextRichInlineLineRange,
	materializeRichInlineLineRange,
	type PreparedRichInline,
	type RichInlineCursor,
} from "@chenglou/pretext/rich-inline";
import type { PlanTreeAction } from "@shared/outline-plan-tree";
import { fragmentTextStyle, letterSpacingForFont } from "@shared/pretext-layout/fragment-style";
import { IconFoldDown, IconFoldUp } from "@tabler/icons-react";
import type React from "react";
import { Fragment, useMemo } from "react";
import { FOLD_ICONS, TASK_ICONS } from "../../../outline/outline-icons";
import type {
	PlanTreeLayout,
	PlanTreePreparedLine,
	PlanTreeRowLayout,
} from "../measure/measure-plan-tree";
import {
	PLAN_TREE_ELLIPSIS,
	PLAN_TREE_MARKER_GAP,
	PLAN_TREE_PAD_X,
	PLAN_TREE_PAD_Y,
	PLAN_TREE_PREVIEW_LABEL_GAP,
	PLAN_TREE_SUBTREE_SLOT,
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
	/** What Alt+click on the arrow does (the arrow's tooltip). */
	altHint: string;
	/** The quick control: everything inside this node. */
	subtreeExpand: string;
	subtreeCollapse: string;
	/** A preview line's name for assistive technology. */
	showDetails: string;
	showWhole: string;
	showLess: string;
	more: (count: number) => string;
}

export const DEFAULT_PLAN_TREE_LABELS: PlanTreeLabels = {
	overview: (count) => `Outline · ${count} blocks`,
	overviewAll: (count) => `Outline · all ${count} blocks shown`,
	expandAll: "Expand all",
	collapseAll: "Collapse all",
	expand: "Expand",
	collapse: "Collapse",
	altHint: "Alt+click: everything inside",
	subtreeExpand: "Expand everything inside",
	subtreeCollapse: "Collapse everything inside",
	showDetails: "Show the details",
	showWhole: "Show the whole text",
	showLess: "Show less",
	more: (count) => `${count} more blocks: open the plan in the outline to see them`,
};

interface PaintedFragment {
	text: string;
	font: string;
	className: string;
	gapBefore: number;
}

interface PaintedLine {
	top: number;
	fragments: PaintedFragment[];
	ellipsis: boolean;
}

/** One visual line of a prepared flow at `width`, from `cursor`. */
function nextLine(
	line: PlanTreePreparedLine & { flow: PreparedRichInline },
	width: number,
	cursor: RichInlineCursor | undefined,
): { fragments: PaintedFragment[]; end: RichInlineCursor } | null {
	const range = layoutNextRichInlineLineRange(line.flow, Math.max(1, width), cursor);
	if (!range) return null;
	const materialized = materializeRichInlineLineRange(line.flow, range);
	return {
		end: range.end,
		fragments: materialized.fragments.map((f) => ({
			text: f.text,
			font: line.fonts[f.itemIndex] ?? "",
			className: line.classNames[f.itemIndex] ?? "",
			gapBefore: f.gapBefore,
		})),
	};
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
			const flow = line.flow;
			const next = flow
				? nextLine({ ...line, flow }, row.textWidth - (ellipsis ? ellipsisWidth : 0), cursor)
				: null;
			if (!next) {
				out.push({ top, fragments: [], ellipsis });
				continue;
			}
			cursor = next.end;
			out.push({ top, ellipsis, fragments: next.fragments });
		}
	});
	return out;
}

function Fragments({ fragments }: { fragments: readonly PaintedFragment[] }) {
	return (
		<>
			{fragments.map((frag, fi) => (
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
		</>
	);
}

function Ellipsis() {
	const font = typographyMetrics().font.body;
	return (
		<span
			className="vlist-frag vlist-plan-dim"
			data-plan-ellipsis=""
			style={fragmentTextStyle({ font, letterSpacing: letterSpacingForFont(font) })}
		>
			{PLAN_TREE_ELLIPSIS}
		</span>
	);
}

/** Alt+Enter / Alt+Space on the arrow: everything inside, as Alt+click. */
function onArrowKey(subtree: () => void) {
	return (e: React.KeyboardEvent) => {
		if (!e.altKey || (e.key !== "Enter" && e.key !== " " && e.key !== "Spacebar")) return;
		e.preventDefault();
		e.stopPropagation();
		subtree();
	};
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
	const preview = useMemo(() => {
		const p = row.preview;
		if (!p?.line.flow) return [];
		return nextLine({ ...p.line, flow: p.line.flow }, p.width, undefined)?.fragments ?? [];
	}, [row.preview]);
	const lineHeight = layout.lineHeight;
	const icon = planTreeIconPx();
	const background = row.role === "background";
	const toggleNode = () => onPlanTree?.({ kind: "node", key: row.key });
	const toggleSubtree = () => onPlanTree?.({ kind: "subtree", key: row.key });
	const toggleText = () => {
		// A drag that selected text is a selection, not a click on the text.
		if (typeof window !== "undefined" && window.getSelection()?.toString()) return;
		onPlanTree?.({ kind: "text", key: row.key });
	};
	const Fold = FOLD_ICONS[row.open ? "expanded" : "collapsed"].Icon;
	const Task = row.task ? TASK_ICONS[row.task].Icon : null;
	const arrowLabel = row.open ? labels.collapse : labels.expand;
	const subtreeLabel = row.subtree === "collapse" ? labels.subtreeCollapse : labels.subtreeExpand;
	const SubtreeIcon = row.subtree === "collapse" ? IconFoldUp : IconFoldDown;
	const smallIcon = Math.min(14, Math.max(10, Math.round(typographyMetrics().size.sm)));
	return (
		<div
			data-plan-row={row.key}
			data-plan-depth={row.depth}
			data-plan-role={row.role}
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
			{row.hasChildren && !background ? (
				<button
					type="button"
					aria-expanded={row.open}
					aria-label={arrowLabel}
					title={`${arrowLabel} · ${labels.altHint}`}
					data-plan-toggle=""
					className={`${ROW_BUTTON_CLASS} vlist-plan-toggle`}
					onClick={(e) => (e.altKey ? toggleSubtree() : toggleNode())}
					onKeyDown={onArrowKey(toggleSubtree)}
					style={{
						position: "absolute",
						left: row.left,
						top: 0,
						width: PLAN_TREE_TOGGLE_SLOT,
						height: lineHeight,
					}}
				>
					<Fold size={smallIcon} />
				</button>
			) : null}
			{background ? null : (
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
			)}
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
				className={
					background
						? "vlist-plan-text vlist-plan-background"
						: row.textToggles
							? "vlist-plan-text vlist-plan-text--toggles mantine-focus-auto"
							: "vlist-plan-text"
				}
				style={{
					position: "absolute",
					left: row.textLeft,
					top: 0,
					width: row.textWidth,
					height: row.textHeight,
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
							<Fragments fragments={line.fragments} />
							{line.ellipsis ? <Ellipsis /> : null}
						</LineFragments>
					</div>
				))}
			</div>
			{row.subtree ? (
				<button
					type="button"
					aria-expanded={row.subtree === "collapse"}
					aria-label={subtreeLabel}
					title={subtreeLabel}
					data-plan-subtree={row.subtree}
					className={`${ROW_BUTTON_CLASS} vlist-plan-subtree`}
					onClick={toggleSubtree}
					style={{
						position: "absolute",
						right: 0,
						top: 0,
						width: PLAN_TREE_SUBTREE_SLOT,
						height: lineHeight,
					}}
				>
					<SubtreeIcon size={smallIcon} />
				</button>
			) : null}
			{row.preview ? (
				// biome-ignore lint/a11y/useSemanticElements: a <button> would bring UA button box styles into a measured, fixed-height line
				<div
					role="button"
					tabIndex={0}
					aria-expanded={false}
					aria-label={
						row.preview.label ? `${labels.showDetails}: ${row.preview.label}` : labels.showDetails
					}
					data-plan-preview=""
					className="vlist-plan-preview mantine-focus-auto"
					onClick={toggleSubtree}
					onKeyDown={activateOnKey(toggleSubtree)}
					style={{
						position: "absolute",
						left: row.preview.left,
						top: row.preview.top,
						right: 0,
						height: lineHeight,
						display: "flex",
						alignItems: "center",
						overflow: "hidden",
						whiteSpace: "nowrap",
					}}
				>
					<span
						data-plan-preview-text=""
						className="vlist-plan-preview-text"
						style={{
							display: "flex",
							alignItems: "center",
							maxWidth: row.preview.width,
							height: lineHeight,
							overflow: "hidden",
							flex: "0 1 auto",
						}}
					>
						<LineFragments>
							<Fragments fragments={preview} />
						</LineFragments>
					</span>
					{row.preview.ellipsis ? <Ellipsis /> : null}
					{row.preview.label ? (
						<span
							data-plan-preview-label=""
							className="vlist-plan-preview-label"
							style={{
								marginLeft: PLAN_TREE_PREVIEW_LABEL_GAP,
								width: row.preview.labelWidth,
								flex: "0 0 auto",
								font: typographyMetrics().font.body,
								letterSpacing: letterSpacingForFont(typographyMetrics().font.body) || undefined,
								lineHeight: `${lineHeight}px`,
							}}
						>
							{row.preview.label}
						</span>
					) : null}
				</div>
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
	labels = DEFAULT_PLAN_TREE_LABELS,
	onPlanTree,
}: {
	blocks: readonly PreparedBlock[];
	frames: readonly BlockFrame[];
	availableWidth: number;
	height: number;
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
	const all = layout.allOpen;
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
