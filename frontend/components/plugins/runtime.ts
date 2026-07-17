import { createPluginAssetShell, createPluginNonce } from "./asset-shell";
import type {
	JsonValue,
	PluginDockPanelParams,
	UiRpcError,
	UiRpcNotification,
	UiRpcRequest,
	UiRpcResponse,
} from "./protocol";
import {
	createUiRequestId,
	isJsonValue,
	jsonByteLength,
	makeUiNotification,
	makeUiRequest,
	makeUiResponse,
	PLUGIN_UI_DEFAULT_TIMEOUT_MS,
	PLUGIN_UI_PROTOCOL,
	PLUGIN_UI_REQUEST_MAX_BYTES,
	PLUGIN_UI_RESPONSE_MAX_BYTES,
	parsePluginDockPanelParams,
	uiHandshakeParamsSchema,
	uiRpcEnvelopeSchema,
	uiRpcErrorSchema,
} from "./protocol";
import type {
	PluginUiContext,
	PluginUiContribution,
	PluginUiRequestHandler,
	PluginUiSessionSnapshot,
} from "./types";

export interface PluginUiSessionOptions {
	params: PluginDockPanelParams;
	contribution: PluginUiContribution;
	nonce?: string;
	getContext?: (params: PluginDockPanelParams) => PluginUiContext;
	onRequest?: PluginUiRequestHandler;
	onNotification?: (params: PluginDockPanelParams, notification: UiRpcNotification) => void;
	defaultTimeoutMs?: number;
	onStateChange?: (snapshot: PluginUiSessionSnapshot) => void;
}

