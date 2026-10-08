const PLUGIN_ID = "com.example.provider";
const PLUGIN_VERSION = "1.0.1";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const RPC_PROTOCOL = "narrafork.rpc/1";
const PROVIDER_PROTOCOL = "1.0";
const MAX_HEADER_BYTES = 8 * 1024;
// Provider requests carry full histories; inbound host responses share this bounded parser.
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const headerBuffer = new Uint8Array(MAX_HEADER_BYTES + 4);
let headerLength = 0;
let bodyBuffer;
let bodyReceived = 0;
let framingPhase = "idle";
let initialized = false;
let active = false;
let runtimeId;
let generation;

function append(left, right) {
	const next = new Uint8Array(left.byteLength + right.byteLength);
	next.set(left);
	next.set(right, left.byteLength);
	return next;
}

function contentLength(header) {
	let length;
	for (const line of header.split("\r\n")) {
		const separator = line.indexOf(":");
		if (separator <= 0) throw new Error("invalid RPC header");
		if (line.slice(0, separator).trim().toLowerCase() !== "content-length") continue;
		if (length !== undefined) throw new Error("duplicate Content-Length header");
		const value = line.slice(separator + 1).trim();
		if (!/^\d+$/.test(value)) throw new Error("invalid Content-Length header");
		length = Number(value);
	}
	if (!Number.isSafeInteger(length)) throw new Error("missing Content-Length header");
	return length;
}

function send(message, callback) {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(append(header, body), callback);
}

function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}

function reject(id, code, message, data) {
	send({
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	});
}

function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}

function describeProvider(id, params) {
	const versions = Array.isArray(params?.protocolVersions) ? params.protocolVersions : [];
	if (!versions.includes(PROVIDER_PROTOCOL)) {
		reject(id, -32001, "No supported provider protocol version", {
			code: "INCOMPATIBLE",
			offered: versions,
		});
		return;
	}
	respond(id, {
		selectedProtocolVersion: PROVIDER_PROTOCOL,
		plugin: { id: PLUGIN_ID, name: "Example Provider", version: PLUGIN_VERSION },
		providers: [
			{
				localId: "example-provider",
				displayName: "Example Provider",
				description: "Deterministic offline provider used by release validation.",
				defaultModelId: "example/offline",
				configSchema: {
					type: "object",
					properties: {
						apiMode: {
							type: "string",
							title: "Reply style",
							description: "Chooses which deterministic reply the provider streams.",
							enum: ["offline", "verbose"],
							default: "offline",
						},
						// Declared with the spelling `04-server-rpc-and-provider.md` specifies.
						// The host routes such a field to its secret vault and merges the stored
						// value back into `config` for each call, so it must never carry a
						// `default` and is never echoed back to any UI.
						apiKey: {
							type: "string",
							title: "API key",
							description: "Optional credential; demonstrates host-side secret injection.",
							writeOnly: true,
							"x-narrafork-secret": true,
						},
					},
					additionalProperties: false,
				},
				capabilities: {
					validateConfig: true,
					listModels: true,
					chat: true,
					generate: false,
				},
				limits: {
					maxConcurrentChat: 2,
					maxConcurrentGenerate: 1,
					maxConfigBytes: 4096,
					maxModelPageSize: 10,
				},
			},
		],
	});
}

function listModels(id, params) {
	if (params?.providerTypeId !== `${PLUGIN_ID}/example-provider`) {
		reject(id, -32602, "Unknown provider type", { code: "INVALID_PARAMS" });
		return;
	}
	respond(id, {
		models: [
			{
				id: "example/offline",
				displayName: "Example Offline Model",
				description: "A deterministic model that does not use network access.",
				contextWindow: 4096,
				maxOutputTokens: 512,
				capabilities: {
					chat: true,
					generate: false,
					streaming: true,
					tools: false,
					sessionMode: "stateless",
				},
			},
		],
		catalogVersion: "example-1",
		cacheTtlMs: 60_000,
	});
}

