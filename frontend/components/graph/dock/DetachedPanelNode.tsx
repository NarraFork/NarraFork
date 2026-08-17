/**
 * Tool panels torn out of a chapter node's dock, standing as their own canvas node.
 *
 * The node hosts a REAL dockview surface (`DetachedNodeDock`), so tab dragging,
 * reordering, middle-click close, split layouts and drop indicators all come from
 * dockview rather than being re-implemented here. An earlier version drew its own
 * tab strip; that meant re-creating each of those behaviours by hand, and shipping
 * without the ones not yet written.
 *
 * Chrome layout, top to bottom:
 *
 *   [ grip bar ]      ← ours: drags the NODE, closes the node
 *   [ dockview  ]     ← dockview's: tabs, panels, splits
 *
 * The grip bar exists because dockview already owns its whole tab strip. Its blank
 * area (`.dv-void-container`) is dockview's handle for dragging a GROUP, and it
 * installs its own `pointerdown` there — so using it as the React Flow drag handle
 * would stack two drag mechanisms on one element, the failure mode this layout
 * avoids by keeping the two regions physically separate.
 *
 * The grip serves both node gestures at once, which compose rather than conflict:
 * React Flow moves the node via `dragHandle`, and the panel-drag singleton lets the
 * canvas notice the node being dropped onto another surface. Released over blank
 * canvas, React Flow's position stands; released over a drop target, the node is
 * merged away and that position goes with it.
 */

import { ActionIcon, Card, Center, Text, Tooltip } from "@mantine/core";
import { IconGripHorizontal, IconX } from "@tabler/icons-react";
import { Handle, type NodeProps, NodeResizeControl, Position } from "@xyflow/react";
import type { SerializedDockview } from "dockview-react";
import { memo, useCallback, useMemo, useSyncExternalStore } from "react";
import { useTranslation } from "react-i18next";
import { startDetachedPanelDrag } from "../../../lib/panel-drag";
import { NarratorDockContext } from "../../narrator/dock/NarratorDockContext";
import { DetachedNodeDock } from "./DetachedNodeDock";
import { createDetachedPanelDockValue } from "./detached-panel-context";
import type { DetachedPanelEntry } from "./detached-panels";
import { getChapterDock, subscribeChapterDocks } from "./dock-registry";

/** Marks the node's own grip bar: its React Flow drag handle. */
export const DETACHED_GRIP_CLASS = "nf-detached-grip";

export interface DetachedPanelNodeData {
	/** Detached node id; also this React Flow node's id and its surface id. */
	panelId: string;
	/** Chapter these panels were torn out of; owns their persistence. */
	chapterId: string;
	/**
	 * Primary narrator of that chapter, resolved by NarraFlow from the same graph
	 * data the chapter node uses. Null when the chapter has no narrator — most
	 * panels then have nothing to show (git is the exception, it only needs a
	 * chapter).
	 */
	narratorId: string | null;
	/** Restored dockview layout, when this node already has one. */
	layout?: SerializedDockview;
	/** Panels to create on first mount (fresh tear-out, or upgraded v1/v2 data). */
	pendingPanels?: DetachedPanelEntry[];
	/** Persist this node's layout. */
	onLayoutChange?: (nodeId: string, layout: SerializedDockview) => void;
	/** Remove the node (its surface ended up empty, or the close button). */
	onCloseNode?: (nodeId: string) => void;
	[key: string]: unknown;
}

const MIN_WIDTH = 320;
const MIN_HEIGHT = 240;

