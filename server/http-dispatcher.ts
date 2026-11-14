import { eq } from "drizzle-orm";
import type { Hono } from "hono";
import {
	declaredBodyExceeds,
	isStorageImportUpload,
	MAX_ORDINARY_BODY_BYTES,
} from "../shared/storage-transfer";
import { isStreamingAttachmentUpload } from "../shared/text-file-types";
import type { AppEnv } from "./app";
import { db } from "./db";
import { users } from "./db/schema";
import type { ServerRequestLifecycle } from "./http-request-lifecycle";
import { verifyToken } from "./lib/auth";
import { isTrustedProxyAddress, resolveClientIp } from "./lib/client-ip";
import { validateAccessTokenById } from "./lib/oauth-provider";
import { trustedRemoteRequestContext } from "./lib/remote-request-context";
import { settings } from "./lib/settings";
import { buildHealthPayload, type createStartupReadinessGate } from "./lib/startup-readiness";
import type { VNetRelayAuth } from "./lib/vnet/types";
import {
	consumeOAuthWsTicket,
	EXTERNAL_NARRATORS_WS_CHANNEL,
	getExternalWebSocketRolloutSettings,
	isExternalWebSocketOriginAllowed,
} from "./services/oauth-ws-ticket-service";
import { publicShareConnectionBudget } from "./services/public-narrator-share-connections";
import {
	type VerifiedPublicShare,
	verifyPublicShare,
} from "./services/public-narrator-share-service";
import { canAcceptExternalNarratorConnection } from "./websocket/oauth-connection-registry";
import {
	narratorWebSocketBackendRefusal,
	resolveExternalNarratorWSData,
	resolveWSData,
	type WSData,
} from "./websocket/ws-handler";

async function resolveVNetRelayAuth(req: Request, url: URL): Promise<VNetRelayAuth | null> {
	if (!settings.vnet?.enabled) return null;
	const bearer = req.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
	const queryToken = url.searchParams.get("token") ?? undefined;
	const token = bearer || queryToken;
	const relayToken = settings.vnet.relayToken?.trim();

	if (token && relayToken && token === relayToken) {
		return { kind: "relay-token" };
	}
	if (token) {
		try {
			const payload = await verifyToken(token);
			return { kind: "session", userId: payload.sub };
		} catch {
			// Fall through to anonymous only when explicitly enabled.
		}
	}
	if (settings.vnet.allowAnonymousRelay) {
		return { kind: "anonymous" };
	}
	return null;
}

const BODYLESS_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/**
 * `maxRequestBodySize` 是全局的，导入预览把它抬到 4 GB。
 * 其它带正文的请求仍按 128 MB 拒绝：声明的 Content-Length 直接 413，
 * 缺省或偏小的长度则在读流时计数，避免未声明长度的请求把 4 GB 吃满。
 * WebSocket 升级在调用这里之前已经返回。
 */
function limitOrdinaryRequestBody(req: Request, url: URL): Request | Response {
	if (isStorageImportUpload(req.method, url.pathname)) return req;
	// 附件流式上传逐块落盘，并在 attachment-staging 里按实际字节数执行 1 GiB 上限，
	// 在这里按 128 MB 截断会让大附件永远传不上去。
	if (isStreamingAttachmentUpload(req.method, url.pathname)) return req;
	if (BODYLESS_METHODS.has(req.method.toUpperCase())) return req;
	if (declaredBodyExceeds(req.headers.get("content-length"), MAX_ORDINARY_BODY_BYTES)) {
		return new Response("Request body too large", {
			status: 413,
			headers: { "content-type": "text/plain; charset=utf-8" },
		});
	}
	if (!req.body) return req;
	let seen = 0;
	const limited = req.body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			transform(chunk, controller) {
				seen += chunk.byteLength;
				if (seen > MAX_ORDINARY_BODY_BYTES) {
					controller.error(new Error("Request body too large"));
					return;
				}
				controller.enqueue(chunk);
			},
		}),
	);
	return new Request(req, { body: limited, duplex: "half" } as RequestInit);
}

