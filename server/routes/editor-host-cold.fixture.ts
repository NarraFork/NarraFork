/** Isolated executable fixture, not a production server entry or recovery fallback. */

import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { NarratorClientMessage } from "../websocket/narrator-ws";
import type { WSData } from "../websocket/ws-handler";

if (process.env.NARRAFORK_TEST !== "1" || !process.env.NARRAFORK_HOME)
	throw new Error("Cold Host fixture requires test isolation before importing persistence");
const [
	{ db },
	{ fileChangeOperations, narrators, users, workspaceWriteLeases, remoteDevices },
	{ createToken, verifyToken },
	{ settings },
	{ requireAuth },
	{ getEditorDocumentService },
	{ denyHostEditorHelpers },
	{ handleNarratorWS },
	{ resolveWSData },
	{ createEditorDocumentRoutes },
	{ createFileReferenceRoutes },
] = await Promise.all([
	import("../db"),
	import("../db/schema"),
	import("../lib/auth"),
	import("../lib/settings"),
	import("../middleware/auth"),
	import("../services/editor-document-runtime"),
	import("./editor-native-fixture"),
	import("../websocket/narrator-ws"),
	import("../websocket/ws-handler"),
	import("./editor-documents"),
	import("./narrator-file-references"),
]);
const raw = await Bun.stdin.text();
if (raw.length > 32 * 1024) throw new Error("Fixture configuration budget exceeded");
const config = JSON.parse(raw) as {
	workspace: string;
	manifest?: string;
	distributionUrl?: string;
	remote?: { deviceId: string; tokenHash: string };
	userId: string;
	narratorId: string;
	secret: string;
	port: number;
};
settings.auth.jwtSecret = config.secret;
settings.update = {
	product: "narrafork",
	channel: "stable",
	checkIntervalMinutes: 60,
	autoDownload: false,
	...settings.update,
	source: "update-server",
	serverUrl: config.distributionUrl ?? "https://host-must-not-download.invalid",
	proxy: { mode: "direct" },
};
// Process-local trap: leave worker/Git/browser subprocesses alone. Any local
// executor bootstrap or network dependency is a fixture failure, not a fallback.
const processGuard = denyHostEditorHelpers();
const faultCounts = { historyFailures: 0, droppedReplies: 0 };
const nativeCalls = {
	apply: 0,
	query: 0,
	ack: 0,
	get helperStarts() {
		return processGuard.starts;
	},
	network: 0,
};
const originalFetch = globalThis.fetch;
globalThis.fetch = Object.assign(
	() => {
		nativeCalls.network++;
		throw new Error("Cold Host ordinary save must not fetch a helper");
	},
	{ preconnect: originalFetch.preconnect },
);
const now = new Date().toISOString();
db.insert(users)
	.values({
		id: config.userId,
		username: config.userId,
		passwordHash: "fixture-not-a-login",
		role: "user",
		createdAt: now,
	})
	.onConflictDoNothing()
	.run();
db.insert(narrators)
	.values({
		id: config.narratorId,
		ownerUserId: config.userId,
		cwd: config.workspace,
		defaultDeviceId: config.remote?.deviceId ?? "local",
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	})
	.onConflictDoNothing()
	.run();
if (config.remote)
	db.insert(remoteDevices)
		.values({
			id: config.remote.deviceId,
			name: "Controlled persistence peer",
			slug: config.remote.deviceId,
			tokenHash: config.remote.tokenHash,
			tokenPrefix: "fixture",
			connectionMode: "reverse",
			status: "offline",
			scope: "global",
			createdBy: config.userId,
			createdAt: now,
			updatedAt: now,
		})
		.onConflictDoNothing()
		.run();
const devices = await import("../services/device-connection-service");
if (config.remote) devices.initDeviceConnectionService();
let bundle: { html: string; assets: [string, { path: string; mime: string }][] } = {
	html: "",
	assets: [],
};
if (config.manifest) {
	const manifestFile = Bun.file(config.manifest);
	if (manifestFile.size > 1024 * 1024) throw new Error("Fixture bundle manifest exceeds budget");
	bundle = await manifestFile.json();
}
const assets = new Map(bundle.assets);
const token = await createToken(config.userId);
let dropReply = false,
	blockQuery = false,
	failSettlement = false,
	dropApplyReply = false,
	failAck = false;
