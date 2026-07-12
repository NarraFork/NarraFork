/**
 * Director-mode rendering layer.
 *
 * A self-drawn, absolutely-positioned layout that overlays the dockview surface
 * while director mode is active: one full-featured primary panel plus a rail of
 * shrunken (CSS-scaled) preview panels. Clicking a preview promotes it to
 * primary (a switch, not an in-place interaction). A draggable divider adjusts
 * the primary ratio.
 *
 * Panel content reuses the existing panel components (NarratorPanel /
 * WorkspaceTerminalPanel / WebviewPanel). Secondary narrator panels render in
 * `workspacePreview` mode so they stay lightweight.
 */

import { Box } from "@mantine/core";
import {
	lazy,
	memo,
	Suspense,
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useState,
} from "react";
import { NarratorPanel } from "../NarratorPanel";
import { usePanelCompact } from "../panels/shared";
import type { WebviewLeafConfig } from "../split-tree";
import { WebviewPanel } from "../WebviewPanel";
import {
	computeDirectorFrames,
	DIRECTOR_DIVIDER_HIT_SIZE,
	DIRECTOR_DIVIDER_LINE_SIZE,
	DIRECTOR_PADDING,
	type DirectorFrame,
	type DirectorLeaf,
	normalizeDirectorPrimaryRatio,
	previewScaleForWidth,
	resolvePrimaryLeaf,
} from "./director-constants";

const WorkspaceTerminalPanel = lazy(() =>
	import("../../terminal/WorkspaceTerminalPanel").then((m) => ({
		default: m.WorkspaceTerminalPanel,
	})),
);

export interface DirectorLayoutProps {
	leaves: DirectorLeaf[];
	primaryPanelId: string | null;
	primaryRatio: number;
	/** Promote a secondary leaf to primary. */
	onActivate: (leafId: string) => void;
	/** Live preview of the ratio while dragging the divider (not persisted). */
	onPreviewRatio: (ratio: number) => void;
	/** Commit the ratio when the drag ends (persisted). */
	onCommitRatio: (ratio: number) => void;
	/** Open a child session in the narrator's secondary area and return to grid. */
	onViewSubagentSession: (hostNarratorId: string, subagentNarratorId: string) => void;
	/** Close a panel (only offered on the primary). */
	onClosePanel: (leafId: string) => void;
	/** Persist an edited webview config back onto the dockview panel params. */
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
}

/** Renders a leaf's actual panel content (reusing the live panel components). */
function DirectorPanelContent({
	leaf,
	compact,
	isPrimary,
	onClose,
	onViewSubagentSession,
	onUpdateWebviewConfig,
}: {
	leaf: DirectorLeaf;
	compact: boolean;
	isPrimary: boolean;
	onClose?: () => void;
	onViewSubagentSession: (hostNarratorId: string, subagentNarratorId: string) => void;
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
}) {
	const params = leaf.params;
	const narratorId = params.panelType === "narrator" ? params.narratorId : "";

	const handleWebviewConfigChange = useCallback(
		(config: WebviewLeafConfig) => onUpdateWebviewConfig(leaf.id, config),
		[leaf.id, onUpdateWebviewConfig],
	);

	if (params.panelType === "terminal") {
		return (
			<Suspense fallback={null}>
				<WorkspaceTerminalPanel
					key={leaf.id}
					config={params.terminalConfig}
					leafId={leaf.id}
					onClose={onClose}
				/>
			</Suspense>
		);
	}

	if (params.panelType === "webview") {
		return (
			<WebviewPanel
				key={leaf.id}
				config={params.webviewConfig ?? { url: "" }}
				leafId={leaf.id}
				onClose={onClose}
				onConfigChange={handleWebviewConfigChange}
			/>
		);
	}

	if (params.panelType !== "narrator") return null;

	// Narrator. Secondary panels render as lightweight previews.
	return (
		<Box style={{ height: "100%", overflow: "hidden" }}>
			<NarratorPanel
				key={narratorId}
				narratorId={narratorId}
				compact={compact}
				onClose={onClose}
				onViewSubagentSession={(subagentNarratorId) =>
					onViewSubagentSession(narratorId, subagentNarratorId)
				}
				workspacePreview={!isPrimary}
			/>
		</Box>
	);
}

