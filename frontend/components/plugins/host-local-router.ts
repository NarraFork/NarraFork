/**
 * Host-local method router for the plugin UI bridge.
 *
 * Methods declared in `PLUGIN_UI_HOST_LOCAL_METHODS` never travel to the
 * backend (`/api/plugins/ui/sessions/:id/request`); they are resolved inside
 * the host (this process) so panel chrome, context, and notifications behave
 * consistently and stay available even when the backend session is down.
 *
 * Routing contract (F2/F3):
 * - `context.get` is served from the same data source as the handshake so both
 *   paths are deeply equal (F0 requirement). When no `getContext` resolver is
 *   wired the method reports a structured `CONTEXT_UNAVAILABLE` error instead
 *   of a hardcoded stub.
 * - `panel.getState` / `panel.setTitle` / `panel.updateParams` are minimally
 *   implemented against the registered `PluginUiPanelDelegate` (Dockview panel
 *   api where available).
 * - Every other declared host-local method returns an explicit
 *   `NOT_SUPPORTED` (non-retryable) so plugins can feature-detect instead of
 *   mistaking a silent no-op for success.
 * - Methods outside the host-local set return `null` so the caller forwards
 *   them to the backend handler.
 */

import type {
	JsonValue,
	PluginDockPanelParams,
	PluginUiHostLocalMethod,
	UiRpcRequest,
} from "./protocol";
import { isPluginUiHostLocalMethod, parsePluginDockPanelParams } from "./protocol";
import { PluginUiHostError } from "./runtime";
import type { PluginUiContext, PluginUiRequestContext } from "./types";

/**
 * Host-side handle over the Dockview panel chrome. Implemented by the runtime
 * provider (which tracks panel delegates) — the router itself stays
 * Dockview-free for testability.
 */
export interface PluginUiPanelDelegate {
	/** Current Dockview panel title, when known. */
	getTitle?: () => string | undefined;
	/** Whether the panel is the active tab in its group. */
	isActive?: () => boolean;
	/** Set the Dockview tab title. */
	setTitle?: (title: string) => void;
	/** Merge partial params back onto the Dockview panel (bounded). */
	updateParams?: (params: Readonly<Record<string, JsonValue>>) => void;
	/** Focus (activate) the panel. */
	focus?: () => void;
	/** Close the panel. */
	close?: () => void;
}

/** Host-side surface for opening a NEW plugin panel (used by `panel.open`). */
export interface PluginUiPanelOpenRequest {
	pluginId: string;
	contributionId: string;
	binding?: PluginDockPanelParams["binding"];
	viewState?: JsonValue;
	title?: string;
}

export interface PluginUiHostLocalRouterOptions {
	/** Resolve the host-owned context (same source as the handshake). */
	getContext?: (params: PluginDockPanelParams) => PluginUiContext | undefined;
	/** Resolve the panel delegate for one panel instance. */
	getPanelDelegate?: (panelInstanceId: string) => PluginUiPanelDelegate | undefined;
	/** Show a host notification (wired to Mantine notifications in main.tsx). */
	showNotification?: (input: PluginUiNotificationInput) => void;
	/** Open another plugin panel on the host surface (picker/Dockview bridge). */
	openPanel?: (request: PluginUiPanelOpenRequest) => void;
	/** Open an external URL. Only wired when a policy gate exists; otherwise NOT_SUPPORTED. */
	openExternal?: (url: string) => void;
	/** Navigate to an internal host route (e.g. a narrator chat page). */
	navigate?: (to: string) => void;
}

export interface PluginUiNotificationInput {
	title?: string;
	message: string;
	color?: string;
}

function isRecord(value: unknown): value is Record<string, JsonValue> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
	return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function invalidParams(message: string): PluginUiHostError {
	return new PluginUiHostError("INVALID_PARAMS", message, { retryable: false });
}

function notSupported(method: string): PluginUiHostError {
	return new PluginUiHostError(
		"NOT_SUPPORTED",
		`Plugin UI method is not supported by this host: ${method}`,
		{ retryable: false },
	);
}

/**
 * Route a host-local UI method. Returns the JSON result when the method is
 * handled (or a structured PluginUiHostError is thrown), and `null` when the
 * method is not host-local and must be forwarded to the backend handler.
 */
export function routePluginUiHostLocalRequest(
	context: PluginUiRequestContext,
	options: PluginUiHostLocalRouterOptions,
): JsonValue | Promise<JsonValue> | null {
	const method = context.request.method;
	if (!isPluginUiHostLocalMethod(method)) return null;
	return dispatchHostLocal(context.params, context.request, method, options);
}

function dispatchHostLocal(
	params: PluginDockPanelParams,
	request: UiRpcRequest,
	method: PluginUiHostLocalMethod,
	options: PluginUiHostLocalRouterOptions,
): JsonValue | Promise<JsonValue> {
	switch (method) {
		case "context.get": {
			const contextValue = options.getContext?.(params);
			if (!contextValue) {
				throw new PluginUiHostError(
					"CONTEXT_UNAVAILABLE",
					"Plugin UI context is not available on this host surface",
					{ retryable: true },
				);
			}
			return contextValue as unknown as JsonValue;
		}
		case "context.subscribe":
			// Context push subscriptions are not implemented yet; the handshake and
			// context.get already expose the current snapshot.
			throw notSupported(method);
		case "panel.getState":
			return panelGetState(params, options);
		case "panel.setTitle":
			return panelSetTitle(params, request, options);
		case "panel.updateParams":
			return panelUpdateParams(params, request, options);
		case "panel.focus":
			return panelVoid(params, options, (delegate) => delegate.focus?.(), method);
		case "panel.close":
			return panelVoid(params, options, (delegate) => delegate.close?.(), method);
		case "panel.open":
			return panelOpen(request, options, method);
		case "notifications.show":
			return notificationsShow(request, options, method);
		case "ui.openExternal":
			return uiOpenExternal(request, options, method);
		case "ui.navigate":
			return uiNavigate(request, options, method);
		case "panel.setBadge":
		case "panel.setDirty":
			throw notSupported(method);
		default:
			throw notSupported(method);
	}
}

