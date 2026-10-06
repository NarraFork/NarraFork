import type { IDockviewPanelProps } from "dockview-react";
import type { PluginUiHostLocalRouterOptions, PluginUiPanelDelegate } from "./host-local-router";
import type { PluginUiSessionContext } from "./PluginUiSurfaceContext";
import type { JsonValue, PluginDockPanelParams, UiRpcNotification, UiRpcRequest } from "./protocol";

/**
 * Surfaces a plugin view may declare.
 *
 * Defined once and reused: the same list previously appeared inline in half a dozen
 * places, so adding a surface meant finding every copy. Mirrors the manifest enum in
 * `server/lib/plugins/manifest.ts`.
 */
export type PluginViewSurface =
	| "workspace"
	| "director"
	| "focus"
	/** A chapter node's embedded dock; part of the `focus` family (one narrator). */
	| "graph"
	| "settings"
	| "provider-settings";

export type PluginUiStatus =
	| "available"
	| "missing"
	| "disabled"
	| "denied"
	| "incompatible"
	| "error";

export type PluginContributionAvailability =
	| "available"
	| "disabled"
	| "denied"
	| "incompatible"
	| "missing";

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
	scope?: "workspace" | "narrator" | "project" | "global";
	/** Surfaces this view may mount on; the session route re-checks them server-side. */
	surfaces?: PluginViewSurface[];
	/**
	 * Set when the view opted into the host's shared UI runtime (React + Mantine). The shell
	 * then injects the runtime before the view's entry; absent means the view ships its own
	 * DOM code and the shell is unchanged.
	 */
	runtime?: PluginUiRuntimeKind;
	status?: PluginUiStatus;
	unavailableReason?: string;
}

/** Shared UI runtimes the host can inject into a plugin iframe. */
export type PluginUiRuntimeKind = "host-react";

/**
 * Session-identity fields for a contribution. When any of these values change,
 * the runtime must dispose the previous backend session and rebuild it.
 */
export interface PluginContributionIdentity {
	pluginId: string;
	contributionId: string;
	version?: string;
	hash?: string;
	entryPath?: string;
	stylePath?: string;
}

/** Host-owned contribution record kept in the runtime registry/store. */
export interface PluginContributionRecord extends PluginContributionIdentity {
	scope?: "workspace" | "narrator" | "project" | "global";
	/** Surfaces this view may mount on; used to filter per-surface, never to authorize. */
	surfaces?: PluginViewSurface[];
	/** Shared host runtime this view opted into, if any. */
	runtime?: PluginUiRuntimeKind;
	title: string;
	pluginName?: string;
	availability: PluginContributionAvailability;
	unavailableReason?: string;
	entryUrl?: string;
	styleUrl?: string;
}

export type PluginContributionSnapshotStatus = "idle" | "syncing" | "ready" | "error";

export interface PluginContributionSnapshot {
	/** Monotonic revision that bumps whenever the contribution map changes. */
	revision: number;
	/** Whether a backend snapshot has been successfully applied. */
	synced: boolean;
	/** Last successful sync time (ms since epoch). */
	updatedAt?: number;
	/** Last sync error, if any. */
	error?: string;
	/** Current lifecycle state of the snapshot. */
	status: PluginContributionSnapshotStatus;
	/** Host-owned contributions keyed by `${pluginId}:${contributionId}`. */
	contributions: Readonly<Record<string, PluginContributionRecord>>;
}

export interface PluginUiContext {
	contextVersion: number;
	host: {
		appVersion: string;
		/**
		 * Host UI language, normalized (`en`, `zh-CN`).
		 *
		 * A snapshot taken when the session was built. Prefer `narrafork.i18n.locale`, which
		 * tracks language changes live; this field cannot, because `context.subscribe` is not
		 * implemented and `context.get` is only read once.
		 */
		locale: string;
		/**
		 * The scheme the host is actually rendering in, with `"auto"` already resolved.
		 *
		 * Also a build-time snapshot, for the same reason. Use it for one-off decisions (which
		 * illustration to pick); do NOT use it to follow the theme — that is what the injected
		 * `--nf-*` CSS variables are for, and they update in place without any plugin code.
		 */
		colorScheme: "light" | "dark";
		platform: "windows" | "macos" | "linux" | "unknown";
	};
	plugin: { id: string; version: string; contributionId: string; panelInstanceId: string };
	surface: {
		kind: "narrator-focus" | "workspace" | "director" | "settings" | "provider-settings";
		active: boolean;
		visible: boolean;
	};
	narrator?: { id: string; chapterId?: string | null; projectId?: string | null };
	project?: { id: string };
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
	getContext?: (
		params: PluginDockPanelParams,
		sessionContext: PluginUiSessionContext,
		contribution: PluginUiContribution,
	) => PluginUiContext;
	onRequest?: PluginUiRequestHandler;
	onBackendRequest?: PluginUiBackendRequestHandler;
	onNotification?: (params: PluginDockPanelParams, notification: UiRpcNotification) => void;
	defaultTimeoutMs?: number;
	/**
	 * Host-local method wiring (`context.get`, `panel.*`, `notifications.show`,
	 * `ui.openExternal`). Routed before the backend handler; unimplemented
	 * methods report a structured NOT_SUPPORTED error to the plugin.
	 */
	hostLocal?: PluginUiHostLocalRouterOptions;
	/**
	 * Called when a backend request fails with `PLUGIN_UI_SESSION_INVALID`
	 * (HTTP 401). Should dispose and rebuild the session exactly once; the
	 * provider does not auto-retry by itself.
	 */
	onSessionInvalid?: (panelInstanceId: string) => void;
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
	/** Bumps for contribution-store and backend-session state changes. */
	revision: number;
	resolveContribution: (params: PluginDockPanelParams) => PluginUiContribution | undefined;
	ensureSession: (
		params: PluginDockPanelParams,
		contribution: PluginUiContribution,
		sessionContext: PluginUiSessionContext,
	) => void;
	updateSessionParams: (panelInstanceId: string, params: PluginDockPanelParams) => void;
	getSessionSnapshot: (panelInstanceId: string) => PluginUiSessionSnapshot | undefined;
	/**
	 * The live session controller for a panel (if any). The panel renders the
	 * session's iframe inside its own dock content — mirroring how built-in tool
	 * panels render their content directly — instead of an overlay layer, so the
	 * dock natively manages tab switching, hiding, and movement.
	 */
	getSessionController: (panelInstanceId: string) => PluginUiSessionController | undefined;
	reloadSession: (panelInstanceId: string) => void;
	/** Dispose the session for one panel (if any) without scheduling a rebuild. */
	disposeSession: (panelInstanceId: string) => void;
	/**
	 * Register a host panel delegate (Dockview chrome bridge) for a panel
	 * instance. Returns an unregister function. Used by PluginDockPanel to back
	 * host-local `panel.*` methods.
	 */
	registerPanelDelegate: (panelInstanceId: string, delegate: PluginUiPanelDelegate) => () => void;
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

/** Narrow surface over the live session runtime used by the dock panel. */
export interface PluginUiSessionController {
	getSrcdoc(): string;
	attach(iframe: HTMLIFrameElement): void;
	setVisibility(visible: boolean): void;
	setActive(active: boolean): void;
	setFocused(focused: boolean): void;
}
