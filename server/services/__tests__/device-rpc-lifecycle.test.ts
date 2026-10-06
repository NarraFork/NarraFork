import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { DEVICE_PROTOCOL_VERSION, type RpcMethod } from "../../lib/agent/execution/rpc-types";
import { generateId } from "../../lib/id";
import { settings } from "../../lib/settings";
import {
	getDeviceConnectionDiagnostics,
	getDeviceConnectionGeneration,
	handleDeviceWS,
	isDeviceOnline,
	type SendRpcOptions,
	sendRpc,
} from "../device-connection-service";
import { createRemoteBackend } from "../device-remote-backend";
import { hashDeviceToken } from "../device-service";

type Socket = Parameters<typeof handleDeviceWS.message>[0];
type Frame = { type: string; id?: string; method?: string };
let deviceId: string;
let ws: Socket;
let sent: Frame[];
let sendMode: "ok" | "drop" | "backpressure" | "throw";
let outstanding: Promise<unknown>[];
let originalDevices: typeof settings.devices;

async function connect(): Promise<Socket> {
	const socket = {
		readyState: 1,
		data: {
			channel: "device",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			authenticated: false,
		},
		send(data: string) {
			if (sendMode === "throw") throw new Error("test transport failed");
			if (sendMode === "drop") return 0;
			sent.push(JSON.parse(data));
			return sendMode === "backpressure" ? -1 : data.length;
		},
		close() {},
	} as unknown as Socket;
	await handleDeviceWS.message(socket, {
		type: "hello",
		protocolVersion: DEVICE_PROTOCOL_VERSION,
		deviceRef: deviceId,
		token: "rpc-lifecycle-test-token",
		agentVersion: "test",
		platform: { os: "linux", arch: "amd64" },
		capabilities: { git: true, pty: true },
	});
	expect(isDeviceOnline(deviceId)).toBe(true);
	return socket;
}

function rpc(method: RpcMethod = "fs.stat", opts: SendRpcOptions = {}) {
	const promise = sendRpc(deviceId, method, {}, opts);
	// Attach immediately: cancellation/disconnect may reject several at once.
	outstanding.push(promise.catch(() => {}));
	return promise;
}

async function result(id: string | undefined, ok = true, socket = ws) {
	await handleDeviceWS.message(socket, {
		type: "rpc_result",
		id,
		ok,
		result: 42,
		error: "remote failure",
	});
}
function lastId() {
	return sent.filter((f) => f.type === "rpc").at(-1)?.id;
}
async function roundTrip() {
	const promise = rpc();
	await result(lastId());
	expect(await promise).toBe(42);
}

beforeEach(async () => {
	originalDevices = structuredClone(settings.devices);
	if (!settings.devices) throw new Error("missing device defaults");
	settings.devices.maxConcurrentRpcPerDevice = 2;
	settings.devices.rpcTimeoutMs = 1000;
	deviceId = generateId();
	sent = [];
	outstanding = [];
	sendMode = "ok";
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "RPC lifecycle test",
		slug: deviceId,
		tokenHash: hashDeviceToken("rpc-lifecycle-test-token"),
		tokenPrefix: "test",
		connectionMode: "reverse",
		status: "offline",
		scope: "global",
		createdBy: "rpc-test",
		createdAt: now,
		updatedAt: now,
	});
	ws = await connect();
});
afterEach(async () => {
	if (ws) handleDeviceWS.close(ws);
	await Promise.all(outstanding);
	await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
	settings.devices = originalDevices;
});

