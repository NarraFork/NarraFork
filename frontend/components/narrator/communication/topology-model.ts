import type {
	CommunicationMutation,
	CommunicationNode,
	CommunicationPeer,
	CommunicationTopology,
} from "@shared/narrator-communication";

export interface Rect {
	x: number;
	y: number;
	width: number;
	height: number;
}
export interface PlacedNode extends Rect {
	node: CommunicationNode;
	depth: number;
	descendants: number;
}
export interface PlacedGroup extends Rect {
	id: string;
	root: CommunicationNode;
	title: string | null;
	count: number;
	hidden: number;
	current: boolean;
}
export interface TopologyLayout {
	nodes: PlacedNode[];
	groups: PlacedGroup[];
	width: number;
	height: number;
	mode: "wide" | "compact" | "narrow";
}
export interface TopologyAction {
	sourceId: string;
	mutation: CommunicationMutation;
}
export type DropIntent =
	| {
			kind: "allowed";
			action: TopologyAction;
			label: "connect" | "split" | "restore" | "disconnect";
			count?: number;
	  }
	| {
			kind: "rejected";
			reason: "offline" | "readonly" | "self" | "sameGroup" | "connected" | "invalid";
	  };

/** Stable topology order deliberately ignores titles, live status and incoming DTO order. */
export function orderedGroup(nodes: CommunicationNode[], collapsed = new Set<string>()) {
	const ids = new Set(nodes.map((node) => node.id));
	const children = new Map<string, CommunicationNode[]>();
	for (const node of nodes) {
		const key =
			node.parentNarratorId && ids.has(node.parentNarratorId) ? node.parentNarratorId : "";
		const list = children.get(key) ?? [];
		list.push(node);
		children.set(key, list);
	}
	for (const list of children.values()) list.sort((a, b) => a.id.localeCompare(b.id));
	const ordered: { node: CommunicationNode; depth: number; descendants: number }[] = [];
	const visited = new Set<string>();
	const count = (id: string, seen = new Set<string>()): number => {
		if (seen.has(id)) return 0;
		seen.add(id);
		return (children.get(id) ?? []).reduce((n, node) => n + 1 + count(node.id, seen), 0);
	};
	const visit = (node: CommunicationNode, depth: number) => {
		if (visited.has(node.id)) return;
		visited.add(node.id);
		ordered.push({ node, depth, descendants: count(node.id) });
		if (!collapsed.has(node.id))
			for (const child of children.get(node.id) ?? []) visit(child, depth + 1);
	};
	for (const node of children.get("") ?? []) visit(node, 0);
	// A corrupt display projection must remain bounded, never recurse forever.
	if (!ordered.length && nodes[0]) visit(nodes[0], 0);
	return ordered;
}

export function layoutTopology(
	topology: CommunicationTopology,
	containerWidth: number,
	collapsed = new Set<string>(),
	expandedGroups = new Set<string>(),
): TopologyLayout {
	const width = Math.max(240, containerWidth);
	const mode = width >= 720 ? "wide" : width >= 420 ? "compact" : "narrow";
	const scope = topology.scope;
	const anchor =
		scope.kind === "narrator"
			? topology.nodes.find((node) => node.id === scope.narratorId)?.groupId
			: topology.nodes.find((node) => node.team?.id === scope.teamId)?.groupId;
	const grouped = new Map<string, CommunicationNode[]>();
	for (const node of topology.nodes) {
		const list = grouped.get(node.groupId) ?? [];
		list.push(node);
		grouped.set(node.groupId, list);
	}
	const ids = [...grouped.keys()].sort((a, b) =>
		a === anchor ? -1 : b === anchor ? 1 : a.localeCompare(b),
	);
	const nodes: PlacedNode[] = [];
	const groups: PlacedGroup[] = [];
	const margin = mode === "narrow" ? 10 : 18;
	const corridor = mode === "wide" ? 80 : 30;
	const groupWidth =
		mode === "wide" ? (width - margin * 2 - corridor) / 2 : width - margin * 2 - corridor;
	const columns = [18, 18];
	for (const id of ids) {
		const members = grouped.get(id) ?? [];
		const current =
			id === anchor || (scope.kind === "team" && members.some((n) => n.team?.id === scope.teamId));
		const sorted = orderedGroup(members, collapsed);
		const root = sorted[0]?.node;
		if (!root) continue;
		const externalCollapsed = !current && members.length > 4 && !expandedGroups.has(id);
		const peerIds = new Set(topology.peers.flatMap((p) => [p.endpointLo, p.endpointHi]));
		const shown = externalCollapsed
			? sorted.filter((entry, i) => i === 0 || peerIds.has(entry.node.id))
			: sorted;
		const column = mode === "wide" && id !== anchor ? 1 : 0;
		const x = margin + (column ? groupWidth + corridor : 0);
		const y = mode === "wide" ? columns[column] : Math.max(...columns);
		const height = 64 + shown.length * 56 + (shown.length < members.length ? 40 : 0);
		groups.push({
			id,
			root,
			title: root.team?.name?.trim() || root.title,
			count: members.length,
			hidden: members.length - shown.length,
			current,
			x,
			y,
			width: groupWidth,
			height,
		});
		shown.forEach((entry, i) => {
			const indent = Math.min(entry.depth, mode === "narrow" ? 2 : 4) * 10;
			nodes.push({
				...entry,
				x: x + 12 + indent,
				y: y + 56 + i * 56,
				width: groupWidth - 24 - indent,
				height: 48,
			});
		});
		columns[column] = y + height + (mode === "wide" ? 28 : 64);
	}
	return { nodes, groups, width, height: Math.max(340, ...columns) + 30, mode };
}

