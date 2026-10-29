import { afterEach, describe, expect, test } from "bun:test";
import {
	assertDirectSdp,
	assertStunUrls,
	type Invitation,
	PrototypeTransport,
	remotePath,
	takeFragmentInvitation,
	validateInvitation,
} from "../../remote-prototype/client";
import { generateIdentity, instanceId } from "../../shared/remote-access/identity";
import {
	APP_VERSION,
	decodeFrame,
	encodeFrame,
	FRAME_DATA,
	FRAME_END,
	LIMITS,
	VERSION,
} from "../../shared/remote-access/protocol";

class FakeChannel extends EventTarget {
	readyState: RTCDataChannelState = "open";
	binaryType = "arraybuffer";
	bufferedAmount = 0;
	bufferedAmountLowThreshold = 0;
	readonly sent: (string | Uint8Array)[] = [];
	onsend?: (data: string | Uint8Array) => void;
	send(data: string | Uint8Array) {
		this.sent.push(data);
		this.onsend?.(data);
	}
	close() {
		if (this.readyState === "closed") return;
		this.readyState = "closed";
		this.dispatchEvent(new Event("close"));
	}
	message(data: unknown) {
		this.dispatchEvent(new MessageEvent("message", { data }));
	}
	control(message: Record<string, unknown>) {
		this.message(JSON.stringify(message));
	}
	low() {
		this.bufferedAmount = 0;
		this.dispatchEvent(new Event("bufferedamountlow"));
	}
	json() {
		return this.sent
			.filter((value): value is string => typeof value === "string")
			.map((value) => JSON.parse(value) as Record<string, unknown>);
	}
}
const active: PrototypeTransport[] = [];
afterEach(() => {
	for (const transport of active.splice(0)) transport.close();
});
function setup(options: ConstructorParameters<typeof PrototypeTransport>[1] = {}) {
	const channels = {
		control: new FakeChannel(),
		realtime: new FakeChannel(),
		bulk: new FakeChannel(),
	};
	const transport = PrototypeTransport.fromChannels(
		channels as unknown as ConstructorParameters<typeof PrototypeTransport>[0],
		options,
	);
	active.push(transport);
	channels.control.control({
		type: "hello.ready",
		grantId: "grant",
		discoveryCapability: "capability",
		expiresAt: Math.floor(Date.now() / 1000) + 3600,
	});
	return { transport, ...channels };
}
async function activate(fixture: ReturnType<typeof setup>) {
	const promise = fixture.transport.authenticate("fixture-jwt");
	await tick();
	fixture.control.control({
		type: "ready",
		version: VERSION,
		apiVersion: 1,
		appVersion: APP_VERSION,
	});
	await promise;
}
async function tick() {
	for (let i = 0; i < 80; i++) await Promise.resolve();
}
function head(channel: FakeChannel, id: number, status = 200, headers: [string, string][] = []) {
	channel.control({ type: "response.open", streamId: id, status, headers });
}
function frame(channel: FakeChannel, id: number, sequence: number, payload?: Uint8Array) {
	channel.message(
		encodeFrame({ kind: payload ? FRAME_DATA : FRAME_END, streamId: id, sequence, payload }),
	);
}
async function openRequest(fixture: ReturnType<typeof setup>, init?: RequestInit) {
	const promise = fixture.transport.request("/api/echo", init);
	await tick();
	const open = fixture.control.json().findLast((message) => message.type === "request.open");
	return { promise, id: Number(open?.streamId) };
}