// --- Streaming chat -------------------------------------------------------
//
// Operations are tracked so `provider.cancel` can stop an in-flight stream. Each
// operation emits `provider.event` notifications with a monotonic `seq`, then
// exactly one terminal event (`done` or `error`). The host rejects any event that
// arrives before the accept response, so emission is deferred until after it.

const operations = new Map();

function emit(operationId, event) {
	const operation = operations.get(operationId);
	if (!operation) return;
	operation.seq += 1;
	send({
		jsonrpc: "2.0",
		method: "provider.event",
		params: {
			protocolVersion: PROVIDER_PROTOCOL,
			operationId,
			seq: operation.seq,
			event,
		},
	});
}

function finishOperation(operationId, event) {
	const operation = operations.get(operationId);
	if (!operation) return;
	if (operation.timer) clearTimeout(operation.timer);
	// A dump-captured operation reports the upstream response before the terminal event:
	// `done`/`error` close the stream, so dump evidence must precede them.
	if (operation.dump) {
		emit(operationId, {
			type: "dump.response",
			status: 200,
			headers: { "content-type": "text/event-stream" },
		});
		emit(operationId, {
			type: "dump.response",
			bodyChunk: operation.words.join(""),
			final: true,
		});
	}
	emit(operationId, event);
	operations.delete(operationId);
}

/**
 * Report the upstream request for a dump-captured call.
 *
 * The hard rule: dump events may be emitted ONLY when the chat params carried
 * `requestDump` — the field's presence is the whole compatibility negotiation, and
 * hosts predating these event types kill the connection on unknown event types. Bodies
 * travel in ≤64KiB chunks to respect the 256KiB frame limit. The host re-masks
 * credentials (it knows the values it handed over in `config`), so this plugin reports
 * the true header shape without echoing the key itself.
 */
function emitDumpRequest(operationId, params) {
	const body = JSON.stringify({
		model: params?.modelId,
		input: params?.request?.current?.text ?? "",
	});
	emit(operationId, {
		type: "dump.request",
		transport: "mock",
		url: "https://api.example.invalid/v1/chat",
		headers: { "content-type": "application/json", authorization: "Bearer ***" },
		bodyChunk: body.slice(0, 64 * 1024),
		final: true,
		truncated: body.length > 64 * 1024,
	});
}

/**
 * Deterministic word-by-word replies so tests can assert exact streamed text.
 *
 * Two variants exist so `apiMode` has an observable effect: a config value that changes
 * nothing cannot demonstrate that host-side persistence actually reaches the plugin.
 */
const CHAT_WORDS_BY_MODE = {
	offline: ["Hello", " from", " the", " example", " provider", "."],
	verbose: ["Hello", " from", " the", " example", " provider", " in", " verbose", " mode", "."],
};

/**
 * Appended so credential injection is observable end to end.
 *
 * The plugin reports only whether a key arrived, never any part of its value: a real
 * provider would send it upstream, and echoing it into the stream would write the
 * credential into stored narrator messages.
 */
const AUTH_WORDS = {
	authenticated: [" [authenticated]"],
	anonymous: [" [anonymous]"],
};

/** Fall back to `offline` for an absent or unknown mode, matching the schema default. */
function chatWordsFor(config) {
	const record = object(config);
	const mode = record?.apiMode;
	const words = CHAT_WORDS_BY_MODE[mode] ?? CHAT_WORDS_BY_MODE.offline;
	// An unset secret is absent from `config` rather than empty, which is what lets a
	// real provider distinguish "not configured" from "configured as empty".
	const apiKey = record?.apiKey;
	const authenticated = typeof apiKey === "string" && apiKey.length > 0;
	return [...words, ...(authenticated ? AUTH_WORDS.authenticated : AUTH_WORDS.anonymous)];
}

