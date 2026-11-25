import { expect, mock, test } from "bun:test";
import {
	type CommunicationScope,
	type CommunicationTopology,
	COMMUNICATION_LIMITS as limits,
} from "@shared/narrator-communication";
import { narratorWsMessageSchema } from "../../server/lib/validators/websocket";
import {
	type CommunicationSocket,
	CommunicationSubscriptions,
} from "../../server/websocket/narrator-communication-ws";
import { resolveRemoteRequestRule } from "../../shared/remote-access/request-policy";
import {
	CommunicationTopologySubscriptions,
	type CommunicationTransport,
} from "./communication-subscription";
import type { MessageCallback } from "./narrator-ws-manager";

const scope: CommunicationScope = { kind: "narrator", narratorId: "source" };
const topology = (title = "initial"): CommunicationTopology => ({
	scope,
	truncated: false,
	peers: [],
	nodes: [
		{
			id: "source",
			title,
			status: "idle",
			parentNarratorId: null,
			groupId: "source",
			version: 1,
			canManage: true,
			canConnect: true,
			delegated: false,
			restoreParentId: null,
		},
	],
});
const deferred = <T>() => {
	let resolve!: (value: T) => void;
	let reject!: (reason: unknown) => void;
	const promise = new Promise<T>((a, b) => {
		resolve = a;
		reject = b;
	});
	return { promise, resolve, reject };
};
async function settle(predicate: () => boolean) {
	const deadline = Date.now() + 2000;
	while (!predicate()) {
		if (Date.now() > deadline) throw new Error("did not settle");
		await new Promise((resolve) => setTimeout(resolve, 2));
	}
}
function fixture(
	read: ConstructorParameters<typeof CommunicationSubscriptions>[0] = async () => topology(),
	timeoutMs = 1000,
) {
	const server = new CommunicationSubscriptions(read, { timeoutMs, coalesceMs: 1, maxReads: 2 });
	const receivers = new Set<MessageCallback>();
	const connections = new Set<(value: boolean, reconnect: boolean) => void>();
	const credentials = new Set<() => void>();
	const clientFrames: Record<string, unknown>[] = [];
	const serverFrames: Record<string, unknown>[] = [];
	let credential = 1;
	let connectedCredential = 1;
	let backlog = 0;
	let drop = false;
	const document = Object.assign(new EventTarget(), {
		visibilityState: "visible" as DocumentVisibilityState,
	});
	const lifecycle = { window: new EventTarget(), document };
	const receive = (frame: Record<string, unknown>) => {
		for (const callback of receivers) callback(frame);
	};
	const ws: CommunicationSocket = {
		data: { userId: "person" },
		send: (text) => {
			if (drop) return 0;
			const frame = JSON.parse(text);
			serverFrames.push(frame);
			receive(frame);
			return 1;
		},
		getBufferedAmount: () => backlog,
		close: mock(() => {}),
	};
	const transport: CommunicationTransport = {
		connected: true,
		send: (frame) => {
			clientFrames.push(frame);
			const parsed = narratorWsMessageSchema.parse(frame);
			if (parsed.type === "communication_subscribe" || parsed.type === "communication_unsubscribe")
				server.handle(ws, parsed);
			return true;
		},
		getCredentialIdentity: () => credential,
		getConnectionCredentialIdentity: () => connectedCredential,
		onCredentialChange: (callback) => {
			credentials.add(callback);
			return () => {
				credentials.delete(callback);
			};
		},
		reconnect: mock(() => {}),
		addListener: (_options, callback) => {
			receivers.add(callback);
			return { _id: 1 };
		},
		removeListener: () => {
			receivers.clear();
		},
		onConnectionChange: (callback) => {
			connections.add(callback);
			return () => {
				connections.delete(callback);
			};
		},
	};
	const client = new CommunicationTopologySubscriptions(transport, lifecycle);
	const watch = () => client.watch(scope, () => {});
	const sent = () => clientFrames.filter((frame) => frame.type === "communication_subscribe");
	const id = () => sent().at(-1)?.subscriptionId as string;
	const view = () => client.getSnapshot(scope);
	return {
		server,
		client,
		ws,
		transport,
		serverFrames,
		clientFrames,
		watch,
		sent,
		id,
		view,
		receive,
		backlog: (value: number) => {
			backlog = value;
		},
		drop: () => {
			drop = true;
		},
		connect(value: boolean) {
			Object.assign(transport, { connected: value });
			if (value) connectedCredential = credential;
			else server.release(ws);
			for (const cb of connections) cb(value, true);
		},
		credential(value: number) {
			credential = value;
			for (const cb of credentials) cb();
		},
		hidden(value: boolean) {
			document.visibilityState = value ? "hidden" : "visible";
			document.dispatchEvent(new Event("visibilitychange"));
		},
	};
}

