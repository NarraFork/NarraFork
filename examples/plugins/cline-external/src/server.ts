/**
 * `cline-external` plugin backend.
 *
 * Serves Cline as an out-of-process provider plugin, alongside the built-in adapter rather
 * than replacing it. The two use different provider prefixes (`cline-ext` vs `cline`) and
 * separate credential storage, so they can run side by side for comparison — and so the
 * built-in one can be deleted later without a migration step.
 *
 * ## How credentials arrive
 *
 * On provider calls the host resolves this plugin's secret fields from its vault and includes
 * them in `config` (`plugin-provider-credential-resolver.ts`). On command calls it does not,
 * because `commands.invoke` has no config field — those read the vault over `secrets.get`.
 * Both paths funnel through `credentials.ts`.
 *
 * ## What is not reused from the host
 *
 * shares no module with the core. The built-in Cline code reaches the host's home directory
 * and settings, which a plugin must not touch, and keeping the two independent is what allows
 * the built-in adapter to be removed when this replaces it.
 */

import {
	AuthInputError,
	buildOpenRouterHeaders,
	DEFAULT_CHAT_BASE_URL,
	PortInUseError,
	withWorkosPrefix,
} from "./auth";
import { CommandInputError, cancelPendingAuth, findCommand } from "./commands";
import {
	accessTokenFor,
	credentialsFromConfig,
	MissingCredentialError,
	parseEnabledModels,
	resetCredentialCache,
} from "./credentials";
import {
	classifyClineError,
	consumeStream,
	type PluginStreamEvent,
	StreamMapper,
	UsageAccumulator,
} from "./event-mapping";
import { pfetch, resetProxyAgents } from "./fetch";
import {
	appendCurrentTurn,
	convertHistory,
	convertTools,
	type OpenAiMessage,
	withSystemPrompt,
} from "./history";
import { activeProxyUrl, applyHostHints } from "./host-hints";
import { buildCatalog, contextWindowFor, resetModelCaches } from "./models";
import {
	isRecord,
	type JsonRpcRequest,
	listen,
	notify,
	RPC_PROTOCOL,
	reject,
	respond,
	send,
} from "./rpc";

const PLUGIN_ID = "com.narrafork.cline-external";
const PLUGIN_VERSION = "0.1.4";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const PROVIDER_PROTOCOL = "1.0";
const LOCAL_ID = "cline";

let initialized = false;
let active = false;
let runtimeId: string | undefined;
let generation: number | undefined;

interface Operation {
	seq: number;
	controller: AbortController;
}

const operations = new Map<string, Operation>();

function emit(operationId: string, event: PluginStreamEvent): void {
	const operation = operations.get(operationId);
	if (!operation) return;
	operation.seq += 1;
	notify("provider.event", {
		protocolVersion: PROVIDER_PROTOCOL,
		operationId,
		seq: operation.seq,
		event,
	});
}

/** Emit the single terminal event an operation owes the host, then forget it. */
function finish(operationId: string, event: PluginStreamEvent): void {
	if (!operations.has(operationId)) return;
	emit(operationId, event);
	operations.delete(operationId);
}

function configOf(params: unknown): Record<string, unknown> {
	const config = isRecord(params) ? params.config : undefined;
	return isRecord(config) ? config : {};
}

function chatBaseOf(config: Record<string, unknown>): string {
	const raw = config.baseUrl;
	const base = typeof raw === "string" ? raw.trim() : "";
	return (base || DEFAULT_CHAT_BASE_URL).replace(/\/+$/, "");
}

function modelOf(params: unknown): string {
	return isRecord(params) && typeof params.modelId === "string" ? params.modelId : "";
}

