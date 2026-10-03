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
	useMemo,
	useRef,
	useState,
} from "react";
import { type PluginDockPanelHostApi, PluginDockPanelView } from "../../plugins/PluginDockPanel";
import { PluginUiSurfaceProvider } from "../../plugins/PluginUiSurfaceContext";
import type { PluginDockPanelParams } from "../../plugins/protocol";
import { WebviewPanel } from "../browser/WebviewPanel";
import { NarratorPanel } from "../NarratorPanel";
import { usePanelCompact } from "../panels/shared";
import type { WebviewLeafConfig } from "../split-tree";
import {
	computeDirectorFrames,
	DIRECTOR_DIVIDER_HIT_SIZE,
	DIRECTOR_DIVIDER_LINE_SIZE,
	DIRECTOR_PADDING,
	type DirectorFrame,
	type DirectorLeaf,
	directorRailIndexAtX,
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
	workspaceId: string;
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
	onViewSubagentSession: (
		hostNarratorId: string,
		subagentNarratorId: string,
		messageId?: string,
	) => void;
	/** Close a panel (only offered on the primary). */
	onClosePanel: (leafId: string) => void;
	/** Persist an edited webview config back onto the dockview panel params. */
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
	/** Persist plugin-owned view state back onto the dockview panel params. */
	onUpdatePluginParams: (leafId: string, params: PluginDockPanelParams) => void;
	/** Keep the hidden Dockview panel title in sync with host-local panel.setTitle. */
	onSetPanelTitle: (leafId: string, title: string) => void;
}

function DirectorPluginPanel({
	leaf,
	isPrimary,
	onClose,
	onActivate,
	onUpdatePluginParams,
	onSetPanelTitle,
}: {
	leaf: DirectorLeaf & { params: PluginDockPanelParams };
	isPrimary: boolean;
	onClose?: () => void;
	onActivate: (leafId: string) => void;
	onUpdatePluginParams: (leafId: string, params: PluginDockPanelParams) => void;
	onSetPanelTitle: (leafId: string, title: string) => void;
}) {
	const hostApi = useMemo<PluginDockPanelHostApi>(
		() => ({
			title: leaf.title,
			isActive: isPrimary,
			setTitle: (title) => onSetPanelTitle(leaf.id, title),
			updateParameters: (params) => onUpdatePluginParams(leaf.id, params),
			setActive: () => onActivate(leaf.id),
			close: () => onClose?.(),
		}),
		[leaf.id, leaf.title, isPrimary, onActivate, onClose, onSetPanelTitle, onUpdatePluginParams],
	);
	return <PluginDockPanelView rawParams={leaf.params} hostApi={hostApi} />;
}

