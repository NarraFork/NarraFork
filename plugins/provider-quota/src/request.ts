import { BalanceProbeRequestError, QuotaQueryError } from "./errors";
import {
	boundedJson,
	type ConnectionRequest,
	type ConnectionResponse,
	type HostRequest,
	type QuotaQueryParams,
	record,
	type SettingsConnectionRequest,
} from "./protocol";
import type { BalanceRequest } from "./relay";

export const BALANCE_MAX_RESPONSE_BYTES = 64 * 1024;
export const BALANCE_REQUEST_TIMEOUT_MS = 8_000;
/** Optional metadata must leave time to serialize and deliver the confirmed raw allowance. */
export const RELAY_METADATA_RETURN_BUDGET_MS = 250;

export function parseConnectionJson(
	response: ConnectionResponse,
	maxResponseBytes = BALANCE_MAX_RESPONSE_BYTES,
	auth: import("./relay").BalanceAuth = "provider-key",
): unknown {
	const site = auth === "site-token" || auth === "settings-account";
	if (
		!record(response) ||
		!Number.isInteger(response.status) ||
		response.status < 100 ||
		response.status > 599
	)
		throw new BalanceProbeRequestError("transient", "invalid_response");
	if (response.status < 200 || response.status >= 300) {
		if (site) {
			if (response.status === 401 || response.status === 403)
				throw new BalanceProbeRequestError("auth");
			if (response.status === 429 || response.status >= 500)
				throw new BalanceProbeRequestError("transient");
			throw new BalanceProbeRequestError("invalid_response");
		}
		throw new BalanceProbeRequestError(
			response.status === 404 || response.status === 405 ? "unsupported" : "transient",
		);
	}
	if (response.contentType !== null && typeof response.contentType !== "string")
		throw new BalanceProbeRequestError("transient", "invalid_response");
	const contentType = response.contentType?.split(";")[0]?.trim().toLowerCase();
	if (contentType && contentType !== "application/json" && !contentType.endsWith("+json"))
		throw new BalanceProbeRequestError(site ? "invalid_response" : "unsupported");
	if (
		typeof response.body !== "string" ||
		!Number.isInteger(response.bytes) ||
		response.bytes < 0 ||
		response.bytes > maxResponseBytes ||
		response.body.length > maxResponseBytes
	)
		throw new BalanceProbeRequestError("transient", "invalid_response");
	const actualBytes = new TextEncoder().encode(response.body).byteLength;
	if (actualBytes > maxResponseBytes || actualBytes !== response.bytes)
		throw new BalanceProbeRequestError("transient", "invalid_response");
	let body: unknown;
	try {
		body = JSON.parse(response.body);
	} catch {
		throw new BalanceProbeRequestError(site ? "invalid_response" : "unsupported");
	}
	if (!boundedJson(body))
		throw new BalanceProbeRequestError(site ? "invalid_response" : "unsupported");
	return body;
}

