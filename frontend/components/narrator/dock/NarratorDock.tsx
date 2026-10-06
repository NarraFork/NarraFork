/**
 * The unified narrator dockview surface.
 *
 * Renders a single DockviewSurface hosting the chat panel plus any open tool
 * panels (details / files / spec / git / browser / terminal). Layout is
 * persisted per narrator + device in localStorage. Must be rendered inside a
 * NarratorDockProvider (it binds the provider's api ref).
 */

import type { DockviewApi } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import { DockviewSurface, type DropZoneThresholds } from "../../dockview";
import { dockPanelId } from "./dock-panel-types";
import { useNarratorDockContext } from "./NarratorDockContext";
import type { DockDevice } from "./narrator-dock-layout";
import { applyNarratorDockLayout, saveNarratorDockLayout } from "./narrator-dock-layout";
import { narratorDockComponents, narratorDockTabComponents } from "./panels";

const SAVE_DEBOUNCE_MS = 400;

export interface NarratorDockProps {
	device: DockDevice;
	/** Restrict split directions (mobile drawer → vertical only). */
	thresholds?: DropZoneThresholds;
}

/**
 * Bind the dock context's api ref to a DockviewSurface, restore/persist the
 * per-narrator layout, and keep the context's open-tool set in sync.
 */
export function NarratorDock({ device, thresholds }: NarratorDockProps) {
	const dock = useNarratorDockContext();
	if (!dock) {
		throw new Error("NarratorDock must be rendered inside a NarratorDockProvider");
	}
	const { narratorId, apiRef, refreshOpenToolTypes } = dock;
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const disposablesRef = useRef<Array<{ dispose(): void }>>([]);

	/**
	 * Hide the chat group's tab strip while chat is its only panel.
	 *
	 * The chat panel is the surface's protagonist and never needs a tab to
	 * switch away from — tabs belong to the side/tool group. Dockview renders a
	 * tab strip on EVERY group by default (even single-panel ones), so without
	 * this the top of the narrator page shows a stray "Narrator" tab. When the
	 * user merges a tool panel into the chat group (drag-to-tab), the strip
	 * comes back so both tabs stay switchable.
	 *
	 * `hideHeader` is a dockview group option (core `IHeader.hidden`); setting
	 * it live also persists into `toJSON`/`fromJSON`, so restored layouts keep
	 * the rule. Must be re-synced after every layout change: a restored layout
	 * written before this rule (or a drag re-parent) can leave the chat group
	 * header visible.
	 */
	const syncChatGroupHeader = useCallback((api: DockviewApi) => {
		const chat = api.getPanel(dockPanelId("chat"));
		if (!chat) return;
		const group = chat.group;
		// `group.model.header.hidden` is dockview-core's live toggle (sets the
		// strip's display). Only write when it actually changes so we never
		// trigger a layout event from our own sync.
		const hidden = group.model.panels.length === 1;
		if (group.model.header.hidden !== hidden) {
			group.model.header.hidden = hidden;
		}
	}, []);

	const persist = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			saveNarratorDockLayout(api, narratorId, device);
		}, SAVE_DEBOUNCE_MS);
	}, [apiRef, narratorId, device]);

	const handleReady = useCallback(
		(api: import("dockview-react").DockviewApi) => {
			apiRef.current = api;
			applyNarratorDockLayout(api, narratorId, device);
			syncChatGroupHeader(api);
			refreshOpenToolTypes();
			disposablesRef.current = [
				api.onDidLayoutChange(() => {
					persist();
					syncChatGroupHeader(api);
					refreshOpenToolTypes();
				}),
				api.onDidAddPanel(() => {
					syncChatGroupHeader(api);
					refreshOpenToolTypes();
				}),
				api.onDidRemovePanel(() => {
					syncChatGroupHeader(api);
					refreshOpenToolTypes();
				}),
			];
		},
		[apiRef, narratorId, device, persist, refreshOpenToolTypes, syncChatGroupHeader],
	);

	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const api = apiRef.current;
			if (api) saveNarratorDockLayout(api, narratorId, device);
			for (const d of disposablesRef.current) d.dispose();
			disposablesRef.current = [];
		};
	}, [apiRef, narratorId, device]);

	return (
		<DockviewSurface
			apiRef={apiRef}
			components={narratorDockComponents}
			tabComponents={narratorDockTabComponents}
			onReady={handleReady}
			thresholds={thresholds}
			// One surface per narrator page. Stamped onto panel drags so a drop is only
			// treated as an in-surface rearrangement by the surface it started on —
			// panel ids are global, so a graph node's dock must not resolve this page's
			// `ndock-terminal` against its own api (and vice versa).
			surfaceId={`focus:${narratorId}`}
			// Keep every panel's DOM + component instance alive when moved between
			// groups (split / swap / merge), so the chat's live WebSocket session,
			// the terminal (xterm), the spec editor and scroll positions survive a
			// drag-rearrange instead of being torn down and rebuilt.
			defaultRenderer="always"
		/>
	);
}
