import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ServerWebSocket } from "bun";
import { buildExecutorManifest } from "../../scripts/lib/executor-manifest";
import { db } from "../db";
import { remoteDevices } from "../db/schema";
import { resetExecutorManifestCache } from "../lib/executor-binaries";
import { generateId } from "../lib/id";
import { settings } from "../lib/settings";
import { BUILD_EXECUTOR_DISTRIBUTION } from "../lib/version";
import {
	getDeviceConnectionGeneration,
	handleDeviceWS,
	initDeviceConnectionService,
} from "../services/device-connection-service";
import { hashDeviceToken } from "../services/device-service";

/** Test-only real executor + authenticated WS. Never controls an installed user executor. */
export async function nativeEditorFixture(root: string, workspace: string) {
	initDeviceConnectionService();
	const binaryPath = resolve(
		import.meta.dir,
		`../../.narrafork/editor-phase8-executor${process.platform === "win32" ? ".exe" : ""}`,
	);
	const binary = await readFile(binaryPath);
	const platform =
		`${process.platform === "win32" ? "windows" : process.platform}-${process.arch === "x64" ? "amd64" : process.arch}` as "linux-amd64";
	const manifest = buildExecutorManifest({
		version: BUILD_EXECUTOR_DISTRIBUTION.version,
		protocolVersion: 1,
		releasedAt: new Date().toISOString(),
		artifacts: [{ platform, bytes: new Uint8Array(binary) }],
	});
	const deviceId = generateId(),
		token = `rdev_${generateId()}${generateId()}`,
		now = new Date().toISOString();
	db.insert(remoteDevices)
		.values({
			id: deviceId,
			name: "Native editor fixture",
			slug: deviceId,
			tokenHash: hashDeviceToken(token),
			tokenPrefix: "fixture",
			connectionMode: "reverse",
			status: "offline",
			scope: "global",
			createdBy: "native-fixture",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const originalUpdate = settings.update;
	let socket: Parameters<typeof handleDeviceWS.message>[0] | undefined;
	let child: Bun.Subprocess<"pipe", "pipe", "pipe"> | undefined;
	let childLogs = "";
	let dropNext = false,
		low = false,
		withoutRawRead = false,
		reads = 0,
		rawOpens = 0,
		rawChunks = 0,
		maxRawCredit = 0,
		applies = 0;
	const applyIds = new Set<string>();
	type Data = { adapter?: Parameters<typeof handleDeviceWS.message>[0] };
	function adapter(ws: ServerWebSocket<Data>) {
		if (ws.data.adapter) return ws.data.adapter;
		ws.data.adapter = {
			data: {
				channel: "device",
				connectedAt: Date.now(),
				lastPongAt: Date.now(),
				authenticated: false,
			},
			get readyState() {
				return ws.readyState;
			},
			getBufferedAmount: () => ws.getBufferedAmount(),
			send(data: string | Uint8Array) {
				if (typeof data === "string") {
					const frame = JSON.parse(data);
					if (frame.type === "rpc" && frame.method === "fs.read") reads++;
					if (frame.type === "rpc" && frame.method === "editor.read.open") rawOpens++;
					if (frame.type === "rpc" && frame.method === "editor.read.chunk") {
						rawChunks++;
						maxRawCredit = Math.max(maxRawCredit, frame.params.maxBytes);
					}
					if (frame.type === "rpc" && frame.method === "editor.apply") {
						applies++;
						applyIds.add(frame.id);
					}
				}
				return ws.send(data);
			},
			close: (code?: number, reason?: string) => ws.close(code, reason),
		} as Parameters<typeof handleDeviceWS.message>[0];
		return ws.data.adapter;
	}
	const server = Bun.serve<Data>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			const path = new URL(request.url).pathname;
			if (path === "/ws/device" && server.upgrade(request, { data: {} })) return;
			if (path === "/api/v2/tools/narrafork-executor-manifest.json") return Response.json(manifest);
			if (path.startsWith("/api/v2/tools/narrafork-executor-")) return new Response(binary);
			return new Response("not found", { status: 404 });
		},
		websocket: {
			open(ws) {
				socket = adapter(ws);
				handleDeviceWS.open(socket);
			},
			async message(ws, message) {
				const frame = JSON.parse(String(message));
				if (frame.type === "hello" && low)
					frame.capabilities.features = frame.capabilities.features.filter(
						(name: string) => name !== "editor.durable-write.v1",
					);
				if (frame.type === "hello" && withoutRawRead)
					frame.capabilities.features = frame.capabilities.features.filter(
						(name: string) => name !== "editor.raw-read.v1",
					);
				if (frame.type === "rpc_result" && applyIds.delete(frame.id) && dropNext) {
					dropNext = false;
					ws.close();
					return;
				}
				await handleDeviceWS.message(adapter(ws), frame);
			},
			close(ws) {
				handleDeviceWS.close(adapter(ws));
			},
		},
	});
	settings.update = {
		product: "narrafork",
		channel: "stable",
		checkIntervalMinutes: 60,
		autoDownload: false,
		...originalUpdate,
		source: "update-server",
		serverUrl: `http://127.0.0.1:${server.port}`,
		proxy: { mode: "direct" },
	};
	resetExecutorManifestCache();
	async function waitOnline(previous?: number) {
		const deadline = Date.now() + 15_000;
		for (;;) {
			const generation = getDeviceConnectionGeneration(deviceId);
			if (generation && generation !== previous) return generation;
			if (Date.now() > deadline || (child && child.exitCode !== null))
				throw new Error(`Native editor executor handshake failed: ${childLogs}`);
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
	}
	async function start() {
		await mkdir(join(root, "executor-home"), { recursive: true, mode: 0o700 });
		child = Bun.spawn(
			[
				binaryPath,
				"--server",
				`ws://127.0.0.1:${server.port}/ws/device`,
				"--device",
				deviceId,
				"--token-stdin",
				"--cwd",
				workspace,
				"--allow-root",
				workspace,
				"--disable-shell",
			],
			{
				cwd: workspace,
				stdin: "pipe",
				stdout: "pipe",
				stderr: "pipe",
				env: {
					PATH: process.env.PATH,
					LANG: "C.UTF-8",
					HOME: join(root, "executor-home"),
					XDG_CACHE_HOME: join(root, "executor-home", "cache"),
				},
			},
		);
		child.stdin.write(`${token}\n`);
		child.stdin.end();
		const owned = child;
		for (const stream of [owned.stdout, owned.stderr])
			void (async () => {
				const reader = stream.getReader();
				let total = 0;
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						total += chunk.value.length;
						if (total > 64 * 1024) {
							owned.kill();
							throw new Error("Native fixture log limit");
						}
						childLogs = (childLogs + new TextDecoder().decode(chunk.value)).slice(-4096);
					}
				} finally {
					reader.releaseLock();
				}
			})().catch(() => {});
		await waitOnline();
	}
	return {
		deviceId,
		distributionUrl: `http://127.0.0.1:${server.port}`,
		start,
		binarySha256: createHash("sha256").update(binary).digest("hex"),
		get applies() {
			return applies;
		},
		get reads() {
			return reads;
		},
		get rawOpens() {
			return rawOpens;
		},
		get rawChunks() {
			return rawChunks;
		},
		get maxRawCredit() {
			return maxRawCredit;
		},
		get logs() {
			return childLogs;
		},
		dropSuccess() {
			dropNext = true;
		},
		async reconnect(lowCapability = false, removeRawRead = false) {
			const old = getDeviceConnectionGeneration(deviceId) ?? undefined;
			low = lowCapability;
			withoutRawRead = removeRawRead;
			socket?.close();
			return waitOnline(old);
		},
		async restart() {
			const old = getDeviceConnectionGeneration(deviceId) ?? undefined;
			child?.kill();
			await child?.exited;
			await start();
			return waitOnline(old);
		},
		async dispose() {
			child?.kill();
			await child?.exited;
			socket?.close();
			await server.stop(true);
			settings.update = originalUpdate;
			resetExecutorManifestCache();
		},
	};
}