describe("browser direct-only identity and paths", () => {
	test("pin is derived from valid public key, localhost must be explicit, host cannot be overridden", async () => {
		const identity = await generateIdentity();
		const id = await instanceId(identity.publicKey);
		const invitation: Invitation = {
			instanceId: id,
			publicKey: identity.publicKey,
			pairId: "pair",
			pairingSecret: "a".repeat(64),
			discoveryCapability: "discovery",
			signalUrl: "ws://127.0.0.1:9999/signal/browser",
		};
		await expect(validateInvitation(invitation, { origin: "http://localhost" })).rejects.toThrow(
			"instance_origin_required",
		);
		await expect(
			validateInvitation(invitation, { origin: "http://localhost", allowLocalhost: true }),
		).rejects.toThrow("instance_origin_required");
		await validateInvitation(invitation, {
			origin: "http://localhost",
			allowLocalhost: true,
			expectedInstanceId: id,
		});
		await expect(
			validateInvitation(
				{ ...invitation, instanceId: "a".repeat(52) },
				{ origin: "http://localhost", allowLocalhost: true, expectedInstanceId: "a".repeat(52) },
			),
		).rejects.toThrow("instance_pin_mismatch");
		await expect(
			validateInvitation(invitation, {
				origin: `https://${"a".repeat(52)}.connect.example`,
				allowLocalhost: true,
				expectedInstanceId: id,
			}),
		).rejects.toThrow("instance_host_mismatch");
		await expect(
			validateInvitation(
				{ ...invitation, signalUrl: "ws://remote.example/signal/browser" },
				{ origin: `https://${id}.connect.example`, allowLocalhost: true },
			),
		).rejects.toThrow("invalid_signal_url");
	});
	test("STUN only and all SDP candidates must be direct", () => {
		assertStunUrls(["stun:example.com:3478", "stuns:example.com:5349?transport=tcp"]);
		for (const url of [
			"turn:example.com",
			"turns:example.com",
			"https://example.com",
			"stun:usr@example.com",
		])
			expect(() => assertStunUrls([url])).toThrow("turn_forbidden");
		assertDirectSdp("v=0\r\na=candidate:1 1 udp 123 127.0.0.1 2000 typ host\r\n");
		expect(() =>
			assertDirectSdp("v=0\r\na=candidate:1 1 udp 123 127.0.0.1 2000 typ relay\r\n"),
		).toThrow("relay_or_invalid_candidate");
	});
	test("absolute URLs, encoded traversal, query credentials, secret headers rejected", async () => {
		for (const path of [
			"https://example.com/api/x",
			"//example.com/api/x",
			"/api/../private",
			"/api/%2e%2e/private",
			"/api/a\\b",
			"/api/a#x",
			"/api/a?token=secret",
			"/api/%2fprivate",
		])
			expect(() => remotePath(path)).toThrow();
		const fixture = setup();
		await activate(fixture);
		for (const header of ["X-NarraFork-Bridge", "Host", "X-Forwarded-Host"])
			await expect(
				fixture.transport.request("/api/echo", { headers: { [header]: "secret" } }),
			).rejects.toThrow("forbidden_header");
		await expect(fixture.transport.request("/api/echo", { redirect: "follow" })).rejects.toThrow(
			"redirect_follow_forbidden",
		);
		expect(
			fixture.control.json().filter((message) => message.type === "request.open"),
		).toHaveLength(0);
	});
	test("fragment removed even when malformed, never kept in URL", () => {
		let changed = "";
		const history = {
			replaceState: (_data: unknown, _unused: string, url?: string | URL | null) => {
				changed = String(url);
			},
		};
		expect(() =>
			takeFragmentInvitation({ hash: "#%zz", pathname: "/", search: "" }, history),
		).toThrow();
		expect(changed).toBe("/");
	});
});

