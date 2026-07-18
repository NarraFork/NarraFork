import { afterEach, describe, expect, test } from "bun:test";
import { eq } from "drizzle-orm";
import { db } from "../../db";
import { remoteDevices } from "../../db/schema";
import {
	createDeviceAuthProof,
	DEVICE_AUTH_VERSION,
	deviceAuthKeyFromTokenHash,
	generateDeviceAuthNonce,
	verifyDeviceAuthProof,
} from "../../lib/agent/execution/device-auth";
import {
	DEVICE_PROTOCOL_VERSION,
	type DeviceAuthChallengeFrame,
	type DeviceAuthInitFrame,
	FS_READ_ATOMIC_RESOLVED_PATH_FEATURE,
	FS_STAT_RESOLVED_PATH_FEATURE,
} from "../../lib/agent/execution/rpc-types";
import { generateId } from "../../lib/id";
import {
	getDeviceConnectionDiagnostics,
	getDeviceConnectionGeneration,
	isDeviceOnline,
	sendRpc,
	startDirectDial,
	stopDirectDial,
	testDeviceConnection,
} from "../device-connection-service";
import { createRemoteBackend } from "../device-remote-backend";
import { hashDeviceToken } from "../device-service";

interface CloseInfo {
	code: number;
	reason: string;
}

interface Deferred<T> {
	promise: Promise<T>;
	resolve: (value: T) => void;
	reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
	let resolve!: (value: T) => void;
	let reject!: (error: unknown) => void;
	const promise = new Promise<T>((res, rej) => {
		resolve = res;
		reject = rej;
	});
	return { promise, resolve, reject };
}

