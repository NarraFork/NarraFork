/**
 * What live editing costs on the wire and on the server, measured (the numbers in PR8's
 * description come from here). Not a regression test: it only runs with
 * `NF_OUTLINE_LIVE_BENCH=1` and prints a report.
 *
 *   NF_OUTLINE_LIVE_BENCH=1 bun test --isolate server/services/outline/live/__tests__/live-bench.test.ts
 *
 * The real registry and sessions behind a real Bun WebSocket server; the editor's real client
 * engine (`live-client.ts`) on Bun WebSocket clients; a TCP proxy in between counts the bytes
 * on the wire (frame headers and, when negotiated, compression included). Typists type one
 * character per keystroke at a steady rate, each in their own block or all in one.
 *
 * ISOLATION: the isolated database from `tests/preload.ts`.
 */
import { afterAll, beforeAll, expect, test } from "bun:test";
import { LiveClient, type LiveTransport } from "@frontend/components/outline/editor/live-client";
import { decodeLiveFrame, type LiveFrame } from "@shared/outline-live-protocol";
import type { Socket } from "bun";
import { db } from "../../../../db";
import { aclGrants, projects, users } from "../../../../db/schema";
import { generateId } from "../../../../lib/id";
import { settings } from "../../../../lib/settings";
import {
	drainOutlineLive,
	handleOutlineLiveBinary,
	type OutlineLiveWS,
	releaseOutlineLive,
} from "../../../../websocket/outline-live-ws";
import { ensureProjectSpace } from "../../spaces";
import type { OutlineSpaceRow } from "../../store/port";
import { writeOutline } from "../../write";
import { closeAllLiveSessions, liveSessionOf, outlineLiveQuiet } from "../registry";
import { LivePage, OUTLINE_LIVE_TIMING } from "../session";

const BENCH = process.env.NF_OUTLINE_LIVE_BENCH === "1";
const NOW = "2026-10-27T00:00:00.000Z";

let space: OutlineSpaceRow;
const people: Array<{ id: string; name: string }> = [];

// ─── Server-side timing ─────────────────────────────────────────────────────

const timing = { updates: 0, updateMs: 0, flushes: 0, flushMs: 0, openMs: 0, joinMs: 0, joins: 0 };

function instrument(): void {
	const proto = LivePage.prototype as unknown as Record<string, (...args: unknown[]) => unknown>;
	const wrap = (name: string, count: keyof typeof timing, ms: keyof typeof timing) => {
		const orig = proto[name] as (...args: unknown[]) => unknown;
		proto[name] = function (this: unknown, ...args: unknown[]) {
			const t0 = performance.now();
			try {
				return orig.apply(this, args);
			} finally {
				timing[ms] += performance.now() - t0;
				timing[count]++;
			}
		};
	};
	wrap("handleUpdate", "updates", "updateMs");
	wrap("flushBroadcast", "flushes", "flushMs");
	wrap("join", "joins", "joinMs");
	const open = LivePage.open.bind(LivePage);
	(LivePage as unknown as { open: typeof LivePage.open }).open = async (...args) => {
		const t0 = performance.now();
		try {
			return await open(...args);
		} finally {
			timing.openMs += performance.now() - t0;
		}
	};
}

// ─── Server, proxy, clients ─────────────────────────────────────────────────

type Compression = "off" | "all" | "large";

interface Wire {
	up: number;
	down: number;
}

const wire: Wire = { up: 0, down: 0 };
let compressMs = 0;

