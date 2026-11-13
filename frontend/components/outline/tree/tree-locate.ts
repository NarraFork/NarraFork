/**
 * "Locate in the tree" (readability F): bring a block on screen in the connected outline by
 * opening what it is under — its space's place in the tree, its page, its ancestors — and
 * scrolling to it.
 *
 * A request comes from a search hit (the tree is on screen: its host hands it over), or from a
 * focused page (the reader is taken to the tree: the request waits here, per host, for the tree
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
	pageId: string;
	/** The block to show; the page's own id for the page itself. */
	blockId: string;
	/** The block's ancestors, the page first (none for a page). */
	pathIds: readonly string[];
	/** The page's title, for its row when the tree has not listed it yet. */
	pageTitle: string;
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
	/** Node keys to open, outermost first; the page's last. */
	keys: string[];
	/**
	 * The list the space's own row is in, should it need pinning there: `root` (a project at the
	 * tree's root) or a group's key. Null: the space is the tree's root or always listed.
	 */
	pinIn: string | null;
}

/**
 * The nodes to open for a page of `space`, in a tree rooted at the whole outline (`root` null)
 * or at one space. `parent`: the project space a session hangs under, with that project's id
 * (null: the session is under none the reader may read). Null when the tree cannot show it (a
 * tree rooted at another space).
 */
export function locateKeys(
	space: LocateSpace,
	parent: { spaceId: string; projectId: string } | null,
	pageId: string,
	root: { spaceId: string; projectId: string | null } | null,
): LocatePlan | null {
	const page = `page:${pageId}`;
	if (root) {
		if (root.spaceId === space.id) return { keys: [page], pinIn: null };
		// A session of the project the tree is rooted at.
		if (space.kind === "session" && parent && parent.spaceId === root.spaceId) {
			const group = `group:sessions:${parent.projectId}`;
			return { keys: [group, `space:${space.id}`, page], pinIn: group };
		}
		return null;
	}
	const own = `space:${space.id}`;
	if (space.orphaned) return { keys: ["group:orphaned", own, page], pinIn: "group:orphaned" };
	if (space.kind === "personal") return space.mine ? { keys: [own, page], pinIn: null } : null;
	if (space.kind === "project") return { keys: [own, page], pinIn: "root" };
	if (parent) {
		const group = `group:sessions:${parent.projectId}`;
		return { keys: [`space:${parent.spaceId}`, group, own, page], pinIn: group };
	}
	return { keys: ["group:loose", own, page], pinIn: "group:loose" };
}