/** One absolutely-positioned host for a leaf; secondary hosts scale + intercept clicks. */
function DirectorLeafHost({
	leaf,
	frame,
	isPrimary,
	onActivate,
	onClose,
	onViewSubagentSession,
	onUpdateWebviewConfig,
}: {
	leaf: DirectorLeaf;
	frame: DirectorFrame;
	isPrimary: boolean;
	onActivate: (leafId: string) => void;
	onClose: (leafId: string) => void;
	onViewSubagentSession: (hostNarratorId: string, subagentNarratorId: string) => void;
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
}) {
	const { ref, compact } = usePanelCompact();
	const previewScale = isPrimary ? 1 : previewScaleForWidth(frame.width);
	const handleClose = useCallback(() => onClose(leaf.id), [leaf.id, onClose]);

	return (
		<Box
			style={{
				position: "absolute",
				left: frame.left,
				top: frame.top,
				width: frame.width,
				height: frame.height,
				overflow: "hidden",
				zIndex: isPrimary ? 1 : 2,
				borderRadius: 4,
				border: "1px solid var(--mantine-color-default-border)",
				transition:
					"left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease, opacity 140ms ease",
				willChange: "left, top, width, height",
			}}
		>
			<Box
				ref={ref}
				style={{
					width: `${100 / previewScale}%`,
					height: `${100 / previewScale}%`,
					transform: `scale(${previewScale})`,
					transformOrigin: "top left",
				}}
			>
				<DirectorPanelContent
					leaf={leaf}
					compact={compact}
					isPrimary={isPrimary}
					onClose={isPrimary ? handleClose : undefined}
					onViewSubagentSession={onViewSubagentSession}
					onUpdateWebviewConfig={onUpdateWebviewConfig}
				/>
			</Box>
			{!isPrimary && (
				<Box
					role="button"
					tabIndex={0}
					aria-label="Activate panel"
					onClick={() => onActivate(leaf.id)}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onActivate(leaf.id);
						}
					}}
					style={{ position: "absolute", inset: 0, zIndex: 2, cursor: "pointer" }}
				/>
			)}
		</Box>
	);
}

const MemoDirectorLeafHost = memo(DirectorLeafHost);

