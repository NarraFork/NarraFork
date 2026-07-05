/**
 * Dockview-backed workspace surface.
 *
 * Composes the reusable <DockviewSurface> (theme + single-tab hiding +
 * swap/merge/split drag semantics) and layers on the workspace-specific
 * concerns: layout persistence via the versioned envelope in
 * `dockview-layout.ts`, legacy split-tree migration, sidebar drag-and-drop
 * bridging, narrator join/leave lifecycle, and director (maximize) mode.
 */

import { type DockviewApi, type DockviewDidDropEvent, positionToDirection } from "dockview-react";
import { useCallback, useEffect, useRef } from "react";
import { api as apiClient } from "../../../lib/api";
import type { PanelDragState } from "../../../lib/panel-drag";
import {
	type DockviewDropTarget,
	DockviewSurface,
	intentToDirection,
	intentToPosition,
} from "../../dockview";
import { applyDirectorMode } from "./director";
import { consumeWorkspaceDropPayload, WORKSPACE_DND_MIME } from "./dnd-bridge";
import {
	applyResolvedLayout,
	collectNarratorIdsFromTree,
	componentForParams,
	drainPendingPanels,
	onPendingPanel,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	type WorkspaceDirectorState,
} from "./dockview-layout";
import { type WorkspacePanelParams, workspacePanelComponents } from "./panels";

const SAVE_DEBOUNCE_MS = 500;

interface DockviewWorkspaceProps {
	workspaceId: string;
	/** Raw `workspaces.tree` string from the server (envelope or legacy). */
	treeJson: string | null | undefined;
	/** Server updatedAt (ms) used to detect fresh refetches. */
	serverUpdatedAt: number | undefined;
	/** Notify parent when the live narrator id set changes (for recent-tab sync). */
	onNarratorIdsChange?: (ids: string[]) => void;
	/** Called once the DockviewApi is ready. */
	onApiReady?: (api: DockviewApi) => void;
	/** Director state changes (mode / primary panel) for toolbar reflection. */
	onDirectorStateChange?: (state: WorkspaceDirectorState) => void;
}

/** Extract the live narrator ids from the current Dockview layout. */
function collectLiveNarratorIds(api: DockviewApi): string[] {
	const ids: string[] = [];
	for (const panel of api.panels) {
		const params = panel.params as WorkspacePanelParams | undefined;
		if (params?.panelType === "narrator" && params.narratorId) ids.push(params.narratorId);
	}
	return ids;
}

