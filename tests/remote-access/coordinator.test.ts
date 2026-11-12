import { afterEach, describe, expect, test } from "bun:test";
import { generate } from "selfsigned";
import {
	type CoordinatorOptions,
	startCoordinator,
	type Ticket,
	ticketFields,
} from "../../remote-coordinator";
import {
	generateIdentity,
	instanceId,
	sha256Hex,
	sign,
	verify,
} from "../../shared/remote-access/identity";
import { LIMITS } from "../../shared/remote-access/protocol";

const SDP = "v=0\r\ns=-\r\na=candidate:1 1 UDP 2130706431 127.0.0.1 54321 typ host\r\n";
const ANSWER = "v=0\r\ns=answer\r\n";
type Identity = Awaited<ReturnType<typeof generateIdentity>>;
type Coordinator = Awaited<ReturnType<typeof startCoordinator>>;
type Message = Record<string, unknown>;
const coordinators: Coordinator[] = [];
const clients: Client[] = [];
// lib.dom omits Bun's supported per-client TLS constructor overload.
const BunWebSocket = WebSocket as typeof WebSocket & {
	new (url: string, options?: Bun.WebSocketOptions): WebSocket;
};

class Client {
	ws: WebSocket;
	messages: Message[] = [];
	waiters: {
		type: string;
		resolve: (message: Message) => void;
		reject: (error: Error) => void;
		timer: ReturnType<typeof setTimeout>;
	}[] = [];
	opened: Promise<void>;
	closed: Promise<void>;
	constructor(url: string, trustedCert?: string) {
		this.ws = new BunWebSocket(url, trustedCert ? { tls: { ca: trustedCert } } : undefined);
		this.opened = new Promise((resolve, reject) => {
			this.ws.addEventListener("open", () => resolve(), { once: true });
			this.ws.addEventListener("error", () => reject(new Error("UPGRADE_FAILED")), { once: true });
		});
		this.closed = new Promise((resolve) =>
			this.ws.addEventListener("close", () => resolve(), { once: true }),
		);
		this.ws.addEventListener("message", (event) => {
			const message = JSON.parse(String(event.data)) as Message;
			const index = this.waiters.findIndex((waiter) => waiter.type === message.type);
			if (index < 0) {
				this.messages.push(message);
				return;
			}
			const waiter = this.waiters.splice(index, 1)[0];
			if (waiter) {
				clearTimeout(waiter.timer);
				waiter.resolve(message);
			}
		});
		clients.push(this);
	}
	send(message: unknown) {
		this.ws.send(JSON.stringify(message));
	}
	next(type: string, timeout = 1500): Promise<Message> {
		const index = this.messages.findIndex((message) => message.type === type);
		if (index >= 0) return Promise.resolve(this.messages.splice(index, 1)[0] as Message);
		return new Promise((resolve, reject) => {
			const waiter = {
				type,
				resolve,
				reject,
				timer: setTimeout(() => {
					this.waiters = this.waiters.filter((entry) => entry !== waiter);
					reject(new Error(`Missing ${type}; received ${JSON.stringify(this.messages)}`));
				}, timeout),
			};
			this.waiters.push(waiter);
		});
	}
	close() {
		this.ws.close();
		for (const waiter of this.waiters) clearTimeout(waiter.timer);
	}
}

