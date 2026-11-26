/** Communication is independent of delegation, control grants and result delivery. */
export const COMMUNICATION_LIMITS = {
	maxDepth: 16,
	maxReferences: 16,
	maxVisibleNodes: 200,
	maxVisiblePeers: 400,
	maxSnapshotBytes: 512 * 1024,
	maxSubscriptionsPerSocket: 4,
	maxSubscriptions: 512,
	maxBufferedBytes: 1024 * 1024,
	searchQueryChars: 128,
	searchDefaultLimit: 20,
	searchMaxLimit: 50,
	searchThrottleMs: 250,
	searchTimeoutMs: 5000,
	coalesceMs: 50,
} as const;

export type CommunicationScope =
	| { kind: "narrator"; narratorId: string }
	| { kind: "team"; projectId: string; teamId: string };

export interface CommunicationCandidate {
	id: string;
	title: string | null;
	handle?: string | null;
	status: string;
	lastActivityAt: string | null;
	isRecent: boolean;
	canConnect: boolean;
	connected?: boolean;
	sameGroup?: boolean;
	parentTitle?: string | null;
}

export interface CommunicationCandidates {
	items: CommunicationCandidate[];
	hasMore: boolean;
}

export interface CommunicationTeamAnnotation {
	id: string;
	name: string;
	workItem?: { title: string };
}

export interface CommunicationNode {
	id: string;
	title: string | null;
	handle?: string | null;
	status: string;
	substatus?: string[];
	/** Projected communication parent, never the controller or historical parent. */
	parentNarratorId: string | null;
	/** Display domain; a projection must not disclose an unreadable root's identity. */
	groupId: string;
	version: number;
	canManage: boolean;
	canConnect: boolean;
	/** Only expose an original delegator the viewer may read and restore to. */
	restoreParentId: string | null;
	delegated: boolean;
	team?: CommunicationTeamAnnotation;
}

export interface CommunicationPeer {
	id: string;
	endpointLo: string;
	endpointHi: string;
	createdAt: string;
	canDisconnect: boolean;
}

export interface CommunicationTopology {
	scope: CommunicationScope;
	nodes: CommunicationNode[];
	peers: CommunicationPeer[];
	truncated: boolean;
}

export interface CommunicationTopologyDelta {
	upsertNodes: CommunicationNode[];
	removeNodeIds: string[];
	upsertPeers: CommunicationPeer[];
	removePeerIds: string[];
	truncated: boolean;
}

export type CommunicationClientMessage =
	| { type: "communication_subscribe"; subscriptionId: string; scope: CommunicationScope }
	| { type: "communication_unsubscribe"; subscriptionId: string };

export type CommunicationServerMessage =
	| {
			type: "communication_snapshot";
			subscriptionId: string;
			epoch: string;
			seq: number;
			topology: CommunicationTopology;
	  }
	| {
			type: "communication_delta";
			subscriptionId: string;
			epoch: string;
			baseSeq: number;
			seq: number;
			delta: CommunicationTopologyDelta;
	  }
	| {
			type: "communication_error";
			subscriptionId: string;
			code: "access_denied" | "unavailable" | "resync_required";
	  };

export type CommunicationMutation =
	| { kind: "connect"; targetNarratorId: string }
	| { kind: "disconnect"; peerId: string }
	| { kind: "split"; version: number }
	| { kind: "restore"; version: number };

export interface CommunicationMutationResult {
	changed: boolean;
}

/** Restoring an archive never turns its links into portable access grants. */
export interface CommunicationImportReport {
	nodesInserted: number;
	nodesPreserved: number;
	parentsDetachedMissingEndpoints: number;
	parentsDetachedUnauthorized: number;
	peersRestored: number;
	peersSkipped: number;
	peersMissingEndpoints: number;
	peersUnauthorized: number;
	peersInvalid: number;
	peersAlreadyPresent: number;
}

export function communicationScopeKey(scope: CommunicationScope): string {
	return JSON.stringify(
		scope.kind === "narrator"
			? ["narrator", scope.narratorId]
			: ["team", scope.projectId, scope.teamId],
	);
}

/** One canonical key in both stores; never rely on database locale collation. */
export function canonicalCommunicationPair(a: string, b: string): [string, string] {
	const valid = (id: string) => /^[A-Za-z0-9_-]{1,128}$/u.test(id);
	if (!valid(a) || !valid(b) || a === b) throw new Error("Invalid communication endpoints");
	return a < b ? [a, b] : [b, a];
}

export function diffCommunicationTopology(
	previous: CommunicationTopology,
	next: CommunicationTopology,
): CommunicationTopologyDelta {
	if (communicationScopeKey(previous.scope) !== communicationScopeKey(next.scope))
		throw new Error("Communication topology scope changed");
	const oldNodes = new Map(previous.nodes.map((node) => [node.id, node]));
	const oldPeers = new Map(previous.peers.map((peer) => [peer.id, peer]));
	const nodeIds = new Set(next.nodes.map((node) => node.id));
	const peerIds = new Set(next.peers.map((peer) => peer.id));
	return {
		upsertNodes: next.nodes.filter(
			(node) => JSON.stringify(oldNodes.get(node.id)) !== JSON.stringify(node),
		),
		removeNodeIds: previous.nodes.filter((node) => !nodeIds.has(node.id)).map((node) => node.id),
		upsertPeers: next.peers.filter(
			(peer) => JSON.stringify(oldPeers.get(peer.id)) !== JSON.stringify(peer),
		),
		removePeerIds: previous.peers.filter((peer) => !peerIds.has(peer.id)).map((peer) => peer.id),
		truncated: next.truncated,
	};
}

/** Apply a whole frame atomically; removing a node cannot leave a sensitive dangling edge. */
export function applyCommunicationTopologyDelta(
	previous: CommunicationTopology,
	delta: CommunicationTopologyDelta,
): CommunicationTopology {
	const nodes = new Map(previous.nodes.map((node) => [node.id, node]));
	const peers = new Map(previous.peers.map((peer) => [peer.id, peer]));
	for (const id of delta.removeNodeIds) nodes.delete(id);
	for (const node of delta.upsertNodes) nodes.set(node.id, node);
	for (const id of delta.removePeerIds) peers.delete(id);
	for (const [id, peer] of peers)
		if (!nodes.has(peer.endpointLo) || !nodes.has(peer.endpointHi)) peers.delete(id);
	for (const peer of delta.upsertPeers) {
		if (
			!nodes.has(peer.endpointLo) ||
			!nodes.has(peer.endpointHi) ||
			peer.endpointLo === peer.endpointHi
		)
			throw new Error("Invalid communication delta endpoint");
		peers.set(peer.id, peer);
	}
	if (
		nodes.size > COMMUNICATION_LIMITS.maxVisibleNodes ||
		peers.size > COMMUNICATION_LIMITS.maxVisiblePeers
	)
		throw new Error("Communication projection exceeds budget");
	return {
		scope: previous.scope,
		nodes: [...nodes.values()],
		peers: [...peers.values()],
		truncated: delta.truncated,
	};
}
