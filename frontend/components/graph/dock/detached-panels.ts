/**
 * Tool panels torn out of a chapter node's dock and living as their own canvas
 * nodes.
 *
 * Persisted per chapter in `chapters.detachedPanelsJson`. Kept in its own column
 * rather than inside `dockLayoutJson`: that field holds the EXPANDED chapter
 * node's own dockview layout, and these are separate surfaces.
 *
 * The host narrator is NOT stored. A detached panel belongs to the chapter whose
 * column it lives in, and the narrator is resolved from that chapter at render
 * time — the same rule the dock layout follows, so a fork or split that changes a
 * chapter's primary narrator cannot leave a stale id behind.
 *
 * Each node hosts a REAL dockview surface, so its contents are described by
 * dockview's own `SerializedDockview` rather than by a list we interpret. That is
 * what gives these nodes tab dragging, reordering, middle-click close and split
 * layouts without re-implementing any of it.
 *
 * Three envelope shapes are readable, because two predate that:
 *
 *  - v1: one entry per PANEL, kind + geometry inline.
 *  - v2: one entry per NODE, with a `panels[]` list and an `activePanelId`.
 *  - v3: one entry per NODE, with a dockview `layout`.
 *
 * v1 and v2 upgrade to `pendingPanels` (see below) rather than to a layout: this
 * module is pure, and building a layout needs a live `DockviewApi`.
 *
 * Storage-free by design: parse / serialize / mutate here, transport in the hook.
 */

import type { SerializedDockview } from "dockview-react";
import { filePanelIdentity } from "../../narrator/dock/dock-panel-types";
import { filePanelResourceId, filePanelResourceParams } from "../../narrator/panels/panel-kind";
import {
	isToolEditReference,
	type ToolEditReference,
} from "../../narrator/tool-call/tool-edit-reference";
import { type DetachablePanelKind, isDetachablePanelKind, isMultiInstanceKind } from "./detachable";

/** Current envelope schema version. */
export const DETACHED_PANELS_VERSION = 3 as const;

/**
 * Cap on simultaneously detached PANELS per chapter (not nodes).
 *
 * Each panel holds its own live session (a narrator WebSocket, an xterm attached
 * to a PTY, a browser session), so this is a resource ceiling, not a UI
 * preference.
 *
 * Only enforced on the upgrade path and when creating a node, where we can still
 * count panels. Once a node owns a dockview layout, panels inside it are
 * dockview's business and are not policed here — moving a panel between nodes
 * creates no new session, so there is nothing for a cap to protect.
 */
export const MAX_DETACHED_PANELS = 8;

/**
 * Mirrors the server validator's byte cap. Sized for dockview layouts (one per
 * node, several nodes per chapter), matching the chapter dock-layout column.
 */
export const DETACHED_PANELS_MAX_BYTES = 65536;

/**
 * A panel to be created when a node first mounts.
 *
 * Only produced by the v1/v2 upgrade path, and by the initial tear-out (which
 * knows the kind but has no layout yet). The surface turns these into real
 * dockview panels in `onReady`, after which persistence writes a `layout` and the
 * field disappears for good.
 */
export interface DetachedPanelEntry {
	/**
	 * Identity used to build the dockview panel id. Derived from kind + resource
	 * (see `panelIdFor`), so it doubles as the "is this panel already here?" key.
	 */
	panelId: string;
	kind: DetachablePanelKind;
	/** Resource identity for multi-instance kinds. */
	subagentNarratorId?: string;
	filePath?: string;
	fileNarratorId?: string;
	deviceId?: string;
	referenceOrigin?: boolean;
	toolEdit?: ToolEditReference;
}

/** A canvas node hosting a dockview surface of torn-out panels. */
export interface DetachedNode {
	/** Stable id, also used as the React Flow node id AND the surface id. */
	id: string;
	/** Canvas position and size, in flow (world) units. */
	x: number;
	y: number;
	w: number;
	h: number;
	/**
	 * The surface's dockview layout, once it has one. Absent for a node that has
	 * not mounted yet (fresh tear-out, or upgraded from v1/v2).
	 */
	layout?: SerializedDockview;
	/**
	 * Panels to create on first mount, when there is no `layout` yet. Exactly one
	 * of `layout` / `pendingPanels` is meaningful; an entry with neither is dropped
	 * because it has nothing to render.
	 */
	pendingPanels?: DetachedPanelEntry[];
}

