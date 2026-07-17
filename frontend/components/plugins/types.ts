import type { IDockviewPanelProps } from "dockview-react";
import type { JsonValue, PluginDockPanelParams, UiRpcNotification, UiRpcRequest } from "./protocol";

export type PluginUiStatus =
	| "available"
	| "missing"
	| "disabled"
	| "denied"
	| "incompatible"
	| "error";

export interface PluginUiContribution {
	pluginId: string;
	contributionId: string;
	version: string;
	title: string;
	pluginName?: string;
	contentHash?: string;
	entryUrl: string;
	styleUrl?: string;
	packageHash?: string;
	entryPath?: string;
	stylePath?: string;
	status?: PluginUiStatus;
	unavailableReason?: string;
}

export interface PluginUiContext {
	contextVersion: number;
	host: {
		appVersion: string;
		locale: string;
		colorScheme: "light" | "dark";
		platform: "windows" | "macos" | "linux" | "unknown";
	};
	plugin: { id: string; version: string; contributionId: string; panelInstanceId: string };
	surface: {
		kind: "narrator-focus" | "workspace" | "director" | "settings";
		active: boolean;
		visible: boolean;
	};
	narrator?: { id: string; chapterId?: string | null; projectId?: string | null };
	workspace?: {
		id: string;
		ownerNarratorId?: string;
		narratorIds?: string[];
		presentation: "grid" | "director";
	};
	route: { routeId: string };
}

export interface PluginUiRequestContext {
	params: PluginDockPanelParams;
	request: UiRpcRequest;
	signal: AbortSignal;
}

export type PluginUiRequestHandler = (
	context: PluginUiRequestContext,
) => JsonValue | Promise<JsonValue>;

export interface PluginUiBackendRequestInput {
	sessionId: string;
	sessionToken: string;
	params: PluginDockPanelParams;
	request: UiRpcRequest;
	signal: AbortSignal;
}

export type PluginUiBackendRequestHandler = (
	input: PluginUiBackendRequestInput,
) => JsonValue | Promise<JsonValue>;

export interface PluginUiRuntimeProviderProps {
	children: React.ReactNode;
	resolveContribution: (params: PluginDockPanelParams) => PluginUiContribution | undefined;
	getContext?: (params: PluginDockPanelParams) => PluginUiContext;
	onRequest?: PluginUiRequestHandler;
	onBackendRequest?: PluginUiBackendRequestHandler;
	onNotification?: (params: PluginDockPanelParams, notification: UiRpcNotification) => void;
	defaultTimeoutMs?: number;
}

export interface PluginPanelSlotProps {
	panelInstanceId: string;
	priority?: number;
	visible?: boolean;
	active?: boolean;
	children?: React.ReactNode;
}

export interface PluginDockPanelProps extends IDockviewPanelProps<PluginDockPanelParams> {}

export interface PluginUiRuntimeApi {
	resolveContribution: (params: PluginDockPanelParams) => PluginUiContribution | undefined;
	ensureSession: (params: PluginDockPanelParams, contribution: PluginUiContribution) => void;
	getSessionSnapshot: (panelInstanceId: string) => PluginUiSessionSnapshot | undefined;
	reloadSession: (panelInstanceId: string) => void;
	registerSlot: (
		panelInstanceId: string,
		element: HTMLElement,
		options: { priority: number; visible: boolean; active: boolean },
	) => () => void;
	updateSlot: (
		panelInstanceId: string,
		element: HTMLElement,
		options: { priority: number; visible: boolean; active: boolean },
	) => void;
}

export interface PluginUiSessionSnapshot {
	panelInstanceId: string;
	status: "pending" | "registered" | "connecting" | "ready" | "error" | "crashed" | "disposed";
	diagnosticId?: string;
	error?: string;
}