function describeProvider(id: string | number, params: unknown): void {
	const versions =
		isRecord(params) && Array.isArray(params.protocolVersions) ? params.protocolVersions : [];
	if (!versions.includes(PROVIDER_PROTOCOL)) {
		reject(id, -32001, "No supported provider protocol version", {
			code: "INCOMPATIBLE",
			offered: versions,
		});
		return;
	}
	respond(id, {
		selectedProtocolVersion: PROVIDER_PROTOCOL,
		plugin: { id: PLUGIN_ID, name: "Cline (External)", version: PLUGIN_VERSION },
		providers: [
			{
				localId: LOCAL_ID,
				displayName: "Cline (External)",
				description: "Models from the Cline API gateway, which proxies OpenRouter.",
				defaultModelId: "anthropic/claude-sonnet-4.6",
				configSchema: {
					type: "object",
					properties: {
						credentials: { type: "string", writeOnly: true, "x-narrafork-secret": true },
						// Not confidential. It travels as a secret because that is the only
						// persistence a command can write which the host injects back into
						// provider calls; see `credentials.ts`.
						enabledModels: { type: "string", writeOnly: true, "x-narrafork-secret": true },
						baseUrl: { type: "string", default: DEFAULT_CHAT_BASE_URL },
					},
					additionalProperties: false,
				},
				capabilities: {
					validateConfig: true,
					listModels: true,
					chat: true,
					generate: true,
					// OpenAI chat/completions has no slot for returning a thinking block, so a
					// continuation cannot be honoured. Claiming it would have the host send back
					// metadata this provider must then drop.
					reasoningContinuation: false,
					inputImages: true,
				},
				limits: {
					maxConcurrentChat: 2,
					maxConcurrentGenerate: 1,
					maxConfigBytes: 131_072,
					maxModelPageSize: 50,
				},
			},
		],
	});
}

/**
 * The model catalog for the user's enabled selection.
 *
 * Never calls upstream. The host refreshes catalogs on a schedule the user never sees, so a
 * third-party round-trip here would make the provider appear broken whenever OpenRouter is
 * slow; missing metadata degrades to a default context window instead. The pool is fetched by
 * the `models.search` / `models.refresh` commands, where a user is actually waiting.
 */
function listModels(id: string | number, params: unknown): void {
	applyHostHints(params);
	const config = configOf(params);
	respond(id, buildCatalog(parseEnabledModels(config.enabledModels)));
}

async function validateConfig(id: string | number, params: unknown): Promise<void> {
	applyHostHints(params);
	const config = configOf(params);

	let credentials: ReturnType<typeof credentialsFromConfig>;
	try {
		credentials = credentialsFromConfig(config);
	} catch (error) {
		respond(id, {
			valid: false,
			issues: [
				{
					path: "/credentials",
					message: error instanceof Error ? error.message : "Credentials are unreadable",
				},
			],
		});
		return;
	}
	if (!credentials) {
		respond(id, {
			valid: false,
			issues: [{ path: "/credentials", message: "Cline is not signed in" }],
		});
		return;
	}

	// Only `connectivity` justifies a network call; syntax validation runs on form input and
	// must not spend a round-trip per keystroke.
	const mode = isRecord(params) && params.mode === "connectivity" ? "connectivity" : "syntax";
	if (mode !== "connectivity") {
		respond(id, { valid: true, issues: [] });
		return;
	}

	try {
		await accessTokenFor(credentials, chatBaseOf(config), activeProxyUrl());
		const enabled = parseEnabledModels(config.enabledModels);
		respond(id, {
			valid: true,
			issues: [],
			capabilities: { modelCount: enabled.length },
		});
	} catch (error) {
		respond(id, {
			valid: false,
			issues: [
				{
					path: "/credentials",
					message: error instanceof Error ? error.message : "Could not reach Cline",
				},
			],
		});
	}
}

/** Headers for a gateway call. */
function chatHeaders(accessToken: string): Record<string, string> {
	return {
		...buildOpenRouterHeaders(),
		"Content-Type": "application/json",
		Authorization: `Bearer ${withWorkosPrefix(accessToken)}`,
	};
}

/** An upstream failure carrying its status, so `classifyClineError` can categorise it. */
class UpstreamError extends Error {
	readonly statusCode: number;
	constructor(status: number, body: string) {
		super(`Cline API error ${status}${body ? `: ${body.slice(0, 500)}` : ""}`);
		this.name = "UpstreamError";
		this.statusCode = status;
	}
}

/**
 * How much of an error response body to read before giving up on it.
 *
 * `UpstreamError` truncates to 500 characters for its message anyway, so reading more than a
 * few KB is pure waste — and a gateway that answers an error with an HTML page (or an endless
 * body) must not be able to make the failure path itself expensive.
 */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

/**
 * Read at most `MAX_ERROR_BODY_BYTES` of a failed response, for diagnostics only.
 *
 * Never throws: this runs while already handling a failure, and losing the detail is always
 * preferable to replacing the real status with a read error.
 */
