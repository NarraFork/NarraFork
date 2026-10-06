import { DndContext, DragOverlay, useDraggable } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { createRecentTabDragModel } from "../../../frontend/components/nav/recent-tab-drag-model";
import { useRecentTabsDrag } from "../../../frontend/components/nav/useRecentTabsDrag";
import type { RecentTab } from "../../../frontend/hooks/recent-tabs-utils";
import {
	type RecentTabsInfiniteData,
	recentTabsSectionQueryKey,
} from "../../../frontend/hooks/useRecentTabs";
import { api } from "../../../frontend/lib/api";
import type { RecentTabsMutationResponse } from "../../../frontend/lib/api/settings";
import {
	getPanelDrag,
	onPanelDragEnd,
	type PanelDragState,
} from "../../../frontend/lib/panel-drag";

const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
const key = recentTabsSectionQueryKey("work");
const calls: { method: string; key?: string; target?: unknown; keys?: string[] }[] = [];
const ends: (PanelDragState | null)[] = [];
const deliveries: PanelDragState[] = [];
let held = false;
let release: (() => void) | null = null;
let revision = 0;
let latest: ReturnType<typeof useRecentTabsDrag>;
let errors = 0;
let updateGrouping: (value: boolean) => void = () => {};
const tab = (id: string, fields: Partial<RecentTab> = {}): RecentTab => ({
	type: "narrator",
	id,
	title: id,
	lastVisitedAt: 1,
	...fields,
});
const initial = [
	tab("w", { type: "workspace" }),
	tab("w1", { workspaceId: "w" }),
	tab("w2", { workspaceId: "w" }),
	tab("a"),
	tab("b"),
	tab("c"),
	...Array.from({ length: 24 }, (_, i) => tab(`tail${i}`)),
];
qc.setQueryData<RecentTabsInfiniteData>(key, {
	pages: [{ items: initial, revision, hasMore: false }],
	pageParams: [undefined],
});
async function waitIfHeld() {
	if (held)
		await new Promise<void>((resolve) => {
			release = resolve;
		});
}
// Only transport is replaced, inside this isolated browser module. The hook and
// QueryClient still apply real recent-tabs deltas to a real section cache.
api.moveRecentTab = async (source, target) => {
	calls.push({ method: "move", key: source, target });
	await waitIfHeld();
	const baseRevision = revision++;
	return {
		changed: true,
		baseRevision,
		revision,
		operations: [
			{
				type: "move",
				key: source,
				beforeKey: "beforeKey" in target ? target.beforeKey : null,
				afterKey: "afterKey" in target ? target.afterKey : null,
			},
		],
	};
};
api.setRecentTabDirectoryOrder = async (keys) => {
	calls.push({ method: "directory", keys });
	await waitIfHeld();
	const baseRevision = revision++;
	return {
		changed: true,
		baseRevision,
		revision,
		operations: keys.map((item, index) => {
			const current = qc
				.getQueryData<RecentTabsInfiniteData>(key)
				?.pages[0].items.find((value) => `${value.type}:${value.id}` === item);
			if (!current) throw new Error(`Missing directory member ${item}`);
			return {
				type: "upsert",
				key: item,
				tab: { ...current, dirSortOrder: index },
				beforeKey: null,
				afterKey: null,
			};
		}),
	} satisfies RecentTabsMutationResponse;
};
onPanelDragEnd((state) => {
	ends.push(state ? { ...state } : null);
	if (state && state.x > 260) deliveries.push({ ...state });
});

function Row({ id, disabled }: { id: string; disabled: boolean }) {
	const { setNodeRef, listeners, attributes } = useDraggable({ id, disabled });
	return (
		<div ref={setNodeRef} data-tab-sort-id={id} className="row" {...attributes} {...listeners}>
			{id}
		</div>
	);
}
function Fixture() {
	const containerRef = useRef<HTMLDivElement>(null);
	const [tabs, setTabs] = useState<RecentTab[]>(initial);
	const [groupingEnabled, setGroupingEnabled] = useState(false);
	updateGrouping = setGroupingEnabled;
	useEffect(
		() =>
			qc.getQueryCache().subscribe(() => {
				setTabs(
					(qc.getQueryData<RecentTabsInfiniteData>(key)?.pages.flatMap((page) => page.items) ??
						[]) as RecentTab[],
				);
			}),
		[],
	);
	const drag = useRecentTabsDrag({
		tabs,
		groupingEnabled,
		directoryCollapsedByPath: new Map([["/repo", false]]),
		containerRef,
		qc,
		onError: () => {
			errors++;
		},
	});
	latest = drag;
	const model = createRecentTabDragModel(
		drag.renderTabs,
		groupingEnabled,
		new Map([["/repo", false]]),
	);
	return (
		<DndContext
			sensors={drag.sensors}
			autoScroll={drag.autoScrollOptions}
			onDragStart={drag.onDragStart}
			onDragMove={drag.onDragMove}
			onDragEnd={drag.onDragEnd}
			onDragCancel={drag.onDragCancel}
		>
			<nav data-auto-scroll-gate>
				<div id="sidebar" ref={containerRef}>
					{model.rows.map((row) => {
						const id =
							row.kind === "directory" ? `dir:${row.path}` : `${row.tab.type}:${row.tab.id}`;
						return (
							<div key={id} data-unit={row.kind === "directory" ? row.path : row.tab.id}>
								<Row id={id} disabled={drag.pending} />
								{row.kind !== "tab" &&
									row.children.map((child) => (
										<Row key={child.id} id={`${child.type}:${child.id}`} disabled={drag.pending} />
									))}
							</div>
						);
					})}
				</div>
			</nav>
			<main id="panel-target">Panel drop target</main>
			<DragOverlay dropAnimation={null}>
				{drag.draggingId ? <div id="overlay">{drag.draggingId}</div> : null}
			</DragOverlay>
		</DndContext>
	);
}

export function snapshot() {
	return {
		calls: [...calls],
		ends: [...ends],
		deliveries: [...deliveries],
		errors,
		draggingId: latest.draggingId,
		dragging: latest.draggingRef.current,
		pending: latest.pending,
		panel: getPanelDrag(),
		indicator: latest.indicator,
		order: latest.renderTabs.map((item) => `${item.type}:${item.id}`),
		cacheOrder: qc
			.getQueryData<RecentTabsInfiniteData>(key)
			?.pages[0].items.map((item) => `${item.type}:${item.id}`),
		measured: latest.measureRows(),
	};
}
export function hold(value: boolean) {
	held = value;
	if (!value) {
		release?.();
		release = null;
	}
}
// Used only to install fixture data, never to synthesize drag callbacks.
export function setTabs(tabs: RecentTab[]) {
	qc.setQueryData<RecentTabsInfiniteData>(key, {
		pages: [{ items: tabs, revision, hasMore: false }],
		pageParams: [undefined],
	});
}
export function directoryFixture() {
	updateGrouping(true);
	setTabs([tab("a", { subtitle: "/repo" }), tab("b", { subtitle: "/repo" }), tab("c")]);
}
createRoot(document.getElementById("root") as HTMLElement).render(<Fixture />);
