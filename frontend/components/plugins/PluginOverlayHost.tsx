/**
 * Hosts `surfaces: ["overlay"]` views in a transparent layer above the app shell.
 *
 * WHY THIS EXISTS
 * A dock panel is a rectangle inside the layout: no plugin CSS or script can draw
 * outside it, and a sandboxed iframe cannot reach the host document at all. So a
 * view whose whole purpose is to sit *over* the application — a desktop pet is the
 * motivating case — has nowhere to live without a host-owned layer. This is that
 * layer, and it is the only reason `overlay` exists as a surface.
 *
 * THE POINTER PROBLEM, AND WHY THERE IS A HIT REGION
 * The iframe covers the whole viewport (the view needs a stable coordinate space to
 * draw in), so if it accepted pointer events it would swallow every click on the app
 * beneath it. Making it `pointer-events: none` fixes that but also means nothing
 * inside it can be clicked — an iframe that declines the pointer never delivers the
 * event to its own document either.
 *
 * So interaction is split: the iframe stays click-through, and the view announces
 * one rectangle where it *does* want input (`overlay.setBounds`). A transparent hit
 * region is rendered exactly there and relays pointer positions into the iframe as
 * `overlay.pointer` notifications. `setPointerCapture` on the hit region keeps a
 * gesture alive once the pointer leaves the rectangle, which is what lets a view
 * implement its own drag without the host resizing anything mid-gesture.
 *
 * FAILURE BEHAVIOUR
 * Without bounds the overlay is decorative. Bounds can cover the viewport, so a
 * host-owned dismiss button always sits above every overlay. Recovery never relies
 * on a plugin responding, or on arbitrary size limits that penalize other widgets.
 */

import { Button } from "@mantine/core";
import {
	type PointerEvent as ReactPointerEvent,
	useCallback,
	useEffect,
	useMemo,
	useRef,
	useState,
	useSyncExternalStore,
} from "react";
import { createPortal } from "react-dom";
import { useTranslation } from "react-i18next";
import { buildPluginDockPanelParams } from "./PluginContributionPicker";
import { pluginContributionStore } from "./PluginContributionStore";
import { type PluginDockPanelHostApi, PluginDockPanelView } from "./PluginDockPanel";
import { PluginUiSurfaceProvider } from "./PluginUiSurfaceContext";
import { type PluginOverlayBounds, pluginOverlayBoundsStore } from "./plugin-overlay-bounds";
import { useOptionalPluginUiRuntime } from "./plugin-ui-runtime-context";
import { syncPluginUiContributions } from "./registry";
import type { PluginContributionRecord } from "./types";

/**
 * Layer height.
 *
 * Above the app shell (Mantine's `app: 100`) so the overlay is visible at all, and
 * below `modal: 200` / `popover: 300` so dialogs and menus still cover it — an
 * overlay that blocked a confirmation dialog would be worse than no overlay.
 */
const OVERLAY_Z_INDEX = 150;

function overlayInstanceId(contribution: PluginContributionRecord): string {
	return `overlay:${contribution.pluginId}:${contribution.contributionId}`;
}

/** Overlay views that should currently be mounted. */
function selectOverlayContributions(
	contributions: Readonly<Record<string, PluginContributionRecord>>,
): PluginContributionRecord[] {
	return (
		Object.values(contributions)
			.filter((contribution) => contribution.surfaces?.includes("overlay") ?? false)
			// One overlay layer per app instance, so only global scope can bind to it.
			.filter((contribution) => (contribution.scope ?? "global") === "global")
			// A disabled/denied plugin must not leave an invisible full-viewport layer
			// behind; `PluginDockPanelView`'s placeholder is a panel affordance and would
			// paint a box over the app here.
			.filter((contribution) => contribution.availability === "available")
			.sort((left, right) =>
				`${left.pluginId}:${left.contributionId}`.localeCompare(
					`${right.pluginId}:${right.contributionId}`,
				),
			)
	);
}

