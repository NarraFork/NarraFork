import {
	applyDirectoryMemberOrder,
	directoryRowId,
	directoryRowKeyBlock,
	groupRecentTabsByDirectory,
	type RecentTabRow,
} from "../../hooks/recent-tab-directory-groups";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import {
	applyRecentTabMove,
	computeRecentTabOrderMoves,
	type RecentTabOrderMove,
} from "../../hooks/useRecentTabs";
import type { RecentTabDropRow, RecentTabDropTarget } from "./recent-tab-drop-target";

export const recentTabDragKey = (tab: RecentTab) => `${tab.type}:${tab.id}`;
export interface RecentTabDragEntry {
	key: string;
	unit: string;
	pinned: boolean;
	workspaceId?: string;
	role: "unit" | "workspace-member" | "directory-member";
	keyBlock: string[];
	tab?: RecentTab;
}
export interface RecentTabDragModel {
	tabs: RecentTab[];
	groupingEnabled: boolean;
	rows: RecentTabRow[];
	entries: Map<string, RecentTabDragEntry>;
	topLevel: RecentTab[];
	childrenByWorkspace: Map<string, RecentTab[]>;
	pinnedItems: RecentTab[];
	unpinnedItems: RecentTab[];
	directoryRows: RecentTabRow[];
}

/** Build once per source update, never once per pointer frame. Pinned directories stay flat. */
export function createRecentTabDragModel(
	tabs: RecentTab[],
	groupingEnabled: boolean,
	directoryCollapsedByPath: ReadonlyMap<string, boolean>,
): RecentTabDragModel {
	const children = new Map<string, RecentTab[]>();
	const top: RecentTab[] = [];
	for (const tab of tabs) {
		if (!tab.workspaceId) top.push(tab);
		else {
			const members = children.get(tab.workspaceId) ?? [];
			members.push(tab);
			children.set(tab.workspaceId, members);
		}
	}
	const plain = (tab: RecentTab): RecentTabRow =>
		tab.type === "workspace"
			? { kind: "workspace", tab, children: children.get(tab.id) ?? [] }
			: { kind: "tab", tab };
	const pinnedRows = top.filter((tab) => tab.pinned).map(plain);
	const unpinnedRows = groupingEnabled
		? groupRecentTabsByDirectory(
				top.filter((tab) => !tab.pinned),
				children,
			)
		: top.filter((tab) => !tab.pinned).map(plain);
	const rows = [...pinnedRows, ...unpinnedRows];
	const entries = new Map<string, RecentTabDragEntry>();
	for (const row of rows) {
		const unit = row.kind === "directory" ? directoryRowId(row.path) : recentTabDragKey(row.tab);
		const block = directoryRowKeyBlock(row);
		const pinned = row.kind !== "directory" && !!row.tab.pinned;
		const workspaceId = row.kind === "workspace" ? row.tab.id : undefined;
		entries.set(unit, {
			key: unit,
			unit,
			pinned,
			workspaceId,
			role: "unit",
			keyBlock: block,
			tab: row.kind === "directory" ? undefined : row.tab,
		});
		if (row.kind === "tab") continue;
		if (row.kind === "directory" && (directoryCollapsedByPath.get(row.path) ?? true)) continue;
		for (const tab of row.children) {
			const key = recentTabDragKey(tab);
			entries.set(key, {
				key,
				unit,
				pinned,
				workspaceId,
				tab,
				keyBlock: block,
				role: row.kind === "directory" ? "directory-member" : "workspace-member",
			});
		}
	}
	const flatten = (units: RecentTabRow[]) =>
		units.flatMap((row) =>
			row.kind === "tab"
				? [row.tab]
				: row.kind === "workspace"
					? [row.tab, ...row.children]
					: row.children,
		);
	return {
		tabs,
		groupingEnabled,
		rows,
		entries,
		topLevel: top,
		childrenByWorkspace: children,
		pinnedItems: flatten(pinnedRows),
		unpinnedItems: flatten(unpinnedRows),
		directoryRows: unpinnedRows,
	};
}

/** The same block metadata supports external drops; member sorting narrows it below. */
export function recentTabDragMeasuredRow(
	model: RecentTabDragModel,
	key: string,
	top: number,
	bottom: number,
): RecentTabDropRow | null {
	const entry = model.entries.get(key);
	if (!entry || bottom <= top) return null;
	return {
		key,
		top,
		bottom,
		pinned: entry.pinned,
		workspaceId: entry.workspaceId,
		keyBlock: entry.keyBlock,
	};
}

export function recentTabDragIndicatorRows(
	model: RecentTabDragModel,
	sourceKey: string,
	rows: RecentTabDropRow[],
): RecentTabDropRow[] {
	const source = model.entries.get(sourceKey);
	if (!source) return [];
	return rows.flatMap((row) => {
		const entry = model.entries.get(row.key);
		if (!entry || entry.pinned !== source.pinned) return [];
		if (source.role !== "unit") {
			if (entry.unit !== source.unit) return [];
			if (source.role === "directory-member" && entry.role === "unit") {
				return [{ ...row, keyBlock: [source.keyBlock[0]] }];
			}
			if (entry.role !== source.role) return [];
			if (source.role === "workspace-member" && model.groupingEnabled) return [];
			return [{ ...row, keyBlock: [row.key] }];
		}
		return [row];
	});
}

