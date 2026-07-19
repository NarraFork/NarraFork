import {
	createContext,
	type ReactNode,
	useCallback,
	useContext,
	useMemo,
	useRef,
	useState,
} from "react";
import type { PluginDockPanelParams } from "./protocol";

export type PluginUiHostSurface = "focus" | "workspace" | "director" | "settings";

/** Runtime-only host context. IDs never need to be copied into arbitrary view state. */
export interface PluginUiSessionContext {
	surface: PluginUiHostSurface;
	workspaceId?: string;
	projectId?: string;
	narratorId?: string;
	chapterId?: string | null;
	presentation?: "grid" | "director";
}

type NarratorRuntimeContext = {
	narratorId: string;
	chapterId?: string | null;
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

function sameSurfaceFamily(a: PluginUiHostSurface, b: PluginUiHostSurface): boolean {
	if (a === b) return true;
	return (a === "workspace" || a === "director") && (b === "workspace" || b === "director");
}

export function resolvePluginUiOwnerNarratorId(
	hostContext: PluginUiSessionContext,
	params: PluginDockPanelParams,
): string | undefined {
	switch (params.binding.kind) {
		case "focus-current-narrator":
			return hostContext.surface === "focus" ? hostContext.narratorId : undefined;
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
		previous.chapterId === context.chapterId &&
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
		if (previous?.chapterId === context.chapterId && previous?.projectId === context.projectId) {
			return;
		}
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
