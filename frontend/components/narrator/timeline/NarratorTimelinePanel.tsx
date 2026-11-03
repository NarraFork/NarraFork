/**
 * NarratorTimelinePanel — per-turn, per-agent timeline of a narrator session.
 *
 * One continuous horizontal lane per agent. The primary lane covers the whole turn;
 * each subagent spawned during it gets its own lane underneath, joined to the moment
 * on its parent lane it was spawned from by a dashed connector. Every segment is
 * clickable for details. Data comes from `/api/narrators/:id/timeline`.
 *
 * Rendering is bounded by the viewport, not the data: each lane draws only the segments
 * around the visible scroll window, at most one per pixel column, and shares one hover
 * tooltip, so a dense turn at any zoom keeps a small, steady DOM.
 */

import {
	ActionIcon,
	Alert,
	Badge,
	Box,
	Button,
	Center,
	CloseButton,
	Group,
	Loader,
	Paper,
	Popover,
	ScrollArea,
	Select,
	Stack,
	Switch,
	Text,
	Tooltip,
} from "@mantine/core";
import {
	TIMELINE_CATEGORIES,
	type TimelineCategory,
	type TimelineItem,
	type TimelineLane,
	type TimelineSegment,
	type TimelineTurnSummary,
	type TurnTimelineResponse,
} from "@shared/narrator-timeline";
import {
	IconChevronLeft,
	IconChevronRight,
	IconExternalLink,
	IconRobot,
	IconUser,
	IconZoomIn,
	IconZoomOut,
	IconZoomReset,
} from "@tabler/icons-react";
import type { TFunction } from "i18next";
import {
	type CSSProperties,
	type MouseEvent,
	memo,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import { useTranslation } from "react-i18next";
import { formatLocaleTime } from "../../../lib/intl-format";
import { useNarratorDockContext } from "../dock/NarratorDockContext";
import {
	AXIS_HEIGHT,
	BAR_HEIGHT,
	branchConnectors,
	CATEGORY_COLOR,
	CATEGORY_OPACITY,
	chooseTickStep,
	clampPxPerSec,
	connectorPath,
	fitPxPerSec,
	formatSpan,
	LANE_GAP,
	LANE_HEIGHT,
	laneCenterY,
	MIN_SEGMENT_PX,
	segmentIndexAt,
	ticks,
	timeToX,
	visibleSegmentIndices,
} from "./timeline-layout";
import { useNarratorTimeline } from "./useNarratorTimeline";

const LABEL_WIDTH = 168;
const TRACK_PADDING_RIGHT = 24;
const TICK_LABEL_WIDTH = 60;

/** A segment is identified by its lane and start, which survive a live refresh. */
interface Selection {
	narratorId: string;
	startMs: number;
}

function formatClock(ms: number): string {
	return formatLocaleTime(ms, { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function segmentStyle(segment: TimelineSegment, left: number, width: number): CSSProperties {
	const style: CSSProperties = {
		position: "absolute",
		left,
		width: Math.max(MIN_SEGMENT_PX, width),
		top: (LANE_HEIGHT - BAR_HEIGHT) / 2,
		height: BAR_HEIGHT,
		background: CATEGORY_COLOR[segment.category],
		opacity: CATEGORY_OPACITY[segment.category] ?? 1,
		cursor: "pointer",
		border: "none",
		padding: 0,
	};
	if (segment.category === "after_turn") {
		style.background = `repeating-linear-gradient(45deg, ${CATEGORY_COLOR.after_turn} 0 4px, transparent 4px 8px)`;
		style.opacity = 0.6;
	}
	return style;
}

function laneLabel(lane: TimelineLane, t: TFunction): string {
	if (lane.type === "primary") return t("timeline.lanePrimary");
	return lane.subagentType
		? t("timeline.laneSubagentType", { type: lane.subagentType })
		: t("timeline.laneSubagent");
}

function failedSegment(segment: TimelineSegment, items: Record<string, TimelineItem>): boolean {
	return segment.itemIds.some((id) => {
		const item = items[id];
		return (item?.kind === "tool" && item.status === "fail") || !!item?.errorMessage;
	});
}

function TurnSelectLabel(turn: TimelineTurnSummary, t: TFunction) {
	const parts = [t("timeline.turn", { index: turn.index })];
	parts.push(formatClock(Date.parse(turn.startedAt)));
	if (turn.status !== "completed") parts.push(t(`timeline.status.${turn.status}`));
	if (turn.triggerExcerpt) parts.push(turn.triggerExcerpt);
	return parts.join(" · ");
}

function segmentTitle(
	segment: TimelineSegment,
	items: Record<string, TimelineItem>,
	t: TFunction,
): string {
	const head = `${t(`timeline.category.${segment.category}`)} · ${formatSpan(
		segment.endMs - segment.startMs,
	)}`;
	if (segment.merged)
		return `${head} · ${t("timeline.detail.merged", { count: segment.merged.count })}`;
	if (segment.itemIds.length > 1)
		return `${head} · ${t("timeline.parallel", { count: segment.itemIds.length })}`;
	const item = segment.itemIds[0] ? items[segment.itemIds[0]] : undefined;
	if (!item) return head;
	if (item.kind === "tool")
		return `${head} · ${item.toolName}${item.summary ? `: ${item.summary}` : ""}`;
	return item.model ? `${head} · ${item.model}` : head;
}

interface LaneTrackProps {
	lane: TimelineLane;
	laneIndex: number;
	items: Record<string, TimelineItem>;
	origin: number;
	scale: number;
	/** Track pixels to draw: the visible window plus a margin on both sides. */
	fromPx: number;
	toPx: number;
	selectedStartMs: number | null;
	onSelect: (narratorId: string, startMs: number | null) => void;
	onOpenSubagent?: (narratorId: string) => void;
}

const LaneTrack = memo(function LaneTrack({
	lane,
	laneIndex,
	items,
	origin,
	scale,
	fromPx,
	toPx,
	selectedStartMs,
	onSelect,
	onOpenSubagent,
}: LaneTrackProps) {
	const { t } = useTranslation("narrator");
	const [hovered, setHovered] = useState<number | null>(null);
	const selectedIndex =
		selectedStartMs === null ? -1 : segmentIndexAt(lane.segments, selectedStartMs);

	const indices = useMemo(() => {
		const visible = visibleSegmentIndices(lane.segments, origin, scale, fromPx, toPx);
		if (selectedIndex >= 0 && !visible.includes(selectedIndex)) visible.push(selectedIndex);
		return visible;
	}, [lane.segments, origin, scale, fromPx, toPx, selectedIndex]);

	// Built once per data/zoom/window change; hovering only re-renders the tooltip label.
	const segments = useMemo(
		() =>
			indices.map((index) => {
				const segment = lane.segments[index];
				const left = timeToX(segment.startMs, origin, scale);
				const width = timeToX(segment.endMs, origin, scale) - left;
				const isSelected = index === selectedIndex;
				const style = segmentStyle(segment, left, width);
				if (failedSegment(segment, items)) {
					style.boxShadow = "inset 0 0 0 2px var(--mantine-color-red-6)";
				}
				if (isSelected) {
					style.outline = "2px solid var(--mantine-color-text)";
					style.zIndex = 1;
				}
				const button = (
					<Box
						key={segment.startMs}
						component="button"
						type="button"
						data-index={index}
						aria-label={t(`timeline.category.${segment.category}`)}
						aria-expanded={isSelected}
						data-category={segment.category}
						style={style}
						onClick={() => onSelect(lane.narratorId, isSelected ? null : segment.startMs)}
					/>
				);
				if (!isSelected) return button;
				// The detail floats over the page instead of growing the panel.
				return (
					<Popover
						key={segment.startMs}
						opened
						onChange={(opened) => !opened && onSelect(lane.narratorId, null)}
						onDismiss={() => onSelect(lane.narratorId, null)}
						position="bottom"
						withArrow
						shadow="md"
						width={340}
						withinPortal
						closeOnEscape
						trapFocus={false}
						middlewares={{ flip: true, shift: true }}
					>
						<Popover.Target>{button}</Popover.Target>
						<Popover.Dropdown p="xs">
							<ScrollArea.Autosize mah={360} type="auto">
								<SegmentDetail
									lane={lane}
									segment={segment}
									items={items}
									onClose={() => onSelect(lane.narratorId, null)}
									onOpenSubagent={onOpenSubagent}
								/>
							</ScrollArea.Autosize>
						</Popover.Dropdown>
					</Popover>
				);
			}),
		[indices, lane, items, origin, scale, selectedIndex, onSelect, onOpenSubagent, t],
	);

	const hoveredSegment =
		hovered !== null && hovered !== selectedIndex ? lane.segments[hovered] : undefined;
	const onMouseOver = (event: MouseEvent<HTMLDivElement>) => {
		const target = (event.target as HTMLElement).closest<HTMLElement>("[data-index]");
		const index = target ? Number(target.dataset.index) : null;
		setHovered(index !== null && Number.isFinite(index) ? index : null);
	};

	return (
		<Tooltip.Floating
			label={hoveredSegment ? segmentTitle(hoveredSegment, items, t) : ""}
			disabled={!hoveredSegment}
		>
			<Box
				data-testid="timeline-lane"
				onMouseOver={onMouseOver}
				onMouseLeave={() => setHovered(null)}
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					top: laneCenterY(laneIndex) - LANE_HEIGHT / 2,
					height: LANE_HEIGHT,
				}}
			>
				{segments}
				{lane.coveredUntilMs !== null && (
					<Box
						aria-hidden
						style={{
							position: "absolute",
							left: timeToX(lane.coveredUntilMs, origin, scale),
							width: Math.max(
								MIN_SEGMENT_PX,
								timeToX(lane.endMs, origin, scale) - timeToX(lane.coveredUntilMs, origin, scale),
							),
							top: (LANE_HEIGHT - BAR_HEIGHT) / 2,
							height: BAR_HEIGHT,
							border: "1px dashed var(--mantine-color-default-border)",
							pointerEvents: "none",
						}}
					/>
				)}
				{lane.live && (
					<Box
						style={{
							position: "absolute",
							left: timeToX(lane.endMs, origin, scale) - 1,
							top: 2,
							bottom: 2,
							width: 2,
							background: "var(--mantine-color-blue-5)",
						}}
					/>
				)}
			</Box>
		</Tooltip.Floating>
	);
});

export function NarratorTimelinePanel({
	narratorId,
	onContentHeight,
}: {
	narratorId: string;
	/**
	 * Natural height of the panel content, reported whenever it changes, so a host
	 * (the dock group) can shrink to fit instead of leaving blank space under one lane.
	 */
	onContentHeight?: (height: number) => void;
}) {
	const { t } = useTranslation("narrator");
	const dock = useNarratorDockContext();
	const [selectedTurnId, setSelectedTurnId] = useState<string | null>(null);
	const {
		turns: turnList,
		turnsQuery: turns,
		timeline,
		hasOlderTurns,
		loadOlderTurns,
	} = useNarratorTimeline(narratorId, selectedTurnId);
	const [pxPerSec, setPxPerSec] = useState<number | null>(null);
	const [selection, setSelection] = useState<Selection | null>(null);
	const viewportRef = useRef<HTMLDivElement>(null);
	const rootRef = useRef<HTMLDivElement>(null);
	const [viewportWidth, setViewportWidth] = useState(0);
	const [scrollX, setScrollX] = useState(0);

	useEffect(() => {
		const node = rootRef.current;
		if (!node || !onContentHeight) return;
		const report = () => onContentHeight(Math.ceil(node.getBoundingClientRect().height));
		const observer = new ResizeObserver(report);
		observer.observe(node);
		report();
		return () => observer.disconnect();
	}, [onContentHeight]);

	useEffect(() => {
		const node = viewportRef.current;
		if (!node) return;
		const observer = new ResizeObserver((entries) => {
			setViewportWidth(entries[0]?.contentRect.width ?? 0);
		});
		observer.observe(node);
		return () => observer.disconnect();
	}, []);

	const data: TurnTimelineResponse | undefined = timeline.data;
	const activeTurnId = data?.turn?.id ?? null;

	// Escape closes the detail popover. Focus stays on the segment (no focus trap, so the
	// timeline keeps scrolling and zooming), which is outside the dropdown Mantine listens on.
	useEffect(() => {
		if (!selection) return;
		// Capture phase: the segment button keeps focus, and the portaled popover
		// stops the bubbling Escape before it reaches a document bubble listener.
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "Escape") return;
			event.preventDefault();
			event.stopPropagation();
			setSelection(null);
		};
		document.addEventListener("keydown", onKey, true);
		return () => document.removeEventListener("keydown", onKey, true);
	}, [selection]);

	// Switching turns resets the zoom (fit) and the selection.
	// biome-ignore lint/correctness/useExhaustiveDependencies: reset keyed on the turn id
	useEffect(() => {
		setPxPerSec(null);
		setSelection(null);
	}, [activeTurnId]);

	const spanMs = data ? Math.max(1, data.endMs - data.startMs) : 1;
	const trackWidth = Math.max(0, viewportWidth - LABEL_WIDTH - TRACK_PADDING_RIGHT);
	const fit = fitPxPerSec(spanMs, trackWidth);
	const scale = pxPerSec === null ? fit : clampPxPerSec(pxPerSec, spanMs);
	const contentWidth = Math.floor(
		Math.max(trackWidth, (spanMs / 1000) * scale) + TRACK_PADDING_RIGHT,
	);
	const origin = data?.startMs ?? 0;

	// Draw one viewport of margin either side, re-windowed only when the scroll position
	// crosses into another viewport-sized page, so scrolling does not re-render every frame.
	const pageWidth = Math.max(1, trackWidth);
	const page = Math.floor(scrollX / pageWidth);
	const fromPx = (page - 1) * pageWidth;
	const toPx = (page + 2) * pageWidth;

	const connectors = useMemo(
		() => (data ? branchConnectors(data.lanes, origin, scale) : []),
		[data, origin, scale],
	);
	const tickStep = chooseTickStep(scale);
	// A label is ~60px wide and starts at its tick, so the last one would overhang
	// the track and add a horizontal scrollbar at fit width.
	const tickList = ticks(spanMs, tickStep, (fromPx / scale) * 1000, (toPx / scale) * 1000).filter(
		(offset) => timeToX(origin + offset, origin, scale) <= contentWidth - TICK_LABEL_WIDTH,
	);

	const turnIndex = turnList.findIndex((turn) => turn.id === activeTurnId);
	const olderTurn = turnIndex >= 0 ? turnList[turnIndex + 1] : undefined;
	const newerTurn = turnIndex > 0 ? turnList[turnIndex - 1] : undefined;
	const canGoOlder = !!olderTurn || (turnIndex >= 0 && hasOlderTurns);
	const goOlder = async () => {
		if (olderTurn) return setSelectedTurnId(olderTurn.id);
		const result = await loadOlderTurns();
		const list = result.data?.pages.flatMap((p) => p.turns) ?? [];
		const next = list[list.findIndex((turn) => turn.id === activeTurnId) + 1];
		if (next) setSelectedTurnId(next.id);
	};

	const zoom = (factor: number) => setPxPerSec(clampPxPerSec(scale * factor, spanMs));
	const onSelect = useMemo(
		() => (laneId: string, startMs: number | null) =>
			setSelection(startMs === null ? null : { narratorId: laneId, startMs }),
		[],
	);

	const totals = useMemo(() => {
		const sum: Partial<Record<TimelineCategory, number>> = {};
		const primary = data?.lanes[0];
		if (!primary) return sum;
		for (const [category, ms] of Object.entries(primary.totals)) {
			sum[category as TimelineCategory] = ms ?? 0;
		}
		return sum;
	}, [data]);
	const primarySpan = data?.lanes[0] ? data.lanes[0].endMs - data.lanes[0].startMs : 0;
	// Shares of the covered time, which is the whole lane unless it hit its row cap.
	const coveredSpan = Object.values(totals).reduce((sum, ms) => sum + (ms ?? 0), 0);
	const merged = data?.lanes.some((lane) => lane.segments.some((segment) => segment.merged));
	const uncovered = data?.lanes.filter((lane) => lane.coveredUntilMs !== null) ?? [];

	if (turns.isError || timeline.isError) {
		return (
			<Center p="md">
				<Alert color="red" title={t("timeline.loadFailed")}>
					<Button
						size="xs"
						variant="light"
						onClick={() => {
							turns.refetch();
							timeline.refetch();
						}}
					>
						{t("timeline.retry")}
					</Button>
				</Alert>
			</Center>
		);
	}

	return (
		<Stack ref={rootRef} gap={6} p="xs" data-testid="narrator-timeline">
			<Group gap={6} wrap="nowrap">
				<ActionIcon
					variant="subtle"
					size="sm"
					disabled={!canGoOlder}
					loading={turns.isFetchingNextPage}
					aria-label={t("timeline.prevTurn")}
					onClick={() => void goOlder()}
				>
					<IconChevronLeft size={16} />
				</ActionIcon>
				<Select
					size="xs"
					style={{ flex: 1, minWidth: 120 }}
					data={turnList.map((turn) => ({ value: turn.id, label: TurnSelectLabel(turn, t) }))}
					value={activeTurnId}
					onChange={(value) => value && setSelectedTurnId(value)}
					allowDeselect={false}
					comboboxProps={{ withinPortal: true }}
					aria-label={t("timeline.title")}
				/>
				<ActionIcon
					variant="subtle"
					size="sm"
					disabled={!newerTurn}
					aria-label={t("timeline.nextTurn")}
					onClick={() => newerTurn && setSelectedTurnId(newerTurn.id)}
				>
					<IconChevronRight size={16} />
				</ActionIcon>
				<Switch
					size="xs"
					label={t("timeline.followLatest")}
					checked={selectedTurnId === null}
					onChange={(event) =>
						setSelectedTurnId(event.currentTarget.checked ? null : (activeTurnId ?? null))
					}
				/>
				<Tooltip label={t("timeline.zoomOut")}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={t("timeline.zoomOut")}
						onClick={() => zoom(1 / 1.6)}
					>
						<IconZoomOut size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("timeline.zoomIn")}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={t("timeline.zoomIn")}
						onClick={() => zoom(1.6)}
					>
						<IconZoomIn size={16} />
					</ActionIcon>
				</Tooltip>
				<Tooltip label={t("timeline.fit")}>
					<ActionIcon
						variant="subtle"
						size="sm"
						aria-label={t("timeline.fit")}
						onClick={() => setPxPerSec(null)}
					>
						<IconZoomReset size={16} />
					</ActionIcon>
				</Tooltip>
			</Group>

			{data?.turn && (
				<Group gap={6} wrap="wrap">
					<Badge size="sm" variant="light" color={data.turn.status === "running" ? "blue" : "gray"}>
						{t(`timeline.status.${data.turn.status}`)}
					</Badge>
					<Text size="xs" c="dimmed">
						{t("timeline.total", { duration: formatSpan(primarySpan) })}
						{data.turn.derived ? ` ${t("timeline.turnDerived")}` : ""}
					</Text>
				</Group>
			)}

			<Group gap={10} wrap="wrap" data-testid="timeline-legend">
				{TIMELINE_CATEGORIES.filter((category) => (totals[category] ?? 0) > 0).map((category) => (
					<Group key={category} gap={4} wrap="nowrap">
						<Box
							w={10}
							h={10}
							style={{
								borderRadius: 2,
								background: CATEGORY_COLOR[category],
								opacity: CATEGORY_OPACITY[category] ?? 1,
							}}
						/>
						<Text size="xs">
							{t(`timeline.category.${category}`)} {formatSpan(totals[category] ?? 0)}
							<Text span size="xs" c="dimmed">
								{" "}
								{coveredSpan > 0
									? `${Math.round(((totals[category] ?? 0) / coveredSpan) * 100)}%`
									: ""}
							</Text>
						</Text>
					</Group>
				))}
			</Group>

			<Box ref={viewportRef} style={{ position: "relative", minHeight: 0 }}>
				{!data && (timeline.isLoading || turns.isLoading) && (
					<Center p="md">
						<Loader size="sm" />
					</Center>
				)}
				{data && data.lanes.length === 0 && (
					<Text size="sm" c="dimmed" p="md">
						{t("timeline.noTurns")}
					</Text>
				)}
				{!timeline.isLoading && !data && turnList.length === 0 && (
					<Text size="sm" c="dimmed" p="md">
						{t("timeline.noTurns")}
					</Text>
				)}
				{data && data.lanes.length > 0 && (
					<Box style={{ display: "flex" }}>
						<Box w={LABEL_WIDTH} style={{ flex: "none", paddingTop: AXIS_HEIGHT }}>
							{data.lanes.map((lane) => (
								<Group
									key={lane.narratorId}
									gap={4}
									wrap="nowrap"
									h={LANE_HEIGHT}
									mb={LANE_GAP}
									data-testid="timeline-lane-label"
									style={{
										paddingLeft: lane.depth * 12,
										borderLeft:
											lane.depth > 0 ? "2px dashed var(--mantine-color-cyan-5)" : undefined,
									}}
								>
									{lane.type === "primary" ? (
										<IconUser size={14} style={{ flex: "none" }} />
									) : (
										<IconRobot
											size={14}
											color="var(--mantine-color-cyan-5)"
											style={{ flex: "none" }}
										/>
									)}
									<Box style={{ minWidth: 0 }}>
										<Text size="xs" fw={600} truncate>
											{laneLabel(lane, t)}
										</Text>
										<Text size="10px" c="dimmed" truncate title={lane.title ?? undefined}>
											{lane.title ?? lane.narratorId}
										</Text>
									</Box>
								</Group>
							))}
						</Box>
						<ScrollArea
							style={{ flex: 1, minWidth: 0 }}
							type="auto"
							scrollbarSize={8}
							onScrollPositionChange={({ x }) => setScrollX(x)}
						>
							<Box
								style={{
									position: "relative",
									width: contentWidth,
									height: AXIS_HEIGHT + data.lanes.length * (LANE_HEIGHT + LANE_GAP),
								}}
							>
								{tickList.map((offset) => (
									<Box
										key={offset}
										style={{
											position: "absolute",
											left: timeToX(origin + offset, origin, scale),
											top: 0,
											bottom: 0,
											borderLeft: "1px solid var(--mantine-color-default-border)",
										}}
									>
										<Text size="10px" c="dimmed" pl={3} style={{ whiteSpace: "nowrap" }}>
											{offset === 0 ? formatClock(origin) : `+${formatSpan(offset)}`}
										</Text>
									</Box>
								))}
								<svg
									width={contentWidth}
									height={AXIS_HEIGHT + data.lanes.length * (LANE_HEIGHT + LANE_GAP)}
									style={{ position: "absolute", inset: 0, pointerEvents: "none", zIndex: 2 }}
									aria-hidden="true"
									data-testid="timeline-connectors"
								>
									{connectors.map((connector) => (
										<g key={connector.childNarratorId}>
											<circle
												cx={connector.x1}
												cy={connector.y1 - BAR_HEIGHT / 2}
												r={4}
												fill="var(--mantine-color-body)"
												stroke="var(--mantine-color-cyan-5)"
												strokeWidth={2}
											/>
											<path
												d={connectorPath(connector)}
												fill="none"
												stroke="var(--mantine-color-cyan-5)"
												strokeWidth={1.5}
												strokeDasharray="4 3"
											/>
										</g>
									))}
								</svg>
								{data.lanes.map((lane, laneIndex) => (
									<LaneTrack
										key={lane.narratorId}
										lane={lane}
										laneIndex={laneIndex}
										items={data.items}
										origin={origin}
										scale={scale}
										fromPx={fromPx}
										toPx={toPx}
										selectedStartMs={
											selection?.narratorId === lane.narratorId ? selection.startMs : null
										}
										onSelect={onSelect}
										onOpenSubagent={dock?.openSubagentPanel}
									/>
								))}
							</Box>
						</ScrollArea>
					</Box>
				)}
			</Box>

			{data && data.omittedLanes > 0 && (
				<Text size="xs" c="dimmed">
					{t("timeline.omittedLanes", { count: data.omittedLanes })}
				</Text>
			)}
			{merged && (
				<Text size="xs" c="dimmed">
					{t("timeline.truncated")}
				</Text>
			)}
			{uncovered.map((lane) => (
				<Text key={lane.narratorId} size="xs" c="dimmed">
					{t("timeline.notCovered", {
						lane: laneLabel(lane, t),
						at: formatClock(lane.coveredUntilMs ?? lane.endMs),
					})}
				</Text>
			))}

			{data && data.lanes.length > 0 && !selection && (
				<Text size="xs" c="dimmed">
					{t("timeline.clickHint")}
				</Text>
			)}
		</Stack>
	);
}