test("remote HTTP policy allows only implemented candidates/manage/receipt routes, never HTTP topology", () => {
	const narrator = "a".repeat(21);
	for (const [method, suffix, expected] of [
		["GET", "/communication/candidates", true],
		["POST", "/communication", true],
		["GET", "/submissions/client-id", true],
		["GET", "/communication/topology", false],
		["GET", "/messages/submissions/client-id", false],
		["POST", "/submissions/client-id", false],
	] as const)
		expect(!!resolveRemoteRequestRule(method, `/api/narrators/${narrator}${suffix}`, "ready")).toBe(
			expected,
		);
	expect(
		resolveRemoteRequestRule(
			"GET",
			`/api/projects/${narrator}/teams/${narrator}/communication/topology`,
			"ready",
		),
	).toBeNull();
});

test("strict websocket schema admits narrator/team scopes and refuses broad or oversized requests", () => {
	for (const value of [scope, { kind: "team", projectId: "project", teamId: "team" }])
		expect(
			narratorWsMessageSchema.safeParse({
				type: "communication_subscribe",
				subscriptionId: "sub",
				scope: value,
			}).success,
		).toBe(true);
	for (const value of [
		{ kind: "all" },
		{ ...scope, extra: "x" },
		{ kind: "team", teamId: "team" },
		{ ...scope, narratorId: "x".repeat(129) },
	])
		expect(
			narratorWsMessageSchema.safeParse({
				type: "communication_subscribe",
				subscriptionId: "sub",
				scope: value,
			}).success,
		).toBe(false);
	expect(
		narratorWsMessageSchema.safeParse({ type: "communication_unsubscribe", subscriptionId: "sub" })
			.success,
	).toBe(true);
});

test("end-to-end snapshot and actual data delta share one ref-counted socket subscription", async () => {
	let current = topology();
	const read = mock(async () => structuredClone(current));
	const f = fixture(read);
	const stopA = f.watch();
	const stopB = f.watch();
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(1);
	expect(f.view().topology?.nodes[0].title).toBe("initial");
	current = topology("changed");
	for (let i = 0; i < 10; i++)
		f.server.onEvent({ type: "narrator:status_changed", narratorId: "source", status: "idle" });
	await settle(() => f.view().topology?.nodes[0].title === "changed");
	expect(read).toHaveBeenCalledTimes(2);
	expect(f.serverFrames.at(-1)).toMatchObject({ type: "communication_delta", baseSeq: 0, seq: 1 });
	stopA();
	expect(f.server.stats().total).toBe(1);
	stopB();
	expect(f.server.stats().total).toBe(0);
});

test("node groups, authorized team details and peers update as data and removals leave no sensitive endpoints", async () => {
	let current = topology();
	current.nodes.push({
		...current.nodes[0],
		id: "worker",
		groupId: "source",
		parentNarratorId: "source",
		delegated: true,
		team: {
			id: "team",
			name: "Readable team",
			workItem: { title: "Task" },
		},
	});
	current.peers.push({
		id: "peer",
		endpointLo: "source",
		endpointHi: "worker",
		createdAt: "now",
		canDisconnect: true,
	});
	const f = fixture(async () => structuredClone(current));
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	current.nodes[1] = {
		...current.nodes[1],
		groupId: "worker",
		parentNarratorId: null,
		version: 2,
		team: {
			id: "team",
			name: "Renamed team",
			workItem: { title: "Updated task" },
		},
	};
	f.server.onEvent({ type: "team:communication_changed", teamId: "team" });
	await settle(() => f.view().topology?.nodes[1].team?.name === "Renamed team");
	expect(f.view().topology?.nodes[1]).toMatchObject({
		parentNarratorId: null,
		groupId: "worker",
		team: { name: "Renamed team", workItem: { title: "Updated task" } },
	});
	current = topology();
	f.server.onEvent({ type: "narrator:deleted", narratorId: "worker", title: null });
	await settle(() => f.view().topology?.nodes.length === 1);
	expect(f.view().topology?.peers).toEqual([]);
	expect(f.serverFrames.at(-1)).toMatchObject({
		type: "communication_delta",
		baseSeq: 1,
		seq: 2,
		delta: { removeNodeIds: ["worker"], removePeerIds: ["peer"] },
	});
	stop();
});

