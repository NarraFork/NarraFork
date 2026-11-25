import type { CommunicationNode, CommunicationTopology } from "@shared/narrator-communication";

/** Authorized lightweight DTOs, no real database or execution principal in browser fixtures. */
export function topologyFixture(readOnly = false): CommunicationTopology {
	const node = (
		id: string,
		title: string,
		groupId: string,
		parentNarratorId: string | null,
		team = "Release crew",
	): CommunicationNode => ({
		id,
		title,
		groupId,
		parentNarratorId,
		status: "idle",
		version: 1,
		canManage: !readOnly,
		canConnect: !readOnly,
		restoreParentId: parentNarratorId,
		delegated: !!parentNarratorId,
		team: {
			id: team === "Release crew" ? "team-a" : "team-b",
			name: team,
			...(id === "worker" ? { workItem: { title: "Ship accessible communication topology" } } : {}),
		},
	});
	return {
		scope: { kind: "narrator", narratorId: "root" },
		nodes: [
			node("root", "Release coordinator", "root", null),
			node("worker", "Topology implementation", "root", "root"),
			node(
				"helper",
				"Keyboard & touch review · a deliberately long session title",
				"root",
				"worker",
			),
			node("external", "Design review", "external", null, "Design studio"),
			node(
				"reviewer",
				"Independent accessibility reviewer",
				"external",
				"external",
				"Design studio",
			),
		],
		peers: [
			{
				id: "initial-peer",
				endpointLo: "reviewer",
				endpointHi: "worker",
				createdAt: "2026-01-15T12:00:00Z",
				canDisconnect: !readOnly,
			},
		],
		truncated: false,
	};
}