function startServer(compression: Compression) {
	const wrappers = new Map<unknown, OutlineLiveWS>();
	const wrapperOf = (ws: {
		data: OutlineLiveWS["data"];
		sendBinary(d: Uint8Array, c?: boolean): number;
		getBufferedAmount(): number;
	}) => {
		let w = wrappers.get(ws);
		if (!w) {
			w = {
				data: ws.data,
				sendBinary: (d: Uint8Array) => {
					const compress = compression === "all" || (compression === "large" && d.length >= 1024);
					const t0 = performance.now();
					const r = ws.sendBinary(d, compress);
					if (compress) compressMs += performance.now() - t0;
					return r;
				},
				getBufferedAmount: () => ws.getBufferedAmount(),
			};
			wrappers.set(ws, w);
		}
		return w;
	};
	return Bun.serve<OutlineLiveWS["data"]>({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request, srv) {
			const url = new URL(request.url);
			const userId = url.searchParams.get("user") ?? "";
			const name = people.find((p) => p.id === userId)?.name ?? userId;
			if (srv.upgrade(request, { data: { userId, username: name, userRole: "user" } }))
				return undefined;
			return new Response("no", { status: 400 });
		},
		websocket: {
			perMessageDeflate: compression !== "off",
			message(ws, message) {
				if (typeof message === "string") return;
				handleOutlineLiveBinary(
					wrapperOf(ws),
					new Uint8Array(message.buffer, message.byteOffset, message.byteLength),
				);
			},
			drain(ws) {
				drainOutlineLive(wrapperOf(ws));
			},
			close(ws) {
				releaseOutlineLive(wrapperOf(ws));
				wrappers.delete(ws);
			},
		},
	});
}

/** A TCP proxy counting bytes each way (partial writes queued until drained). */
function startProxy(target: number) {
	type Side = { peer: Socket<Side> | null; queue: Uint8Array[]; dir: "up" | "down" };
	const flush = (s: Socket<Side>) => {
		const q = s.data.queue;
		while (q.length > 0) {
			const chunk = q[0] as Uint8Array;
			const n = s.write(chunk);
			if (n < chunk.length) {
				q[0] = chunk.subarray(n);
				return;
			}
			q.shift();
		}
	};
	const send = (to: Socket<Side> | null, chunk: Uint8Array, pending: Uint8Array[]) => {
		if (!to) {
			pending.push(chunk.slice());
			return;
		}
		to.data.queue.push(chunk.slice());
		flush(to);
	};
	return Bun.listen<Side>({
		hostname: "127.0.0.1",
		port: 0,
		socket: {
			open(client) {
				client.data = { peer: null, queue: [], dir: "up" };
				const early: Uint8Array[] = [];
				(client.data as Side & { early?: Uint8Array[] }).early = early;
				void Bun.connect<Side>({
					hostname: "127.0.0.1",
					port: target,
					socket: {
						open(up) {
							up.data = { peer: client, queue: [], dir: "down" };
							client.data.peer = up;
							for (const c of early) send(up, c, early);
							early.length = 0;
						},
						data(up, chunk) {
							wire.down += chunk.length;
							send(up.data.peer, chunk, []);
						},
						drain(up) {
							flush(up);
						},
						close(up) {
							up.data.peer?.end();
						},
					},
				});
			},
			data(client, chunk) {
				wire.up += chunk.length;
				send(client.data.peer, chunk, (client.data as Side & { early?: Uint8Array[] }).early ?? []);
			},
			drain(client) {
				flush(client);
			},
			close(client) {
				client.data.peer?.end();
			},
		},
	});
}

class WsTransport implements LiveTransport {
	connected = false;
	ws: WebSocket | null = null;
	extensions = "";
	framesUp = 0;
	framesDown = 0;
	bytesUp = 0;
	bytesDown = 0;
	/** Application sizes of the frames received, by kind. */
	readonly downByKind = new Map<number, { frames: number; bytes: number }>();
	private readonly frameListeners = new Set<(frame: LiveFrame) => void>();
	private readonly connListeners = new Set<(connected: boolean) => void>();
	private readonly handles = new Set<number>();

	constructor(private readonly url: string) {
		this.connect();
	}

