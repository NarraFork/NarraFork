import { useShikiTokens } from "@frontend/hooks/useShikiTokens";
import type { ShikiToken } from "@frontend/lib/shiki-token-cache";
import { useComputedColorScheme } from "@mantine/core";
import {
	buildDiffHighlightPlan,
	type DiffDocument,
	type DiffLine,
	type DiffProjectedLine,
	type DiffProjection,
	type DiffSourcePoint,
	diffDocumentLineNoWidth,
	diffLineMarker,
	diffLineNoWidth,
	formatDiffGutter,
	getDiffRowAnchor,
	MAX_DIFF_LINES,
	projectDiffDocument,
	resolveDiffSourcePoint,
} from "@shared/pretext-layout/diff-core";
import {
	type DiffRowLayout,
	type DiffRowsLayout,
	diffPositionAtOffset,
	diffRowAtOffset,
	diffRowBodyTop,
	diffRowTarget,
	estimatedDiffRowTop,
	layoutDiffRows,
	sliceDiffFragments,
} from "@shared/pretext-layout/diff-layout";
import type { ParsedDiffHunk } from "@shared/pretext-layout/parse-unified-diff";
import { getTypographyRevision, onTypographyChange } from "@shared/pretext-layout/typography";
import { findVisibleRange, spacerHeights } from "@shared/pretext-layout/vlist-virtualization";
import {
	Fragment,
	memo,
	useLayoutEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { useTranslation } from "react-i18next";
import { useContentViewport } from "./AutoFollowScroll";
import { DiffWordTokens } from "./DiffWordTokens";

export interface DiffContentProps {
	document?: DiffDocument;
	/** Git-owned rows are never reconstructed into sources or re-diffed. */
	lines?: readonly DiffLine[];
	hunks?: readonly ParsedDiffHunk[];
	wordWrap?: boolean;
	language?: string;
	lineNumberPrefix?: string;
	lineNoWidth?: number;
	gutterMinWidth?: number;
	/** Initial inner width, including gutter, excluding the host's padding. */
	contentWidth?: number;
	onNearBottom?: () => void;
}

const EMPTY_LINES: readonly DiffLine[] = [];
const EMPTY_HUNKS: readonly ParsedDiffHunk[] = [];
const WINDOW_GUARD = 64;

interface ReadingAnchor {
	point: DiffSourcePoint | null;
	row: number;
	column: number;
	pixelOffset: number;
}

interface Frame {
	document: DiffDocument | undefined;
	lines: readonly DiffLine[];
	projection: DiffProjection | null;
	layout: DiffRowsLayout;
}

interface View {
	top: number;
	height: number;
	width: number;
}

function pointOf(line: DiffLine, side?: "old" | "new"): DiffSourcePoint | null {
	const row = line as DiffProjectedLine;
	return (side === "old" ? (row.oldPoint ?? row.newPoint) : (row.newPoint ?? row.oldPoint)) ?? null;
}

function readAnchor(frame: Frame, top: number, preferred?: "old" | "new"): ReadingAnchor | null {
	if (!frame.layout.totalRows) return null;
	const row = diffRowAtOffset(frame.layout, top);
	const local = row - frame.layout.startRow;
	if (local < 0 || local >= frame.lines.length) {
		return {
			point: frame.document ? getDiffRowAnchor(frame.document, row, preferred) : null,
			row,
			column: 0,
			pixelOffset: top - estimatedDiffRowTop(frame.layout, row, true),
		};
	}
	const position = diffPositionAtOffset(frame.layout, top);
	if (!position) return null;
	const line = frame.lines[position.index];
	const point = line ? pointOf(line, preferred) : null;
	return {
		point: point
			? { ...point, column: point.column + position.column, offset: point.offset + position.column }
			: null,
		row,
		column: position.column,
		pixelOffset: position.pixelOffset,
	};
}

function anchorTop(
	frame: Frame,
	anchor: ReadingAnchor,
): { top: number; loss: DiffProjection["anchorLossReason"] } {
	let row = Math.min(anchor.row, Math.max(0, frame.layout.totalRows - 1));
	let column = anchor.column;
	let loss: DiffProjection["anchorLossReason"] = null;
	if (frame.document && anchor.point) {
		const resolved = resolveDiffSourcePoint(frame.document, anchor.point);
		row = resolved.row;
		loss = resolved.reason;
		const line = frame.lines[row - frame.layout.startRow];
		const base = line ? pointOf(line, resolved.point?.side) : null;
		column = resolved.point ? Math.max(0, resolved.point.column - (base?.column ?? 0)) : 0;
	}
	if (!frame.layout.totalRows || loss === "epoch" || loss === "side") return { top: 0, loss };
	const target = diffRowTarget(frame.layout, row - frame.layout.startRow, column);
	const pixelOffset = loss
		? 0
		: Math.min(frame.layout.typography.lineHeight - 1, anchor.pixelOffset);
	return {
		top: Math.max(0, (target?.top ?? estimatedDiffRowTop(frame.layout, row, true)) + pixelOffset),
		loss,
	};
}

function palette(dark: boolean) {
	return {
		removedLine: dark ? "var(--mantine-color-red-light)" : "rgba(255, 99, 71, 0.13)",
		addedLine: dark ? "var(--mantine-color-green-light)" : "rgba(46, 160, 67, 0.13)",
		removedWord: {
			backgroundColor: dark ? "var(--mantine-color-red-light-hover)" : "rgba(255, 99, 71, 0.25)",
			borderRadius: 2,
		},
		addedWord: {
			backgroundColor: dark ? "var(--mantine-color-green-light-hover)" : "rgba(46, 160, 67, 0.25)",
			borderRadius: 2,
		},
	};
}

const DiffLineRow = memo(function DiffLineRow({
	line,
	rowLayout,
	tokens,
	colors,
	gutterWidth,
	lineNoWidth,
	lineNumberPrefix,
	lineHeight,
	top,
	viewportTop,
	viewportHeight,
	overscan,
	focus,
}: {
	line: DiffLine;
	rowLayout: DiffRowLayout;
	tokens?: readonly ShikiToken[];
	colors: ReturnType<typeof palette>;
	gutterWidth: number;
	lineNoWidth?: number;
	lineNumberPrefix?: Parameters<typeof formatDiffGutter>[2];
	lineHeight: number;
	top: number;
	viewportTop: number;
	viewportHeight: number;
	overscan: number;
	focus: boolean;
}) {
	const start = Math.max(0, Math.floor((viewportTop - overscan - top) / lineHeight));
	const end = Math.min(
		rowLayout.visualLines.length,
		Math.ceil((viewportTop + viewportHeight + overscan - top) / lineHeight),
	);
	const gutterColor =
		line.type === "removed"
			? "var(--mantine-color-red-text)"
			: line.type === "added"
				? "var(--mantine-color-green-text)"
				: "var(--mantine-color-dimmed)";
	return (
		<div
			data-diff-row={line.type}
			data-diff-focus={focus || undefined}
			data-diff-source-line={pointOf(line)?.line}
			data-diff-source-side={pointOf(line)?.side}
			style={{
				position: "relative",
				height: rowLayout.height,
				backgroundColor:
					line.type === "removed"
						? colors.removedLine
						: line.type === "added"
							? colors.addedLine
							: undefined,
			}}
		>
			<span
				data-diff-gutter="true"
				style={{
					position: "absolute",
					top: 0,
					left: 0,
					width: gutterWidth,
					userSelect: "none",
					opacity: 0.6,
					color: gutterColor,
				}}
			>
				{lineNoWidth == null
					? diffLineMarker(line.type)
					: formatDiffGutter(line, lineNoWidth, lineNumberPrefix)}
			</span>
			{rowLayout.visualLines.slice(start, end).map((visual, offset) => {
				const words = sliceDiffFragments(line.wordChanges, visual.start, visual.end);
				const colored = sliceDiffFragments(tokens, visual.start, visual.end);
				return (
					<span
						key={visual.start}
						data-diff-visual-line={start + offset}
						style={{
							position: "absolute",
							left: gutterWidth,
							top: (start + offset) * lineHeight,
							height: lineHeight,
							whiteSpace: "pre",
						}}
					>
						{words ? (
							<DiffWordTokens wordChanges={words} tokens={colored} styles={colors} />
						) : colored ? (
							colored.map((token, index) => (
								// biome-ignore lint/suspicious/noArrayIndexKey: tokens partition this fixed text range
								<span key={index} style={{ color: token.color }}>
									{token.content}
								</span>
							))
						) : (
							<span
								style={
									line.type === "context" ? { color: "var(--mantine-color-dimmed)" } : undefined
								}
							>
								{line.content.slice(visual.start, visual.end)}
							</span>
						)}
					</span>
				);
			})}
		</div>
	);
});

/** One painter for inline, fullscreen and Git. The parent owns all scrolling. */
export const DiffContent = memo(function DiffContent({
	document: diffDocument,
	lines: providedLines = EMPTY_LINES,
	hunks = EMPTY_HUNKS,
	wordWrap = false,
	language,
	lineNumberPrefix: suppliedLineNumberPrefix,
	lineNoWidth: suppliedLineNoWidth,
	gutterMinWidth,
	contentWidth,
	onNearBottom,
}: DiffContentProps) {
	const viewport = useContentViewport();
	if (!viewport) throw new Error("DiffContent requires an AutoFollowScroll viewport");
	const {
		following,
		live,
		subscribeViewport,
		setRowTarget,
		scrollTo,
		notifyLayout,
		getSnapshot,
		setContentSize,
	} = viewport;
	const { t } = useTranslation("narrator");
	const dark = useComputedColorScheme("dark") !== "light";
	const colors = useMemo(() => palette(dark), [dark]);
	const typographyRevision = useSyncExternalStore(
		onTypographyChange,
		getTypographyRevision,
		getTypographyRevision,
	);
	const current = useRef<Frame | null>(null);
	const reading = useRef<ReadingAnchor | null>(null);
	const previousLive = useRef(live);
	const previousFollowing = useRef(following);
	const finalFocus = useRef<DiffSourcePoint | null>(null);
	const wasLive = useRef(live);
	const nearBottom = useRef(false);
	const [loss, setLoss] = useState<DiffProjection["anchorLossReason"]>(null);
	const [view, setView] = useState<View>({ top: 0, height: 0, width: 0 });
	const viewRef = useRef(view);
	const origin = viewport.contentPadding?.y ?? 0;
	const width = viewport.layout
		? Math.max(1, viewport.layout.width - 2 * (viewport.contentPadding?.x ?? 0))
		: view.width || contentWidth || 0;
	const height = viewport.layout?.height ?? view.height;
	const ready = width > 0 && height > 0;
	const [request, setRequest] = useState<{
		source: DiffDocument | readonly DiffLine[];
		row: number;
	} | null>(null);
	const source = diffDocument ?? providedLines;
	const lineNumberPrefixes = useMemo(
		() =>
			suppliedLineNumberPrefix ??
			(diffDocument
				? {
						old:
							diffDocument.startLine == null || !diffDocument.oldSource.range.originKnown
								? "~"
								: undefined,
						new:
							diffDocument.startLine == null || !diffDocument.newSource.range.originKnown
								? "~"
								: undefined,
					}
				: undefined),
		[diffDocument, suppliedLineNumberPrefix],
	);
	// Reserve room for the wider side without marking a located side as provisional.
	const lineNumberPrefix =
		typeof lineNumberPrefixes === "object"
			? (lineNumberPrefixes.old ?? lineNumberPrefixes.new)
			: lineNumberPrefixes;
	const previousDocument = current.current?.document;
	const settlingWithoutNewText =
		!live &&
		previousLive.current &&
		previousDocument &&
		diffDocument &&
		previousDocument.oldSource.text === diffDocument.oldSource.text &&
		previousDocument.newSource.text === diffDocument.newSource.text;
	const focus = settlingWithoutNewText
		? (finalFocus.current ?? diffDocument?.focus ?? null)
		: live || previousLive.current || !wasLive.current
			? (diffDocument?.focus ?? finalFocus.current)
			: finalFocus.current;

	const selected = useMemo(() => {
		const anchor = reading.current;
		const follow = following && (live || previousLive.current || !previousFollowing.current);
		if (diffDocument) {
			return projectDiffDocument(diffDocument, {
				anchor: follow && focus ? focus : anchor?.point,
				...(!follow && request?.source === diffDocument
					? { startRow: Math.max(0, request.row - MAX_DIFF_LINES / 2) }
					: {}),
				...(anchor == null && !follow ? { startRow: 0 } : {}),
				limit: MAX_DIFF_LINES,
			});
		}
		return null;
	}, [diffDocument, following, live, request, focus]);
	const startRow =
		selected?.startRow ??
		Math.max(
			0,
			Math.min(
				Math.max(0, providedLines.length - MAX_DIFF_LINES),
				(request?.source === providedLines ? request.row : (reading.current?.row ?? 0)) -
					MAX_DIFF_LINES / 2,
			),
		);
	const lines = useMemo(
		() => selected?.lines ?? providedLines.slice(startRow, startRow + MAX_DIFF_LINES),
		[selected, providedLines, startRow],
	);
	const lineNoWidth = useMemo(
		() =>
			suppliedLineNoWidth ??
			(diffDocument
				? diffDocumentLineNoWidth(diffDocument, lineNumberPrefix, gutterMinWidth)
				: lines.some((line) => line.oldLineNo != null || line.newLineNo != null)
					? diffLineNoWidth(lines, lineNumberPrefix, gutterMinWidth)
					: undefined),
		[diffDocument, lines, suppliedLineNoWidth, lineNumberPrefix, gutterMinWidth],
	);
	// Typography is an external pure-layout input; it changes no source/projection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: typographyRevision invalidates the layout-only snapshot
	const frame = useMemo<Frame>(
		() => ({
			document: diffDocument,
			lines,
			projection: selected,
			layout: layoutDiffRows(
				ready ? lines : EMPTY_LINES,
				{
					contentWidth: Math.max(1, width),
					wordWrap,
					lineNoWidth,
					startRow: ready ? startRow : 0,
					totalRows: ready ? (diffDocument?.totalRows ?? providedLines.length) : 0,
					hunks,
				},
				current.current?.layout,
			),
		}),
		[
			diffDocument,
			lines,
			selected,
			width,
			ready,
			wordWrap,
			lineNoWidth,
			startRow,
			providedLines.length,
			hunks,
			typographyRevision,
		],
	);
	const focusIndex = useMemo(() => {
		if (!diffDocument || !focus) return -1;
		const row = resolveDiffSourcePoint(diffDocument, focus).row - startRow;
		return row >= 0 && row < lines.length ? row : -1;
	}, [diffDocument, focus, startRow, lines.length]);
	const initialTarget = diffRowTarget(frame.layout, focusIndex, 0);
	const top =
		!current.current && following && initialTarget
			? Math.max(0, initialTarget.bottom - height)
			: Math.max(0, view.top - origin);
	const overscan = Math.min(400, Math.max(80, height / 2));
	const range = findVisibleRange(frame.layout.items, top, height, overscan);
	const spacers = spacerHeights(
		frame.layout.items,
		range.start,
		range.end,
		frame.layout.totalHeight,
	);
	const highlighted = useMemo(
		() => buildDiffHighlightPlan(lines.slice(range.start, range.end)),
		[lines, range.start, range.end],
	);
	const tokens0 = useShikiTokens(highlighted?.sources[0] ?? "", language);
	const tokens1 = useShikiTokens(highlighted?.sources[1] ?? "", language);

	useLayoutEffect(
		() =>
			subscribeViewport((snapshot) => {
				const active = current.current;
				if (!active || active.document !== diffDocument) return;
				const next = {
					top: snapshot.scrollTop,
					height: snapshot.viewportHeight,
					width: snapshot.contentWidth,
				};
				const moved = next.top !== viewRef.current.top;
				viewRef.current = next;
				const localTop = Math.max(0, next.top - snapshot.contentOrigin);
				if (next.height > 0 && next.width > 0)
					reading.current = readAnchor(
						active,
						localTop,
						reading.current?.point?.side ?? active.document?.focus?.side,
					);
				setView((old) =>
					old.top === next.top && old.height === next.height && old.width === next.width
						? old
						: next,
				);
				const row = diffRowAtOffset(active.layout, localTop);
				if (
					!viewport.isFollowing() &&
					active.layout.totalRows > MAX_DIFF_LINES &&
					(row < active.layout.startRow + WINDOW_GUARD ||
						row >= active.layout.startRow + active.lines.length - WINDOW_GUARD)
				)
					setRequest((old) =>
						old?.source === source && Math.abs(old.row - row) < WINDOW_GUARD
							? old
							: { source, row },
					);
				if (onNearBottom && moved) {
					const close = next.top + next.height >= snapshot.scrollHeight - 120;
					if (!close) nearBottom.current = false;
					else if (!nearBottom.current) {
						nearBottom.current = true;
						onNearBottom();
					}
				}
			}),
		[subscribeViewport, viewport.isFollowing, source, diffDocument, onNearBottom],
	);

	useLayoutEffect(() => {
		const previous = current.current;
		const anchor = reading.current;
		current.current = frame;
		setContentSize({ width: frame.layout.maxWidth, height: frame.layout.totalHeight });
		let target: { top: number; bottom: number } | null = null;
		if (frame.document && focus) {
			const resolved = resolveDiffSourcePoint(frame.document, focus);
			const local = resolved.row - frame.layout.startRow;
			const line = frame.lines[local];
			const base = line ? pointOf(line, resolved.point?.side) : null;
			if (!resolved.lost && resolved.point)
				target = diffRowTarget(
					frame.layout,
					local,
					Math.max(0, resolved.point.column - (base?.column ?? 0)),
				);
		}
		// Register the new coordinate system before the booked anchor correction.
		// The host performs its follow attempt only after notifyLayout below.
		setRowTarget(target ? { top: target.top + origin, bottom: target.bottom + origin } : null);
		if (ready && previous && previous !== frame && anchor) {
			const resolved = anchorTop(frame, anchor);
			// A follower has no pinned reading position to lose. For a paused reader,
			// clear a previous loss as soon as its current anchor maps successfully.
			setLoss(following ? null : resolved.loss);
			const next = Math.max(
				0,
				Math.min(resolved.top + origin, frame.layout.totalHeight + origin * 2 - height),
			);
			if (Math.abs(getSnapshot().scrollTop - next) > 0.5) scrollTo(next);
			viewRef.current = { ...viewRef.current, top: next };
			setView(viewRef.current);
			reading.current = readAnchor(frame, next - origin, anchor.point?.side);
		}
		if (live || previousLive.current) {
			finalFocus.current = focus ?? finalFocus.current;
			wasLive.current = true;
		}
		previousLive.current = live;
		previousFollowing.current = following;
		notifyLayout();
	}, [
		frame,
		focus,
		following,
		live,
		origin,
		setRowTarget,
		scrollTo,
		notifyLayout,
		getSnapshot,
		setContentSize,
		height,
		ready,
	]);

	useLayoutEffect(() => () => setRowTarget(null), [setRowTarget]);
	const activeLoss = following ? null : loss;
	const warning =
		activeLoss === "range"
			? t("diffReadRangeExpired", {
					defaultValue:
						"Reading position is outside the retained range; showing the nearest available line.",
				})
			: activeLoss
				? t("diffReadVersionChanged", {
						defaultValue:
							"The source range or version changed; the previous reading line is unavailable.",
					})
				: !live && diffDocument?.truncated
					? t("diffSourcePreview", {
							defaultValue: "Source content is incomplete; showing a bounded diff preview.",
						})
					: null;
	return (
		<div
			data-diff-content="true"
			data-diff-projection-start={startRow}
			data-diff-projection-count={lines.length}
			data-diff-document-revision={diffDocument?.revision}
			style={{
				position: "relative",
				// CSS-owned entries bootstrap with one intrinsic line, never guessed viewport dimensions.
				height: ready ? undefined : frame.layout.typography.lineHeight,
				width: ready ? frame.layout.maxWidth : undefined,
				minWidth: wordWrap ? 0 : frame.layout.maxWidth,
				font: frame.layout.typography.font,
				lineHeight: `${frame.layout.typography.lineHeight}px`,
				letterSpacing: frame.layout.typography.letterSpacing,
				whiteSpace: "pre",
				tabSize: 4,
			}}
		>
			{warning ? (
				<div
					data-diff-range-warning={activeLoss ?? "preview"}
					role="status"
					style={{ position: "sticky", top: 0, height: 0, zIndex: 1, pointerEvents: "none" }}
				>
					<span
						style={{
							background: "var(--mantine-color-body)",
							color: "var(--mantine-color-dimmed)",
							whiteSpace: "normal",
						}}
					>
						{warning}
					</span>
				</div>
			) : null}
			{spacers.top > 0 ? (
				<div aria-hidden="true" data-diff-spacer="top" style={{ height: spacers.top }} />
			) : null}
			{lines.slice(range.start, range.end).map((line, offset) => {
				const index = range.start + offset;
				const hunk = frame.layout.hunks.get(index);
				const rowLayout = frame.layout.rows[index];
				if (!rowLayout) return null;
				const ref = highlighted?.rows[offset];
				const tokens = ref ? (ref.source === 0 ? tokens0 : tokens1)?.[ref.line] : undefined;
				return (
					<Fragment key={(line as DiffProjectedLine).key ?? `${startRow + index}`}>
						{hunk ? (
							<div
								data-diff-hunk-separator="true"
								style={{
									height: frame.layout.typography.lineHeight + 2,
									boxSizing: "border-box",
									color: dark ? "#9198a1" : "#59636e",
									backgroundColor: dark ? "#121d2f" : "#ddf4ff",
									borderTop: `1px solid ${dark ? "#1f2a37" : "#c6e6ff"}`,
									borderBottom: `1px solid ${dark ? "#1f2a37" : "#c6e6ff"}`,
									userSelect: "none",
									paddingLeft: frame.layout.gutterWidth,
								}}
							>{`@@ ${hunk.range} @@${hunk.heading ? ` ${hunk.heading}` : ""}`}</div>
						) : null}
						<DiffLineRow
							line={line}
							rowLayout={rowLayout}
							tokens={tokens}
							colors={colors}
							gutterWidth={frame.layout.gutterWidth}
							lineNoWidth={lineNoWidth}
							lineNumberPrefix={lineNumberPrefixes}
							lineHeight={frame.layout.typography.lineHeight}
							top={diffRowBodyTop(frame.layout, index)}
							viewportTop={top}
							viewportHeight={height}
							overscan={overscan}
							focus={focusIndex === index}
						/>
					</Fragment>
				);
			})}
			{spacers.bottom > 0 ? (
				<div aria-hidden="true" data-diff-spacer="bottom" style={{ height: spacers.bottom }} />
			) : null}
		</div>
	);
});
