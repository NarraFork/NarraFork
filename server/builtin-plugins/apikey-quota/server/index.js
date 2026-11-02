/**
 * API Key Quota Probe — NarraFork plugin backend.
 *
 * Owns the "how do I ask a relay for this key's allowance, and how do I read the answer"
 * half of provider balance querying. The host keeps provider config, credential storage,
 * scheduling, caching, DTOs and HTTP routes; it calls this process once per query through
 * `tools.invoke` (`query-balance`).
 *
 * Standalone by design: no imports from the host, no host storage/secrets/config access.
 * The API key arrives in the tool input for that one call and is never written anywhere.
 *
 * Protocol knowledge here mirrors `server/lib/provider-balance-adapters.ts` +
 * `server/lib/provider-balance-transport.ts` at the time of extraction (NarraFork 0.9.x).
 */
const PLUGIN_ID = "com.narrafork.apikey-quota";
const PLUGIN_VERSION = "1.0.0";
const RPC_PROTOCOL = "narrafork.rpc/1";
const PACKAGE_DIGEST = process.env.NF_PLUGIN_PACKAGE_DIGEST;

const MAX_HEADER_BYTES = 8 * 1024;
const MAX_FRAME_BYTES = 256 * 1024;
const MAX_BUFFER_BYTES = MAX_HEADER_BYTES + MAX_FRAME_BYTES + 4;

const BALANCE_MAX_RESPONSE_BYTES = 64 * 1024;
const BALANCE_REQUEST_TIMEOUT_MS = 8_000;
const MAX_URL_LENGTH = 4_096;
const MAX_EXTRA_HEADER_ENTRIES = 64;
const MAX_EXTRA_HEADER_VALUE = 1_024;

const HOP_BY_HOP_HEADERS = new Set([
	"host",
	"connection",
	"content-length",
	"transfer-encoding",
	"proxy-authorization",
	"proxy-connection",
	"upgrade",
	"keep-alive",
	"trailer",
	"te",
]);

class ProbeRequestError extends Error {
	constructor(kind) {
		super(kind === "unsupported" ? "Balance protocol unsupported" : "Balance request failed");
		this.name = "ProbeRequestError";
		this.kind = kind;
	}
}

// --- Response normalisation (identical rules to the host adapters) ---

const record = (value) =>
	typeof value === "object" && value !== null && !Array.isArray(value) ? value : undefined;
const finite = (value) =>
	typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
const positive = (value) => finite(value) && value > 0;
const shortString = (value, max = 128) =>
	typeof value === "string" && value.length > 0 && value.length <= max;

function bounded(value, depth = 0, budget = { left: 4096 }) {
	if (--budget.left < 0 || depth > 12) return false;
	if (typeof value === "string") return value.length <= 4096;
	if (typeof value === "number") return finite(value);
	if (Array.isArray(value)) {
		return value.length <= 256 && value.every((entry) => bounded(entry, depth + 1, budget));
	}
	const obj = record(value);
	if (obj) {
		const entries = Object.entries(obj);
		return (
			entries.length <= 256 &&
			entries.every(([key, entry]) => key.length <= 128 && bounded(entry, depth + 1, budget))
		);
	}
	return value === null || typeof value === "boolean";
}