/** Resolve whole units using the centre of their entire visible geometry, not travel direction. */
export function resolveRecentTabInternalDrop(
	model: RecentTabDragModel,
	sourceKey: string,
	rows: RecentTabDropRow[],
	pointer: { x: number; y: number },
	container: { left: number; right: number; top: number; bottom: number },
): RecentTabDropTarget | null {
	if (
		pointer.x < container.left ||
		pointer.x > container.right ||
		pointer.y < container.top ||
		pointer.y > container.bottom
	)
		return null;
	const source = model.entries.get(sourceKey);
	if (!source) return null;
	const eligible = recentTabDragIndicatorRows(model, sourceKey, rows);
	// Do not snap from the opposite pinned region or from empty/outside geometry.
	const hovered = rows.find((row) => pointer.y >= row.top && pointer.y < row.bottom);
	if (hovered && !eligible.some((row) => row.key === hovered.key)) return null;
	if (hovered?.key === source.unit && source.role === "directory-member") {
		return source.keyBlock[0] === source.key ? null : { kind: "before", key: source.keyBlock[0] };
	}
	if (!eligible.length) return null;
	const units = new Map<string, RecentTabDropRow[]>();
	for (const row of eligible) {
		const unit = source.role === "unit" ? (model.entries.get(row.key)?.unit ?? row.key) : row.key;
		units.set(unit, [...(units.get(unit) ?? []), row]);
	}
	for (const [unit, group] of units) {
		const top = Math.min(...group.map((row) => row.top));
		const bottom = Math.max(...group.map((row) => row.bottom));
		if (pointer.y < bottom) {
			if (unit === (source.role === "unit" ? source.unit : source.key)) return null;
			const before = pointer.y < (top + bottom) / 2;
			return {
				kind: before ? "before" : "after",
				key: before ? group[0].keyBlock[0] : (group.at(-1)?.keyBlock.at(-1) ?? unit),
			};
		}
	}
	const last = eligible.at(-1);
	if (!last || last.keyBlock.includes(sourceKey)) return null;
	return { kind: "after", key: last.keyBlock.at(-1) ?? last.key };
}

export interface RecentTabDragPlan {
	moves: RecentTabOrderMove[];
	directoryKeys?: string[];
	finalTabs: RecentTab[];
}

export function planRecentTabInternalDrop(
	model: RecentTabDragModel,
	sourceKey: string,
	target: RecentTabDropTarget,
): RecentTabDragPlan | null {
	if (target.kind !== "before" && target.kind !== "after") return null;
	const source = model.entries.get(sourceKey);
	const anchorRow = model.rows.find((row) => directoryRowKeyBlock(row).includes(target.key));
	const anchor =
		model.entries.get(target.key) ??
		(anchorRow
			? model.entries.get(
					anchorRow.kind === "directory"
						? directoryRowId(anchorRow.path)
						: recentTabDragKey(anchorRow.tab),
				)
			: undefined);
	if (!source || !anchor || sourceKey === target.key || source.pinned !== anchor.pinned)
		return null;
	const move = {
		key: sourceKey,
		...(target.kind === "before" ? { beforeKey: target.key } : { afterKey: target.key }),
	};
	if (source.role !== "unit") {
		if (source.unit !== anchor.unit || source.role !== anchor.role) return null;
		if (source.role === "workspace-member") {
			if (model.groupingEnabled) return null;
			return { moves: [move], finalTabs: applyRecentTabMove(model.tabs, sourceKey, move) };
		}
		const keys = source.keyBlock.filter((key) => key !== sourceKey);
		const index = keys.indexOf(target.key);
		if (index < 0) return null;
		keys.splice(index + (target.kind === "after" ? 1 : 0), 0, sourceKey);
		return {
			moves: [],
			directoryKeys: keys,
			finalTabs: applyDirectoryMemberOrder(model.tabs, keys),
		};
	}
	if (source.unit === anchor.unit) return null;
	const nextRows = model.rows.filter(
		(row) =>
			(row.kind === "directory" ? directoryRowId(row.path) : recentTabDragKey(row.tab)) !==
			source.unit,
	);
	const moved = model.rows.find(
		(row) =>
			(row.kind === "directory" ? directoryRowId(row.path) : recentTabDragKey(row.tab)) ===
			source.unit,
	);
	const index = nextRows.findIndex((row) => directoryRowKeyBlock(row).includes(target.key));
	if (!moved || index < 0) return null;
	nextRows.splice(index + (target.kind === "after" ? 1 : 0), 0, moved);
	// Flat mode can move a workspace as one original flat unit (server expands its group).
	if (!model.groupingEnabled)
		return { moves: [move], finalTabs: applyRecentTabMove(model.tabs, sourceKey, move) };
	return computeRecentTabOrderMoves(model.tabs, nextRows.map(directoryRowKeyBlock));
}

/** Only order and explicitly changed directory positions mask the latest WS data. */
export function projectRecentTabDragOrder(
	latest: RecentTab[],
	optimistic: RecentTab[] | null,
	directoryKeys?: ReadonlySet<string>,
): RecentTab[] {
	if (!optimistic) return latest;
	const positions = new Map(optimistic.map((tab, index) => [recentTabDragKey(tab), index]));
	const orders = new Map(optimistic.map((tab) => [recentTabDragKey(tab), tab.dirSortOrder]));
	const existing = latest
		.filter((tab) => positions.has(recentTabDragKey(tab)))
		.sort(
			(a, b) =>
				(positions.get(recentTabDragKey(a)) ?? 0) - (positions.get(recentTabDragKey(b)) ?? 0),
		);
	let index = 0;
	return latest.map((tab) => {
		if (!positions.has(recentTabDragKey(tab))) return tab;
		const current = existing[index++];
		const key = recentTabDragKey(current);
		const dirSortOrder =
			!directoryKeys || directoryKeys.has(key) ? orders.get(key) : current.dirSortOrder;
		return dirSortOrder === current.dirSortOrder ? current : { ...current, dirSortOrder };
	});
}