function streamChat(operationId) {
	const operation = operations.get(operationId);
	if (!operation) return;
	const words = operation.words;
	if (operation.wordIndex >= words.length) {
		finishOperation(operationId, {
			type: "done",
			status: "completed",
			stopReason: "end_turn",
			usage: { inputTokens: 8, completionTokens: words.length },
		});
		return;
	}
	emit(operationId, {
		type: "text.delta",
		text: words[operation.wordIndex],
		outputIndex: 0,
	});
	operation.wordIndex += 1;
	// A real provider streams as bytes arrive; the small delay here keeps the stream
	// observable so a cancel can land mid-stream.
	operation.timer = setTimeout(() => streamChat(operationId), 5);
}

function startChat(id, params) {
	const operationId = typeof params?.operationId === "string" ? params.operationId : undefined;
	if (!operationId) {
		reject(id, -32602, "chat requires an operationId", { code: "INVALID_PARAMS" });
		return;
	}
	if (params?.providerTypeId !== `${PLUGIN_ID}/example-provider`) {
		reject(id, -32602, "Unknown provider type", { code: "INVALID_PARAMS" });
		return;
	}
	// Resolve the reply once per operation so a mid-stream config change cannot splice
	// two different replies into one response.
	operations.set(operationId, {
		seq: 0,
		wordIndex: 0,
		timer: undefined,
		words: chatWordsFor(params?.config),
		// The host opts into dump capture per call via `params.requestDump`; without the
		// hint this plugin must never emit dump.request/dump.response events.
		dump: typeof params?.requestDump?.maxBytes === "number",
	});
	// Accept first: the host treats an event before the accept as a protocol error.
	send({ jsonrpc: "2.0", id, result: { operationId, accepted: true } }, () => {
		const operation = operations.get(operationId);
		if (!operation) return;
		if (operation.dump) emitDumpRequest(operationId, params);
		operation.timer = setTimeout(() => streamChat(operationId), 5);
	});
}

function cancelOperation(id, params) {
	const operationId = typeof params?.operationId === "string" ? params.operationId : undefined;
	if (!operationId) {
		reject(id, -32602, "cancel requires an operationId", { code: "INVALID_PARAMS" });
		return;
	}
	if (!operations.has(operationId)) {
		respond(id, { operationId, state: "unknown_operation" });
		return;
	}
	respond(id, { operationId, state: "cancelling" });
	// A cancelled operation still owes the host exactly one terminal event.
	finishOperation(operationId, { type: "done", status: "cancelled", stopReason: "cancelled" });
}

