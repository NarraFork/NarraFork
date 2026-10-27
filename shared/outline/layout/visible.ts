/**
 * Which blocks a view shows under a budget (design §7.2: a mind map lays out and draws at most as
 * many blocks as an editor view expands, 2000; the rest fold into "…N more").
 *
 * Breadth first, as the budgeted reads do (design §3.1): a whole level is shown before the next
 * one is opened, so the top of a large page is always complete and the cut happens as deep as it
 * can. Within the level where the budget runs out, earlier parents (in document order) keep their
 * children and later ones fold theirs. Collapsed blocks show no children and spend nothing.
 *
 * Pure: the caller gives the children of a block in order, so this runs on the editor's block
 * store and in tests alike.
 */

export interface VisiblePlan {
	/** Children shown under each block that shows any, in order. */
	shown: Map<string, string[]>;
	/** Children a block has but does not show for lack of budget (folded into "…N more"). */
	more: Map<string, number>;
	/** Blocks shown, the root included. */
	count: number;
}

export interface VisibleInput {
	rootId: string;
	children: (id: string) => readonly string[];
	/** Collapsed blocks (the root never counts as collapsed). */
	collapsed: (id: string) => boolean;
	/** Most blocks to show, the root included (at least 1). */
	budget: number;
	/** Deepest level opened below the root (a guard against corrupt cycles). */
	maxDepth?: number;
}

export function planVisible(input: VisibleInput): VisiblePlan {
	const budget = Math.max(1, Math.floor(input.budget));
	const maxDepth = input.maxDepth ?? 200;
	const shown = new Map<string, string[]>();
	const more = new Map<string, number>();
	let count = 1;
	let level: string[] = [input.rootId];
	for (let depth = 0; level.length > 0 && depth < maxDepth; depth++) {
		const next: string[] = [];
		for (const id of level) {
			if (id !== input.rootId && input.collapsed(id)) continue;
			const kids = input.children(id);
			if (kids.length === 0) continue;
			const room = budget - count;
			if (room <= 0) {
				more.set(id, kids.length);
				continue;
			}
			const take = kids.length <= room ? kids : kids.slice(0, room);
			shown.set(id, [...take]);
			if (take.length < kids.length) more.set(id, kids.length - take.length);
			count += take.length;
			for (const k of take) next.push(k);
		}
		level = next;
	}
	return { shown, more, count };
}
