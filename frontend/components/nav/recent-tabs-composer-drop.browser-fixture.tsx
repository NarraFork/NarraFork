import { DndContext, useDraggable } from "@dnd-kit/core";
import { QueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { createRoot } from "react-dom/client";
import type { RecentTab } from "../../hooks/recent-tabs-utils";
import { api } from "../../lib/api";
import { confirmAuthUser, setToken } from "../../lib/api/client";
import { getPanelDrag, PANEL_DROP_PRIORITY, registerPanelDropTarget } from "../../lib/panel-drag";
import { getRecentTabsScope } from "../../lib/recent-tabs-owner";
import * as composer from "../narrator/composer/NarratorComposer.browser-fixture";
import { useRecentTabsDrag } from "./useRecentTabsDrag";

const tabs: RecentTab[] = [
	{ type: "narrator", id: "recent-session", title: "Recent session", lastVisitedAt: 1 },
	{
		type: "subagent",
		id: "subagent-tab-id",
		narratorId: "stable-subagent-id",
		title: "Worker session",
		lastVisitedAt: 1,
	},
	{ type: "subagent", id: "legacy-child", title: "Legacy worker", lastVisitedAt: 1 },
	{ type: "project", id: "project-id", title: "Project", lastVisitedAt: 1 },
	{ type: "folder", id: "folder-id", title: "Folder", lastVisitedAt: 1 },
];
const query = new QueryClient();
confirmAuthUser(setToken("fixture-auth:fixture-user"), "fixture-user");
const fallbacks: string[] = [];
const moves: string[] = [];
let mounted = false;
let dragging: { current: boolean } | null = null;
let nativeDrops = 0;
document.addEventListener("drop", () => nativeDrops++);
api.moveRecentTab = async (key) => {
	moves.push(key);
	return { changed: false, baseRevision: 0, revision: 0, operations: [] };
};

function DragRow({ tab }: { tab: RecentTab }) {
	const key = `${tab.type}:${tab.id}`;
	const { setNodeRef, attributes, listeners } = useDraggable({ id: key });
	return (
		<button
			type="button"
			ref={setNodeRef}
			data-tab-sort-id={key}
			{...attributes}
			{...listeners}
			style={{ display: "block", width: "100%", height: 48, touchAction: "none" }}
		>
			{tab.title}
		</button>
	);
}

function Sidebar() {
	const scope = getRecentTabsScope();
	if (!scope) throw Error("Missing composer drop scope");
	const containerRef = useRef<HTMLElement | null>(null);
	const drag = useRecentTabsDrag({
		scope,
		tabs,
		folderOptions: { displayOf: () => "expanded", defaultPreview: 3 },
		containerRef,
		qc: query,
		onError: () => {
			throw new Error("Unexpected sidebar mutation failure");
		},
		newFolderTitle: "Folder",
	});
	dragging = drag.draggingRef;
	useEffect(() => {
		mounted = true;
		const off = registerPanelDropTarget({
			id: "sidebar-fixture-dock",
			priority: PANEL_DROP_PRIORITY.dock,
			hitTest: () => true,
			onDrop: (state) => fallbacks.push(state.id),
		});
		return () => {
			mounted = false;
			off();
		};
	}, []);
	return (
		<DndContext
			sensors={drag.sensors}
			onDragStart={drag.onDragStart}
			onDragMove={drag.onDragMove}
			onDragEnd={drag.onDragEnd}
			onDragCancel={drag.onDragCancel}
		>
			<aside ref={containerRef} style={{ height: "100vh" }}>
				{tabs.map((tab) => (
					<DragRow key={`${tab.type}:${tab.id}`} tab={tab} />
				))}
			</aside>
		</DndContext>
	);
}

createRoot(document.getElementById("sidebar") as HTMLElement).render(<Sidebar />);

export function ready() {
	return mounted && composer.ready();
}
export function snapshot() {
	return {
		...composer.snapshot(),
		drag: getPanelDrag(),
		sorting: dragging?.current ?? false,
		nativeDrops,
		fallbacks: [...fallbacks],
		moves: [...moves],
	};
}
