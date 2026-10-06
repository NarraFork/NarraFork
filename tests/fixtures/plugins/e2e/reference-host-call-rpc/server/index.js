const PLUGIN_ID = "com.example.host-call-rpc";
const PLUGIN_VERSION = "1.0.0";
const RPC_PROTOCOL = "narrafork.rpc/1";
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
const pendingHostCalls = new Map([
	["host-query", "query"],
	["host-denied-command", "denied"],
	["host-unknown", "unknown"],
]);
const hostResults = {};
let buffer = new Uint8Array(0);
let writeChain = Promise.resolve();
let activated = false;

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

function write(message) {
	const body = encoder.encode(JSON.stringify(message));
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	const frame = append(header, body);
	writeChain = writeChain.then(
		() =>
			new Promise((resolve, reject) => {
				process.stdout.write(frame, (error) => {
					if (error) reject(error);
					else resolve();
				});
			}),
	);
	return writeChain;
}

function result(id, value) {
	return write({ jsonrpc: "2.0", id, result: value });
}

function error(id, code, message, data) {
	return write({
		jsonrpc: "2.0",
		id,
		error: { code, message, ...(data === undefined ? {} : { data }) },
	});
}

function startHostCalls() {
	void write({
		jsonrpc: "2.0",
		id: "host-query",
		method: "queries.execute",
		params: {
			pluginId: "com.example.forged-plugin",
			userId: "forged-admin",
			scope: { projectId: "forged-project" },
			payload: "reference-query",
		},
	});
	void write({
		jsonrpc: "2.0",
		id: "host-denied-command",
		method: "commands.execute",
		params: { command: "chapter.delete", chapterId: "forged-chapter" },
	});
	void write({
		jsonrpc: "2.0",
		id: "host-unknown",
		method: "host.method.doesNotExist",
		params: { value: true },
	});
}

function recordHostResponse(message) {
	const key = pendingHostCalls.get(String(message.id));
	if (!key) return false;
	pendingHostCalls.delete(String(message.id));
	hostResults[key] = "error" in message ? { error: message.error } : { result: message.result };
	return true;
}

async function handle(message) {
	if (recordHostResponse(message)) return;
	if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
	const id = message.id;
	switch (message.method) {
		case "initialize":
			if (message.params?.protocol !== RPC_PROTOCOL || message.params?.pluginId !== PLUGIN_ID) {
				await error(id, -32602, "initialize identity or protocol mismatch", {
					code: "INVALID_PARAMS",
				});
				return;
			}
			await result(id, { initialized: true, protocol: RPC_PROTOCOL });
			return;
		case "activate":
			activated = true;
			await result(id, { activated: true });
			startHostCalls();
			return;
		case "health":
			await result(id, { healthy: activated, status: activated ? "ready" : "inactive" });
			return;
		case "reference.hostResults":
			await result(id, {
				settled: pendingHostCalls.size === 0,
				pending: [...pendingHostCalls.values()],
				results: hostResults,
			});
			return;
		case "deactivate":
			activated = false;
			await result(id, { deactivated: true });
			return;
		case "shutdown":
			await result(id, { shutdown: true });
			await writeChain;
			setTimeout(() => process.exit(0), 0);
			return;
		default:
			await error(id, -32601, `Unknown method: ${message.method}`, {
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
		void handle(message).catch((cause) => {
			void error(null, -32603, cause instanceof Error ? cause.message : String(cause));
		});
	}
}

process.stdin.on("data", (chunk) => {
	try {
		buffer = append(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_BUFFER_BYTES) throw new Error("RPC input buffer exceeds limit");
		parseFrames();
	} catch (cause) {
		process.stderr.write(
			`invalid input: ${cause instanceof Error ? cause.message : String(cause)}\n`,
		);
		process.exit(2);
	}
});
process.stdin.on("end", () => process.exit(0));
process.on("uncaughtException", (cause) => {
	process.stderr.write(`uncaught: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exit(1);
});
process.on("unhandledRejection", (cause) => {
	process.stderr.write(`unhandled: ${cause instanceof Error ? cause.message : String(cause)}\n`);
	process.exit(1);
});

void write({
	jsonrpc: "2.0",
	method: "hello",
	params: {
		pluginId: PLUGIN_ID,
		version: PLUGIN_VERSION,
		rpcProtocol: RPC_PROTOCOL,
		features: [],
	},
});
