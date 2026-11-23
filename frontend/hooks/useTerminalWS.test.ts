import { expect, test } from "bun:test";
import { withSocketTimers } from "../lib/ws-test-utils";
import { TerminalWSManager } from "./useTerminalWS";

class Socket {
	static CONNECTING = 0;
	static OPEN = 1;
	static CLOSING = 2;
	static instances: Socket[] = [];
	readyState = 0;
	onopen: (() => void) | null = null;
	onclose: ((event: { code: number }) => void) | null = null;
	onmessage = null;
	onerror = null;
	constructor() {
		Socket.instances.push(this);
	}
	send() {}
	close() {
		this.readyState = 3;
	}
	open() {
		this.readyState = 1;
		this.onopen?.();
	}
}

function withManager(run: (manager: TerminalWSManager, window: EventTarget) => void) {
	const window = Object.assign(new EventTarget(), {
		location: { protocol: "https:", hostname: "example.test", host: "example.test", port: "" },
	});
	const replacements = {
		window,
		document: Object.assign(new EventTarget(), { visibilityState: "visible" }),
		localStorage: { getItem: () => "test-token" },
		WebSocket: Socket,
	};
	const originals = new Map<string, PropertyDescriptor | undefined>();
	for (const [key, value] of Object.entries(replacements)) {
		originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}
	Socket.instances = [];
	const manager = new TerminalWSManager();
	try {
		manager.connect();
		run(manager, window);
	} finally {
		manager.dispose();
		for (const [key, descriptor] of originals) {
			if (descriptor) Object.defineProperty(globalThis, key, descriptor);
			else Reflect.deleteProperty(globalThis, key);
		}
	}
}

test("silent terminal handshake expires and retries", () => {
	withSocketTimers((fire) =>
		withManager((manager) => {
			fire(10_000);
			expect(manager.disconnected).toBe(true);
			fire(1000);
			expect(Socket.instances[0]?.readyState).toBe(3);
			expect(Socket.instances).toHaveLength(2);
		}),
	);
});

test("terminal watchdog retries without a close event", () => {
	withSocketTimers((fire) =>
		withManager((manager) => {
			Socket.instances[0]?.open();
			fire(10_000);
			expect(manager.connected).toBe(true);
			fire(60_000);
			expect(manager.connected).toBe(false);
			fire(1000);
			expect(Socket.instances).toHaveLength(2);
		}),
	);
});

test("online replaces a pending socket but preserves an open socket", () => {
	withSocketTimers(() =>
		withManager((_manager, window) => {
			window.dispatchEvent(new Event("online"));
			expect(Socket.instances).toHaveLength(2);
			Socket.instances[1]?.open();
			window.dispatchEvent(new Event("online"));
			expect(Socket.instances).toHaveLength(2);
		}),
	);
});

test("resume revives exhausted terminal retries", () => {
	withSocketTimers((fire) =>
		withManager((_manager, window) => {
			for (let attempt = 0; attempt <= 50; attempt++) {
				const socket = Socket.instances.at(-1);
				if (!socket) throw new Error("Missing socket");
				socket.readyState = 3;
				socket.onclose?.({ code: 1006 });
				fire(Math.min(1000 * 2 ** attempt, 30_000));
			}
			const count = Socket.instances.length;
			window.dispatchEvent(new Event("pageshow"));
			expect(Socket.instances).toHaveLength(count + 1);
		}),
	);
});
