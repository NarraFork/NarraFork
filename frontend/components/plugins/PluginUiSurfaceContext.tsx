import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PluginDockPanelParams, PluginHostSurface } from "./protocol";

/**
 * Host surfaces a plugin view may be mounted on.
 *
 * An alias of `PluginHostSurface` rather than a second hand-written union: the binding
 * schema in `protocol.ts` is the value the runtime actually validates against, so a
 * surface added there but forgotten here would type-check and then fail at runtime.
 */
export type PluginUiHostSurface = PluginHostSurface;

/** Runtime-only host context. IDs never need to be copied into arbitrary view state. */
export interface PluginUiSessionContext {
	surface: PluginUiHostSurface;
	workspaceId?: string;
	projectId?: string;
	narratorId?: string;
	presentation?: "grid" | "director";
}

type NarratorRuntimeContext = {
	narratorId: string;
	projectId?: string;
};

interface PluginUiSurfaceContextValue {
	revision: number;
	hostContext: PluginUiSessionContext;
	getSessionContext: (panelInstanceId: string) => PluginUiSessionContext | undefined;
	setSessionContext: (panelInstanceId: string, context: PluginUiSessionContext) => void;
	registerNarratorContext: (context: NarratorRuntimeContext) => void;
	resolveOwnerNarratorId: (params: PluginDockPanelParams) => string | undefined;
	resolveSessionContext: (params: PluginDockPanelParams) => PluginUiSessionContext | undefined;
}

const PluginUiSurfaceContext = createContext<PluginUiSurfaceContextValue | null>(null);

/**
 * Surfaces that are interchangeable for binding purposes.
 *
 * Two families exist:
 *  - `workspace` / `director` — the same workspace seen as a grid or as an overlay.
 *  - `focus` — a single narrator's dock.
 *
 * `settings`, `provider-settings` and `overlay` deliberately belong to no family:
 * each is only itself, so a binding recorded for one of them can never resolve on
 * another. The overlay in particular must not fall back to a narrator context —
 * there is one overlay layer per app, with no workspace or narrator in scope.
 */
function isFocusFamily(surface: PluginUiHostSurface): boolean {
	return surface === "focus";
}

function isWorkspaceFamily(surface: PluginUiHostSurface): boolean {
	return surface === "workspace" || surface === "director";
}

function sameSurfaceFamily(a: PluginUiHostSurface, b: PluginUiHostSurface): boolean {
	if (a === b) return true;
	if (isWorkspaceFamily(a) && isWorkspaceFamily(b)) return true;
	return isFocusFamily(a) && isFocusFamily(b);
}

export function resolvePluginUiOwnerNarratorId(
	hostContext: PluginUiSessionContext,
	params: PluginDockPanelParams,
): string | undefined {
	switch (params.binding.kind) {
		case "focus-current-narrator":
			// Prefer the persisted narrator binding when available so recovered
			// panels keep their owner across surfaces; otherwise resolve the live
			// narrator on either focus-family surface.
			if (params.binding.narratorId) return params.binding.narratorId;
			return isFocusFamily(hostContext.surface) ? hostContext.narratorId : undefined;
		case "workspace-narrator":
			return (hostContext.surface === "workspace" || hostContext.surface === "director") &&
				hostContext.workspaceId === params.binding.workspaceId
				? params.binding.ownerNarratorId
				: undefined;
		default:
			return undefined;
	}
}

export function resolveCanonicalPluginUiSessionContext(
	hostContext: PluginUiSessionContext,
	params: PluginDockPanelParams,
	narratorContext?: NarratorRuntimeContext,
): PluginUiSessionContext | undefined {
	const ownerNarratorId = resolvePluginUiOwnerNarratorId(hostContext, params);
	if (ownerNarratorId) {
		return {
			...hostContext,
			...narratorContext,
			narratorId: ownerNarratorId,
		};
	}

	switch (params.binding.kind) {
		case "workspace":
			return (hostContext.surface === "workspace" || hostContext.surface === "director") &&
				hostContext.workspaceId === params.binding.workspaceId
				? hostContext
				: undefined;
		case "global":
			return hostContext.surface === "settings" ? hostContext : undefined;
		case "host-surface":
			return sameSurfaceFamily(params.binding.surface, hostContext.surface)
				? hostContext
				: undefined;
		default:
			return undefined;
	}
}

function sameSessionContext(
	previous: PluginUiSessionContext | undefined,
	context: PluginUiSessionContext,
): boolean {
	return (
		previous?.surface === context.surface &&
		previous.workspaceId === context.workspaceId &&
		previous.projectId === context.projectId &&
		previous.narratorId === context.narratorId &&
		previous.presentation === context.presentation
	);
}

export function PluginUiSurfaceProvider({
	hostContext,
	children,
}: {
	hostContext: PluginUiSessionContext;
	children: ReactNode;
}) {
	const contextsRef = useRef(new Map<string, PluginUiSessionContext>());
	const narratorContextsRef = useRef(new Map<string, NarratorRuntimeContext>());
	const [revision, setRevision] = useState(0);

	const getSessionContext = useCallback(
		(panelInstanceId: string) => contextsRef.current.get(panelInstanceId),
		[],
	);
	const setSessionContext = useCallback(
		(panelInstanceId: string, context: PluginUiSessionContext) => {
			if (sameSessionContext(contextsRef.current.get(panelInstanceId), context)) return;
			contextsRef.current.set(panelInstanceId, context);
			setRevision((value) => value + 1);
		},
		[],
	);
	const registerNarratorContext = useCallback((context: NarratorRuntimeContext) => {
		const previous = narratorContextsRef.current.get(context.narratorId);
		if (previous?.projectId === context.projectId) return;
		narratorContextsRef.current.set(context.narratorId, context);
		setRevision((value) => value + 1);
	}, []);

	const resolveOwnerNarratorId = useCallback(
		(params: PluginDockPanelParams): string | undefined =>
			resolvePluginUiOwnerNarratorId(hostContext, params),
		[hostContext],
	);

	const resolveSessionContext = useCallback(
		(params: PluginDockPanelParams): PluginUiSessionContext | undefined => {
			const explicit = contextsRef.current.get(params.panelInstanceId);
			if (explicit) return explicit;
			const ownerNarratorId = resolveOwnerNarratorId(params);
			return resolveCanonicalPluginUiSessionContext(
				hostContext,
				params,
				ownerNarratorId ? narratorContextsRef.current.get(ownerNarratorId) : undefined,
			);
		},
		[hostContext, resolveOwnerNarratorId],
	);

	const value = useMemo<PluginUiSurfaceContextValue>(
		() => ({
			revision,
			hostContext,
			getSessionContext,
			setSessionContext,
			registerNarratorContext,
			resolveOwnerNarratorId,
			resolveSessionContext,
		}),
		[
			revision,
			hostContext,
			getSessionContext,
			setSessionContext,
			registerNarratorContext,
			resolveOwnerNarratorId,
			resolveSessionContext,
		],
	);

	return (
		<PluginUiSurfaceContext.Provider value={value}>{children}</PluginUiSurfaceContext.Provider>
	);
}

export function usePluginUiSurface(): PluginUiSurfaceContextValue | null {
	return useContext(PluginUiSurfaceContext);
}
