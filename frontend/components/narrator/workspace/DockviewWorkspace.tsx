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
import { type RefObject, useCallback, useEffect, useRef } from "react";
import { api as apiClient } from "../../../lib/api";
import { isNarratorSubject, type PanelDragState } from "../../../lib/panel-drag";
import {
	type DockviewDropTarget,
	DockviewSurface,
	intentToDirection,
	intentToPosition,
} from "../../dockview";
import { type DirectorLeaf, isDirectorRenderablePanel } from "./director-constants";
import { consumeWorkspaceDropPayload, WORKSPACE_DND_MIME } from "./dnd-bridge";
import {
	applyResolvedLayout,
	collectNarratorIdsFromTree,
	componentForParams,
	DEFAULT_DIRECTOR_STATE,
	drainPendingPanels,
	nextWorkspacePanelId,
	onPendingPanel,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	type WorkspaceDirectorState,
} from "./dockview-layout";
import { type WorkspacePanelParams, workspacePanelComponents } from "./panels";
import { createWorkspaceDockStore, WorkspaceDockProvider } from "./workspace-dock";

const SAVE_DEBOUNCE_MS = 500;

/**
 * Imperative handle for driving director mode from outside the workspace.
 *
 * All mutations flow through here so the persisted `director` state (mode /
 * primary panel / ratio) stays in sync with what the director overlay shows.
 * `closePanel` is the only one that actually removes a dockview panel.
 */
export interface DirectorControl {
	setMode: (mode: "grid" | "director") => void;
	/** Promote a panel to primary in director mode. */
	setPrimary: (panelId: string) => void;
	/** Persist the primary/rail ratio. */
	setRatio: (ratio: number) => void;
	/** Open a child session in its host narrator's secondary area and return to grid mode. */
	openSubagentPanel: (hostNarratorId: string, subagentNarratorId: string) => void;
	/** Close a dockview panel by id (goes through dockview's normal removal). */
	closePanel: (panelId: string) => void;
	/** Update a dockview panel's params (e.g. edited webview/plugin state). */
	updatePanelParams: (panelId: string, params: WorkspacePanelParams) => void;
	/** Update a dockview panel title while Director owns the visible chrome. */
	updatePanelTitle: (panelId: string, title: string) => void;
}

