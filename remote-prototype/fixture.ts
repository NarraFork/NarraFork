import { createHash, randomBytes } from "node:crypto";
import type { ServerWebSocket } from "bun";
import { sign, verify } from "hono/jwt";
import { LIMITS } from "../shared/remote-access/protocol";

interface FixtureSocket {
	userId: string;
}

/** Isolated test-only backend. No production imports, database, filesystem or user data. */
export async function startFixture(
	options: {
		port?: number;
		tokenSeconds?: number;
		onSessionInvalidated?: (token: string) => void;
	} = {},
) {
	const bridgeSecret = randomBytes(32).toString("hex");
	const jwtSecret = randomBytes(32).toString("hex");
	const expiresAt = Math.floor(Date.now() / 1000) + (options.tokenSeconds ?? 3600);
	const mintToken = (role: "admin" | "user") =>
		sign(
			{ sub: `fixture-${role}`, role, exp: expiresAt, jti: randomBytes(16).toString("hex") },
			jwtSecret,
		);
	const adminToken = await mintToken("admin");
	const userToken = await mintToken("user");
	const revoked = new Set<string>();
	const sockets = new Set<ServerWebSocket<FixtureSocket>>();
	const idleWaiters = new Set<() => void>();
	const counters = { requests: 0, requestBytes: 0, responseBytes: 0, activeStreams: 0, sockets: 0 };
	async function principal(token: string) {
		if (revoked.has(token)) throw new Error("REVOKED");
		const claims = await verify(token, jwtSecret, "HS256");
		return { userId: String(claims.sub), role: String(claims.role), expiresAt: Number(claims.exp) };
	}
	async function readBounded(request: Request, maximum: number) {
		const reader = request.body?.getReader();
		let bytes = 0;
		const hash = createHash("sha256");
		try {
			if (reader)
				for (;;) {
					const { value, done } = await reader.read();
					if (done) break;
					bytes += value.byteLength;
					if (bytes > maximum) {
						await reader.cancel();
						throw new Error("TOO_LARGE");
					}
					hash.update(value);
				}
		} finally {
			reader?.releaseLock();
		}
		counters.requestBytes += bytes;
		return { bytes, sha256: hash.digest("hex") };
	}
	async function smallJson(request: Request): Promise<{ username?: string; password?: string }> {
		const reader = request.body?.getReader();
		if (!reader) throw new Error("INVALID_JSON");
		const chunks: Uint8Array[] = [];
		let total = 0;
		try {
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				total += value.byteLength;
				if (total > 4096) {
					await reader.cancel();
					throw new Error("TOO_LARGE");
				}
				chunks.push(value);
			}
		} finally {
			reader.releaseLock();
		}
		const bytes = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			bytes.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return JSON.parse(new TextDecoder().decode(bytes)) as { username?: string; password?: string };
	}
	const server = Bun.serve<FixtureSocket>({
		hostname: "127.0.0.1",
		port: options.port ?? 0,
		maxRequestBodySize: LIMITS.fileBytes,
		async fetch(request, runtime) {
			if (request.headers.get("X-NarraFork-Bridge") !== bridgeSecret) {
				return Response.json({ code: "BRIDGE_AUTH_REQUIRED" }, { status: 401 });
			}
			counters.requests += 1;
			const url = new URL(request.url);
			if (url.pathname === "/api/auth/login" && request.method === "POST") {
				if (Number(request.headers.get("content-length")) > 4096)
					return new Response(null, { status: 413 });
				// This endpoint is protected by the private bridge, never a public default account.
				try {
					const body = await smallJson(request);
					if (body.username === "admin" && body.password === "prototype-admin") {
						return Response.json({ token: await mintToken("admin"), role: "admin", expiresAt });
					}
					if (body.username === "user" && body.password === "user-password") {
						return Response.json({ token: await mintToken("user"), role: "user", expiresAt });
					}
				} catch (error) {
					return Response.json(
						{
							code:
								error instanceof Error && error.message === "TOO_LARGE"
									? "TOO_LARGE"
									: "INVALID_JSON",
						},
						{ status: error instanceof Error && error.message === "TOO_LARGE" ? 413 : 400 },
					);
				}
				return Response.json({ code: "LOGIN_FAILED" }, { status: 401 });
			}
			const token =
				url.pathname === "/ws/narrator"
					? (url.searchParams.get("token") ?? "")
					: (request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
			let user: Awaited<ReturnType<typeof principal>>;
			try {
				user = await principal(token);
			} catch {
				return Response.json({ code: "SESSION_INVALID" }, { status: 401 });
			}
			if (url.pathname === "/api/auth/me") return Response.json(user);
			if (user.role !== "admin") return Response.json({ code: "ADMIN_REQUIRED" }, { status: 403 });
			if (url.pathname === "/ws/narrator") {
				if (runtime.upgrade(request, { data: { userId: user.userId } })) return;
				return new Response(null, { status: 400 });
			}
			if (url.pathname === "/api/health")
				return Response.json({ version: "prototype-1", apiVersion: 1 });
			if (url.pathname === "/api/projects")
				return Response.json([{ id: "demo", name: "Isolated prototype" }]);
			if (url.pathname === "/api/echo") {
				if (request.method === "HEAD") return new Response(null, { status: 204 });
				const body = await readBounded(request, LIMITS.jsonBytes);
				return Response.json(
					{ method: request.method, ...body },
					{
						headers: {
							"X-Fixture-Response": "preserved",
							"Content-Disposition": "inline",
							"X-NarraFork-Session-Token": token,
						},
					},
				);
			}
			if (url.pathname === "/api/upload" && request.method === "POST") {
				try {
					return Response.json({
						...(await readBounded(request, LIMITS.fileBytes)),
						contentType: request.headers.get("content-type"),
					});
				} catch {
					return Response.json({ code: "TOO_LARGE" }, { status: 413 });
				}
			}
			if (url.pathname === "/api/download" || url.pathname === "/api/events") {
				const events = url.pathname === "/api/events";
				const size = events ? 0 : Number(url.searchParams.get("size") ?? "131072");
				if (!Number.isSafeInteger(size) || size < 0 || size > LIMITS.fileBytes)
					return new Response(null, { status: 413 });
				const repetitions = Number(url.searchParams.get("repeat") ?? "1");
				if (!Number.isSafeInteger(repetitions) || repetitions < 1 || repetitions > 32)
					return new Response(null, { status: 400 });
				const sse = new TextEncoder().encode(
					'event: update\ndata: {"text":"中文分片"}\n\nevent: complete\ndata: {}\n\n'.repeat(
						repetitions,
					),
				);
				let offset = 0;
				let finished = false;
				counters.activeStreams += 1;
				const finish = () => {
					if (!finished) {
						finished = true;
						counters.activeStreams -= 1;
						if (counters.activeStreams === 0) for (const resolve of [...idleWaiters]) resolve();
					}
				};
				const body = new ReadableStream<Uint8Array>(
					{
						async pull(controller) {
							if (finished) return;
							const total = events ? sse.byteLength : size;
							if (offset >= total) {
								finish();
								controller.close();
								return;
							}
							if (events) await new Promise((resolve) => setTimeout(resolve, 3));
							if (finished) return;
							const length = Math.min(events ? 1 : 16360, total - offset);
							const chunk = events
								? sse.slice(offset, offset + length)
								: new Uint8Array(length).fill(0x61);
							offset += length;
							counters.responseBytes += chunk.byteLength;
							controller.enqueue(chunk);
						},
						cancel() {
							finish();
						},
					},
					{ highWaterMark: 1 },
				);
				return new Response(body, {
					headers: { "Content-Type": events ? "text/event-stream" : "application/octet-stream" },
				});
			}
			if (url.pathname === "/api/redirect")
				return new Response(null, {
					status: 302,
					headers: { Location: "http://192.0.2.1/private" },
				});
			return Response.json({ code: "NOT_FOUND" }, { status: 404 });
		},
		websocket: {
			open(socket) {
				sockets.add(socket);
				counters.sockets = sockets.size;
			},
			message(socket, message) {
				const text = String(message);
				if (Buffer.byteLength(text) > LIMITS.controlBytes) {
					socket.close(1009, "TOO_LARGE");
					return;
				}
				try {
					const event = JSON.parse(text) as { type?: string; narratorIds?: string[] };
					if (event.type === "ping") socket.send(JSON.stringify({ type: "pong" }));
					else if (event.type === "subscribe") {
						socket.send(
							JSON.stringify({ type: "subscribed", narratorIds: event.narratorIds ?? [] }),
						);
						socket.send(JSON.stringify({ type: "fixture.update", seq: 1, text: "实时中文" }));
					}
				} catch {
					socket.close(1007, "INVALID_JSON");
				}
			},
			close(socket) {
				sockets.delete(socket);
				counters.sockets = sockets.size;
			},
		},
	});
	return {
		server,
		bridgeUrl: `http://127.0.0.1:${server.port}`,
		bridgeSecret,
		adminToken,
		userToken,
		stats: () => ({ ...counters }),
		waitForIdle(timeoutMs = 3000): Promise<void> {
			if (counters.activeStreams === 0) return Promise.resolve();
			return new Promise((resolve, reject) => {
				const done = () => {
					clearTimeout(timer);
					idleWaiters.delete(done);
					resolve();
				};
				const timer = setTimeout(() => {
					idleWaiters.delete(done);
					reject(new Error("FIXTURE_STREAM_LEAK"));
				}, timeoutMs);
				idleWaiters.add(done);
			});
		},
		revoke: (token: string) => {
			revoked.add(token);
			options.onSessionInvalidated?.(token);
		},
		stop: () => {
			for (const socket of sockets) socket.close();
			server.stop(true);
		},
	};
}