export function subtreeSize(topology: CommunicationTopology, sourceId: string): number {
	const descendants = new Set([sourceId]);
	for (let pass = 0; pass < topology.nodes.length; pass++) {
		let changed = false;
		for (const node of topology.nodes)
			if (
				node.parentNarratorId &&
				descendants.has(node.parentNarratorId) &&
				!descendants.has(node.id)
			) {
				descendants.add(node.id);
				changed = true;
			}
		if (!changed) break;
	}
	return descendants.size;
}

export function nodeDropIntent(
	topology: CommunicationTopology,
	sourceId: string,
	targetId: string | "split",
	live: boolean,
): DropIntent {
	if (!live) return { kind: "rejected", reason: "offline" };
	const source = topology.nodes.find((node) => node.id === sourceId);
	if (!source) return { kind: "rejected", reason: "invalid" };
	if (targetId === "split")
		return source.canManage && source.parentNarratorId
			? {
					kind: "allowed",
					action: { sourceId, mutation: { kind: "split", version: source.version } },
					label: "split",
					count: subtreeSize(topology, sourceId),
				}
			: { kind: "rejected", reason: source.canManage ? "invalid" : "readonly" };
	if (sourceId === targetId) return { kind: "rejected", reason: "self" };
	const target = topology.nodes.find((node) => node.id === targetId);
	if (!target) return { kind: "rejected", reason: "invalid" };
	// The designated delegator landing zone restores first, never silently makes a peer.
	if (!source.parentNarratorId && source.restoreParentId === targetId)
		return source.canManage && target.canManage
			? {
					kind: "allowed",
					action: { sourceId, mutation: { kind: "restore", version: source.version } },
					label: "restore",
				}
			: { kind: "rejected", reason: "readonly" };
	if (!source.canConnect || !target.canConnect) return { kind: "rejected", reason: "readonly" };
	if (source.groupId === target.groupId) return { kind: "rejected", reason: "sameGroup" };
	if (
		topology.peers.some(
			(peer) =>
				(peer.endpointLo === sourceId && peer.endpointHi === targetId) ||
				(peer.endpointHi === sourceId && peer.endpointLo === targetId),
		)
	)
		return { kind: "rejected", reason: "connected" };
	return {
		kind: "allowed",
		action: { sourceId, mutation: { kind: "connect", targetNarratorId: targetId } },
		label: "connect",
	};
}

export function disconnectAction(
	peer: CommunicationPeer,
	nodes: readonly CommunicationNode[],
): TopologyAction | null {
	const source = nodes.find(
		(node) => node.canManage && (node.id === peer.endpointLo || node.id === peer.endpointHi),
	);
	return peer.canDisconnect && source
		? { sourceId: source.id, mutation: { kind: "disconnect", peerId: peer.id } }
		: null;
}

/** Every cross-domain path is attached to the two specific cards, not a domain frame. */
export function peerPath(
	a: PlacedNode,
	b: PlacedNode,
	layout: TopologyLayout,
	index: number,
): string {
	if (layout.mode === "wide" && Math.abs(a.x - b.x) > a.width) {
		const left = a.x < b.x ? a : b;
		const right = left === a ? b : a;
		const x1 = left.x + left.width;
		const x2 = right.x;
		const y1 = left.y + left.height / 2;
		const y2 = right.y + right.height / 2;
		return `M${x1},${y1} C${x1 + 34},${y1} ${x2 - 34},${y2} ${x2},${y2}`;
	}
	const lane = layout.width - 14 - (index % 4) * 5;
	return `M${a.x + a.width},${a.y + a.height / 2} H${lane} V${b.y + b.height / 2} H${b.x + b.width}`;
}