export function DockviewWorkspace({
	workspaceId,
	treeJson,
	serverUpdatedAt,
	onNarratorIdsChange,
	onApiReady,
	onDirectorStateChange,
}: DockviewWorkspaceProps) {
	const apiRef = useRef<DockviewApi | null>(null);
	const apiDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const directorRef = useRef<WorkspaceDirectorState>({ mode: "grid", primaryPanelId: null });
	const localEditRef = useRef(false);
	const loadedAtRef = useRef<number | null>(null);
	/** Narrator ids we have joined (via panels) and must leave on unmount. */
	const joinedNarratorIdsRef = useRef<Set<string>>(new Set());

	// Keep latest treeJson without forcing effect re-runs on every keystroke.
	const treeJsonRef = useRef(treeJson);
	treeJsonRef.current = treeJson;

	const persist = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
		saveTimerRef.current = setTimeout(() => {
			const serialized = serializeWorkspaceLayout(api, directorRef.current);
			apiClient.updateWorkspace(workspaceId, { tree: serialized }).catch(() => {});
		}, SAVE_DEBOUNCE_MS);
	}, [workspaceId]);

	const syncNarratorIds = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		const ids = collectLiveNarratorIds(api);
		onNarratorIdsChange?.(ids);
		joinedNarratorIdsRef.current = new Set(ids);
	}, [onNarratorIdsChange]);

	/** Add any panels queued for this workspace (sidebar handoff). */
	const drainPendingPanelsInto = useCallback(
		(api: DockviewApi) => {
			for (const params of drainPendingPanels(workspaceId)) {
				// Skip if a narrator panel already exists for this id.
				if (params.panelType === "narrator") {
					const existing = api.panels.find((p) => {
						const pp = p.params as WorkspacePanelParams | undefined;
						return pp?.panelType === "narrator" && pp.narratorId === params.narratorId;
					});
					if (existing) {
						existing.api.setActive();
						continue;
					}
				}
				const id =
					params.panelType === "narrator" ? params.narratorId : `dvp_${Date.now().toString(36)}`;
				api.addPanel({ id, component: componentForParams(params), params });
			}
		},
		[workspaceId],
	);

	// ── Ready: restore layout, wire events ──
	const handleReady = useCallback(
		(api: DockviewApi) => {
			apiRef.current = api;

			const resolved = resolveWorkspaceLayout(treeJsonRef.current);
			directorRef.current = resolved.director;
			try {
				applyResolvedLayout(api, resolved);
			} catch {
				// If restore fails, fall back to migrating legacy content fresh.
				const fallback = resolveWorkspaceLayout(null);
				applyResolvedLayout(api, fallback);
			}
			loadedAtRef.current = serverUpdatedAt ?? null;

			// Add any panels queued by the sidebar (e.g. "+ add narrator") that
			// arrived before this instance mounted.
			drainPendingPanelsInto(api);

			// Restore director mode after layout is in place.
			if (resolved.director.mode === "director") {
				applyDirectorMode(api, resolved.director);
			}
			onDirectorStateChange?.(directorRef.current);
			syncNarratorIds();
			onApiReady?.(api);

			// Persist on any structural layout change (debounced).
			const disposables = [
				api.onDidLayoutChange(() => {
					localEditRef.current = true;
					persist();
					syncNarratorIds();
				}),
				api.onDidAddPanel(() => syncNarratorIds()),
				api.onDidRemovePanel(() => {
					syncNarratorIds();
					// Closing the last panel dissolves the workspace navigation-wise;
					// the parent route handles redirecting when panels hit zero.
				}),
				// Accept our own native sidebar payload if it surfaces via HTML5 DnD.
				api.onUnhandledDragOver((e) => {
					const dt = "dataTransfer" in e.nativeEvent ? e.nativeEvent.dataTransfer : null;
					if (dt?.types.includes(WORKSPACE_DND_MIME)) e.accept();
				}),
			];
			apiDisposablesRef.current = disposables;
		},
		[
			persist,
			serverUpdatedAt,
			syncNarratorIds,
			onApiReady,
			onDirectorStateChange,
			drainPendingPanelsInto,
		],
	);

	// ── External drop from sidebar (native HTML5 payload) ──
	const handleDidDrop = useCallback((event: DockviewDidDropEvent, api: DockviewApi) => {
		const payload = consumeWorkspaceDropPayload(event.nativeEvent);
		if (!payload) return;

		const params = payload.params;
		const id = payload.id ?? `dvp_${Date.now().toString(36)}`;

		// If a panel for this narrator already exists, just focus it.
		if (params.panelType === "narrator") {
			const existing = api.panels.find((p) => {
				const pp = p.params as WorkspacePanelParams | undefined;
				return pp?.panelType === "narrator" && pp.narratorId === params.narratorId;
			});
			if (existing) {
				existing.api.setActive();
				return;
			}
		}

		api.addPanel({
			id,
			component: componentForParams(params),
			title: payload.title,
			params,
			position: {
				direction: positionToDirection(event.position),
				referenceGroup: event.group ?? undefined,
			},
		});
	}, []);

	// ── Sidebar recent-tab drop (panel-drag singleton) ──
	// Existing panels are handled generically by DockviewSurface; here we only
	// materialise a recent-tab narrator that has no live panel yet.
	const handleDropSubject = useCallback(
		(drag: PanelDragState, target: DockviewDropTarget, api: DockviewApi) => {
			const narratorId = drag.id;
			if (!narratorId || narratorId === "__terminal__" || narratorId === "__webview__") return;
			const group = api.groups.find((g) => g.id === target.groupId);
			if (!group) return;

			// A sidebar narrator has no live panel to swap; treat swap as merge.
			const position = target.intent === "swap" ? "center" : intentToPosition(target.intent);
			const direction = target.intent === "swap" ? "within" : intentToDirection(target.intent);

			// Already open? move it to the target instead of duplicating.
			const existing = api.panels.find((p) => {
				const pp = p.params as WorkspacePanelParams | undefined;
				return pp?.panelType === "narrator" && pp.narratorId === narratorId;
			});
			if (existing) {
				existing.api.moveTo({ group, position });
				existing.api.setActive();
				return;
			}

			api.addPanel({
				id: narratorId,
				component: componentForParams({ panelType: "narrator", narratorId }),
				title: drag.title || "Narrator",
				params: { panelType: "narrator", narratorId },
				position: { referenceGroup: group, direction },
			});
		},
		[],
	);

	// Drain pending panels queued while this workspace was already open (the
	// "+ add narrator" button navigates here without remounting).
	useEffect(() => {
		return onPendingPanel(workspaceId, () => {
			const api = apiRef.current;
			if (api) drainPendingPanelsInto(api);
		});
	}, [workspaceId, drainPendingPanelsInto]);

	// ── Cleanup: leave narrators, dispose listeners, flush save ──
	useEffect(() => {
		return () => {
			if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
			const api = apiRef.current;
			if (api) {
				// Flush a final save synchronously via the client (best-effort).
				try {
					const serialized = serializeWorkspaceLayout(api, directorRef.current);
					apiClient.updateWorkspace(workspaceId, { tree: serialized }).catch(() => {});
				} catch {
					// ignore
				}
				for (const d of apiDisposablesRef.current) d.dispose();
				apiDisposablesRef.current = [];
			}
			// Leave all narrators we joined via panels.
			const ids = new Set(joinedNarratorIdsRef.current);
			for (const nId of collectNarratorIdsFromTree(treeJsonRef.current)) ids.add(nId);
			for (const nId of ids) apiClient.leaveNarrator(nId).catch(() => {});
		};
	}, [workspaceId]);

	return (
		<DockviewSurface
			apiRef={apiRef}
			components={workspacePanelComponents}
			onReady={handleReady}
			onDidDrop={handleDidDrop}
			onDropSubject={handleDropSubject}
			// Preserve panel component instances (live narrator sessions, terminals,
			// webviews) when panels are dragged/rearranged across groups.
			defaultRenderer="always"
		/>
	);
}