	connect(): void {
		const ws = new WebSocket(this.url);
		ws.binaryType = "arraybuffer";
		this.ws = ws;
		ws.onopen = () => {
			this.connected = true;
			this.extensions = ws.extensions;
			for (const l of this.connListeners) l(true);
		};
		ws.onclose = () => {
			if (this.ws !== ws) return;
			this.connected = false;
			for (const l of this.connListeners) l(false);
		};
		ws.onmessage = (event) => {
			if (typeof event.data === "string") return;
			const bytes = new Uint8Array(event.data as ArrayBuffer);
			this.framesDown++;
			this.bytesDown += bytes.length;
			const kind = bytes[1] as number;
			const k = this.downByKind.get(kind) ?? { frames: 0, bytes: 0 };
			k.frames++;
			k.bytes += bytes.length;
			this.downByKind.set(kind, k);
			const frame = decodeLiveFrame(bytes);
			if (frame) for (const l of this.frameListeners) l(frame);
		};
	}

	disconnect(): void {
		const ws = this.ws;
		this.ws = null;
		ws?.close();
		this.connected = false;
		this.handles.clear();
		for (const l of this.connListeners) l(false);
	}

	send(frame: Uint8Array): boolean {
		if (!this.connected || !this.ws) return false;
		this.framesUp++;
		this.bytesUp += frame.length;
		this.ws.send(frame as Uint8Array<ArrayBuffer>);
		return true;
	}

	onFrame(listener: (frame: LiveFrame) => void): () => void {
		this.frameListeners.add(listener);
		return () => this.frameListeners.delete(listener);
	}

	onConnectionChange(listener: (connected: boolean) => void): () => void {
		this.connListeners.add(listener);
		return () => this.connListeners.delete(listener);
	}

	allocateHandle(): number | null {
		for (let h = 1; h < 256; h++) {
			if (!this.handles.has(h)) {
				this.handles.add(h);
				return h;
			}
		}
		return null;
	}

	releaseHandle(handle: number): void {
		this.handles.delete(handle);
	}