async function readErrorBody(response: Response): Promise<string> {
	if (!response.body) return "";
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	let bytes = 0;
	try {
		while (bytes < MAX_ERROR_BODY_BYTES) {
			const { done, value } = await reader.read();
			if (done) break;
			bytes += value.byteLength;
			text += decoder.decode(value, { stream: true });
		}
	} catch {
		// Keep whatever arrived before the read failed.
	} finally {
		reader.releaseLock();
		void response.body.cancel().catch(() => undefined);
	}
	return text.slice(0, MAX_ERROR_BODY_BYTES);
}

/**
 * POST to the gateway and return the streaming body.
 *
 * The operation's `signal` is passed through, which deliberately opts out of `pfetch`'s
 * default timeout: a completion legitimately takes minutes, so the only thing entitled to end
 * it is the host cancelling the operation or `consumeStream`'s own bounds.
 */
async function openStream(
	baseUrl: string,
	accessToken: string,
	body: Record<string, unknown>,
	signal: AbortSignal,
	proxyUrl: string | undefined,
): Promise<ReadableStream<Uint8Array>> {
	const response = await pfetch(
		`${baseUrl}/chat/completions`,
		{
			method: "POST",
			headers: chatHeaders(accessToken),
			body: JSON.stringify(body),
			signal,
		},
		proxyUrl,
	);
	if (!response.ok) {
		throw new UpstreamError(response.status, await readErrorBody(response));
	}
	if (!response.body) throw new Error("Cline API returned no response body");
	return response.body;
}

async function startChat(id: string | number, params: unknown): Promise<void> {
	applyHostHints(params);
	const operationId =
		isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
	if (!operationId) {
		reject(id, -32602, "chat requires an operationId", { code: "INVALID_PARAMS" });
		return;
	}
	if (operations.has(operationId)) {
		reject(id, -32602, "duplicate operationId", { code: "INVALID_PARAMS" });
		return;
	}

	const config = configOf(params);
	const request = isRecord(params) ? params.request : undefined;
	const modelId = modelOf(params);

	const controller = new AbortController();
	operations.set(operationId, { seq: 0, controller });
	// Accept first: the host rejects any `provider.event` that arrives before this response.
	respond(id, { accepted: true, operationId });

	const usage = new UsageAccumulator();
	usage.setContextWindow(contextWindowFor(modelId));
	const mapper = new StreamMapper(usage);

	try {
		const credentials = credentialsFromConfig(config);
		if (!credentials) throw new MissingCredentialError();
		const baseUrl = chatBaseOf(config);
		const proxyUrl = activeProxyUrl();
		const accessToken = await accessTokenFor(credentials, baseUrl, proxyUrl);

		const messages = convertHistory(
			isRecord(request) && Array.isArray(request.history) ? request.history : [],
		);
		appendCurrentTurn(
			messages,
			isRecord(isRecord(request) ? request.current : undefined)
				? (request as { current: Record<string, unknown> }).current
				: {},
		);
		const tools = convertTools(
			isRecord(request) && Array.isArray(request.tools) ? request.tools : [],
		);

		const body: Record<string, unknown> = {
			model: modelId,
			messages,
			stream: true,
			stream_options: { include_usage: true },
		};
		if (tools.length > 0) body.tools = tools;

		emit(operationId, { type: "request_started" });

		const stream = await openStream(baseUrl, accessToken, body, controller.signal, proxyUrl);
		await consumeStream(stream, mapper, (event) => emit(operationId, event), controller.signal);

		if (controller.signal.aborted) {
			finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
			return;
		}
		finish(operationId, mapper.finalEvent());
	} catch (error) {
		const classified = classifyClineError(error);
		if (classified.classification === "cancelled") {
			finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
			return;
		}
		// One terminal event is owed even on failure, so report the error then close the stream.
		emit(operationId, { type: "error", error: classified });
		finish(operationId, {
			type: "done",
			status: "failed",
			stopReason: "error",
			...(usage.snapshot() ? { usage: usage.snapshot() } : {}),
		});
	}
}

/**
 * `provider.generate` — a separate implementation, not a re-route into chat.
 *
 * The host sends `request: {mode: "prompt", text, systemInstruction?}` or
 * `{mode: "history", systemInstruction, content, locale?}`, which shares no shape with a chat
 * handler, which reads `request.current.text` — a field that does not exist on either generate
 * shape, so it sends an empty prompt. That bug is not reproduced here.
 *
 * Streams like chat (the host consumes generate through the same accepted/event/done triple)
 * but sends no tools, because the host throws if a generate operation emits a tool event.
 */
