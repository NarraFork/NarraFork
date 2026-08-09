import type { JsonValue } from "./protocol";
import {
	createUiRequestId,
	isJsonValue,
	jsonByteLength,
	makeUiNotification,
	makeUiRequest,
	PLUGIN_UI_DEFAULT_TIMEOUT_MS,
	PLUGIN_UI_PROTOCOL,
	PLUGIN_UI_PROTOCOL_MAJOR,
	PLUGIN_UI_REQUEST_MAX_BYTES,
	PLUGIN_UI_RESPONSE_MAX_BYTES,
	uiBootstrapSchema,
} from "./protocol";

export interface PluginAssetShellOptions {
	nonce: string;
	pluginId: string;
	contributionId: string;
	panelInstanceId: string;
	entryUrl: string;
	styleUrl?: string;
	/** Panel title shown by the built-in loading splash (before the plugin script takes over). */
	title?: string;
	defaultTimeoutMs?: number;
	/**
	 * Shared host runtime (React + Mantine) to load before the plugin entry.
	 *
	 * Only set when the view declared `runtime: "host-react"`. Views that draw their own DOM
	 * must not pay for a ~1.2 MB download they never use, so the default stays absent and
	 * their shell is byte-for-byte what it was before this existed.
	 *
	 * The host supplies these URLs; a manifest cannot name them. They go through
	 * `isAllowedPluginAssetUrl` like every other asset.
	 */
	runtimeUrl?: string;
	runtimeStyleUrl?: string;
}

function escapeAttribute(value: string): string {
	return value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
}

/**
 * Mantine tokens mirrored from the host document into the sandboxed iframe so
 * plugin UIs can style themselves with the exact same design system (colors,
 * radius, fonts, spacing) as the host — including light/dark scheme switches,
 * because the srcdoc is rebuilt on theme change. Iframe documents do not
 * inherit host CSS variables, so the shell copies the resolved values.
 */
