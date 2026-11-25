import { describe, expect, test } from "bun:test";
import {
	applyCommunicationTopologyDelta,
	type CommunicationNode,
	type CommunicationTopology,
	canonicalCommunicationPair,
	communicationScopeKey,
	diffCommunicationTopology,
} from "./narrator-communication";

function node(id: string, groupId = "a"): CommunicationNode {
	return {
		id,
		title: id,
		status: "idle",
		parentNarratorId: null,
		groupId,
		version: 1,
		canManage: true,
		canConnect: true,
		restoreParentId: null,
		delegated: false,
	};
}
function topology(): CommunicationTopology {
	return {
		scope: { kind: "narrator", narratorId: "a" },
		nodes: [node("a"), node("b", "b")],
		peers: [
			{
				id: "edge",
				endpointLo: "a",
				endpointHi: "b",
				createdAt: "2026-11-24T00:00:00Z",
				canDisconnect: true,
			},
		],
		truncated: false,
	};
}

describe("communication protocol", () => {
	test("scope keys keep team and narrator resources separate", () => {
		expect(communicationScopeKey({ kind: "narrator", narratorId: "x" })).not.toBe(
			communicationScopeKey({ kind: "team", projectId: "p", teamId: "x" }),
		);
	});
	test("peer identity is undirected, exact and independent of collation", () => {
		expect(canonicalCommunicationPair("Z", "a")).toEqual(["Z", "a"]);
		expect(canonicalCommunicationPair("a", "Z")).toEqual(["Z", "a"]);
		for (const pair of [
			["a", "a"],
			["", "a"],
			["a/b", "b"],
		])
			expect(() => canonicalCommunicationPair(pair[0], pair[1])).toThrow();
	});
	test("diff and apply preserve a split subtree and explicit peer", () => {
		const before = topology();
		const next = { ...before, nodes: [node("a"), { ...node("b", "new-root"), version: 2 }] };
		const delta = diffCommunicationTopology(before, next);
		expect(delta.upsertNodes.map((item) => item.id)).toEqual(["b"]);
		expect(delta.upsertPeers).toEqual([]);
		expect(applyCommunicationTopologyDelta(before, delta)).toEqual(next);
		expect(before.nodes[1].version).toBe(1);
	});
	test("revoking a node cannot leave its edge behind", () => {
		const before = topology();
		const delta = {
			upsertNodes: [],
			removeNodeIds: ["b"],
			upsertPeers: [],
			removePeerIds: [],
			truncated: false,
		};
		const next = applyCommunicationTopologyDelta(before, delta);
		expect(next.nodes.map((item) => item.id)).toEqual(["a"]);
		expect(next.peers).toEqual([]);
		expect(before.peers).toHaveLength(1);
	});
	test("a dangling upsert fails without partially mutating the previous projection", () => {
		const before = topology();
		expect(() =>
			applyCommunicationTopologyDelta(before, {
				upsertNodes: [],
				removeNodeIds: [],
				upsertPeers: [{ ...before.peers[0], endpointHi: "hidden" }],
				removePeerIds: [],
				truncated: false,
			}),
		).toThrow();
		expect(before.peers[0].endpointHi).toBe("b");
	});
	test("different scopes require a snapshot, never a delta", () => {
		const before = topology();
		expect(() =>
			diffCommunicationTopology(before, {
				...before,
				scope: { kind: "narrator", narratorId: "other" },
			}),
		).toThrow();
	});
});