async function startGenerate(id: string | number, params: unknown): Promise<void> {
	applyHostHints(params);
	const operationId =
		isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
	if (!operationId) {
		reject(id, -32602, "generate requires an operationId", { code: "INVALID_PARAMS" });
		return;
	}
	if (operations.has(operationId)) {
		reject(id, -32602, "duplicate operationId", { code: "INVALID_PARAMS" });
		return;
	}

	const config = configOf(params);
	const request = isRecord(params) ? params.request : undefined;
	const modelId = modelOf(params);

	const controller = new AbortController();
	operations.set(operationId, { seq: 0, controller });
	respond(id, { accepted: true, operationId });

	const usage = new UsageAccumulator();
	usage.setContextWindow(contextWindowFor(modelId));
	const mapper = new StreamMapper(usage);

	try {
		const credentials = credentialsFromConfig(config);
		if (!credentials) throw new MissingCredentialError();
		const baseUrl = chatBaseOf(config);
		const proxyUrl = activeProxyUrl();
		const accessToken = await accessTokenFor(credentials, baseUrl, proxyUrl);

		emit(operationId, { type: "request_started" });

		const stream = await openStream(
			baseUrl,
			accessToken,
			{
				model: modelId,
				messages: generateMessages(request),
				stream: true,
				stream_options: { include_usage: true },
			},
			controller.signal,
			proxyUrl,
		);
		await consumeStream(
			stream,
			mapper,
			(event) => {
				// Defensive: a generate stream must not carry tool events, and the host throws if
				// one arrives. A model that emits an unsolicited tool call (none were offered)
				// would otherwise fail the whole operation instead of producing its text.
				if (event.type.startsWith("tool_call.")) return;
				emit(operationId, event);
			},
			controller.signal,
		);

		if (controller.signal.aborted) {
			finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
			return;
		}
		finish(operationId, mapper.finalEvent());
	} catch (error) {
		const classified = classifyClineError(error);
		if (classified.classification === "cancelled") {
			finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
			return;
		}
		emit(operationId, { type: "error", error: classified });
		finish(operationId, {
			type: "done",
			status: "failed",
			stopReason: "error",
			...(usage.snapshot() ? { usage: usage.snapshot() } : {}),
		});
	}
}

/** Build the message list for either generate mode. */
export function generateMessages(request: unknown): OpenAiMessage[] {
	if (!isRecord(request)) return [];
	if (request.mode === "history") {
		const systemInstruction =
			typeof request.systemInstruction === "string" ? request.systemInstruction : "";
		const content = typeof request.content === "string" ? request.content : "";
		return withSystemPrompt(
			content ? [{ role: "user", content }] : [],
			systemInstruction || undefined,
		);
	}
	// `mode: "prompt"`, and also the fallback for an unrecognised mode: a prompt is the
	// simpler shape, so treating an unknown mode as one degrades to sending the text rather
	// than sending nothing.
	const text = typeof request.text === "string" ? request.text : "";
	const systemInstruction =
		typeof request.systemInstruction === "string" ? request.systemInstruction : "";
	return withSystemPrompt(
		text ? [{ role: "user", content: text }] : [],
		systemInstruction || undefined,
	);
}

function cancelOperation(id: string | number, params: unknown): void {
	const operationId =
		isRecord(params) && typeof params.operationId === "string" ? params.operationId : undefined;
	if (!operationId) {
		reject(id, -32602, "cancel requires an operationId", { code: "INVALID_PARAMS" });
		return;
	}
	const operation = operations.get(operationId);
	if (!operation) {
		respond(id, { operationId, state: "unknown_operation" });
		return;
	}
	respond(id, { operationId, state: "cancelling" });
	operation.controller.abort();
	finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
}

/**
 * Handle `commands.invoke` — the settings view's entire action surface.
 *
 * Commands receive no config (see `credentials.ts`), so `chatBaseUrl` is passed only when the
 * caller happened to include one; handlers fall back to the default otherwise.
 */