interface DockviewWorkspaceProps {
	workspaceId: string;
	/** Raw `workspaces.tree` string from the server (envelope or legacy). */
	treeJson: string | null | undefined;
	/** Server updatedAt (ms) used to detect fresh refetches. */
	serverUpdatedAt: number | undefined;
	/** Notify parent when the live narrator id set changes (for recent-tab sync). */
	onNarratorIdsChange?: (ids: string[]) => void;
	/** Notify parent of the live panel list (for the director overlay). */
	onPanelsChange?: (leaves: DirectorLeaf[]) => void;
	/** Called once the DockviewApi is ready. */
	onApiReady?: (api: DockviewApi) => void;
	/** Director state changes (mode / primary panel / ratio) for toolbar + overlay. */
	onDirectorStateChange?: (state: WorkspaceDirectorState) => void;
	/**
	 * Imperative handle to drive director mode. Mutations here keep the internal
	 * `directorRef` and layout persistence in sync; director mode is a pure
	 * overlay and never mutates the dockview layout (except `closePanel`).
	 */
	directorControlRef?: RefObject<DirectorControl | null>;
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

/** Snapshot the live panels as director leaves (id + params + title). */
function collectPanels(api: DockviewApi): DirectorLeaf[] {
	const leaves: DirectorLeaf[] = [];
	for (const panel of api.panels) {
		const params = panel.params as WorkspacePanelParams | undefined;
		if (!params) continue;
		// Cluster secondary panels are resources, not top-level director cells.
		if (!isDirectorRenderablePanel(params)) continue;
		leaves.push({ id: panel.api.id, params, title: panel.api.title ?? "" });
	}
	return leaves;
}

export function DockviewWorkspace({
	workspaceId,
	treeJson,
	serverUpdatedAt,
	onNarratorIdsChange,
	onPanelsChange,
	onApiReady,
	onDirectorStateChange,
	directorControlRef,
}: DockviewWorkspaceProps) {
	const apiRef = useRef<DockviewApi | null>(null);
	// Per-workspace dock store (shards tool-panel coordination by narratorId).
	// Created once, bound to this surface's api ref.
	const dockStoreRef = useRef<ReturnType<typeof createWorkspaceDockStore> | null>(null);
	if (!dockStoreRef.current) dockStoreRef.current = createWorkspaceDockStore(apiRef);
	const apiDisposablesRef = useRef<Array<{ dispose(): void }>>([]);
	const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const directorRef = useRef<WorkspaceDirectorState>({ ...DEFAULT_DIRECTOR_STATE });
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

	// ── Director mode (pure overlay; never mutates the dockview layout) ──
	// All director mutations flow through the imperative handle so the persisted
	// `director` state stays in sync. Entering/leaving director mode and picking
	// a primary panel do NOT add/remove dockview panels, so they never trigger
	// the "workspace empty → navigate away" path (only closePanel can).
	const commitDirector = useCallback(
		(next: WorkspaceDirectorState) => {
			directorRef.current = next;
			// Tell the dock store so the underlying panel adapters unmount their
			// content while the director overlay hosts the live instances.
			dockStoreRef.current?.setDirectorActive(next.mode === "director");
			onDirectorStateChange?.(directorRef.current);
			persist();
		},
		[persist, onDirectorStateChange],
	);

	const setMode = useCallback(
		(mode: "grid" | "director") => {
			const api = apiRef.current;
			const primaryPanelId =
				mode === "director"
					? (directorRef.current.primaryPanelId ?? api?.activePanel?.id ?? null)
					: directorRef.current.primaryPanelId;
			commitDirector({ ...directorRef.current, mode, primaryPanelId });
		},
		[commitDirector],
	);

	const setPrimary = useCallback(
		(panelId: string) => {
			commitDirector({ ...directorRef.current, primaryPanelId: panelId });
		},
		[commitDirector],
	);

	const setRatio = useCallback(
		(ratio: number) => {
			commitDirector({ ...directorRef.current, primaryRatio: ratio });
		},
		[commitDirector],
	);

	const openSubagentPanel = useCallback(
		(hostNarratorId: string, subagentNarratorId: string) => {
			dockStoreRef.current?.openSubagentPanel(hostNarratorId, subagentNarratorId);
			setMode("grid");
		},
		[setMode],
	);

	const closePanel = useCallback((panelId: string) => {
		apiRef.current?.getPanel(panelId)?.api.close();
	}, []);

	const updatePanelParams = useCallback((panelId: string, params: WorkspacePanelParams) => {
		apiRef.current?.getPanel(panelId)?.api.updateParameters(params);
	}, []);

	const updatePanelTitle = useCallback((panelId: string, title: string) => {
		apiRef.current?.getPanel(panelId)?.api.setTitle(title);
	}, []);

	useEffect(() => {
		if (!directorControlRef) return;
		directorControlRef.current = {
			setMode,
			setPrimary,
			setRatio,
			openSubagentPanel,
			closePanel,
			updatePanelParams,
			updatePanelTitle,
		};
		return () => {
			directorControlRef.current = null;
		};
	}, [
		directorControlRef,
		setMode,
		setPrimary,
		setRatio,
		openSubagentPanel,
		closePanel,
		updatePanelParams,
		updatePanelTitle,
	]);

	const syncNarratorIds = useCallback(() => {
		const api = apiRef.current;
		if (!api) return;
		// Close tool panels whose owning narrator cell is gone and reclaim dead
		// sharded state before recomputing, so orphans don't linger or accumulate.
		dockStoreRef.current?.pruneOrphanedClusters(api);
		// Refresh each narrator's open-tool set so cluster toolbars reflect the
		// live layout (open/close/drag of tool tabs).
		dockStoreRef.current?.refreshOpenToolTypes(api);
		const ids = collectLiveNarratorIds(api);
		onNarratorIdsChange?.(ids);
		onPanelsChange?.(collectPanels(api));
		joinedNarratorIdsRef.current = new Set(ids);
	}, [onNarratorIdsChange, onPanelsChange]);

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
				const id = params.panelType === "narrator" ? params.narratorId : nextWorkspacePanelId();
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
			// Seed the store's director flag from the restored state so underlying
			// panels start unmounted when a workspace reopens in director mode.
			dockStoreRef.current?.setDirectorActive(resolved.director.mode === "director");
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

			// Director mode is a pure overlay owned by the route; just report the
			// restored state so the toolbar + overlay reflect it.
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
		const id = payload.id ?? nextWorkspacePanelId();

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
			// Only a real narrator subject can be materialised as a narrator panel;
			// tool/webview panel drags are handled generically by DockviewSurface.
			if (!narratorId || !isNarratorSubject(drag)) return;
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
		<WorkspaceDockProvider store={dockStoreRef.current} workspaceId={workspaceId}>
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
		</WorkspaceDockProvider>
	);
}