describe("browser HTTP frame and credit transport", () => {
	test("response headers resolve before body; body before headers survives cross-channel ordering", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture);
		frame(fixture.bulk, id, 0, new TextEncoder().encode("early"));
		head(fixture.control, id);
		const response = await promise;
		expect(response.status).toBe(200);
		expect(fixture.transport.queueBytes.incoming).toBe(5);
		const reader = response.body?.getReader();
		expect(new TextDecoder().decode((await reader?.read())?.value)).toBe("early");
		await tick();
		expect(fixture.control.json().find((message) => message.type === "window.update")?.bytes).toBe(
			5,
		);
		frame(fixture.bulk, id, 1);
		expect((await reader?.read())?.done).toBe(true);
	});
	test("response preserves content length and business renewal headers but not bridge secrets", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture);
		head(fixture.control, id, 200, [
			["Content-Length", "5"],
			["X-NarraFork-Session-Token", "renewed-token"],
			["Content-Disposition", "inline"],
		]);
		const response = await promise;
		expect(response.headers.get("Content-Length")).toBe("5");
		expect(response.headers.get("X-NarraFork-Session-Token")).toBe("renewed-token");
		frame(fixture.bulk, id, 0, new TextEncoder().encode("hello"));
		frame(fixture.bulk, id, 1);
		expect(await response.text()).toBe("hello");
		const other = await openRequest(fixture);
		head(fixture.control, other.id, 200, [["X-NarraFork-Bridge", "private"]]);
		await expect(other.promise).rejects.toThrow("forbidden_header");
	});
	test("state exists before request.open even when peer synchronously answers", async () => {
		const fixture = setup();
		await activate(fixture);
		fixture.control.onsend = (data) => {
			if (typeof data !== "string") return;
			const message = JSON.parse(data);
			if (message.type !== "request.open") return;
			head(fixture.control, message.streamId);
			frame(fixture.bulk, message.streamId, 0, new TextEncoder().encode("immediate"));
			frame(fixture.bulk, message.streamId, 1);
		};
		expect(await (await fixture.transport.request("/api/echo")).text()).toBe("immediate");
	});
	test("hasBody:false is implicit request EOF and emits no bulk END", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture);
		fixture.control.control({ type: "request.accept", streamId: id });
		await tick();
		expect(
			fixture.control.json().findLast((message) => message.type === "request.open")?.hasBody,
		).toBe(false);
		expect(fixture.bulk.sent).toHaveLength(0);
		head(fixture.control, id, 204);
		frame(fixture.bulk, id, 0);
		expect((await promise).body).toBeNull();
	});
	test("upload waits accept, frames are bounded and credit does not exceed 64KiB", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture, {
			method: "POST",
			body: new Uint8Array(100_000),
		});
		expect(fixture.bulk.sent).toHaveLength(0);
		fixture.control.control({ type: "request.accept", streamId: id });
		await tick();
		await tick();
		const frames = fixture.bulk.sent.map((value) => decodeFrame(value as Uint8Array));
		expect(frames.reduce((sum, value) => sum + value.payload.byteLength, 0)).toBe(
			LIMITS.windowBytes,
		);
		for (const value of fixture.bulk.sent)
			expect((value as Uint8Array).byteLength).toBeLessThanOrEqual(LIMITS.frameBytes);
		fixture.control.control({ type: "window.update", streamId: id, bytes: LIMITS.windowBytes });
		await tick();
		await tick();
		const final = fixture.bulk.sent.map((value) => decodeFrame(value as Uint8Array));
		expect(final.reduce((sum, value) => sum + value.payload.byteLength, 0)).toBe(100_000);
		expect(final.at(-1)?.kind).toBe(FRAME_END);
		head(fixture.control, id, 204);
		frame(fixture.bulk, id, 0);
		expect((await promise).body).toBeNull();
	});
	test("consumer demand alone replenishes receive credit, excessive peer credit fails closed", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture);
		head(fixture.control, id);
		const response = await promise;
		for (let seq = 0; seq < 4; seq++) frame(fixture.bulk, id, seq, new Uint8Array(16000));
		await tick();
		expect(fixture.transport.queueBytes.incoming).toBe(64000);
		expect(fixture.control.json().some((message) => message.type === "window.update")).toBe(false);
		await response.body?.getReader().read();
		await tick();
		expect(fixture.transport.queueBytes.incoming).toBe(48000);
		fixture.control.control({ type: "window.update", streamId: id, bytes: 1 });
		expect(fixture.transport.state).toBe("closed");
	});
	test("AbortSignal and reader.cancel each transmit stream.cancel; close rejects pending reads", async () => {
		const fixture = setup();
		await activate(fixture);
		const abort = new AbortController();
		const first = await openRequest(fixture, { signal: abort.signal });
		abort.abort();
		await tick();
		await expect(first.promise).rejects.toBeInstanceOf(Error);
		expect(
			fixture.control
				.json()
				.some((message) => message.type === "stream.cancel" && message.streamId === first.id),
		).toBe(true);
		const second = await openRequest(fixture);
		head(fixture.control, second.id);
		const response = await second.promise;
		await response.body?.cancel();
		await tick();
		expect(
			fixture.control
				.json()
				.some((message) => message.type === "stream.cancel" && message.streamId === second.id),
		).toBe(true);
		const third = await openRequest(fixture);
		head(fixture.control, third.id);
		const pendingRead = (await third.promise).body?.getReader().read();
		fixture.transport.close(new Error("grant_revoked"));
		await expect(pendingRead).rejects.toThrow("grant_revoked");
	});
	test("HEAD/204/304 use null bodies and redirects are returned without follow", async () => {
		const fixture = setup();
		await activate(fixture);
		for (const [status, method] of [
			[200, "HEAD"],
			[204, "GET"],
			[304, "GET"],
		] as const) {
			const { promise, id } = await openRequest(fixture, { method });
			head(fixture.control, id, status);
			frame(fixture.bulk, id, 0);
			expect((await promise).body).toBeNull();
		}
		const { promise, id } = await openRequest(fixture);
		head(fixture.control, id, 302, [["Location", "http://192.0.2.1/private"]]);
		frame(fixture.bulk, id, 0);
		const response = await promise;
		expect(response.status).toBe(302);
		expect(response.headers.get("Location")).toBe("http://192.0.2.1/private");
	});
	test("multipart uses Request-generated boundary and streaming UTF8 decoding survives split chunks", async () => {
		const fixture = setup();
		await activate(fixture);
		const form = new FormData();
		form.append("text", "中文");
		const { promise, id } = await openRequest(fixture, { method: "POST", body: form });
		const open = fixture.control.json().findLast((message) => message.type === "request.open");
		const pairs = open?.headers as [string, string][];
		expect(pairs.find(([key]) => key === "content-type")?.[1]).toMatch(
			/multipart\/form-data; boundary=/,
		);
		fixture.control.control({ type: "request.accept", streamId: id });
		await tick();
		await tick();
		expect(fixture.bulk.sent.length).toBeGreaterThan(0);
		head(fixture.control, id, 200, [["Content-Type", "text/event-stream"]]);
		const bytes = new TextEncoder().encode("data: 中文\n\n");
		for (let i = 0; i < bytes.length; i++) frame(fixture.bulk, id, i, bytes.slice(i, i + 1));
		frame(fixture.bulk, id, bytes.length);
		expect(await (await promise).text()).toBe("data: 中文\n\n");
	});
	test("high RTC bufferedAmount pauses writes until low watermark", async () => {
		const fixture = setup();
		await activate(fixture);
		fixture.bulk.bufferedAmount = 1024 * 1024 + 1;
		const { promise, id } = await openRequest(fixture, { method: "POST", body: "payload" });
		fixture.control.control({ type: "request.accept", streamId: id });
		await tick();
		expect(fixture.bulk.sent).toHaveLength(0);
		fixture.bulk.low();
		await tick();
		await tick();
		expect(fixture.bulk.sent.length).toBeGreaterThan(0);
		head(fixture.control, id, 204);
		frame(fixture.bulk, id, 0);
		await promise;
	});
	test("abort during RTC backpressure cancels only that upload and stops queued frames", async () => {
		const fixture = setup();
		await activate(fixture);
		fixture.bulk.bufferedAmount = 1024 * 1024 + 1;
		const abort = new AbortController();
		const { promise, id } = await openRequest(fixture, {
			method: "POST",
			body: "payload",
			signal: abort.signal,
		});
		fixture.control.control({ type: "request.accept", streamId: id });
		await tick();
		abort.abort();
		await tick();
		await expect(promise).rejects.toBeInstanceOf(Error);
		fixture.bulk.low();
		await tick();
		expect(fixture.bulk.sent).toHaveLength(0);
		expect(fixture.transport.state).toBe("ready");
		const second = await openRequest(fixture);
		fixture.control.control({ type: "request.accept", streamId: second.id });
		head(fixture.control, second.id, 204);
		frame(fixture.bulk, second.id, 0);
		expect((await second.promise).status).toBe(204);
	});
	test("JSON and binary uploads enforce distinct 1MiB and 8MiB caps", async () => {
		const fixture = setup();
		await activate(fixture);
		fixture.bulk.onsend = (value) => {
			if (typeof value === "string") return;
			const packet = decodeFrame(value);
			if (packet.kind === FRAME_DATA)
				fixture.control.control({
					type: "window.update",
					streamId: packet.streamId,
					bytes: packet.payload.byteLength,
				});
		};
		for (const [size, type] of [
			[LIMITS.jsonBytes + 1, "application/json"],
			[LIMITS.fileBytes + 1, "application/octet-stream"],
		] as const) {
			const { promise, id } = await openRequest(fixture, {
				method: "POST",
				headers: { "Content-Type": type },
				body: new Uint8Array(size),
			});
			fixture.control.control({ type: "request.accept", streamId: id });
			await expect(promise).rejects.toThrow("request_body_exceeded");
		}
		for (const packet of fixture.bulk.sent)
			expect((packet as Uint8Array).byteLength).toBeLessThanOrEqual(LIMITS.frameBytes);
		expect(fixture.transport.state).toBe("ready");
	});
	test("streaming JSON response cap fails closed and releases queued bytes", async () => {
		const fixture = setup();
		await activate(fixture);
		const { promise, id } = await openRequest(fixture);
		head(fixture.control, id, 200, [["Content-Type", "application/json"]]);
		const reader = (await promise).body?.getReader();
		let total = 0;
		let sequence = 0;
		while (total < LIMITS.jsonBytes) {
			const count = Math.min(LIMITS.frameBytes - LIMITS.headerBytes, LIMITS.jsonBytes - total);
			frame(fixture.bulk, id, sequence++, new Uint8Array(count));
			await reader?.read();
			total += count;
		}
		const pending = reader?.read();
		frame(fixture.bulk, id, sequence, new Uint8Array([1]));
		await expect(pending).rejects.toThrow("receive_queue_exceeded");
		expect(fixture.transport.queueBytes.incoming).toBe(0);
	});
	test("header deadline and invalid sequence fail pending work", async () => {
		const fixture = setup({ headerTimeoutMs: 5 });
		await activate(fixture);
		await expect(fixture.transport.request("/api/echo")).rejects.toThrow("response_header_timeout");
		const second = setup();
		await activate(second);
		const { promise, id } = await openRequest(second);
		frame(second.bulk, id, 2, new Uint8Array([1]));
		await expect(promise).rejects.toThrow("invalid_sequence");
		expect(second.transport.queueBytes.incoming).toBe(0);
	});
});