interface DetachedPanelsEnvelope {
	version: typeof DETACHED_PANELS_VERSION;
	nodes: DetachedNode[];
}

/**
 * Identity for a panel, used to build its dockview panel id and to answer "is
 * this panel already open?".
 *
 * Derived from kind + resource rather than randomly generated, so it IS the
 * deduplication key and the two rules cannot drift apart. Singleton kinds are one
 * per chapter, so the kind alone suffices.
 *
 * Scoped to the UPGRADE and CREATE paths: a node that already owns a dockview
 * layout identifies its panels through that layout's own ids.
 */
export function panelIdFor(kind: DetachablePanelKind, resourceId?: string): string {
	if (kind === "file" && resourceId) {
		const target = filePanelResourceParams(resourceId);
		if (target.toolEdit || target.fileNarratorId) {
			return `file:${filePanelIdentity(target.filePath, target.deviceId, target.toolEdit, target.fileNarratorId)}`;
		}
		return `file:${filePanelResourceId(target.filePath, target.deviceId)}`;
	}
	return isMultiInstanceKind(kind) && resourceId ? `${kind}:${resourceId}` : kind;
}

/** The resource identity carried by an entry, if its kind has one. */
export function resourceIdOf(panel: DetachedPanelEntry): string | undefined {
	if (panel.kind === "subagent") return panel.subagentNarratorId;
	if (panel.kind === "file" && panel.filePath)
		return filePanelResourceId(
			panel.filePath,
			panel.deviceId,
			panel.referenceOrigin,
			panel.toolEdit,
			panel.fileNarratorId,
		);
	return undefined;
}

/**
 * Build a pending-panel entry, deriving its `panelId`.
 *
 * Like `panelIdFor`, this serves the upgrade and create paths only.
 */
export function makePanelEntry(kind: DetachablePanelKind, resourceId?: string): DetachedPanelEntry {
	return {
		panelId: panelIdFor(kind, resourceId),
		kind,
		...(kind === "subagent" && resourceId ? { subagentNarratorId: resourceId } : {}),
		...(kind === "file" && resourceId ? filePanelResourceParams(resourceId) : {}),
	};
}

function isFiniteNumber(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value);
}

/**
 * Panels awaiting creation across every node — what the cap bounds on the create
 * path. Nodes that already own a layout are not counted: their panels live inside
 * dockview and are not enumerable here.
 */
export function countPendingPanels(nodes: DetachedNode[]): number {
	let total = 0;
	for (const node of nodes) total += node.pendingPanels?.length ?? 0;
	return total;
}

/**
 * Parse one pending-panel entry. Malformed entries are dropped rather than
 * repaired: an unknown kind cannot be rendered, and silently keeping it would
 * surface as a blank or crashing tab.
 */
function parsePanelEntry(value: unknown): DetachedPanelEntry | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (!isDetachablePanelKind(v.kind)) return null;
	if (v.kind === "file" && v.toolEdit !== undefined && !isToolEditReference(v.toolEdit))
		return null;
	const resourceId =
		v.kind === "subagent" && typeof v.subagentNarratorId === "string" && v.subagentNarratorId
			? v.subagentNarratorId
			: v.kind === "file" && typeof v.filePath === "string" && v.filePath
				? filePanelResourceId(
						v.filePath,
						typeof v.deviceId === "string" ? v.deviceId : "local",
						v.referenceOrigin === true,
						isToolEditReference(v.toolEdit) ? v.toolEdit : undefined,
						typeof v.fileNarratorId === "string" ? v.fileNarratorId : undefined,
					)
				: undefined;
	// The stored panelId is ignored in favour of the derived one: it is a pure
	// function of kind + resource, so recomputing it repairs any drift (a hand-
	// edited file, a value written by an older shape) instead of trusting a key
	// that no longer matches what it identifies.
	return makePanelEntry(v.kind, resourceId);
}

