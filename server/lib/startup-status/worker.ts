/**
 * Status-page worker: answers HTTP on the configured port while the main thread is busy starting
 * (upgrading the database, loading modules). It has its own thread, so a long synchronous
 * migration cannot stall it. Read-only: no request can change anything.
 */

import { parentPort } from "node:worker_threads";
import { STARTUP_STATUS_HEADER } from "../../../shared/startup-status";
import { injectSpaBaseHref } from "../spa-base-href";
import { STARTUP_PAGE_HTML } from "./page";
import {
	type FromStatusWorker,
	isLoopbackAddress,
	type StartupSnapshot,
	snapshotForViewer,
	type ToStatusWorker,
} from "./protocol";

const port = parentPort;
if (!port) throw new Error("startup status worker must run as a worker thread");

let snapshot: StartupSnapshot | undefined;
let viewerExpected = false;
let polled = false;
/** A problem was posted and no page has read it yet. */
let problemUnread = false;

const send = (message: FromStatusWorker) => port.postMessage(message);
const headers = { [STARTUP_STATUS_HEADER]: "1", "cache-control": "no-store", "retry-after": "2" };

function respond(request: Request, server: Bun.Server<undefined>): Response {
	const { pathname } = new URL(request.url);
	if (pathname === "/api/startup" && snapshot) {
		polled = true;
		if (problemUnread) {
			problemUnread = false;
			// Leave the response time to reach the browser before the process exits.
			setTimeout(() => send({ type: "problem-shown" }), 500);
		}
		const local = isLoopbackAddress(server.requestIP(request)?.address);
		return Response.json({ ...snapshotForViewer(snapshot, local), now: Date.now() }, { headers });
	}
	if (pathname === "/api/health") {
		return Response.json(
			{ status: "starting", readiness: "starting", version: snapshot?.version },
			{ status: 503, headers },
		);
	}
	const isPage =
		request.method === "GET" && (request.headers.get("accept") ?? "").includes("text/html");
	if (!isPage || pathname.startsWith("/api/") || pathname.startsWith("/ws/")) {
		return new Response("NarraFork is starting", { status: 503, headers });
	}
	return new Response(injectSpaBaseHref(STARTUP_PAGE_HTML, pathname), {
		status: 503,
		headers: { ...headers, "content-type": "text/html; charset=utf-8" },
	});
}

function listen(message: Extract<ToStatusWorker, { type: "listen" }>): void {
	viewerExpected = message.viewerExpected;
	const { hostname, port: listenPort, tls } = message.target;
	try {
		Bun.serve({
			hostname,
			port: listenPort,
			tls: tls && {
				cert: Bun.file(tls.certFile),
				key: Bun.file(tls.keyFile),
				...(tls.passphrase && { passphrase: tls.passphrase }),
				...(tls.caFile && { ca: Bun.file(tls.caFile) }),
			},
			fetch: respond,
		});
		send({ type: "listening" });
	} catch (error) {
		send({ type: "unavailable", error: String(error) });
	}
}

port.on("message", (message: ToStatusWorker | { action: "ping" }) => {
	// `connectCompiledWorker` asks every worker whether it loaded.
	if ("action" in message) {
		port.postMessage({ ready: true });
		return;
	}
	const hadProblem = !!snapshot?.problem;
	snapshot = message.snapshot;
	if (message.type === "listen") return listen(message);
	if (!snapshot.problem || hadProblem) return;
	if (polled || viewerExpected) problemUnread = true;
	else send({ type: "problem-shown" });
});