describe("device RPC lifecycle", () => {
	test("hundreds of completed Bash RPCs reuse slots and detach abort listeners", async () => {
		const controller = new AbortController();
		const add = spyOn(controller.signal, "addEventListener");
		const remove = spyOn(controller.signal, "removeEventListener");
		try {
			for (let i = 0; i < 100; i++) {
				const promise = rpc("exec.start", { signal: controller.signal });
				await result(lastId());
				expect(await promise).toBe(42);
			}
			expect(add).toHaveBeenCalledTimes(100);
			expect(remove).toHaveBeenCalledTimes(100);
			controller.abort();
			expect(sent.filter((f) => f.type === "rpc_cancel")).toHaveLength(0);
		} finally {
			add.mockRestore();
			remove.mockRestore();
		}
	});

	test("completed RemoteExecHandles detach their caller's abort bridge", async () => {
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: getDeviceConnectionGeneration(deviceId) ?? 0,
		});
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		try {
			for (let i = 0; i < 20; i++) {
				const handle = await backend.execCommand({
					command: "pwd",
					cwd: "/work",
					signal: controller.signal,
				});
				outstanding.push(handle.exited.catch(() => {}));
				await result(lastId());
				await handle.exited;
			}
			expect(remove).toHaveBeenCalledTimes(20);
		} finally {
			remove.mockRestore();
		}
	});
	test("RemoteExecHandle surfaces executor-reported output truncation", async () => {
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: getDeviceConnectionGeneration(deviceId) ?? 0,
		});
		for (const truncated of [true, false]) {
			const handle = await backend.execCommand({ command: "pwd", cwd: "/work" });
			outstanding.push(handle.exited.catch(() => {}));
			await handleDeviceWS.message(ws, {
				type: "rpc_result",
				id: lastId(),
				ok: true,
				result: { exitCode: 0, timedOut: false, truncated },
			});
			expect(await handle.exited).toBe(0);
			expect(handle.outputIncomplete?.()).toBe(truncated);
		}
	});

	test("failure and duplicate/late result release a slot exactly once", async () => {
		const failed = rpc();
		const failedId = lastId();
		const held = rpc();
		const heldId = lastId();
		await expect(rpc()).rejects.toThrow("concurrency limit");
		await result(failedId, false);
		await expect(failed).rejects.toThrow("remote failure");
		await result(failedId);
		await roundTrip();
		await result(heldId);
		await held;
	});

	for (const mode of ["abort", "timeout"] as const) {
		test(`${mode} clears slots without any result from the executor`, async () => {
			const controller = new AbortController();
			const remove = spyOn(controller.signal, "removeEventListener");
			try {
				const opts = { signal: controller.signal, timeoutMs: mode === "timeout" ? 5 : 1000 };
				const calls = [rpc("exec.start", opts), rpc("exec.start", opts)];
				await expect(rpc()).rejects.toThrow("concurrency limit");
				if (mode === "abort") controller.abort();
				for (const promise of calls)
					await expect(promise).rejects.toThrow(mode === "abort" ? "aborted" : "timed out");
				expect(remove).toHaveBeenCalledTimes(2);
				expect(sent.filter((f) => f.type === "rpc_cancel")).toHaveLength(2);
				await roundTrip();
			} finally {
				remove.mockRestore();
			}
		});
	}

	test("disconnect rejects all calls and unbinds the shared owner signal", async () => {
		const controller = new AbortController();
		const remove = spyOn(controller.signal, "removeEventListener");
		try {
			const calls = [
				rpc("exec.start", { signal: controller.signal }),
				rpc("pty.open", { signal: controller.signal, longLived: true }),
			];
			handleDeviceWS.close(ws);
			for (const promise of calls) await expect(promise).rejects.toThrow("offline");
			expect(remove).toHaveBeenCalledTimes(2);
			ws = await connect();
			await roundTrip();
		} finally {
			remove.mockRestore();
		}
	});

	test("a closed socket releases all slots before admission, even without a close callback", async () => {
		const calls = [rpc("exec.start"), rpc("fs.stat")];
		Object.defineProperty(ws, "readyState", { value: 3 });
		await expect(rpc()).rejects.toThrow("offline");
		for (const call of calls) await expect(call).rejects.toThrow("offline");
		expect(isDeviceOnline(deviceId)).toBe(false);
	});
	test("replacement rejects old calls and ignores late results on the old connection", async () => {
		const oldSocket = ws;
		const previous = rpc();
		const oldId = lastId();
		ws = await connect();
		await expect(previous).rejects.toThrow("connection changed");
		const next = rpc();
		const nextId = lastId();
		await handleDeviceWS.message(oldSocket, {
			type: "rpc_result",
			id: oldId,
			ok: true,
			result: "stale transport result",
		});
		handleDeviceWS.close(oldSocket);
		expect(isDeviceOnline(deviceId)).toBe(true);
		await result(nextId);
		expect(await next).toBe(42);
	});

	test("only pty.open may be long-lived, so ordinary RPCs cannot escape the quota/timeout", async () => {
		const sentBefore = sent.length;
		await expect(rpc("exec.start", { longLived: true })).rejects.toThrow("cannot be long-lived");
		expect(sent.length).toBe(sentBefore);
		await roundTrip();
	});

	test("an already-spent explicit deadline fails fast instead of waiting the default", async () => {
		const sentBefore = sent.length;
		await expect(rpc("fs.stat", { timeoutMs: 0 })).rejects.toThrow("deadline already spent");
		await expect(rpc("fs.stat", { timeoutMs: -5 })).rejects.toThrow("deadline already spent");
		expect(sent.length).toBe(sentBefore);
		await roundTrip();
	});

	test("PTY does not count against the short RPC cap", async () => {
		const controller = new AbortController();
		const pty = rpc("pty.open", { longLived: true, signal: controller.signal });
		const a = rpc();
		const aid = lastId();
		const b = rpc();
		const bid = lastId();
		await expect(rpc()).rejects.toThrow("concurrency limit");
		controller.abort();
		await expect(pty).rejects.toThrow("aborted");
		await expect(rpc()).rejects.toThrow("concurrency limit");
		await result(aid);
		await result(bid);
		await Promise.all([a, b]);
	});

	test("the raised limit admits 64 calls, rejects the 65th, and bounds diagnostics", async () => {
		if (!settings.devices) throw new Error("missing settings");
		settings.devices.maxConcurrentRpcPerDevice = 64;
		const calls = Array.from({ length: 64 }, () => rpc());
		await expect(rpc()).rejects.toThrow("concurrency limit reached (64)");
		const diagnostics = await getDeviceConnectionDiagnostics(deviceId);
		expect(diagnostics?.rpc?.shortLived).toBe(64);
		expect(diagnostics?.rpc?.oldest).toHaveLength(8);
		for (const frame of sent.filter((frame) => frame.type === "rpc")) await result(frame.id);
		await Promise.all(calls);
		expect((await getDeviceConnectionDiagnostics(deviceId))?.rpc?.total).toBe(0);
	});

	test("an already aborted request is rejected before admission without sending frames", async () => {
		const controller = new AbortController();
		controller.abort();
		const count = sent.length;
		await expect(rpc("exec.start", { signal: controller.signal })).rejects.toThrow("aborted");
		expect(sent).toHaveLength(count);
		await roundTrip();
	});
	test("send exceptions do not retain a pending slot", async () => {
		sendMode = "throw";
		for (let i = 0; i < 5; i++) await expect(rpc()).rejects.toThrow("test transport failed");
		sendMode = "ok";
		await roundTrip();
	});

	test("a dropped WebSocket send is rejected immediately instead of occupying a slot", async () => {
		sendMode = "drop";
		const started = performance.now();
		await expect(rpc()).rejects.toThrow("not accepted");
		expect(performance.now() - started).toBeLessThan(500);
		sendMode = "ok";
		await roundTrip();
	});

	test("a backpressured but accepted send remains pending until its result", async () => {
		sendMode = "backpressure";
		await roundTrip();
	});

	test("reports the methods and ages occupying the cap without exposing commands", async () => {
		const a = rpc("exec.start");
		const aid = lastId();
		const b = rpc("fs.stat");
		const bid = lastId();
		await expect(rpc()).rejects.toThrow("exec.start");
		const diag = await getDeviceConnectionDiagnostics(deviceId);
		expect(diag).toHaveProperty("rpc.shortLived", 2);
		expect(diag).toHaveProperty("rpc.maxConcurrent", 2);
		await result(aid);
		await result(bid);
		await Promise.all([a, b]);
	});
});