describe("browser authentication and logical sockets", () => {
	test("pre-auth denies protected requests and mismatched ready versions fail closed", async () => {
		const fixture = setup();
		await expect(fixture.transport.request("/api/projects")).rejects.toThrow("not_authenticated");
		const pending = fixture.transport.authenticate("jwt");
		await tick();
		fixture.control.control({
			type: "ready",
			version: 999,
			apiVersion: 1,
			appVersion: APP_VERSION,
		});
		await expect(pending).rejects.toThrow("version_mismatch");
		expect(fixture.transport.state).toBe("closed");
	});
	test("socket waits actual ready; closing connecting socket sends lifecycle cancellation", async () => {
		const fixture = setup();
		await activate(fixture);
		const socket = fixture.transport.openSocket("/ws/narrator", "jwt");
		expect(socket.readyState).toBe(socket.CONNECTING);
		expect(() => socket.send('{"type":"ping"}')).toThrow("socket_not_open");
		fixture.realtime.control({ type: "socket.ready", streamId: socket.streamId });
		await socket.ready;
		expect(socket.readyState).toBe(socket.OPEN);
		socket.send('{"type":"ping"}');
		await tick();
		expect(fixture.realtime.json().some((message) => message.type === "socket.send")).toBe(true);
		let received = "";
		socket.onmessage = (event) => {
			received = event.data;
		};
		fixture.realtime.control({
			type: "socket.message",
			streamId: socket.streamId,
			message: '{"type":"pong"}',
		});
		expect(received).toBe('{"type":"pong"}');
		const connecting = fixture.transport.openSocket("/ws/narrator", "jwt");
		connecting.close();
		await tick();
		expect(connecting.readyState).toBe(connecting.CLOSED);
		await expect(connecting.ready).rejects.toThrow("socket_closed");
		expect(
			fixture.realtime
				.json()
				.some(
					(message) => message.type === "socket.close" && message.streamId === connecting.streamId,
				),
		).toBe(true);
	});
	test("socket budget is eight and JSON control envelope is bounded", async () => {
		const fixture = setup();
		await activate(fixture);
		for (let i = 0; i < 8; i++) fixture.transport.openSocket("/ws/narrator", "jwt");
		expect(() => fixture.transport.openSocket("/ws/narrator", "jwt")).toThrow("too_many_sockets");
		expect(
			fixture.control.json().some((message) => String(message.type).startsWith("socket.")),
		).toBe(false);
	});
});
