/** Standalone, loopback-only interactive fixture. No NarraFork service or database is opened.
 * bun frontend/components/narrator/communication/topology-server.browser-fixture.ts
 * http://127.0.0.1:41738/?width=360&height=820&lang=zh-CN&team=1&readonly=1
 */
import { basename } from "node:path";
import {
	type CommunicationMutation,
	type CommunicationScope,
	type CommunicationTopology,
	canonicalCommunicationPair,
	diffCommunicationTopology,
} from "@shared/narrator-communication";
import type { ServerWebSocket } from "bun";
import { topologyFixture } from "./topology-fixture-data";

type Client = {
	entries: Map<string, { scope: CommunicationScope; previous: CommunicationTopology; seq: number }>;
	heartbeat?: ReturnType<typeof setInterval>;
};
const readOnly = process.env.COMMUNICATION_READONLY === "1";
let topology = topologyFixture(readOnly);
const sockets = new Set<ServerWebSocket<Client>>();
function publish() {
	for (const ws of sockets)
		for (const [id, entry] of ws.data.entries) {
			const next = { ...structuredClone(topology), scope: entry.scope };
			ws.send(
				JSON.stringify({
					type: "communication_delta",
					subscriptionId: id,
					epoch: "fixture",
					baseSeq: entry.seq,
					seq: ++entry.seq,
					delta: diffCommunicationTopology(entry.previous, next),
				}),
			);
			entry.previous = next;
		}
}
const bundle = await Bun.build({
	entrypoints: [new URL("./topology.browser-fixture.tsx", import.meta.url).pathname],
	target: "browser",
	format: "esm",
	splitting: true,
	define: { "process.env.NODE_ENV": '"production"' },
});
if (!bundle.success) throw new Error(bundle.logs.join("\n"));
const assets = new Map(bundle.outputs.map((output) => [`/${basename(output.path)}`, output]));
const entry = bundle.outputs.find((output) => output.kind === "entry-point");
if (!entry) throw new Error("Missing browser fixture entry");
const server = Bun.serve<Client>({
	hostname: "127.0.0.1",
	port: Number(process.env.COMMUNICATION_FIXTURE_PORT ?? 41738),
	async fetch(request, server) {
		const url = new URL(request.url);
		if (url.pathname === "/ws/narrator")
			return server.upgrade(request, { data: { entries: new Map() } })
				? undefined
				: new Response("Upgrade failed", { status: 400 });
		if (url.pathname === "/api/auth/me")
			return Response.json({ id: "fixture-user", username: "Fixture", role: "user" });
		if (url.pathname.endsWith("/communication/candidates")) {
			const sourceId = url.pathname.split("/")[3];
			const source = topology.nodes.find((node) => node.id === sourceId);
			return Response.json({
				items: topology.nodes
					.filter(
						(node) =>
							node.id !== sourceId &&
							(node.title ?? "")
								.toLowerCase()
								.includes((url.searchParams.get("q") ?? "").toLowerCase()),
					)
					.map((node) => ({
						id: node.id,
						title: node.title,
						status: node.status,
						isRecent: node.id === "external",
						lastActivityAt: "2026-01-15T12:00:00Z",
						canConnect: node.canConnect,
						sameGroup: node.groupId === source?.groupId,
						connected: topology.peers.some(
							(p) =>
								[p.endpointLo, p.endpointHi].includes(node.id) &&
								[p.endpointLo, p.endpointHi].includes(sourceId),
						),
					})),
				hasMore: false,
			});
		}
		if (url.pathname.endsWith("/communication") && request.method === "POST") {
			const sourceId = url.pathname.split("/")[3];
			const mutation = (await request.json()) as CommunicationMutation;
			const node = topology.nodes.find((node) => node.id === sourceId);
			if (!node?.canManage) return Response.json({ error: "Read only" }, { status: 403 });
			if (mutation.kind === "split" || mutation.kind === "restore") {
				if (mutation.version !== node.version)
					return Response.json({ error: "Version conflict" }, { status: 409 });
				node.parentNarratorId = mutation.kind === "split" ? null : node.restoreParentId;
				node.version++;
				for (const member of topology.nodes) {
					let cursor = member;
					const seen = new Set<string>();
					while (cursor.parentNarratorId && !seen.has(cursor.id)) {
						seen.add(cursor.id);
						const parent = topology.nodes.find((n) => n.id === cursor.parentNarratorId);
						if (!parent) break;
						cursor = parent;
					}
					member.groupId = cursor.id;
				}
			} else if (mutation.kind === "connect") {
				if (
					topology.peers.some(
						(p) =>
							[p.endpointLo, p.endpointHi].includes(sourceId) &&
							[p.endpointLo, p.endpointHi].includes(mutation.targetNarratorId),
					)
				)
					return Response.json({ changed: false });
				const [endpointLo, endpointHi] = canonicalCommunicationPair(
					sourceId,
					mutation.targetNarratorId,
				);
				topology.peers.push({
					id: `fixture-peer-${Date.now()}`,
					endpointLo,
					endpointHi,
					createdAt: new Date().toISOString(),
					canDisconnect: true,
				});
			} else {
				const peer = topology.peers.find((p) => p.id === mutation.peerId);
				if (!peer) return Response.json({ error: "Stale relation" }, { status: 404 });
				topology.peers = topology.peers.filter((p) => p !== peer);
			}
			publish();
			return Response.json({ changed: true });
		}
		if (url.pathname === "/") {
			if (url.searchParams.get("readonly") === "1") topology = topologyFixture(true);
			const width = Math.min(1600, Math.max(240, Number(url.searchParams.get("width") ?? 1024)));
			const height = Math.min(1600, Math.max(300, Number(url.searchParams.get("height") ?? 820)));
			return new Response(
				`<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">${[
					...assets.keys(),
				]
					.filter((path) => path.endsWith(".css"))
					.map((path) => `<link rel="stylesheet" href="${path}">`)
					.join(
						"",
					)}<style>html,body{margin:0;background:#16171b}button{font:inherit}#root{padding:12px;box-sizing:border-box}</style></head><body><div id="root"></div><script type="module">window.fixture=await import(${JSON.stringify(`/${basename(entry.path)}`)});window.fixture.mount(${width},${height},${url.searchParams.get("team") === "1"});${url.searchParams.get("lang") === "zh-CN" ? 'await window.fixture.language("zh-CN");' : ""}</script></body></html>`,
				{ headers: { "content-type": "text/html" } },
			);
		}
		const asset = assets.get(url.pathname);
		return asset ? new Response(asset) : new Response("Not found", { status: 404 });
	},
	websocket: {
		open(ws) {
			sockets.add(ws);
			// Match the application's JSON heartbeat, not WebSocket control-frame ping.
			ws.send(JSON.stringify({ type: "ping" }));
			ws.data.heartbeat = setInterval(() => ws.send(JSON.stringify({ type: "ping" })), 15_000);
		},
		message(ws, raw) {
			const frame = JSON.parse(String(raw));
			if (frame.type === "pong") return;
			if (frame.type === "communication_subscribe") {
				const initial = { ...structuredClone(topology), scope: frame.scope };
				ws.data.entries.set(frame.subscriptionId, {
					scope: frame.scope,
					previous: initial,
					seq: 0,
				});
				ws.send(
					JSON.stringify({
						type: "communication_snapshot",
						subscriptionId: frame.subscriptionId,
						epoch: "fixture",
						seq: 0,
						topology: initial,
					}),
				);
			}
			if (frame.type === "communication_unsubscribe") ws.data.entries.delete(frame.subscriptionId);
		},
		close(ws) {
			clearInterval(ws.data.heartbeat);
			ws.data.heartbeat = undefined;
			sockets.delete(ws);
		},
	},
});
console.log(`Communication topology fixture: ${server.url.href}?width=360&lang=zh-CN`);
