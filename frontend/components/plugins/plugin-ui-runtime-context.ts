/**
 * The plugin UI runtime's context, consumer hooks and fallback context envelope, split out
 * of `PluginUiRuntimeProvider.tsx`.
 *
 * WHY THE SPLIT
 * ------------
 * `@vitejs/plugin-react` only treats a module as a VALID Fast Refresh boundary when every
 * export is a component. `usePluginUiRuntime`, `useOptionalPluginUiRuntime` and
 * `fallbackPluginUiContext` are not components, so keeping them beside the provider made
 * the module an invalid boundary. The provider is mounted in `App.tsx`, which put that
 * invalidation directly on the app shell's propagation path and turned shell edits into
 * full page reloads. Same shape as `image-viewer-context.ts` and `confirm-dialog-context.ts`.
 *
 * The context stays registry-keyed (`createSharedContext`) for the separate reason
 * documented below: identity must survive re-evaluation, whichever module holds it.
 */

import { createSharedContext } from "@frontend/lib/shared-context";
import { useContext } from "react";
import type { PluginUiSessionContext } from "./PluginUiSurfaceContext";
import type { PluginDockPanelParams } from "./protocol";
import type { PluginUiSession } from "./runtime";
import type { MaterializedPluginUiSession } from "./session-client";
import type {
	PluginUiContext,
	PluginUiContribution,
	PluginUiRuntimeApi,
	PluginUiSessionSnapshot,
} from "./types";

/*
 * `SlotRecord` / `SessionRecord` moved here VERBATIM from the provider, rather than being
 * re-described with a narrower shape. A hand-written "public view" of them would silently
 * drop fields the provider actually stores, and the two definitions would then be free to
 * drift apart with nothing to detect it.
 */

export interface SlotRecord {
	element: HTMLElement;
	priority: number;
	visible: boolean;
	active: boolean;
	rect: { left: number; top: number; width: number; height: number };
}

export interface SessionRecord {
	params: PluginDockPanelParams;
	sessionContext: PluginUiSessionContext;
	contribution: PluginUiContribution;
	materialized?: MaterializedPluginUiSession;
	controller?: PluginUiSession;
	snapshot: PluginUiSessionSnapshot;
	/** Monotonic rebuild counter; bumps on every session rebuild so stale async completions are dropped. */
	requestGeneration: number;
	/** Backend rebuild attempts for the current identity. Session-401 auto-recovery is allowed exactly once. */
	rebuildAttempts: number;
	abortController: AbortController;
	revoked: boolean;
}

export interface RuntimeContextValue extends PluginUiRuntimeApi {
	getSessions: () => SessionRecord[];
	getSlots: (panelInstanceId: string) => SlotRecord[];
}

/**
 * Registry-keyed: the provider is mounted once by the app shell while consumers live
 * in lazily-loaded dock panels, so a Fast Refresh re-evaluation (or a duplicated
 * production chunk) would otherwise split them across two context objects and
 * surface as "PluginUiRuntimeProvider is required". See `lib/shared-context.ts`.
 */
export const RuntimeContext = createSharedContext<RuntimeContextValue | null>(
	"plugins/PluginUiRuntimeProvider",
	null,
);

export function usePluginUiRuntime(): RuntimeContextValue {
	const value = useContext(RuntimeContext);
	if (!value) throw new Error("PluginUiRuntimeProvider is required");
	return value;
}

export function useOptionalPluginUiRuntime(): RuntimeContextValue | null {
	return useContext(RuntimeContext);
}

/**
 * Last-resort context when the app shell did not wire `getContext`. Mirrors the
 * backend PluginUiHost.context shape (which still reports host fields as
 * "unknown") so plugins always see the same envelope.
 */
export function fallbackPluginUiContext(
	params: PluginDockPanelParams,
	sessionContext: PluginUiSessionContext,
	contribution: PluginUiContribution,
): PluginUiContext {
	return {
		contextVersion: 1,
		host: {
			appVersion: "unknown",
			locale: "unknown",
			colorScheme: "dark",
			platform: "unknown",
		},
		plugin: {
			id: params.pluginId,
			version: contribution.version || "unknown",
			contributionId: params.contributionId,
			panelInstanceId: params.panelInstanceId,
		},
		surface: {
			// `graph` (a chapter node's embedded dock) reports as `narrator-focus`
			// rather than introducing a new wire value: both host exactly one
			// narrator, and an unrecognized `kind` would break already-published
			// plugins. A node's smaller viewport is something the iframe observes
			// through its own size, not through a distinct surface kind.
			kind:
				sessionContext.surface === "focus" || sessionContext.surface === "graph"
					? "narrator-focus"
					: sessionContext.surface === "settings"
						? "settings"
						: sessionContext.surface,
			active: true,
			visible: true,
		},
		...(sessionContext.narratorId
			? {
					narrator: {
						id: sessionContext.narratorId,
						chapterId: sessionContext.chapterId,
						projectId: sessionContext.projectId,
					},
				}
			: {}),
		...(sessionContext.projectId ? { project: { id: sessionContext.projectId } } : {}),
		...(sessionContext.workspaceId
			? {
					workspace: {
						id: sessionContext.workspaceId,
						ownerNarratorId: sessionContext.narratorId,
						presentation: sessionContext.presentation ?? "grid",
					},
				}
			: {}),
		route: { routeId: "plugin-ui" },
	};
}
