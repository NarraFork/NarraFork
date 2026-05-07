import { Badge, Card, Group, Text } from "@mantine/core";
import { IconEye } from "@tabler/icons-react";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import { memo, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { statusRegistry } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";

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
const MIN_RESIZE_WIDTH = 260;
const MIN_RESIZE_HEIGHT = 300;

function ReviewNodeInner({ data, id }: NodeProps) {
	const d = data as ReviewNodeData;
	const { t } = useTranslation("chapters");
	const { t: tc } = useTranslation("common");

	const expanded = !!d.expanded;
	const hasNarrator = !!d.narratorId;
	const reviewStatus = d.reviewStatus ?? "reviewing";
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

	// Track node resize to show skeleton overlay in NarratorPanel
	const [isResizing, setIsResizing] = useState(false);
	const onResizeStart = useCallback(() => setIsResizing(true), []);
	const onResizeEnd = useCallback(() => setIsResizing(false), []);

	// Allow Ctrl+wheel to pass through to ReactFlow for zoom even when over NarratorPanel
	// (handled by NowheelPassthrough in NarraFlow — no per-node listener needed)
	const panelWheelRef = useRef<HTMLDivElement>(null);

	return (
		<>
			{expanded && (
				<NodeResizeControl
					minWidth={MIN_RESIZE_WIDTH}
					minHeight={MIN_RESIZE_HEIGHT}
					position="bottom-right"
					onResizeStart={onResizeStart}
					onResizeEnd={onResizeEnd}
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
					<Text size="xs" fw={600} truncate style={{ flex: 1 }}>
						{d.title}
					</Text>
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
								background: `var(--mantine-color-${narratorDisplay.color}-5)`,
							}}
						/>
						<Text size="xs" c="dimmed">
							{tc(narratorDisplay.i18nKey)}
						</Text>
					</Group>
				)}

				{/* Expanded: show narrator panel */}
				{expanded && hasNarrator && d.narratorId && (
					// biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only
					<div
						className="nopan nodrag nowheel"
						ref={panelWheelRef}
						onContextMenu={(e) => e.stopPropagation()}
						style={{
							flex: 1,
							minHeight: 0,
							overflow: "hidden",
							borderTop: "1px solid var(--mantine-color-dark-4)",
						}}
					>
						<NarratorPanel
							key={d.narratorId}
							narratorId={d.narratorId}
							compact
							isResizing={isResizing}
						/>
					</div>
				)}
			</Card>
		</>
	);
}

export const ReviewNode = memo(ReviewNodeInner);