async function coordinator(options: CoordinatorOptions = {}) {
	const value = await startCoordinator({ allowLocalhost: true, ...options });
	coordinators.push(value);
	return value;
}
async function discovery(
	cap = "test_capability",
	id = "invite-1",
	kind: "invite" | "grant" = "invite",
	expiresAt = Math.floor(Date.now() / 1000) + 600,
) {
	return { hash: await sha256Hex(cap), kind, id, expiresAt };
}
async function register(
	a: Coordinator,
	identity?: Identity,
	list?: Awaited<ReturnType<typeof discovery>>[],
	trustedCert?: string,
) {
	const discoveries = list ?? [await discovery()];
	const key = identity ?? (await generateIdentity());
	const client = new Client(a.signalUrl, trustedCert);
	await client.opened;
	const challenge = await client.next("challenge");
	const signature = await sign(key.privateKey, "register", [
		String(challenge.challenge),
		key.publicKey,
	]);
	client.send({ type: "register", publicKey: key.publicKey, signature, discoveries });
	const registered = await client.next("registered");
	return { client, key, registered, signature, challenge };
}
async function offer(
	a: Coordinator,
	id: string,
	cap = "test_capability",
	targetId = "invite-1",
	sdp = SDP,
	key?: Identity,
	trustedCert?: string,
) {
	const identity = key ?? (await generateIdentity());
	const client = new Client(a.signalUrl.replace("/instance", "/browser"), trustedCert);
	await client.opened;
	const message = {
		type: "connect",
		instanceId: id,
		discoveryCapability: cap,
		clientPublicKey: identity.publicKey,
		offer: sdp,
		offerSignature: await sign(identity.privateKey, "offer", [
			id,
			targetId,
			identity.publicKey,
			await sha256Hex(sdp),
		]),
	};
	return { client, key: identity, message };
}
async function connected(a: Coordinator, trustedCert?: string) {
	const b = await register(a, undefined, undefined, trustedCert);
	const c = await offer(
		a,
		String(b.registered.instanceId),
		"test_capability",
		"invite-1",
		SDP,
		undefined,
		trustedCert,
	);
	c.client.send(c.message);
	const request = await b.client.next("offer");
	const ticket = request.ticket as Ticket;
	const signature = await sign(b.key.privateKey, "answer", [
		ticket.instanceId,
		ticket.sessionId,
		ticket.clientPublicKey,
		ticket.offerHash,
		await sha256Hex(ANSWER),
	]);
	b.client.send({ type: "answer", sessionId: ticket.sessionId, answer: ANSWER, signature });
	const result = await c.client.next("connected");
	return { b, c, request, result, ticket };
}

afterEach(async () => {
	for (const client of clients.splice(0)) client.close();
	for (const a of coordinators.splice(0)) await a.stop();
});

