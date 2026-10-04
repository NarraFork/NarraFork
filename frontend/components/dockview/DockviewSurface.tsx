/**
 * DockviewSurface — NarraFork's reusable Dockview wrapper.
 *
 * Bundles the custom behaviours we want everywhere we embed Dockview:
 *   - Mantine-aligned theme (theme.css)
 *   - three-zone drop semantics (center swap / surround merge / edge split)
 *     for both the panel-drag singleton and native panel drags
 *   - an overlay hint that distinguishes swap from merge/split
 *
 * Domain-specific concerns (layout persistence, which components to register,
 * how to materialise an external subject drop) are injected by the caller.
 */

import { Box } from "@mantine/core";
import { IconSwitchHorizontal } from "@tabler/icons-react";
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
import {
	createContext,
	type RefObject,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PanelDragState } from "../../lib/panel-drag";
import type { DropIndicator, DropZoneThresholds } from "./drop-intent";
import { DefaultSurfaceTab, withSurfaceTabMenu } from "./SurfaceTab";
import {
	bindNativeDropPreview,
	DOCKVIEW_SURFACE_ATTR,
	type DockviewDropTarget,
	dropNativePanel,
	useDockviewDnd,
} from "./useDockviewDnd";

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
	 * Defaults to true. When disabled, the small center zone merges instead.
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
	/** Keep temporary workspace windows inside the available surface. */
	floatingGroupBounds?: "boundedWithinViewport";
	/**
	 * Per-panel tab renderers, keyed by the `tabComponent` name a panel is added
	 * with. Used e.g. to give the focus dock's chat panel a close-less tab so the
	 * cluster protagonist can never be closed.
	 */
	tabComponents?: Record<string, React.FunctionComponent<IDockviewPanelHeaderProps>>;
	/**
	 * Stable identity for this surface, stamped onto panel-header drags and matched
	 * on drop.
	 *
	 * Needed wherever more than one surface can be mounted at once (one per
	 * expanded graph node): panel ids are global (`ndock-terminal`), so a surface
	 * receiving a foreign panel's drop would otherwise resolve that id against its
	 * own api and move an unrelated same-kind panel. Omit it for a lone surface to
	 * keep the previous behaviour.
	 */
	surfaceId?: string;
}

/**
 * The id of the nearest enclosing DockviewSurface.
 *
 * Panel headers sit deep inside dockview's own render tree, so the id cannot be
 * prop-drilled to them; `usePanelHeaderDrag` reads it from here when starting a
 * drag.
 */
const DockviewSurfaceIdContext = createContext<string | undefined>(undefined);