	resetCounts(): void {
		this.framesUp = 0;
		this.framesDown = 0;
		this.bytesUp = 0;
		this.bytesDown = 0;
		this.downByKind.clear();
	}
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function waitFor(fn: () => boolean, what: string, timeoutMs = 20_000): Promise<void> {
	const end = Date.now() + timeoutMs;
	while (!fn()) {
		if (Date.now() > end) throw new Error(`timed out: ${what}`);
		await sleep(5);
	}
}

async function quiet(clients: LiveClient[]): Promise<void> {
	let calm = 0;
	while (calm < 3) {
		await sleep(20);
		const busy = !outlineLiveQuiet() || clients.some((c) => !c.quiet || c.pending.length > 0);
		calm = busy ? 0 : calm + 1;
	}
}

function keystroke(c: LiveClient, blockId: string): void {
	const cur = c.textOf(blockId);
	c.commit({
		ops: [],
		bodies: [{ id: blockId, md: `${cur}字` }],
		kind: "typing",
		blockId,
		selBefore: null,
		selAfter: null,
		view: null,
	});
}

// ─── Fixtures ───────────────────────────────────────────────────────────────

async function makeUser(name: string): Promise<string> {
	const id = generateId();
	await db
		.insert(users)
		.values({ id, username: name, passwordHash: "x", role: "user", createdAt: NOW });
	people.push({ id, name });
	return id;
}

/**
 * A page of `n` blocks of realistic text (mixed Chinese and English, some markup), two levels;
 * `blockBytes` pads every block to about that size.
 */
async function bigPage(
	n: number,
	blockBytes = 0,
): Promise<{ pageId: string; ids: string[]; bytes: number }> {
	const owner = people[0]?.id as string;
	const words = [
		"大纲",
		"块模型",
		"真相",
		"编辑器",
		"live",
		"session",
		"**粗体**",
		"`code`",
		"协作",
	];
	let bytes = 0;
	const ids: string[] = [];
	const first = await writeOutline({
		spaceId: space.id,
		ops: [{ op: "insert", tempId: "p", parent: null, content: `Big page ${n}` }],
		actor: { kind: "human", id: owner },
		responsibleUserId: owner,
	});
	const pageId = first.results[0]?.blockId as string;
	const parents: string[] = [pageId];
	// Chunks inside the write path's operation and body limits.
	const chunk = blockBytes > 0 ? Math.max(1, Math.floor(120_000 / (blockBytes + 64))) : 200;
	for (let at = 0; at < n; at += chunk) {
		const ops: Parameters<typeof writeOutline>[0]["ops"][number][] = [];
		for (let i = at; i < Math.min(n, at + chunk); i++) {
			const len = 4 + (i % 9);
			let content = Array.from({ length: len }, (_, k) => words[(i + k) % words.length]).join(" ");
			while (Buffer.byteLength(content) < blockBytes)
				content += ` ${words[content.length % 9]} ${i}`;
			bytes += Buffer.byteLength(content);
			// Every 10th block opens a level; children go under the last opener.
			const parent = i % 10 === 0 ? pageId : (parents[parents.length - 1] as string);
			ops.push({ op: "insert", tempId: `b${i}`, parent: { id: parent }, content });
		}
		const r = await writeOutline({
			spaceId: space.id,
			ops,
			actor: { kind: "human", id: owner },
			responsibleUserId: owner,
		});
		r.results.forEach((x, k) => {
			ids.push(x.blockId);
			if ((at + k) % 10 === 0) parents.push(x.blockId);
		});
	}
	return { pageId, ids, bytes };
}

beforeAll(async () => {
	if (!BENCH) return;
	settings.outline.enabled = true;
	const owner = await makeUser("alice");
	await makeUser("bob");
	await makeUser("carol");
	const projectId = generateId();
	await db.insert(projects).values({
		id: projectId,
		name: "Bench",
		ownerUserId: owner,
		visibility: "private",
		createdAt: NOW,
		updatedAt: NOW,
	});
	for (const p of people.slice(1)) {
		await db.insert(aclGrants).values({
			id: generateId(),
			scopeType: "project",
			scopeId: projectId,
			principalType: "user",
			principalId: p.id,
			capability: "write",
			createdAt: NOW,
		});
	}
	space = await ensureProjectSpace(projectId);
	instrument();
	// Commits after typing pauses, as in production; persistence as in production.
	Object.assign(OUTLINE_LIVE_TIMING, { flushIdleMs: 2000, flushMaxMs: 10000, persistMs: 500 });
}, 120_000);

afterAll(async () => {
	if (BENCH) await closeAllLiveSessions("ended");
});

// ─── Scenarios ──────────────────────────────────────────────────────────────

interface TypingResult {
	compression: Compression;
	typists: number;
	sameBlock: boolean;
	keys: number;
	seconds: number;
	wireUpPerKey: number;
	wireDownPerKey: number;
	wireUpPerTypistPerSec: number;
	wireDownPerClientPerSec: number;
	framesUpPerTypistPerSec: number;
	framesDownPerClientPerSec: number;
	appUpPerKey: number;
	appDownPerClientPerSec: number;
	yUpdateAvg: number;
	naiveEchoDownPerClientPerSec: number;
	naiveNoEchoDownPerClientPerSec: number;
	jsonBase64DownPerClientPerSec: number;
	serverUpdateUs: number;
	serverFlushUs: number;
	extensions: string;
}

async function typing(
	compression: Compression,
	typists: number,
	sameBlock: boolean,
	rateHz = 10,
	seconds = 4,
): Promise<TypingResult> {
	const server = startServer(compression);
	const proxy = startProxy(server.port as number);
	const { pageId, ids } = await bigPage(30);
	const transports = people.map(
		(p) => new WsTransport(`ws://127.0.0.1:${proxy.port}/live?user=${encodeURIComponent(p.id)}`),
	);
	const clients = transports.map((t) => new LiveClient(t, pageId, "edit"));
	await waitFor(() => clients.every((c) => c.ready), "joined");
	await quiet(clients);
	// Every local Yjs update of a typist (one per keystroke): sizes for the comparisons.
	const ySizes: number[] = [];
	for (const c of clients.slice(0, typists)) {
		c.doc.on("update", (u: Uint8Array, origin: unknown) => {
			if ((origin as { origin?: string } | null)?.origin === "local") ySizes.push(u.length);
		});
	}
	for (const t of transports) t.resetCounts();
	wire.up = 0;
	wire.down = 0;
	Object.assign(timing, { updates: 0, updateMs: 0, flushes: 0, flushMs: 0 });
	const keysEach = rateHz * seconds;
	const t0 = performance.now();
	for (let k = 0; k < keysEach; k++) {
		for (let i = 0; i < typists; i++) {
			keystroke(clients[i] as LiveClient, ids[sameBlock ? 0 : i] as string);
		}
		await sleep(1000 / rateHz);
	}
	await quiet(clients);
	const elapsed = (performance.now() - t0) / 1000;
	const keys = keysEach * typists;
	const n = clients.length;
	// Every client ends with the same text.
	const texts = clients.map((c) =>
		ids
			.slice(0, typists)
			.map((id) => c.textOf(id))
			.join("|"),
	);
	expect(new Set(texts).size).toBe(1);
	const appDown = transports.reduce((s, t) => s + t.bytesDown, 0);
	const framesDown = transports.reduce((s, t) => s + t.framesDown, 0);
	const appUp = transports.reduce((s, t) => s + t.bytesUp, 0);
	const framesUp = transports.reduce((s, t) => s + t.framesUp, 0);
	const yAvg = ySizes.reduce((a, b) => a + b, 0) / Math.max(1, ySizes.length);
	// Alternatives, from the same keystrokes: relay every update in its own frame (8 bytes of
	// live header + 2 of WebSocket header) to everyone including the typist, or to the others
	// only; or the same frames as JSON with base64 bodies (the narrator socket's text frames).
	const perFrame = (bytes: number) => bytes + 8 + 2;
	const naiveEcho = ySizes.reduce((s, b) => s + perFrame(b) * n, 0);
	const naiveNoEcho = ySizes.reduce((s, b) => s + perFrame(b) * (n - 1), 0);
	const jsonDown = ySizes.reduce(
		(s, b) =>
			s +
			(JSON.stringify({ type: "outline_live", h: 1, k: "batch", head: { a: [] } }).length +
				Math.ceil(b / 3) * 4 +
				2) *
				(n - 1),
		0,
	);
	const result: TypingResult = {
		compression,
		typists,
		sameBlock,
		keys,
		seconds: +elapsed.toFixed(2),
		wireUpPerKey: +(wire.up / keys).toFixed(1),
		wireDownPerKey: +(wire.down / keys).toFixed(1),
		wireUpPerTypistPerSec: Math.round(wire.up / typists / elapsed),
		wireDownPerClientPerSec: Math.round(wire.down / n / elapsed),
		framesUpPerTypistPerSec: +(framesUp / typists / elapsed).toFixed(1),
		framesDownPerClientPerSec: +(framesDown / n / elapsed).toFixed(1),
		appUpPerKey: +(appUp / keys).toFixed(1),
		appDownPerClientPerSec: Math.round(appDown / n / elapsed),
		yUpdateAvg: +yAvg.toFixed(1),
		naiveEchoDownPerClientPerSec: Math.round(naiveEcho / n / elapsed),
		naiveNoEchoDownPerClientPerSec: Math.round(naiveNoEcho / n / elapsed),
		jsonBase64DownPerClientPerSec: Math.round(jsonDown / n / elapsed),
		serverUpdateUs: Math.round((timing.updateMs / Math.max(1, timing.updates)) * 1000),
		serverFlushUs: Math.round((timing.flushMs / Math.max(1, timing.flushes)) * 1000),
		extensions: transports[0]?.extensions ?? "",
	};
	for (const c of clients) c.dispose();
	for (const t of transports) t.disconnect();
	await closeAllLiveSessions("ended");
	server.stop(true);
	proxy.stop(true);
	return result;
}

async function initialSync(compression: Compression, blocks: number, blockBytes = 0) {
	const server = startServer(compression);
	const proxy = startProxy(server.port as number);
	const { pageId, ids, bytes } = await bigPage(blocks, blockBytes);
	Object.assign(timing, { openMs: 0, joinMs: 0, joins: 0 });
	compressMs = 0;
	wire.up = 0;
	wire.down = 0;
	const t = new WsTransport(`ws://127.0.0.1:${proxy.port}/live?user=${people[0]?.id}`);
	const t0 = performance.now();
	const c = new LiveClient(t, pageId, "edit");
	await waitFor(() => c.ready, "joined").catch((e) => {
		throw new Error(
			`${e} ${JSON.stringify({ status: c.status, close: c.closeCode, connected: t.connected, up: t.framesUp, down: t.framesDown, wire, enabled: settings.outline.enabled })}`,
		);
	});
	const readyMs = performance.now() - t0;
	await quiet([c]);
	const joined = t.downByKind.get(0x81);
	const firstWire = wire.down;
	const firstOpenMs = timing.openMs;
	const firstJoinMs = timing.joinMs;
	// A second person joins the open session: no open, only the snapshot.
	Object.assign(timing, { joinMs: 0, joins: 0 });
	wire.down = 0;
	const t2 = new WsTransport(`ws://127.0.0.1:${proxy.port}/live?user=${people[1]?.id}`);
	const t1 = performance.now();
	const c2 = new LiveClient(t2, pageId, "edit");
	await waitFor(() => c2.ready, "second joined");
	const secondReadyMs = performance.now() - t1;
	await quiet([c, c2]);
	const secondWire = wire.down;
	// Resume after a short disconnect: 20 keystrokes by the other person meanwhile.
	t2.disconnect();
	for (let i = 0; i < 20; i++) keystroke(c, ids[5] as string);
	await quiet([c]);
	t2.resetCounts();
	wire.down = 0;
	t2.connect();
	await waitFor(
		() => c2.status === "live" && c2.textOf(ids[5] as string) === c.textOf(ids[5] as string),
		"resumed",
	);
	await quiet([c, c2]);
	const resumeApp = t2.bytesDown;
	const resumeWire = wire.down;
	const result = {
		compression,
		blocks: ids.length,
		contentBytes: bytes,
		joinedFrameBytes: joined?.bytes ?? 0,
		wireDownFirst: firstWire,
		wireDownSecond: secondWire,
		readyMsFirst: Math.round(readyMs),
		readyMsSecond: Math.round(secondReadyMs),
		serverOpenMs: +firstOpenMs.toFixed(1),
		serverJoinMsFirst: +firstJoinMs.toFixed(1),
		serverJoinMsSecond: +timing.joinMs.toFixed(1),
		serverCompressMs: +compressMs.toFixed(1),
		resumeFrameBytes: resumeApp,
		resumeWire,
		resumes: c2.stats.resumes,
		extensions: t.extensions,
	};
	c.dispose();
	c2.dispose();
	t.disconnect();
	t2.disconnect();
	await closeAllLiveSessions("ended");
	server.stop(true);
	proxy.stop(true);
	return result;
}

test.skipIf(!BENCH)(
	"live editing on the wire",
	async () => {
		const report: Record<string, unknown[]> = { typing: [], initialSync: [] };
		for (const compression of ["off", "all", "large"] as const) {
			// 2000 blocks with the page itself: the most a live session takes.
			report.initialSync?.push(await initialSync(compression, 1999));
		}
		// The largest page a session takes: 2000 blocks, 4 MiB of text.
		report.initialSync?.push(await initialSync("off", 1999, 2000));
		report.initialSync?.push(await initialSync("all", 1999, 2000));
		for (const compression of ["off", "all"] as const) {
			for (const typists of [1, 2, 3]) {
				report.typing?.push(await typing(compression, typists, false));
			}
			report.typing?.push(await typing(compression, 3, true));
		}
		// Fast typing (or key repeat): 30 keys a second each, two typists.
		report.typing?.push(await typing("off", 2, false, 30, 3));
		expect(liveSessionOf("none")).toBeUndefined();
		console.log(JSON.stringify(report, null, 1));
	},
	600_000,
);
