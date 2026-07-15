import { describe, expect, it } from "bun:test";
import {
	createNarratorForegroundRecoveryCoalescer,
	decideNarratorForegroundRecovery,
	NarratorWSManager,
} from "../../frontend/lib/narrator-ws-manager";

class FakeWebSocket {
	static readonly CONNECTING = 0;
	static readonly OPEN = 1;
	static readonly CLOSING = 2;
	static readonly CLOSED = 3;
	static instances: FakeWebSocket[] = [];

	readonly url: string;
	readyState = FakeWebSocket.CONNECTING;
	onopen: ((event: Event) => void) | null = null;
	onmessage: ((event: MessageEvent) => void) | null = null;
	onclose: ((event: CloseEvent) => void) | null = null;
	onerror: ((event: Event) => void) | null = null;
	sent: string[] = [];

	constructor(url: string | URL) {
		this.url = String(url);
		FakeWebSocket.instances.push(this);
	}

	open(): void {
		this.readyState = FakeWebSocket.OPEN;
		this.onopen?.(new Event("open"));
	}

	send(data: string | ArrayBufferLike | Blob | ArrayBufferView): void {
		this.sent.push(String(data));
	}

	close(): void {
		this.readyState = FakeWebSocket.CLOSED;
	}
}

function installBrowserHarness(initiallyOnline: boolean): {
	windowTarget: EventTarget;
	navigatorState: { onLine: boolean };
	restore: () => void;
} {
	const globalKeys = ["window", "document", "navigator", "localStorage", "WebSocket"] as const;
	const originalDescriptors = new Map(
		globalKeys.map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]),
	);
	const windowTarget = Object.assign(new EventTarget(), {
		location: {
			protocol: "http:",
			host: "localhost:7778",
			hostname: "localhost",
			port: "7778",
		},
	});
	const documentTarget = Object.assign(new EventTarget(), {
		visibilityState: "visible" as DocumentVisibilityState,
	});
	const navigatorState = { onLine: initiallyOnline };
	const values = new Map<string, string>([["narrafork_token", "test-token"]]);
	const storage: Storage = {
		get length() {
			return values.size;
		},
		clear: () => values.clear(),
		getItem: (key) => values.get(key) ?? null,
		key: (index) => [...values.keys()][index] ?? null,
		removeItem: (key) => values.delete(key),
		setItem: (key, value) => values.set(key, value),
	};

	FakeWebSocket.instances = [];
	for (const [key, value] of [
		["window", windowTarget],
		["document", documentTarget],
		["navigator", navigatorState],
		["localStorage", storage],
		["WebSocket", FakeWebSocket],
	] as const) {
		Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
	}

	return {
		windowTarget,
		navigatorState,
		restore: () => {
			for (const key of globalKeys) {
				const descriptor = originalDescriptors.get(key);
				if (descriptor) Object.defineProperty(globalThis, key, descriptor);
				else Reflect.deleteProperty(globalThis, key);
			}
			FakeWebSocket.instances = [];
		},
	};
}

function hasSubscribeFor(socket: FakeWebSocket, narratorId: string): boolean {
	return socket.sent.some((raw) => {
		const message = JSON.parse(raw) as { type?: string; narratorIds?: string[] };
		return message.type === "subscribe" && message.narratorIds?.includes(narratorId);
	});
}

describe("narrator foreground recovery", () => {
	it("短时隐藏且连接正常时只执行同步", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 5_000,
				socketState: "open",
				hasPendingReconnect: false,
			}),
		).toBe("sync");
	});

	it("长时隐藏后强制重连，即使旧连接仍显示为打开", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 60_000,
				socketState: "open",
				hasPendingReconnect: true,
			}),
		).toBe("reconnect");
	});

	it("连接缺失且没有有效重连任务时立即重连", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "missing",
				hasPendingReconnect: false,
			}),
		).toBe("reconnect");
	});

	it("已有退避重连任务时不绕过定时器", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "missing",
				hasPendingReconnect: true,
			}),
		).toBe("none");
	});

	it("连接正在建立时不重复发起连接", () => {
		expect(
			decideNarratorForegroundRecovery({
				hiddenElapsedMs: 1_000,
				socketState: "connecting",
				hasPendingReconnect: false,
			}),
		).toBe("none");
	});

	it("连续前台事件只执行一次恢复动作", async () => {
		const coalescer = createNarratorForegroundRecoveryCoalescer(1);
		let recoveryCount = 0;
		expect(coalescer.schedule(() => recoveryCount++)).toBe(true);
		expect(coalescer.schedule(() => recoveryCount++)).toBe(false);
		await Bun.sleep(10);
		expect(recoveryCount).toBe(1);
		coalescer.cancel();
	});

	it("网络恢复时即使旧 socket 仍为 OPEN 也强制重连并恢复订阅", async () => {
		const harness = installBrowserHarness(true);
		const manager = new NarratorWSManager();
		const connectionChanges: Array<[boolean, boolean]> = [];
		manager.onConnectionChange((connected, isReconnect) => {
			connectionChanges.push([connected, isReconnect]);
		});

		try {
			manager.connect();
			const firstSocket = FakeWebSocket.instances[0];
			expect(firstSocket).toBeDefined();
			firstSocket.open();
			const subscription = manager.subscribe(["narrator-1"], { kind: "messages" });
			await Promise.resolve();
			expect(hasSubscribeFor(firstSocket, "narrator-1")).toBe(true);

			// Some browsers retain OPEN across a physical disconnect. The online event
			// must replace it rather than trusting readyState or sending sync_check to it.
			harness.windowTarget.dispatchEvent(new Event("online"));
			expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
			expect(FakeWebSocket.instances).toHaveLength(2);

			const recoveredSocket = FakeWebSocket.instances[1];
			recoveredSocket.open();
			await Promise.resolve();
			expect(hasSubscribeFor(recoveredSocket, "narrator-1")).toBe(true);
			expect(connectionChanges.at(-1)).toEqual([true, true]);

			manager.unsubscribe(subscription);
		} finally {
			manager.disconnect();
			harness.restore();
		}
	});

	it("离线时关闭半开连接并暂停重试，online 后立即恢复", () => {
		const harness = installBrowserHarness(true);
		const manager = new NarratorWSManager();

		try {
			manager.connect();
			const firstSocket = FakeWebSocket.instances[0];
			firstSocket.open();

			harness.navigatorState.onLine = false;
			harness.windowTarget.dispatchEvent(new Event("offline"));
			expect(firstSocket.readyState).toBe(FakeWebSocket.CLOSED);
			expect(manager.connected).toBe(false);
			expect(manager.disconnected).toBe(true);

			// Manual/fallback retries while navigator reports offline must not create sockets.
			manager.reconnect();
			expect(FakeWebSocket.instances).toHaveLength(1);

			harness.navigatorState.onLine = true;
			harness.windowTarget.dispatchEvent(new Event("online"));
			expect(FakeWebSocket.instances).toHaveLength(2);
			FakeWebSocket.instances[1].open();
			expect(manager.connected).toBe(true);
			expect(manager.disconnected).toBe(false);
		} finally {
			manager.disconnect();
			harness.restore();
		}
	});
});