async function invokeCommand(id: string | number, params: unknown): Promise<void> {
	const contributionId = isRecord(params) ? params.contributionId : undefined;
	if (typeof contributionId !== "string") {
		reject(id, -32602, "commands.invoke requires a contributionId", { code: "INVALID_PARAMS" });
		return;
	}
	const handler = findCommand(contributionId);
	if (!handler) {
		reject(id, -32601, `Unknown command: ${contributionId}`, { code: "METHOD_NOT_FOUND" });
		return;
	}
	const input = isRecord(params) ? params.input : undefined;
	const chatBaseUrl =
		isRecord(input) && typeof input.chatBaseUrl === "string" ? input.chatBaseUrl : undefined;

	try {
		const result = await handler(input, { ...(chatBaseUrl ? { chatBaseUrl } : {}) });
		respond(id, {
			...(result.output === undefined ? {} : { output: result.output as never }),
			...(result.secretWrites && result.secretWrites.length > 0
				? { secretWrites: result.secretWrites }
				: {}),
			// Non-secret provider settings. Omitted when empty so the response shape is
			// unchanged for the commands that do not persist config.
			...(result.configWrites && result.configWrites.length > 0
				? { configWrites: result.configWrites }
				: {}),
		});
	} catch (error) {
		if (error instanceof CommandInputError || error instanceof AuthInputError) {
			reject(id, -32602, error.message, { code: "INVALID_PARAMS" });
			return;
		}
		if (error instanceof PortInUseError) {
			reject(id, -32603, error.message, { code: "PORT_IN_USE" });
			return;
		}
		const classified = classifyClineError(error);
		reject(id, -32603, classified.message, { code: classified.code });
	}
}

/** Abort every operation and release the sign-in listener. */
function teardown(): void {
	for (const operationId of [...operations.keys()]) {
		operations.get(operationId)?.controller.abort();
		finish(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
	}
	// Without this the loopback port stays bound with no flow attached to it, and the next
	// sign-in — in this process or the built-in adapter — cannot bind.
	cancelPendingAuth("Plugin is shutting down");
	resetCredentialCache();
	resetModelCaches();
	resetProxyAgents();
}

function handleRequest(message: JsonRpcRequest): void {
	const { id, method, params } = message;
	switch (method) {
		case "initialize": {
			const record = isRecord(params) ? params : {};
			if (record.protocol !== RPC_PROTOCOL || record.pluginId !== PLUGIN_ID) {
				reject(id, -32602, "initialize identity or protocol mismatch", { code: "INVALID_PARAMS" });
				return;
			}
			runtimeId = typeof record.runtimeId === "string" ? record.runtimeId : undefined;
			generation = typeof record.generation === "number" ? record.generation : undefined;
			initialized = true;
			respond(id, { initialized: true, protocol: RPC_PROTOCOL });
			return;
		}
		case "activate":
			if (!initialized) {
				reject(id, -32603, "Plugin must be initialized before activation");
				return;
			}
			active = true;
			respond(id, { activated: true });
			return;
		case "health":
			respond(id, {
				healthy: initialized && active,
				status: active ? "ready" : "inactive",
				runtimeId,
				generation,
			});
			return;
		case "provider.describe":
			if (!active) {
				reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			describeProvider(id, params);
			return;
		case "provider.validateConfig":
			void validateConfig(id, params).catch((error: unknown) => {
				reject(id, -32603, classifyClineError(error).message, { code: "INTERNAL" });
			});
			return;
		case "provider.listModels":
			// Deliberately answerable before activation: the host refreshes catalogs for every
			// registered provider, and reporting an empty catalog is more useful than an error.
			listModels(id, params);
			return;
		case "provider.chat":
			if (!active) {
				reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			void startChat(id, params);
			return;
		case "provider.generate":
			if (!active) {
				reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			void startGenerate(id, params);
			return;
		case "provider.cancel":
			cancelOperation(id, params);
			return;
		case "commands.invoke":
			if (!active) {
				reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			void invokeCommand(id, params);
			return;
		case "deactivate":
			active = false;
			teardown();
			respond(id, { deactivated: true });
			return;
		case "shutdown":
			active = false;
			initialized = false;
			teardown();
			operations.clear();
			send({ jsonrpc: "2.0", id, result: { shutdown: true } }, () => process.exit(0));
			return;
		default:
			reject(id, -32601, `Unknown method: ${method}`, { code: "METHOD_NOT_FOUND" });
	}
}

listen(handleRequest);

send({
	jsonrpc: "2.0",
	method: "hello",
	params: {
		pluginId: PLUGIN_ID,
		version: PLUGIN_VERSION,
		rpcProtocol: RPC_PROTOCOL,
		...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),
		// `host_api.notifications`: required — the host drops `provider.event` without it.
		// `rpc.cancel`: required — cancellation support.
		// `host_api.requests`: required — commands read and write credentials with
		// `secrets.get`/`secrets.set`, which are Plugin→Host requests.
		features: ["host_api.notifications", "rpc.cancel", "host_api.requests"],
	},
});
