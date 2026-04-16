import { Box } from "@mantine/core";
import { useQueryClient } from "@tanstack/react-query";
import { createContext, memo, useCallback, useContext, useEffect, useRef, useState } from "react";
import {
	type NarratorDragState,
	onNarratorDragEnd,
	onNarratorDragMove,
	startNarratorDrag,
} from "../../lib/narrator-drag";
import { WorkspaceTerminalPanel } from "../terminal/WorkspaceTerminalPanel";
import { NarratorPanel } from "./NarratorPanel";
import type {
	SplitBranch,
	SplitDirection,
	SplitLeaf,
	SplitNode,
	TerminalLeafConfig,
	WebviewLeafConfig,
} from "./split-tree";
import { leafPanelType, normalizeDirectorPrimaryRatio } from "./split-tree";
import { WebviewPanel } from "./WebviewPanel";

const MIN_SIZE_PCT = 15;

/** Which zone the cursor is hovering over */
type DropZone = "left" | "right" | "top" | "bottom" | "center" | null;

function computeDropZone(rect: DOMRect, x: number, y: number): DropZone {
	const rx = (x - rect.left) / rect.width;
	const ry = (y - rect.top) / rect.height;
	const T = 0.25;
	if (rx < T) return "left";
	if (rx > 1 - T) return "right";
	if (ry < T) return "top";
	if (ry > 1 - T) return "bottom";
	return "center";
}

const ZONE_STYLES: Record<NonNullable<DropZone>, React.CSSProperties> = {
	left: { left: 0, top: 0, width: "50%", height: "100%" },
	right: { right: 0, top: 0, width: "50%", height: "100%" },
	top: { left: 0, top: 0, width: "100%", height: "50%" },
	bottom: { left: 0, bottom: 0, width: "100%", height: "50%" },
	center: { left: 0, top: 0, width: "100%", height: "100%" },
};

// ── Context for workspace callbacks ──

export interface SplitPanelCallbacks {
	onSplitAndAssign: (
		leafId: string,
		direction: SplitDirection,
		position: "before" | "after",
		narratorId: string,
	) => void;
	onReplace: (leafId: string, narratorId: string) => void;
	onClose: (leafId: string) => void;
	/** Swap the content of two leaf panels. */
	onSwap: (leafIdA: string, leafIdB: string) => void;
	/** Move an existing panel (remove from source leaf, split-assign at target). */
	onMoveToSplit: (
		sourceLeafId: string,
		targetLeafId: string,
		direction: SplitDirection,
		position: "before" | "after",
	) => void;
	/** Split a leaf and assign a terminal panel to the new leaf. */
	onSplitAndAssignTerminal?: (
		leafId: string,
		direction: SplitDirection,
		position: "before" | "after",
		config: TerminalLeafConfig,
	) => void;
	/** Split a leaf and assign a webview panel to the new leaf. */
	onSplitAndAssignWebview?: (
		leafId: string,
		direction: SplitDirection,
		position: "before" | "after",
		config: WebviewLeafConfig,
	) => void;
	/** Update the webview config of an existing leaf. */
	onUpdateWebviewConfig?: (leafId: string, config: WebviewLeafConfig) => void;
	resolveNarratorView: (leaf: SplitLeaf) => { narratorId: string | null; isSubagentView: boolean };
	onOpenSubagentInLeaf: (leafId: string, narratorId: string) => void;
	onRestoreLeafNarrator: (leafId: string) => void;
	canClose: boolean;
}

export const SplitPanelCtx = createContext<SplitPanelCallbacks>({
	onSplitAndAssign: () => {},
	onReplace: () => {},
	onClose: () => {},
	onSwap: () => {},
	onMoveToSplit: () => {},
	resolveNarratorView: (leaf) => ({ narratorId: leaf.narratorId, isSubagentView: false }),
	onOpenSubagentInLeaf: () => {},
	onRestoreLeafNarrator: () => {},
	canClose: false,
});

// ── Main recursive renderer ──

export function SplitPanelContainer({
	node,
	onUpdateSizes,
}: {
	node: SplitNode;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
}) {
	if (node.type === "leaf") {
		return <LeafPanel leaf={node} />;
	}
	return <BranchPanel branch={node} onUpdateSizes={onUpdateSizes} />;
}

// ── Leaf: NarratorPanel with drop overlay ──

/** Threshold below which the panel uses compact (mobile-style) toolbar. */
const COMPACT_WIDTH_THRESHOLD = 640;

function LeafDropZoneOverlay({ dropZone, zIndex = 1 }: { dropZone: DropZone; zIndex?: number }) {
	if (!dropZone) return null;
	return (
		<Box
			style={{
				position: "absolute",
				...ZONE_STYLES[dropZone],
				backgroundColor: "var(--mantine-color-indigo-9)",
				opacity: 0.25,
				borderRadius: 4,
				pointerEvents: "none",
				transition: "all 100ms ease",
				zIndex,
			}}
		/>
	);
}