function panelGetState(
	params: PluginDockPanelParams,
	options: PluginUiHostLocalRouterOptions,
): JsonValue {
	const delegate = options.getPanelDelegate?.(params.panelInstanceId);
	return {
		panelInstanceId: params.panelInstanceId,
		pluginId: params.pluginId,
		contributionId: params.contributionId,
		binding: params.binding as unknown as JsonValue,
		title: delegate?.getTitle?.() ?? null,
		active: delegate?.isActive?.() ?? null,
		viewState: params.viewState ?? null,
		viewStateVersion: params.viewStateVersion ?? null,
	};
}

function panelSetTitle(
	params: PluginDockPanelParams,
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
): JsonValue {
	const delegate = options.getPanelDelegate?.(params.panelInstanceId);
	if (!delegate?.setTitle) throw notSupported(request.method);
	const title = isRecord(request.params) ? readString(request.params.title) : undefined;
	if (!title) throw invalidParams("panel.setTitle requires a non-empty title");
	if (title.length > 200) throw invalidParams("panel.setTitle title exceeds 200 characters");
	delegate.setTitle(title);
	return { ok: true };
}

function panelUpdateParams(
	params: PluginDockPanelParams,
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
): JsonValue {
	const delegate = options.getPanelDelegate?.(params.panelInstanceId);
	if (!delegate?.updateParams) throw notSupported(request.method);
	if (!isRecord(request.params)) throw invalidParams("panel.updateParams requires an object");
	const patch: Record<string, JsonValue> = {};
	if ("viewState" in request.params) patch.viewState = request.params.viewState;
	if ("viewStateVersion" in request.params) {
		const version = request.params.viewStateVersion;
		if (typeof version !== "number" || !Number.isInteger(version) || version < 0) {
			throw invalidParams("panel.updateParams viewStateVersion must be a non-negative integer");
		}
		patch.viewStateVersion = version;
	}
	const next = parsePluginDockPanelParams({ ...params, ...patch });
	if (!next) throw invalidParams("panel.updateParams produced invalid panel params");
	delegate.updateParams(next as unknown as Readonly<Record<string, JsonValue>>);
	return { ok: true };
}

function panelVoid(
	params: PluginDockPanelParams,
	options: PluginUiHostLocalRouterOptions,
	action: (delegate: PluginUiPanelDelegate) => void,
	method: string,
): JsonValue {
	const delegate = options.getPanelDelegate?.(params.panelInstanceId);
	if (!delegate) throw notSupported(method);
	action(delegate);
	return { ok: true };
}

function panelOpen(
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
	method: string,
): JsonValue {
	if (!options.openPanel) throw notSupported(method);
	if (!isRecord(request.params)) throw invalidParams("panel.open requires an object");
	const pluginId = readString(request.params.pluginId);
	const contributionId = readString(request.params.contributionId);
	if (!pluginId || !contributionId) {
		throw invalidParams("panel.open requires pluginId and contributionId");
	}
	const title = readString(request.params.title);
	options.openPanel({
		pluginId,
		contributionId,
		...(title ? { title } : {}),
		...(isRecord(request.params.binding)
			? { binding: request.params.binding as unknown as PluginDockPanelParams["binding"] }
			: {}),
		...("viewState" in request.params ? { viewState: request.params.viewState } : {}),
	});
	return { accepted: true };
}

function notificationsShow(
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
	method: string,
): JsonValue {
	if (!options.showNotification) throw notSupported(method);
	if (!isRecord(request.params)) throw invalidParams("notifications.show requires an object");
	const message = readString(request.params.message);
	if (!message) throw invalidParams("notifications.show requires a message");
	if (message.length > 4_000)
		throw invalidParams("notifications.show message exceeds 4000 characters");
	const title = readString(request.params.title);
	const color = readString(request.params.color);
	options.showNotification({ message, ...(title ? { title } : {}), ...(color ? { color } : {}) });
	return { ok: true };
}

function uiOpenExternal(
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
	method: string,
): JsonValue {
	if (!options.openExternal) throw notSupported(method);
	const url = isRecord(request.params) ? readString(request.params.url) : undefined;
	if (!url) throw invalidParams("ui.openExternal requires a url");
	if (!/^https?:\/\//i.test(url)) throw invalidParams("ui.openExternal only allows http(s) URLs");
	options.openExternal(url);
	return { ok: true };
}

/** Internal route allow-list: only host-owned deep links may be navigated to. */
const INTERNAL_NAVIGATION_PREFIXES = ["/narrators/", "/projects/", "/chapters/"];

function uiNavigate(
	request: UiRpcRequest,
	options: PluginUiHostLocalRouterOptions,
	method: string,
): JsonValue {
	if (!options.navigate) throw notSupported(method);
	const to = isRecord(request.params) ? readString(request.params.to) : undefined;
	if (!to) throw invalidParams("ui.navigate requires a to path");
	const allowed = INTERNAL_NAVIGATION_PREFIXES.some((prefix) => to.startsWith(prefix));
	if (!allowed || to.includes("\0") || to.includes("\\") || /[\s?#]/.test(to)) {
		throw invalidParams("ui.navigate only allows internal host paths");
	}
	options.navigate(to);
	return { ok: true };
}
