import { expect, test } from "bun:test";
import { topologyFixture } from "./topology-fixture-data";
import {
	disconnectAction,
	layoutTopology,
	nodeDropIntent,
	peerPath,
	subtreeSize,
} from "./topology-model";

for (const width of [280, 360, 420, 720, 1024])
	test(`layout ${width}: readable cards, bounded channels and stable status updates`, () => {
		const topology = topologyFixture();
		const first = layoutTopology(topology, width);
		expect(first.mode).toBe(width >= 720 ? "wide" : width >= 420 ? "compact" : "narrow");
		for (const node of first.nodes) {
			expect(node.width).toBeGreaterThanOrEqual(164);
			expect(node.x + node.width).toBeLessThan(width);
			expect(node.height).toBe(48);
		}
		const updated = layoutTopology(
			{
				...topology,
				nodes: [...topology.nodes]
					.reverse()
					.map((node) => ({ ...node, status: "working", title: `${node.title} updated` })),
			},
			width,
		);
		expect(updated.nodes.map(({ x, y, width, node }) => [node.id, x, y, width])).toEqual(
			first.nodes.map(({ x, y, width, node }) => [node.id, x, y, width]),
		);
		const a = first.nodes.find((n) => n.node.id === "worker");
		const b = first.nodes.find((n) => n.node.id === "reviewer");
		if (!a || !b) throw new Error("Missing exact endpoints");
		expect(peerPath(a, b, first, 0)).toContain(`${a.y + a.height / 2}`);
	});

test("frames use team names, with root session titles only for unteamed groups", () => {
	const topology = topologyFixture();
	expect(layoutTopology(topology, 1024).groups.map((group) => [group.id, group.title])).toEqual([
		["root", "Release crew"],
		["external", "Design studio"],
	]);
	delete topology.nodes[0].team;
	expect(layoutTopology(topology, 1024).groups[0].title).toBe("Release coordinator");
});

test("split communication groups keep their team label without merging back together", () => {
	const topology = topologyFixture();
	topology.nodes[1].parentNarratorId = null;
	topology.nodes[1].groupId = "worker";
	topology.nodes[2].groupId = "worker";
	const groups = layoutTopology(topology, 360).groups;
	expect(groups.filter((group) => group.title === "Release crew").map((group) => group.id)).toEqual(
		["root", "worker"],
	);
	expect(groups).toHaveLength(3);
});

test("dropping onto original delegator restores before peer creation; other domains never reparent", () => {
	const topology = topologyFixture();
	const worker = topology.nodes.find((node) => node.id === "worker");
	if (!worker) throw new Error("Missing worker");
	expect(subtreeSize(topology, worker.id)).toBe(2);
	expect(nodeDropIntent(topology, worker.id, "split", true)).toMatchObject({
		kind: "allowed",
		count: 2,
		action: { mutation: { kind: "split", version: 1 } },
	});
	worker.parentNarratorId = null;
	worker.groupId = worker.id;
	expect(nodeDropIntent(topology, worker.id, "root", true)).toMatchObject({
		kind: "allowed",
		label: "restore",
	});
	expect(nodeDropIntent(topology, worker.id, "external", true)).toMatchObject({
		kind: "allowed",
		label: "connect",
	});
	expect(nodeDropIntent(topology, worker.id, "reviewer", true)).toEqual({
		kind: "rejected",
		reason: "connected",
	});
});

test("no permission, offline, self and same-domain drops reject without alternate side effects", () => {
	const topology = topologyFixture();
	expect(nodeDropIntent(topology, "helper", "root", true)).toEqual({
		kind: "rejected",
		reason: "sameGroup",
	});
	expect(nodeDropIntent(topology, "helper", "helper", true)).toEqual({
		kind: "rejected",
		reason: "self",
	});
	expect(nodeDropIntent(topology, "helper", "external", false)).toEqual({
		kind: "rejected",
		reason: "offline",
	});
	expect(nodeDropIntent(topologyFixture(true), "helper", "external", true)).toEqual({
		kind: "rejected",
		reason: "readonly",
	});
});

test("external groups collapse without hiding specific connected endpoints; branches are bounded", () => {
	const topology = topologyFixture();
	for (let i = 0; i < 10; i++) topology.nodes.push({ ...topology.nodes[4], id: `other-${i}` });
	const layout = layoutTopology(topology, 360);
	expect(layout.groups.find((group) => group.id === "external")?.hidden).toBe(10);
	expect(layout.nodes.some((node) => node.node.id === "reviewer")).toBe(true);
	expect(
		layoutTopology(topology, 360, new Set(["worker"])).nodes.some((n) => n.node.id === "helper"),
	).toBe(false);
});

test("disconnect chooses a writable Hi endpoint and never falls back to a readonly source", () => {
	const topology = topologyFixture();
	const peer = topology.peers[0];
	const lo = topology.nodes.find((node) => node.id === peer.endpointLo);
	const hi = topology.nodes.find((node) => node.id === peer.endpointHi);
	if (!lo || !hi) throw new Error("Missing precise endpoints");
	lo.canManage = false;
	expect(disconnectAction(peer, topology.nodes)).toEqual({
		sourceId: hi.id,
		mutation: { kind: "disconnect", peerId: peer.id },
	});
	hi.canManage = false;
	expect(disconnectAction(peer, topology.nodes)).toBeNull();
	hi.canManage = true;
	expect(disconnectAction({ ...peer, canDisconnect: false }, topology.nodes)).toBeNull();
	expect(disconnectAction(peer, [])).toBeNull();
});
