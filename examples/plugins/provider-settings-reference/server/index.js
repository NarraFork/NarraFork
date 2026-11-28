const RPC_PROTOCOL = "narrafork.rpc/1";
const CONTRIBUTION_ID = "settings";
const PACKAGE_DIR = process.env.NF_PLUGIN_PACKAGE_DIR;
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const NF_DATA_DIR = process.env.NF_PLUGIN_DATA_DIR;
let packageManifest;
try {
	if (PACKAGE_DIR)
		packageManifest = JSON.parse(await Bun.file(`${PACKAGE_DIR}/manifest.json`).text());
} catch {
	packageManifest = undefined;
}
const PLUGIN_ID =
	typeof packageManifest?.pluginId === "string"
		? packageManifest.pluginId
		: "com.example.provider-settings.reference";
const PLUGIN_VERSION =
	typeof packageManifest?.version === "string" ? packageManifest.version : "1.0.0";
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
if (NF_DATA_DIR) await Bun.write(`${NF_DATA_DIR}/provider-settings-started`, PLUGIN_ID);
let buffer = new Uint8Array(0);
let initialized = false;
let active = false;
let runtimeId;
let generation;
let nextHostRequestId = 1;
const hostRequests = new Map();

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
		)
			return index;
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

function send(message) {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(append(header, body));
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

function hostGet(reference) {
	const id = `provider-settings-get-${nextHostRequestId++}`;
	return new Promise((resolve, rejectPromise) => {
		hostRequests.set(String(id), { resolve, reject: rejectPromise });
		send({
			jsonrpc: "2.0",
			id,
			method: "provider.settings.get",
			params: { reference },
		});
	});
}

function recordHostResponse(message) {
	if (!("id" in message)) return false;
	const pending = hostRequests.get(String(message.id));
	if (!pending) return false;
	hostRequests.delete(String(message.id));
	if ("error" in message) pending.reject(message.error);
	else pending.resolve(message.result);
	return true;
}

async function providerSettingsAction(id, params) {
	if (!active) {
		reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
		return;
	}
	if (params?.contributionId !== CONTRIBUTION_ID || typeof params?.reference !== "string") {
		reject(id, -32602, "Invalid provider settings action parameters", { code: "INVALID_PARAMS" });
		return;
	}
	try {
		const snapshot = await hostGet(params.reference);
		const values = object(snapshot?.values);
		if (!values) throw new Error("Host returned no public settings");
		if (NF_DATA_DIR) {
			await Bun.write(`${NF_DATA_DIR}/provider-settings-action.marker`, "provider-settings-action");
		}
		const text = typeof values.text === "string" ? values.text : "";
		const enabled = values.enabled === true;
		const attempts = Number.isSafeInteger(values.attempts) ? values.attempts : -1;
		respond(id, {
			text: `provider-settings-reference:${text}:${enabled ? "enabled" : "disabled"}:${attempts}`,
		});
	} catch (error) {
		reject(id, -32008, "Provider settings read was denied", {
			code: "PERMISSION_DENIED",
			message: error instanceof Error ? error.message : "host request failed",
		});
	}
}

async function handle(message) {
	if (recordHostResponse(message)) return;
	if (!object(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
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
		case "providerSettings.action":
			await providerSettingsAction(message.id, params);
			return;
		case "deactivate":
			active = false;
			respond(message.id, { deactivated: true });
			return;
		case "shutdown":
			active = false;
			initialized = false;
			respond(message.id, { shutdown: true });
			setTimeout(() => process.exit(0), 0);
			return;
		default:
			reject(message.id, -32601, `Unknown method: ${message.method}`, {
				code: "METHOD_NOT_FOUND",
			});
	}
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
		void handle(message).catch((error) => {
			reject(message.id, -32603, error instanceof Error ? error.message : "request failed");
		});
	}
}

process.stdin.on("data", (chunk) => {
	try {
		buffer = append(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4) {
			throw new Error("RPC input buffer exceeds limit");
		}
		parseFrames();
	} catch {
		process.exit(2);
	}
});
process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", () => process.exit(1));
process.on("unhandledRejection", () => process.exit(1));

send({
	jsonrpc: "2.0",
	method: "hello",
	params: {
		pluginId: PLUGIN_ID,
		version: PLUGIN_VERSION,
		rpcProtocol: RPC_PROTOCOL,
		...(PACKAGE_DIGEST ? { packageDigest: PACKAGE_DIGEST } : {}),
		features: ["host_api.requests", "host_api.provider_settings"],
	},
});
