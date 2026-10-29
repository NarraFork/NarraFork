import type { Server, ServerWebSocket } from "bun";
import {
	generateIdentity,
	hex,
	instanceId,
	sha256Hex,
	sign,
	verify,
} from "../shared/remote-access/identity";
import {
	APP_VERSION,
	LIMITS,
	type SessionTicket,
	ticketFields,
	VERSION,
} from "../shared/remote-access/protocol";

export { ticketFields } from "../shared/remote-access/protocol";

import * as valid from "./validation";

export interface CoordinatorOptions {
	host?: string;
	port?: number;
	leaseSeconds?: number;
	authTimeoutMs?: number;
	negotiationTimeoutMs?: number;
	allowLocalhost?: boolean;
	assetHandler?: (request: Request) => Response | undefined | Promise<Response | undefined>;
	/** Lower values are useful for isolated overload tests. */
	maxInstances?: number;
	maxConnections?: number;
	maxConnectionsPerIp?: number;
	sendQueueBytes?: number;
}

type Bucket = { start: number; count: number };
type IpBudget = { sockets: number; upgrade: Bucket; connect: Bucket };
type Connection = {
	role: "instance" | "browser";
	ip: string;
	challenge: string;
	ws?: ServerWebSocket<Connection>;
	closed: boolean;
	authenticated: boolean;
	authTimer?: ReturnType<typeof setTimeout>;
	instance?: Instance;
	session?: Session;
	queue: Promise<void>;
	queuedBytes: number;
	queuedMessages: number;
};
type Instance = {
	id: string;
	publicKey: string;
	epoch: string;
	connection: Connection;
	leaseUntil: number;
	discoveries: Map<string, valid.Discovery>;
	requests: Bucket;
	capRequests: Map<string, Bucket>;
	sessions: Set<Session>;
};
export type Ticket = SessionTicket;
type Session = {
	id: string;
	instance: Instance;
	browser: Connection;
	ticket: Ticket;
	counts: { instance: number; browser: number };
	timer?: ReturnType<typeof setTimeout>;
};

function randomId(): string {
	return hex(crypto.getRandomValues(new Uint8Array(24)));
}
function bucket(): Bucket {
	return { start: Date.now(), count: 0 };
}
function take(budget: Bucket, max: number): boolean {
	const now = Date.now();
	if (now - budget.start >= 60000) {
		budget.start = now;
		budget.count = 0;
	}
	return ++budget.count <= max;
}

