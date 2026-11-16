/**
 * "Locate in the tree" (readability F): bring a block on screen in the forest by opening what
 * it is under — its space's place in the tree, then its ancestors (the space's own block list
 * does that, `forest/ForestBlocks.tsx`) — and scrolling to it.
 *
 * A request comes from a search hit (the tree is on screen: its host hands it over), or from a
 * focused block (the reader is taken to the tree: the request waits here, per host, for the tree
 * that mounts next, and is dropped when none does within {@link LOCATE_PENDING_MS}).
 *
 * The node keys to open are worked out here ({@link locateKeys}); a row the tree's lists have
 * not loaded (a session past the first page of its project) is shown pinned at the top of its
 * list, so locating never pages through a list. Pure but for the pending slot.
 */
import type { OutlineSpaceSummary } from "@shared/outline-api";
import type { TreeHost } from "./tree-open-state";

export interface TreeLocateTarget {
	spaceId: string;
	/** The block to show (its ancestors are read when it is located). */
	blockId: string;
	/** The block is a question for the reader: once shown, its answer form opens in the tree. */
	answer?: boolean;
}

/** How long a request waits for a tree to mount. */
export const LOCATE_PENDING_MS = 10_000;

const pending = new Map<TreeHost, { target: TreeLocateTarget; at: number }>();

/** Ask the tree this host shows next to locate `target`. */
export function requestTreeLocate(host: TreeHost, target: TreeLocateTarget, now = Date.now()) {
	pending.set(host, { target, at: now });
}

/** The request waiting for this host's tree, taken (once); null when none, or it went stale. */
export function takeTreeLocate(host: TreeHost, now = Date.now()): TreeLocateTarget | null {
	const found = pending.get(host);
	if (!found) return null;
	pending.delete(host);
	return now - found.at <= LOCATE_PENDING_MS ? found.target : null;
}

/** Where a space hangs: what {@link locateKeys} needs of it. */
export type LocateSpace = Pick<
	OutlineSpaceSummary,
	"id" | "kind" | "projectId" | "mine" | "orphaned"
>;

export interface LocatePlan {
	/** Node keys to open, outermost first; the space's own last (none for the tree's root). */
	keys: string[];
	/**
	 * The list the space's own row is in, should it need pinning there: `root` (a project at the
	 * tree's root) or a group's key. Null: the space is the tree's root or always listed.
	 */
	pinIn: string | null;
	/**
	 * The session's project space must be pinned at the tree's root too: the root lists projects
	 * a list page at a time, and the session's may be past what it has loaded.
	 */
	pinParentAtRoot: boolean;
}

/**
 * The nodes to open for a block of `space`, in a tree rooted at the whole outline (`root` null)
 * or at one space. `parent`: the project space a session hangs under, with that project's id
 * (null: the session is under none the reader may read). Null when the tree cannot show it (a
 * tree rooted at another space).
 */
export function locateKeys(
	space: LocateSpace,
	parent: { spaceId: string; projectId: string } | null,
	root: { spaceId: string; projectId: string | null } | null,
): LocatePlan | null {
	if (root) {
		if (root.spaceId === space.id) return { keys: [], pinIn: null, pinParentAtRoot: false };
		// A session of the project the tree is rooted at.
		if (space.kind === "session" && parent && parent.spaceId === root.spaceId) {
			const group = `group:sessions:${parent.projectId}`;
			return { keys: [group, `space:${space.id}`], pinIn: group, pinParentAtRoot: false };
		}
		return null;
	}
	const own = `space:${space.id}`;
	if (space.orphaned)
		return { keys: ["group:orphaned", own], pinIn: "group:orphaned", pinParentAtRoot: false };
	if (space.kind === "personal")
		return space.mine ? { keys: [own], pinIn: null, pinParentAtRoot: false } : null;
	if (space.kind === "project") return { keys: [own], pinIn: "root", pinParentAtRoot: false };
	if (parent) {
		const group = `group:sessions:${parent.projectId}`;
		return {
			keys: [`space:${parent.spaceId}`, group, own],
			pinIn: group,
			pinParentAtRoot: true,
		};
	}
	return { keys: ["group:loose", own], pinIn: "group:loose", pinParentAtRoot: false };
}