async function waitFor<T>(promise: Promise<T>, label: string, timeoutMs = 5_000): Promise<T> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise,
			new Promise<never>((_, reject) => {
				timer = setTimeout(() => reject(new Error(`Timed out waiting for ${label}`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}

const createdDeviceIds: string[] = [];
const testServers: Array<ReturnType<typeof Bun.serve>> = [];

async function insertDirectDevice(input: {
	deviceId: string;
	deviceRef: string;
	token: string;
	directUrl: string;
}): Promise<void> {
	const now = new Date().toISOString();
	await db.insert(remoteDevices).values({
		id: input.deviceId,
		name: `Test ${input.deviceRef}`,
		slug: input.deviceRef,
		tokenHash: hashDeviceToken(input.token),
		tokenPrefix: input.token.slice(0, 9),
		connectionMode: "direct",
		directUrl: input.directUrl,
		status: "offline",
		scope: "global",
		createdBy: "device-auth-test",
		createdAt: now,
		updatedAt: now,
	});
	createdDeviceIds.push(input.deviceId);
}

function decodeText(message: string | Buffer): string {
	return typeof message === "string" ? message : message.toString("utf8");
}

function startFakeExecutor(handlers: {
	onOpen: (ws: {
		send(data: string | Uint8Array): number;
		close(code?: number, reason?: string): void;
	}) => void;
	onFrame?: (
		ws: { send(data: string | Uint8Array): number; close(code?: number, reason?: string): void },
		frame: Record<string, unknown>,
	) => void;
	onClose?: (info: CloseInfo) => void;
}) {
	const server = Bun.serve<{ test: true }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, bunServer) {
			if (bunServer.upgrade(request, { data: { test: true } })) return;
			return new Response("WebSocket upgrade required", { status: 426 });
		},
		websocket: {
			open(ws) {
				handlers.onOpen(ws);
			},
			message(ws, message) {
				if (typeof message !== "string" && !(message instanceof Buffer)) return;
				try {
					const frame = JSON.parse(decodeText(message)) as Record<string, unknown>;
					handlers.onFrame?.(ws, frame);
				} catch {
					ws.close(1002, "invalid test frame");
				}
			},
			close(_ws, code, reason) {
				handlers.onClose?.({ code, reason });
			},
		},
	});
	testServers.push(server);
	return { server, url: `ws://127.0.0.1:${server.port}/ws/device` };
}

function startAuthenticatedFakeExecutor(options: {
	token: string;
	deviceRef: string;
	capabilities?: Record<string, unknown>;
	platform?: { os: string; arch: string };
	defaultCwd?: string;
	onRpc?: (
		ws: { send(data: string | Uint8Array): number; close(code?: number, reason?: string): void },
		frame: Record<string, unknown>,
	) => void;
}) {
	const ready = deferred<void>();
	const executorNonce = generateDeviceAuthNonce();
	const key = deviceAuthKeyFromTokenHash(hashDeviceToken(options.token));
	if (!key) throw new Error("invalid test auth key");
	let acknowledged = false;
	const fake = startFakeExecutor({
		onOpen(ws) {
			ws.send(
				JSON.stringify({
					type: "auth_init",
					authVersion: DEVICE_AUTH_VERSION,
					deviceRef: options.deviceRef,
					executorNonce,
				}),
			);
		},
		onFrame(ws, frame) {
			if (frame.type === "auth_challenge") {
				const challenge = frame as unknown as DeviceAuthChallengeFrame;
				const proof = createDeviceAuthProof(key, {
					authVersion: DEVICE_AUTH_VERSION,
					deviceRef: options.deviceRef,
					executorNonce,
					serverNonce: challenge.serverNonce,
					role: "executor",
				});
				ws.send(
					JSON.stringify({
						type: "auth_proof",
						authVersion: DEVICE_AUTH_VERSION,
						deviceRef: options.deviceRef,
						executorNonce,
						serverNonce: challenge.serverNonce,
						proof,
					}),
				);
				ws.send(
					JSON.stringify({
						type: "hello",
						protocolVersion: DEVICE_PROTOCOL_VERSION,
						deviceRef: options.deviceRef,
						agentVersion: "test-executor",
						platform: options.platform ?? { os: "linux", arch: "x64" },
						defaultCwd: options.defaultCwd ?? "/remote/work",
						capabilities: options.capabilities ?? { git: true, ripgrep: true, pty: false },
					}),
				);
				return;
			}
			if (frame.type === "hello_ack") {
				if (frame.ok === true) {
					acknowledged = true;
					ready.resolve();
				} else {
					ready.reject(new Error(String(frame.error ?? "hello rejected")));
				}
				return;
			}
			if (frame.type === "rpc") options.onRpc?.(ws, frame);
		},
		onClose(info) {
			if (!acknowledged) {
				ready.reject(new Error(`connection closed during handshake: ${info.code} ${info.reason}`));
			}
		},
	});
	return { ...fake, ready: ready.promise };
}

afterEach(async () => {
	for (const deviceId of createdDeviceIds) stopDirectDial(deviceId);
	for (const server of testServers.splice(0)) server.stop(true);
	await new Promise((resolve) => setTimeout(resolve, 10));
	for (const deviceId of createdDeviceIds.splice(0)) {
		await db.delete(remoteDevices).where(eq(remoteDevices.id, deviceId));
	}
});

describe("direct device mutual authentication", () => {
	test("completes nonce/HMAC authentication before registering RPC", async () => {
		const token = "rdev_ts_direct_success";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const executorNonce = generateDeviceAuthNonce();
		const handshake = deferred<void>();
		let challengeVerified = false;
		let helloAckReceived = false;
		let rpcObservedBeforeAck = false;
		const key = deviceAuthKeyFromTokenHash(hashDeviceToken(token));
		if (!key) throw new Error("invalid test auth key");

		const fake = startFakeExecutor({
			onOpen(ws) {
				const init: DeviceAuthInitFrame = {
					type: "auth_init",
					authVersion: DEVICE_AUTH_VERSION,
					deviceRef,
					executorNonce,
				};
				ws.send(JSON.stringify(init));
			},
			onFrame(ws, frame) {
				if (frame.type === "auth_challenge") {
					const challenge = frame as unknown as DeviceAuthChallengeFrame;
					expect(challenge.deviceRef).toBe(deviceRef);
					expect(challenge.executorNonce).toBe(executorNonce);
					expect(frame).not.toHaveProperty("token");
					challengeVerified = verifyDeviceAuthProof(
						key,
						{
							authVersion: DEVICE_AUTH_VERSION,
							deviceRef,
							executorNonce,
							serverNonce: challenge.serverNonce,
							role: "server",
						},
						challenge.proof,
					);
					expect(challengeVerified).toBe(true);
					const proof = createDeviceAuthProof(key, {
						authVersion: DEVICE_AUTH_VERSION,
						deviceRef,
						executorNonce,
						serverNonce: challenge.serverNonce,
						role: "executor",
					});
					ws.send(
						JSON.stringify({
							type: "auth_proof",
							authVersion: DEVICE_AUTH_VERSION,
							deviceRef,
							executorNonce,
							serverNonce: challenge.serverNonce,
							proof,
						}),
					);
					ws.send(
						JSON.stringify({
							type: "hello",
							protocolVersion: DEVICE_PROTOCOL_VERSION,
							deviceRef,
							agentVersion: "test-executor",
							platform: { os: "linux", arch: "x64" },
							defaultCwd: "/remote/work",
							capabilities: { git: true, ripgrep: true, pty: true },
						}),
					);
					return;
				}
				if (frame.type === "hello_ack") {
					expect(frame.ok).toBe(true);
					helloAckReceived = true;
					handshake.resolve();
					return;
				}
				if (frame.type === "rpc") {
					if (!helloAckReceived) rpcObservedBeforeAck = true;
					ws.send(
						JSON.stringify({
							type: "rpc_result",
							id: frame.id,
							ok: true,
							result: frame.method === "system.ping" ? { ok: true } : { exists: true },
						}),
					);
				}
			},
			onClose(info) {
				handshake.reject(
					new Error(`connection closed during handshake: ${info.code} ${info.reason}`),
				);
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: fake.url });

		startDirectDial(deviceId, fake.url);
		await waitFor(handshake.promise, "direct handshake");
		expect(challengeVerified).toBe(true);
		expect(isDeviceOnline(deviceId)).toBe(true);
		const diagnostics = await getDeviceConnectionDiagnostics(deviceId);
		expect(diagnostics?.stage).toBe("ready");
		expect(diagnostics?.defaultCwd).toBe("/remote/work");
		expect(diagnostics?.agentVersion).toBe("test-executor");
		const connectionTest = await testDeviceConnection(deviceId);
		expect(connectionTest?.ok).toBe(true);
		expect(connectionTest?.stage).toBe("rpc_ready");
		const result = (await sendRpc(deviceId, "fs.exists", { path: "/remote/work/file" })) as {
			exists: boolean;
		};
		expect(result.exists).toBe(true);
		expect(rpcObservedBeforeAck).toBe(false);
	});

	test("rejects a wrong executor proof before hello registration", async () => {
		const token = "rdev_ts_direct_good";
		const wrongToken = "rdev_ts_direct_wrong";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const executorNonce = generateDeviceAuthNonce();
		const closed = deferred<CloseInfo>();
		const wrongKey = deviceAuthKeyFromTokenHash(hashDeviceToken(wrongToken));
		if (!wrongKey) throw new Error("invalid wrong test key");

		const fake = startFakeExecutor({
			onOpen(ws) {
				ws.send(
					JSON.stringify({
						type: "auth_init",
						authVersion: DEVICE_AUTH_VERSION,
						deviceRef,
						executorNonce,
					}),
				);
			},
			onFrame(ws, frame) {
				if (frame.type !== "auth_challenge") return;
				const challenge = frame as unknown as DeviceAuthChallengeFrame;
				const badProof = createDeviceAuthProof(wrongKey, {
					authVersion: DEVICE_AUTH_VERSION,
					deviceRef,
					executorNonce,
					serverNonce: challenge.serverNonce,
					role: "executor",
				});
				ws.send(
					JSON.stringify({
						type: "auth_proof",
						authVersion: DEVICE_AUTH_VERSION,
						deviceRef,
						executorNonce,
						serverNonce: challenge.serverNonce,
						proof: badProof,
					}),
				);
			},
			onClose(info) {
				closed.resolve(info);
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: fake.url });

		startDirectDial(deviceId, fake.url);
		const info = await waitFor(closed.promise, "wrong-proof rejection");
		expect(info.code).toBe(1008);
		expect(isDeviceOnline(deviceId)).toBe(false);
	});

	for (const preAuthFrame of ["rpc", "rpc_cancel", "rpc_result", "rpc_stream"] as const) {
		test(`rejects ${preAuthFrame} before authentication`, async () => {
			const token = `rdev_ts_${preAuthFrame}`;
			const deviceId = generateId();
			const deviceRef = `direct-${deviceId.slice(0, 8)}`;
			const closed = deferred<CloseInfo>();
			const fake = startFakeExecutor({
				onOpen(ws) {
					ws.send(JSON.stringify({ type: preAuthFrame, id: "unauthenticated" }));
				},
				onClose(info) {
					closed.resolve(info);
				},
			});
			await insertDirectDevice({ deviceId, deviceRef, token, directUrl: fake.url });

			startDirectDial(deviceId, fake.url);
			const info = await waitFor(closed.promise, `${preAuthFrame} rejection`);
			expect(info.code).toBe(1008);
			expect(isDeviceOnline(deviceId)).toBe(false);
		});
	}

	test("rejects binary transfer data before authentication", async () => {
		const token = "rdev_ts_binary_preauth";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const closed = deferred<CloseInfo>();
		const fake = startFakeExecutor({
			onOpen(ws) {
				ws.send(new Uint8Array([0x4e, 0x01, 0x00, 0x00]));
			},
			onClose(info) {
				closed.resolve(info);
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: fake.url });

		startDirectDial(deviceId, fake.url);
		const info = await waitFor(closed.promise, "binary pre-auth rejection");
		expect(info.code).toBe(1008);
		expect(isDeviceOnline(deviceId)).toBe(false);
	});
});

describe("remote backend connection binding", () => {
	const safeFeatures = [FS_STAT_RESOLVED_PATH_FEATURE, FS_READ_ATOMIC_RESOLVED_PATH_FEATURE];

	test("fails closed when a stat-bound backend reconnects to a legacy executor", async () => {
		const token = "rdev_ts_generation_downgrade";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const planPath = "/remote/work/plan.md";
		const upgraded = startAuthenticatedFakeExecutor({
			token,
			deviceRef,
			capabilities: { git: true, ripgrep: true, pty: false, features: safeFeatures },
			onRpc(ws, frame) {
				if (frame.method !== "fs.stat") return;
				ws.send(
					JSON.stringify({
						type: "rpc_result",
						id: frame.id,
						ok: true,
						result: {
							exists: true,
							isDirectory: false,
							isFile: true,
							size: 6,
							resolvedPath: planPath,
						},
					}),
				);
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: upgraded.url });
		startDirectDial(deviceId, upgraded.url);
		await waitFor(upgraded.ready, "upgraded executor handshake");
		const upgradedGeneration = getDeviceConnectionGeneration(deviceId);
		if (upgradedGeneration === null) throw new Error("missing upgraded connection generation");
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: upgradedGeneration,
			platform: { os: "linux", arch: "x64" },
			defaultCwd: "/remote/work",
			supportsFsStatResolvedPath: true,
			supportsFsReadAtomicResolvedPath: true,
		});
		expect((await backend.statFile(planPath))?.resolvedPath).toBe(planPath);

		let legacyReadCount = 0;
		const legacy = startAuthenticatedFakeExecutor({
			token,
			deviceRef,
			capabilities: { git: true, ripgrep: true, pty: false },
			onRpc(ws, frame) {
				if (frame.method !== "fs.read") return;
				legacyReadCount++;
				ws.send(
					JSON.stringify({
						type: "rpc_result",
						id: frame.id,
						ok: true,
						result: {
							dataB64: Buffer.from("legacy").toString("base64"),
							truncated: false,
							totalSize: 6,
						},
					}),
				);
			},
		});
		startDirectDial(deviceId, legacy.url);
		await waitFor(legacy.ready, "legacy executor handshake");
		const legacyGeneration = getDeviceConnectionGeneration(deviceId);
		if (legacyGeneration === null) throw new Error("missing legacy connection generation");
		expect(legacyGeneration).not.toBe(upgradedGeneration);

		await expect(
			backend.readFileBytes(planPath, {
				maxBytes: 1024,
				expectedResolvedPath: planPath,
			}),
		).rejects.toThrow(/connection changed/i);
		const downgradedBackend = createRemoteBackend(deviceId, {
			connectionGeneration: legacyGeneration,
			platform: { os: "linux", arch: "x64" },
			defaultCwd: "/remote/work",
			supportsFsStatResolvedPath: false,
			supportsFsReadAtomicResolvedPath: false,
		});
		await expect(
			downgradedBackend.readFileBytes(planPath, {
				maxBytes: 1024,
				expectedResolvedPath: planPath,
			}),
		).rejects.toThrow(/does not support atomic/i);
		expect(legacyReadCount).toBe(0);
	});

	test("keeps POSIX backslashes distinct in remote canonical identity", async () => {
		const token = "rdev_ts_linux_backslash_identity";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const canonicalPath = "/remote/work/a\\b";
		const separatorPath = "/remote/work/a/b";
		const executor = startAuthenticatedFakeExecutor({
			token,
			deviceRef,
			capabilities: { git: true, ripgrep: true, pty: false, features: safeFeatures },
			onRpc(ws, frame) {
				if (frame.method === "fs.stat") {
					ws.send(
						JSON.stringify({
							type: "rpc_result",
							id: frame.id,
							ok: true,
							result: {
								exists: true,
								isDirectory: false,
								isFile: true,
								size: 7,
								resolvedPath: canonicalPath,
							},
						}),
					);
				} else if (frame.method === "fs.read") {
					ws.send(
						JSON.stringify({
							type: "rpc_result",
							id: frame.id,
							ok: true,
							result: {
								dataB64: Buffer.from("unsafe").toString("base64"),
								truncated: false,
								totalSize: 6,
								resolvedPath: separatorPath,
							},
						}),
					);
				}
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: executor.url });
		startDirectDial(deviceId, executor.url);
		await waitFor(executor.ready, "linux path executor handshake");
		const generation = getDeviceConnectionGeneration(deviceId);
		if (generation === null) throw new Error("missing connection generation");
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: generation,
			platform: { os: "linux", arch: "x64" },
			defaultCwd: "/remote/work",
			supportsFsStatResolvedPath: true,
			supportsFsReadAtomicResolvedPath: true,
		});
		const fileStat = await backend.statFile(canonicalPath);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical stat path");
		expect(fileStat.resolvedPath).toBe(canonicalPath);

		await expect(
			backend.readFileBytes(canonicalPath, {
				maxBytes: 1024,
				expectedResolvedPath: fileStat.resolvedPath,
			}),
		).rejects.toThrow(/resolved path mismatch/i);
	});

	test("accepts Windows slash and case variants in remote canonical identity", async () => {
		const token = "rdev_ts_windows_path_identity";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const canonicalPath = "C:\\Work\\Plan.md";
		const responsePath = "c:/work/plan.md";
		const executor = startAuthenticatedFakeExecutor({
			token,
			deviceRef,
			platform: { os: "windows", arch: "x64" },
			defaultCwd: "C:\\Work",
			capabilities: { git: true, ripgrep: true, pty: false, features: safeFeatures },
			onRpc(ws, frame) {
				const result =
					frame.method === "fs.stat"
						? {
								exists: true,
								isDirectory: false,
								isFile: true,
								size: 7,
								resolvedPath: canonicalPath,
							}
						: {
								dataB64: Buffer.from("windows").toString("base64"),
								truncated: false,
								totalSize: 7,
								resolvedPath: responsePath,
							};
				ws.send(JSON.stringify({ type: "rpc_result", id: frame.id, ok: true, result }));
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: executor.url });
		startDirectDial(deviceId, executor.url);
		await waitFor(executor.ready, "windows path executor handshake");
		const generation = getDeviceConnectionGeneration(deviceId);
		if (generation === null) throw new Error("missing connection generation");
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: generation,
			platform: { os: "windows", arch: "x64" },
			defaultCwd: "C:\\Work",
			supportsFsStatResolvedPath: true,
			supportsFsReadAtomicResolvedPath: true,
		});
		const fileStat = await backend.statFile(canonicalPath);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical stat path");
		const result = await backend.readFileBytes(canonicalPath, {
			maxBytes: 1024,
			expectedResolvedPath: fileStat.resolvedPath,
		});
		expect(new TextDecoder().decode(result.bytes)).toBe("windows");
		expect(result.resolvedPath).toBe(responsePath);
	});

	test("rejects an fs.read response whose canonical path mismatches", async () => {
		const token = "rdev_ts_response_path_mismatch";
		const deviceId = generateId();
		const deviceRef = `direct-${deviceId.slice(0, 8)}`;
		const planPath = "/remote/work/plan.md";
		const executor = startAuthenticatedFakeExecutor({
			token,
			deviceRef,
			capabilities: { git: true, ripgrep: true, pty: false, features: safeFeatures },
			onRpc(ws, frame) {
				const result =
					frame.method === "fs.stat"
						? {
								exists: true,
								isDirectory: false,
								isFile: true,
								size: 6,
								resolvedPath: planPath,
							}
						: {
								dataB64: Buffer.from("unsafe").toString("base64"),
								truncated: false,
								totalSize: 6,
								resolvedPath: "/remote/work/other.md",
							};
				ws.send(JSON.stringify({ type: "rpc_result", id: frame.id, ok: true, result }));
			},
		});
		await insertDirectDevice({ deviceId, deviceRef, token, directUrl: executor.url });
		startDirectDial(deviceId, executor.url);
		await waitFor(executor.ready, "path-mismatch executor handshake");
		const generation = getDeviceConnectionGeneration(deviceId);
		if (generation === null) throw new Error("missing connection generation");
		const backend = createRemoteBackend(deviceId, {
			connectionGeneration: generation,
			platform: { os: "linux", arch: "x64" },
			defaultCwd: "/remote/work",
			supportsFsStatResolvedPath: true,
			supportsFsReadAtomicResolvedPath: true,
		});
		const fileStat = await backend.statFile(planPath);
		if (!fileStat?.resolvedPath) throw new Error("missing canonical stat path");

		await expect(
			backend.readFileBytes(planPath, {
				maxBytes: 1024,
				expectedResolvedPath: fileStat.resolvedPath,
			}),
		).rejects.toThrow(/resolved path mismatch/i);
	});
});