/** Whether a value looks like a restorable dockview layout. */
function isLayout(value: unknown): value is SerializedDockview {
	if (!value || typeof value !== "object") return false;
	const v = value as { grid?: unknown; panels?: unknown };
	if (!v.grid || typeof v.grid !== "object") return false;
	// A layout with no panels restores to an empty surface, which is the same as
	// having nothing to render.
	return !!v.panels && typeof v.panels === "object" && Object.keys(v.panels).length > 0;
}

/**
 * Parse one node, accepting all three envelope shapes.
 *
 * Dispatch is on the entry's SHAPE, not the envelope's `version`. The version is
 * only a marker; the shape is what determines whether parsing can succeed, so
 * reading the shape tolerates a file whose version and contents disagree in
 * either direction.
 */
function parseNode(value: unknown): DetachedNode | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || !v.id) return null;
	if (!isFiniteNumber(v.x) || !isFiniteNumber(v.y)) return null;
	if (!isFiniteNumber(v.w) || !isFiniteNumber(v.h)) return null;
	if (v.w <= 0 || v.h <= 0) return null;

	const geometry = { id: v.id, x: v.x, y: v.y, w: v.w, h: v.h };

	// v3: a real dockview layout.
	if (isLayout(v.layout)) return { ...geometry, layout: v.layout };

	// v2: a `panels[]` list. v1: the entry itself described a single panel.
	const rawPanels = Array.isArray(v.panels)
		? v.panels
		: Array.isArray(v.pendingPanels)
			? v.pendingPanels
			: [v];
	const pendingPanels: DetachedPanelEntry[] = [];
	const seen = new Set<string>();
	for (const entry of rawPanels) {
		const panel = parsePanelEntry(entry);
		// Duplicate ids would produce two dockview panels claiming one identity.
		if (!panel || seen.has(panel.panelId)) continue;
		seen.add(panel.panelId);
		pendingPanels.push(panel);
	}
	// Neither a layout nor a usable panel: nothing to render, so drop the node
	// rather than mounting an empty surface.
	if (pendingPanels.length === 0) return null;
	return { ...geometry, pendingPanels };
}

/**
 * Parse the stored string. Returns an empty array for every unusable input rather
 * than throwing: a corrupt value must degrade to "this chapter has no detached
 * panels", never to a canvas that fails to render.
 */
export function parseDetachedNodes(raw: string | null | undefined): DetachedNode[] {
	if (!raw) return [];
	try {
		const parsed = JSON.parse(raw);
		if (!parsed || typeof parsed !== "object") return [];
		// `nodes` is the v2/v3 key; `panels` was v1's. Either may appear.
		const container = parsed as { nodes?: unknown; panels?: unknown };
		const list = Array.isArray(container.nodes)
			? container.nodes
			: Array.isArray(container.panels)
				? container.panels
				: null;
		if (!list) return [];
		const out: DetachedNode[] = [];
		const seenNodeIds = new Set<string>();
		let pendingBudget = MAX_DETACHED_PANELS;
		for (const entry of list) {
			const node = parseNode(entry);
			// Duplicate ids would produce two React Flow nodes with the same key.
			if (!node || seenNodeIds.has(node.id)) continue;
			if (node.pendingPanels) {
				// Truncate at the panel cap rather than dropping the node: the cap is a
				// resource ceiling, and keeping the first tabs is more useful than losing
				// the node entirely.
				if (node.pendingPanels.length > pendingBudget) {
					node.pendingPanels = node.pendingPanels.slice(0, Math.max(0, pendingBudget));
				}
				if (node.pendingPanels.length === 0) continue;
				pendingBudget -= node.pendingPanels.length;
			}
			seenNodeIds.add(node.id);
			out.push(node);
		}
		return out;
	} catch {
		return [];
	}
}

/**
 * Serialize for persistence, or null when the payload exceeds the cap (the caller
 * then skips a request the server would reject anyway).
 */
export function serializeDetachedNodes(nodes: DetachedNode[]): string | null {
	const envelope: DetachedPanelsEnvelope = { version: DETACHED_PANELS_VERSION, nodes };
	const serialized = JSON.stringify(envelope);
	// Byte length, not string length: a layout full of CJK panel titles is larger
	// over the wire than `.length` suggests, and the server cap counts bytes.
	if (new TextEncoder().encode(serialized).length > DETACHED_PANELS_MAX_BYTES) return null;
	return serialized;
}