/** Renders a leaf's actual panel content (reusing the live panel components). */
function DirectorPanelContent({
	leaf,
	compact,
	isPrimary,
	suppressAutoFocusOnPromote,
	onClose,
	onActivate,
	onViewSubagentSession,
	onUpdateWebviewConfig,
	onUpdatePluginParams,
	onSetPanelTitle,
}: {
	leaf: DirectorLeaf;
	compact: boolean;
	isPrimary: boolean;
	/** Touch promotions pass this down so the composer focus never summons the keyboard. */
	suppressAutoFocusOnPromote?: boolean;
	onClose?: () => void;
	onActivate: (leafId: string) => void;
	onViewSubagentSession: (
		hostNarratorId: string,
		subagentNarratorId: string,
		messageId?: string,
	) => void;
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
	onUpdatePluginParams: (leafId: string, params: PluginDockPanelParams) => void;
	onSetPanelTitle: (leafId: string, title: string) => void;
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

	if (params.panelType === "plugin") {
		return (
			<DirectorPluginPanel
				leaf={leaf as DirectorLeaf & { params: PluginDockPanelParams }}
				isPrimary={isPrimary}
				onClose={onClose}
				onActivate={onActivate}
				onUpdatePluginParams={onUpdatePluginParams}
				onSetPanelTitle={onSetPanelTitle}
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
				onViewSubagentSession={(subagentNarratorId, messageId) =>
					onViewSubagentSession(narratorId, subagentNarratorId, messageId)
				}
				workspacePreview={!isPrimary}
				suppressAutoFocusOnPromote={suppressAutoFocusOnPromote}
			/>
		</Box>
	);
}

/** One absolutely-positioned host for a leaf; secondary hosts scale + intercept clicks. */
function DirectorLeafHost({
	leaf,
	frame,
	isPrimary,
	framesInstant,
	railScrolled,
	onActivate,
	onActivateGesture,
	suppressAutoFocusOnPromote,
	onClose,
	onViewSubagentSession,
	onUpdateWebviewConfig,
	onUpdatePluginParams,
	onSetPanelTitle,
}: {
	leaf: DirectorLeaf;
	frame: DirectorFrame;
	isPrimary: boolean;
	/** Skip the frame transition (the portrait rail is mid-scroll: offsets must track instantly). */
	framesInstant?: boolean;
	/** Render `left` through the rail's imperative scroll offset (portrait rail only). */
	railScrolled?: boolean;
	onActivate: (leafId: string) => void;
	/** Records the gesture's pointer type ahead of the promotion render. */
	onActivateGesture: (pointerType: string | null) => void;
	suppressAutoFocusOnPromote: boolean;
	onClose: (leafId: string) => void;
	onViewSubagentSession: (
		hostNarratorId: string,
		subagentNarratorId: string,
		messageId?: string,
	) => void;
	onUpdateWebviewConfig: (leafId: string, config: WebviewLeafConfig) => void;
	onUpdatePluginParams: (leafId: string, params: PluginDockPanelParams) => void;
	onSetPanelTitle: (leafId: string, title: string) => void;
}) {
	const { ref, compact } = usePanelCompact();
	const previewScale = isPrimary ? 1 : previewScaleForWidth(frame.width);
	const handleClose = useCallback(() => onClose(leaf.id), [leaf.id, onClose]);

	return (
		<Box
			style={{
				position: "absolute",
				// Portrait rail hosts read their left through the imperative scroll
				// offset (see DirectorLayout); everyone else uses the frame as-is.
				left: railScrolled ? `calc(${frame.left}px - var(--nf-rail-scroll, 0px))` : frame.left,
				top: frame.top,
				width: frame.width,
				height: frame.height,
				overflow: "hidden",
				zIndex: isPrimary ? 1 : 2,
				borderRadius: 4,
				border: "1px solid var(--mantine-color-default-border)",
				transition: framesInstant
					? "none"
					: "left 140ms ease, top 140ms ease, width 140ms ease, height 140ms ease, opacity 140ms ease",
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
					suppressAutoFocusOnPromote={suppressAutoFocusOnPromote}
					onClose={isPrimary ? handleClose : undefined}
					onActivate={onActivate}
					onViewSubagentSession={onViewSubagentSession}
					onUpdateWebviewConfig={onUpdateWebviewConfig}
					onUpdatePluginParams={onUpdatePluginParams}
					onSetPanelTitle={onSetPanelTitle}
				/>
			</Box>
			{!isPrimary && (
				<Box
					role="button"
					tabIndex={0}
					aria-label="Activate panel"
					onPointerDown={(e) => onActivateGesture(e.pointerType)}
					onClick={(e) => {
						// Self-contained record: PointerEvent.pointerType for real
						// pointers, "" for synthetic clicks (→ null, focus allowed).
						onActivateGesture((e.nativeEvent as PointerEvent).pointerType || null);
						onActivate(leaf.id);
					}}
					onKeyDown={(e) => {
						if (e.key === "Enter" || e.key === " ") {
							e.preventDefault();
							onActivateGesture(null);
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
	workspaceId,
	leaves,
	primaryPanelId,
	primaryRatio,
	onActivate,
	onPreviewRatio,
	onCommitRatio,
	onViewSubagentSession,
	onClosePanel,
	onUpdateWebviewConfig,
	onUpdatePluginParams,
	onSetPanelTitle,
}: DirectorLayoutProps) {
	const containerRef = useRef<HTMLDivElement>(null);
	const [size, setSize] = useState({ width: 0, height: 0 });
	const [isLandscape, setIsLandscape] = useState(true);
	// Pointer type of the latest promote gesture (pointerdown fires before the
	// click that promotes, so this is already set when the promotion renders).
	// A touch promotion must not focus the composer — focusing a field summons
	// the soft keyboard, which a tap on a preview was not asking for.
	const activatePointerTypeRef = useRef<string | null>(null);
	const handleActivateGesture = useCallback((pointerType: string | null) => {
		activatePointerTypeRef.current = pointerType;
	}, []);
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
	const { railThickness, primaryFrame, secondaryFrames } = computeDirectorFrames({
		width,
		height,
		isLandscape,
		secondaryCount: secondaryLeaves.length,
		primaryRatio,
	});

	// ── Portrait rail scrolling ──
	// The portrait rail is ONE row of previews. A transparent native scroller
	// sits above the (non-interactive) previews and owns all pointer gestures in
	// the rail zone: drags scroll with native momentum, taps are hit-tested
	// against the frames and promote. Hosts stay flat siblings — their `left`
	// reads `calc(frame - var(--nf-rail-scroll))` — so promotion/demotion never
	// remounts a panel and keeps its frame transition.
	//
	// The offset lives in an imperatively-updated CSS variable, NOT React state:
	// a state-driven offset re-rendered every leaf (including the primary's
	// NarratorPanel) on each scroll frame, on the most performance-constrained
	// devices. With the variable, scrolling costs zero React renders; state only
	// tracks the gesture's settled-ness, because transitions must not run while
	// the offset is chasing the scroll (each tiny delta would re-animate for
	// 140ms and turn the rail rubbery).
	const [railScrolling, setRailScrolling] = useState(false);
	const railSettleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	useEffect(() => {
		return () => {
			if (railSettleTimerRef.current !== null) clearTimeout(railSettleTimerRef.current);
		};
	}, []);

	const handleRailScroll = useCallback((event: React.UIEvent<HTMLDivElement>) => {
		containerRef.current?.style.setProperty(
			"--nf-rail-scroll",
			`${event.currentTarget.scrollLeft}px`,
		);
		setRailScrolling(true);
		if (railSettleTimerRef.current !== null) clearTimeout(railSettleTimerRef.current);
		railSettleTimerRef.current = setTimeout(() => setRailScrolling(false), 160);
	}, []);

	// Rotation (or closing the last secondary) unmounts the scroller; on remount
	// its DOM scrollLeft is 0 while the container variable would keep the stale
	// offset — previews and hit-testing would disagree about positions.
	const syncRailScrollVar = useCallback((el: HTMLDivElement | null) => {
		if (el) {
			containerRef.current?.style.setProperty("--nf-rail-scroll", `${el.scrollLeft}px`);
		}
	}, []);

	const lastSecondaryFrame = secondaryFrames[secondaryFrames.length - 1];
	const railContentWidth = lastSecondaryFrame
		? lastSecondaryFrame.left + lastSecondaryFrame.width + DIRECTOR_PADDING
		: 0;

	// Tap-to-promote on the rail scroller: hit-test the tap point (in rail
	// content coordinates) against the frames. Gaps between previews activate
	// nothing. After a scroll gesture the browser suppresses the click, so a
	// flick never promotes by accident.
	const handleRailClick = useCallback(
		(event: React.MouseEvent<HTMLDivElement>) => {
			// Record the gesture type from the click itself (PointerEvent in modern
			// browsers, "" for synthetic clicks) so every activation is
			// self-contained rather than reading a stale pointerdown.
			handleActivateGesture((event.nativeEvent as PointerEvent).pointerType || null);
			const scroller = event.currentTarget;
			const x = event.clientX - scroller.getBoundingClientRect().left + scroller.scrollLeft;
			const index = directorRailIndexAtX(secondaryFrames, x);
			const leaf = index >= 0 ? secondaryLeaves[index] : undefined;
			if (leaf) onActivate(leaf.id);
		},
		[secondaryFrames, secondaryLeaves, onActivate, handleActivateGesture],
	);

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
		<PluginUiSurfaceProvider
			hostContext={{ surface: "director", workspaceId, presentation: "director" }}
		>
			<Box
				ref={containerRef}
				className="nf-director-layout"
				style={{
					position: "absolute",
					left: 0,
					right: 0,
					bottom: 0,
					// On narrow screens with the virtual keyboard up (safe-area.css),
					// the lift grows the box upward by the keyboard's occlusion height:
					// the primary panel and rail keep their pre-keyboard size instead of
					// being squeezed, the surplus slides off the top (the parent clips
					// it), and the bottom edge stays put so the composer sits right on
					// the keyboard. 0px at rest, where this is exactly `inset: 0`.
					top: "calc(var(--nf-director-keyboard-lift, 0px) * -1)",
					// Isolate the local primary/preview/divider layers without creating a
					// global stacking race with Mantine portal menus and comboboxes.
					isolation: "isolate",
					overflow: "hidden",
					backgroundColor: "var(--mantine-color-body)",
					// Portrait rail scroll offset, updated imperatively on scroll.
					...({ "--nf-rail-scroll": "0px" } as React.CSSProperties),
				}}
			>
				{leaves.map((leaf) => {
					const isPrimary = leaf.id === primaryLeaf.id;
					const secondaryIndex = secondaryLeaves.findIndex((l) => l.id === leaf.id);
					const frame = isPrimary
						? primaryFrame
						: (secondaryFrames[secondaryIndex] ?? { left: 0, top: 0, width: 0, height: 0 });
					// Only coarse-pointer promotions suppress the composer focus: touch
					// (and pen on Android) summon the soft keyboard on focus; mouse,
					// keyboard (null) and synthetic clicks keep the existing focus.
					const gestureType = activatePointerTypeRef.current;
					return (
						<MemoDirectorLeafHost
							key={leaf.id}
							leaf={leaf}
							frame={frame}
							isPrimary={isPrimary}
							framesInstant={!isPrimary && !isLandscape && railScrolling}
							railScrolled={!isPrimary && !isLandscape}
							onActivate={onActivate}
							onActivateGesture={handleActivateGesture}
							suppressAutoFocusOnPromote={gestureType === "touch" || gestureType === "pen"}
							onClose={onClosePanel}
							onViewSubagentSession={onViewSubagentSession}
							onUpdateWebviewConfig={onUpdateWebviewConfig}
							onUpdatePluginParams={onUpdatePluginParams}
							onSetPanelTitle={onSetPanelTitle}
						/>
					);
				})}
				{/* Portrait rail scroller: transparent, above the previews (same z-index,
				    later in DOM). Owns every pointer gesture in the rail zone — drags
				    scroll natively, taps promote via frame hit-test. The per-host
				    overlays stay for keyboard activation; pointer never reaches them here. */}
				{!isLandscape && hasSecondary && (
					<Box
						ref={syncRailScrollVar}
						data-director-rail-scroller
						onClick={handleRailClick}
						onScroll={handleRailScroll}
						style={{
							position: "absolute",
							left: 0,
							top: 0,
							width: "100%",
							height: railThickness,
							overflowX: "auto",
							overflowY: "hidden",
							zIndex: 2,
							WebkitOverflowScrolling: "touch",
						}}
					>
						<Box style={{ width: railContentWidth, height: 1 }} />
					</Box>
				)}
				{dividerStyle && (
					<Box onPointerDown={handleDividerPointerDown} style={dividerStyle}>
						<Box
							style={{
								position: "absolute",
								left: isLandscape
									? (DIRECTOR_DIVIDER_HIT_SIZE - DIRECTOR_DIVIDER_LINE_SIZE) / 2
									: 0,
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
		</PluginUiSurfaceProvider>
	);
}