export function PluginOverlayHost() {
	const { t } = useTranslation("plugins");
	const [hidden, setHidden] = useState(false);
	const runtime = useOptionalPluginUiRuntime();
	const contributionSnapshot = useSyncExternalStore(
		pluginContributionStore.subscribe,
		pluginContributionStore.getSnapshot,
		pluginContributionStore.getSnapshot,
	);
	const boundsSnapshot = useSyncExternalStore(
		pluginOverlayBoundsStore.subscribe,
		pluginOverlayBoundsStore.getSnapshot,
		pluginOverlayBoundsStore.getSnapshot,
	);

	// A cold open can land before the app-level sync has run (same reason the
	// settings-surface panel does this).
	useEffect(() => {
		if (contributionSnapshot.status === "idle") {
			void syncPluginUiContributions().catch(() => {});
		}
	}, [contributionSnapshot.status]);

	const overlays = useMemo(
		() => selectOverlayContributions(contributionSnapshot.contributions),
		[contributionSnapshot.contributions],
	);

	useEffect(() => {
		const resize = () =>
			pluginOverlayBoundsStore.clipToViewport(window.innerWidth, window.innerHeight);
		window.addEventListener("resize", resize);
		return () => window.removeEventListener("resize", resize);
	}, []);

	// An additional cold-start escape hatch, independent of the mounted UI.
	const disabled =
		typeof window !== "undefined" &&
		new URLSearchParams(window.location.search).get("nfNoOverlay") === "1";
	if (disabled || hidden) return null;

	if (!runtime || overlays.length === 0) return null;

	// Portal both the layers and their escape hatch together: ancestor transforms or
	// stacking contexts must not place a plugin above the host's dismiss control.
	return createPortal(
		<>
			{overlays.map((contribution) => {
				const instanceId = overlayInstanceId(contribution);
				return (
					<PluginOverlayLayer
						key={instanceId}
						contribution={contribution}
						panelInstanceId={instanceId}
						bounds={
							runtime.getSessionSnapshot(instanceId)?.status === "ready"
								? boundsSnapshot[instanceId]
								: undefined
						}
					/>
				);
			})}
			<Button
				data-plugin-overlay-dismiss=""
				size="compact-xs"
				onClick={() => {
					setHidden(true);
					for (const contribution of overlays) {
						const id = overlayInstanceId(contribution);
						pluginOverlayBoundsStore.clear(id);
						runtime.disposeSession(id);
					}
				}}
				style={{
					position: "fixed",
					right: "max(12px, env(safe-area-inset-right))",
					bottom: "max(12px, env(safe-area-inset-bottom))",
					zIndex: OVERLAY_Z_INDEX + 1,
				}}
			>
				{t("hideOverlays")}
			</Button>
		</>,
		document.body,
	);
}