let forcedQuery: "not_found" | "uncertain" | undefined;
const applyRequests = new Set<string>();
// Instance-local evidence fault after actual Host write/sync/close/verification.
// This is not a mock writer and never changes a global prototype or disk bytes.
const { getDefaultLocalFileChangeRuntime } = await import("../services/file-change-runtime");
const evidence = (await getDefaultLocalFileChangeRuntime()).evidence;
const recordEffect = evidence.recordEffect.bind(evidence);
evidence.recordEffect = (...args: Parameters<typeof recordEffect>) => {
	if (failSettlement && args[0].outcome === "applied") {
		failSettlement = false;
		faultCounts.historyFailures++;
		throw new Error("Fixture Host history unavailable after confirmed write");
	}
	return recordEffect(...args);
};
const app = new Hono();
app.use("*", requireAuth);
app.use("*", async (c, next) => {
	if (blockQuery && c.req.path.includes("/editor-operations/"))
		return c.json({ error: "Fixture query unavailable until Host restart" }, 503);
	await next();
});
app.post("/fixture-fault", (c) => {
	const mode = c.req.query("mode");
	failSettlement = mode === "settlement" || c.req.query("pending") === "1";
	dropApplyReply = mode === "lost-apply";
	failAck = mode === "ack";
	forcedQuery = mode === "not_found" || mode === "uncertain" ? mode : undefined;
	dropReply = !mode && !failSettlement;
	blockQuery = !mode;
	return c.json({ armed: true });
});
app.post("/fixture-purge-worker-meta", async (c) => {
	const operations = db
		.select({ id: fileChangeOperations.sourceId })
		.from(fileChangeOperations)
		.where(eq(fileChangeOperations.sourceKind, "editor"))
		.limit(8)
		.all();
	for (const operation of operations)
		await unlink(
			join(process.env.NARRAFORK_HOME as string, "editor-transfers", `ed-${operation.id}.json`),
		).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	return c.json({ removed: operations.length });
});
app.post("/fixture-change-root", (c) => {
	db.update(narrators)
		.set({ cwd: `${config.workspace}-changed` })
		.where(eq(narrators.id, config.narratorId))
		.run();
	return c.json({ changed: true });
});
app.post("/fixture-revoke", (c) => {
	if (config.remote)
		db.update(remoteDevices)
			.set({ revokedAt: new Date().toISOString() })
			.where(eq(remoteDevices.id, config.remote.deviceId))
			.run();
	return c.json({ revoked: true });
});
app.get("/fixture-info", (c) =>
	c.json({
		operations: db
			.select({
				id: fileChangeOperations.id,
				sourceId: fileChangeOperations.sourceId,
				settlement: fileChangeOperations.settlement,
				workspaceLeaseId: fileChangeOperations.workspaceLeaseId,
				snapshotRevision: fileChangeOperations.editorRawSnapshotRevision,
			})
			.from(fileChangeOperations)
			.where(eq(fileChangeOperations.sourceKind, "editor"))
			.limit(4)
			.all(),
		leases: db
			.select({ id: workspaceWriteLeases.leaseId, status: workspaceWriteLeases.status })
			.from(workspaceWriteLeases)
			.limit(4)
			.all(),
		helpers: { processes: processGuard.starts },
		editor: getEditorDocumentService().diagnostics,
		nativeCalls,
		faultCounts,
		online: config.remote
			? devices.getDeviceConnectionGeneration(config.remote.deviceId) !== null
			: true,
		pid: process.pid,
	}),
);
app.route("/api/narrators", createEditorDocumentRoutes());
app.route("/api/narrators/:id/file-references", createFileReferenceRoutes());
const sockets = new Set<Parameters<typeof handleNarratorWS.open>[0]>();
setInterval(() => {
	for (const socket of sockets) socket.send(JSON.stringify({ type: "ping" }));
}, 30_000).unref();
const deviceAdapters = new WeakMap<object, Parameters<typeof devices.handleDeviceWS.message>[0]>();
function deviceAdapter(ws: Bun.ServerWebSocket<WSData>) {
	let adapter = deviceAdapters.get(ws);
	if (adapter) return adapter;
	adapter = {
		data: ws.data,
		get readyState() {
			return ws.readyState;
		},
		getBufferedAmount: () => ws.getBufferedAmount(),
		close: (code?: number, reason?: string) => ws.close(code, reason),
		send(data: string | Uint8Array) {
			if (typeof data === "string") {
				const frame = JSON.parse(data);
				if (frame.type === "rpc" && frame.method === "editor.apply") {
					nativeCalls.apply++;
					applyRequests.add(frame.id);
				}
				if (frame.type === "rpc" && frame.method === "editor.query") {
					const ack = !!frame.params.acknowledgeTerminal;
					if (ack) nativeCalls.ack++;
					else nativeCalls.query++;
					if ((ack && failAck) || (!ack && forcedQuery)) {
						const outcome = forcedQuery;
						if (ack) failAck = false;
						queueMicrotask(() => {
							void devices.handleDeviceWS.message(
								deviceAdapter(ws),
								ack
									? {
											type: "rpc_result",
											id: frame.id,
											ok: false,
											error: "Fixture ACK unavailable",
										}
									: {
											type: "rpc_result",
											id: frame.id,
											ok: true,
											result: { operationId: frame.params.operationId, outcome, result: null },
										},
							);
						});
						return 0;
					}
				}
			}
			return ws.send(data);
		},
	} as Parameters<typeof devices.handleDeviceWS.message>[0];
	deviceAdapters.set(ws, adapter);
	return adapter;
}
const server = Bun.serve<WSData>({
	hostname: "127.0.0.1",
	port: config.port,
	async fetch(request, server) {
		const url = new URL(request.url),
			path = url.pathname;
		if (path === "/ws/device" && config.remote) {
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
			return new Response("Upgrade refused", { status: 400 });
		}
		if (path === "/ws/narrator") {
			try {
				const verified = await verifyToken(url.searchParams.get("token") ?? "");
				if (verified.sub !== config.userId) return new Response("Denied", { status: 403 });
				const data = resolveWSData(
					url,
					{
						userId: config.userId,
						username: config.userId,
						role: "user",
						avatarColor: null,
						avatarImageId: null,
					},
					undefined,
					{
						sessionExp: verified.exp,
						sessionUserId: verified.sub,
						sessionId: verified.sid,
					},
				);
				if (data && server.upgrade(request, { data })) return;
			} catch {
				return new Response("Denied", { status: 401 });
			}
			return new Response("Upgrade refused", { status: 400 });
		}
		if (path === "/fixture-config")
			return Response.json({
				narratorId: config.narratorId,
				deviceId: config.remote?.deviceId ?? "local",
				token,
			});
		// Only this fixture's deliberately lost reply/query is unavailable. All file
		// operations still traverse real JWT middleware, production runtime and ordinary Host IO.
		if (path.startsWith("/api/") || path.startsWith("/fixture-")) {
			const response = await app.fetch(request);
			if (dropReply && path.endsWith("/commit") && response.ok) {
				dropReply = false;
				faultCounts.droppedReplies++;
				await response.body?.cancel();
				return Response.json({ error: "Fixture lost committed reply" }, { status: 503 });
			}
			return response;
		}
		if (path === "/")
			return new Response(bundle.html, { headers: { "Content-Type": "text/html" } });
		const asset = assets.get(path);
		return asset
			? new Response(Bun.file(asset.path), { headers: { "Content-Type": asset.mime } })
			: new Response("Not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			if (ws.data.channel === "device") devices.handleDeviceWS.open(deviceAdapter(ws));
			if (ws.data.channel === "narrator") {
				const socket = ws as Parameters<typeof handleNarratorWS.open>[0];
				sockets.add(socket);
				handleNarratorWS.open(socket);
			}
		},
		async message(ws, frame) {
			if (ws.data.channel === "device") {
				const value = JSON.parse(String(frame));
				if (value.type === "rpc_result" && applyRequests.delete(value.id) && dropApplyReply) {
					dropApplyReply = false;
					ws.close();
					return;
				}
				await devices.handleDeviceWS.message(deviceAdapter(ws), value);
			}
			if (ws.data.channel === "narrator")
				await handleNarratorWS.message(
					ws as Parameters<typeof handleNarratorWS.message>[0],
					JSON.parse(String(frame)) as NarratorClientMessage,
				);
		},
		close(ws) {
			if (ws.data.channel === "device") devices.handleDeviceWS.close(deviceAdapter(ws));
			if (ws.data.channel === "narrator") {
				const socket = ws as Parameters<typeof handleNarratorWS.close>[0];
				sockets.delete(socket);
				handleNarratorWS.close(socket);
			}
		},
	},
});
// The parent consumes this bounded machine-readable line; it never prints the fixture JWT.
console.log(`EDITOR_HOST_READY ${JSON.stringify({ port: server.port, token, pid: process.pid })}`);
