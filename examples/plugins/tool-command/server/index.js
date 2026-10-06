const PLUGIN_ID = "com.example.tool-command";
const PLUGIN_VERSION = "1.0.1";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const RPC_PROTOCOL = "narrafork.rpc/1";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;
const MAX_TEXT = 2000;
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

function invokeTool(id, params) {
	if (!active) {
		reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
		return;
	}
	if (params?.contributionId !== "describe-selection") {
		reject(id, -32602, "Unknown tool contribution", { code: "INVALID_PARAMS" });
		return;
	}
	const input = object(params.input);
	if (!input || typeof input.text !== "string" || input.text.length > MAX_TEXT) {
		reject(id, -32602, "tools.invoke requires input.text up to 2000 characters", {
			code: "INVALID_PARAMS",
		});
		return;
	}
	const preview = input.text.slice(0, 80);
	respond(id, {
		output: JSON.stringify({ length: input.text.length, preview }),
		title: "Selection description",
		metadata: { length: input.text.length, preview },
	});
}

function handleRequest(message) {
	const params = object(message.params);
	switch (message.method) {
		case "initialize": {
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
		}
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
		case "tools.invoke":
			invokeTool(message.id, params);
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
		...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),
		features: [],
	},
});
