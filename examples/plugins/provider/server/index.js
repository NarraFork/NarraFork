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
						apiMode: { type: "string", enum: ["offline"], default: "offline" },
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
		case "provider.validateConfig":
			respond(message.id, { valid: true, issues: [], capabilities: { offline: true } });
			return;
		case "provider.listModels":
			listModels(message.id, params);
			return;
		case "deactivate":
			active = false;
			respond(message.id, { deactivated: true });
			return;
		case "shutdown":
			active = false;
			initialized = false;
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
		features: [],
	},
});