function PluginOverlayLayer({
	contribution,
	panelInstanceId,
	bounds,
}: {
	contribution: PluginContributionRecord;
	panelInstanceId: string;
	bounds: PluginOverlayBounds | undefined;
}) {
	const runtime = useOptionalPluginUiRuntime();
	const [title, setTitle] = useState<string | undefined>(undefined);

	const params = useMemo(
		() =>
			buildPluginDockPanelParams({
				pluginId: contribution.pluginId,
				contributionId: contribution.contributionId,
				panelInstanceId,
				binding: { kind: "host-surface", surface: "overlay" },
			}),
		[contribution.pluginId, contribution.contributionId, panelInstanceId],
	);

	// The overlay has no dock chrome and no user-reachable panel API: a plugin cannot
	// resize or close the layer itself, only ask for its interactive rectangle.
	const hostApi = useMemo<PluginDockPanelHostApi>(
		() => ({
			title,
			isActive: true,
			setTitle,
			updateParameters: () => {},
			setActive: () => {},
			close: () => {},
		}),
		[title],
	);

	const sendPointer = useCallback(
		(type: "down" | "move" | "up" | "cancel", event: ReactPointerEvent<HTMLDivElement>) => {
			// `sendNotification` is optional on the controller interface: a session that has
			// not finished its handshake cannot deliver anything, and the concrete class
			// drops these silently until then. Optional-calling keeps that contract honest.
			runtime?.getSessionController(panelInstanceId)?.sendNotification?.("overlay.pointer", {
				type,
				// Viewport coordinates: the plugin draws in the same space, so it never has
				// to translate between the hit region and its own canvas.
				x: event.clientX,
				y: event.clientY,
				pointerId: event.pointerId,
				buttons: event.buttons,
			});
		},
		[runtime, panelInstanceId],
	);

	const capturedPointer = useRef<number | null>(null);
	useEffect(() => {
		if (!bounds) capturedPointer.current = null;
	}, [bounds]);

	return (
		<div
			data-plugin-overlay={panelInstanceId}
			data-nf-overlay-layer=""
			style={{
				position: "fixed",
				inset: 0,
				zIndex: OVERLAY_Z_INDEX,
				// The layer itself never takes input; only the hit region below does.
				pointerEvents: "none",
				background: "transparent",
				// No text, no selection, no caret: a drag across the layer must not leave the
				// document's insertion point blinking behind the pet.
				userSelect: "none",
				caretColor: "transparent",
			}}
		>
			{/*
			 * Absolutely positioned, never left to content height.
			 *
			 * The view asks for `h="100%"` and the iframe for `height: 100%`; against an
			 * auto-height parent both resolve to `auto`, and an iframe with `auto` height
			 * falls back to the HTML default of 150px. The overlay then collapses into a
			 * short strip at the top of the window, and the view is told that strip is its
			 * whole viewport. `inset: 0` against the fixed layer gives the chain a definite
			 * height, so the frame really covers the viewport — the coordinate space
			 * `overlay.setBounds` is expressed in.
			 */}
			<div style={{ position: "absolute", inset: 0 }}>
				<PluginUiSurfaceProvider hostContext={{ surface: "overlay" }}>
					<PluginDockPanelView rawParams={params} hostApi={hostApi} passthrough />
				</PluginUiSurfaceProvider>
			</div>
			{bounds ? (
				// biome-ignore lint/a11y/noStaticElementInteractions: Pointer-only decoration; the host dismiss button is keyboard accessible. Forms belong in dock panels.
				<div
					data-plugin-overlay-hit={panelInstanceId}
					role="presentation"
					onPointerDown={(event) => {
						// Only the primary button drags.
						if (event.button !== 0 || !event.isPrimary || capturedPointer.current !== null) return;
						capturedPointer.current = event.pointerId;
						// Suppress the browser's own gesture handling, which otherwise starts a
						// text selection on the document underneath and leaves a blinking
						// caret somewhere in the app while the pet is being dragged.
						event.preventDefault();
						// Capture so a gesture survives the pointer leaving the rectangle:
						// the region only covers what the view last reported, and the view may
						// deliberately lag its reports to save round trips.
						try {
							event.currentTarget.setPointerCapture(event.pointerId);
						} catch {
							/* capture unsupported: dragging still works inside the region */
						}
						sendPointer("down", event);
					}}
					onContextMenu={(event) => {
						// The view has no menu of its own on this surface (a click-through frame
						// cannot show one), so right-click should do nothing at all rather than
						// pop the browser's menu over the app.
						event.preventDefault();
					}}
					onPointerMove={(event) => {
						if (capturedPointer.current !== event.pointerId) return;
						sendPointer("move", event);
					}}
					onPointerUp={(event) => {
						if (capturedPointer.current !== event.pointerId) return;
						capturedPointer.current = null;
						sendPointer("up", event);
						try {
							event.currentTarget.releasePointerCapture(event.pointerId);
						} catch {
							/* never captured */
						}
					}}
					onLostPointerCapture={(event) => {
						if (capturedPointer.current !== event.pointerId) return;
						capturedPointer.current = null;
						sendPointer("cancel", event);
					}}
					onPointerCancel={(event) => {
						if (capturedPointer.current !== event.pointerId) return;
						capturedPointer.current = null;
						sendPointer("cancel", event);
					}}
					style={{
						position: "absolute",
						left: bounds.x,
						top: bounds.y,
						width: bounds.width,
						height: bounds.height,
						pointerEvents: "auto",
						background: "transparent",
						// No cursor opinion: the view draws its own affordance, and a host that
						// guessed "grab" would be wrong for every other kind of overlay.
						touchAction: "none",
						userSelect: "none",
						caretColor: "transparent",
					}}
				/>
			) : null}
		</div>
	);
}