function quotaAmount(value, window) {
	const obj = record(value);
	if (
		!obj ||
		!finite(obj.remaining) ||
		!finite(obj.used) ||
		!finite(obj.limit) ||
		obj.used < 0 ||
		obj.limit < 0
	) {
		return null;
	}
	const amount = { unit: "USD", remaining: obj.remaining, used: obj.used, total: obj.limit };
	if (window) amount.window = window;
	return amount;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

/** Optional metadata must not invalidate a supported allowance or invent local time. */
function normalizedTimestamp(value) {
	if (typeof value !== "string" || value.length > 128) return undefined;
	if (!ISO_DATE_TIME.test(value)) return undefined;
	const timestamp = Date.parse(value);
	return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : undefined;
}

export function parseSub2ApiBalance(body) {
	const data = record(body);
	if (!data || !bounded(data) || typeof data.isValid !== "boolean") return null;
	if (data.success === false || data.error !== undefined) return null;
	if (data.mode === "quota_limited") {
		const amounts = [];
		if (data.quota !== undefined) {
			const amount = quotaAmount(data.quota);
			const quota = record(data.quota);
			if (!amount || !quota || quota.unit !== "USD") return null;
			amounts.push(amount);
		}
		if (data.rate_limits !== undefined) {
			if (!Array.isArray(data.rate_limits) || data.rate_limits.length > 10) return null;
			const windows = new Set();
			for (const entry of data.rate_limits) {
				const limit = record(entry);
				if (!limit || !["5h", "1d", "7d"].includes(String(limit.window))) return null;
				const window = String(limit.window);
				const amount = quotaAmount(limit, window);
				if (!amount || windows.has(window)) return null;
				windows.add(window);
				amounts.push(amount);
			}
		}
		return amounts.length ? { scope: "key", unlimited: false, amounts } : null;
	}
	if (data.mode !== "unrestricted" || data.unit !== "USD") return null;
	if (data.balance !== undefined) {
		if (!finite(data.balance)) return null;
		return {
			scope: "wallet",
			unlimited: false,
			amounts: [{ unit: "USD", remaining: data.balance }],
		};
	}
	if (!shortString(data.planName) || !data.planName.trim()) return null;
	const amounts = [];
	let expiresAt;
	if (data.subscription !== undefined && data.subscription !== null) {
		const subscription = record(data.subscription);
		if (!subscription) return null;
		expiresAt = normalizedTimestamp(subscription.expires_at);
		const weeklyStart = normalizedTimestamp(subscription.weekly_window_start);
		for (const window of ["daily", "weekly", "monthly"]) {
			const total = subscription[`${window}_limit_usd`];
			const used = subscription[`${window}_usage_usd`];
			if (total === undefined || total === null) continue;
			if (!finite(total) || total < 0 || !finite(used) || used < 0) return null;
			const remaining = total - used;
			if (!finite(remaining)) return null;
			const amount = { unit: "USD", remaining, used, total, window };
			if (window === "weekly" && weeklyStart) amount.windowStart = weeklyStart;
			amounts.push(amount);
		}
	}
	const balance = {
		scope: "subscription",
		// The gateway explicitly reports -1 when no positive period limit is configured.
		unlimited: data.remaining === -1,
		amounts,
		planName: data.planName.trim(),
	};
	if (expiresAt) balance.expiresAt = expiresAt;
	return balance;
}

const RAW_CONVERSION = { unit: "QUOTA", divisor: 1, rate: 1 };

function newApiConversion(status) {
	const wrapper = record(status);
	if (!wrapper || wrapper.success !== true || !record(wrapper.data) || !bounded(wrapper)) {
		return RAW_CONVERSION;
	}
	const data = wrapper.data;
	if (!positive(data.quota_per_unit)) return RAW_CONVERSION;
	switch (data.quota_display_type) {
		case "USD":
			return { unit: "USD", divisor: data.quota_per_unit, rate: 1 };
		case "CNY":
			return positive(data.usd_exchange_rate)
				? { unit: "CNY", divisor: data.quota_per_unit, rate: data.usd_exchange_rate }
				: RAW_CONVERSION;
		case "TOKENS":
			return { unit: "TOKENS", divisor: 1, rate: 1 };
		case "CUSTOM": {
			const symbol = data.custom_currency_symbol;
			return typeof symbol === "string" &&
				/^(?:[A-Za-z]{1,8}|\p{Sc})$/u.test(symbol) &&
				positive(data.custom_currency_exchange_rate)
				? {
						unit: symbol,
						divisor: data.quota_per_unit,
						rate: data.custom_currency_exchange_rate,
					}
				: RAW_CONVERSION;
		}
		default:
			return RAW_CONVERSION;
	}
}

export function parseNewApiBalance(body, status) {
	const wrapper = record(body);
	if (!wrapper || !bounded(wrapper) || wrapper.code !== true || wrapper.success === false)
		return null;
	const data = record(wrapper.data);
	if (
		!data ||
		data.object !== "token_usage" ||
		typeof data.unlimited_quota !== "boolean" ||
		!finite(data.total_available) ||
		!finite(data.total_used) ||
		data.total_used < 0 ||
		!finite(data.total_granted)
	) {
		return null;
	}
	if (data.unlimited_quota) return { scope: "key", unlimited: true, amounts: [] };
	let conversion = newApiConversion(status);
	const raw = [data.total_available, data.total_used, data.total_granted];
	let values = raw.map((value) => (value / conversion.divisor) * conversion.rate);
	if (!values.every(finite)) {
		conversion = RAW_CONVERSION;
		values = raw;
	}
	return {
		scope: "key",
		unlimited: false,
		amounts: [{ unit: conversion.unit, remaining: values[0], used: values[1], total: values[2] }],
	};
}

export function normalizeRoot(baseUrl) {
	if (typeof baseUrl !== "string" || baseUrl.length > 2048 || /[?#\\\s]/u.test(baseUrl)) {
		throw new Error("Invalid balance URL");
	}
	let url;
	try {
		url = new URL(baseUrl);
	} catch {
		throw new Error("Invalid balance URL");
	}
	if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) {
		throw new Error("Invalid balance URL");
	}
	return url.origin + url.pathname.replace(/\/+$/, "");
}

export function buildBalanceRoots(baseUrl) {
	const original = normalizeRoot(baseUrl);
	const stripped = original.replace(/\/(?:v1|v1beta|anthropic)$/, "");
	return stripped === original ? [original] : [stripped, original];
}

// --- Bounded transport ---

function buildHeaders(input, authenticated) {
	// Public site metadata must not receive even a credential-bearing custom header.
	if (!authenticated) return { Accept: "application/json" };
	const headers = {
		Authorization: `Bearer ${input.apiKey}`,
		...(typeof input.userAgent === "string" && input.userAgent.length <= 512
			? { "User-Agent": input.userAgent }
			: {}),
	};
	const blocked = new Set(HOP_BY_HOP_HEADERS);
	const extra = record(input.headers);
	if (extra) {
		const entries = Object.entries(extra).slice(0, MAX_EXTRA_HEADER_ENTRIES);
		for (const [name, value] of entries) {
			if (typeof value !== "string" || value.length > MAX_EXTRA_HEADER_VALUE) continue;
			const lower = name.toLowerCase();
			if (lower === "connection") {
				for (const token of value.split(",")) {
					const normalized = token.trim().toLowerCase();
					if (normalized) blocked.add(normalized);
				}
			}
		}
		for (const [name, value] of entries) {
			if (typeof value !== "string" || value.length > MAX_EXTRA_HEADER_VALUE) continue;
			if (blocked.has(name.toLowerCase())) continue;
			headers[name] = value;
		}
	}
	for (const name of blocked) {
		for (const key of Object.keys(headers)) {
			if (key.toLowerCase() === name) delete headers[key];
		}
	}
	headers.Accept = "application/json";
	return headers;
}

function fetchOptions(input, signal) {
	const options = { method: "GET", redirect: "error", signal };
	if (typeof input.tlsRejectUnauthorized === "boolean") {
		options.tls = { rejectUnauthorized: input.tlsRejectUnauthorized };
	}
	if (typeof input.proxy === "string" && input.proxy.length > 0 && input.proxy.length <= 2048) {
		options.proxy = input.proxy;
	}
	return options;
}

/**
 * Host-supplied per-request timeout.
 *
 * The host transport applies this value verbatim (`setTimeout(..., requestTimeoutMs)`), so the
 * plugin must not re-clamp it: clamping would make an 800 ms or 90 s round take a different
 * amount of time here than in the bundled adapters. Only a value that cannot express a bound
 * at all falls back to the default, and a non-positive value keeps the host's immediate-abort
 * meaning instead of silently becoming the default.
 */
function requestTimeoutMs(input) {
	const raw = input?.timeoutMs;
	if (typeof raw !== "number" || !Number.isFinite(raw)) return BALANCE_REQUEST_TIMEOUT_MS;
	return Math.trunc(raw);
}

/**
 * Read the body under the same 64 KiB cap as the host transport, without buffering an
 * unbounded response first: an oversized body must be rejected while it is still streaming,
 * not after it has already been read into memory.
 */
async function readCappedBody(response, signal) {
	const reader = response.body?.getReader();
	if (!reader) throw new ProbeRequestError("unsupported");
	const chunks = [];
	let length = 0;
	let aborted = false;
	const onAbort = () => {
		aborted = true;
		void reader.cancel().catch(() => {});
	};
	signal.addEventListener("abort", onAbort, { once: true });
	try {
		while (true) {
			const { value, done } = await reader.read();
			if (done) break;
			if (aborted) throw new ProbeRequestError("transient");
			length += value.byteLength;
			if (length > BALANCE_MAX_RESPONSE_BYTES) throw new ProbeRequestError("transient");
			chunks.push(value);
		}
	} finally {
		signal.removeEventListener("abort", onAbort);
		void reader.cancel().catch(() => {});
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	return bytes;
}

/**
 * One allow-listed GET against the provider origin. Every bound the host transport applied
 * is preserved here: single origin, no query/hash, byte cap, JSON-only, no redirects.
 */
function createRequest(input, signal, fetcher = fetch) {
	const origin = new URL(input.baseUrl).origin;
	return async (url, authenticated = true) => {
		const target = new URL(url);
		if (
			target.origin !== origin ||
			target.username ||
			target.password ||
			target.search ||
			target.hash ||
			url.length > MAX_URL_LENGTH
		) {
			throw new ProbeRequestError("unsupported");
		}
		const controller = new AbortController();
		const combined = AbortSignal.any([signal, controller.signal]);
		const timer = setTimeout(() => controller.abort(), requestTimeoutMs(input));
		let response;
		try {
			response = await fetcher(url, {
				...fetchOptions(input, combined),
				headers: buildHeaders(input, authenticated),
			});
			if (!response.ok) {
				throw new ProbeRequestError(
					response.status === 404 || response.status === 405 ? "unsupported" : "transient",
				);
			}
			const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
			if (contentType && contentType !== "application/json" && !contentType.endsWith("+json")) {
				throw new ProbeRequestError("unsupported");
			}
			const declaredLength = Number(response.headers.get("content-length"));
			if (declaredLength > BALANCE_MAX_RESPONSE_BYTES) {
				throw new ProbeRequestError("transient");
			}
			const bytes = await readCappedBody(response, combined);
			try {
				return JSON.parse(new TextDecoder().decode(bytes));
			} catch {
				throw new ProbeRequestError("unsupported");
			}
		} catch (error) {
			if (error instanceof ProbeRequestError) throw error;
			throw new ProbeRequestError("transient");
		} finally {
			clearTimeout(timer);
		}
	};
}

async function readNewApi(root, body, request) {
	let status;
	try {
		status = await request(`${root}/api/status`, false);
	} catch {
		// Metadata is public and optional; a known key allowance remains supported.
	}
	return parseNewApiBalance(body, status);
}

export async function probeProviderBalance(input, signal, fetcher) {
	const request = createRequest(input, signal, fetcher);
	let transient = false;
	for (const root of buildBalanceRoots(input.baseUrl)) {
		for (const adapter of ["sub2api", "new-api"]) {
			try {
				const path = adapter === "sub2api" ? "/v1/usage" : "/api/usage/token/";
				const body = await request(root + path, true);
				let balance = adapter === "sub2api" ? parseSub2ApiBalance(body) : parseNewApiBalance(body);
				if (!balance) continue;
				if (adapter === "new-api") balance = (await readNewApi(root, body, request)) ?? balance;
				return { adapter, root, balance };
			} catch (error) {
				if (!(error instanceof ProbeRequestError) || error.kind === "transient") transient = true;
			}
		}
	}
	if (transient) throw new ProbeRequestError("transient");
	return null;
}

export async function refreshProviderBalance(input, signal, fetcher) {
	const normalized = normalizeRoot(input.root);
	const request = createRequest(input, signal, fetcher);
	try {
		const path = input.adapter === "sub2api" ? "/v1/usage" : "/api/usage/token/";
		const body = await request(normalized + path, true);
		const balance =
			input.adapter === "sub2api" ? parseSub2ApiBalance(body) : parseNewApiBalance(body);
		if (!balance) throw new ProbeRequestError("unsupported");
		return input.adapter === "new-api"
			? ((await readNewApi(normalized, body, request)) ?? balance)
			: balance;
	} catch (error) {
		if (error instanceof ProbeRequestError) throw error;
		throw new ProbeRequestError("transient");
	}
}

// --- Tool handler ---

export function parseToolInput(raw) {
	if (!record(raw)) throw new ProbeRequestError("unsupported");
	const mode = raw.mode === "refresh" ? "refresh" : raw.mode === "probe" ? "probe" : null;
	if (!mode) throw new ProbeRequestError("unsupported");
	if (typeof raw.baseUrl !== "string" || raw.baseUrl.length > 2048) {
		throw new ProbeRequestError("unsupported");
	}
	if (typeof raw.apiKey !== "string" || raw.apiKey.length === 0 || raw.apiKey.length > 4096) {
		throw new ProbeRequestError("unsupported");
	}
	const input = { mode, baseUrl: raw.baseUrl, apiKey: raw.apiKey };
	if (record(raw.headers)) input.headers = raw.headers;
	if (typeof raw.userAgent === "string") input.userAgent = raw.userAgent;
	if (typeof raw.proxy === "string") input.proxy = raw.proxy;
	if (typeof raw.tlsRejectUnauthorized === "boolean") {
		input.tlsRejectUnauthorized = raw.tlsRejectUnauthorized;
	}
	if (typeof raw.timeoutMs === "number") input.timeoutMs = raw.timeoutMs;
	if (mode === "refresh") {
		if (raw.adapter !== "sub2api" && raw.adapter !== "new-api") {
			throw new ProbeRequestError("unsupported");
		}
		if (typeof raw.root !== "string" || raw.root.length > 2048) {
			throw new ProbeRequestError("unsupported");
		}
		input.adapter = raw.adapter;
		input.root = raw.root;
	}
	return input;
}

/**
 * Tool outcomes travel in a successful RPC response with an explicit `status`, so a
 * protocol-level answer ("this relay has no allowance endpoint", "the request failed") is
 * never confused with transport/runtime failure ("the plugin is not running"). Only the
 * latter is a JSON-RPC error, and the host treats it as "plugin unavailable".
 */
async function queryBalance(rawInput, signal) {
	const input = parseToolInput(rawInput);
	if (input.mode === "probe") {
		let found;
		try {
			found = await probeProviderBalance(input, signal);
		} catch (error) {
			const kind = error instanceof ProbeRequestError ? error.kind : "transient";
			return failure(kind);
		}
		if (!found) {
			return {
				output: JSON.stringify({ status: "unsupported" }),
				metadata: { status: "unsupported" },
			};
		}
		return {
			output: JSON.stringify({
				status: "ok",
				adapter: found.adapter,
				root: found.root,
				balance: found.balance,
			}),
			title: "API key quota",
			metadata: { status: "ok", adapter: found.adapter },
		};
	}
	let balance;
	try {
		balance = await refreshProviderBalance(input, signal);
	} catch (error) {
		const kind = error instanceof ProbeRequestError ? error.kind : "transient";
		return failure(kind);
	}
	return {
		output: JSON.stringify({ status: "ok", balance }),
		title: "API key quota",
		metadata: { status: "ok", adapter: input.adapter },
	};
}

function failure(kind) {
	return {
		output: JSON.stringify({ status: "failed", kind }),
		metadata: { status: "failed" },
	};
}

// --- RPC plumbing (Content-Length framed JSON-RPC over stdio) ---

const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });
let buffer = new Uint8Array(0);
let initialized = false;
let active = false;
let runtimeId;
let generation;
const inFlight = new Map();

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
	send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
}