const MANTINE_TOKEN_NAMES = [
	"--mantine-color-body",
	"--mantine-color-text",
	"--mantine-color-dimmed",
	"--mantine-color-default",
	"--mantine-color-default-border",
	"--mantine-color-default-hover",
	"--mantine-color-black",
	"--mantine-color-white",
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-gray-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-dark-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-blue-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-indigo-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-yellow-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-green-${i}`),
	...Array.from({ length: 10 }, (_, i) => `--mantine-color-red-${i}`),
	"--mantine-primary-color-0",
	"--mantine-primary-color-1",
	"--mantine-primary-color-2",
	"--mantine-primary-color-3",
	"--mantine-primary-color-4",
	"--mantine-primary-color-5",
	"--mantine-primary-color-6",
	"--mantine-primary-color-7",
	"--mantine-primary-color-8",
	"--mantine-primary-color-9",
	"--mantine-primary-color-filled",
	"--mantine-primary-color-filled-hover",
	"--mantine-primary-color-light",
	"--mantine-primary-color-light-hover",
	"--mantine-primary-color-contrast",
	"--mantine-radius-xs",
	"--mantine-radius-sm",
	"--mantine-radius-md",
	"--mantine-radius-lg",
	"--mantine-spacing-xs",
	"--mantine-spacing-sm",
	"--mantine-spacing-md",
	"--mantine-spacing-lg",
	"--mantine-font-family",
	"--mantine-font-family-monospace",
	"--mantine-heading-font-family",
	"--mantine-font-size-xs",
	"--mantine-font-size-sm",
	"--mantine-font-size-md",
	"--mantine-font-size-lg",
	"--mantine-line-height",
];

/** Read the host's live Mantine tokens. Safe to call during render (document is mounted). */
export function readHostMantineTokens(): string {
	if (typeof document === "undefined") return "";
	const style = getComputedStyle(document.documentElement);
	const parts: string[] = [];
	for (const name of MANTINE_TOKEN_NAMES) {
		const value = style.getPropertyValue(name).trim();
		if (value) parts.push(`${name}:${value};`);
	}
	return parts.join("");
}

function escapeScriptJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e");
}

/** Host-owned asset URL policy. Plugin manifests never provide URLs directly to the shell. */
export function isAllowedPluginAssetUrl(value: string): boolean {
	if (!value.trim()) return false;
	try {
		const hasHostLocation =
			typeof globalThis.location !== "undefined" && Boolean(globalThis.location.origin);
		if (!hasHostLocation && /^[A-Za-z][A-Za-z0-9+.-]*:/.test(value)) return false;
		const url = new URL(value, globalThis.location?.origin ?? "http://localhost");
		if (url.protocol !== "http:" && url.protocol !== "https:") return false;
		if (hasHostLocation && url.origin !== globalThis.location.origin) return false;
		return !url.username && !url.password && !url.href.includes("javascript:");
	} catch {
		return false;
	}
}

function createInlineBridge(options: PluginAssetShellOptions): string {
	const timeout = options.defaultTimeoutMs ?? PLUGIN_UI_DEFAULT_TIMEOUT_MS;
	const bootstrap = {
		pluginId: options.pluginId,
		contributionId: options.contributionId,
		panelInstanceId: options.panelInstanceId,
		nonce: options.nonce,
		protocol: PLUGIN_UI_PROTOCOL,
		protocolVersion: PLUGIN_UI_PROTOCOL_MAJOR,
		entryUrl: options.entryUrl,
		styleUrl: options.styleUrl,
		runtimeUrl: options.runtimeUrl,
		runtimeStyleUrl: options.runtimeStyleUrl,
		timeout,
	};
	return `
(() => {
  "use strict";
  const config = ${escapeScriptJson(bootstrap)};
  let port = null;
  let connected = false;
  let loaded = false;
  let sequence = 0;
  const pending = new Map();
  const notificationListeners = new Set();
  const byteLength = (value) => {
    try { return new TextEncoder().encode(JSON.stringify(value)).byteLength; }
    catch { return Number.POSITIVE_INFINITY; }
  };
  const validJson = (value, depth = 0, seen = new Set()) => {
    if (depth > 32 || value === undefined || typeof value === "function") return false;
    if (value === null || typeof value === "string" || typeof value === "boolean") return true;
    if (typeof value === "number") return Number.isFinite(value);
    if (typeof value !== "object" || seen.has(value)) return false;
    seen.add(value);
    if (Array.isArray(value)) return value.every((item) => validJson(item, depth + 1, seen));
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    return Object.entries(value).every(([key, item]) => !["__proto__", "prototype", "constructor"].includes(key) && validJson(item, depth + 1, seen));
  };
  const makeId = () => {
    sequence = (sequence + 1) % Number.MAX_SAFE_INTEGER;
    const random = globalThis.crypto && globalThis.crypto.randomUUID ? globalThis.crypto.randomUUID().replaceAll("-", "").slice(0, 12) : "local";
    return "ui_" + random + "_" + sequence.toString(36);
  };
  const post = (message, maxBytes) => {
    if (!port || byteLength(message) > maxBytes) throw new Error("UI bridge payload is too large");
    port.postMessage(message);
  };
  const request = (method, params, requestTimeout = config.timeout) => new Promise((resolve, reject) => {
    if (!connected) { reject(new Error("Plugin UI bridge is not connected")); return; }
    if (params !== undefined && !validJson(params)) { reject(new Error("Plugin UI params must be JSON")); return; }
    const message = { protocol: config.protocol, kind: "request", id: makeId(), method, ...(params === undefined ? {} : { params }) };
    if (byteLength(message) > ${PLUGIN_UI_REQUEST_MAX_BYTES}) { reject(new Error("UI request is too large")); return; }
    const timer = setTimeout(() => {
      pending.delete(message.id);
      try { post({ protocol: config.protocol, kind: "notification", method: "rpc.cancel", params: { requestId: message.id } }, ${PLUGIN_UI_REQUEST_MAX_BYTES}); } catch {}
      reject(Object.assign(new Error("Plugin UI request timed out"), { code: "TIMEOUT" }));
    }, requestTimeout);
    pending.set(message.id, { resolve, reject, timer });
    try { post(message, ${PLUGIN_UI_REQUEST_MAX_BYTES}); } catch (error) { clearTimeout(timer); pending.delete(message.id); reject(error); }
  });
  const notify = (method, params) => {
    const message = { protocol: config.protocol, kind: "notification", method, ...(params === undefined ? {} : { params }) };
    if (params !== undefined && !validJson(params)) throw new Error("Plugin UI notification must be JSON");
    post(message, ${PLUGIN_UI_REQUEST_MAX_BYTES});
  };
  const onNotification = (listener) => { notificationListeners.add(listener); return () => notificationListeners.delete(listener); };
  const api = Object.freeze({
    request,
    notify,
    onNotification,
    getContext: () => request("context.get"),
    subscribeContext: () => request("context.subscribe"),
    panel: Object.freeze({
      getState: () => request("panel.getState"),
      setTitle: (input) => request("panel.setTitle", input),
      setBadge: (input) => request("panel.setBadge", input),
      setDirty: (input) => request("panel.setDirty", input),
      updateParams: (input) => request("panel.updateParams", input),
      focus: () => request("panel.focus"),
      close: () => request("panel.close"),
      open: (input) => request("panel.open", input),
    }),
    queries: Object.freeze({ execute: (queryId, input) => request("queries.execute", { queryId, input }) }),
    commands: Object.freeze({ execute: (commandId, input) => request("commands.execute", { commandId, input }) }),
    events: Object.freeze({
      subscribe: (input) => request("events.subscribe", input),
      unsubscribe: (input) => request("events.unsubscribe", input),
      poll: (input) => request("events.poll", input),
    }),
    storage: Object.freeze({
      get: (input) => request("storage.get", input),
      set: (input) => request("storage.set", input),
      delete: (input) => request("storage.delete", input),
      list: (input) => request("storage.list", input),
    }),
    config: Object.freeze({ get: () => request("config.get") }),
    // Own secrets, read and write. The host namespaces by the session's plugin id, so there
    // is no parameter for naming another plugin's store.
    secrets: Object.freeze({
      get: (key) => request("secrets.get", { key }),
      set: (key, value) => request("secrets.set", { key, value }),
      delete: (key) => request("secrets.delete", { key }),
      list: () => request("secrets.list"),
    }),
    notifications: Object.freeze({ show: (input) => request("notifications.show", input) }),
    ui: Object.freeze({ openExternal: (input) => request("ui.openExternal", input) }),
  });
  const validEnvelope = (message) => {
    if (!message || typeof message !== "object" || message.protocol !== config.protocol) return false;
    if (message.kind === "response") return typeof message.id === "string" && (Object.prototype.hasOwnProperty.call(message, "result") || (message.error && typeof message.error.code === "string" && typeof message.error.message === "string"));
    if (message.kind === "notification") return typeof message.method === "string" && (message.params === undefined || validJson(message.params));
    return false;
  };
  const handleMessage = (event) => {
    const message = event.data;
    if (byteLength(message) > ${PLUGIN_UI_RESPONSE_MAX_BYTES} || !validEnvelope(message)) return;
    if (message.kind === "response") {
      const item = pending.get(message.id);
      if (!item) return;
      pending.delete(message.id);
      clearTimeout(item.timer);
      if (message.error) item.reject(Object.assign(new Error(message.error.message), message.error));
      else item.resolve(message.result);
      return;
    }
    for (const listener of notificationListeners) listener(message);
  };
  let handshakeId = "";
  const addStylesheet = (href) => {
    const style = document.createElement("link");
    style.rel = "stylesheet";
    style.href = href;
    document.head.appendChild(style);
  };
  const loadEntry = () => {
    if (config.styleUrl) addStylesheet(config.styleUrl);
    const script = document.createElement("script");
    script.src = config.entryUrl;
    script.async = false;
    script.onerror = () => notify("plugin.lifecycle", { state: "crashed", reason: "asset-load-failed" });
    document.head.appendChild(script);
  };
  const loadPlugin = () => {
    if (loaded) return;
    loaded = true;
    // Without a shared runtime the plugin owns its whole bundle, so load it directly.
    if (!config.runtimeUrl) { loadEntry(); return; }
    // With one, the entry reads React/Mantine off a global the runtime installs, so it
    // must not execute until the runtime has finished. Chaining on the load event rather
    // than relying on document order is what makes that ordering real: two non-async
    // scripts do execute in order, but a runtime failure would otherwise be invisible and
    // the plugin would fail on a missing global instead of reporting the actual cause.
    if (config.runtimeStyleUrl) addStylesheet(config.runtimeStyleUrl);
    const runtime = document.createElement("script");
    runtime.src = config.runtimeUrl;
    runtime.async = false;
    runtime.onload = () => loadEntry();
    runtime.onerror = () => notify("plugin.lifecycle", { state: "crashed", reason: "runtime-load-failed" });
    document.head.appendChild(runtime);
  };
  const onConnect = (event) => {
    if (connected || event.source !== window.parent || !event.ports || event.ports.length !== 1) return;
    const message = event.data;
    if (!message || typeof message !== "object" || message.type !== "narrafork:ui-connect" || message.protocol !== config.protocol || message.nonce !== config.nonce || message.pluginId !== config.pluginId || message.contributionId !== config.contributionId || message.panelInstanceId !== config.panelInstanceId || !message.hostProtocolRange || message.hostProtocolRange.min !== config.protocolVersion || message.hostProtocolRange.max !== config.protocolVersion) return;
    port = event.ports[0];
    connected = true;
    window.removeEventListener("message", onConnect);
    port.addEventListener("message", handleMessage);
    if (port.start) port.start();
    const handshake = { nonce: config.nonce, protocolVersion: config.protocolVersion, pluginId: config.pluginId, contributionId: config.contributionId, panelInstanceId: config.panelInstanceId };
    handshakeId = makeId();
    const handshakeTimer = setTimeout(() => {
      if (!pending.has(handshakeId)) return;
      pending.delete(handshakeId);
      connected = false;
      if (port) port.close();
      port = null;
    }, config.timeout);
    pending.set(handshakeId, {
      resolve: () => loadPlugin(),
      reject: () => {
        connected = false;
        if (port) port.close();
        port = null;
      },
      timer: handshakeTimer,
    });
    post({ protocol: config.protocol, kind: "request", id: handshakeId, method: "handshake", params: handshake }, ${PLUGIN_UI_REQUEST_MAX_BYTES});
    globalThis.narrafork = api;
  };
  window.addEventListener("message", onConnect);
})();`;
}

/** Build the complete HTML document used as iframe srcdoc. */
export function createPluginAssetShell(options: PluginAssetShellOptions): string {
	if (
		!uiBootstrapSchema.safeParse({
			type: "narrafork:ui-connect",
			nonce: options.nonce,
			protocol: PLUGIN_UI_PROTOCOL,
			hostProtocolRange: { min: 1, max: 1 },
			pluginId: options.pluginId,
			contributionId: options.contributionId,
			panelInstanceId: options.panelInstanceId,
		}).success
	) {
		throw new Error("Invalid plugin UI shell identity");
	}
	if (
		!isAllowedPluginAssetUrl(options.entryUrl) ||
		(options.styleUrl && !isAllowedPluginAssetUrl(options.styleUrl)) ||
		// Host-supplied, but validated on the same terms: the CSP below only grants the
		// asset origin, so an off-origin runtime URL would be blocked at load time with a
		// far less obvious error than this one.
		(options.runtimeUrl && !isAllowedPluginAssetUrl(options.runtimeUrl)) ||
		(options.runtimeStyleUrl && !isAllowedPluginAssetUrl(options.runtimeStyleUrl))
	) {
		throw new Error("Plugin UI assets must use same-origin HTTP(S) URLs");
	}
	const assetOrigin = new URL(options.entryUrl, globalThis.location?.origin ?? "http://localhost")
		.origin;
	const csp = [
		"default-src 'none'",
		`sandbox allow-scripts`,
		`script-src 'nonce-${escapeAttribute(options.nonce)}' ${assetOrigin}`,
		`style-src ${assetOrigin} 'unsafe-inline'`,
		`img-src ${assetOrigin} data: blob:`,
		`font-src ${assetOrigin}`,
		"connect-src 'none'",
		"frame-src 'none'",
		"child-src 'none'",
		"worker-src 'none'",
		"object-src 'none'",
		"base-uri 'none'",
		"form-action 'none'",
		"manifest-src 'none'",
		"media-src 'none'",
	].join("; ");
	// The iframe body starts with a themed loading splash (spinner + panel
	// title) so the frame is never a blank white rectangle while the bridge
	// handshake and plugin script load. The plugin script takes over the body
	// as soon as it runs (plugin UIs render their own content); the splash is
	// deliberately inline/CSP-safe (style-src 'unsafe-inline').
	const splashTitle = options.title ? escapeAttribute(options.title) : "Plugin panel";
	const splash = `<div id="plugin-shell-splash" style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;background:var(--mantine-color-body,#1a1b1e);color:var(--mantine-color-dimmed,#909296);font-family:var(--mantine-font-family,system-ui,-apple-system,'Segoe UI',Roboto,sans-serif);font-size:13px;"><div style="width:20px;height:20px;border:2px solid var(--mantine-color-default-border,#373a40);border-top-color:var(--mantine-primary-color-5,#4c6ef5);border-radius:50%;animation:plugin-shell-spin .9s linear infinite;"></div><div>${splashTitle}</div></div><style>@keyframes plugin-shell-spin{to{transform:rotate(360deg)}}</style>`;
	return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${escapeAttribute(csp)}"><style>:root{${readHostMantineTokens()}}</style></head><body>${splash}<script nonce="${escapeAttribute(options.nonce)}">${createInlineBridge(options)}</script></body></html>`;
}

export function createPluginNonce(): string {
	const bytes = new Uint8Array(16);
	if (globalThis.crypto?.getRandomValues) globalThis.crypto.getRandomValues(bytes);
	else for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
	return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export type { JsonValue };
export { createUiRequestId, isJsonValue, jsonByteLength, makeUiNotification, makeUiRequest };