/** The sole HTTP/WS dispatcher, shared by public, manager and private RTC listeners. */
export function createServerRequestDispatcher(options: {
	app: Hono<AppEnv>;
	lifecycle: ServerRequestLifecycle;
	startupReadiness: ReturnType<typeof createStartupReadinessGate>;
	activeDatabaseBackend: "sqlite" | "postgres";
}) {
	const { app, lifecycle, startupReadiness, activeDatabaseBackend } = options;
	return (req: Request, server: Pick<Bun.Server<WSData>, "requestIP" | "upgrade">) => {
		if (!lifecycle.accepting) {
			return new Response("Server is shutting down", {
				status: 503,
				headers: { "Retry-After": "1" },
			});
		}
		const requestId = lifecycle.nextRequestId();
		const execution = lifecycle.context.run(requestId, async () => {
			const url = new URL(req.url);

			// Keep liveness available while exposing whether continuation recovery is still
			// running or has failed. Recovery is considered admitted once every continuation
			// has been protected and mounted in the background; terminal Agent/Await and user
			// permission waits must never hold this barrier.
			if (url.pathname === "/api/health") {
				const healthResponse = await app.fetch(req);
				const healthPayload = (await healthResponse.json().catch(() => ({}))) as Record<
					string,
					unknown
				>;
				const headers = new Headers(healthResponse.headers);
				headers.delete("content-length");
				headers.set("content-type", "application/json; charset=UTF-8");
				return new Response(
					JSON.stringify({
						...buildHealthPayload(healthPayload, startupReadiness.state),
						// Which database backend this process wired at startup. A monitor that
						// watches a PostgreSQL deployment must be able to tell it actually came
						// up on PostgreSQL — a silent fallback would report a healthy SQLite.
						database: { backend: activeDatabaseBackend },
					}),
					{
						status: healthResponse.status,
						headers,
					},
				);
			}

			const narratorWsRefusal = narratorWebSocketBackendRefusal(
				url.pathname,
				activeDatabaseBackend,
			);
			if (narratorWsRefusal) return narratorWsRefusal;

			// Wait for recovery to reach a terminal outcome so restored narrators observe a
			// consistent state. A recovery failure is scoped to its narrator and never
			// closes the HTTP surface: the UI is what repairs that narrator's state.
			await startupReadiness.barrier;
			if (!lifecycle.accepting) return new Response("Server is shutting down", { status: 503 });

			if (url.pathname === "/ws/external/v1/narrators") {
				const rollout = getExternalWebSocketRolloutSettings();
				const origin = req.headers.get("origin");
				if (!isExternalWebSocketOriginAllowed(origin, rollout.allowedOrigins)) {
					return new Response("WebSocket Origin is not allowed", { status: 403 });
				}
				if (!canAcceptExternalNarratorConnection()) {
					return new Response("External narrator WebSocket capacity reached", { status: 503 });
				}
				const ticket = url.searchParams.get("ticket");
				if (!ticket) return new Response("WebSocket ticket required", { status: 401 });
				const consumed = consumeOAuthWsTicket(ticket, EXTERNAL_NARRATORS_WS_CHANNEL);
				if (!consumed) return new Response("Invalid or expired WebSocket ticket", { status: 401 });
				const live = await validateAccessTokenById(consumed.auth.oauth.tokenId).catch(() => null);
				if (
					!live ||
					live.userId !== consumed.auth.user.sub ||
					live.clientId !== consumed.auth.oauth.clientId ||
					live.oauthClientId !== consumed.auth.oauth.oauthClientId ||
					live.grantId !== consumed.auth.oauth.grantId ||
					live.refreshFamilyId !== consumed.auth.oauth.refreshFamilyId ||
					!live.scopes.includes("narrator.read") ||
					!live.scopes.includes("event.subscribe")
				) {
					return new Response("OAuth authorization is no longer valid", { status: 401 });
				}
				const upgraded = server.upgrade(req, {
					data: resolveExternalNarratorWSData(consumed.auth),
				});
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			if (url.pathname === "/ws/vnet") {
				const auth = await resolveVNetRelayAuth(req, url);
				if (!auth) {
					return new Response("VNet relay authentication required", { status: 401 });
				}
				const wsData = resolveWSData(url, undefined, auth);
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}
				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Remote executor devices authenticate via the hello frame (device token),
			// not a JWT, so accept the upgrade here and let the handshake verify.
			if (url.pathname === "/ws/device") {
				const wsData = resolveWSData(url);
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}
				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// WebSocket upgrade for /ws/narrator and /ws/terminal
			if (url.pathname.startsWith("/ws")) {
				// Anonymous public-share reader: `?share=<shareId>&token=<secret>` instead
				// of a session token. Verified once at upgrade, scoped at subscribe time
				// (narrator-ws reads `ws.data.publicShare`), and dropped on revocation.
				const shareId = url.searchParams.get("share");
				if (shareId && url.pathname === "/ws/narrator") {
					const shareToken = url.searchParams.get("token");
					if (!shareToken) {
						return new Response("Authentication required", { status: 401 });
					}
					let share: VerifiedPublicShare;
					try {
						share = verifyPublicShare(shareId, `Share ${shareToken}`);
					} catch {
						return new Response("Share link unavailable", { status: 401 });
					}
					const wsData = resolveWSData(url, undefined, undefined, undefined, share);
					if (!wsData) {
						return new Response("Unknown WebSocket endpoint", { status: 404 });
					}
					const ip = resolveClientIp({
						peerIp: server.requestIP(req)?.address,
						xForwardedFor: req.headers.get("x-forwarded-for"),
						xRealIp: req.headers.get("x-real-ip"),
						trustedProxyCidrs: settings.auth.trustedProxyCidrs ?? ["127.0.0.0/8", "::1/128"],
					});
					if (wsData.channel !== "narrator") {
						return new Response("Unknown WebSocket endpoint", { status: 404 });
					}
					const upgraded = publicShareConnectionBudget.upgrade(share.shareId, ip, (lease) => {
						wsData.publicShareConnectionLease = lease;
						return server.upgrade(req, { data: wsData });
					});
					if (upgraded === null) {
						return new Response("Too many sharing connections", {
							status: 429,
							headers: { "Retry-After": "15" },
						});
					}
					if (upgraded) return undefined;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}

				// Verify the session token from the query param
				const token = url.searchParams.get("token");
				if (!token) {
					return new Response("Authentication required", { status: 401 });
				}
				let payload: Awaited<ReturnType<typeof verifyToken>>;
				try {
					payload = await verifyToken(token);
				} catch {
					return new Response("Invalid or expired token", { status: 401 });
				}

				// Look up user info for presence tracking
				const user = await db.query.users.findFirst({
					where: eq(users.id, payload.sub),
					columns: {
						id: true,
						username: true,
						avatarColor: true,
						avatarImageId: true,
						// Read live, so a demotion applies to the next socket. The narrator
						// subscribe path uses it for the admin short-circuit.
						role: true,
					},
				});
				// `verifyToken` already rejected revoked and expired sessions; a user row that
				// vanished since still fails the upgrade.
				if (!user) {
					return new Response("Invalid or expired token", { status: 401 });
				}
				const userInfo = user
					? {
							userId: user.id,
							username: user.username,
							avatarColor: user.avatarColor,
							avatarImageId: user.avatarImageId,
							role: user.role,
						}
					: undefined;

				// Remember the session so the socket can be re-checked when it lapses or
				// when the user's authorization changes (logout, revocation, role).
				const wsData = resolveWSData(url, userInfo, undefined, {
					sessionExp: payload.exp,
					sessionId: payload.sid,
					sessionUserId: payload.sub,
				});
				if (!wsData) {
					return new Response("Unknown WebSocket endpoint", { status: 404 });
				}

				const upgraded = server.upgrade(req, { data: wsData });
				if (upgraded) return undefined;
				return new Response("WebSocket upgrade failed", { status: 400 });
			}

			// Everything else goes to Hono. Resolve the client IP and whether the immediate
			// socket peer is trusted at the Bun boundary, so routes never trust forwarding
			// headers solely because a caller supplied them.
			const remote = trustedRemoteRequestContext(req);
			const peerIp = remote ? undefined : server.requestIP(req)?.address;
			const trustedProxyCidrs = settings.auth.trustedProxyCidrs ?? ["127.0.0.0/8", "::1/128"];
			const clientIp = resolveClientIp({
				peerIp,
				xForwardedFor: req.headers.get("x-forwarded-for"),
				xRealIp: req.headers.get("x-real-ip"),
				trustedProxyCidrs,
			});
			const limited = limitOrdinaryRequestBody(req, url);
			if (limited instanceof Response) return limited;
			return app.fetch(limited, {
				clientIp: remote?.clientIp ?? clientIp,
				peerIp,
				trustedProxy: !remote && isTrustedProxyAddress(peerIp, trustedProxyCidrs),
			});
		});
		return lifecycle.track(requestId, req, execution, !!trustedRemoteRequestContext(req));
	};
}