function handleRequest(message) {
	const params = object(message.params);
	switch (message.method) {
		case "initialize":
			if (params?.protocol !== RPC_PROTOCOL || params.pluginId !== PLUGIN_ID) {
				reject(message.id, -32602, "initialize identity or protocol mismatch", {
					code: "INVALID_PARAMS",
				});
				return;
			}
			runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
			generation = typeof params.generation === "number" ? params.generation : undefined;
			initialized = true;
			respond(message.id, { initialized: true, protocol: RPC_PROTOCOL });
			return;
		case "activate":
			if (!initialized) {
				reject(message.id, -32603, "Plugin must be initialized before activation");
				return;
			}
			active = true;
			respond(message.id, { activated: true });
			return;
		case "health":
			respond(message.id, {
				healthy: initialized && active,
				status: active ? "ready" : "inactive",
				runtimeId,
				generation,
			});
			return;
		case "provider.describe":
			if (!active) {
				reject(message.id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			describeProvider(message.id, params);
			return;
		case "provider.validateConfig": {
			// The host validates against the schema already; this reports the resolved mode
			// back so a caller can confirm which reply the provider would stream.
			const mode = object(params?.config)?.apiMode;
			if (mode !== undefined && !(mode in CHAT_WORDS_BY_MODE)) {
				respond(message.id, {
					valid: false,
					issues: [{ path: "/apiMode", message: "must be offline or verbose" }],
				});
				return;
			}
			respond(message.id, {
				valid: true,
				issues: [],
				capabilities: { offline: true, apiMode: mode ?? "offline" },
			});
			return;
		}
		case "provider.listModels":
			listModels(message.id, params);
			return;
		case "provider.chat":
			if (!active) {
				reject(message.id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
				return;
			}
			startChat(message.id, params);
			return;
		case "provider.cancel":
			cancelOperation(message.id, params);
			return;
		case "deactivate":
			active = false;
			for (const operationId of [...operations.keys()]) {
				finishOperation(operationId, {
					type: "done",
					status: "cancelled",
					stopReason: "cancelled",
				});
			}
			respond(message.id, { deactivated: true });
			return;
		case "shutdown":
			active = false;
			initialized = false;
			for (const operation of operations.values()) {
				if (operation.timer) clearTimeout(operation.timer);
			}
			operations.clear();
			send({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } }, () => {
				process.exit(0);
			});
			return;
		default:
			reject(message.id, -32601, `Unknown method: ${message.method}`, {
				code: "METHOD_NOT_FOUND",
			});
	}
}

function handleMessage(message) {
	if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
	if (!("id" in message)) return;
	handleRequest(message);
}

function parseFrames(chunk) {
	let offset = 0;
	while (offset < chunk.byteLength) {
		if (bodyBuffer === undefined) {
			framingPhase = "header";
			headerBuffer[headerLength++] = chunk[offset++];
			const delimiter = headerLength - 4;
			if (
				delimiter < 0 ||
				headerBuffer[delimiter] !== 13 ||
				headerBuffer[delimiter + 1] !== 10 ||
				headerBuffer[delimiter + 2] !== 13 ||
				headerBuffer[delimiter + 3] !== 10
			) {
				if (headerLength === headerBuffer.byteLength) throw new Error("RPC header exceeds limit");
				continue;
			}
			const length = contentLength(decoder.decode(headerBuffer.subarray(0, delimiter)));
			if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
			// Allocate exactly once, after validating Content-Length. Geometric growth,
			// per-chunk copies and a final body slice amplify large requests and can
			// exhaust the production runner's address-space limit before decoding.
			framingPhase = "body-allocation";
			bodyBuffer = new Uint8Array(length);
			headerLength = 0;
		}
		framingPhase = "body-copy";
		const count = Math.min(bodyBuffer.byteLength - bodyReceived, chunk.byteLength - offset);
		bodyBuffer.set(chunk.subarray(offset, offset + count), bodyReceived);
		offset += count;
		bodyReceived += count;
		if (bodyReceived < bodyBuffer.byteLength) continue;
		framingPhase = "body-decode";
		const json = decoder.decode(bodyBuffer);
		framingPhase = "json-parse";
		const message = JSON.parse(json);
		bodyBuffer = undefined;
		bodyReceived = 0;
		framingPhase = "dispatch";
		handleMessage(message);
	}
}

process.stdin.on("data", (chunk) => {
	try {
		parseFrames(chunk);
	} catch (error) {
		// Diagnostics only; never log request content or JSON parse error messages.
		process.stderr.write(
			`RPC framing failure (${error instanceof Error ? error.name : "unknown"}, phase=${framingPhase}, buffered=${headerLength + bodyReceived})\n`,
		);
		process.exit(2);
	}
});

process.stdin.on("end", () => process.exit(0));

send({
	jsonrpc: "2.0",
	method: "hello",
	params: {
		pluginId: PLUGIN_ID,
		version: PLUGIN_VERSION,
		rpcProtocol: RPC_PROTOCOL,
		...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),
		// A streaming provider must negotiate these: the host drops `provider.event`
		// notifications from a plugin that did not declare `host_api.notifications`,
		// and `rpc.cancel` is required to stop an in-flight stream.
		features: ["host_api.notifications", "rpc.cancel"],
	},
});