test("dirty captured during initial snapshot is not lost and reads are single-flight", async () => {
	const pending = deferred<CommunicationTopology>();
	let calls = 0;
	const f = fixture(async () =>
		++calls === 1 ? pending.promise : topology("born during snapshot"),
	);
	const stop = f.watch();
	await settle(() => calls === 1);
	f.server.onEvent({ type: "narrator:communication_changed", narratorIds: ["child"] });
	expect(calls).toBe(1);
	pending.resolve(topology());
	await settle(() => f.view().topology?.nodes[0].title === "born during snapshot");
	expect(f.serverFrames.map((frame) => frame.type)).toEqual([
		"communication_snapshot",
		"communication_delta",
	]);
	stop();
});

test("access event synchronously erases cached facts and cancels a racing old-authority read", async () => {
	const pending = deferred<CommunicationTopology>();
	let calls = 0;
	let oldSignal: AbortSignal | undefined;
	const f = fixture(async (_scope, _principal, options) => {
		calls++;
		if (calls === 2) {
			oldSignal = options.signal;
			return pending.promise;
		}
		if (calls > 2) throw Object.assign(new Error("hidden"), { statusCode: 404 });
		return topology("sensitive");
	});
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	f.server.onEvent({ type: "narrator:communication_changed", narratorIds: ["source"] });
	await settle(() => calls === 2);
	f.server.onEvent({ type: "project:access_changed", projectId: "p", reason: "members_changed" });
	expect(f.view().topology).toBeNull();
	expect(oldSignal?.aborted).toBe(true);
	pending.resolve(topology("must never publish"));
	await settle(() => f.view().status === "denied");
	expect(f.serverFrames.some((frame) => JSON.stringify(frame).includes("must never publish"))).toBe(
		false,
	);
	stop();
});

test("duplicate and old epoch frames are ignored; a sequence gap causes only one snapshot resubscribe", async () => {
	const f = fixture();
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	const oldId = f.id();
	const snapshot = f.serverFrames[0];
	const delta = {
		type: "communication_delta",
		subscriptionId: oldId,
		epoch: snapshot.epoch,
		baseSeq: 0,
		seq: 1,
		delta: {
			upsertNodes: topology("next").nodes,
			removeNodeIds: [],
			upsertPeers: [],
			removePeerIds: [],
			truncated: false,
		},
	};
	f.receive(delta);
	expect(f.view().topology?.nodes[0].title).toBe("next");
	f.receive({ ...delta, delta: { ...delta.delta, upsertNodes: topology("duplicate").nodes } });
	f.receive({ ...delta, epoch: "old", seq: 2, baseSeq: 1 });
	expect(f.view().topology?.nodes[0].title).toBe("next");
	f.receive({ ...delta, baseSeq: 3, seq: 4 });
	f.receive({ ...delta, baseSeq: 4, seq: 5 });
	expect(f.view().topology).toBeNull();
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(2);
	expect(f.id()).not.toBe(oldId);
	f.receive({ ...snapshot, topology: topology("stale") });
	expect(f.view().topology?.nodes[0].title).toBe("initial");
	stop();
});