/** A standalone, memory-only control plane. Never imports production routes or databases. */
export async function startCoordinator(options: CoordinatorOptions = {}) {
	const host = options.host ?? "127.0.0.1";
	if (!options.allowLocalhost) {
		throw new Error(
			"M1 plaintext listener requires explicit allowLocalhost; use a TLS reverse proxy for deployment",
		);
	}
	if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
		throw new Error("M1 coordinator must bind loopback; public deployment is not enabled");
	}
	const leaseMs = (options.leaseSeconds ?? 75) * 1000;
	const authMs = options.authTimeoutMs ?? 5000;
	const negotiationMs = options.negotiationTimeoutMs ?? 20000;
	if (![leaseMs, authMs, negotiationMs].every((n) => Number.isFinite(n) && n > 0))
		throw new Error("Invalid time budget");
	const maxInstances = options.maxInstances ?? 10000;
	const maxConnections = options.maxConnections ?? 20000;
	const maxPerIp = options.maxConnectionsPerIp ?? 64;
	const sendQueueBytes = options.sendQueueBytes ?? 256 * 1024;
	const identity = await generateIdentity();
	const instances = new Map<string, Instance>();
	const sessions = new Map<string, Session>();
	const connections = new Set<Connection>();
	const ips = new Map<string, IpBudget>();
	let stopping = false;
	let signalBytesIn = 0;
	let signalBytesOut = 0;
	let rejected = 0;

	function send(connection: Connection, message: unknown): boolean {
		if (connection.closed || !connection.ws) return false;
		const text = JSON.stringify(message);
		const bytes = new TextEncoder().encode(text).byteLength;
		if (bytes > LIMITS.signalBytes || connection.ws.getBufferedAmount() + bytes > sendQueueBytes) {
			close(connection, "SLOW_CONSUMER");
			return false;
		}
		const result = connection.ws.send(text);
		if (result === 0) {
			close(connection, "SEND_FAILED");
			return false;
		}
		signalBytesOut += bytes;
		if (connection.ws.getBufferedAmount() > sendQueueBytes) {
			close(connection, "SLOW_CONSUMER");
			return false;
		}
		return true;
	}
	function error(connection: Connection, code: string, sessionId?: string) {
		rejected++;
		send(connection, { type: "error", code, ...(sessionId ? { sessionId } : {}) });
	}
	function endSession(session: Session, code?: string, source?: Connection) {
		if (!sessions.delete(session.id)) return;
		clearTimeout(session.timer);
		session.instance.sessions.delete(session);
		if (session.browser.session === session) session.browser.session = undefined;
		if (code) {
			if (source !== session.browser) error(session.browser, code, session.id);
			if (source !== session.instance.connection)
				send(session.instance.connection, { type: "cancel", sessionId: session.id });
		}
	}
	function removeInstance(instance: Instance, code: string) {
		if (instances.get(instance.id) !== instance) return;
		instances.delete(instance.id);
		instance.discoveries.clear();
		instance.capRequests.clear();
		for (const session of [...instance.sessions]) endSession(session, code);
	}
	function close(connection: Connection, reason = "CLOSED") {
		if (connection.closed) return;
		connection.closed = true;
		clearTimeout(connection.authTimer);
		connections.delete(connection);
		const ip = ips.get(connection.ip);
		if (ip) ip.sockets--;
		if (connection.instance) removeInstance(connection.instance, reason);
		if (connection.session) endSession(connection.session, reason, connection);
		connection.ws?.close(1008, reason);
	}
	function current(connection: Connection): Instance | undefined {
		const entry = connection.instance;
		if (!entry || instances.get(entry.id) !== entry || entry.connection !== connection) return;
		if (entry.leaseUntil <= Date.now()) {
			removeInstance(entry, "LEASE_EXPIRED");
			close(connection, "LEASE_EXPIRED");
			return;
		}
		return entry;
	}
	function replaceDiscoveries(entry: Instance, list: valid.Discovery[]) {
		const previous = entry.capRequests;
		entry.discoveries = new Map(list.map((item) => [item.hash, { ...item }]));
		entry.capRequests = new Map(
			list.map((item) => [item.hash, previous.get(item.hash) ?? bucket()]),
		);
		for (const session of [...entry.sessions]) {
			if (
				!list.some(
					(item) => item.kind === session.ticket.targetKind && item.id === session.ticket.targetId,
				)
			)
				endSession(session, "DISCOVERY_REVOKED");
		}
	}
	async function register(connection: Connection, message: Record<string, unknown>) {
		const list = valid.discoveries(message.discoveries, Math.floor(Date.now() / 1000));
		if (
			!valid.exact(message, ["type", "publicKey", "signature", "discoveries"]) ||
			!valid.publicKey(message.publicKey) ||
			!valid.signature(message.signature) ||
			!list
		) {
			error(connection, "INVALID_REGISTER");
			close(connection);
			return;
		}
		const challenge = connection.challenge;
		connection.challenge = "";
		if (
			!(await verify(message.publicKey, message.signature, "register", [
				challenge,
				message.publicKey,
			])) ||
			connection.closed
		) {
			error(connection, "BAD_SIGNATURE");
			close(connection);
			return;
		}
		const id = await instanceId(message.publicKey);
		if (connection.closed) return;
		const old = instances.get(id);
		if (!old && instances.size >= maxInstances) {
			error(connection, "REGISTRY_FULL");
			close(connection);
			return;
		}
		const capRequests = new Map(old?.capRequests);
		if (old) close(old.connection, "REPLACED");
		const entry: Instance = {
			id,
			publicKey: message.publicKey,
			epoch: randomId(),
			connection,
			leaseUntil: Date.now() + leaseMs,
			discoveries: new Map(),
			requests: old?.requests ?? bucket(),
			capRequests,
			sessions: new Set(),
		};
		connection.instance = entry;
		connection.authenticated = true;
		clearTimeout(connection.authTimer);
		instances.set(id, entry);
		replaceDiscoveries(entry, list);
		send(connection, { type: "registered", instanceId: id, leaseEpoch: entry.epoch });
	}
	async function connect(connection: Connection, message: Record<string, unknown>) {
		if (
			!valid.exact(message, [
				"type",
				"instanceId",
				"discoveryCapability",
				"clientPublicKey",
				"offer",
				"offerSignature",
			]) ||
			typeof message.instanceId !== "string" ||
			!/^[a-z2-7]{52}$/.test(message.instanceId) ||
			!valid.opaque(message.discoveryCapability) ||
			!valid.publicKey(message.clientPublicKey) ||
			!valid.signature(message.offerSignature) ||
			!valid.sdp(message.offer)
		) {
			error(connection, "INVALID_CONNECT");
			close(connection);
			return;
		}
		const ip = ips.get(connection.ip);
		if (!ip || !take(ip.connect, 30)) {
			error(connection, "RATE_LIMIT");
			return;
		}
		const entry = instances.get(message.instanceId);
		if (!entry || !current(entry.connection)) {
			error(connection, "NOT_AVAILABLE");
			return;
		}
		const hash = await sha256Hex(message.discoveryCapability);
		const discovery = entry.discoveries.get(hash);
		if (!discovery || discovery.expiresAt <= Math.floor(Date.now() / 1000)) {
			error(connection, "NOT_AVAILABLE");
			return;
		}
		const capBudget = entry.capRequests.get(hash);
		if (!capBudget || !take(capBudget, 5) || !take(entry.requests, 5)) {
			error(connection, "RATE_LIMIT");
			return;
		}
		if (
			entry.sessions.size >= LIMITS.peers ||
			(discovery.kind === "invite" &&
				[...entry.sessions].some(
					(s) => s.ticket.targetKind === "invite" && s.ticket.targetId === discovery.id,
				))
		) {
			error(connection, "PEER_LIMIT");
			return;
		}
		const offerHash = await sha256Hex(message.offer);
		if (
			!(await verify(message.clientPublicKey, message.offerSignature, "offer", [
				entry.id,
				discovery.id,
				message.clientPublicKey,
				offerHash,
			]))
		) {
			error(connection, "BAD_SIGNATURE");
			return;
		}
		if (connection.closed || !current(entry.connection)) return;
		const expiresAt = Math.min(discovery.expiresAt, Math.floor(Date.now() / 1000) + 60);
		const unsigned = {
			instanceId: entry.id,
			leaseEpoch: entry.epoch,
			sessionId: randomId(),
			clientPublicKey: message.clientPublicKey,
			offerHash,
			expiresAt,
			targetKind: discovery.kind,
			targetId: discovery.id,
		};
		const ticket: Ticket = {
			...unsigned,
			signature: await sign(identity.privateKey, "ticket", ticketFields(unsigned)),
		};
		// Crypto yields: re-check admission to avoid concurrent requests exceeding peer budgets.
		if (
			connection.closed ||
			!current(entry.connection) ||
			discovery !== entry.discoveries.get(hash) ||
			discovery.expiresAt <= Math.floor(Date.now() / 1000)
		)
			return;
		if (
			entry.sessions.size >= LIMITS.peers ||
			(discovery.kind === "invite" &&
				[...entry.sessions].some(
					(s) => s.ticket.targetKind === "invite" && s.ticket.targetId === discovery.id,
				))
		) {
			error(connection, "PEER_LIMIT");
			return;
		}
		const session: Session = {
			id: ticket.sessionId,
			instance: entry,
			browser: connection,
			ticket,
			counts: { instance: 0, browser: valid.sdpCandidateCount(message.offer) },
		};
		session.timer = setTimeout(
			() => endSession(session, "NEGOTIATION_TIMEOUT"),
			Math.min(negotiationMs, Math.max(1, expiresAt * 1000 - Date.now())),
		);
		connection.session = session;
		connection.authenticated = true;
		clearTimeout(connection.authTimer);
		sessions.set(session.id, session);
		entry.sessions.add(session);
		send(entry.connection, {
			type: "offer",
			ticket,
			offer: message.offer,
			offerSignature: message.offerSignature,
		});
	}
	async function handle(connection: Connection, message: Record<string, unknown>) {
		if (connection.closed) return;
		if (!connection.authenticated) {
			if (connection.role === "instance" && message.type === "register" && connection.challenge)
				return register(connection, message);
			if (connection.role === "browser" && message.type === "connect")
				return connect(connection, message);
			error(connection, "AUTH_REQUIRED");
			close(connection);
			return;
		}
		if (connection.role === "instance") {
			const entry = current(connection);
			if (!entry) {
				error(connection, "STALE_LEASE");
				close(connection);
				return;
			}
			if (message.type === "ping" && valid.exact(message, ["type"])) {
				entry.leaseUntil = Date.now() + leaseMs;
				send(connection, { type: "pong" });
				return;
			}
			if (message.type === "discoveries" && valid.exact(message, ["type", "discoveries"])) {
				const list = valid.discoveries(message.discoveries, Math.floor(Date.now() / 1000));
				if (!list) {
					error(connection, "INVALID_DISCOVERIES");
					return;
				}
				replaceDiscoveries(entry, list);
				return;
			}
		}
		if (typeof message.sessionId !== "string") {
			error(connection, "INVALID_TYPE");
			return;
		}
		const session = sessions.get(message.sessionId);
		if (
			!session ||
			(session.browser !== connection && session.instance.connection !== connection) ||
			!current(session.instance.connection)
		) {
			error(connection, "NO_SESSION");
			return;
		}
		if (session.ticket.expiresAt <= Math.floor(Date.now() / 1000)) {
			endSession(session, "TICKET_EXPIRED");
			return;
		}
		if (message.type === "cancel" && valid.exact(message, ["type", "sessionId"])) {
			endSession(session, "CANCELLED", connection);
			return;
		}
		if (message.type === "candidate" && valid.exact(message, ["type", "sessionId", "candidate"])) {
			if (
				!valid.candidate(message.candidate) ||
				++session.counts[connection.role] > LIMITS.candidates
			) {
				error(connection, "INVALID_CANDIDATE", session.id);
				endSession(session, "INVALID_CANDIDATE");
				return;
			}
			send(session.browser === connection ? session.instance.connection : session.browser, message);
			return;
		}
		if (
			connection.role === "instance" &&
			message.type === "error" &&
			valid.exact(message, ["type", "sessionId", "code"]) &&
			typeof message.code === "string" &&
			/^[a-zA-Z0-9_]{1,64}$/.test(message.code)
		) {
			send(session.browser, { type: "error", code: message.code, sessionId: session.id });
			endSession(session);
			return;
		}
		if (
			connection.role === "instance" &&
			message.type === "answer" &&
			valid.exact(message, ["type", "sessionId", "answer", "signature"])
		) {
			if (
				!valid.sdp(message.answer) ||
				!valid.signature(message.signature) ||
				session.counts.instance + valid.sdpCandidateCount(message.answer) > LIMITS.candidates
			) {
				error(connection, "INVALID_ANSWER", session.id);
				return;
			}
			const answerHash = await sha256Hex(message.answer);
			if (
				!(await verify(session.instance.publicKey, message.signature, "answer", [
					session.instance.id,
					session.id,
					session.ticket.clientPublicKey,
					session.ticket.offerHash,
					answerHash,
				]))
			) {
				error(connection, "BAD_SIGNATURE", session.id);
				return;
			}
			if (
				sessions.get(session.id) !== session ||
				!current(connection) ||
				session.ticket.expiresAt <= Math.floor(Date.now() / 1000)
			)
				return;
			// Complete routing before sending, so WSS cleanup cannot cancel an established DC.
			endSession(session);
			send(session.browser, {
				type: "connected",
				sessionId: session.id,
				ticket: session.ticket,
				answer: message.answer,
				signature: message.signature,
			});
			return;
		}
		error(connection, "INVALID_TYPE", session.id);
	}

	const server: Server<Connection> = Bun.serve<Connection>({
		hostname: host,
		port: options.port ?? 0,
		async fetch(request, bunServer) {
			const path = new URL(request.url).pathname;
			if (path === "/api" || path.startsWith("/api/") || path === "/ws" || path.startsWith("/ws/"))
				return Response.json({ error: "BUSINESS_ROUTES_FORBIDDEN" }, { status: 404 });
			if (path === "/client/manifest" && request.method === "GET")
				return Response.json({
					version: VERSION,
					appVersion: APP_VERSION,
					coordinatorPublicKey: identity.publicKey,
					features: ["direct-only"],
				});
			if (path === "/signal/instance" || path === "/signal/browser") {
				if (request.method !== "GET" || new URL(request.url).search !== "")
					return Response.json({ error: "INVALID_UPGRADE" }, { status: 400 });
				const ip = bunServer.requestIP(request)?.address ?? "unknown";
				let budget = ips.get(ip);
				if (!budget) {
					if (ips.size >= 4096) return Response.json({ error: "RATE_LIMIT" }, { status: 429 });
					budget = { sockets: 0, upgrade: bucket(), connect: bucket() };
					ips.set(ip, budget);
				}
				if (
					stopping ||
					connections.size >= maxConnections ||
					budget.sockets >= maxPerIp ||
					!take(budget.upgrade, 120)
				)
					return Response.json({ error: "RATE_LIMIT" }, { status: 429 });
				const connection: Connection = {
					role: path.endsWith("instance") ? "instance" : "browser",
					ip,
					challenge: randomId(),
					closed: false,
					authenticated: false,
					queue: Promise.resolve(),
					queuedBytes: 0,
					queuedMessages: 0,
				};
				if (bunServer.upgrade(request, { data: connection })) {
					connections.add(connection);
					budget.sockets++;
					return;
				}
				return Response.json({ error: "WEBSOCKET_REQUIRED" }, { status: 400 });
			}
			if (request.method === "GET" && options.assetHandler) {
				const response = await options.assetHandler(request);
				if (response) return response;
			}
			return Response.json({ error: "NOT_FOUND" }, { status: 404 });
		},
		websocket: {
			maxPayloadLength: LIMITS.signalBytes,
			backpressureLimit: sendQueueBytes,
			closeOnBackpressureLimit: true,
			idleTimeout: 120,
			open(ws) {
				ws.data.ws = ws;
				ws.data.authTimer = setTimeout(() => {
					error(ws.data, "AUTH_TIMEOUT");
					close(ws.data);
				}, authMs);
				if (ws.data.role === "instance")
					send(ws.data, {
						type: "challenge",
						challenge: ws.data.challenge,
						coordinatorPublicKey: identity.publicKey,
					});
			},
			message(ws, raw) {
				const connection = ws.data;
				if (connection.closed) return;
				const bytes =
					typeof raw === "string" ? new TextEncoder().encode(raw).byteLength : raw.byteLength;
				signalBytesIn += bytes;
				if (
					typeof raw !== "string" ||
					bytes > LIMITS.signalBytes ||
					connection.queuedMessages >= 8 ||
					connection.queuedBytes + bytes > 256 * 1024
				) {
					error(connection, "MESSAGE_LIMIT");
					close(connection);
					return;
				}
				let message: unknown;
				try {
					message = JSON.parse(raw);
				} catch {
					error(connection, "INVALID_JSON");
					close(connection);
					return;
				}
				if (!valid.object(message)) {
					error(connection, "INVALID_MESSAGE");
					close(connection);
					return;
				}
				const value = message;
				connection.queuedMessages++;
				connection.queuedBytes += bytes;
				connection.queue = connection.queue
					.then(() => handle(connection, value))
					.catch(() => {
						error(connection, "INVALID_MESSAGE");
						close(connection);
					})
					.finally(() => {
						connection.queuedMessages--;
						connection.queuedBytes -= bytes;
					});
			},
			close(ws) {
				close(ws.data, "SIGNAL_DISCONNECTED");
			},
		},
	});
	function sweep() {
		const now = Date.now();
		for (const entry of instances.values()) {
			if (entry.leaseUntil <= now) {
				removeInstance(entry, "LEASE_EXPIRED");
				close(entry.connection, "LEASE_EXPIRED");
			} else
				for (const [hash, discovery] of entry.discoveries)
					if (discovery.expiresAt <= Math.floor(now / 1000)) {
						entry.discoveries.delete(hash);
						entry.capRequests.delete(hash);
					}
		}
		for (const [ip, budget] of ips)
			if (
				budget.sockets === 0 &&
				now - Math.max(budget.upgrade.start, budget.connect.start) > 60000
			)
				ips.delete(ip);
	}
	const timer = setInterval(sweep, Math.min(1000, leaseMs / 2));
	timer.unref();
	const origin = `http://${host === "::1" ? "[::1]" : host}:${server.port}`;
	return {
		server,
		origin,
		signalUrl: `${origin.replace(/^http/, "ws")}/signal/instance`,
		publicKey: identity.publicKey,
		stats: () => ({
			instances: instances.size,
			sessions: sessions.size,
			connections: connections.size,
			discoveries: [...instances.values()].reduce((n, entry) => n + entry.discoveries.size, 0),
			ipBudgets: ips.size,
			signalBytesIn,
			signalBytesOut,
			rejected,
		}),
		disconnectInstances() {
			for (const entry of [...instances.values()]) close(entry.connection, "SIGNAL_DISCONNECTED");
		},
		/** In-process test hook only: never controls or revokes an established RTC peer. */
		expireLeases() {
			for (const entry of instances.values()) entry.leaseUntil = Date.now() - 1;
			sweep();
		},
		async stop() {
			if (stopping) return;
			stopping = true;
			clearInterval(timer);
			for (const connection of [...connections]) close(connection, "SHUTDOWN");
			instances.clear();
			sessions.clear();
			ips.clear();
			await server.stop(true);
		},
	};
}
