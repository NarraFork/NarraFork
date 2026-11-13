import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import type { BusinessSocket } from "@shared/remote-access/business-transport";
import { DeferredBusinessSocket } from "./recovering-transport";

const originalCloseEvent = Object.getOwnPropertyDescriptor(globalThis, "CloseEvent");
class TestCloseEvent extends Event {
	readonly code: number;
	readonly reason: string;
	readonly wasClean: boolean;
	constructor(type: string, init?: CloseEventInit) {
		super(type);
		this.code = init?.code ?? 0;
		this.reason = init?.reason ?? "";
		this.wasClean = init?.wasClean ?? false;
	}
}
class Socket extends EventTarget implements BusinessSocket {
	readyState = 0;
	bufferedAmount = 0;
	binaryType: BinaryType = "blob";
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	send = mock((_data: string | ArrayBuffer | ArrayBufferView<ArrayBuffer>) => {});
	close(code = 1000, reason = "") {
		this.readyState = 3;
		this.onclose?.(new CloseEvent("close", { code, reason }));
	}
	open() {
		this.readyState = 1;
		this.onopen?.(new Event("open"));
	}
}
beforeEach(() => {
	Object.defineProperty(globalThis, "CloseEvent", { configurable: true, value: TestCloseEvent });
});
afterEach(() => {
	if (originalCloseEvent) Object.defineProperty(globalThis, "CloseEvent", originalCloseEvent);
	else Reflect.deleteProperty(globalThis, "CloseEvent");
});

test("logical socket preserves text/binary and close 4001 without a native WebSocket", async () => {
	const inner = new Socket();
	const ended = mock(() => {});
	const socket = new DeferredBusinessSocket(async () => inner, ended);
	socket.binaryType = "arraybuffer";
	expect(() => socket.send("before-open")).toThrow("REMOTE_SOCKET_NOT_OPEN");
	await Promise.resolve();
	const opened = mock(() => {});
	socket.onopen = opened;
	inner.open();
	expect(opened).toHaveBeenCalledTimes(1);
	expect(inner.binaryType).toBe("arraybuffer");
	const message = mock(() => {});
	socket.onmessage = message;
	inner.onmessage?.(new MessageEvent("message", { data: "hello" }));
	const bytes = new Uint8Array([3, 4]);
	inner.onmessage?.(new MessageEvent("message", { data: bytes.buffer }));
	expect(message).toHaveBeenCalledTimes(2);
	socket.send(bytes);
	expect(inner.send).toHaveBeenCalledWith(bytes);
	const closed = mock(() => {});
	socket.onclose = closed;
	inner.close(4001, "session revoked");
	expect(socket.readyState).toBe(3);
	expect(closed).toHaveBeenCalledWith(
		expect.objectContaining({ code: 4001, reason: "session revoked" }),
	);
	expect(ended).toHaveBeenCalledWith(4001);
});
test("closing a connecting socket prevents later open from resurrecting it", async () => {
	const inner = new Socket();
	let resolve!: (value: BusinessSocket) => void;
	const socket = new DeferredBusinessSocket(
		() =>
			new Promise((done) => {
				resolve = done;
			}),
	);
	const open = mock(() => {});
	socket.onopen = open;
	socket.close();
	resolve(inner);
	await Promise.resolve();
	expect(socket.readyState).toBe(3);
	expect(inner.readyState).toBe(3);
	expect(open).not.toHaveBeenCalled();
});