/** Read the enclosing surface's id, or undefined outside a DockviewSurface. */
export function useDockviewSurfaceId(): string | undefined {
	return useContext(DockviewSurfaceIdContext);
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
	floatingGroupBounds,
	tabComponents,
	surfaceId,
}: DockviewSurfaceProps) {
	const wrappedTabs = useMemo(
		() =>
			tabComponents &&
			Object.fromEntries(
				Object.entries(tabComponents).map(([name, Tab]) => [name, withSurfaceTabMenu(Tab)]),
			),
		[tabComponents],
	);
	const internalApiRef = useRef<DockviewApi | null>(null);
	const apiRef = externalApiRef ?? internalApiRef;
	const rootRef = useRef<HTMLDivElement | null>(null);
	const [readyApi, setReadyApi] = useState<DockviewApi | null>(null);
	const [nativeIndicator, setNativeIndicator] = useState<DropIndicator | null>(null);

	useEffect(() => {
		const root = rootRef.current;
		if (!readyApi || !root) return;
		return bindNativeDropPreview(readyApi, root, setNativeIndicator, thresholds, enableSwapZone);
	}, [readyApi, thresholds, enableSwapZone]);

	const handleReady = useCallback(
		(event: DockviewReadyEvent) => {
			apiRef.current = event.api;
			setReadyApi(event.api);
			onReady?.(event.api);
		},
		[apiRef, onReady],
	);

	const handleDidDrop = useCallback(
		(event: DockviewDidDropEvent) => {
			const api = apiRef.current;
			if (!api) return;
			onDidDrop?.(event, api);
		},
		[apiRef, onDidDrop],
	);

	// Resolve from the RELEASE coordinates, using exactly the preview geometry.
	const handleWillDrop = useCallback(
		(event: DockviewWillDropEvent) => {
			setNativeIndicator(null);
			const api = apiRef.current;
			if (!api) return;
			dropNativePanel(api, event, thresholds, enableSwapZone);
		},
		[apiRef, enableSwapZone, thresholds],
	);

	const handleDropSubject = useCallback(
		(state: PanelDragState, target: DockviewDropTarget) => {
			const api = apiRef.current;
			if (!api) return;
			onDropSubject?.(state, target, api);
		},
		[apiRef, onDropSubject],
	);

	const { dropIndicator: customIndicator } = useDockviewDnd({
		apiRef,
		rootRef,
		onDropSubject: onDropSubject ? handleDropSubject : undefined,
		thresholds,
		surfaceId,
	});

	const dropIndicator = nativeIndicator ?? customIndicator;
	const surfaceClass = [themeless ? "" : DOCKVIEW_THEME_CLASS, className].filter(Boolean).join(" ");

	return (
		<DockviewSurfaceIdContext.Provider value={surfaceId}>
			<Box
				ref={rootRef}
				// Lets a drop identify the topmost SURFACE under the pointer while
				// ignoring unrelated layers such as a drag ghost (see isTopmostSurface).
				{...{ [DOCKVIEW_SURFACE_ATTR]: surfaceId ?? "" }}
				style={{ height: "100%", width: "100%", position: "relative" }}
			>
				<DockviewReact
					className={surfaceClass || undefined}
					// Supply our own theme so dockview stamps OUR class on the internal
					// shell instead of defaulting to the dark `abyss` theme (which would
					// shadow our CSS variables from inside the wrapper). Skipped when the
					// caller opts out of theming.
					theme={themeless ? undefined : NARRAFORK_DOCKVIEW_THEME}
					components={components}
					tabComponents={wrappedTabs}
					// dockview-core's vanilla default tab only closes on the close-button
					// click; dockview-react's DockviewDefaultTab additionally closes on a
					// middle-click (mouse button 1) and honours `hideClose`. Registering it
					// as the default gives every ordinary panel middle-click-to-close, while
					// panels that opt into a custom `tabComponent` (e.g. the close-less chat
					// protagonist on the single-narrator page) retain their own interactions.
					// Both paths share the context menu through stable renderer wrappers.
					defaultTabComponent={DefaultSurfaceTab}
					onReady={handleReady}
					onDidDrop={handleDidDrop}
					onWillDrop={handleWillDrop}
					defaultRenderer={defaultRenderer}
					floatingGroupBounds={floatingGroupBounds}
				/>
				{dropIndicator && (
					<Box
						data-dockview-drop-intent={dropIndicator.variant}
						style={{
							position: "absolute",
							left: dropIndicator.left,
							top: dropIndicator.top,
							width: dropIndicator.width,
							height: dropIndicator.height,
							backgroundColor:
								dropIndicator.variant === "swap"
									? "color-mix(in srgb, var(--mantine-color-teal-8) 35%, transparent)"
									: "color-mix(in srgb, var(--mantine-color-indigo-9) 25%, transparent)",
							display: "flex",
							alignItems: "center",
							justifyContent: "center",
							border:
								dropIndicator.variant === "swap"
									? "2px dashed var(--mantine-color-teal-4)"
									: undefined,
							borderRadius: 4,
							pointerEvents: "none",
							transition: "all 80ms ease",
							zIndex: 5,
						}}
					>
						{dropIndicator.variant === "swap" && (
							<IconSwitchHorizontal
								size={28}
								stroke={2}
								color="var(--mantine-color-teal-2)"
								style={{ maxWidth: "60%", maxHeight: "60%" }}
								aria-hidden="true"
							/>
						)}
					</Box>
				)}
			</Box>
		</DockviewSurfaceIdContext.Provider>
	);
}