function useLeafHeaderPointerDown(leaf: SplitLeaf) {
	const { resolveNarratorView } = useContext(SplitPanelCtx);
	const panelType = leafPanelType(leaf);
	const { narratorId: currentNarratorId } = resolveNarratorView(leaf);
	const qc = useQueryClient();

	return useCallback(
		(e: React.PointerEvent) => {
			if (panelType === "narrator" && currentNarratorId) {
				const cached = qc.getQueryData<{ title?: string }>(["narrators", currentNarratorId]);
				const title = cached?.title ?? "";
				startNarratorDrag(currentNarratorId, title, e.clientX, e.clientY, leaf.id);
			} else if (panelType === "terminal") {
				startNarratorDrag("__terminal__", "Terminal", e.clientX, e.clientY, leaf.id);
			} else if (panelType === "webview") {
				startNarratorDrag("__webview__", "Webview", e.clientX, e.clientY, leaf.id);
			}
		},
		[currentNarratorId, leaf.id, panelType, qc.getQueryData],
	);
}

function useLeafPanelDragAndDrop(leaf: SplitLeaf) {
	const { onSplitAndAssign, onReplace, onSwap, onMoveToSplit } = useContext(SplitPanelCtx);
	const handleHeaderPointerDown = useLeafHeaderPointerDown(leaf);
	const [dropZone, setDropZone] = useState<DropZone>(null);
	const boxRef = useRef<HTMLDivElement>(null);
	const dropZoneRef = useRef<DropZone>(null);
	const dragSourceLeafRef = useRef<string | null>(null);

	useEffect(() => {
		const unsubMove = onNarratorDragMove((state: NarratorDragState) => {
			const el = boxRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				state.x >= rect.left &&
				state.x <= rect.right &&
				state.y >= rect.top &&
				state.y <= rect.bottom;
			if (inside) {
				if (state.sourceLeafId === leaf.id) {
					if (dropZoneRef.current) {
						dropZoneRef.current = null;
						setDropZone(null);
					}
					return;
				}
				const zone = computeDropZone(rect, state.x, state.y);
				dropZoneRef.current = zone;
				dragSourceLeafRef.current = state.sourceLeafId ?? null;
				setDropZone(zone);
			} else if (dropZoneRef.current) {
				dropZoneRef.current = null;
				setDropZone(null);
			}
		});

		const unsubEnd = onNarratorDragEnd((final: NarratorDragState | null) => {
			const zone = dropZoneRef.current;
			const sourceLeafId = dragSourceLeafRef.current;
			dropZoneRef.current = null;
			dragSourceLeafRef.current = null;
			setDropZone(null);
			if (!final || !zone) return;

			const el = boxRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				final.x >= rect.left &&
				final.x <= rect.right &&
				final.y >= rect.top &&
				final.y <= rect.bottom;
			if (!inside) return;
			if (final.sourceLeafId === leaf.id) return;

			if (zone === "center") {
				if (sourceLeafId) {
					onSwap(sourceLeafId, leaf.id);
				} else {
					onReplace(leaf.id, final.narratorId);
				}
			} else {
				const direction: SplitDirection =
					zone === "left" || zone === "right" ? "horizontal" : "vertical";
				const position: "before" | "after" = zone === "left" || zone === "top" ? "before" : "after";
				if (sourceLeafId) {
					onMoveToSplit(sourceLeafId, leaf.id, direction, position);
				} else {
					onSplitAndAssign(leaf.id, direction, position, final.narratorId);
				}
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [leaf.id, onMoveToSplit, onReplace, onSplitAndAssign, onSwap]);

	return { boxRef, dropZone, handleHeaderPointerDown };
}

function LeafPanel({ leaf }: { leaf: SplitLeaf }) {
	const { boxRef, dropZone, handleHeaderPointerDown } = useLeafPanelDragAndDrop(leaf);
	const [isCompact, setIsCompact] = useState(true);
	useEffect(() => {
		const el = boxRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const width = entries[0]?.contentRect.width ?? 0;
			setIsCompact(width < COMPACT_WIDTH_THRESHOLD);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, [boxRef]);

	return (
		<Box
			ref={boxRef}
			h="100%"
			style={{ position: "relative", overflow: "hidden", borderRadius: 4 }}
		>
			<LeafPanelContent
				leaf={leaf}
				compact={isCompact}
				onHeaderPointerDown={handleHeaderPointerDown}
			/>
			<LeafDropZoneOverlay dropZone={dropZone} />
		</Box>
	);
}

export function LeafPanelContent({
	leaf,
	compact,
	onHeaderPointerDown,
	allowClose = true,
	workspacePreview = false,
	suppressAutoFocusOnPromote = false,
}: {
	leaf: SplitLeaf;
	compact: boolean;
	onHeaderPointerDown?: (e: React.PointerEvent) => void;
	allowClose?: boolean;
	workspacePreview?: boolean;
	suppressAutoFocusOnPromote?: boolean;
}) {
	const {
		onClose,
		onSplitAndAssignTerminal,
		onUpdateWebviewConfig,
		resolveNarratorView,
		onOpenSubagentInLeaf,
		onRestoreLeafNarrator,
		canClose,
	} = useContext(SplitPanelCtx);
	const panelType = leafPanelType(leaf);
	const { narratorId: currentNarratorId, isSubagentView } = resolveNarratorView(leaf);
	const closeHandler = canClose && allowClose ? () => onClose(leaf.id) : undefined;

	const handleOpenTerminalPanel = () => {
		if (!leaf.narratorId || !onSplitAndAssignTerminal) return;
		onSplitAndAssignTerminal(leaf.id, "horizontal", "after", {
			narratorId: leaf.narratorId,
		});
	};

	const handleWebviewConfigChange = (config: WebviewLeafConfig) => {
		onUpdateWebviewConfig?.(leaf.id, config);
	};

	if (panelType === "terminal" && leaf.terminalConfig) {
		return (
			<WorkspaceTerminalPanel
				key={leaf.id}
				config={leaf.terminalConfig}
				leafId={leaf.id}
				onClose={closeHandler}
				onHeaderPointerDown={onHeaderPointerDown}
			/>
		);
	}

	if (panelType === "webview") {
		return (
			<WebviewPanel
				key={leaf.id}
				config={leaf.webviewConfig ?? { url: "" }}
				leafId={leaf.id}
				onClose={closeHandler}
				onHeaderPointerDown={onHeaderPointerDown}
				onConfigChange={handleWebviewConfigChange}
			/>
		);
	}

	return (
		<>
			{leaf.narratorId && (
				<Box
					style={{
						position: "absolute",
						inset: 0,
						visibility: isSubagentView ? "hidden" : "visible",
					}}
				>
					<NarratorPanel
						key={leaf.narratorId}
						narratorId={leaf.narratorId}
						compact={compact}
						onClose={closeHandler}
						onHeaderPointerDown={onHeaderPointerDown}
						onOpenTerminalPanel={onSplitAndAssignTerminal ? handleOpenTerminalPanel : undefined}
						onViewSubagentSession={(narratorId) => onOpenSubagentInLeaf(leaf.id, narratorId)}
						workspacePreview={workspacePreview}
						suppressAutoFocusOnPromote={suppressAutoFocusOnPromote}
					/>
				</Box>
			)}
			{isSubagentView && currentNarratorId && (
				<Box style={{ position: "absolute", inset: 0 }}>
					<NarratorPanel
						key={currentNarratorId}
						narratorId={currentNarratorId}
						compact={compact}
						onBack={() => onRestoreLeafNarrator(leaf.id)}
						onClose={closeHandler}
						onHeaderPointerDown={onHeaderPointerDown}
						onViewSubagentSession={(narratorId) => onOpenSubagentInLeaf(leaf.id, narratorId)}
						workspacePreview={workspacePreview}
						suppressAutoFocusOnPromote={suppressAutoFocusOnPromote}
					/>
				</Box>
			)}
		</>
	);
}

const DIRECTOR_PADDING = 8;
const DIRECTOR_GAP = 8;
const DIRECTOR_RAIL_MAX = 360;
const DIRECTOR_RAIL_MIN_LANDSCAPE = 220;
const DIRECTOR_RAIL_MIN_PORTRAIT = 180;
const DIRECTOR_SECONDARY_MAX_LANDSCAPE = 220;
const DIRECTOR_SECONDARY_MAX_PORTRAIT = 280;
const DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH = 140;
const DIRECTOR_PREVIEW_SCALE = 0.82;
const DIRECTOR_DIVIDER_HIT_SIZE = 28;
const DIRECTOR_DIVIDER_LINE_SIZE = 2;
const DIRECTOR_PREVIEW_DIVIDER_SIZE = 1;

function clamp(value: number, min: number, max: number): number {
	return Math.min(Math.max(value, min), max);
}

const MemoLeafPanelContent = memo(LeafPanelContent);

type DirectorFrame = {
	left: number;
	top: number;
	width: number;
	height: number;
};

type DirectorDropZone = "center" | "edge" | null;

function isInsideDirectorFrame(frame: DirectorFrame, x: number, y: number): boolean {
	return (
		x >= frame.left &&
		x <= frame.left + frame.width &&
		y >= frame.top &&
		y <= frame.top + frame.height
	);
}

function getDirectorEdgeFrame(
	width: number,
	height: number,
	isLandscape: boolean,
	edgeThickness: number,
): DirectorFrame {
	if (isLandscape) {
		return {
			left: Math.max(0, width - edgeThickness),
			top: 0,
			width: Math.max(0, edgeThickness),
			height: Math.max(0, height),
		};
	}
	return {
		left: 0,
		top: 0,
		width: Math.max(0, width),
		height: Math.max(0, edgeThickness),
	};
}

function computeDirectorDropZone(
	containerRect: DOMRect,
	primaryFrame: DirectorFrame,
	edgeFrame: DirectorFrame,
	x: number,
	y: number,
): DirectorDropZone {
	const localX = x - containerRect.left;
	const localY = y - containerRect.top;
	if (isInsideDirectorFrame(primaryFrame, localX, localY)) return "center";
	if (isInsideDirectorFrame(edgeFrame, localX, localY)) return "edge";
	return null;
}

function getDirectorDropOverlayStyle(
	dropZone: DirectorDropZone,
	primaryFrame: DirectorFrame,
	edgeFrame: DirectorFrame,
): React.CSSProperties | null {
	if (!dropZone) return null;
	if (dropZone === "center") {
		return {
			left: primaryFrame.left,
			top: primaryFrame.top,
			width: primaryFrame.width,
			height: primaryFrame.height,
		};
	}
	return {
		left: edgeFrame.left,
		top: edgeFrame.top,
		width: edgeFrame.width,
		height: edgeFrame.height,
	};
}

function DirectorLeafHost({
	leaf,
	frame,
	compact,
	allowClose,
	activate,
	zIndex,
	suppressAutoFocusOnPromote = false,
}: {
	leaf: SplitLeaf;
	frame: DirectorFrame;
	compact: boolean;
	allowClose: boolean;
	activate?: (method: "mouse" | "touch" | "keyboard") => void;
	zIndex: number;
	suppressAutoFocusOnPromote?: boolean;
}) {
	const previewScale = allowClose ? 1 : frame.width <= 320 ? 0.68 : DIRECTOR_PREVIEW_SCALE;
	const pointerTypeRef = useRef<"mouse" | "touch" | "keyboard">("mouse");

	return (
		<Box
			style={{
				position: "absolute",
				left: frame.left,
				top: frame.top,
				width: frame.width,
				height: frame.height,
				overflow: "hidden",
				zIndex,
				transition:
					"left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease, opacity 140ms ease",
				willChange: "left, top, width, height",
			}}
		>
			<Box
				style={{
					width: `${100 / previewScale}%`,
					height: `${100 / previewScale}%`,
					transform: `scale(${previewScale})`,
					transformOrigin: "top left",
				}}
			>
				<MemoLeafPanelContent
					leaf={leaf}
					compact={compact}
					allowClose={allowClose}
					workspacePreview={!allowClose}
					suppressAutoFocusOnPromote={suppressAutoFocusOnPromote}
				/>
			</Box>
			{activate ? (
				<Box
					role="button"
					tabIndex={0}
					aria-label="Activate panel"
					onPointerDown={(event) => {
						pointerTypeRef.current = event.pointerType === "touch" ? "touch" : "mouse";
					}}
					onClick={() => activate(pointerTypeRef.current)}
					onKeyDown={(event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							activate("keyboard");
						}
					}}
					style={{
						position: "absolute",
						inset: 0,
						zIndex: 2,
						cursor: "pointer",
					}}
				/>
			) : null}
		</Box>
	);
}

export function DirectorPanelLayout({
	leaves,
	primaryLeafId,
	primaryRatio,
	lastActivationMethod,
	onActivateLeaf,
	onPreviewRatioChange,
	onCommitRatioChange,
}: {
	leaves: SplitLeaf[];
	primaryLeafId: string | null;
	primaryRatio: number;
	lastActivationMethod: "mouse" | "touch" | "keyboard" | null;
	onActivateLeaf: (leafId: string, method: "mouse" | "touch" | "keyboard") => void;
	onPreviewRatioChange: (ratio: number) => void;
	onCommitRatioChange: (ratio: number) => void;
}) {
	const { onMoveToSplit, onReplace, onSplitAndAssign, onSwap } = useContext(SplitPanelCtx);
	const containerRef = useRef<HTMLDivElement>(null);
	const [containerSize, setContainerSize] = useState({ width: 0, height: 0 });
	const [isLandscape, setIsLandscape] = useState(true);
	const [dropZone, setDropZone] = useState<DirectorDropZone>(null);
	const dropZoneRef = useRef<DirectorDropZone>(null);
	const dragSourceLeafRef = useRef<string | null>(null);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (!rect) return;
			setContainerSize({ width: rect.width, height: rect.height });
			setIsLandscape(rect.width >= rect.height);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const primaryLeaf = leaves.find((leaf) => leaf.id === primaryLeafId) ?? leaves[0];
	const secondaryLeaves = primaryLeaf ? leaves.filter((leaf) => leaf.id !== primaryLeaf.id) : [];

	const { width, height } = containerSize;
	const hasSecondary = secondaryLeaves.length > 0;
	const normalizedPrimaryRatio = normalizeDirectorPrimaryRatio(primaryRatio);
	const projectedRailThickness = clamp(
		Math.round((isLandscape ? width : height) * (1 - normalizedPrimaryRatio)),
		isLandscape ? DIRECTOR_RAIL_MIN_LANDSCAPE : DIRECTOR_RAIL_MIN_PORTRAIT,
		DIRECTOR_RAIL_MAX,
	);
	const railThickness = hasSecondary ? projectedRailThickness : 0;
	const primaryFrame: DirectorFrame = isLandscape
		? {
				left: 0,
				top: 0,
				width: Math.max(0, width - railThickness),
				height: Math.max(0, height),
			}
		: {
				left: 0,
				top: railThickness,
				width: Math.max(0, width),
				height: Math.max(0, height - railThickness),
			};
	const dropEdgeFrame = getDirectorEdgeFrame(width, height, isLandscape, projectedRailThickness);
	const portraitColumns = Math.min(secondaryLeaves.length, 3);

	const secondaryFrames = secondaryLeaves.map((_, index) => {
		const secondaryCount = secondaryLeaves.length;
		if (isLandscape) {
			const railLeft = Math.max(0, width - railThickness);
			const railHeight = Math.max(0, height - DIRECTOR_PADDING * 2);
			const availableHeight = Math.max(0, railHeight - DIRECTOR_GAP * (secondaryCount - 1));
			const itemHeight =
				secondaryCount > 0
					? Math.min(availableHeight / secondaryCount, DIRECTOR_SECONDARY_MAX_LANDSCAPE)
					: 0;
			return {
				left: railLeft + DIRECTOR_PADDING,
				top: DIRECTOR_PADDING + index * (itemHeight + DIRECTOR_GAP),
				width: Math.max(0, railThickness - DIRECTOR_PADDING * 2),
				height: itemHeight,
			};
		}
		const railWidth = Math.max(0, width - DIRECTOR_PADDING * 2);
		const maxColumns = Math.max(
			1,
			Math.min(
				3,
				Math.floor(
					(railWidth + DIRECTOR_GAP) / (DIRECTOR_SECONDARY_TARGET_PORTRAIT_WIDTH + DIRECTOR_GAP),
				),
			),
		);
		const columns = Math.min(secondaryCount, maxColumns);
		const rows = Math.ceil(secondaryCount / columns);
		const railHeight = Math.max(0, railThickness - DIRECTOR_PADDING * 2);
		const availableWidth = Math.max(0, railWidth - DIRECTOR_GAP * Math.max(0, columns - 1));
		const availableHeight = Math.max(0, railHeight - DIRECTOR_GAP * Math.max(0, rows - 1));
		const itemWidth =
			columns > 0 ? Math.min(availableWidth / columns, DIRECTOR_SECONDARY_MAX_PORTRAIT) : 0;
		const itemHeight = rows > 0 ? availableHeight / rows : 0;
		const column = columns > 0 ? index % columns : 0;
		const row = columns > 0 ? Math.floor(index / columns) : 0;
		return {
			left: DIRECTOR_PADDING + column * (itemWidth + DIRECTOR_GAP),
			top: DIRECTOR_PADDING + row * (itemHeight + DIRECTOR_GAP),
			width: itemWidth,
			height: itemHeight,
		};
	});
	const previewDividers: React.CSSProperties[] = [];
	if (hasSecondary) {
		if (isLandscape) {
			for (let index = 1; index < secondaryFrames.length; index++) {
				const frame = secondaryFrames[index];
				previewDividers.push({
					position: "absolute",
					left: frame.left,
					top: frame.top - DIRECTOR_GAP / 2 - DIRECTOR_PREVIEW_DIVIDER_SIZE / 2,
					width: frame.width,
					height: DIRECTOR_PREVIEW_DIVIDER_SIZE,
					background: "var(--mantine-color-dark-4)",
					opacity: 0.85,
					zIndex: 2,
					pointerEvents: "none",
				});
			}
		} else {
			for (let index = 0; index < secondaryFrames.length; index++) {
				const frame = secondaryFrames[index];
				const column = portraitColumns > 0 ? index % portraitColumns : 0;
				const row = portraitColumns > 0 ? Math.floor(index / portraitColumns) : 0;
				if (column > 0) {
					previewDividers.push({
						position: "absolute",
						left: frame.left - DIRECTOR_GAP / 2 - DIRECTOR_PREVIEW_DIVIDER_SIZE / 2,
						top: frame.top,
						width: DIRECTOR_PREVIEW_DIVIDER_SIZE,
						height: frame.height,
						background: "var(--mantine-color-dark-4)",
						opacity: 0.85,
						zIndex: 2,
						pointerEvents: "none",
					});
				}
				if (row > 0 && column === 0) {
					previewDividers.push({
						position: "absolute",
						left: DIRECTOR_PADDING,
						top: frame.top - DIRECTOR_GAP / 2 - DIRECTOR_PREVIEW_DIVIDER_SIZE / 2,
						width: Math.max(0, width - DIRECTOR_PADDING * 2),
						height: DIRECTOR_PREVIEW_DIVIDER_SIZE,
						background: "var(--mantine-color-dark-4)",
						opacity: 0.85,
						zIndex: 2,
						pointerEvents: "none",
					});
				}
			}
		}
	}

	useEffect(() => {
		const unsubMove = onNarratorDragMove((state: NarratorDragState) => {
			if (!primaryLeaf) return;
			const el = containerRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				state.x >= rect.left &&
				state.x <= rect.right &&
				state.y >= rect.top &&
				state.y <= rect.bottom;
			if (!inside) {
				if (dropZoneRef.current) {
					dropZoneRef.current = null;
					dragSourceLeafRef.current = null;
					setDropZone(null);
				}
				return;
			}
			const zone = computeDirectorDropZone(rect, primaryFrame, dropEdgeFrame, state.x, state.y);
			dropZoneRef.current = zone;
			dragSourceLeafRef.current = state.sourceLeafId ?? null;
			setDropZone(zone);
		});

		const unsubEnd = onNarratorDragEnd((final: NarratorDragState | null) => {
			const zone = dropZoneRef.current;
			const sourceLeafId = dragSourceLeafRef.current;
			dropZoneRef.current = null;
			dragSourceLeafRef.current = null;
			setDropZone(null);
			if (!final || !zone || !primaryLeaf) return;

			const el = containerRef.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const inside =
				final.x >= rect.left &&
				final.x <= rect.right &&
				final.y >= rect.top &&
				final.y <= rect.bottom;
			if (!inside) return;
			if (sourceLeafId === primaryLeaf.id) return;

			if (zone === "center") {
				if (sourceLeafId) {
					onSwap(sourceLeafId, primaryLeaf.id);
				} else {
					onReplace(primaryLeaf.id, final.narratorId);
				}
				return;
			}

			const direction: SplitDirection = isLandscape ? "horizontal" : "vertical";
			const position: "before" | "after" = isLandscape ? "after" : "before";
			if (sourceLeafId) {
				onMoveToSplit(sourceLeafId, primaryLeaf.id, direction, position);
			} else {
				onSplitAndAssign(primaryLeaf.id, direction, position, final.narratorId);
			}
		});

		return () => {
			unsubMove();
			unsubEnd();
		};
	}, [
		isLandscape,
		onMoveToSplit,
		onReplace,
		onSplitAndAssign,
		onSwap,
		primaryFrame,
		primaryLeaf,
		dropEdgeFrame,
	]);

	const directorDropOverlayStyle = getDirectorDropOverlayStyle(
		dropZone,
		primaryFrame,
		dropEdgeFrame,
	);

	if (!primaryLeaf) return null;

	const handleDividerPointerDown = (event: React.PointerEvent<HTMLDivElement>) => {
		if (!hasSecondary) return;
		event.preventDefault();
		event.stopPropagation();
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		const axisSize = isLandscape ? rect.width : rect.height;
		if (axisSize <= 0) return;

		const updateRatio = (clientX: number, clientY: number) => {
			const axisPos = isLandscape ? clientX - rect.left : clientY - rect.top;
			const rawRatio = isLandscape ? axisPos / axisSize : 1 - axisPos / axisSize;
			const nextRatio = normalizeDirectorPrimaryRatio(rawRatio);
			onPreviewRatioChange(nextRatio);
			return nextRatio;
		};

		let lastRatio = updateRatio(event.clientX, event.clientY);
		const pointerId = event.pointerId;
		const target = event.currentTarget;
		target.setPointerCapture(pointerId);
		document.body.style.userSelect = "none";
		document.body.style.touchAction = "none";

		const cleanup = () => {
			if (target.hasPointerCapture(pointerId)) {
				target.releasePointerCapture(pointerId);
			}
			document.removeEventListener("pointermove", handlePointerMove);
			document.removeEventListener("pointerup", handlePointerUp);
			document.removeEventListener("pointercancel", handlePointerUp);
			document.body.style.userSelect = "";
			document.body.style.touchAction = "";
		};
		const handlePointerMove = (moveEvent: PointerEvent) => {
			lastRatio = updateRatio(moveEvent.clientX, moveEvent.clientY);
		};
		const handlePointerUp = () => {
			cleanup();
			onCommitRatioChange(lastRatio);
		};

		document.addEventListener("pointermove", handlePointerMove, { passive: false });
		document.addEventListener("pointerup", handlePointerUp);
		document.addEventListener("pointercancel", handlePointerUp);
	};

	const dividerStyle: React.CSSProperties | null = hasSecondary
		? isLandscape
			? {
					position: "absolute",
					left: primaryFrame.width - DIRECTOR_DIVIDER_HIT_SIZE / 2,
					top: 0,
					width: DIRECTOR_DIVIDER_HIT_SIZE,
					height: height,
					cursor: "col-resize",
					zIndex: 3,
					touchAction: "none",
					userSelect: "none",
				}
			: {
					position: "absolute",
					left: 0,
					top: primaryFrame.top - DIRECTOR_DIVIDER_HIT_SIZE / 2,
					width: width,
					height: DIRECTOR_DIVIDER_HIT_SIZE,
					cursor: "row-resize",
					zIndex: 3,
					touchAction: "none",
					userSelect: "none",
				}
		: null;

	return (
		<Box
			ref={containerRef}
			h="100%"
			style={{
				position: "relative",
				overflow: "hidden",
				minWidth: 0,
				minHeight: 0,
			}}
		>
			{previewDividers.map((style) => (
				<Box
					key={`preview-divider-${style.left}-${style.top}-${style.width}-${style.height}`}
					style={style}
				/>
			))}
			{leaves.map((leaf) => {
				const isPrimary = leaf.id === primaryLeaf.id;
				const secondaryIndex = secondaryLeaves.findIndex((item) => item.id === leaf.id);
				const frame = isPrimary
					? primaryFrame
					: (secondaryFrames[secondaryIndex] ?? { left: 0, top: 0, width: 0, height: 0 });
				return (
					<DirectorLeafHost
						key={leaf.id}
						leaf={leaf}
						frame={frame}
						compact={!isPrimary}
						allowClose={isPrimary}
						activate={isPrimary ? undefined : (method) => onActivateLeaf(leaf.id, method)}
						suppressAutoFocusOnPromote={isPrimary && lastActivationMethod === "touch"}
						zIndex={isPrimary ? 1 : 2}
					/>
				);
			})}
			{directorDropOverlayStyle ? (
				<Box
					style={{
						position: "absolute",
						...directorDropOverlayStyle,
						backgroundColor: "var(--mantine-color-indigo-9)",
						opacity: 0.25,
						borderRadius: 4,
						pointerEvents: "none",
						transition: "all 100ms ease",
						zIndex: 4,
					}}
				/>
			) : null}
			{dividerStyle && (
				<Box onPointerDown={handleDividerPointerDown} style={dividerStyle}>
					<Box
						style={{
							position: "absolute",
							left: isLandscape ? (DIRECTOR_DIVIDER_HIT_SIZE - DIRECTOR_DIVIDER_LINE_SIZE) / 2 : 0,
							top: isLandscape ? 0 : (DIRECTOR_DIVIDER_HIT_SIZE - DIRECTOR_DIVIDER_LINE_SIZE) / 2,
							width: isLandscape ? DIRECTOR_DIVIDER_LINE_SIZE : "100%",
							height: isLandscape ? "100%" : DIRECTOR_DIVIDER_LINE_SIZE,
							background: "var(--mantine-color-dark-4)",
							opacity: 0.7,
						}}
					/>
				</Box>
			)}
		</Box>
	);
}

// ── Branch: flex container with resize handles ──

function BranchPanel({
	branch,
	onUpdateSizes,
}: {
	branch: SplitBranch;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
}) {
	const isHorizontal = branch.direction === "horizontal";
	const containerRef = useRef<HTMLDivElement>(null);
	const overlayRef = useRef<HTMLDivElement>(null);

	const handleResizeStart = useCallback(
		/** Called on pointerdown — compute handle offset within container and show overlay */
		(_handleIdx: number, pointerPos: number) => {
			const container = containerRef.current;
			const overlay = overlayRef.current;
			if (!container || !overlay) return null;
			const rect = container.getBoundingClientRect();
			const totalPx = isHorizontal ? rect.width : rect.height;
			const containerStart = isHorizontal ? rect.left : rect.top;
			const handleOffset = pointerPos - containerStart;

			// Show overlay line at current position
			overlay.style.display = "block";
			if (isHorizontal) {
				overlay.style.left = `${handleOffset}px`;
				overlay.style.top = "0";
				overlay.style.width = "2px";
				overlay.style.height = "100%";
			} else {
				overlay.style.top = `${handleOffset}px`;
				overlay.style.left = "0";
				overlay.style.height = "2px";
				overlay.style.width = "100%";
			}

			return {
				totalPx,
				containerStart,
				startPointer: pointerPos,
				startOffset: handleOffset,
				startSizes: [...branch.sizes],
			};
		},
		[branch.sizes, isHorizontal],
	);

	/** Called on pointermove — move overlay line (pure DOM, no React state) */
	const handleResizeMove = useCallback(
		(
			currentPos: number,
			ctx: {
				totalPx: number;
				containerStart: number;
				startPointer: number;
				startOffset: number;
				startSizes: number[];
			},
			handleIdx: number,
		) => {
			const overlay = overlayRef.current;
			if (!overlay) return;
			const delta = currentPos - ctx.startPointer;
			const prevPct = ctx.startSizes[handleIdx - 1];
			const currPct = ctx.startSizes[handleIdx];
			const deltaPct = (delta / ctx.totalPx) * 100;
			// Clamp so neither side goes below MIN_SIZE_PCT
			const clampedDelta = Math.max(
				MIN_SIZE_PCT - prevPct,
				Math.min(currPct - MIN_SIZE_PCT, deltaPct),
			);
			const clampedPx = (clampedDelta / 100) * ctx.totalPx;
			const newOffset = ctx.startOffset + clampedPx;
			if (isHorizontal) {
				overlay.style.left = `${newOffset}px`;
			} else {
				overlay.style.top = `${newOffset}px`;
			}
		},
		[isHorizontal],
	);

	/** Called on pointerup — hide overlay, commit final sizes */
	const handleResizeEnd = useCallback(
		(
			currentPos: number,
			ctx: {
				totalPx: number;
				containerStart: number;
				startPointer: number;
				startOffset: number;
				startSizes: number[];
			},
			handleIdx: number,
		) => {
			const overlay = overlayRef.current;
			if (overlay) overlay.style.display = "none";

			const delta = currentPos - ctx.startPointer;
			const deltaPct = (delta / ctx.totalPx) * 100;
			const prevPct = ctx.startSizes[handleIdx - 1];
			const currPct = ctx.startSizes[handleIdx];
			const clampedDelta = Math.max(
				MIN_SIZE_PCT - prevPct,
				Math.min(currPct - MIN_SIZE_PCT, deltaPct),
			);
			if (Math.abs(clampedDelta) < 0.01) return;

			const newSizes = [...ctx.startSizes];
			newSizes[handleIdx - 1] = prevPct + clampedDelta;
			newSizes[handleIdx] = currPct - clampedDelta;
			onUpdateSizes(branch.id, newSizes);
		},
		[branch.id, onUpdateSizes],
	);

	return (
		<Box
			ref={containerRef}
			h="100%"
			w="100%"
			style={{
				display: "flex",
				flexDirection: isHorizontal ? "row" : "column",
				minWidth: 0,
				minHeight: 0,
				overflow: "hidden",
				position: "relative",
			}}
		>
			{branch.children.map((child, idx) => (
				<ChildWithHandle
					key={child.id}
					child={child}
					idx={idx}
					branch={branch}
					isHorizontal={isHorizontal}
					onUpdateSizes={onUpdateSizes}
					onResizeStart={handleResizeStart}
					onResizeMove={handleResizeMove}
					onResizeEnd={handleResizeEnd}
				/>
			))}
			{/* Drag preview overlay line — positioned via pure DOM */}
			<div
				ref={overlayRef}
				style={{
					display: "none",
					position: "absolute",
					backgroundColor: "var(--mantine-color-indigo-6)",
					borderRadius: 1,
					zIndex: 10,
					pointerEvents: "none",
				}}
			/>
		</Box>
	);
}

interface ResizeCtx {
	totalPx: number;
	containerStart: number;
	startPointer: number;
	startOffset: number;
	startSizes: number[];
}

function ChildWithHandle({
	child,
	idx,
	branch,
	isHorizontal,
	onUpdateSizes,
	onResizeStart,
	onResizeMove,
	onResizeEnd,
}: {
	child: SplitNode;
	idx: number;
	branch: SplitBranch;
	isHorizontal: boolean;
	onUpdateSizes: (branchId: string, sizes: number[]) => void;
	onResizeStart: (handleIdx: number, pointerPos: number) => ResizeCtx | null;
	onResizeMove: (currentPos: number, ctx: ResizeCtx, handleIdx: number) => void;
	onResizeEnd: (currentPos: number, ctx: ResizeCtx, handleIdx: number) => void;
}) {
	// Use flex-grow ratio instead of fixed percentage width/height.
	// This lets the flex container naturally account for resize handle widths.
	const flexProp = { flex: `${branch.sizes[idx]} 1 0%` };

	const onResizeStartRef = useRef(onResizeStart);
	onResizeStartRef.current = onResizeStart;
	const onResizeMoveRef = useRef(onResizeMove);
	onResizeMoveRef.current = onResizeMove;
	const onResizeEndRef = useRef(onResizeEnd);
	onResizeEndRef.current = onResizeEnd;

	const handlePointerDown = useCallback(
		(e: React.PointerEvent) => {
			e.preventDefault();
			const pos = isHorizontal ? e.clientX : e.clientY;
			const ctx = onResizeStartRef.current(idx, pos);
			if (!ctx) return;

			document.body.style.cursor = isHorizontal ? "col-resize" : "row-resize";
			document.body.style.userSelect = "none";

			const onMove = (ev: PointerEvent) => {
				onResizeMoveRef.current(isHorizontal ? ev.clientX : ev.clientY, ctx, idx);
			};
			const onUp = (ev: PointerEvent) => {
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
				document.body.style.cursor = "";
				document.body.style.userSelect = "";
				onResizeEndRef.current(isHorizontal ? ev.clientX : ev.clientY, ctx, idx);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[idx, isHorizontal],
	);

	return (
		<>
			{idx > 0 && <ResizeHandle direction={branch.direction} onPointerDown={handlePointerDown} />}
			<Box
				style={{
					...flexProp,
					minWidth: 0,
					minHeight: 0,
					overflow: "hidden",
				}}
			>
				<SplitPanelContainer node={child} onUpdateSizes={onUpdateSizes} />
			</Box>
		</>
	);
}

// ── Resize handle (visual only, drag logic lives in parent) ──

function ResizeHandle({
	direction,
	onPointerDown,
}: {
	direction: SplitDirection;
	onPointerDown: (e: React.PointerEvent) => void;
}) {
	const isHorizontal = direction === "horizontal";

	return (
		<Box
			onPointerDown={onPointerDown}
			style={{
				flexShrink: 0,
				[isHorizontal ? "width" : "height"]: 6,
				cursor: isHorizontal ? "col-resize" : "row-resize",
				backgroundColor: "transparent",
				transition: "background-color 150ms ease",
				position: "relative",
				display: "flex",
				alignItems: "center",
				justifyContent: "center",
			}}
			onMouseEnter={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "var(--mantine-color-indigo-9)";
			}}
			onMouseLeave={(e) => {
				(e.currentTarget as HTMLElement).style.backgroundColor = "transparent";
			}}
		>
			{/* Always-visible thin line indicator */}
			<Box
				style={{
					position: "absolute",
					[isHorizontal ? "width" : "height"]: 1,
					[isHorizontal ? "height" : "width"]: "100%",
					backgroundColor: "var(--mantine-color-dark-4)",
					pointerEvents: "none",
				}}
			/>
		</Box>
	);
}