test("reconnect, hidden/unhidden and last-consumer release each establish fresh snapshots", async () => {
	const f = fixture();
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	const firstId = f.id();
	f.connect(false);
	expect(f.view().status).toBe("disconnected");
	expect(f.view().topology).toBeNull();
	f.connect(true);
	await settle(() => f.view().status === "live");
	expect(f.id()).not.toBe(firstId);
	f.hidden(true);
	expect(f.server.stats().total).toBe(0);
	expect(f.view().topology).toBeNull();
	f.hidden(false);
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(3);
	stop();
	expect(f.server.stats().total).toBe(0);
});

test("reopening after an unobserved visibility change rechecks current page state", async () => {
	const f = fixture();
	let stop = f.watch();
	await settle(() => f.view().status === "live");
	f.hidden(true);
	stop();
	f.hidden(false); // No listeners remain at this point.
	stop = f.watch();
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(2);
	stop();
});

test("credential transition clears cache immediately and cannot subscribe on old account socket", async () => {
	const f = fixture();
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	const old = f.serverFrames[0];
	f.credential(2);
	expect(f.view().topology).toBeNull();
	expect(f.transport.reconnect).toHaveBeenCalledTimes(1);
	f.receive(old);
	expect(f.view().topology).toBeNull();
	expect(f.sent()).toHaveLength(1);
	f.connect(false);
	f.connect(true);
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(2);
	stop();
});

test("credential changes while disconnected/connecting retire the pending old-account handshake", () => {
	const f = fixture();
	f.connect(false);
	const stop = f.watch();
	f.credential(2);
	expect(f.transport.reconnect).toHaveBeenCalledTimes(1);
	expect(f.sent()).toHaveLength(0);
	expect(f.view().topology).toBeNull();
	stop();
});

test("same subscription id replaces old object; canceled late snapshot never escapes", async () => {
	const pending = deferred<CommunicationTopology>();
	let calls = 0;
	let signal: AbortSignal | undefined;
	const f = fixture(async (_scope, _principal, options) => {
		calls++;
		if (calls === 1) {
			signal = options.signal;
			return pending.promise;
		}
		return topology("new object");
	});
	const message = { type: "communication_subscribe" as const, subscriptionId: "same", scope };
	f.server.handle(f.ws, message);
	await settle(() => calls === 1);
	f.server.handle(f.ws, message);
	expect(signal?.aborted).toBe(true);
	await settle(() => f.serverFrames.length === 1);
	pending.resolve(topology("old object"));
	await Promise.resolve();
	expect(f.serverFrames).toHaveLength(1);
	expect(f.serverFrames[0]).toMatchObject({ topology: { nodes: [{ title: "new object" }] } });
	f.server.release(f.ws);
});

test("timeout and worker failures are unavailable, never empty success or main-thread fallback", async () => {
	for (const fail of [false, true]) {
		let signal: AbortSignal | undefined;
		const read = mock(
			async (_scope: CommunicationScope, _principal: unknown, options: { signal: AbortSignal }) => {
				signal = options.signal;
				if (fail) throw new Error("worker unavailable");
				return new Promise<CommunicationTopology>(() => {});
			},
		);
		const f = fixture(read, 10);
		const stop = f.watch();
		await settle(() => f.view().status === "unavailable");
		expect(f.serverFrames.map((frame) => frame.type)).toEqual(["communication_error"]);
		expect(read).toHaveBeenCalledTimes(1);
		if (!fail) expect(signal?.aborted).toBe(true);
		stop();
	}
});

test("unsubscribe cancels pending read and releases global budget", async () => {
	let signal: AbortSignal | undefined;
	const f = fixture(async (_scope, _principal, options) => {
		signal = options.signal;
		return new Promise<CommunicationTopology>(() => {});
	});
	const stop = f.watch();
	await settle(() => !!signal);
	stop();
	expect(signal?.aborted).toBe(true);
	await settle(() => f.server.stats().reading === 0);
	expect(f.server.stats().total).toBe(0);
	expect(f.serverFrames).toHaveLength(0);
});

