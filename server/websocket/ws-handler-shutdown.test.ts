import { describe, expect, mock, test } from "bun:test";
import type { ServerWebSocket } from "bun";
import { ShutdownActivityTracker, shutdownStep } from "../lib/shutdown-activity";

let messageWork = Promise.resolve();
const handler = { open() {}, close() {}, message: () => messageWork };
mock.module("../lib/settings", () => ({ settings: {} }));
mock.module("../lib/logger", () => ({ logger: { warn() {}, info() {}, error() {}, debug() {} } }));
mock.module("../services/device-connection-service", () => ({
	handleDeviceWS: handler,
	getDeviceConnections: () => new Map(),
}));
mock.module("./narrator-ws", () => ({
	handleNarratorWS: handler,
	getNarratorConnections: () => new Map(),
}));
mock.module("./terminal-ws", () => ({
	handleTerminalWS: handler,
	getTerminalConnections: () => new Map(),
}));
mock.module("./vnet-ws", () => ({ handleVNetWS: handler, getVNetConnections: () => new Map() }));
mock.module("./external-narrator-ws", () => ({
	handleExternalNarratorWS: handler,
	rejectOversizedExternalNarratorFrame: () => false,
}));
mock.module("./oauth-connection-registry", () => ({
	closeAllExternalNarratorConnections() {},
	closeExternalNarratorConnectionForAuthLoss() {},
	getExternalNarratorConnections: () => new Map(),
	sendExternalNarratorFrame() {},
}));
const { waitForWebSocketActivityDrain, wsHandlers } = await import("./ws-handler");

import type { WSData } from "./ws-handler";

function deferred() {
	let resolve!: () => void;
	const promise = new Promise<void>((done) => {
		resolve = done;
	});
	return { promise, resolve };
}

function dispatch(work: Promise<void>) {
	messageWork = work;
	wsHandlers.message(
		{ data: { channel: "terminal" }, send() {}, close() {} } as unknown as ServerWebSocket<WSData>,
		'{"type":"test"}',
	);
}

describe("WebSocket shutdown activity", () => {
	test("timeout cancels only the drain waiter and keeps unfinished handler ownership", async () => {
		const work = deferred();
		dispatch(work.promise);
		const tracker = new ShutdownActivityTracker();
		tracker.markDrainComplete();
		expect(await shutdownStep(tracker, "websocket", waitForWebSocketActivityDrain, 5)).toBe(
			"timeout",
		);
		expect(tracker.isCleanShutdown()).toBe(false);
		let drained = false;
		const retry = waitForWebSocketActivityDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		work.resolve();
		await retry;
		expect(drained).toBe(true);
	});

	test("an aborted drain never resumes its loop to absorb a later handler", async () => {
		const first = deferred();
		dispatch(first.promise);
		const controller = new AbortController();
		const cancelled = waitForWebSocketActivityDrain(controller.signal);
		controller.abort(new Error("stop waiting"));
		await expect(cancelled).rejects.toThrow("stop waiting");
		const later = deferred();
		dispatch(later.promise);
		first.resolve();
		let drained = false;
		const active = waitForWebSocketActivityDrain().then(() => {
			drained = true;
		});
		await Promise.resolve();
		expect(drained).toBe(false);
		later.resolve();
		await active;
		expect(drained).toBe(true);
	});
});