function DetachedPanelNodeInner({ data }: NodeProps) {
	const d = data as DetachedPanelNodeData;
	const { t } = useTranslation("graph");

	// Re-render when the source node expands or collapses: that is what makes the
	// forwarded actions (jump to message / open subagent) become available again.
	const sourceDock = useSyncExternalStore(
		subscribeChapterDocks,
		useCallback(() => getChapterDock(d.chapterId), [d.chapterId]),
	);

	const narratorId = d.narratorId ?? "";
	const dockValue = useMemo(
		() =>
			createDetachedPanelDockValue({
				narratorId,
				chapterId: d.chapterId,
				sourceDock,
			}),
		[narratorId, d.chapterId, sourceDock],
	);

	const saveLayout = useCallback(
		(layout: SerializedDockview) => d.onLayoutChange?.(d.panelId, layout),
		[d.onLayoutChange, d.panelId],
	);
	const closeNode = useCallback(() => d.onCloseNode?.(d.panelId), [d.onCloseNode, d.panelId]);
	const handleEmpty = useCallback((nodeId: string) => d.onCloseNode?.(nodeId), [d.onCloseNode]);

	const handleStyle = { opacity: 0, width: 8, height: 8 };

	// Every panel except git renders per-narrator data, so without one there is
	// nothing to show. Matches ChapterNode, which only mounts a dock when the
	// chapter has a narrator.
	const onlyGit = !d.layout && (d.pendingPanels ?? []).every((p) => p.kind === "git");
	const canRender = !!d.narratorId || onlyGit;

	return (
		<>
			<NodeResizeControl
				minWidth={MIN_WIDTH}
				minHeight={MIN_HEIGHT}
				position="bottom-right"
				style={{ background: "transparent", border: "none" }}
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
			<Handle type="target" position={Position.Top} id="top" style={handleStyle} />
			<Handle type="target" position={Position.Left} id="left" style={handleStyle} />
			<Handle type="target" position={Position.Right} id="right" style={handleStyle} />
			<Handle type="target" position={Position.Bottom} id="bottom" style={handleStyle} />
			{/* biome-ignore lint/a11y/noStaticElementInteractions: stopPropagation only */}
			<div
				className="nopan nowheel"
				data-detached-node={d.panelId}
				onContextMenu={(e) => e.stopPropagation()}
				style={{ width: "100%", height: "100%" }}
			>
				<Card
					shadow="sm"
					padding={0}
					radius="md"
					withBorder
					style={{
						width: "100%",
						height: "100%",
						borderColor: "var(--mantine-color-indigo-5)",
						display: "flex",
						flexDirection: "column",
						overflow: "hidden",
					}}
				>
					<GripBar nodeId={d.panelId} onClose={closeNode} />
					<div style={{ flex: 1, minHeight: 0, overflow: "hidden" }}>
						{canRender ? (
							<NarratorDockContext.Provider value={dockValue}>
								<DetachedNodeDock
									nodeId={d.panelId}
									chapterId={d.chapterId}
									narratorId={narratorId}
									initialLayout={d.layout ?? null}
									pendingPanels={d.pendingPanels}
									save={saveLayout}
									onEmpty={handleEmpty}
								/>
							</NarratorDockContext.Provider>
						) : (
							<Center h="100%" p="sm">
								<Text size="xs" c="dimmed" ta="center">
									{t("nodeDock.noNarrator")}
								</Text>
							</Center>
						)}
					</div>
				</Card>
			</div>
		</>
	);
}

/**
 * The node's own grip bar — the one piece of chrome dockview does not provide.
 *
 * Deliberately narrow and content-free: everything about the PANELS (titles, close
 * buttons, activation) belongs to dockview's tabs just below. This bar is only
 * about the node as a whole.
 */
function GripBar({ nodeId, onClose }: { nodeId: string; onClose: () => void }) {
	const { t } = useTranslation("graph");
	return (
		<div
			className={DETACHED_GRIP_CLASS}
			onPointerDown={(e) => {
				// Skip the close button so its click is not swallowed by a drag, and so a
				// zero-distance press does not arm one. Mirrors ToolPanelHeader's guard.
				const el = e.target as HTMLElement;
				if (el.closest("button, a, input, select, textarea, [role='button']")) return;
				// Feeds the singleton IN ADDITION to React Flow's dragHandle: the canvas
				// needs to see this gesture to offer "drop onto another surface", while
				// React Flow handles the plain move. Both outcomes compose — see the file
				// header.
				//
				// Deliberately NO `toolKind`: a node can hold several panels, so this drag
				// does not denote one panel kind. That absence is also what keeps receiving
				// surfaces out of it — their `handleDropSubject` bails on a
				// non-detachable kind, leaving whole-node drops to the canvas, which is
				// the only place that can move every panel at once.
				startDetachedPanelDrag({
					id: nodeId,
					title: nodeId,
					x: e.clientX,
					y: e.clientY,
				});
			}}
			style={{
				display: "flex",
				alignItems: "center",
				justifyContent: "space-between",
				flexShrink: 0,
				height: 18,
				padding: "0 4px",
				cursor: "grab",
				borderBottom: "1px solid var(--mantine-color-default-border)",
			}}
		>
			<IconGripHorizontal size={12} style={{ opacity: 0.5 }} />
			<Tooltip label={t("nodeDock.closeDetachedNode")} withinPortal>
				<ActionIcon size="xs" variant="subtle" color="gray" onClick={onClose}>
					<IconX size={11} />
				</ActionIcon>
			</Tooltip>
		</div>
	);
}

export const DetachedPanelNode = memo(DetachedPanelNodeInner);
