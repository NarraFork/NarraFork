import type { ServerWebSocket } from "bun";
import { REMOTE_PRODUCTION_LIMITS as limits } from "../../shared/remote-access/application";
import {
	REMOTE_BRIDGE_HEADERS as headers,
	REMOTE_SESSION_INTROSPECT_PATH,
} from "../../shared/remote-access/ipc";
import { resolveRemoteRequestRule } from "../../shared/remote-access/request-policy";
import type { createServerRequestDispatcher } from "../http-dispatcher";
import type { ServerRequestLifecycle } from "../http-request-lifecycle";
import { AppError } from "../lib/errors";
import { markTrustedRemoteRequest } from "../lib/remote-request-context";
import type { StartupReadinessGate } from "../lib/startup-readiness";
import { type WSData, wsHandlers } from "../websocket/ws-handler";
import {
	equalRemoteSecret,
	type RemoteAccessRegistry,
	type RemoteContext,
} from "./remote-access-registry";

const REMOTE_SOCKET_MESSAGES = new Set([
	"pong",
	"subscribe",
	"unsubscribe",
	"sync_check",
	"permission_decision",
	"buffer_message",
	"cancel_buffer",
	"update_buffer",
	"remove_buffer",
	"presence_join",
	"presence_leave",
]);

function errorResponse(error: unknown): Response {
	if (error instanceof AppError)
		return Response.json({ error: error.message, code: error.code }, { status: error.statusCode });
	if (["SessionTokenRevoked", "SessionTokenExpired"].includes((error as Error)?.name))
		return Response.json({ error: "Session unavailable" }, { status: 401 });
	return Response.json({ error: "Remote connection unavailable" }, { status: 503 });
}
function limitedRequest(
	request: Request,
	maximum: number,
	signal: AbortSignal,
): Request | Response {
	const length = request.headers.get("content-length");
	if (length && (!/^\d+$/.test(length) || Number(length) > maximum))
		return new Response("Request too large", { status: 413 });
	const cleanHeaders = new Headers(request.headers);
	for (const key of Object.values(headers)) cleanHeaders.delete(key);
	for (const key of ["cookie", "forwarded", "x-forwarded-for", "x-forwarded-host", "x-real-ip"])
		cleanHeaders.delete(key);
	let seen = 0;
	const body = request.body?.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > maximum) controller.error(new Error("REMOTE_REQUEST_TOO_LARGE"));
				else controller.enqueue(chunk);
			},
		}),
	);
	return new Request(request.url, {
		method: request.method,
		headers: cleanHeaders,
		body,
		signal,
		duplex: "half",
	} as RequestInit);
}

