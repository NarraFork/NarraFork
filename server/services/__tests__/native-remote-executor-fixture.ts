import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { RemoteHistoryReceipt } from "@shared/remote-history-protocol";
import type { ServerWebSocket } from "bun";
import { testEnvironment } from "../../../tests/preload";
import { resolveBackend } from "../../lib/agent/execution/registry";
import type { DeviceHelloFrame } from "../../lib/agent/execution/rpc-types";
import {
	type DeviceWSData,
	handleDeviceWS,
	initDeviceConnectionService,
} from "../device-connection-service";

const OUTPUT_BYTES = 65_536;
const WS_FRAME_BYTES = 256 * 1024;
const WS_TOTAL_BYTES = 16 * 1024 * 1024;
type DeviceSocket = ServerWebSocket<DeviceWSData & { channel: "device" }>;

/** Only owns the processes it spawns; never kills a server, process group or installed executor. */
export async function boundedFixtureCommand(
	command: string[],
	options: { cwd?: string; env?: Record<string, string | undefined>; timeoutMs?: number } = {},
) {
	const child = Bun.spawn(command, {
		cwd: options.cwd,
		env: options.env,
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});
	let timeout = false;
	const timer = setTimeout(() => {
		timeout = true;
		child.kill();
	}, options.timeoutMs ?? 5_000);
	async function collect(stream: ReadableStream<Uint8Array>) {
		const chunks: Uint8Array[] = [];
		let bytes = 0;
		for await (const chunk of stream) {
			bytes += chunk.byteLength;
			if (bytes > OUTPUT_BYTES) {
				child.kill();
				throw new Error("Native fixture child exceeded bounded output");
			}
			chunks.push(chunk);
		}
		return Buffer.concat(chunks).toString();
	}
	try {
		const [stdout, stderr, code] = await Promise.all([
			collect(child.stdout),
			collect(child.stderr),
			child.exited,
		]);
		if (timeout || code !== 0)
			throw new Error(
				`Native fixture command failed (${code}, timeout=${timeout}): ${stderr.slice(0, 4096)}`,
			);
		return { stdout, stderr };
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill();
	}
}

export interface NativeRpcTrace {
	id: string;
	method: string;
	operationId?: string;
	root?: string;
}

