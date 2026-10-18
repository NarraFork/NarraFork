import { expect, spyOn, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readlink, rm, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Hono } from "hono";
import { testEnvironment } from "../../tests/preload";
import { db } from "../db";
import { narrators, remoteDevices, users } from "../db/schema";
import { generateId } from "../lib/id";
import { safeSpawn } from "../lib/spawn";
import {
	type DeviceWSData,
	disconnectDevice,
	getConnectedDeviceHello,
	getDeviceConnectionGeneration,
	handleDeviceWS,
	initDeviceConnectionService,
	isDeviceOnline,
} from "../services/device-connection-service";
import { RemoteBackend } from "../services/device-remote-backend";
import { hashDeviceToken } from "../services/device-service";
import { EditorDocumentService } from "../services/editor-document-service";
import { createEditorDocumentRoutes } from "./editor-documents";

async function waitFor(check: () => boolean, ms = 10000) {
	const deadline = Date.now() + ms;
	while (!check()) {
		if (Date.now() > deadline) throw new Error("Executor fixture readiness deadline");
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}
async function fds(pid: number, path: string) {
	const entries = await readdir(`/proc/${pid}/fd`);
	let count = 0;
	for (const entry of entries)
		if ((await readlink(`/proc/${pid}/fd/${entry}`).catch(() => "")) === path) count++;
	return count;
}
test("real executor process -> authenticated WS RPC -> authorized raw service; no host read or low-capability fallback", async () => {
	const root = await mkdtemp(join(testEnvironment.isolatedHome, "raw-executor-"));
	const remoteRoot = join(root, "remote");
	await mkdir(remoteRoot);
	const source = join(remoteRoot, "remote.txt"),
		bytes = Buffer.alloc(20 * 1024 * 1024, 65);
	bytes.set(Buffer.from("\ufeff远端😀\r\n\ufeffmixed\rtext\n"));
	await writeFile(source, bytes);
	const binary = join(root, "executor");
	const realHome = dirname(testEnvironment.realNarraforkHome);
	const build = await safeSpawn({
		cmd: ["go", "build", "-o", binary, "./cmd/narrafork-executor"],
		cwd: resolve(import.meta.dir, "../../remote-executor"),
		env: {
			...process.env,
			GOCACHE: join(realHome, ".cache/go-build"),
			GOPATH: join(realHome, "go"),
			GOPROXY: "off",
			CGO_ENABLED: "0",
		},
		timeout: 60000,
		maxOutputBytes: 65536,
	});
	if (build.exitCode) throw new Error(`Executor native build failed: ${build.stderr}`);
	initDeviceConnectionService();
	await new Promise((resolve) => setTimeout(resolve, 0));
	const deviceId = generateId(),
		userId = generateId(),
		narratorId = generateId(),
		now = new Date().toISOString(),
		token = "rdev_raw_fixture_only";
	db.insert(users)
		.values({ id: userId, username: userId, passwordHash: "fixture", role: "user", createdAt: now })
		.run();
	db.insert(remoteDevices)
		.values({
			id: deviceId,
			name: "Raw fixture",
			slug: deviceId,
			tokenHash: hashDeviceToken(token),
			tokenPrefix: "rdev",
			connectionMode: "reverse",
			status: "offline",
			scope: "global",
			createdBy: userId,
			createdAt: now,
			updatedAt: now,
		})
		.run();
	db.insert(narrators)
		.values({
			id: narratorId,
			ownerUserId: userId,
			cwd: root,
			defaultDeviceId: deviceId,
			visibility: "private",
			createdAt: now,
			updatedAt: now,
		})
		.run();
	const service = new EditorDocumentService({
		root: join(root, "transfers"),
		execute: async () => {
			throw new Error("Remote raw writer is unavailable");
		},
	});
	const calls: string[] = [];
	const worker = spyOn(service.streams.workers, "run");
	let lowCapability = false;
	let executor: ReturnType<typeof Bun.spawn> | undefined;
	const server = Bun.serve<DeviceWSData & { channel: "device" }>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, server) {
			if (
				server.upgrade(request, {
					data: {
						channel: "device",
						connectedAt: Date.now(),
						lastPongAt: Date.now(),
						authenticated: false,
					},
				})
			)
				return;
			return new Response("fixture WebSocket required", { status: 400 });
		},
		websocket: {
			open: (ws) => handleDeviceWS.open(ws),
			close: (ws) => handleDeviceWS.close(ws),
			async message(ws, data) {
				if (typeof data !== "string") return handleDeviceWS.binaryMessage(ws, new Uint8Array(data));
				const frame = JSON.parse(data);
				if (lowCapability && frame.type === "hello")
					frame.capabilities.features = frame.capabilities.features.filter(
						(feature: string) => feature !== "editor.raw-read.v1",
					);
				await handleDeviceWS.message(ws, frame);
			},
		},
	});
	const app = new Hono();
	app.use("*", async (c, next) => {
		c.set("user", { sub: userId, role: "user", iat: 1, exp: 9999999999 });
		await next();
	});
	app.route(
		"/api/narrators",
		createEditorDocumentRoutes(() => service),
	);
	const base = `/api/narrators/${narratorId}/editor-documents`;
	const request = (path: string, method = "GET", input?: unknown) =>
		app.request(`http://fixture${path}`, {
			method,
			...(input
				? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) }
				: {}),
		});
	try {
		executor = Bun.spawn(
			[
				binary,
				"--server",
				`ws://127.0.0.1:${server.port}`,
				"--device",
				deviceId,
				"--token",
				token,
				"--allow-root",
				remoteRoot,
				"--cwd",
				remoteRoot,
				"--disable-shell",
			],
			{
				cwd: root,
				env: { ...process.env, HOME: root, NARRAFORK_HOME: join(root, "executor-home") },
				stdout: "ignore",
				stderr: "ignore",
			},
		);
		await waitFor(() => isDeviceOnline(deviceId));
		const generation = getDeviceConnectionGeneration(deviceId) as number;
		expect(getConnectedDeviceHello(deviceId)?.capabilities?.features).toContain(
			"editor.raw-read.v1",
		);
		const created = await request(base, "POST", {
			path: source,
			deviceId,
			origin: "reference",
			protocol: "raw-v2",
		});
		expect(created.status).toBe(200);
		const document = await created.json();
		expect(document.target.deviceId).toBe(deviceId);
		expect(document.protocol).toBe("raw-v2");
		expect(document.baseHash).toBe(createHash("sha256").update(bytes).digest("hex"));
		expect(await fds(executor.pid, source)).toBe(0);
		const opened = await request(`${base}/${document.docId}/raw-reads`, "POST", {
			versionHandle: document.versionHandle,
		});
		expect(opened.status).toBe(200);
		const { readId } = await opened.json();
		expect(await fds(executor.pid, source)).toBe(1);
		const digest = createHash("sha256");
		let offset = 0;
		for (;;) {
			const response = await request(`${base}/${document.docId}/raw-reads/${readId}`, "POST", {
				offset,
				maxBytes: 65536,
			});
			expect(response.status).toBe(200);
			const chunk = new Uint8Array(await response.arrayBuffer());
			offset += chunk.length;
			digest.update(chunk);
			if (response.headers.get("x-editor-eof") === "1") break;
		}
		expect(digest.digest("hex")).toBe(document.baseHash);
		expect(offset).toBe(bytes.length);
		expect(await fds(executor.pid, source)).toBe(0);
		expect(service.streams.diagnostics.active).toBe(1);
		expect((await request(`${base}/${document.docId}/raw-reads/${readId}`, "DELETE")).status).toBe(
			204,
		);
		for (const call of worker.mock.calls) calls.push(call[1].action);
		expect(calls).toContain("codec-open");
		expect(calls).toContain("codec-chunk");
		expect(calls).not.toContain("open");
		await unlink(source);
		const missing = await request(`${base}/${document.docId}/disk-state`);
		expect(missing.status).toBe(200);
		expect(await missing.json()).toEqual({
			exists: false,
			protocol: "raw-v2",
			hashKind: "raw-sha256",
		});
		await writeFile(source, bytes);
		lowCapability = true;
		disconnectDevice(deviceId, "isolated fixture low-capability reconnect");
		await waitFor(
			() => isDeviceOnline(deviceId) && getDeviceConnectionGeneration(deviceId) !== generation,
		);
		const old = new RemoteBackend(deviceId, {
			connectionGeneration: generation,
			defaultCwd: remoteRoot,
			platform: { os: "linux", arch: "amd64" },
			supportsFsStatResolvedPath: true,
		});
		await expect(old.editorRootIdentity()).rejects.toThrow();
		const refused = await request(base, "POST", {
			path: source,
			deviceId,
			origin: "reference",
			protocol: "raw-v2",
		});
		expect(refused.status).toBe(422);
		expect((await refused.json()).code).toBe("EDITOR_PROVIDER_UNSUPPORTED");
		expect(await fds(executor.pid, source)).toBe(0);
		expect(service.streams.diagnostics.active).toBe(0);
		console.info(
			"real-raw-executor-host",
			JSON.stringify({
				bytes: offset,
				generation,
				methodFamily: "editor.read.open/chunk/close",
				workerActions: [...new Set(calls)],
				source: service.streams.diagnostics,
			}),
		);
	} finally {
		worker.mockRestore();
		disconnectDevice(deviceId, "isolated fixture teardown");
		if (executor) {
			executor.kill("SIGTERM");
			await executor.exited;
		}
		server.stop(true);
		await service.dispose();
		await rm(root, { recursive: true, force: true });
	}
}, 90000);
