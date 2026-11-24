import { QuotaQueryError } from "./errors";
import { ContentLengthDecoder, encodeFrame } from "./framing";
import {
	type ConnectionResponse,
	FEATURES,
	type HostRequest,
	PLUGIN_ID,
	PLUGIN_VERSION,
	RPC_PROTOCOL,
	record,
} from "./protocol";
import { queryQuota } from "./query";

type RpcId = string | number;
interface PendingRequest {
	resolve: (value: ConnectionResponse) => void;
	reject: (error: QuotaQueryError) => void;
	signal: AbortSignal;
	abort: () => void;
}
const validId = (value: unknown): value is RpcId =>
	(typeof value === "string" && value.length > 0 && value.length <= 128) ||
	(typeof value === "number" && Number.isFinite(value));

/** A dedicated stdio program. Nothing here runs in the host HTTP/Agent process. */
export function runStdioQuotaPlugin(): void {
	let initialized = false;
	let active = false;
	let shuttingDown = false;
	let runtimeId: string | undefined;
	let generation: number | undefined;
	let serial = 0;
	let blocked = false;
	let queuedBytes = 0;
	const capabilities = new Set<string>();
	const queries = new Map<RpcId, AbortController>();
	const pending = new Map<RpcId, PendingRequest>();
	const writes: Array<{ frame: Uint8Array; callback?: () => void }> = [];

	function fatal(): never {
		process.stderr.write("Provider quota RPC protocol failure\n");
		process.exit(2);
	}
	function pump() {
		while (!blocked && writes.length) {
			const next = writes.shift();
			if (!next) break;
			queuedBytes -= next.frame.byteLength;
			blocked = !process.stdout.write(next.frame, next.callback);
		}
	}
	function send(message: unknown, callback?: () => void) {
		try {
			const frame = encodeFrame(message);
			if (writes.length >= 128 || queuedBytes + frame.byteLength > 256 * 1024) fatal();
			writes.push({ frame, callback });
			queuedBytes += frame.byteLength;
			pump();
		} catch {
			fatal();
		}
	}
	function respond(id: RpcId, result: unknown) {
		send({ jsonrpc: "2.0", id, result });
	}
	function reject(id: RpcId, code: number, message: string) {
		send({ jsonrpc: "2.0", id, error: { code, message } });
	}
	function abortAll() {
		for (const controller of queries.values()) controller.abort(new QuotaQueryError("unavailable"));
		for (const item of pending.values()) {
			item.signal.removeEventListener("abort", item.abort);
			item.reject(new QuotaQueryError("unavailable"));
		}
		pending.clear();
	}
	const hostRequest: HostRequest = (params, signal) =>
		new Promise((resolve, rejectPromise) => {
			if (!active || shuttingDown || signal.aborted) {
				rejectPromise(new QuotaQueryError("unavailable"));
				return;
			}
			if (pending.size >= 16) {
				rejectPromise(new QuotaQueryError("queue_full"));
				return;
			}
			const id = `quota-host-${++serial}`;
			const abort = () => {
				const item = pending.get(id);
				if (!item) return;
				pending.delete(id);
				item.signal.removeEventListener("abort", abort);
				send({ jsonrpc: "2.0", method: "$/cancelRequest", params: { id } });
				item.reject(
					signal.reason instanceof QuotaQueryError
						? signal.reason
						: new QuotaQueryError("unavailable"),
				);
			};
			pending.set(id, { resolve, reject: rejectPromise, signal, abort });
			signal.addEventListener("abort", abort, { once: true });
			if (signal.aborted) {
				abort();
				return;
			}
			send({ jsonrpc: "2.0", id, method: "provider.connection.request", params });
		});
	function acceptResponse(message: Record<string, unknown>) {
		if (!validId(message.id)) return;
		const item = pending.get(message.id);
		if (!item) return; // Late replies to an aborted request cannot publish data.
		pending.delete(message.id);
		item.signal.removeEventListener("abort", item.abort);
		if (message.error !== undefined) {
			const error = record(message.error) ? message.error : {};
			const data = record(error.data) ? error.data : {};
			const code = data.code ?? error.code;
			const safeCode =
				code === "PERMISSION_DENIED" || code === -32008
					? "permission_denied"
					: code === "TIMEOUT"
						? "timeout"
						: code === "RATE_LIMITED" || code === "PLUGIN_BUSY"
							? "queue_full"
							: code === "PLUGIN_DISABLED" || code === "HOST_UNAVAILABLE"
								? "unavailable"
								: "request_failed";
			item.reject(new QuotaQueryError(safeCode));
		} else if (record(message.result))
			item.resolve(message.result as unknown as ConnectionResponse);
		else item.reject(new QuotaQueryError("invalid_response"));
	}
	function cancel(params: unknown): boolean {
		if (!record(params)) return false;
		const id = params.id ?? params.requestId;
		if (!validId(id)) return false;
		const controller = queries.get(id);
		controller?.abort(new QuotaQueryError("unavailable"));
		return controller !== undefined;
	}
	function handle(value: unknown) {
		if (!record(value) || value.jsonrpc !== "2.0") fatal();
		if (typeof value.method !== "string") {
			acceptResponse(value);
			return;
		}
		if (value.method === "$/cancelRequest") {
			const cancelled = cancel(value.params);
			if (validId(value.id)) respond(value.id, { cancelled });
			return;
		}
		if (!validId(value.id)) return;
		const id = value.id;
		const params = record(value.params) ? value.params : {};
		switch (value.method) {
			case "hello":
				respond(id, {
					pluginId: PLUGIN_ID,
					version: PLUGIN_VERSION,
					rpcProtocol: RPC_PROTOCOL,
					features: FEATURES,
				});
				return;
			case "initialize": {
				const version =
					typeof params.hostApiVersion === "string"
						? /^1\.(\d+)(?:\.\d+)?$/.exec(params.hostApiVersion)
						: null;
				if (
					params.protocol !== RPC_PROTOCOL ||
					params.pluginId !== PLUGIN_ID ||
					!version ||
					!Array.isArray(params.features) ||
					!FEATURES.every((feature) => (params.features as unknown[]).includes(feature))
				) {
					reject(id, -32001, "Host API or required quota features unavailable");
					return;
				}
				runtimeId = typeof params.runtimeId === "string" ? params.runtimeId : undefined;
				generation = typeof params.generation === "number" ? params.generation : undefined;
				capabilities.clear();
				if (Array.isArray(params.capabilities))
					for (const capability of params.capabilities)
						if (typeof capability === "string") capabilities.add(capability);
				initialized = true;
				respond(id, { initialized: true, protocol: RPC_PROTOCOL, features: FEATURES });
				return;
			}
			case "activate":
				if (!initialized || shuttingDown) {
					reject(id, -32009, "Plugin not initialized");
					return;
				}
				active = true;
				respond(id, { activated: true });
				return;
			case "health":
				respond(id, {
					healthy: initialized && active && !shuttingDown,
					status: active ? "ready" : "inactive",
					runtimeId,
					generation,
				});
				return;
			case "cancel":
				respond(id, { cancelled: cancel(params) });
				return;
			case "deactivate":
				active = false;
				abortAll();
				respond(id, { deactivated: true });
				return;
			case "shutdown":
				active = false;
				initialized = false;
				shuttingDown = true;
				abortAll();
				send({ jsonrpc: "2.0", id, result: { shutdown: true } }, () => process.exit(0));
				return;
			case "quota.query": {
				if (!active || shuttingDown) {
					respond(id, { status: "error", data: null, error: "unavailable" });
					return;
				}
				if (
					!capabilities.has("quota.provide") ||
					!capabilities.has("provider.connection.request")
				) {
					respond(id, { status: "error", data: null, error: "permission_denied" });
					return;
				}
				if (queries.has(id)) {
					reject(id, -32006, "Duplicate query ID");
					return;
				}
				if (queries.size >= 4) {
					respond(id, { status: "error", data: null, error: "queue_full" });
					return;
				}
				const controller = new AbortController();
				queries.set(id, controller);
				const startedAt = performance.now();
				void queryQuota(value.params, hostRequest, controller.signal)
					.then(
						(result) => {
							if (!shuttingDown) respond(id, result);
							const elapsed = performance.now() - startedAt;
							if (elapsed >= 2000)
								process.stderr.write(
									`Provider quota slow operation durationMs=${Math.round(elapsed)} status=${result.status}\n`,
								);
						},
						() => {
							if (!shuttingDown)
								respond(id, { status: "error", data: null, error: "request_failed" });
						},
					)
					.finally(() => queries.delete(id));
				return;
			}
			default:
				reject(id, -32601, "Unknown method");
		}
	}
	const framing = new ContentLengthDecoder(handle);
	process.stdout.on("drain", () => {
		blocked = false;
		pump();
	});
	process.stdout.on("error", fatal);
	process.stdin.on("data", (chunk: Uint8Array) => {
		try {
			framing.feed(chunk);
		} catch {
			fatal();
		}
	});
	process.stdin.on("error", fatal);
	process.stdin.on("end", () => {
		try {
			framing.finish();
		} catch {
			fatal();
		}
		abortAll();
		process.exit(0);
	});
	send({
		jsonrpc: "2.0",
		method: "hello",
		params: {
			pluginId: PLUGIN_ID,
			version: PLUGIN_VERSION,
			rpcProtocol: RPC_PROTOCOL,
			...(process.env.NF_PLUGIN_PACKAGE_DIGEST
				? { packageDigest: process.env.NF_PLUGIN_PACKAGE_DIGEST }
				: {}),
			features: FEATURES,
		},
	});
}
