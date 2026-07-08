/**
 * DockviewSurface — NarraFork's reusable Dockview wrapper.
 *
 * Bundles the custom behaviours we want everywhere we embed Dockview:
 *   - Mantine-aligned theme (theme.css) + single-tab hiding
 *   - three-zone drop semantics (center swap / surround merge / edge split)
 *     for both the panel-drag singleton and native panel drags
 *   - an overlay hint that distinguishes swap from merge/split
 *
 * Domain-specific concerns (layout persistence, which components to register,
 * how to materialise an external subject drop) are injected by the caller.
 */

import { Box } from "@mantine/core";
import {
	type DockviewApi,
	type DockviewDidDropEvent,
	DockviewReact,
	type DockviewReadyEvent,
	type DockviewWillDropEvent,
	type IDockviewPanelHeaderProps,
	type IDockviewPanelProps,
} from "dockview-react";
import "dockview-react/dist/styles/dockview.css";
import "./theme.css";
import { type RefObject, useCallback, useEffect, useRef } from "react";
import type { PanelDragState } from "../../lib/panel-drag";
import type { DropZoneThresholds } from "./drop-intent";
import { swapPanels } from "./panel-swap";
import { type DockviewDropTarget, useDockviewDnd } from "./useDockviewDnd";

/** Theme class that maps dockview CSS variables to Mantine (see theme.css). */
export const DOCKVIEW_THEME_CLASS = "dockview-theme-narrafork";

/**
 * NarraFork's dockview theme descriptor.
 *
 * Dockview v7 applies a theme to an internal `.dv-shell` element and, when no
 * `theme` is supplied, defaults to the dark `abyss` theme. That default sits
 * INSIDE our `.dockview-theme-narrafork` wrapper, so its CSS variables shadow
 * ours (e.g. inactive tabs render dark navy) and it forces a different tab-strip
 * height. Supplying our own theme makes dockview stamp OUR class on the shell,
 * so `theme.css` variables are authoritative and the strip metrics are ours.
 *
 * `tabGroupIndicator: "none"` disables dockview's built-in group underline (we
 * render our own active-tab indicator in theme.css). `colorScheme` follows the
 * app's Mantine light/dark scheme via the CSS variables, so it is left unset.
 */
const NARRAFORK_DOCKVIEW_THEME = {
	name: "narrafork",
	className: DOCKVIEW_THEME_CLASS,
	tabGroupIndicator: "none",
} as const;

export interface DockviewSurfaceProps {
	/** Panel component registry passed to DockviewReact. */
	// biome-ignore lint/suspicious/noExplicitAny: dockview panel registry is heterogeneous
	components: Record<string, React.FunctionComponent<IDockviewPanelProps<any>>>;
	/** Called once the DockviewApi is ready (after internal wiring). */
	onReady?: (api: DockviewApi) => void;
	/** Native dockview drop (e.g. external HTML5 payloads). */
	onDidDrop?: (event: DockviewDidDropEvent, api: DockviewApi) => void;
	/**
	 * Handle a drop of a subject that is NOT an existing panel (e.g. a sidebar
	 * recent tab) coming through the panel-drag singleton.
	 */
	onDropSubject?: (state: PanelDragState, target: DockviewDropTarget, api: DockviewApi) => void;
	/**
	 * Enable the central "swap" zone for native (dockview-internal) panel drags.
	 * Defaults to true. Merge/split fall through to dockview's own behaviour.
	 */
	enableSwapZone?: boolean;
	/** Override the three-zone thresholds. */
	thresholds?: DropZoneThresholds;
	/** Extra class names appended to the theme class. */
	className?: string;
	/** Skip the default theme class (advanced; you own theming then). */
	themeless?: boolean;
	/** Expose the live DockviewApi ref to the caller. */
	apiRef?: RefObject<DockviewApi | null>;
	/**
	 * Surface-wide panel render mode:
	 *   - "onlyWhenVisible" (dockview default): a panel's DOM is removed when it
	 *     is not visible (hidden tab, or moved between groups), which REMOUNTS
	 *     the framework component and loses its state (WS sessions, terminals,
	 *     scroll position).
	 *   - "always": keep every panel's DOM alive and merely hide it, so moving a
	 *     panel between groups (split/swap/merge) preserves the component
	 *     instance and all its state.
	 * Leave unset to inherit dockview's default.
	 */
	defaultRenderer?: "always" | "onlyWhenVisible";
	/**
	 * Per-panel tab renderers, keyed by the `tabComponent` name a panel is added
	 * with. Used e.g. to give the focus dock's chat panel a close-less tab so the
	 * cluster protagonist can never be closed.
	 */
	tabComponents?: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>>;
}