async function invokeTool(id, params) {
	if (!active) {
		reject(id, -32009, "Plugin is not active", { code: "PLUGIN_UNAVAILABLE" });
		return;
	}
	if (!record(params) || params.contributionId !== "query-balance") {
		reject(id, -32602, "Unknown tool contribution", { code: "INVALID_PARAMS" });
		return;
	}
	const controller = new AbortController();
	inFlight.set(id, controller);
	try {
		const result = await queryBalance(params.input, controller.signal);
		respond(id, result);
	} catch (error) {
		// Only malformed input reaches here; fixed codes only, never upstream text.
		const detail =
			error instanceof ProbeRequestError
				? { code: "BALANCE_UNSUPPORTED" }
				: { code: "INVALID_PARAMS" };
		reject(id, -32602, "query-balance input rejected", detail);
	} finally {
		inFlight.delete(id);
	}
}

function handleRequest(message) {
	const params = record(message.params);
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
			void invokeTool(message.id, params);
			return;
		case "cancel": {
			const target = record(params)?.requestId;
			const controller = inFlight.get(target);
			if (controller) {
				controller.abort();
				inFlight.delete(target);
			}
			respond(message.id, { cancelled: Boolean(controller) });
			return;
		}
		case "deactivate":
			active = false;
			for (const controller of inFlight.values()) controller.abort();
			inFlight.clear();
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
	if (!record(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") return;
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

export function startServer() {
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
}

if (import.meta.main) startServer();