function cancelledError(signal: AbortSignal): BalanceProbeRequestError {
	return new BalanceProbeRequestError(
		"transient",
		signal.reason instanceof QuotaQueryError ? signal.reason.code : "unavailable",
	);
}
export function abortableRequest<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
	return new Promise((resolve, reject) => {
		let settled = false;
		const abort = () => {
			if (!settled) {
				settled = true;
				reject(cancelledError(signal));
			}
		};
		signal.addEventListener("abort", abort, { once: true });
		if (signal.aborted) abort();
		promise.then(
			(value) => {
				signal.removeEventListener("abort", abort);
				if (!settled) {
					settled = true;
					resolve(value);
				}
			},
			(error: unknown) => {
				signal.removeEventListener("abort", abort);
				if (!settled) {
					settled = true;
					reject(error);
				}
			},
		);
	});
}
export interface JsonRequestLimits {
	requestTimeoutMs?: number;
	maxResponseBytes?: number;
	maxRequests?: number;
}
function safePath(path: string): boolean {
	if (path.length > 2048 || !path.startsWith("/") || path.startsWith("//") || /[?#\\\s]/.test(path))
		return false;
	try {
		return !decodeURIComponent(path)
			.split("/")
			.some((segment) => segment === "." || segment === "..");
	} catch {
		return false;
	}
}

export function createJsonConnectionRequest(
	params: QuotaQueryParams,
	hostRequest: HostRequest,
	roundSignal: AbortSignal,
	limits: JsonRequestLimits = {},
) {
	let count = 0;
	return async (
		path: string,
		headers: ConnectionRequest["headers"] = { accept: "application/json" },
		query?: Record<string, string>,
		deadlineReserveMs = 0,
		destination: ConnectionRequest["destination"] = "provider",
	): Promise<unknown> => {
		if (!safePath(path)) throw new BalanceProbeRequestError("invalid_configuration");
		if (roundSignal.aborted) throw cancelledError(roundSignal);
		const requestDeadlineAt = params.deadlineAt - Math.max(0, deadlineReserveMs);
		if (Date.now() >= requestDeadlineAt) throw new BalanceProbeRequestError("transient", "timeout");
		if (++count > (limits.maxRequests ?? 8))
			throw new BalanceProbeRequestError("transient", "queue_full");
		const controller = new AbortController();
		const signal = AbortSignal.any([roundSignal, controller.signal]);
		const timer = setTimeout(
			() => controller.abort(new QuotaQueryError("timeout")),
			Math.max(
				1,
				Math.min(
					limits.requestTimeoutMs ?? BALANCE_REQUEST_TIMEOUT_MS,
					requestDeadlineAt - Date.now(),
				),
			),
		);
		try {
			const response = await abortableRequest(
				Promise.resolve().then(() => {
					if (signal.aborted) throw cancelledError(signal);
					return hostRequest(
						{
							reference: params.reference,
							method: "GET",
							path,
							...(destination === "site-account" ? { destination } : {}),
							...(headers ? { headers } : {}),
							...(query ? { query } : {}),
						},
						signal,
					);
				}),
				signal,
			);
			if (signal.aborted) throw cancelledError(signal);
			return parseConnectionJson(
				response,
				limits.maxResponseBytes ?? BALANCE_MAX_RESPONSE_BYTES,
				destination === "site-account" ? "site-token" : "provider-key",
			);
		} catch (error) {
			if (error instanceof BalanceProbeRequestError) throw error;
			if (error instanceof QuotaQueryError)
				throw new BalanceProbeRequestError(
					error.code === "auth_failed"
						? "auth"
						: error.code === "invalid_configuration"
							? "invalid_configuration"
							: error.code === "invalid_response"
								? "invalid_response"
								: "transient",
					error.code,
				);
			throw new BalanceProbeRequestError("transient");
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Settings connections resolve the saved URL and credentials entirely inside the host. */
export function createSettingsConnectionRequest(
	params: QuotaQueryParams,
	hostRequest: HostRequest,
	roundSignal: AbortSignal,
	limits: JsonRequestLimits = {},
) {
	let count = 0;
	return async (connectionId: string): Promise<unknown> => {
		if (!/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/.test(connectionId))
			throw new BalanceProbeRequestError("invalid_configuration");
		const settings = params.settings;
		if (!settings) throw new BalanceProbeRequestError("invalid_configuration");
		if (roundSignal.aborted) throw cancelledError(roundSignal);
		const requestDeadlineAt = params.deadlineAt;
		if (Date.now() >= requestDeadlineAt) throw new BalanceProbeRequestError("transient", "timeout");
		if (++count > (limits.maxRequests ?? 8))
			throw new BalanceProbeRequestError("transient", "queue_full");
		const controller = new AbortController();
		const signal = AbortSignal.any([roundSignal, controller.signal]);
		const timer = setTimeout(
			() => controller.abort(new QuotaQueryError("timeout")),
			Math.max(
				1,
				Math.min(
					limits.requestTimeoutMs ?? BALANCE_REQUEST_TIMEOUT_MS,
					requestDeadlineAt - Date.now(),
				),
			),
		);
		try {
			const request: SettingsConnectionRequest = {
				reference: settings.reference,
				connectionId,
			};
			const response = await abortableRequest(
				Promise.resolve().then(() => {
					if (signal.aborted) throw cancelledError(signal);
					return hostRequest("provider.settings.connection.request", request, signal);
				}),
				signal,
			);
			if (signal.aborted) throw cancelledError(signal);
			return parseConnectionJson(
				response,
				limits.maxResponseBytes ?? BALANCE_MAX_RESPONSE_BYTES,
				"settings-account",
			);
		} catch (error) {
			if (error instanceof BalanceProbeRequestError) throw error;
			if (error instanceof QuotaQueryError)
				throw new BalanceProbeRequestError(
					error.code === "auth_failed"
						? "auth"
						: error.code === "invalid_configuration"
							? "invalid_configuration"
							: error.code === "invalid_response"
								? "invalid_response"
								: "transient",
					error.code,
				);
			throw new BalanceProbeRequestError("transient");
		} finally {
			clearTimeout(timer);
		}
	};
}

/** Credential-free bridge: a destination kind selects only a host-saved origin and credential. */
export function createRelayRequest(
	params: QuotaQueryParams,
	hostRequest: HostRequest,
	signal: AbortSignal,
	limits: JsonRequestLimits = {},
): BalanceRequest {
	const siteRoot = params.target.siteQuota?.root;
	const origin = new URL(siteRoot ?? params.target.baseUrl).origin;
	const request = createJsonConnectionRequest(params, hostRequest, signal, limits);
	return async (url, suppliedAuth = "provider-key") => {
		const auth =
			typeof suppliedAuth === "boolean" ? (suppliedAuth ? "provider-key" : "none") : suppliedAuth;
		let target: URL;
		try {
			target = new URL(url);
		} catch {
			throw new BalanceProbeRequestError("invalid_configuration");
		}
		if (
			url.length > 4096 ||
			target.origin !== origin ||
			target.username ||
			target.password ||
			target.search ||
			target.hash ||
			!["http:", "https:"].includes(target.protocol)
		)
			throw new BalanceProbeRequestError("invalid_configuration");
		if (auth === "site-token") {
			if (!siteRoot || url !== `${siteRoot.replace(/\/+$/, "")}/api/user/self`)
				throw new BalanceProbeRequestError("invalid_configuration");
		} else if (
			params.target.siteQuota ||
			(auth === "none" && !target.pathname.endsWith("/api/status"))
		) {
			throw new BalanceProbeRequestError("invalid_configuration");
		}
		return request(
			target.pathname,
			{ accept: "application/json" },
			undefined,
			auth === "none" ? RELAY_METADATA_RETURN_BUDGET_MS : 0,
			auth === "site-token" ? "site-account" : "provider",
		);
	};
}