type PendingRequest = {
	resolve: (value: JsonValue) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

function asError(error: unknown, fallback: string): Error {
	return error instanceof Error ? error : new Error(error ? String(error) : fallback);
}

function responseError(id: string, code: UiRpcError["code"], message: string): UiRpcResponse {
	return makeUiResponse(id, undefined, { code, message });
}

export class PluginUiHostError extends Error {
	readonly code: UiRpcError["code"];
	readonly retryable?: boolean;
	readonly details?: JsonValue;

	constructor(
		code: UiRpcError["code"],
		message: string,
		options: { retryable?: boolean; details?: JsonValue } = {},
	) {
		super(message);
		this.name = "PluginUiHostError";
		this.code = code;
		this.retryable = options.retryable;
		this.details = options.details;
	}
}

function asUiRpcError(error: unknown, cancelled: boolean): UiRpcError {
	if (cancelled) return { code: "CANCELLED", message: "Plugin UI request was cancelled" };
	if (error instanceof PluginUiHostError) {
		return {
			code: error.code,
			message: error.message,
			...(error.retryable === undefined ? {} : { retryable: error.retryable }),
			...(error.details === undefined ? {} : { details: error.details }),
		};
	}
	if (error && typeof error === "object" && !Array.isArray(error)) {
		const value = error as Record<string, unknown>;
		const candidate = {
			code: value.code,
			message:
				typeof value.message === "string"
					? value.message
					: asError(error, "Plugin UI request failed").message,
			...(typeof value.retryable === "boolean" ? { retryable: value.retryable } : {}),
			...(isJsonValue(value.details) ? { details: value.details } : {}),
		};
		const parsed = uiRpcErrorSchema.safeParse(candidate);
		if (parsed.success) return parsed.data;
	}
	return { code: "INTERNAL_ERROR", message: asError(error, "Plugin UI request failed").message };
}

/** One iframe + one MessagePort session. The controller owns all transport state. */
export class PluginUiSession {
	readonly params: PluginDockPanelParams;
	readonly contribution: PluginUiContribution;
	private readonly options: PluginUiSessionOptions;
	private readonly pending = new Map<string, PendingRequest>();
	private readonly inFlight = new Map<string, AbortController>();
	private port: MessagePort | null = null;
	private portMessageHandler: ((event: MessageEvent) => void) | null = null;
	private portMessageErrorHandler: (() => void) | null = null;
	private attachedIframe: HTMLIFrameElement | null = null;
	private handshakeTimer: ReturnType<typeof setTimeout> | null = null;
	private nonce: string;
	private generation = 0;
	private state: PluginUiSessionSnapshot["status"] = "registered";
	private diagnosticId: string | undefined;
	private error: string | undefined;
	private srcdoc: string;
	private visibility: boolean | undefined;
	private focused: boolean | undefined;
	private active: boolean | undefined;

	constructor(options: PluginUiSessionOptions) {
		this.options = options;
		this.params = options.params;
		this.contribution = options.contribution;
		this.nonce = options.nonce ?? createPluginNonce();
		this.srcdoc = this.createShell();
	}

	getSnapshot(): PluginUiSessionSnapshot {
		return {
			panelInstanceId: this.params.panelInstanceId,
			status: this.state,
			...(this.diagnosticId ? { diagnosticId: this.diagnosticId } : {}),
			...(this.error ? { error: this.error } : {}),
		};
	}

	getSrcdoc(): string {
		return this.srcdoc;
	}

	attach(iframe: HTMLIFrameElement): void {
		if (this.state === "disposed" || this.attachedIframe === iframe) return;
		this.disposePort();
		this.attachedIframe = iframe;
		this.generation += 1;
		const generation = this.generation;
		this.error = undefined;
		this.setState("connecting");
		if (!iframe.contentWindow) {
			this.crash("Plugin iframe has no content window");
			return;
		}
		const channel = new MessageChannel();
		const port = channel.port1;
		this.port = port;
		this.portMessageHandler = (event) => this.handleMessage(event, generation, port);
		this.portMessageErrorHandler = () => {
			if (this.generation === generation && this.port === port) {
				this.crash("Plugin UI message transport failed");
			}
		};
		port.addEventListener("message", this.portMessageHandler);
		port.addEventListener("messageerror", this.portMessageErrorHandler);
		port.start();
		const bootstrap = {
			type: "narrafork:ui-connect" as const,
			nonce: this.nonce,
			protocol: PLUGIN_UI_PROTOCOL,
			hostProtocolRange: { min: 1 as const, max: 1 as const },
			pluginId: this.params.pluginId,
			contributionId: this.params.contributionId,
			panelInstanceId: this.params.panelInstanceId,
		};
		const timeoutMs = this.options.defaultTimeoutMs ?? PLUGIN_UI_DEFAULT_TIMEOUT_MS;
		this.handshakeTimer = setTimeout(() => {
			if (this.generation === generation && this.port === port && this.state === "connecting") {
				this.crash("Plugin UI handshake timed out");
			}
		}, timeoutMs);
		try {
			iframe.contentWindow.postMessage(bootstrap, "*", [channel.port2]);
		} catch (error) {
			this.crash(asError(error, "Plugin iframe connection failed").message);
		}
	}

	reload(): void {
		this.disposePort();
		this.attachedIframe = null;
		this.nonce = createPluginNonce();
		this.srcdoc = this.createShell();
		this.error = undefined;
		this.setState("registered");
	}

	request(
		method: string,
		params?: JsonValue,
		timeoutMs = this.options.defaultTimeoutMs ?? PLUGIN_UI_DEFAULT_TIMEOUT_MS,
	): Promise<JsonValue> {
		const request = makeUiRequest(method, params);
		this.assertPayload(request, PLUGIN_UI_REQUEST_MAX_BYTES);
		if (!this.port || this.state !== "ready") {
			return Promise.reject(new Error("Plugin UI bridge is not ready"));
		}
		return new Promise<JsonValue>((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(request.id);
				this.sendNotification("rpc.cancel", { requestId: request.id });
				reject(Object.assign(new Error("Plugin UI request timed out"), { code: "TIMEOUT" }));
			}, timeoutMs);
			this.pending.set(request.id, { resolve, reject, timer });
			try {
				this.port?.postMessage(request);
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(request.id);
				reject(asError(error, "Plugin UI request failed"));
			}
		});
	}

	sendNotification(method: string, params?: JsonValue): void {
		if (!this.port || this.state !== "ready") return;
		const notification = makeUiNotification(method, params);
		this.assertPayload(notification, PLUGIN_UI_REQUEST_MAX_BYTES);
		this.port.postMessage(notification);
	}

	setVisibility(visible: boolean): void {
		if (this.visibility === visible) return;
		this.visibility = visible;
		this.sendNotification("panel.visibilityChanged", { visible });
	}

	setFocused(focused: boolean): void {
		if (this.focused === focused) return;
		this.focused = focused;
		this.sendNotification("panel.focusChanged", { focused });
	}

	setActive(active: boolean): void {
		if (this.active === active) return;
		this.active = active;
		this.sendNotification("panel.activeChanged", { active });
	}

	setSize(width: number, height: number): void {
		if (!Number.isFinite(width) || !Number.isFinite(height)) return;
		this.sendNotification("panel.sizeChanged", {
			width: Math.max(0, width),
			height: Math.max(0, height),
		});
	}

	dispose(): void {
		if (this.state === "disposed") return;
		this.setState("disposed");
		this.disposePort();
		this.attachedIframe = null;
	}

	private createShell(): string {
		return createPluginAssetShell({
			nonce: this.nonce,
			pluginId: this.params.pluginId,
			contributionId: this.params.contributionId,
			panelInstanceId: this.params.panelInstanceId,
			entryUrl: this.contribution.entryUrl,
			styleUrl: this.contribution.styleUrl,
			defaultTimeoutMs: this.options.defaultTimeoutMs,
		});
	}

	private handleMessage(event: MessageEvent, generation: number, port: MessagePort): void {
		if (generation !== this.generation || this.port !== port || this.state === "disposed") return;
		const maxBytes =
			event.data?.kind === "request" || event.data?.kind === "notification"
				? PLUGIN_UI_REQUEST_MAX_BYTES
				: PLUGIN_UI_RESPONSE_MAX_BYTES;
		if (jsonByteLength(event.data) > maxBytes) {
			this.crash("Plugin UI payload exceeds the protocol limit");
			return;
		}
		const parsed = uiRpcEnvelopeSchema.safeParse(event.data);
		if (!parsed.success) {
			this.crash("Plugin UI sent an invalid protocol envelope");
			return;
		}
		if (parsed.data.kind === "response") {
			const pending = this.pending.get(parsed.data.id);
			if (!pending) return;
			this.pending.delete(parsed.data.id);
			clearTimeout(pending.timer);
			if ("error" in parsed.data)
				pending.reject(Object.assign(new Error(parsed.data.error.message), parsed.data.error));
			else pending.resolve(parsed.data.result);
			return;
		}
		if (parsed.data.kind === "notification") {
			if (parsed.data.method === "rpc.cancel") {
				const requestId = this.readRequestId(parsed.data.params);
				if (requestId) this.inFlight.get(requestId)?.abort();
				return;
			}
			this.options.onNotification?.(this.params, parsed.data);
			return;
		}
		void this.handleRequest(parsed.data, generation, port);
	}

	private async handleRequest(
		request: UiRpcRequest,
		generation: number,
		port: MessagePort,
	): Promise<void> {
		if (generation !== this.generation || this.port !== port || this.state === "disposed") return;
		if (request.method === "handshake") {
			const handshake = uiHandshakeParamsSchema.safeParse(request.params);
			if (
				!handshake.success ||
				handshake.data.nonce !== this.nonce ||
				handshake.data.pluginId !== this.params.pluginId ||
				handshake.data.contributionId !== this.params.contributionId ||
				handshake.data.panelInstanceId !== this.params.panelInstanceId
			) {
				this.sendResponse(
					responseError(request.id, "INCOMPATIBLE", "Plugin UI handshake identity mismatch"),
					generation,
					port,
				);
				this.crash("Plugin UI handshake rejected");
				return;
			}
			if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
			this.handshakeTimer = null;
			this.setState("ready");
			const context = this.options.getContext?.(this.params);
			this.sendResponse(
				makeUiResponse(request.id, {
					protocolVersion: 1,
					context: context && isJsonValue(context) ? context : null,
				}),
				generation,
				port,
			);
			return;
		}
		if (this.state !== "ready") {
			this.sendResponse(
				responseError(request.id, "HOST_UNAVAILABLE", "Plugin UI bridge is not ready"),
				generation,
				port,
			);
			return;
		}
		const abort = new AbortController();
		this.inFlight.set(request.id, abort);
		try {
			if (!this.options.onRequest) {
				throw new PluginUiHostError("HOST_UNAVAILABLE", "No host handler is registered", {
					retryable: true,
				});
			}
			const result = await this.options.onRequest({
				params: this.params,
				request,
				signal: abort.signal,
			});
			if (!isJsonValueForRuntime(result)) throw new Error("Host returned a non-JSON value");
			const response = makeUiResponse(request.id, result);
			this.assertPayload(response, PLUGIN_UI_RESPONSE_MAX_BYTES);
			this.sendResponse(response, generation, port);
		} catch (error) {
			this.sendResponse(
				makeUiResponse(request.id, undefined, asUiRpcError(error, abort.signal.aborted)),
				generation,
				port,
			);
		} finally {
			this.inFlight.delete(request.id);
		}
	}

	private sendResponse(response: UiRpcResponse, generation?: number, port?: MessagePort): void {
		const target = port ?? this.port;
		if (
			!target ||
			(generation !== undefined && (generation !== this.generation || target !== this.port))
		)
			return;
		this.assertPayload(response, PLUGIN_UI_RESPONSE_MAX_BYTES);
		target.postMessage(response);
	}

	private readRequestId(value: unknown): string | undefined {
		if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
		const requestId = (value as Record<string, unknown>).requestId;
		return typeof requestId === "string" ? requestId : undefined;
	}

	private assertPayload(value: unknown, maxBytes: number): void {
		if (jsonByteLength(value) > maxBytes)
			throw new Error("Plugin UI payload exceeds the protocol limit");
	}

	private disposePort(): void {
		if (this.handshakeTimer) clearTimeout(this.handshakeTimer);
		this.handshakeTimer = null;
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(new Error("Plugin UI session disposed"));
		}
		this.pending.clear();
		for (const controller of this.inFlight.values()) controller.abort();
		this.inFlight.clear();
		if (this.port && this.portMessageHandler)
			this.port.removeEventListener("message", this.portMessageHandler);
		if (this.port && this.portMessageErrorHandler)
			this.port.removeEventListener("messageerror", this.portMessageErrorHandler);
		this.port?.close();
		this.port = null;
		this.portMessageHandler = null;
		this.portMessageErrorHandler = null;
	}

	private crash(message: string): void {
		this.error = message;
		this.diagnosticId = `pui_${this.params.panelInstanceId}_${this.generation}`;
		this.setState("crashed");
		this.disposePort();
	}

	private setState(state: PluginUiSessionSnapshot["status"]): void {
		this.state = state;
		this.options.onStateChange?.(this.getSnapshot());
	}
}

function isJsonValueForRuntime(value: unknown): value is JsonValue {
	return isJsonValue(value);
}

export { createUiRequestId, parsePluginDockPanelParams };
