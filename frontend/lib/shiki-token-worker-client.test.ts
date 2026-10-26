import { describe, expect, it } from "bun:test";
import type { ShikiTokenLoader } from "./shiki-token-cache";
import {
	createShikiTokenWorkerLoader,
	type ShikiTokenWorkerPort,
} from "./shiki-token-worker-client";
import type {
	ShikiToken,
	ShikiTokenWorkerRequest,
	ShikiTokenWorkerResponse,
} from "./shiki-token-worker-protocol";

const THEME = "github-dark-default";

class FakePort implements ShikiTokenWorkerPort {
	messages: ShikiTokenWorkerRequest[] = [];
	terminated = false;
	onmessage: ((event: MessageEvent<ShikiTokenWorkerResponse>) => void) | null = null;
	onerror: ((event: ErrorEvent) => void) | null = null;
	postMessage(message: ShikiTokenWorkerRequest) {
		this.messages.push(message);
	}
	terminate() {
		this.terminated = true;
	}
	requests() {
		return this.messages.filter(
			(message): message is Extract<ShikiTokenWorkerRequest, { type: "tokens" }> =>
				message.type === "tokens",
		);
	}
	reply(code: string, tokens: ShikiToken[][] | null = [[{ content: code }]]) {
		const request = this.requests().find((message) => message.code === code);
		if (!request) throw new Error(`no request for ${code}`);
		this.onmessage?.({ data: { type: "tokens", id: request.id, tokens } } as MessageEvent);
	}
}

function setup(options: { maxInFlight?: number; maxQueued?: number; watchdogMs?: number } = {}) {
	const ports: FakePort[] = [];
	const fallbackCalls: string[] = [];
	const fallback: ShikiTokenLoader = async (code) => {
		fallbackCalls.push(code);
		return [[{ content: `main:${code}` }]];
	};
	const load = createShikiTokenWorkerLoader({
		factory: () => {
			const port = new FakePort();
			ports.push(port);
			return port;
		},
		appBase: () => "https://app.test/nf/",
		fallback,
		...options,
	});
	return { load, ports, fallbackCalls };
}

const settle = async () => {
	for (let i = 0; i < 4; i++) await Promise.resolve();
};

describe("shiki token worker loader", () => {
	it("boots one lazy Worker and resolves tokens from it", async () => {
		const { load, ports } = setup();
		expect(ports).toHaveLength(0);
		const result = load("const a = 1", "typescript", THEME);
		expect(ports).toHaveLength(1);
		expect(ports[0].messages[0]).toEqual({ type: "boot", assetBase: "https://app.test/nf/" });
		expect(ports[0].requests()[0]).toMatchObject({
			code: "const a = 1",
			lang: "typescript",
			theme: THEME,
		});
		ports[0].reply("const a = 1");
		expect(await result).toEqual([[{ content: "const a = 1" }]]);

		const second = load("b", "typescript", THEME);
		expect(ports).toHaveLength(1);
		ports[0].reply("b", null);
		expect(await second).toBeNull();
	});

	it("dispatches newest-first within a bounded in-flight window", async () => {
		const { load, ports } = setup({ maxInFlight: 1 });
		const a = load("a", "typescript", THEME);
		const b = load("b", "typescript", THEME);
		const c = load("c", "typescript", THEME);
		expect(ports[0].requests().map((message) => message.code)).toEqual(["a"]);

		ports[0].reply("a");
		await a;
		// The most recently revealed body jumps the older backlog.
		expect(ports[0].requests().map((message) => message.code)).toEqual(["a", "c"]);
		ports[0].reply("c");
		await c;
		ports[0].reply("b");
		expect(await b).toEqual([[{ content: "b" }]]);
	});

	it("drops the oldest queued request beyond the queue bound", async () => {
		const { load, ports } = setup({ maxInFlight: 1, maxQueued: 2 });
		void load("busy", "typescript", THEME);
		const oldest = load("old", "typescript", THEME);
		void load("mid", "typescript", THEME);
		void load("new", "typescript", THEME);
		expect(await oldest).toBeNull();
		expect(ports[0].requests().map((message) => message.code)).toEqual(["busy"]);
	});

	it("abandons a runaway request and restarts the Worker for the rest", async () => {
		const { load, ports } = setup({ maxInFlight: 2, watchdogMs: 5 });
		const stuck = load("stuck", "typescript", THEME);
		await new Promise((resolve) => setTimeout(resolve, 1));
		const other = load("other", "typescript", THEME);
		expect(await stuck).toBeNull();
		expect(ports[0].terminated).toBe(true);
		expect(ports).toHaveLength(2);
		expect(ports[1].requests().map((message) => message.code)).toEqual(["other"]);
		ports[1].reply("other");
		expect(await other).toEqual([[{ content: "other" }]]);
	});

	it("falls back to the main thread once the Worker cannot run", async () => {
		const { load, ports, fallbackCalls } = setup({ maxInFlight: 1 });
		const first = load("first", "typescript", THEME);
		const queued = load("queued", "typescript", THEME);
		ports[0].onerror?.({ message: "blocked" } as ErrorEvent);
		await settle();
		expect(ports[0].terminated).toBe(true);
		expect(await first).toEqual([[{ content: "main:first" }]]);
		expect(await queued).toEqual([[{ content: "main:queued" }]]);

		expect(await load("later", "typescript", THEME)).toEqual([[{ content: "main:later" }]]);
		expect(ports).toHaveLength(1);
		expect(fallbackCalls).toEqual(["first", "queued", "later"]);
	});

	it("falls back when the Worker cannot even be constructed", async () => {
		const fallbackCalls: string[] = [];
		const load = createShikiTokenWorkerLoader({
			factory: () => {
				throw new Error("SecurityError");
			},
			appBase: () => "https://app.test/",
			fallback: async (code) => {
				fallbackCalls.push(code);
				return null;
			},
		});
		expect(await load("x", "typescript", THEME)).toBeNull();
		expect(fallbackCalls).toEqual(["x"]);
	});
});