function closeRemoteSocket(socket: ServerWebSocket<WSData>, context?: RemoteContext): void {
	const cause = context?.controller.signal.reason;
	const reason = cause instanceof Error ? cause.message : "";
	const expired = !!context?.session && context.session.expiresAt <= Date.now() / 1000;
	if (expired || reason === "authorization_changed" || reason === "session_invalidated") {
		socket.close(4001, "Remote session ended");
	} else if (["grant_revoked", "expired", "login_timeout"].includes(reason)) {
		// Pairing is a different authority from an otherwise valid NF session.
		socket.close(1008, "Remote pairing ended");
	} else {
		// In particular, a storage outage must never instruct the browser to erase a
		// valid session token. Epoch/process shutdowns are transport failures too.
		socket.close(1013, "Remote connection unavailable; reconnect");
	}
}
/** A private loopback listener; it never registers its introspection route on the public app. */
export function createRemoteAccessBridge(options: {
	dispatch: ReturnType<typeof createServerRequestDispatcher>;
	lifecycle: ServerRequestLifecycle;
	readiness: StartupReadinessGate;
	registry: RemoteAccessRegistry;
	processCapability: string;
	budgets?: Partial<
		Record<
			| "requestTimeoutMs"
			| "headerTimeoutMs"
			| "streamLifetimeMs"
			| "idleTimeoutMs"
			| "stallTimeoutMs",
			number
		>
	>;
}) {
	const budgets = { ...limits, ...options.budgets };
	const socketContexts = new WeakMap<WSData, RemoteContext>();
	const socketCleanup = new WeakMap<ServerWebSocket<WSData>, () => void>();
	let host = "";
	const listener = Bun.serve<WSData>({
		hostname: "127.0.0.1",
		port: 0,
		idleTimeout: 255,
		maxRequestBodySize: limits.fileBytes,
		websocket: {
			...wsHandlers,
			open(socket) {
				const context = socketContexts.get(socket.data);
				if (!context || context.controller.signal.aborted) {
					closeRemoteSocket(socket, context);
					return;
				}
				const close = () => closeRemoteSocket(socket, context);
				context.resources.add(close);
				socketCleanup.set(socket, close);
				wsHandlers.open?.(socket);
			},
			message(socket, message) {
				const context = socketContexts.get(socket.data);
				if (
					!context ||
					context.controller.signal.aborted ||
					!context.session ||
					context.session.expiresAt <= Date.now() / 1000
				) {
					closeRemoteSocket(socket, context);
					return;
				}
				if (context.frozen) {
					socket.close(1013, "Authorization check pending; reconnect");
					return;
				}
				// The narrator channel is not a tunnel for editor/outline/git/chat-room protocols.
				if (typeof message !== "string" || Buffer.byteLength(message) > limits.socketMessageBytes) {
					socket.close(1009, "Unsupported remote message");
					return;
				}
				try {
					const frame = JSON.parse(message) as { type?: unknown };
					if (typeof frame.type !== "string" || !REMOTE_SOCKET_MESSAGES.has(frame.type)) {
						socket.close(1008, "Remote socket operation denied");
						return;
					}
				} catch {
					socket.close(1008, "Invalid remote message");
					return;
				}
				return wsHandlers.message(socket, message);
			},
			close(socket, code, reason) {
				const close = socketCleanup.get(socket);
				if (close) socketContexts.get(socket.data)?.resources.delete(close);
				socketCleanup.delete(socket);
				wsHandlers.close?.(socket, code, reason);
			},
		},
		async fetch(request, server) {
			const url = new URL(request.url);
			const ip = server.requestIP(request)?.address;
			if (
				(ip !== "127.0.0.1" && ip !== "::ffff:127.0.0.1") ||
				request.headers.get("host") !== host ||
				!equalRemoteSecret(request.headers.get(headers.process), options.processCapability) ||
				request.headers.get(headers.epoch) !== options.registry.epoch
			)
				return new Response("Forbidden", { status: 403 });
			const context = options.registry.get(
				request.headers.get(headers.context),
				request.headers.get(headers.capability),
			);
			if (!context) return new Response("Unknown remote context", { status: 403 });
			if (!options.lifecycle.accepting)
				return new Response("Server is shutting down", { status: 503 });
			await options.readiness.barrier;
			if (!options.lifecycle.accepting || context.controller.signal.aborted)
				return new Response("Remote connection closed", { status: 503 });
			try {
				if (url.pathname === REMOTE_SESSION_INTROSPECT_PATH) {
					if (request.method !== "POST" || url.search)
						return new Response("Forbidden", { status: 403 });
					const input = limitedRequest(
						request,
						4096,
						AbortSignal.any([request.signal, context.controller.signal]),
					);
					if (input instanceof Response) return input;
					const value = (await input.json()) as { token?: unknown };
					if (typeof value.token !== "string" || value.token.length > 2048)
						return new Response("Invalid token", { status: 400 });
					return Response.json(await options.registry.bind(context, value.token), {
						headers: { "Cache-Control": "no-store" },
					});
				}
				if (context.frozen)
					return new Response("Authorization is being checked", {
						status: 503,
						headers: { "Retry-After": "1" },
					});
				const rule = resolveRemoteRequestRule(
					request.method,
					url.pathname,
					context.session ? "ready" : "paired",
				);
				if (!rule || url.searchParams.has("share"))
					return new Response("Remote request denied", { status: 403 });
				if (rule.phase === "ready") {
					const token =
						request.headers.get("authorization")?.replace(/^Bearer /, "") ??
						(url.pathname === "/ws/narrator" ? url.searchParams.get("token") : null);
					if (!token) return new Response("Session required", { status: 401 });
					await options.registry.authorize(context, token);
				}
				if (context.resources.size >= 32)
					return new Response("Remote capacity reached", {
						status: 429,
						headers: { "Retry-After": "1" },
					});
				const controller = new AbortController();
				const signal = AbortSignal.any([
					request.signal,
					context.controller.signal,
					controller.signal,
				]);
				const cancel = () => controller.abort();
				context.resources.add(cancel);
				const startedAt = Date.now();
				let timer = setTimeout(
					cancel,
					rule.profile === "sse"
						? budgets.headerTimeoutMs
						: Math.min(budgets.headerTimeoutMs, budgets.requestTimeoutMs),
				);
				let lifetime: ReturnType<typeof setTimeout> | undefined;
				let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
				let closed = false;
				const cleanup = () => {
					clearTimeout(timer);
					clearTimeout(lifetime);
					context.resources.delete(cancel);
				};
				try {
					const limited = limitedRequest(request, rule.requestBytes, signal);
					if (limited instanceof Response) {
						cleanup();
						return limited;
					}
					markTrustedRemoteRequest(limited, {
						contextId: context.id,
						grantId: context.peer.grantId,
						clientIp: `remote-grant:${context.peer.grantId}`,
					});
					const response = await options.dispatch(limited, {
						requestIP: server.requestIP.bind(server),
						upgrade(_req, config) {
							if (!config?.data || context.controller.signal.aborted || context.frozen)
								return false;
							socketContexts.set(config.data, context);
							return server.upgrade(request, config);
						},
					});
					if (signal.aborted) {
						await response?.body?.cancel().catch(() => {});
						cleanup();
						return new Response("Remote connection closed", { status: 503 });
					}
					if (!response?.body) {
						cleanup();
						return response;
					}
					if (response.status >= 300 && response.status < 400) {
						await response.body.cancel();
						cleanup();
						return new Response("Remote redirects denied", { status: 502 });
					}
					clearTimeout(timer);
					const sse =
						rule.profile === "sse" &&
						response.headers.get("content-type")?.startsWith("text/event-stream");
					lifetime = setTimeout(
						cancel,
						sse
							? budgets.streamLifetimeMs
							: Math.max(1, budgets.requestTimeoutMs - (Date.now() - startedAt)),
					);
					let total = 0;
					const responseReader = response.body.getReader();
					reader = responseReader;
					const stream = new ReadableStream<Uint8Array>({
						start(output) {
							signal.addEventListener(
								"abort",
								() => {
									if (closed) return;
									closed = true;
									output.error(new DOMException("Remote stream cancelled", "AbortError"));
									void reader
										?.cancel()
										.catch(() => {})
										.finally(cleanup);
								},
								{ once: true },
							);
							if (signal.aborted) {
								closed = true;
								output.error(new Error("Remote stream cancelled"));
								void reader
									?.cancel()
									.catch(() => {})
									.finally(cleanup);
							}
						},
						async pull(output) {
							clearTimeout(timer);
							timer = setTimeout(cancel, sse ? budgets.idleTimeoutMs : budgets.requestTimeoutMs);
							try {
								const item = await responseReader.read();
								if (closed) return;
								if (item.done) {
									closed = true;
									output.close();
									cleanup();
									return;
								}
								total += item.value.byteLength;
								if (total > rule.responseBytes) {
									cancel();
									return;
								}
								output.enqueue(item.value);
								clearTimeout(timer);
								timer = setTimeout(cancel, budgets.stallTimeoutMs);
							} catch (error) {
								if (!closed) {
									closed = true;
									output.error(error);
								}
								cleanup();
							}
						},
						async cancel(reason) {
							closed = true;
							controller.abort();
							try {
								await reader?.cancel(reason);
							} finally {
								cleanup();
							}
						},
					});
					return new Response(stream, {
						status: response.status,
						statusText: response.statusText,
						headers: response.headers,
					});
				} catch (error) {
					cleanup();
					throw error;
				}
			} catch (error) {
				return errorResponse(error);
			}
		},
	});
	host = listener.url.host;
	return {
		url: listener.url.origin,
		stop() {
			options.registry.dispose();
			void listener.stop(true);
		},
	};
}
