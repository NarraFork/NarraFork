import { ActionIcon, Badge, Card, Group, Text, Tooltip } from "@mantine/core";
import { IconGitCommit, IconMessage, IconMinimize } from "@tabler/icons-react";
import { useQueryClient } from "@tanstack/react-query";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import { memo, useCallback, useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHAPTER_ROLE_ICONS, CHAPTER_STATUS_COLORS, statusRegistry } from "../../lib/constants";
import { ChapterForkModal } from "../chapter/ChapterForkModal";
import { NarratorPanel } from "../narrator/NarratorPanel";

export interface ChapterNodeData {
	title: string;
	status: string;
	branch: string;
	narratorCount: number;
	narratorId?: string | null;
	hasContainers: boolean;
	role?: string;
	color?: string;
	hasUpstreamUpdates?: boolean;
	isRoot?: boolean;
	commitCount?: number;
	expanded?: boolean;
	onToggleExpand?: (chapterId: string) => void;
	[key: string]: unknown;
}

const COLLAPSED_WIDTH = 280;
const COLLAPSED_HEIGHT = 120;
const EXPANDED_WIDTH = 380;
const EXPANDED_HEIGHT = 640;
const MIN_RESIZE_WIDTH = 280;
const MIN_RESIZE_HEIGHT = 300;
const TRUNK_WIDTH = 320;
const TRUNK_HEIGHT = 140;

function ChapterNodeInner({ data, id }: NodeProps) {
	const d = data as ChapterNodeData;
	const { t } = useTranslation("graph");
	const { t: tc } = useTranslation("common");
	const queryClient = useQueryClient();

	// Fork-from-message state (ChapterForkModal)
	const [forkAtMessageUuid, setForkAtMessageUuid] = useState<string | null>(null);
	const handleForkFromMessage = useCallback((messageUuid: string) => {
		setForkAtMessageUuid(messageUuid);
	}, []);
	const closeForkModal = useCallback(() => setForkAtMessageUuid(null), []);
	const handleForkSuccess = useCallback(() => {
		queryClient.invalidateQueries({ queryKey: ["storyGraph"] });
	}, [queryClient]);

	const role = d.role ?? "branch";
	const isRoot = !!d.isRoot;
	const isTrunk = role === "trunk";
	const isFrozen = d.status === "frozen";
	const expanded = !!d.expanded;
	const roleIcon = isRoot ? "📂" : CHAPTER_ROLE_ICONS[role] || "";
	const borderColor = isRoot
		? "var(--mantine-color-indigo-6)"
		: (d.color ?? `var(--mantine-color-${CHAPTER_STATUS_COLORS[d.status] ?? "gray"}-4)`);

	const hasNarrator = !!d.narratorId;

	const collapsedW = isRoot || isTrunk ? TRUNK_WIDTH : COLLAPSED_WIDTH;
	const collapsedH = isRoot || isTrunk ? TRUNK_HEIGHT : COLLAPSED_HEIGHT;
	const nodeWidth = expanded ? EXPANDED_WIDTH : collapsedW;
	const nodeHeight = expanded ? EXPANDED_HEIGHT : collapsedH;

	const toggleExpand = useCallback(
		(e: React.MouseEvent) => {
			e.stopPropagation();
			if (!hasNarrator) return;
			d.onToggleExpand?.(id);
		},
		[hasNarrator, d.onToggleExpand, id],
	);

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	// Allow Ctrl+wheel to pass through to ReactFlow for zoom even when over NarratorPanel
	const panelWheelRef = useRef<HTMLDivElement>(null);
	useEffect(() => {
		const el = panelWheelRef.current;
		if (!el) return;
		const handler = (e: WheelEvent) => {
			if (e.ctrlKey || e.metaKey) {
				// Remove nowheel temporarily so ReactFlow receives the event
				el.classList.remove("nowheel");
				// Re-add on next frame after the event has bubbled
				requestAnimationFrame(() => el.classList.add("nowheel"));
			}
		};
		// Must use capture phase so we act before ReactFlow's listener checks the class
		el.addEventListener("wheel", handler, { capture: true, passive: true });
		return () => el.removeEventListener("wheel", handler, { capture: true });
	}, []);

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
							background: "var(--mantine-color-indigo-5)",
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
					width: expanded ? "100%" : nodeWidth,
					height: expanded ? "100%" : nodeHeight,
					borderColor,
					borderWidth: isRoot ? 2 : 1,
					opacity: isFrozen ? 0.6 : 1,
					position: "relative",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
				{d.hasUpstreamUpdates && (
					<div
						style={{
							position: "absolute",
							top: 6,
							right: hasNarrator ? 30 : 6,
							width: 8,
							height: 8,
							borderRadius: "50%",
							backgroundColor: statusRegistry.edgeType("dependency").color,
							zIndex: 1,
						}}
					/>
				)}
				{/* Header — always visible, acts as drag handle when expanded */}
				<div
					className={expanded ? "chapter-node-drag-handle" : undefined}
					style={{
						padding: "6px 8px",
						cursor: "grab",
						flexShrink: 0,
					}}
				>
					<Group justify="space-between" mb={expanded ? 0 : 4} wrap="nowrap">
						<Text
							size="sm"
							fw={600}
							lineClamp={1}
							style={{ maxWidth: nodeWidth - (hasNarrator ? 100 : 80), minWidth: 0 }}
						>
							{roleIcon ? `${roleIcon} ` : ""}
							{d.title}
						</Text>
						<Group gap={4} wrap="nowrap">
							<Badge size="xs" color={CHAPTER_STATUS_COLORS[d.status] ?? "gray"}>
								{tc(statusRegistry.chapterStatus(d.status).i18nKey)}
							</Badge>
							{hasNarrator && (
								<Tooltip label={expanded ? t("collapseNarrator") : t("expandNarrator")}>
									<ActionIcon variant="subtle" size="xs" className="nodrag" onClick={toggleExpand}>
										{expanded ? <IconMinimize size={14} /> : <IconMessage size={14} />}
									</ActionIcon>
								</Tooltip>
							)}
						</Group>
					</Group>
					{!expanded && (
						<>
							<Text size="xs" c="dimmed" lineClamp={1}>
								{d.branch}
							</Text>
							<Group gap={8} mt={4}>
								{isRoot && (
									<Badge size="xs" variant="filled" color="indigo">
										{t("root")}
									</Badge>
								)}
								{!isRoot && role !== "branch" && (
									<Badge size="xs" variant="outline" color="indigo">
										{role}
									</Badge>
								)}
								<Text size="xs" c="dimmed">
									{t("narratorCount", { count: d.narratorCount })}
								</Text>
								{d.hasContainers && (
									<Badge size="xs" variant="dot" color="teal">
										{t("containers")}
									</Badge>
								)}
								{(d.commitCount ?? 0) > 0 && (
									<Group gap={2}>
										<IconGitCommit size={12} color="var(--mantine-color-dimmed)" />
										<Text size="xs" c="dimmed">
											{d.commitCount}
										</Text>
									</Group>
								)}
							</Group>
						</>
					)}
				</div>

				{/* Expanded: NarratorPanel */}
				{expanded && d.narratorId && (
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
							onForkFromMessage={handleForkFromMessage}
						/>
					</div>
				)}
			</Card>
			{expanded && (
				<ChapterForkModal
					chapterId={id}
					opened={forkAtMessageUuid !== null}
					onClose={closeForkModal}
					forkAtMessageUuid={forkAtMessageUuid ?? undefined}
					onForkSuccess={handleForkSuccess}
				/>
			)}
		</>
	);
}

export const ChapterNode = memo(ChapterNodeInner);
