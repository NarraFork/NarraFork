import { ActionIcon, Badge, Card, Group, Text, Tooltip } from "@mantine/core";
import { IconGitCommit, IconMessage, IconMinimize } from "@tabler/icons-react";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import { lazy, memo, Suspense, useCallback, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CHAPTER_ROLE_ICONS, CHAPTER_STATUS_COLORS, statusRegistry } from "../../lib/constants";
import { ChapterForkModal } from "../chapter/ChapterForkModal";
import { NarratorPanelSkeleton } from "../narrator/NarratorPanelSkeleton";
import { NodeTitleEditor } from "./NodeTitleEditor";

// Lazy: dockview + every tool panel is a large chunk, and most nodes on a canvas
// are collapsed. Only expanding one pays for it.
const ChapterNodeDock = lazy(() =>
	import("./dock/ChapterNodeDock").then((m) => ({ default: m.ChapterNodeDock })),
);

export interface ChapterNodeData {
	title: string;
	status: string;
	branch: string;
	narratorCount: number;
	narratorId?: string | null;
	narratorStatus?: string | null;
	narratorSubstatus?: string[] | null;
	hasContainers: boolean;
	role?: string;
	color?: string;
	isRoot?: boolean;
	commitCount?: number;
	expanded?: boolean;
	onToggleExpand?: (chapterId: string) => void;
	[key: string]: unknown;
}

const COLLAPSED_WIDTH = 280;
const COLLAPSED_HEIGHT = 120;
/**
 * Expanded size must fit a dockview cluster, not just a chat column: opening the
 * first tool panel splits ~1/3 of the width off (see `resolveToolPlacement`), and
 * at the old 380px that left a ~127px panel nobody could use.
 */
const EXPANDED_WIDTH = 720;
const EXPANDED_HEIGHT = 640;
/** Below this width a split-right tool panel is too narrow to be worth opening. */
export const MIN_RESIZE_WIDTH = 480;
const MIN_RESIZE_HEIGHT = 300;
const TRUNK_WIDTH = 320;
const TRUNK_HEIGHT = 140;
const MAX_CHAPTER_NODE_TEXT_CHARS = 500;

function clampChapterNodeText(value: string | null | undefined): string {
	if (!value) return "";
	return value.length > MAX_CHAPTER_NODE_TEXT_CHARS
		? `${value.slice(0, MAX_CHAPTER_NODE_TEXT_CHARS)}…`
		: value;
}

function ChapterNodeInner({ data, id }: NodeProps) {
	const d = data as ChapterNodeData;
	const { t } = useTranslation("graph");
	const { t: tc } = useTranslation("common");
	const narratorDisplay = d.narratorStatus
		? statusRegistry.narratorEffective(d.narratorStatus, d.narratorSubstatus ?? undefined)
		: null;

	const [forkMessageId, setForkMessageId] = useState<string | null>(null);
	const handleForkFromMessage = useCallback((messageId: string) => {
		setForkMessageId(messageId);
	}, []);

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
	const displayTitle = clampChapterNodeText(d.title);
	const displayBranch = clampChapterNodeText(d.branch);

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

	// No resize-tracking state any more: it existed only to show NarratorPanel's
	// skeleton overlay while dragging the node's corner. The dock's panels are laid
	// out by the browser (CSS flex, `onlyWhenVisible`), so a resize reflows in the
	// same frame and no longer produces the flash the overlay was hiding.

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
					isolation: "isolate",
					display: "flex",
					flexDirection: "column",
					overflow: "hidden",
				}}
			>
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
						{/* Expanded, this is the ONLY visible copy of the title: the embedded
						    panel suppresses its own header title (and hands its pencil /
						    sparkles actions over here) because a dozen tool buttons used to
						    squeeze that copy to zero width. */}
						<NodeTitleEditor
							chapterId={id}
							narratorId={d.narratorId ?? null}
							title={displayTitle}
							prefix={roleIcon || undefined}
							showActions={expanded}
							size="sm"
							// Collapsed nodes have a known width, so the title is capped to leave
							// room for the badge. An expanded node is user-resizable, so a fixed
							// cap would waste whatever width they dragged out — flex instead.
							textStyle={
								expanded ? { flex: 1 } : { maxWidth: nodeWidth - (hasNarrator ? 100 : 80) }
							}
						/>
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
								{displayBranch}
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
								{d.narratorStatus && narratorDisplay ? (
									<Badge
										size="xs"
										variant="dot"
										color={statusRegistry.accentColor(narratorDisplay)}
									>
										{tc(narratorDisplay.i18nKey)}
									</Badge>
								) : (
									<Text size="xs" c="dimmed">
										{t("narratorCount", { count: d.narratorCount })}
									</Text>
								)}
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

				{/* Expanded: a full dockview surface (chat + stackable tool panels) */}
				{expanded && d.narratorId && (
					// `position: relative` + `overflow: hidden` give the dock a containing
					// block and clip it to the node. The nopan/nodrag/nowheel classes keep
					// React Flow from swallowing dockview's tab clicks and sash drags.
					// biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only
					<div
						className="nopan nodrag nowheel"
						ref={panelWheelRef}
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
							<ChapterNodeDock
								key={d.narratorId}
								chapterId={id}
								narratorId={d.narratorId}
								onForkFromMessage={handleForkFromMessage}
							/>
						</Suspense>
					</div>
				)}
			</Card>
			{forkMessageId && (
				<ChapterForkModal
					chapterId={id}
					chapterStatus={d.status}
					forkAtMessageId={forkMessageId}
					opened
					onClose={() => setForkMessageId(null)}
				/>
			)}
		</>
	);
}

function areStringArraysEqual(a?: readonly string[] | null, b?: readonly string[] | null): boolean {
	const left = a ?? [];
	const right = b ?? [];
	if (left.length !== right.length) return false;
	return left.every((value, index) => value === right[index]);
}

function areChapterNodePropsEqual(prev: NodeProps, next: NodeProps) {
	const prevData = prev.data as ChapterNodeData;
	const nextData = next.data as ChapterNodeData;

	return (
		prev.id === next.id &&
		prevData.title === nextData.title &&
		prevData.status === nextData.status &&
		prevData.branch === nextData.branch &&
		prevData.narratorCount === nextData.narratorCount &&
		prevData.narratorId === nextData.narratorId &&
		prevData.narratorStatus === nextData.narratorStatus &&
		areStringArraysEqual(prevData.narratorSubstatus, nextData.narratorSubstatus) &&
		prevData.hasContainers === nextData.hasContainers &&
		prevData.role === nextData.role &&
		prevData.color === nextData.color &&
		prevData.isRoot === nextData.isRoot &&
		prevData.commitCount === nextData.commitCount &&
		prevData.expanded === nextData.expanded &&
		prevData.onToggleExpand === nextData.onToggleExpand
	);
}

export const ChapterNode = memo(ChapterNodeInner, areChapterNodePropsEqual);