function DetailRow({ label, value }: { label: string; value: string | number | null | undefined }) {
	if (value === null || value === undefined || value === "") return null;
	return (
		<Group gap={6} wrap="nowrap" align="flex-start">
			<Text size="xs" c="dimmed" w={110} style={{ flex: "none" }}>
				{label}
			</Text>
			<Text size="xs" style={{ wordBreak: "break-word" }}>
				{value}
			</Text>
		</Group>
	);
}

function ItemDetail({
	item,
	onOpenSubagent,
}: {
	item: TimelineItem;
	onOpenSubagent?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("narrator");
	if (item.kind === "model") {
		return (
			<Paper withBorder p={6} radius="sm">
				<DetailRow label={t("timeline.detail.model")} value={item.model} />
				<DetailRow label={t("timeline.detail.requestKind")} value={item.requestKind} />
				<DetailRow
					label={t("timeline.detail.duration")}
					value={item.durationMs !== null ? formatSpan(item.durationMs) : null}
				/>
				<DetailRow
					label={t("timeline.detail.ttft")}
					value={item.ttftMs !== null ? formatSpan(item.ttftMs) : null}
				/>
				<DetailRow
					label={t("timeline.detail.tokens")}
					value={
						item.inputTokens || item.outputTokens
							? `${item.inputTokens} / ${item.outputTokens}`
							: null
					}
				/>
				<DetailRow label={t("timeline.detail.error")} value={item.errorMessage} />
			</Paper>
		);
	}
	return (
		<Paper withBorder p={6} radius="sm">
			<Group justify="space-between" wrap="nowrap">
				<Text size="xs" fw={600}>
					{item.toolName}
				</Text>
				{item.childNarratorId && onOpenSubagent && (
					<Button
						size="compact-xs"
						variant="light"
						leftSection={<IconExternalLink size={12} />}
						onClick={() => item.childNarratorId && onOpenSubagent(item.childNarratorId)}
					>
						{t("timeline.openSubagent")}
					</Button>
				)}
			</Group>
			<DetailRow label={t("timeline.detail.summary")} value={item.summary} />
			<DetailRow label={t("timeline.detail.status")} value={item.status} />
			<DetailRow
				label={t("timeline.detail.duration")}
				value={item.durationMs !== null ? formatSpan(item.durationMs) : null}
			/>
			<DetailRow label={t("timeline.detail.decidedBy")} value={item.permissionDecidedBy} />
			<DetailRow label={t("timeline.detail.device")} value={item.executionDeviceId} />
			<DetailRow label={t("timeline.detail.background")} value={item.isBackground ? "✓" : null} />
			<DetailRow label={t("timeline.detail.error")} value={item.errorMessage} />
		</Paper>
	);
}

function SegmentDetail({
	lane,
	segment,
	items,
	onClose,
	onOpenSubagent,
}: {
	lane: TimelineLane;
	segment: TimelineSegment;
	items: Record<string, TimelineItem>;
	onClose: () => void;
	onOpenSubagent?: (narratorId: string) => void;
}) {
	const { t } = useTranslation("narrator");
	const segmentItems = segment.itemIds
		.map((id) => items[id])
		.filter((item): item is TimelineItem => !!item);
	const composition = segment.merged
		? TIMELINE_CATEGORIES.filter((category) => (segment.merged?.totals[category] ?? 0) > 0)
		: [];
	return (
		<Stack gap={6} data-testid="timeline-detail">
			<Group justify="space-between" wrap="nowrap">
				<Group gap={6} wrap="nowrap">
					<Box
						w={10}
						h={10}
						style={{ borderRadius: 2, background: CATEGORY_COLOR[segment.category], flex: "none" }}
					/>
					<Text size="sm" fw={600}>
						{t(`timeline.category.${segment.category}`)}
					</Text>
					<Text size="xs" c="dimmed">
						{laneLabel(lane, t)}
					</Text>
				</Group>
				<CloseButton size="sm" aria-label={t("timeline.closeDetail")} onClick={onClose} />
			</Group>
			<DetailRow label={t("timeline.detail.start")} value={formatClock(segment.startMs)} />
			<DetailRow label={t("timeline.detail.end")} value={formatClock(segment.endMs)} />
			<DetailRow
				label={t("timeline.detail.duration")}
				value={formatSpan(segment.endMs - segment.startMs)}
			/>
			{segment.category === "after_turn" && (
				<Text size="xs" c="dimmed">
					{t("timeline.detail.afterTurn")}
				</Text>
			)}
			{segment.category === "overhead" && !segment.merged && (
				<Text size="xs" c="dimmed">
					{t("timeline.detail.noItems")}
				</Text>
			)}
			{segment.merged && (
				<Stack gap={2}>
					<Text size="xs" c="dimmed">
						{t("timeline.detail.merged", { count: segment.merged.count })}
					</Text>
					{composition.map((category) => (
						<Group key={category} gap={6} wrap="nowrap">
							<Box
								w={8}
								h={8}
								style={{ borderRadius: 2, background: CATEGORY_COLOR[category], flex: "none" }}
							/>
							<Text size="xs">
								{t(`timeline.category.${category}`)}{" "}
								{formatSpan(segment.merged?.totals[category] ?? 0)}
							</Text>
						</Group>
					))}
				</Stack>
			)}
			{!segment.merged && segmentItems.length > 1 && (
				<Text size="xs" c="dimmed">
					{t("timeline.parallel", { count: segmentItems.length })}
				</Text>
			)}
			{segmentItems.slice(0, 20).map((item) => (
				<ItemDetail key={item.id} item={item} onOpenSubagent={onOpenSubagent} />
			))}
		</Stack>
	);
}
