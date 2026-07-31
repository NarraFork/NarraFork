const PLUGIN_ID = "com.example.provider";
const PLUGIN_VERSION = "1.0.0";
const RPC_PROTOCOL = "narrafork.rpc/1";
const PROVIDER_PROTOCOL = "1.0";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = new Uint8Array(0);
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

function delimiterIndex(bytes) {
	for (let index = 0; index <= bytes.byteLength - 4; index += 1) {
		if (
			bytes[index] === 13 &&
			bytes[index + 1] === 10 &&
			bytes[index + 2] === 13 &&
			bytes[index + 3] === 10
		) {
			return index;
		}
	}
	return -1;
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
	emit(operationId, event);
	operations.delete(operationId);
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

/** Fall back to `offline` for an absent or unknown mode, matching the schema default. */
function chatWordsFor(config) {
	const mode = object(config)?.apiMode;
	return CHAT_WORDS_BY_MODE[mode] ?? CHAT_WORDS_BY_MODE.offline;
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
	});
	// Accept first: the host treats an event before the accept as a protocol error.
	send({ jsonrpc: "2.0", id, result: { operationId, accepted: true } }, () => {
		const operation = operations.get(operationId);
		if (!operation) return;
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

function parseFrames() {
	while (buffer.byteLength > 0) {
		const delimiter = delimiterIndex(buffer);
		if (delimiter < 0) {
			if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			return;
		}
		if (delimiter > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
		const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
		if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
		const bodyStart = delimiter + 4;
		const frameEnd = bodyStart + length;
		if (buffer.byteLength < frameEnd) return;
		const message = JSON.parse(decoder.decode(buffer.slice(bodyStart, frameEnd)));
		buffer = buffer.slice(frameEnd);
		handleMessage(message);
	}
}

process.stdin.on("data", (chunk) => {
	try {
		buffer = append(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
		parseFrames();
	} catch {
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
		// A streaming provider must negotiate these: the host drops `provider.event`
		// notifications from a plugin that did not declare `host_api.notifications`,
		// and `rpc.cancel` is required to stop an in-flight stream.
		features: ["host_api.notifications", "rpc.cancel"],
	},
});
