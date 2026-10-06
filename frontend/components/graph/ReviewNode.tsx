import { Badge, Card, Group, Text } from "@mantine/core";
import { IconEye } from "@tabler/icons-react";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import { lazy, memo, Suspense, useCallback, useRef } from "react";
import { useTranslation } from "react-i18next";
import { statusRegistry } from "../../lib/constants";
import { NarratorPanelSkeleton } from "../narrator/NarratorPanelSkeleton";
import { NodeTitleEditor } from "./NodeTitleEditor";

// Lazy for the same reason as ChapterNode: dockview and its panels are a large
// chunk that only an expanded node needs.
const ChapterNodeDock = lazy(() =>
	import("./dock/ChapterNodeDock").then((m) => ({ default: m.ChapterNodeDock })),
);

export interface ReviewNodeData {
	title: string;
	status: string;
	branch: string;
	narratorCount: number;
	narratorId?: string | null;
	narratorStatus?: string | null;
	narratorSubstatus?: string[] | null;
	reviewSourceChapterId?: string | null;
	reviewStatus?: string | null;
	expanded?: boolean;
	onToggleExpand?: (chapterId: string) => void;
	[key: string]: unknown;
}

const NODE_WIDTH = 260;
const NODE_HEIGHT = 100;
/** Matches ChapterNode: narrower than this a split-right tool panel is unusable. */
const MIN_RESIZE_WIDTH = 480;
const MIN_RESIZE_HEIGHT = 300;
const MAX_REVIEW_NODE_TITLE_CHARS = 500;

function clampReviewNodeTitle(value: string): string {
	return value.length > MAX_REVIEW_NODE_TITLE_CHARS
		? `${value.slice(0, MAX_REVIEW_NODE_TITLE_CHARS)}…`
		: value;
}

function ReviewNodeInner({ data, id }: NodeProps) {
	const d = data as ReviewNodeData;
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	const expanded = !!d.expanded;
	const hasNarrator = !!d.narratorId;
	const reviewStatus = d.reviewStatus ?? "reviewing";
	const displayTitle = clampReviewNodeTitle(d.title);
	const narratorDisplay = d.narratorStatus
		? statusRegistry.narratorEffective(d.narratorStatus, d.narratorSubstatus ?? undefined)
		: null;

	const statusColor =
		reviewStatus === "concluded" ? "green" : reviewStatus === "reviewing" ? "yellow" : "gray";

	const toggleExpand = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (!hasNarrator) return;
			d.onToggleExpand?.(id);
		},
		[hasNarrator, d.onToggleExpand, id],
	);

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	// See ChapterNode: the resize-tracking state existed only for NarratorPanel's
	// skeleton overlay, which the dock's CSS-driven panel layout makes unnecessary.

	// Allow Ctrl+wheel to pass through to ReactFlow for zoom even when over the dock
	// (handled by NowheelPassthrough in NarraFlow — no per-node listener needed)
	const panelWheelRef = useRef<HTMLDivElement>(null);

	return (
		<>
			{expanded && (
				<NodeResizeControl
					minWidth={MIN_RESIZE_WIDTH}
					minHeight={MIN_RESIZE_HEIGHT}
					position="bottom-right"
					style={{
						background: "transparent",
						border: "none",
					}}
				>
					<div
						style={{
							width: 14,
							height: 14,
							borderRadius: "50%",
							background: "#fab005",
							opacity: 0.7,
							cursor: "nwse-resize",
							position: "relative",
							top: -4,
							left: -4,
						}}
					/>
				</NodeResizeControl>
			)}
			<Handle type="target" position={Position.Top} id="top" style={handleStyle} />
			<Handle type="source" position={Position.Top} id="top-src" style={handleStyle} />
			<Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
			<Handle type="source" position={Position.Bottom} id="bottom-src" style={handleStyle} />
			<Handle type="target" position={Position.Left} id="left" style={handleStyle} />
			<Handle type="source" position={Position.Left} id="left-src" style={handleStyle} />
			<Handle type="target" position={Position.Right} id="right" style={handleStyle} />
			<Handle type="source" position={Position.Right} id="right-src" style={handleStyle} />
			<Card
				shadow="sm"
				padding={0}
				radius="md"
				withBorder
				style={{
					width: expanded ? "100%" : NODE_WIDTH,
					height: expanded ? "100%" : NODE_HEIGHT,
					borderColor: "#fab005",
					borderWidth: 2,
					borderStyle: "dashed",
					position: "relative",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
				onDoubleClick={toggleExpand}
			>
				{/* Header — acts as drag handle when expanded */}
				<Group
					className={expanded ? "chapter-node-drag-handle" : undefined}
					gap={6}
					px="xs"
					py={6}
					style={{
						background: "rgba(250, 176, 5, 0.08)",
						borderBottom: "1px solid var(--mantine-color-dark-4)",
						cursor: "grab",
						flexShrink: 0,
					}}
				>
					<IconEye size={14} color="#fab005" />
					{/* Same reason as ChapterNode: expanded, the embedded panel hides its own
					    title row, so this is the copy the reader actually sees. */}
					<NodeTitleEditor
						chapterId={id}
						narratorId={d.narratorId ?? null}
						title={displayTitle}
						showActions={expanded}
						size="xs"
						textStyle={{ flex: 1 }}
					/>
					<Badge size="xs" color={statusColor} variant="light">
						{t(`reviewStatus.${reviewStatus}`, reviewStatus)}
					</Badge>
				</Group>

				{/* Narrator status indicator */}
				{!expanded && hasNarrator && d.narratorStatus && narratorDisplay && (
					<Group gap={4} px="xs" py={4}>
						<div
							style={{
								width: 6,
								height: 6,
								borderRadius: "50%",
								background: statusRegistry.accentVar(narratorDisplay, 5),
							}}
						/>
						<Text size="xs" c="dimmed">
							{tc(narratorDisplay.i18nKey)}
						</Text>
					</Group>
				)}

				{/* Expanded: a full dockview surface (chat + stackable tool panels).
				    `position: relative` gives the dock its containing block — see ChapterNode. */}
				{expanded && hasNarrator && d.narratorId && (
					// biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only
					<div
						className="nopan nodrag nowheel"
						ref={panelWheelRef}
						data-review-node-dock={d.narratorId}
						onContextMenu={(e) => e.stopPropagation()}
						style={{
							flex: 1,
							minHeight: 0,
							position: "relative",
							overflow: "hidden",
							borderTop: "1px solid var(--mantine-color-dark-4)",
						}}
					>
						<Suspense fallback={<NarratorPanelSkeleton />}>
							<ChapterNodeDock key={d.narratorId} chapterId={id} narratorId={d.narratorId} />
						</Suspense>
					</div>
				)}
			</Card>
		</>
	);
}

export const ReviewNode = memo(ReviewNodeInner);
