import { afterEach, beforeEach, expect, test } from "bun:test";
import {
	WINDOWS_FIRST_CAPTURE_FEATURE,
	type WindowsFirstCaptureOriginSeed,
} from "@shared/windows-first-capture";
import golden from "@shared/windows-first-capture.golden.json";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import { DEVICE_PROTOCOL_VERSION, type RpcRequestFrame } from "../../lib/agent/execution/rpc-types";
import { generateId } from "../../lib/id";
import {
	getDeviceMetadataSession,
	handleDeviceWS,
	type SendRpcOptions,
	sendRpc,
	type WindowsFirstCapturePendingContext,
} from "../device-connection-service";
import { hashDeviceToken } from "../device-service";

type Socket = Parameters<typeof handleDeviceWS.message>[0];
let deviceId: string;
let socket: Socket;
let frames: Array<Omit<RpcRequestFrame, "type"> & { type: string }>;
let outstanding: Promise<unknown>[];
async function connect(feature = true) {
	const ws = {
		readyState: 1,
		data: {
			channel: "device",
			connectedAt: Date.now(),
			lastPongAt: Date.now(),
			authenticated: false,
		},
		send(data: string) {
			frames.push(JSON.parse(data));
			return data.length;
		},
		close() {},
	} as unknown as Socket;
	await handleDeviceWS.message(ws, {
		type: "hello",
		protocolVersion: DEVICE_PROTOCOL_VERSION,
		deviceRef: deviceId,
		token: "first-capture-lifecycle-test",
		agentVersion: "unit_test_not_native",
		platform: { os: "windows", arch: "amd64" },
		capabilities: { features: feature ? [WINDOWS_FIRST_CAPTURE_FEATURE] : [] },
	});
	return ws;
}
function seed(): WindowsFirstCaptureOriginSeed {
	const { outerRpcId: _id, ...origin } = JSON.parse(golden.preauth.canonicalPayload).origin;
	return {
		...origin,
		deviceId,
		...getDeviceMetadataSession(deviceId),
		version: 1,
		phase: "preauthorize",
	};
}
function start(
	options: Partial<SendRpcOptions["windowsFirstCapture"]> = {},
	control: SendRpcOptions = {},
) {
	const promise = sendRpc(
		deviceId,
		"history.metadataPreauthorize",
		{ version: 1, path: "C:\\工作区\\original.txt", nonce: "A".repeat(32) },
		{
			...control,
			windowsFirstCapture: {
				origin: seed(),
				async verifyResult() {
					throw new Error("Unit lifecycle verifier rejects all native completion claims");
				},
				...options,
			},
		},
	);
	outstanding.push(promise.catch(() => {}));
	return promise;
}
const lastRpc = () => {
	const frame = frames.filter((f) => f.type === "rpc").at(-1);
	if (!frame) throw new Error("missing unit-test RPC frame");
	return frame;
};
const reply = (id: string, result: unknown = 42, ws = socket) =>
	handleDeviceWS.message(ws, { type: "rpc_result", id, ok: true, result });
beforeEach(async () => {
	deviceId = generateId();
	frames = [];
	outstanding = [];
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id: deviceId,
		name: "First capture pending fixture",
		slug: deviceId,
		tokenHash: hashDeviceToken("first-capture-lifecycle-test"),
		tokenPrefix: "test",
		connectionMode: "reverse",
		status: "offline",
		scope: "global",
		createdBy: "rpc-test",
		createdAt: now,
		updatedAt: now,
	});
	socket = await connect();
});
afterEach(async () => {
	handleDeviceWS.close(socket);
	await Promise.all(outstanding);
	await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
});

test("origin is server-only, phase/method-scoped and actual pending owns outerRpcId", async () => {
	await expect(sendRpc(deviceId, "history.metadataPreauthorize", {})).rejects.toThrow(
		"server-only",
	);
	const legacy = sendRpc(
		deviceId,
		"fs.stat",
		{},
		{ windowsFirstCapture: { origin: seed(), async verifyResult() {} } },
	);
	await expect(legacy).rejects.toThrow("server-only");
	const wrongPhase = start({ origin: { ...seed(), phase: "capture" } });
	await expect(wrongPhase).rejects.toThrow("correlation");
	let pending: WindowsFirstCapturePendingContext | undefined;
	const promise = start({
		onAllocated(ctx) {
			pending = ctx;
		},
	});
	const frame = lastRpc();
	expect(frame.windowsFirstCaptureOrigin?.outerRpcId).toBe(frame.id);
	expect(frame.windowsFirstCaptureOrigin?.phase).toBe("preauthorize");
	expect(pending?.isPending()).toBe(true);
	expect("windowsFirstCaptureOrigin" in frame.params).toBe(false);
	await reply(frame.id);
	await expect(promise).rejects.toThrow("unproven");
	expect(pending?.isPending()).toBe(false);
});