export type AddDetachedResult =
	| { ok: true; nodes: DetachedNode[] }
	| { ok: false; reason: "limit"; limit: number }
	| { ok: false; reason: "duplicate" };

/**
 * Whether this chapter is already about to show this panel.
 *
 * Only sees `pendingPanels`: a node that already owns a dockview layout keeps its
 * panels inside dockview, so a duplicate there is caught by the receiving
 * surface's own `getPanel` check instead (see `ChapterNodeDock.handleDropSubject`,
 * which focuses an existing panel rather than adding a second).
 */
export function hasPendingPanel(nodes: DetachedNode[], panelId: string): boolean {
	return nodes.some((node) => node.pendingPanels?.some((p) => p.panelId === panelId) ?? false);
}

/**
 * Add a new node, refusing at the panel cap and refusing a panel this chapter is
 * already about to open.
 *
 * Returns a tagged result rather than silently dropping, so a caller cannot treat
 * "refused" as "added" — the failure mode that would leave a panel closed in the
 * dock and absent from the canvas.
 */
export function addDetachedNode(nodes: DetachedNode[], node: DetachedNode): AddDetachedResult {
	if (nodes.some((n) => n.id === node.id)) return { ok: false, reason: "duplicate" };
	const adding = node.pendingPanels ?? [];
	if (adding.some((p) => hasPendingPanel(nodes, p.panelId))) {
		return { ok: false, reason: "duplicate" };
	}
	if (countPendingPanels(nodes) + adding.length > MAX_DETACHED_PANELS) {
		return { ok: false, reason: "limit", limit: MAX_DETACHED_PANELS };
	}
	return { ok: true, nodes: [...nodes, node] };
}

/** Remove a whole node by id. Returns the same reference when nothing matched. */
export function removeDetachedNode(nodes: DetachedNode[], id: string): DetachedNode[] {
	const next = nodes.filter((n) => n.id !== id);
	return next.length === nodes.length ? nodes : next;
}

/**
 * Store a surface's layout, replacing any `pendingPanels` it was created from.
 *
 * Called after the surface reports a layout change, which is what makes the
 * upgrade from v1/v2 one-shot and self-healing: the pending list exists only
 * until the first real layout lands.
 */
export function setDetachedLayout(
	nodes: DetachedNode[],
	id: string,
	layout: SerializedDockview,
): DetachedNode[] {
	let changed = false;
	const next = nodes.map((n) => {
		if (n.id !== id) return n;
		changed = true;
		const { pendingPanels: _dropped, ...rest } = n;
		return { ...rest, layout };
	});
	return changed ? next : nodes;
}

/**
 * Fresh id for a newly detached node.
 *
 * `Math.random` rather than `crypto.randomUUID`, matching `split-tree.ts`: the
 * latter is unavailable over plain HTTP, which self-hosted deployments use.
 */
export function generateDetachedPanelId(): string {
	return `dp_${Math.random().toString(36).slice(2, 10)}`;
}

/** Update geometry after a drag or resize. Same reference when nothing changed. */
export function updateDetachedNodeGeometry(
	nodes: DetachedNode[],
	id: string,
	geometry: Partial<Pick<DetachedNode, "x" | "y" | "w" | "h">>,
): DetachedNode[] {
	let changed = false;
	const next = nodes.map((n) => {
		if (n.id !== id) return n;
		const merged: DetachedNode = {
			...n,
			...(isFiniteNumber(geometry.x) ? { x: geometry.x } : {}),
			...(isFiniteNumber(geometry.y) ? { y: geometry.y } : {}),
			...(isFiniteNumber(geometry.w) && geometry.w > 0 ? { w: geometry.w } : {}),
			...(isFiniteNumber(geometry.h) && geometry.h > 0 ? { h: geometry.h } : {}),
		};
		if (merged.x !== n.x || merged.y !== n.y || merged.w !== n.w || merged.h !== n.h) {
			changed = true;
			return merged;
		}
		return n;
	});
	return changed ? next : nodes;
}