export function DockviewSurface({
	components,
	onReady,
	onDidDrop,
	onDropSubject,
	enableSwapZone = true,
	thresholds,
	className,
	themeless,
	apiRef: externalApiRef,
	defaultRenderer,
	tabComponents,
}: DockviewSurfaceProps) {
	const internalApiRef = useRef<DockviewApi | null>(null);
	const apiRef = externalApiRef ?? internalApiRef;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const relayoutDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
	const relayoutRafRef = useRef<number | null>(null);

	// With defaultRenderer="always" dockview renders each panel into an
	// absolutely-positioned overlay whose top/height are JS-computed from the
	// content container and only recomputed on a dimension change. Our theme
	// hides the tab strip via CSS (`.dv-single-tab { display:none }`) when a
	// group drops to one tab; that grows the content box WITHOUT changing the
	// group's pixel size, so no dimension-change event fires and the overlay
	// keeps its stale offset (an empty tab-strip-high gap above the panel).
	// Forcing a relayout at the current size re-propagates panel dimensions,
	// which makes the overlay recompute its position. Harmless in
	// onlyWhenVisible mode (content lives in the flex box), so always run it.
	const scheduleRelayout = useCallback(() => {
		if (relayoutRafRef.current !== null) return;
		relayoutRafRef.current = requestAnimationFrame(() => {
			relayoutRafRef.current = null;
			const api = apiRef.current;
			if (!api) return;
			api.layout(api.width, api.height, true);
		});
	}, [apiRef]);

	const handleReady = useCallback(
		(event: DockviewReadyEvent) => {
			apiRef.current = event.api;
			// Re-run after add/remove so crossing the single-tab boundary (strip
			// shown ↔ hidden) repositions the always-rendered panel overlays.
			relayoutDisposablesRef.current = [
				event.api.onDidAddPanel(() => scheduleRelayout()),
				event.api.onDidRemovePanel(() => scheduleRelayout()),
			];
			onReady?.(event.api);
		},
		[apiRef, onReady, scheduleRelayout],
	);

	useEffect(() => {
		return () => {
			if (relayoutRafRef.current !== null) {
				cancelAnimationFrame(relayoutRafRef.current);
				relayoutRafRef.current = null;
			}
			for (const d of relayoutDisposablesRef.current) d.dispose();
			relayoutDisposablesRef.current = [];
		};
	}, []);

	const handleDidDrop = useCallback(
		(event: DockviewDidDropEvent) => {
			const api = apiRef.current;
			if (!api) return;
			onDidDrop?.(event, api);
		},
		[apiRef, onDidDrop],
	);

	// Native (dockview-internal) panel drag: add a center "swap" zone. Dockview
	// already merges on center and splits on edges, matching our merge/split
	// intents, so we only override the content-center drop → swap.
	const handleWillDrop = useCallback(
		(event: DockviewWillDropEvent) => {
			if (!enableSwapZone) return;
			if (event.kind !== "content" || event.position !== "center") return;
			const data = event.getData();
			const api = apiRef.current;
			if (!data || !api) return;
			const draggedPanelId = data.panelId;
			const targetPanelId = event.group?.activePanel?.id;
			if (!draggedPanelId || !targetPanelId || draggedPanelId === targetPanelId) return;
			if (data.groupId === event.group?.id) return; // same group → let default run
			event.preventDefault();
			swapPanels(api, draggedPanelId, targetPanelId);
		},
		[apiRef, enableSwapZone],
	);

	const handleDropSubject = useCallback(
		(state: PanelDragState, target: DockviewDropTarget) => {
			const api = apiRef.current;
			if (!api) return;
			onDropSubject?.(state, target, api);
		},
		[apiRef, onDropSubject],
	);

	const { dropIndicator } = useDockviewDnd({
		apiRef,
		rootRef,
		onDropSubject: onDropSubject ? handleDropSubject : undefined,
		thresholds,
	});

	const surfaceClass = [themeless ? "" : DOCKVIEW_THEME_CLASS, className].filter(Boolean).join(" ");

	return (
		<Box ref={rootRef} style={{ height: "100%", width: "100%", position: "relative" }}>
			<DockviewReact
				className={surfaceClass || undefined}
				// Supply our own theme so dockview stamps OUR class on the internal
				// shell instead of defaulting to the dark `abyss` theme (which would
				// shadow our CSS variables from inside the wrapper). Skipped when the
				// caller opts out of theming.
				theme={themeless ? undefined : NARRAFORK_DOCKVIEW_THEME}
				components={components}
				tabComponents={tabComponents}
				onReady={handleReady}
				onDidDrop={handleDidDrop}
				onWillDrop={handleWillDrop}
				defaultRenderer={defaultRenderer}
			/>
			{dropIndicator && (
				<Box
					style={{
						position: "absolute",
						left: dropIndicator.left,
						top: dropIndicator.top,
						width: dropIndicator.width,
						height: dropIndicator.height,
						backgroundColor:
							dropIndicator.variant === "swap"
								? "var(--mantine-color-teal-8)"
								: "var(--mantine-color-indigo-9)",
						opacity: dropIndicator.variant === "swap" ? 0.35 : 0.25,
						border:
							dropIndicator.variant === "swap"
								? "2px dashed var(--mantine-color-teal-4)"
								: undefined,
						borderRadius: 4,
						pointerEvents: "none",
						transition: "all 80ms ease",
						zIndex: 5,
					}}
				/>
			)}
		</Box>
	);
}