test("authenticated executor's unsigned success never bypasses pending verifier", async () => {
	let checks = 0;
	const promise = start({
		async verifyResult(value) {
			checks++;
			expect(value).toEqual({ state: "captured" });
			throw new Error("not signed");
		},
	});
	await reply(lastRpc().id, { state: "captured" });
	await expect(promise).rejects.toThrow("unproven");
	expect(checks).toBe(1);
	expect(frames.filter((f) => f.type === "rpc_cancel")).toHaveLength(1);
});

test("duplicate result during async validation runs verifier exactly once", async () => {
	const gate = Promise.withResolvers<void>();
	let checks = 0;
	const promise = start({
		async verifyResult() {
			checks++;
			await gate.promise;
			throw new Error("not a native fixture");
		},
	});
	const id = lastRpc().id;
	await reply(id);
	await reply(id);
	expect(checks).toBe(1);
	gate.resolve();
	await expect(promise).rejects.toThrow("unproven");
	expect(frames.filter((f) => f.type === "rpc_cancel")).toHaveLength(1);
});

test("original timeout removes pending; late helper receipt does not invoke verifier", async () => {
	let checks = 0;
	const promise = start(
		{
			async verifyResult() {
				checks++;
				throw new Error("not accepted");
			},
		},
		{ timeoutMs: 5 },
	);
	const old = lastRpc().id;
	await expect(promise).rejects.toThrow("timed out");
	const replacement = start();
	expect(lastRpc().id).not.toBe(old);
	await reply(old, {
		version: 1,
		attestation: {
			version: 1,
			payload: Buffer.from(golden.capture.canonicalPayload).toString("base64url"),
			signature: golden.capture.signature,
		},
	});
	expect(checks).toBe(0);
	await reply(lastRpc().id);
	await expect(replacement).rejects.toThrow("unproven");
});

test("abort while verifying invalidates old context and cannot complete replacement", async () => {
	const controller = new AbortController();
	const gate = Promise.withResolvers<void>();
	let pending: WindowsFirstCapturePendingContext | undefined;
	const promise = start(
		{
			onAllocated(ctx) {
				pending = ctx;
			},
			async verifyResult() {
				await gate.promise;
				return "unit lifecycle result only";
			},
		},
		{ signal: controller.signal },
	);
	const id = lastRpc().id;
	await reply(id);
	controller.abort();
	await expect(promise).rejects.toThrow("aborted");
	expect(pending?.isPending()).toBe(false);
	const replacement = start();
	gate.resolve();
	await reply(id);
	await reply(lastRpc().id);
	await expect(replacement).rejects.toThrow("unproven");
});

test("reconnect with same outer id cannot borrow old socket/pending/context", async () => {
	let checks = 0;
	const promise = start({
		async verifyResult() {
			checks++;
			throw new Error("not accepted");
		},
	});
	const oldSocket = socket;
	const old = lastRpc().id;
	socket = await connect();
	await expect(promise).rejects.toThrow("connection");
	const replacement = start({
		async verifyResult() {
			checks++;
			throw new Error("not accepted");
		},
	});
	expect(lastRpc().id).toBe(old);
	await reply(old, 42, oldSocket);
	expect(checks).toBe(0);
	await reply(old);
	await expect(replacement).rejects.toThrow("unproven");
	expect(checks).toBe(1);
});

test("old executor without protocol feature rejects before any first-capture dispatch", async () => {
	socket = await connect(false);
	const before = frames.filter((f) => f.type === "rpc").length;
	await expect(start()).rejects.toThrow("protocol/session");
	expect(frames.filter((f) => f.type === "rpc").length).toBe(before);
});