test("server projection budgets fail closed and socket backlog/drop force reconnect", async () => {
	const manyNodes = topology();
	manyNodes.nodes = Array.from({ length: limits.maxVisibleNodes + 1 }, (_, i) => ({
		...manyNodes.nodes[0],
		id: `node-${i}`,
	}));
	const manyPeers = topology();
	manyPeers.peers = Array.from({ length: limits.maxVisiblePeers + 1 }, (_, i) => ({
		id: `peer-${i}`,
		endpointLo: "a",
		endpointHi: "b",
		createdAt: "now",
		canDisconnect: true,
	}));
	for (const oversized of [topology("x".repeat(limits.maxSnapshotBytes)), manyNodes, manyPeers]) {
		const f = fixture(async () => oversized);
		const stop = f.watch();
		await settle(() => f.view().status === "unavailable");
		expect(f.serverFrames).toHaveLength(1);
		stop();
	}
	for (const drop of [false, true]) {
		const f = fixture();
		if (drop) f.drop();
		else f.backlog(limits.maxBufferedBytes);
		const stop = f.watch();
		await settle(() => (f.ws.close as ReturnType<typeof mock>).mock.calls.length > 0);
		expect(f.server.stats().total).toBe(0);
		expect(f.serverFrames).toHaveLength(0);
		stop();
	}
});

test("overflowing client projection resyncs and rejects dangling peer deltas atomically", async () => {
	const f = fixture();
	const stop = f.watch();
	await settle(() => f.view().status === "live");
	const snapshot = f.serverFrames[0];
	f.receive({
		type: "communication_delta",
		subscriptionId: f.id(),
		epoch: snapshot.epoch,
		seq: 1,
		baseSeq: 0,
		delta: {
			upsertNodes: [],
			removeNodeIds: [],
			upsertPeers: [{ id: "bad", endpointLo: "source", endpointHi: "hidden" }],
			removePeerIds: [],
			truncated: false,
		},
	});
	expect(f.view().topology).toBeNull();
	await settle(() => f.view().status === "live");
	expect(f.sent()).toHaveLength(2);
	f.receive({
		type: "communication_delta",
		subscriptionId: f.id(),
		epoch: f.serverFrames.at(-1)?.epoch,
		seq: 1,
		baseSeq: 0,
		padding: "x".repeat(limits.maxBufferedBytes),
	});
	await settle(() => f.sent().length === 3);
	stop();
});

test("socket and global subscription ceilings and read concurrency are bounded", async () => {
	let active = 0;
	let maxActive = 0;
	const server = new CommunicationSubscriptions(
		async (_scope, _principal, { signal }) => {
			active++;
			maxActive = Math.max(maxActive, active);
			return new Promise<CommunicationTopology>((_, reject) =>
				signal.addEventListener("abort", () => {
					active--;
					reject(new Error("canceled"));
				}),
			);
		},
		{ timeoutMs: 1000, coalesceMs: 1, maxReads: 2 },
	);
	const sockets: CommunicationSocket[] = [];
	const frames: Record<string, unknown>[] = [];
	for (let i = 0; i <= limits.maxSubscriptions / 4; i++) {
		const ws: CommunicationSocket = {
			data: { userId: "person" },
			send: (text) => {
				frames.push(JSON.parse(text));
				return 1;
			},
		};
		sockets.push(ws);
		for (let j = 0; j < 5; j++)
			server.handle(ws, { type: "communication_subscribe", subscriptionId: `${j}`, scope });
	}
	expect(server.stats().total).toBe(limits.maxSubscriptions);
	expect(frames.every((frame) => frame.code === "unavailable")).toBe(true);
	await settle(() => server.stats().reading === 2);
	expect(maxActive).toBe(2);
	for (const ws of sockets) server.release(ws);
	await settle(() => server.stats().reading === 0);
	expect(server.stats().total).toBe(0);
});

test("anonymous/public-share sockets cannot acquire topology authorization", () => {
	const f = fixture();
	delete f.ws.data.userId;
	f.server.handle(f.ws, { type: "communication_subscribe", subscriptionId: "anonymous", scope });
	f.ws.data.userId = "person";
	f.ws.data.publicShare = {};
	f.server.handle(f.ws, { type: "communication_subscribe", subscriptionId: "share", scope });
	expect(f.serverFrames).toEqual([
		{ type: "communication_error", subscriptionId: "anonymous", code: "access_denied" },
		{ type: "communication_error", subscriptionId: "share", code: "access_denied" },
	]);
	expect(f.server.stats().total).toBe(0);
});
