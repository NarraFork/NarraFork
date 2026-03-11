import { Badge, Card, Group, Text } from "@mantine/core";
import { IconEye } from "@tabler/icons-react";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { memo, useCallback } from "react";
import { useTranslation } from "react-i18next";
import { NARRATOR_STATUS_COLORS } from "../../lib/constants";
import { NarratorPanel } from "../narrator/NarratorPanel";

export interface ReviewNodeData {
	title: string;
	status: string;
	branch: string;
	narratorCount: number;
	narratorId?: string | null;
	narratorStatus?: string | null;
	reviewSourceChapterId?: string | null;
	reviewStatus?: string | null;
	expanded?: boolean;
	onToggleExpand?: (chapterId: string) => void;
	[key: string]: unknown;
}

const NODE_WIDTH = 260;
const NODE_HEIGHT = 100;
const EXPANDED_WIDTH = 380;
const EXPANDED_HEIGHT = 640;

function ReviewNodeInner({ data, id }: NodeProps) {
	const d = data as ReviewNodeData;
	const { t } = useTranslation("chapters");

	const expanded = !!d.expanded;
	const hasNarrator = !!d.narratorId;
	const reviewStatus = d.reviewStatus ?? "reviewing";

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
	const nodeWidth = expanded ? EXPANDED_WIDTH : NODE_WIDTH;
	const nodeHeight = expanded ? EXPANDED_HEIGHT : NODE_HEIGHT;

	return (
		<>
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
					width: expanded ? "100%" : nodeWidth,
					height: expanded ? "100%" : nodeHeight,
					borderColor: "#fab005",
					borderWidth: 2,
					borderStyle: "dashed",
					position: "relative",
					overflow: "hidden",
					cursor: "grab",
				}}
				onDoubleClick={toggleExpand}
			>
				{/* Header */}
				<Group
					gap={6}
					px="xs"
					py={6}
					style={{
						background: "rgba(250, 176, 5, 0.08)",
						borderBottom: "1px solid var(--mantine-color-dark-4)",
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
				{!expanded && hasNarrator && d.narratorStatus && (
					<Group gap={4} px="xs" py={4}>
						<div
							style={{
								width: 6,
								height: 6,
								borderRadius: "50%",
								background: `var(--mantine-color-${NARRATOR_STATUS_COLORS[d.narratorStatus] ?? "gray"}-5)`,
							}}
						/>
						<Text size="xs" c="dimmed">
							{d.narratorStatus}
						</Text>
					</Group>
				)}

				{/* Expanded: show narrator panel */}
				{expanded && hasNarrator && d.narratorId && (
					<div
						className="nowheel nodrag"
						style={{
							flex: 1,
							overflow: "hidden",
							display: "flex",
							flexDirection: "column",
							height: "calc(100% - 36px)",
						}}
					>
						<NarratorPanel narratorId={d.narratorId} compact />
					</div>
				)}
			</Card>
		</>
	);
}

export const ReviewNode = memo(ReviewNodeInner);
