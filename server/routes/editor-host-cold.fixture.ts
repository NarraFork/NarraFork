/** Isolated executable fixture, not a production server entry or recovery fallback. */

import { eq } from "drizzle-orm";
import { Hono } from "hono";
import type { NarratorClientMessage } from "../websocket/narrator-ws";
import type { WSData } from "../websocket/ws-handler";

if (process.env.NARRAFORK_TEST !== "1" || !process.env.NARRAFORK_HOME)
	throw new Error("Cold Host fixture requires test isolation before importing persistence");
const [
	{ db },
	{ fileChangeOperations, narrators, users },
	{ createToken, verifyToken },
	{ settings },
	{ requireAuth },
	{ getEditorDocumentService },
	{ EditorHelperSession, editorHelperAvailable, editorHelperDiagnostics, resolveEditorHelper },
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
	import("../services/editor-helper"),
	import("../websocket/narrator-ws"),
	import("../websocket/ws-handler"),
	import("./editor-documents"),
	import("./narrator-file-references"),
]);
const raw = await Bun.stdin.text();
if (raw.length > 32 * 1024) throw new Error("Fixture configuration budget exceeded");
const config = JSON.parse(raw) as {
	workspace: string;
	manifest: string;
	distributionUrl: string;
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
	serverUrl: config.distributionUrl,
	proxy: { mode: "direct" },
};
const nativeCalls = { apply: 0, query: 0 };
const originalCall = EditorHelperSession.prototype.call;
EditorHelperSession.prototype.call = function <T>(
	method: string,
	params: object,
	signal?: AbortSignal,
): Promise<T> {
	if (method === "editor.apply") nativeCalls.apply++;
	if (method === "editor.query") nativeCalls.query++;
	return originalCall.call(this, method, params, signal) as Promise<T>;
};
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
		defaultDeviceId: "local",
		visibility: "private",
		createdAt: now,
		updatedAt: now,
	})
	.onConflictDoNothing()
	.run();
await resolveEditorHelper(AbortSignal.timeout(15_000));
const readyDeadline = Date.now() + 15_000;
while (!editorHelperAvailable()) {
	if (Date.now() >= readyDeadline) throw new Error("Verified fixture helper did not become ready");
	await new Promise((resolve) => setTimeout(resolve, 5));
}
const manifestFile = Bun.file(config.manifest);
if (manifestFile.size > 1024 * 1024) throw new Error("Fixture bundle manifest exceeds budget");
const bundle = (await manifestFile.json()) as {
	html: string;
	assets: [string, { path: string; mime: string }][];
};
const assets = new Map(bundle.assets);
const token = await createToken(config.userId, "user");
let dropReply = false,
	blockQuery = false;
const app = new Hono();
app.use("*", requireAuth);
app.use("*", async (c, next) => {
	if (blockQuery && c.req.path.includes("/editor-operations/"))
		return c.json({ error: "Fixture query unavailable until Host restart" }, 503);
	await next();
});
app.post("/fixture-fault", (c) => {
	dropReply = true;
	blockQuery = true;
	return c.json({ armed: true });
});
app.get("/fixture-info", (c) =>
	c.json({
		operations: db
			.select({ id: fileChangeOperations.id })
			.from(fileChangeOperations)
			.where(eq(fileChangeOperations.sourceKind, "editor"))
			.limit(4)
			.all(),
		helpers: editorHelperDiagnostics(),
		editor: getEditorDocumentService().diagnostics,
		nativeCalls,
		pid: process.pid,
	}),
);
app.route("/api/narrators", createEditorDocumentRoutes());
app.route("/api/narrators/:id/file-references", createFileReferenceRoutes());
const sockets = new Set<Parameters<typeof handleNarratorWS.open>[0]>();
setInterval(() => {
	for (const socket of sockets) socket.send(JSON.stringify({ type: "ping" }));
}, 30_000).unref();
const server = Bun.serve<WSData>({
	hostname: "127.0.0.1",
	port: config.port,
	async fetch(request, server) {
		const url = new URL(request.url),
			path = url.pathname;
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
						sessionTokenVersion: verified.sv ?? 0,
					},
				);
				if (data && server.upgrade(request, { data })) return;
			} catch {
				return new Response("Denied", { status: 401 });
			}
			return new Response("Upgrade refused", { status: 400 });
		}
		if (path === "/fixture-config")
			return Response.json({ narratorId: config.narratorId, deviceId: "local", token });
		// Only this fixture's deliberately lost reply/query is unavailable. All file
		// operations still traverse real JWT middleware, production runtime and native IO.
		if (path.startsWith("/api/") || path.startsWith("/fixture-")) {
			const response = await app.fetch(request);
			if (dropReply && path.endsWith("/commit") && response.ok) {
				dropReply = false;
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
			if (ws.data.channel === "narrator") {
				const socket = ws as Parameters<typeof handleNarratorWS.open>[0];
				sockets.add(socket);
				handleNarratorWS.open(socket);
			}
		},
		async message(ws, frame) {
			if (ws.data.channel === "narrator")
				await handleNarratorWS.message(
					ws as Parameters<typeof handleNarratorWS.message>[0],
					JSON.parse(String(frame)) as NarratorClientMessage,
				);
		},
		close(ws) {
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
