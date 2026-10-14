const PLUGIN_ID = "steward-narrator";
const PLUGIN_VERSION = "0.2.0";
const RPC_PROTOCOL = "narrafork.rpc/1";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;
const BIND_COMMAND = "steward.bind";
const READ_COMMAND = "steward.binding";
const SEND_TOOL = "steward.send";
const BINDING_KEY = "steward.binding.v1";
const MAX_FRAME_BYTES = 64 * 1024 * 1024;
const MAX_HEADER_BYTES = 8 * 1024;
const MAX_MESSAGE_LENGTH = 16000;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = new Uint8Array(0);
let initialized = false;
let active = false;
let runtimeId;
let generation;
let nextId = 1;
const pending = new Map();

function object(value) {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
}
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
function send(message) {
	const body = encoder.encode(JSON.stringify(message));
	if (body.byteLength > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
	const header = encoder.encode(
		`Content-Length: ${body.byteLength}\r\nContent-Type: application/json; charset=utf-8\r\n\r\n`,
	);
	process.stdout.write(append(header, body));
}
function respond(id, result) {
	send({ jsonrpc: "2.0", id, result });
}
function reject(id, code, message, data) {
	send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}
function errorMessage(error) {
	return error instanceof Error ? error.message : "宿主请求失败";
}
function hostRequest(method, params) {
	return new Promise((resolve, rejectPromise) => {
		const id = `host-${nextId++}`;
		pending.set(id, { resolve, reject: rejectPromise });
		send({ jsonrpc: "2.0", id, method, params });
	});
}
function hostResult(value) {
	if (value && typeof value === "object" && value.status === "failed") {
		throw new Error(value.error?.message || "宿主拒绝了请求");
	}
	return value;
}
function contextFrom(params) {
	const context = object(params?.context);
	const invocation = object(context?.invocation);
	const scope = object(context?.scope);
	if (!invocation || invocation.kind !== "user" || typeof invocation.userId !== "string")
		throw new Error("宿主未提供用户调用上下文");
	if (typeof invocation.narratorId !== "string" || !invocation.narratorId.trim())
		throw new Error("宿主未提供当前叙述者上下文");
	if (scope?.userId !== undefined && scope.userId !== invocation.userId)
		throw new Error("用户范围与调用主体不一致");
	if (scope?.narratorId !== undefined && scope.narratorId !== invocation.narratorId)
		throw new Error("叙述者范围与调用主体不一致");
	return {
		invocation,
		scope: { ...scope, userId: invocation.userId, narratorId: invocation.narratorId },
	};
}
function storageParams(context, extra = {}) {
	return { scopeType: "user", scopeId: context.invocation.userId, ...extra };
}
function parseBinding(value) {
	if (value === null) return null;
	const candidate = object(value);
	if (
		!candidate ||
		typeof candidate.stewardNarratorId !== "string" ||
		typeof candidate.userId !== "string" ||
		typeof candidate.boundAt !== "string" ||
		!Number.isInteger(candidate.revision) ||
		candidate.revision < 1
	)
		throw new Error("绑定状态无效");
	return candidate;
}
async function readBinding(context) {
	const raw = hostResult(
		await hostRequest("storage.get", storageParams(context, { key: BINDING_KEY })),
	);
	return parseBinding(raw?.value ?? raw);
}
async function bind(context) {
	const previous = await readBinding(context);
	const binding = {
		stewardNarratorId: context.invocation.narratorId,
		userId: context.invocation.userId,
		boundByNarratorId: context.invocation.narratorId,
		boundAt: new Date().toISOString(),
		revision: (previous?.revision || 0) + 1,
	};
	const stored = hostResult(
		await hostRequest(
			"storage.set",
			storageParams(context, {
				key: BINDING_KEY,
				value: binding,
				expectedRevision: previous?.revision || 0,
			}),
		),
	);
	return stored?.value ?? binding;
}
async function sendMessage(context, input) {
	const request = object(input);
	if (
		!request ||
		typeof request.targetNarratorId !== "string" ||
		typeof request.message !== "string" ||
		!request.message.trim() ||
		request.message.length > MAX_MESSAGE_LENGTH
	)
		throw new Error("steward.send 输入无效");
	const binding = await readBinding(context);
	if (
		!binding ||
		binding.userId !== context.invocation.userId ||
		binding.stewardNarratorId !== context.invocation.narratorId
	)
		throw new Error("当前叙述者不是当前用户绑定的管家");
	const result = hostResult(
		await hostRequest("commands.execute", {
			commandId: "narrafork.narrator.send_message",
			input: { narratorId: request.targetNarratorId, message: request.message },
		}),
	);
	return result?.output ?? result;
}
async function invoke(id, params) {
	if (!active) return reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
	const contributionId = params?.contributionId;
	try {
		const context = contextFrom(params);
		if (contributionId === BIND_COMMAND) return respond(id, { output: await bind(context) });
		if (contributionId === READ_COMMAND) return respond(id, { output: await readBinding(context) });
		if (contributionId === SEND_TOOL)
			return respond(id, { output: JSON.stringify(await sendMessage(context, params.input)) });
		return reject(id, -32602, "Unknown steward contribution", { code: "INVALID_PARAMS" });
	} catch (error) {
		reject(id, -32003, errorMessage(error), { code: "PERMISSION_DENIED" });
	}
}
function handleMessage(message) {
	if (!object(message) || message.jsonrpc !== "2.0") return;
	if ("id" in message && pending.has(message.id)) {
		const call = pending.get(message.id);
		pending.delete(message.id);
		if (message.error) call.reject(new Error(message.error.message || "宿主请求失败"));
		else call.resolve(message.result);
		return;
	}
	if (!("id" in message) || typeof message.method !== "string") return;
	if (message.method === "initialize") {
		if (message.params?.protocol !== RPC_PROTOCOL || message.params?.pluginId !== PLUGIN_ID)
			return reject(message.id, -32602, "initialize identity or protocol mismatch", {
				code: "INVALID_PARAMS",
			});
		runtimeId = message.params.runtimeId;
		generation = message.params.generation;
		initialized = true;
		return respond(message.id, { initialized: true, protocol: RPC_PROTOCOL });
	}
	if (message.method === "activate") {
		if (!initialized)
			return reject(message.id, -32603, "Plugin must be initialized before activation");
		active = true;
		return respond(message.id, { activated: true });
	}
	if (message.method === "health")
		return respond(message.id, {
			healthy: initialized && active,
			status: active ? "ready" : "inactive",
			runtimeId,
			generation,
		});
	if (message.method === "commands.invoke" || message.method === "tools.invoke")
		return void invoke(message.id, message.params);
	if (message.method === "deactivate") {
		active = false;
		return respond(message.id, { deactivated: true });
	}
	if (message.method === "shutdown") {
		active = false;
		initialized = false;
		return send({ jsonrpc: "2.0", id: message.id, result: { shutdown: true } });
	}
	reject(message.id, -32601, `Unknown method: ${message.method}`, { code: "METHOD_NOT_FOUND" });
}
function parseFrames() {
	while (buffer.byteLength) {
		const delimiter = (() => {
			for (let i = 0; i <= buffer.byteLength - 4; i += 1)
				if (
					buffer[i] === 13 &&
					buffer[i + 1] === 10 &&
					buffer[i + 2] === 13 &&
					buffer[i + 3] === 10
				)
					return i;
			return -1;
		})();
		if (delimiter < 0) {
			if (buffer.byteLength > MAX_HEADER_BYTES) throw new Error("RPC header exceeds limit");
			return;
		}
		const length = contentLength(decoder.decode(buffer.slice(0, delimiter)));
		if (length > MAX_FRAME_BYTES) throw new Error("RPC frame exceeds limit");
		const end = delimiter + 4 + length;
		if (buffer.byteLength < end) return;
		const message = JSON.parse(decoder.decode(buffer.slice(delimiter + 4, end)));
		buffer = buffer.slice(end);
		handleMessage(message);
	}
}
process.stdin.on("data", (chunk) => {
	try {
		buffer = append(buffer, new Uint8Array(chunk));
		if (buffer.byteLength > MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4)
			throw new Error("RPC input buffer exceeds limit");
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
		features: ["host_api.requests"],
	},
});