/** Official Go cmd, official reverse transport, official authenticated server RPC dispatcher. */
export async function startNativeRemoteExecutorFixture(options: {
	directory: string;
	root: string;
	deviceId: string;
	token: string;
}) {
	const moduleDirectory = fileURLToPath(new URL("../../../remote-executor", import.meta.url));
	const binary = join(
		options.directory,
		process.platform === "win32" ? "executor-fixture.exe" : "executor-fixture",
	);
	// Test preload changes HOME. Reuse only the installed compiler/module caches, not runtime state.
	const originalEnv = { ...process.env, HOME: testEnvironment.originalHome, GOTOOLCHAIN: "local" };
	const goEnv = await boundedFixtureCommand(["go", "env", "-json", "GOCACHE", "GOMODCACHE"], {
		env: originalEnv,
	});
	const cache = JSON.parse(goEnv.stdout) as { GOCACHE: string; GOMODCACHE: string };
	await boundedFixtureCommand(["go", "build", "-o", binary, "./cmd/narrafork-executor"], {
		cwd: resolve(moduleDirectory),
		env: {
			...process.env,
			GOCACHE: cache.GOCACHE,
			GOMODCACHE: cache.GOMODCACHE,
			GOTOOLCHAIN: "local",
		},
		timeoutMs: 35_000,
	});

	initDeviceConnectionService();
	const trace: NativeRpcTrace[] = [];
	const rpcErrors: { id: string; method?: string; message: string }[] = [];
	const sockets = new Map<DeviceSocket, DeviceSocket>();
	const outstanding = new Set<Promise<void>>();
	let hello: DeviceHelloFrame | undefined;
	let socket: DeviceSocket | undefined;
	let dropped: RemoteHistoryReceipt | undefined;
	let dropMutation = false;
	let hideHistory = false;
	let receivedBytes = 0;
	let failure: Error | undefined;
	let readyResolve: (() => void) | undefined;
	let ready = new Promise<void>((resolveReady) => {
		readyResolve = resolveReady;
	});
	const server = Bun.serve<DeviceWSData & { channel: "device" }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, instance) {
			if (new URL(request.url).pathname !== "/ws/device")
				return new Response("fixture only", { status: 404 });
			if (
				instance.upgrade(request, {
					data: {
						channel: "device",
						authenticated: false,
						connectedAt: Date.now(),
						lastPongAt: Date.now(),
					},
				})
			)
				return;
			return new Response("upgrade required", { status: 426 });
		},
		websocket: {
			maxPayloadLength: WS_FRAME_BYTES,
			backpressureLimit: WS_FRAME_BYTES,
			closeOnBackpressureLimit: true,
			open(ws) {
				socket = ws;
				// Instrument only real wire sends. No RPC results or backend methods are fabricated.
				const facade = {
					data: ws.data,
					get readyState() {
						return ws.readyState;
					},
					send(data: string | Uint8Array) {
						if (typeof data === "string") {
							if (Buffer.byteLength(data) > WS_FRAME_BYTES)
								throw new Error("Fixture outgoing frame budget");
							const frame = JSON.parse(data) as {
								type?: string;
								id: string;
								method: string;
								params?: { operationId?: string; root?: string; binding?: { root?: string } };
							};
							if (frame.type === "rpc") {
								if (trace.length >= 2048) throw new Error("Fixture RPC trace budget");
								trace.push({
									id: frame.id,
									method: frame.method,
									operationId: frame.params?.operationId,
									root: frame.params?.binding?.root ?? frame.params?.root,
								});
							}
						}
						return ws.send(data);
					},
					getBufferedAmount: () => ws.getBufferedAmount(),
					close: (code?: number, reason?: string) => ws.close(code, reason),
				} as unknown as DeviceSocket;
				sockets.set(ws, facade);
				handleDeviceWS.open(facade);
			},
			message(ws, data) {
				const facade = sockets.get(ws);
				if (!facade) throw new Error("Unregistered fixture socket");
				const bytes = typeof data === "string" ? Buffer.byteLength(data) : data.byteLength;
				receivedBytes += bytes;
				if (bytes > WS_FRAME_BYTES || receivedBytes > WS_TOTAL_BYTES) {
					failure = new Error("Native fixture WS byte budget");
					ws.close(1009, "fixture byte budget");
					return;
				}
				const run = async () => {
					if (typeof data !== "string") return handleDeviceWS.binaryMessage(facade, data);
					const frame = JSON.parse(data);
					if (frame.type === "hello") {
						if (hideHistory)
							frame.capabilities.features = (frame.capabilities.features ?? []).filter(
								(feature: string) => !feature.startsWith("history."),
							);
						hello = frame;
					}
					if (
						dropMutation &&
						frame.type === "rpc_result" &&
						frame.ok &&
						frame.result?.kind === "mutate" &&
						frame.result.state === "settled"
					) {
						dropMutation = false;
						dropped = frame.result;
						return; // Simulate loss AFTER Go's real durable mutation, never an echoed fake write.
					}
					if (frame.type === "rpc_result" && !frame.ok) {
						if (rpcErrors.length >= 32) throw new Error("Fixture RPC error trace budget");
						const request = trace.findLast((entry) => entry.id === frame.id);
						rpcErrors.push({
							id: frame.id,
							method: request?.method,
							message: String(frame.error?.message ?? frame.error ?? "unknown native error").slice(
								0,
								1024,
							),
						});
					}
					await handleDeviceWS.message(facade, frame);
					if (frame.type === "hello" && facade.data.authenticated) readyResolve?.();
				};
				const task = run().catch((error) => {
					failure = error instanceof Error ? error : new Error(String(error));
					ws.close(1011, "fixture handler failure");
				});
				outstanding.add(task);
				void task.finally(() => outstanding.delete(task));
			},
			close(ws) {
				const facade = sockets.get(ws);
				if (facade) handleDeviceWS.close(facade);
				sockets.delete(ws);
			},
		},
	});
	const executorEnv = { ...process.env };
	for (const key of Object.keys(executorEnv)) {
		if (key.startsWith("NARRAFORK_EXECUTOR_")) delete executorEnv[key];
	}
	const spawnChild = () =>
		Bun.spawn(
			[
				binary,
				"--server",
				`ws://127.0.0.1:${server.port}/ws/device`,
				"--device",
				options.deviceId,
				"--token-stdin",
				"--allow-root",
				options.root,
				"--cwd",
				options.root,
				"--state-dir",
				join(options.directory, "executor-private"),
				"--disable-shell",
			],
			{
				cwd: options.directory,
				env: executorEnv,
				stdin: new Blob([`${options.token}\n`]),
				stdout: "pipe",
				stderr: "pipe",
			},
		);
	let child = spawnChild();
	let childLog = "";
	async function collectLog(stream: ReadableStream<Uint8Array>) {
		for await (const chunk of stream) {
			if (Buffer.byteLength(childLog) + chunk.byteLength > OUTPUT_BYTES) {
				failure = new Error("Native executor output budget");
				child.kill();
				return;
			}
			childLog += Buffer.from(chunk).toString();
		}
	}
	let logs = Promise.all([collectLog(child.stdout), collectLog(child.stderr)]);
	const watchdog = setTimeout(() => {
		failure = new Error("Native executor fixture lifetime exceeded 50s");
		child.kill();
	}, 50_000);
	async function waitReady() {
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				ready,
				child.exited.then((code) => {
					throw new Error(`Native executor exited (${code}): ${childLog.slice(-4096)}`);
				}),
				new Promise<never>((_, reject) => {
					timer = setTimeout(
						() => reject(new Error(`Native handshake timeout: ${childLog.slice(-4096)}`)),
						10_000,
					);
				}),
			]);
			if (failure) throw failure;
		} finally {
			if (timer) clearTimeout(timer);
		}
	}
	async function dispose() {
		clearTimeout(watchdog);
		if (child.exitCode === null) child.kill();
		server.stop(true);
		await Promise.allSettled([...outstanding, child.exited, logs]);
	}
	try {
		await waitReady();
	} catch (error) {
		await dispose();
		throw error;
	}
	return {
		backend: resolveBackend({ requested: options.deviceId }),
		trace,
		rpcErrors,
		get hello() {
			return hello;
		},
		get droppedReceipt() {
			return dropped;
		},
		get logs() {
			return childLog;
		},
		assertHealthy() {
			if (failure) throw failure;
		},
		dropNextMutationReply() {
			dropped = undefined;
			dropMutation = true;
		},
		async restartFixtureChild() {
			if (failure) throw failure;
			// Exactly one managed fixture slot. Keep the same private journal and the ORIGINAL lifetime watchdog.
			if (child.exitCode === null) child.kill();
			await Promise.allSettled([child.exited, logs, ...outstanding]);
			ready = new Promise<void>((resolveReady) => {
				readyResolve = resolveReady;
			});
			child = spawnChild();
			logs = Promise.all([collectLog(child.stdout), collectLog(child.stderr)]);
			await waitReady();
			return resolveBackend({ requested: options.deviceId });
		},
		async advertiseLegacyHistory() {
			hideHistory = true;
			ready = new Promise<void>((resolveReady) => {
				readyResolve = resolveReady;
			});
			socket?.close(1000, "fixture capability downgrade");
			await waitReady();
			return resolveBackend({ requested: options.deviceId });
		},
		dispose,
	};
}