describe("isolated coordinator control plane", () => {
	test("explicit localhost mode and strict business/static separation", async () => {
		await expect(startCoordinator()).rejects.toThrow("allowLocalhost");
		await expect(startCoordinator({ allowLocalhost: true, host: "0.0.0.0" })).rejects.toThrow(
			"loopback",
		);
		const a = await coordinator({ assetHandler: () => new Response("shell") });
		for (const path of ["/api/auth/me", "/api", "/ws/narrator", "/ws"]) {
			const response = await fetch(a.origin + path);
			expect(response.status).toBe(404);
			expect(await response.json()).toEqual({ error: "BUSINESS_ROUTES_FORBIDDEN" });
		}
		expect(await (await fetch(a.origin)).text()).toBe("shell");
		expect((await (await fetch(`${a.origin}/client/manifest`)).json()).coordinatorPublicKey).toBe(
			a.publicKey,
		);
		expect((await fetch(`${a.origin}/signal/browser?token=not-allowed`)).status).toBe(400);
	});

	test("public bind requires explicit TLS opt-in and a complete certificate/key", async () => {
		for (const host of ["0.0.0.0", "::", "192.0.2.1"]) {
			for (const options of [
				{},
				{ allowLocalhost: true },
				{ allowLocalhost: true, allowPublicTls: true },
				{ tls: { cert: "certificate", key: "key" } },
			]) {
				await expect(startCoordinator({ host, ...options })).rejects.toThrow("Non-loopback");
			}
		}
		for (const tls of [
			{ cert: "certificate" },
			{ key: "key" },
			{ cert: "", key: "key" },
			{ cert: "certificate", key: "" },
		]) {
			await expect(
				startCoordinator({
					host: "0.0.0.0",
					allowLocalhost: true,
					allowPublicTls: true,
					tls: tls as CoordinatorOptions["tls"],
				}),
			).rejects.toThrow("TLS requires both cert and key");
		}
	});

	test("opted-in TLS listener serves HTTPS assets and negotiates over WSS", async () => {
		const pems = await generate([{ name: "commonName", value: "localhost" }], {
			algorithm: "sha256",
			extensions: [
				{ name: "basicConstraints", cA: true },
				{ name: "keyUsage", digitalSignature: true, keyEncipherment: true, keyCertSign: true },
				{ name: "extKeyUsage", serverAuth: true },
				{ name: "subjectAltName", altNames: [{ type: 7, ip: "127.0.0.1" }] },
			],
		});
		const a = await coordinator({
			host: "0.0.0.0",
			allowLocalhost: false,
			allowPublicTls: true,
			tls: { cert: pems.cert, key: pems.private },
			assetHandler: () => new Response("tls shell"),
		});
		expect(a.origin).toBe(`https://0.0.0.0:${a.server.port}`);
		expect(a.signalUrl).toBe(`wss://0.0.0.0:${a.server.port}/signal/instance`);
		// Trust this test's certificate only; no process/global trust overrides.
		const origin = a.origin.replace("0.0.0.0", "127.0.0.1");
		const tls = { ca: pems.cert };
		expect(await (await fetch(origin, { tls })).text()).toBe("tls shell");
		const forbidden = await fetch(`${origin}/api/auth/me`, { tls });
		expect(forbidden.status).toBe(404);
		expect(await forbidden.json()).toEqual({ error: "BUSINESS_ROUTES_FORBIDDEN" });
		const { result, ticket } = await connected(
			{ ...a, signalUrl: a.signalUrl.replace("0.0.0.0", "127.0.0.1") },
			pems.cert,
		);
		expect(result.sessionId).toBe(ticket.sessionId);
		expect(result.answer).toBe(ANSWER);
	});

	test("registers fingerprint, stores only bounded hashes, signs ticket and binds answer", async () => {
		const a = await coordinator();
		const { b, c, result, ticket, request } = await connected(a);
		expect(b.registered.instanceId).toBe(await instanceId(b.key.publicKey));
		expect(ticket.clientPublicKey).toBe(c.key.publicKey);
		expect(ticket.leaseEpoch).toBe(String(b.registered.leaseEpoch));
		expect(ticket.targetKind).toBe("invite");
		expect(ticket.targetId).toBe("invite-1");
		expect(ticketFields(ticket)).toEqual([
			ticket.instanceId,
			ticket.leaseEpoch,
			ticket.sessionId,
			ticket.clientPublicKey,
			ticket.offerHash,
			String(ticket.expiresAt),
			"invite",
			"invite-1",
		]);
		expect(await verify(a.publicKey, ticket.signature, "ticket", ticketFields(ticket))).toBe(true);
		for (const mutation of [
			{ instanceId: "another-instance" },
			{ leaseEpoch: "old-lease" },
			{ sessionId: "another-session" },
			{ clientPublicKey: b.key.publicKey },
			{ offerHash: "0".repeat(64) },
			{ expiresAt: ticket.expiresAt + 1 },
			{ targetKind: "grant" as const },
			{ targetId: "another-target" },
		]) {
			expect(
				await verify(
					a.publicKey,
					ticket.signature,
					"ticket",
					ticketFields({ ...ticket, ...mutation }),
				),
			).toBe(false);
		}
		expect(await verify(a.publicKey, ticket.signature, "offer", ticketFields(ticket))).toBe(false);
		expect(result.ticket).toEqual(ticket);
		expect(JSON.stringify(request)).not.toContain("test_capability");
		expect(a.stats().sessions).toBe(0);
		expect(a.stats().discoveries).toBe(1);
		b.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
		expect((await b.client.next("error")).code).toBe("NO_SESSION");
	});

	test("wrong register signature, point and challenge replay never replace identity", async () => {
		const a = await coordinator();
		const b = await register(a);
		for (const publicKey of [b.key.publicKey, `04${"0".repeat(128)}`]) {
			const rogue = new Client(a.signalUrl);
			await rogue.opened;
			await rogue.next("challenge");
			rogue.send({ type: "register", publicKey, signature: b.signature, discoveries: [] });
			expect((await rogue.next("error")).code).toBe("BAD_SIGNATURE");
			await rogue.closed;
		}
		expect(a.stats().instances).toBe(1);
		b.client.send({
			type: "register",
			publicKey: b.key.publicKey,
			signature: b.signature,
			discoveries: [],
		});
		expect((await b.client.next("error")).code).toBe("INVALID_TYPE");
	});

	test("new signed registration takes over with fresh epoch; old pending sessions stop", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		await b.client.next("offer");
		const replacement = await register(a, b.key);
		expect(replacement.registered.leaseEpoch).not.toBe(b.registered.leaseEpoch);
		await b.client.closed;
		expect((await c.client.next("error")).code).toBe("REPLACED");
		expect(a.stats().instances).toBe(1);
		expect(a.stats().sessions).toBe(0);
		const next = await offer(a, String(b.registered.instanceId));
		next.client.send(next.message);
		expect((await replacement.client.next("offer")).ticket).toMatchObject({
			leaseEpoch: replacement.registered.leaseEpoch,
		});
	});

	test("discoveries require finite valid TTL, bounded size, unique hash/target and exact fields", async () => {
		const a = await coordinator();
		const b = await register(a);
		const good = await discovery();
		for (const discoveries of [
			[{ ...good, expiresAt: Math.floor(Date.now() / 1000) - 1 }],
			[{ ...good, expiresAt: Math.floor(Date.now() / 1000) + 30 * 86400 + 10 }],
			[{ ...good, expiresAt: 1.5 }],
			[{ ...good, kind: "session" }],
			[{ ...good, pairingSecret: "forbidden" }],
			[good, good],
			Array.from({ length: 65 }, () => good),
		]) {
			b.client.send({ type: "discoveries", discoveries });
			expect((await b.client.next("error")).code).toBe("INVALID_DISCOVERIES");
			expect(a.stats().discoveries).toBe(1);
		}
	});

	test("discovery replacement removes old capability and revokes only pending negotiation", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		await b.client.next("offer");
		b.client.send({
			type: "discoveries",
			discoveries: [await discovery("new_cap", "grant-2", "grant")],
		});
		expect((await c.client.next("error")).code).toBe("DISCOVERY_REVOKED");
		expect((await b.client.next("cancel")).type).toBe("cancel");
		const rejected = await offer(a, String(b.registered.instanceId));
		rejected.client.send(rejected.message);
		expect((await rejected.client.next("error")).code).toBe("NOT_AVAILABLE");
		const accepted = await offer(a, String(b.registered.instanceId), "new_cap", "grant-2");
		accepted.client.send(accepted.message);
		expect((await b.client.next("offer")).ticket).toMatchObject({
			targetKind: "grant",
			targetId: "grant-2",
		});
	});

	test("unknown instances, invalid capability and expired discovery never expose directory", async () => {
		const a = await coordinator();
		const b = await register(a, undefined, [
			await discovery("expired-soon", "invite-1", "invite", Math.floor(Date.now() / 1000) + 1),
		]);
		for (const [id, cap] of [
			[String(b.registered.instanceId), "bad_cap"],
			["a".repeat(52), "expired-soon"],
		]) {
			const c = await offer(a, String(id), String(cap));
			c.client.send(c.message);
			expect((await c.client.next("error")).code).toBe("NOT_AVAILABLE");
		}
		await Bun.sleep(1100);
		const c = await offer(a, String(b.registered.instanceId), "expired-soon");
		c.client.send(c.message);
		expect((await c.client.next("error")).code).toBe("NOT_AVAILABLE");
		expect((await fetch(`${a.origin}/instances`)).status).toBe(404);
	});

	test("offer signature binds target id/client key/offer, arbitrary data is never forwarded", async () => {
		const a = await coordinator();
		const b = await register(a);
		const invalid = await offer(
			a,
			String(b.registered.instanceId),
			"test_capability",
			"wrong-target",
		);
		invalid.client.send(invalid.message);
		expect((await invalid.client.next("error")).code).toBe("BAD_SIGNATURE");
		const altered = await offer(a, String(b.registered.instanceId));
		altered.client.send({ ...altered.message, offer: ANSWER });
		expect((await altered.client.next("error")).code).toBe("BAD_SIGNATURE");
		const injected = await offer(a, String(b.registered.instanceId));
		injected.client.send({ ...injected.message, pairingSecret: "secret", token: "JWT" });
		expect((await injected.client.next("error")).code).toBe("INVALID_CONNECT");
		b.client.send({ type: "data", data: "never-relay-business" });
		expect((await b.client.next("error")).code).toBe("INVALID_TYPE");
		expect(b.client.messages.filter((message) => message.type === "offer")).toHaveLength(0);
		expect(a.stats().sessions).toBe(0);
	});

	test("full SDP rejects relay, candidate and SDP overflows before allocation", async () => {
		const a = await coordinator();
		const b = await register(a);
		for (const sdp of [
			SDP.replace("typ host", "typ relay"),
			`v=0\r\n${"a".repeat(LIMITS.sdpBytes)}`,
			`v=0\r\na=candidate:${"a".repeat(LIMITS.candidateBytes)}\r\n`,
			`v=0\r\n${SDP.split("\r\n")[2]}\r\n`.replace(
				/a=candidate:[\s\S]*$/,
				`${Array.from({ length: 129 }, () => SDP.split("\r\n")[2]).join("\r\n")}\r\n`,
			),
		]) {
			const c = await offer(a, String(b.registered.instanceId), "test_capability", "invite-1", sdp);
			c.client.send(c.message);
			expect((await c.client.next("error")).code).toBe("INVALID_CONNECT");
		}
		expect(a.stats().sessions).toBe(0);
	});

	test("candidate routing requires authorized session and direct bounded candidate", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const request = await b.client.next("offer");
		const ticket = request.ticket as Ticket;
		const stranger = new Client(a.signalUrl.replace("/instance", "/browser"));
		await stranger.opened;
		stranger.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
		expect((await stranger.next("error")).code).toBe("AUTH_REQUIRED");
		const candidate = {
			candidate: "candidate:2 1 UDP 123 127.0.0.1 54322 typ srflx",
			sdpMid: "0",
			sdpMLineIndex: 0,
		};
		c.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate });
		expect((await b.client.next("candidate")).candidate).toEqual(candidate);
		b.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
		expect((await c.client.next("candidate")).candidate).toBeNull();
		c.client.send({
			type: "candidate",
			sessionId: ticket.sessionId,
			candidate: { ...candidate, candidate: candidate.candidate.replace("srflx", "relay") },
		});
		expect((await c.client.next("error")).code).toBe("INVALID_CANDIDATE");
		expect(a.stats().sessions).toBe(0);
	});

	test("candidate count and UTF8 byte budget are bounded", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		for (let n = 0; n < 128; n++) {
			c.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
			if (n < 127) await b.client.next("candidate");
		}
		expect((await c.client.next("error")).code).toBe("INVALID_CANDIDATE");
		expect(a.stats().sessions).toBe(0);
		const huge = new Client(a.signalUrl.replace("/instance", "/browser"));
		await huge.opened;
		huge.ws.send(JSON.stringify({ type: "data", payload: "字".repeat(LIMITS.signalBytes / 2) }));
		await huge.closed;
	});

	test("full SDP and trickle share the same per-side candidate budget", async () => {
		const a = await coordinator();
		const b = await register(a);
		const line = "a=candidate:1 1 UDP 123 127.0.0.1 54321 typ host";
		const full = `v=0\r\n${Array.from({ length: 128 }, () => line).join("\r\n")}\r\n`;
		const c = await offer(a, String(b.registered.instanceId), "test_capability", "invite-1", full);
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		c.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
		expect((await c.client.next("error")).code).toBe("INVALID_CANDIDATE");
		await b.client.next("cancel");
		const c2 = await offer(a, String(b.registered.instanceId));
		c2.client.send(c2.message);
		const ticket2 = (await b.client.next("offer")).ticket as Ticket;
		b.client.send({ type: "candidate", sessionId: ticket2.sessionId, candidate: null });
		await c2.client.next("candidate");
		const signature = await sign(b.key.privateKey, "answer", [
			ticket2.instanceId,
			ticket2.sessionId,
			ticket2.clientPublicKey,
			ticket2.offerHash,
			await sha256Hex(full),
		]);
		b.client.send({ type: "answer", sessionId: ticket2.sessionId, answer: full, signature });
		expect((await b.client.next("error")).code).toBe("INVALID_ANSWER");
	});

	test("only bounded instance errors are routed and release failed negotiations", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		b.client.send({
			type: "error",
			sessionId: ticket.sessionId,
			code: "offer_rejected",
			body: "never-forward",
		});
		expect((await b.client.next("error")).code).toBe("INVALID_TYPE");
		expect(c.client.messages.filter((message) => message.type === "error")).toHaveLength(0);
		b.client.send({ type: "error", sessionId: ticket.sessionId, code: "offer_rejected" });
		expect(await c.client.next("error")).toEqual({
			type: "error",
			code: "offer_rejected",
			sessionId: ticket.sessionId,
		});
		expect(a.stats().sessions).toBe(0);
	});

	test("only one unfinished negotiation per invitation and foreign instances cannot route", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		const c2 = await offer(a, String(b.registered.instanceId));
		c2.client.send(c2.message);
		expect((await c2.client.next("error")).code).toBe("PEER_LIMIT");
		const foreign = await register(a);
		foreign.client.send({ type: "candidate", sessionId: ticket.sessionId, candidate: null });
		expect((await foreign.client.next("error")).code).toBe("NO_SESSION");
		expect(a.stats().sessions).toBe(1);
	});

	test("IP attempt budget covers invalid capabilities and stops discovery probing", async () => {
		const a = await coordinator();
		const b = await register(a);
		for (let n = 0; n < 31; n++) {
			const c = await offer(a, String(b.registered.instanceId), `unknown_${n}`);
			c.client.send(c.message);
			expect((await c.client.next("error")).code).toBe(n < 30 ? "NOT_AVAILABLE" : "RATE_LIMIT");
			c.client.close();
			await c.client.closed;
		}
		expect(a.stats().sessions).toBe(0);
	});

	test("answers reject wrong identity, wrong session, relay and embedded secrets", async () => {
		const a = await coordinator();
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		b.client.send({
			type: "answer",
			sessionId: "unknown",
			answer: ANSWER,
			signature: "0".repeat(128),
		});
		expect((await b.client.next("error")).code).toBe("NO_SESSION");
		b.client.send({
			type: "answer",
			sessionId: ticket.sessionId,
			answer: SDP.replace("typ host", "typ relay"),
			signature: "0".repeat(128),
		});
		expect((await b.client.next("error")).code).toBe("INVALID_ANSWER");
		const signature = await sign(c.key.privateKey, "answer", [
			ticket.instanceId,
			ticket.sessionId,
			ticket.clientPublicKey,
			ticket.offerHash,
			await sha256Hex(ANSWER),
		]);
		b.client.send({ type: "answer", sessionId: ticket.sessionId, answer: ANSWER, signature });
		expect((await b.client.next("error")).code).toBe("BAD_SIGNATURE");
		b.client.send({
			type: "answer",
			sessionId: ticket.sessionId,
			answer: ANSWER,
			signature,
			token: "JWT",
		});
		expect((await b.client.next("error")).code).toBe("INVALID_TYPE");
		expect(c.client.messages.filter((message) => message.type === "connected")).toHaveLength(0);
	});

	test("lease loss and forced instance disconnect affect discovery, never established DC", async () => {
		const a = await coordinator({ leaseSeconds: 0.08 });
		const { b, c } = await connected(a);
		await b.client.closed;
		expect(a.stats().instances).toBe(0);
		expect(a.stats().sessions).toBe(0);
		expect(
			c.client.messages.filter((message) => ["error", "cancel"].includes(String(message.type))),
		).toHaveLength(0);
		const reconnected = await register(a, b.key);
		a.disconnectInstances();
		await reconnected.client.closed;
		expect(
			c.client.messages.filter((message) => ["error", "cancel"].includes(String(message.type))),
		).toHaveLength(0);
	});

	test("explicit lease expiry uses normal cleanup and never cancels completed negotiations", async () => {
		const a = await coordinator();
		const { b, c } = await connected(a);
		a.expireLeases();
		await b.client.closed;
		expect(a.stats()).toMatchObject({ instances: 0, sessions: 0, discoveries: 0, connections: 1 });
		expect(
			c.client.messages.filter((message) => ["error", "cancel"].includes(String(message.type))),
		).toHaveLength(0);
		const pendingInstance = await register(a, b.key);
		const pendingClient = await offer(a, String(pendingInstance.registered.instanceId));
		pendingClient.client.send(pendingClient.message);
		await pendingInstance.client.next("offer");
		a.expireLeases();
		expect((await pendingClient.client.next("error")).code).toBe("LEASE_EXPIRED");
		await pendingInstance.client.closed;
		expect(a.stats()).toMatchObject({ instances: 0, sessions: 0, discoveries: 0 });
		a.expireLeases();
		expect(
			c.client.messages.filter((message) => ["error", "cancel"].includes(String(message.type))),
		).toHaveLength(0);
		expect((await fetch(`${a.origin}/debug/expire-leases`)).status).toBe(404);
	});

	test("STUN-only sample is loopback, CLI-free and contains no relay or credentials", async () => {
		const sample = await Bun.file(
			new URL("../../remote-coordinator/stun-only.conf", import.meta.url),
		).text();
		const settings = sample
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter((line) => line && !line.startsWith("#"));
		expect(settings).toEqual([
			"listening-ip=127.0.0.1",
			"listening-port=3478",
			"stun-only",
			"no-cli",
			"no-tcp",
			"no-tls",
			"no-dtls",
			"no-rfc5780",
			"no-stun-backward-compatibility",
			"response-origin-only-with-rfc5780",
		]);
		expect(
			settings.some((line) => /relay|secret|user=|lt-cred|static-auth|realm/i.test(line)),
		).toBe(false);
	});

	test("ping renews current lease and auth deadline cleans idle sockets", async () => {
		const a = await coordinator({ leaseSeconds: 0.15, authTimeoutMs: 50 });
		const b = await register(a);
		await Bun.sleep(80);
		b.client.send({ type: "ping" });
		expect((await b.client.next("pong")).type).toBe("pong");
		await Bun.sleep(80);
		expect(a.stats().instances).toBe(1);
		const idle = new Client(a.signalUrl.replace("/instance", "/browser"));
		await idle.opened;
		expect((await idle.next("error")).code).toBe("AUTH_TIMEOUT");
		await idle.closed;
		await b.client.closed;
		expect(a.stats().instances).toBe(0);
	});

	test("negotiation timeout and cancellation release routing and peer budget", async () => {
		const a = await coordinator({ negotiationTimeoutMs: 30 });
		const b = await register(a);
		const c = await offer(a, String(b.registered.instanceId));
		c.client.send(c.message);
		const ticket = (await b.client.next("offer")).ticket as Ticket;
		expect((await c.client.next("error")).code).toBe("NEGOTIATION_TIMEOUT");
		expect((await b.client.next("cancel")).sessionId).toBe(ticket.sessionId);
		expect(a.stats().sessions).toBe(0);
		const next = await offer(a, String(b.registered.instanceId));
		next.client.send(next.message);
		const nextTicket = (await b.client.next("offer")).ticket as Ticket;
		next.client.send({ type: "cancel", sessionId: nextTicket.sessionId });
		expect((await b.client.next("cancel")).sessionId).toBe(nextTicket.sessionId);
		expect(a.stats().sessions).toBe(0);
	});

	test("one pending peer per invite and at most four per instance", async () => {
		const a = await coordinator();
		const list = await Promise.all(
			Array.from({ length: 5 }, (_, n) => discovery(`cap_${n}`, `grant-${n}`, "grant")),
		);
		const b = await register(a, undefined, list);
		for (let n = 0; n < 4; n++) {
			const c = await offer(a, String(b.registered.instanceId), `cap_${n}`, `grant-${n}`);
			c.client.send(c.message);
			await b.client.next("offer");
		}
		const excess = await offer(a, String(b.registered.instanceId), "cap_4", "grant-4");
		excess.client.send(excess.message);
		expect((await excess.client.next("error")).code).toBe("PEER_LIMIT");
		expect(a.stats().sessions).toBe(4);
	});

	test("capability and instance connections limited to five per minute", async () => {
		const a = await coordinator();
		const b = await register(a);
		for (let n = 0; n < 5; n++) {
			const c = await offer(a, String(b.registered.instanceId));
			c.client.send(c.message);
			const ticket = (await b.client.next("offer")).ticket as Ticket;
			c.client.send({ type: "cancel", sessionId: ticket.sessionId });
			await b.client.next("cancel");
		}
		b.client.send({ type: "discoveries", discoveries: [await discovery()] });
		const excess = await offer(a, String(b.registered.instanceId));
		excess.client.send(excess.message);
		expect((await excess.client.next("error")).code).toBe("RATE_LIMIT");
	});

	test("registration and IP socket limits bound memory; shutdown clears everything", async () => {
		const a = await coordinator({ maxInstances: 1, maxConnectionsPerIp: 3 });
		await register(a);
		const rejected = new Client(a.signalUrl);
		await rejected.opened;
		const challenge = await rejected.next("challenge");
		const identity = await generateIdentity();
		rejected.send({
			type: "register",
			publicKey: identity.publicKey,
			signature: await sign(identity.privateKey, "register", [
				String(challenge.challenge),
				identity.publicKey,
			]),
			discoveries: [],
		});
		expect((await rejected.next("error")).code).toBe("REGISTRY_FULL");
		await rejected.closed;
		const idle = new Client(a.signalUrl.replace("/instance", "/browser"));
		await idle.opened;
		const idle2 = new Client(a.signalUrl.replace("/instance", "/browser"));
		await idle2.opened;
		const response = await fetch(`${a.origin}/signal/browser`, {
			headers: {
				Upgrade: "websocket",
				Connection: "Upgrade",
				"Sec-WebSocket-Version": "13",
				"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
			},
		});
		expect(response.status).toBe(429);
		await a.stop();
		expect(a.stats()).toMatchObject({
			instances: 0,
			sessions: 0,
			connections: 0,
			discoveries: 0,
			ipBudgets: 0,
		});
		await a.stop();
	});

	test("bounded send queue rejects oversized outbound offer instead of buffering forever", async () => {
		const a = await coordinator({ sendQueueBytes: 1024 });
		const b = await register(a);
		const c = await offer(
			a,
			String(b.registered.instanceId),
			"test_capability",
			"invite-1",
			`v=0\r\ns=${"x".repeat(2048)}\r\n`,
		);
		c.client.send(c.message);
		await b.client.closed;
		expect((await c.client.next("error")).code).toBe("SLOW_CONSUMER");
		expect(a.stats().sessions).toBe(0);
		expect(a.stats().instances).toBe(0);
	});
});