export function DirectorLayout({
	leaves,
	primaryPanelId,
	primaryRatio,
	onActivate,
	onPreviewRatio,
	onCommitRatio,
	onViewSubagentSession,
	onClosePanel,
	onUpdateWebviewConfig,
}: DirectorLayoutProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [isLandscape, setIsLandscape] = useState(true);
	// Cleanup for an in-flight divider drag, so an unmount mid-drag still removes
	// the document listeners and restores body styles (otherwise they leak).
	const dragCleanupRef = useRef<(() => void) | null>(null);

	useEffect(() => {
		return () => {
			dragCleanupRef.current?.();
			dragCleanupRef.current = null;
		};
	}, []);

	// Seed the size synchronously on mount so the first paint uses real frames
	// instead of a zero-size layout (which flashes blank when entering director).
	useLayoutEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const rect = el.getBoundingClientRect();
		if (rect.width > 0 || rect.height > 0) {
			setSize({ width: rect.width, height: rect.height });
			setIsLandscape(rect.width >= rect.height);
		}
	}, []);

	useEffect(() => {
		const el = containerRef.current;
		if (!el) return;
		const ro = new ResizeObserver((entries) => {
			const rect = entries[0]?.contentRect;
			if (!rect) return;
			setSize({ width: rect.width, height: rect.height });
			setIsLandscape(rect.width >= rect.height);
		});
		ro.observe(el);
		return () => ro.disconnect();
	}, []);

	const primaryLeaf = resolvePrimaryLeaf(leaves, primaryPanelId);
	const secondaryLeaves = primaryLeaf ? leaves.filter((l) => l.id !== primaryLeaf.id) : [];
	const hasSecondary = secondaryLeaves.length > 0;

	const { width, height } = size;
	const { primaryFrame, secondaryFrames } = computeDirectorFrames({
		width,
		height,
		isLandscape,
		secondaryCount: secondaryLeaves.length,
		primaryRatio,
	});

	const handleDividerPointerDown = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
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
				onPreviewRatio(nextRatio);
				return nextRatio;
			};

			let lastRatio = updateRatio(event.clientX, event.clientY);
			const pointerId = event.pointerId;
			const target = event.currentTarget;
			target.setPointerCapture(pointerId);
			document.body.style.userSelect = "none";
			document.body.style.touchAction = "none";

			const cleanup = () => {
				if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
				document.removeEventListener("pointermove", handlePointerMove);
				document.removeEventListener("pointerup", handlePointerUp);
				document.removeEventListener("pointercancel", handlePointerUp);
				document.body.style.userSelect = "";
				document.body.style.touchAction = "";
				dragCleanupRef.current = null;
			};
			const handlePointerMove = (moveEvent: PointerEvent) => {
				lastRatio = updateRatio(moveEvent.clientX, moveEvent.clientY);
			};
			const handlePointerUp = () => {
				cleanup();
				onCommitRatio(lastRatio);
			};

			// Expose cleanup so an unmount mid-drag can tear down these listeners.
			dragCleanupRef.current = cleanup;
			document.addEventListener("pointermove", handlePointerMove, { passive: false });
			document.addEventListener("pointerup", handlePointerUp);
			document.addEventListener("pointercancel", handlePointerUp);
		},
		[hasSecondary, isLandscape, onPreviewRatio, onCommitRatio],
	);

	if (!primaryLeaf) return null;

	const dividerStyle: React.CSSProperties | null = hasSecondary
		? isLandscape
			? {
					position: "absolute",
					left:
						primaryFrame.left +
						primaryFrame.width +
						DIRECTOR_PADDING -
						DIRECTOR_DIVIDER_HIT_SIZE / 2,
					top: 0,
					width: DIRECTOR_DIVIDER_HIT_SIZE,
					height,
					cursor: "col-resize",
					zIndex: 3,
					touchAction: "none",
					userSelect: "none",
				}
			: {
					position: "absolute",
					left: 0,
					top: primaryFrame.top - DIRECTOR_PADDING - DIRECTOR_DIVIDER_HIT_SIZE / 2,
					width,
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
			style={{
				position: "absolute",
				inset: 0,
				// Opaque + isolated so we reliably cover dockview's overlay panels
				// (which use z-index 999 inside the surface's own stacking context).
				isolation: "isolate",
				zIndex: 1000,
				overflow: "hidden",
				backgroundColor: "var(--mantine-color-body)",
			}}
		>
			{leaves.map((leaf) => {
				const isPrimary = leaf.id === primaryLeaf.id;
				const secondaryIndex = secondaryLeaves.findIndex((l) => l.id === leaf.id);
				const frame = isPrimary
					? primaryFrame
					: (secondaryFrames[secondaryIndex] ?? { left: 0, top: 0, width: 0, height: 0 });
				return (
					<MemoDirectorLeafHost
						key={leaf.id}
						leaf={leaf}
						frame={frame}
						isPrimary={isPrimary}
						onActivate={onActivate}
						onClose={onClosePanel}
						onViewSubagentSession={onViewSubagentSession}
						onUpdateWebviewConfig={onUpdateWebviewConfig}
					/>
				);
			})}
			{dividerStyle && (
				<Box onPointerDown={handleDividerPointerDown} style={dividerStyle}>
					<Box
						style={{
							position: "absolute",
							left: isLandscape ? (DIRECTOR_DIVIDER_HIT_SIZE - DIRECTOR_DIVIDER_LINE_SIZE) / 2 : 0,
							top: isLandscape ? 0 : (DIRECTOR_DIVIDER_HIT_SIZE - DIRECTOR_DIVIDER_LINE_SIZE) / 2,
							width: isLandscape ? DIRECTOR_DIVIDER_LINE_SIZE : "100%",
							height: isLandscape ? "100%" : DIRECTOR_DIVIDER_LINE_SIZE,
							background: "var(--mantine-color-default-border)",
							opacity: 0.7,
						}}
					/>
				</Box>
			)}
		</Box>
	);
}
